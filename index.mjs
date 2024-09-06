import axios from 'axios'
import * as core from '@actions/core'
import * as github from '@actions/github'

// Use these for local debugging.
// You will also need `mock-inputs.json` with input values.
//
// import * as core from './mock.mjs'
// import * as github from './mock.mjs'

const { context = {} } = github
const { payload } = context

const githubToken = core.getInput('github-token')
const githubRequireKeywordPrefix =
  core.getInput('github-require-keyword-prefix') ?? true

const jiraDomain = core.getInput('jira-domain', { required: true })
const jiraUser = core.getInput('jira-user', { required: true })
const jiraApiToken = core.getInput('jira-api-token', { required: true })
const jiraListPrDraft = core.getInput('jira-list-pr-draft')
const jiraListPrReady = core.getInput('jira-list-pr-ready')
const jiraListPrMerged = core.getInput('jira-list-pr-merged')

const jiraApi = axios.create({
  // https://developer.atlassian.com/cloud/jira/platform/rest/v2/api-group-issues/
  baseURL: `https://${jiraDomain}/rest/api/2`,
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

async function getIssueTransitionIds(issueId) {
  const response = await jiraApi.get(
    `issue/${encodeURIComponent(issueId)}/transitions`
  )
  const { transitions } = response.data
  return new Map(
    transitions
      .filter((t) => t.isAvailable)
      .map((t) => [t.name.toLowerCase(), Number.parseInt(t.id, 10)])
  )
}

const octokit = github.getOctokit(githubToken)
const repoOwner = (payload.organization || payload.repository.owner).login
const issueNumber = (payload.pull_request || payload.issue).number

async function run(pr) {
  try {
    const comments = await getPullRequestComments()
    const issueIds = await getIssueIds(pr.body, comments)

    if (!issueIds.length) {
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

    await assignPrToIssues(issueIds, pr)

    if (pr.state === 'open' && isDraft) {
      if (!jiraListPrDraft) {
        console.log('No draft PR list name provided, skipping moving issues')
      } else {
        await moveIssuesToList(issueIds, jiraListPrDraft)
        console.log('Moved', issueIds.length, 'issues to', jiraListPrDraft)
      }
    } else if (pr.state === 'open' && !isDraft) {
      if (!jiraListPrReady) {
        console.log('No ready PR list name provided, skipping moving issues')
      } else {
        await moveIssuesToList(issueIds, jiraListPrReady)
        console.log('Moved', issueIds.length, 'issues to', jiraListPrReady)
      }
    } else if (pr.state === 'closed') {
      if (!jiraListPrMerged) {
        console.log('No merged PR list name provided, skipping moving issues')
      } else {
        await moveIssuesToList(issueIds, jiraListPrMerged)
        console.log('Moved', issueIds.length, 'issues to', jiraListPrMerged)
      }
    } else {
      console.log(
        'Skipping moving the issues:',
        `pr.state=${pr.state},`,
        pr.draft ? 'draft' : isFauxDraft ? 'faux draft' : 'not draft'
      )
    }
  } catch (error) {
    core.setFailed(error)
  }
}

async function getIssueIds(prBody, comments) {
  console.log('Searching for issue ids')

  let issueIds = matchIssueIds(prBody || '')

  for (const comment of comments) {
    issueIds = [...issueIds, ...matchIssueIds(comment.body)]
  }
  return [...new Set(issueIds)]
}

function matchIssueIds(text) {
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
  const urlRegExp = `https://${jiraDomain}/browse/([A-Z]+-\\d+)`
  const closesRegExp = `${keywordsRegExp}${urlRegExp}(?:\\s*,\\s*${urlRegExp})*`

  // Find all “Closes URL, URL…”
  const matches = text.match(new RegExp(closesRegExp, 'gi')) || []

  return Array.from(
    new Set(
      matches.flatMap((match) => {
        // Find URLs
        const urlMatches = match.match(new RegExp(urlRegExp, 'g'))
        // Find issueId in the URL (only capture group in urlRegexp)
        const issueIds = urlMatches.map(
          (url) => url.match(new RegExp(urlRegExp))[1]
        )
        return issueIds
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

async function assignPrToIssues(issueIds, pr) {
  console.log('Assigning PR to issues')

  return Promise.all(
    issueIds.map(async (issueId) => {
      console.log('Assigning PR to issue', issueId)

      const prLinkObject = {
        url: pr.html_url,
        title: `PR #${pr.number}: ${pr.title}`,
      }

      const { data: links } = await jiraApi.get(
        `issue/${encodeURIComponent(issueId)}/remotelink`
      )

      const alreadyAssigned = links.some(
        (link) => link.object.url === prLinkObject.url
      )
      if (!alreadyAssigned) {
        await jiraApi.post(`issue/${encodeURIComponent(issueId)}/remotelink`, {
          application: {},
          object: prLinkObject,
        })
      }
    })
  )
}

async function moveIssuesToList(issueIds, listName) {
  return Promise.all(
    issueIds.map(async (issueId) => {
      console.log('Moving issue', issueId, 'to a list', listName, `(${listId})`)

      const transitionIds = await getIssueTransitionIds(issueId)

      const listId = transitionIds.get(listName.toLowerCase())
      if (listId == null) {
        throw new Error(
          `List name ${listName} not found in JIRA. Available lists: ${Array.from(transitionIds.keys()).join(', ')}`
        )
      }

      return jiraApi.post(`issue/${encodeURIComponent(issueId)}/transitions`, {
        transition: {
          id: listId,
        },
      })
    })
  )
}

run(payload.pull_request || payload.issue)
