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
  core.getInput('github-require-keyword-prefix') !== 'false'

const jiraDomainInput = core.getInput('jira-domain', { required: true })
const jiraUser = core.getInput('jira-user', { required: true })
const jiraApiToken = core.getInput('jira-api-token', { required: true })
const jiraStatusPrDraft = core.getInput('jira-status-pr-draft')
const jiraStatusPrReady = core.getInput('jira-status-pr-ready')
const jiraStatusPrMerged = core.getInput('jira-status-pr-merged')

const headers = {
  'Accept': 'application/json',
  'Content-Type': 'application/json',
}

const auth = {
  username: jiraUser,
  password: jiraApiToken,
}

const timeoutMs = 10_000

/** @param {import('axios').AxiosError} error */
function onRejected(error) {
  console.error(
    `Error ${error.response.status} ${error.response.statusText}`,
    error.request.path,
    error.response.data
  )
}

// https://developer.atlassian.com/cloud/jira/platform/rest/v3/
const jiraApiBaseUrl = new URL('/rest/api/3/', `https://${jiraDomainInput}`)
const jiraApi = axios.create({
  baseURL: jiraApiBaseUrl.toString(),
  headers,
  auth,
  timeout: timeoutMs,
})
jiraApi.interceptors.response.use(null, onRejected)

// https://developer.atlassian.com/cloud/jira/software/rest/
const jiraAgileApiBaseUrl = new URL(
  '/rest/agile/1.0/',
  `https://${jiraDomainInput}`
)
const jiraAgileApi = axios.create({
  baseURL: jiraAgileApiBaseUrl.toString(),
  headers,
  auth,
  timeout: timeoutMs,
})
jiraAgileApi.interceptors.response.use(null, onRejected)

const octokit = github.getOctokit(githubToken)
const repoOwner = (payload.organization || payload.repository.owner).login
const issueNumber = (payload.pull_request || payload.issue).number

/**
 * GitHub data
 *
 * @typedef {object} PullRequestComment
 * @property {string} body
 */

/**
 * Jira data
 *
 * @typedef {string} IssueKey
 * @typedef {string} StatusName
 *
 * @typedef {object} IssueData
 * @property {string} issueKey
 * @property {StatusName} currentStatusName
 * @property {Map<StatusName, number>} availableTransitions
 */

/**
 * @param {string} name
 * @return {StatusName}
 */
function normaliseStatusName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * @param {Array<IssueKey>} issuesKeys
 * @return {Promise<Array<IssueData>>}
 */
async function getIssues(issuesKeys) {
  const response = await jiraApi.get('search/jql', {
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

/**
 * @param {string} prBody
 * @param {Array<PullRequestComment>} comments
 * @return {Array<IssueKey>}
 */
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
  const issueKeyRegExp = '[A-Z][A-Z0-9]+-[0-9]+'
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

/**
 * @return {Promise<Array<PullRequestComment>>}
 */
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

/**
 * @param {Array<IssueKey>} issueKeys
 * @return {Promise<void>}
 */
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

function escapeJqlString(str) {
  return str.replace(/(["\\])/g, '\\$1')
}

/**
 * @param {StatusName} statusName
 * @return {Promise<IssueKey|undefined>}
 */
async function getLastIssueInStatusKey(statusName) {
  const statusNameNormalised = normaliseStatusName(statusName)
  const response = await jiraApi.get('search/jql', {
    params: {
      maxResults: 1,
      jql: `status="${escapeJqlString(statusNameNormalised)}" ORDER BY Rank DESC`,
      fields: 'key',
    },
  })
  const key = response.data.issues.at(0)?.key
  console.log('Last issue in', statusName, 'is', key)
  return key
}

/**
 * @param {Array<IssueKey>} issueKeys
 * @param {Array<StatusName>} newStatusNames
 * @return {Promise<void>}
 */
async function transitionIssues(issueKeys, newStatusNames) {
  const newStatusNamesNormalised = newStatusNames.map(normaliseStatusName)

  const issuesData = await getIssues(issueKeys)

  /** @type {Map<StatusName, Array<IssueData>}>} */
  const issuesByNewStatusName = new Map()
  issuesData.forEach((issueData) => {
    const newStatusName = newStatusNamesNormalised.find((statusName) =>
      issueData.availableTransitions.has(statusName)
    )
    if (issuesByNewStatusName.has(newStatusName)) {
      issuesByNewStatusName.get(newStatusName).push(issueData)
    } else {
      issuesByNewStatusName.set(newStatusName, [issueData])
    }
  })

  await Promise.all(
    Array.from(issuesByNewStatusName.entries()).map(
      async ([newStatusName, issues]) => {
        const lastIssueInStatusKey =
          await getLastIssueInStatusKey(newStatusName)

        const transitionedIssueKeys = (
          await Promise.all(
            issues.map(async (issue) => {
              if (issue.currentStatusName === newStatusName) {
                console.log(
                  'Did not transition',
                  issue.issueKey,
                  '— already in',
                  newStatusName
                )
              } else {
                const newStatusId =
                  issue.availableTransitions.get(newStatusName)
                if (newStatusId == null) {
                  throw new Error(
                    `List name “${newStatusName}” not found in JIRA. Available statuses: ${Array.from(issue.availableTransitions.keys()).join(', ')}`
                  )
                }

                await jiraApi.post(
                  `issue/${encodeURIComponent(issue.issueKey)}/transitions`,
                  {
                    transition: {
                      id: newStatusId,
                    },
                  }
                )

                console.log('Transitioned', issue.issueKey, 'to', newStatusName)

                return issue.issueKey
              }
            })
          )
        ).filter(Boolean)

        // Move all newly transitioned issues to the end of the list
        if (transitionedIssueKeys.length > 0 && lastIssueInStatusKey) {
          await jiraAgileApi.put('issue/rank', {
            issues: transitionedIssueKeys,
            rankAfterIssue: lastIssueInStatusKey,
          })
          console.log(
            `Moved issues to the end of column '${newStatusName}':`,
            ...transitionedIssueKeys
          )
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
      if (
        context.eventName === 'pull_request' &&
        payload.action === 'opened' &&
        !['main', 'production'].includes(pr.head.ref)
      ) {
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
        await transitionIssues(issueIds, jiraStatusPrDraft.split('|'))
      }
    } else if (pr.state === 'open' && !isDraft) {
      if (!jiraStatusPrReady) {
        console.log(
          'No ready PR status name provided, skipping transitioning issues'
        )
      } else {
        await transitionIssues(issueIds, jiraStatusPrReady.split('|'))
      }
    } else if (pr.state === 'closed') {
      if (!jiraStatusPrMerged) {
        console.log(
          'No merged PR status name provided, skipping transitioning issues'
        )
      } else {
        await transitionIssues(issueIds, jiraStatusPrMerged.split('|'))
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
