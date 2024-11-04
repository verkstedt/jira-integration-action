import axios from 'axios'
import * as core from '@actions/core'
import * as github from '@actions/github'

// Use these for local debugging.
// You will also need `mock-inputs.json` with input values.
//
// import * as mock from './mock.mjs'
//
// const core = mock
// const github = mock

const {
  context,
  context: { payload, repo },
} = github
const pr = payload.pull_request || payload.issue

const githubToken = core.getInput('github-token')
const githubRequireKeywordPrefix =
  core.getInput('github-require-keyword-prefix') ?? true

const jiraDomainInput = core.getInput('jira-domain', { required: true })
const jiraUser = core.getInput('jira-user', { required: true })
const jiraApiToken = core.getInput('jira-api-token', { required: true })
const jiraStatusPrDraft = core.getInput('jira-status-pr-draft')
const jiraStatusPrReady = core.getInput('jira-status-pr-ready')
const jiraStatusPrMerged = core.getInput('jira-status-pr-merged')

// https://developer.atlassian.com/cloud/jira/platform/rest/v2/api-group-issues/
const jiraApiBaseUrl = new URL(`https://${jiraDomainInput}`)
jiraApiBaseUrl.pathname = '/rest/api/2'

const jiraApi = axios.create({
  baseURL: jiraApiBaseUrl.toString(),
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  },
  auth: {
    username: jiraUser,
    password: jiraApiToken,
  },
})

jiraApi.interceptors.response.use(
  null,
  /** @param {import('axios').AxiosError} error */
  (error) => {
    console.error(
      `Error ${error.response.status} ${error.response.statusText}`,
      error.request.path,
      error.response.data
    )
  }
)

const octokit = github.getOctokit(githubToken)
const repoOwner = (payload.organization || payload.repository.owner).login
const issueNumber = (payload.pull_request || payload.issue).number

function normaliseStatusName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

async function getIssues(issuesKeys) {
  const response = await jiraApi.get('search', {
    params: {
      maxResults: 100,
      jql: `id in (${issuesKeys.join(',')})`,
      fields: 'status',
      expand: 'transitions',
    },
  })

  return response.data.issues.map((jiraIssueData) => ({
    issueKey: jiraIssueData.key,
    currentStatusName: normaliseStatusName(jiraIssueData.fields.status.name),
    availableTransitions: new Map(
      jiraIssueData.transitions
        .filter((t) => t.isAvailable)
        .map((t) => [normaliseStatusName(t.name), Number.parseInt(t.id, 10)])
    ),
  }))
}

function extractResolvedIssueKeys(prBody, comments) {
  const text = [prBody, ...comments.map((comment) => comment.body)].join('\0')

  const keywords = [
    'close',
    'closes',
    'closed',
    'fix',
    'fixes',
    'fixed',
    'resolve',
    'resolves',
    'resolved',
  ]
  const keywordsRegExp = githubRequireKeywordPrefix
    ? `(?:${keywords.join('|')})\\s+`
    : ''
  // Warning:
  // It’s extremely important for this regexp to match only simple
  // jira keys as extracted keys will be used in JQL queries.
  const issueKeyRegExp = '[A-Z]+-[0-9]+'
  const urlRegExp = `${jiraApiBaseUrl.origin}/browse/(${issueKeyRegExp})`
  const closesRegExp = `${keywordsRegExp}${urlRegExp}(?:\\s*,\\s*${urlRegExp})*`

  // Find all “Closes URL, URL…”
  const matches = text.match(new RegExp(closesRegExp, 'gi')) || []

  return Array.from(
    new Set(
      matches.flatMap((match) => {
        // Find URLs
        const urlMatches = match.match(new RegExp(urlRegExp, 'g'))
        // Find issueId in the URL (only capture group in urlRegExp)
        const issueKeys = urlMatches.map(
          (url) => url.match(new RegExp(urlRegExp))[1]
        )
        return issueKeys
      })
    )
  )
}

async function getPullRequestComments() {
  console.log('Requesting pull request comments')

  const response = await octokit.rest.issues.listComments({
    owner: repoOwner,
    repo: payload.repository.name,
    issue_number: issueNumber,
  })
  return response.data
}

async function nagToLinkJiraIssue() {
  await octokit.rest.issues.createComment({
    issue_number: pr.number,
    owner: repo.owner,
    repo: repo.repo,
    body: `@${context.actor} Please add Jira issue URL to the PR description (proceeded with “Closes” or “Fixes”) — it will make issues move when PR status changes.\n`,
  })
}

async function assignPrToIssues(issueKeys) {
  await Promise.all(
    issueKeys.map(async (issueKey) => {
      console.log('Assigning PR', `#${pr.number}`, 'to issue', issueKey)

      const prLinkObject = {
        url: pr.html_url,
        // Using URL as title will make JIRA fetch the title itself
        title: pr.html_url,
        icon: { url16x16: 'https://github.com/favicon.ico' },
      }

      const { data: links } = await jiraApi.get(
        `issue/${encodeURIComponent(issueKey)}/remotelink`
      )

      const alreadyAssigned = links.some(
        (link) => link.object.url === prLinkObject.url
      )
      if (!alreadyAssigned) {
        await jiraApi.post(`issue/${encodeURIComponent(issueKey)}/remotelink`, {
          application: {},
          object: prLinkObject,
        })
      }
    })
  )

  console.log(
    'Assigned PR',
    `#${pr.number}`,
    'to',
    issueKeys.length,
    'issue(s)'
  )
}

async function transitionIssues(issueKeys, newStatusName) {
  const newStatusNameNormalised = normaliseStatusName(newStatusName)

  const issuesData = await getIssues(issueKeys)

  return Promise.all(
    issuesData.map(
      async ({ issueKey, currentStatusName, availableTransitions }) => {
        if (currentStatusName === newStatusNameNormalised) {
          console.log(
            'Did not transition',
            issueKey,
            '— already in',
            newStatusName
          )
        } else {
          const newStatusId = availableTransitions.get(newStatusNameNormalised)
          if (newStatusId == null) {
            throw new Error(
              `List name ${newStatusName} not found in JIRA. Available statuses: ${Array.from(availableTransitions.keys()).join(', ')}`
            )
          }

          await jiraApi.post(
            `issue/${encodeURIComponent(issueKey)}/transitions`,
            {
              transition: {
                id: newStatusId,
              },
            }
          )

          console.log('Transitioned', issueKey, 'to', newStatusName)
        }
      }
    )
  )
}

async function main() {
  try {
    const comments = await getPullRequestComments()
    const issueIds = extractResolvedIssueKeys(pr.body, comments)

    if (!issueIds.length) {
      if (context.eventName === 'pull_request' && payload.action === 'opened') {
        void nagToLinkJiraIssue()
      }

      console.log('Could not find issue IDs')
      return
    }
    console.log('Found issue IDs:', issueIds.join(', '))

    // Treat PRs with “draft” or “wip” in brackets at the start or
    // end of the titles like drafts. Useful for orgs on unpaid
    // plans which doesn’t support PR drafts.
    const titleDraftRegExp =
      /^(?:\s*[\[(](?:wip|draft)[\])]\s+)|(?:\s+[\[(](?:wip|draft)[\])]\s*)$/i
    const isRealDraft = pr.draft === true
    const isFauxDraft = Boolean(pr.title.match(titleDraftRegExp))
    const isDraft = isRealDraft || isFauxDraft

    await assignPrToIssues(issueIds)

    if (pr.state === 'open' && isDraft) {
      if (!jiraStatusPrDraft) {
        console.log(
          'No draft PR status name provided, skipping transitioning issues'
        )
      } else {
        await transitionIssues(issueIds, jiraStatusPrDraft)
      }
    } else if (pr.state === 'open' && !isDraft) {
      if (!jiraStatusPrReady) {
        console.log(
          'No ready PR status name provided, skipping transitioning issues'
        )
      } else {
        await transitionIssues(issueIds, jiraStatusPrReady)
      }
    } else if (pr.state === 'closed') {
      if (!jiraStatusPrMerged) {
        console.log(
          'No merged PR status name provided, skipping transitioning issues'
        )
      } else {
        await transitionIssues(issueIds, jiraStatusPrMerged)
      }
    } else {
      console.log(
        'Skipping transitioning the issues:',
        `pr.state=${pr.state},`,
        pr.draft ? 'draft' : isFauxDraft ? 'faux draft' : 'not draft'
      )
    }
  } catch (error) {
    core.setFailed(error)
  }
}

main()
