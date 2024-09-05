import axios from 'axios'
import * as core from '@actions/core'
import * as github from '@actions/github'

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

async function getIssueTransitionIds() {
  const url = `https://${jiraDomain}/rest/api/2/issue/TTP-18/transitions`
  const response = await axios.get(url, {
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    auth: {
      username: jiraUser,
      password: jiraApiToken,
    },
  })
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
    const ticketIds = await getTicketIds(pr.body, comments)

    if (!ticketIds.length) {
      console.log('Could not find ticket IDs')
      return
    }
    console.log('Found ticket IDs:', ticketIds.join(', '))

    // Treat PRs with “draft” or “wip” in brackets at the start or
    // end of the titles like drafts. Useful for orgs on unpaid
    // plans which doesn’t support PR drafts.
    const titleDraftRegExp =
      /^(?:\s*[\[(](?:wip|draft)[\])]\s+)|(?:\s+[\[(](?:wip|draft)[\])]\s*)$/i
    const isRealDraft = pr.draft === true
    const isFauxDraft = Boolean(pr.title.match(titleDraftRegExp))
    const isDraft = isRealDraft || isFauxDraft

    if (pr.state === 'open' && isDraft) {
      if (!jiraListPrDraft) {
        console.log('No draft PR list name provided, skipping moving tickets')
      } else {
        await moveTicketsToList(ticketIds, jiraListPrDraft)
        console.log('Moved', ticketIds.length, 'tickets to', jiraListPrDraft)
      }
    } else if (pr.state === 'open' && !isDraft) {
      if (!jiraListPrReady) {
        console.log('No ready PR list name provided, skipping moving tickets')
      } else {
        await moveTicketsToList(ticketIds, jiraListPrReady)
        console.log('Moved', ticketIds.length, 'tickets to', jiraListPrReady)
      }
    } else if (pr.state === 'closed') {
      if (!jiraListPrMerged) {
        console.log('No merged PR list name provided, skipping moving tickets')
      } else {
        await moveTicketsToList(ticketIds, jiraListPrMerged)
        console.log('Moved', ticketIds.length, 'tickets to', jiraListPrMerged)
      }
    } else {
      console.log(
        'Skipping moving the tickets:',
        `pr.state=${pr.state},`,
        pr.draft ? 'draft' : isFauxDraft ? 'faux draft' : 'not draft'
      )
    }
  } catch (error) {
    core.setFailed(error)
  }
}

async function getTicketIds(prBody, comments) {
  console.log('Searching for ticket ids')

  let ticketIds = matchTicketIds(prBody || '')

  for (const comment of comments) {
    ticketIds = [...ticketIds, ...matchTicketIds(comment.body)]
  }
  return [...new Set(ticketIds)]
}

function matchTicketIds(text) {
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
        // Find ticketId in the URL (only capture group in urlRegexp)
        const ticketIds = urlMatches.map(
          (url) => url.match(new RegExp(urlRegExp))[1]
        )
        return ticketIds
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

async function moveTicketsToList(ticketIds, listName) {
  const transitionIds = await getIssueTransitionIds()

  const listId = transitionIds.get(listName.toLowerCase())
  if (listId == null) {
    throw new Error(
      `List name ${listName} not found in JIRA. Available lists: ${Array.from(transitionIds.keys()).join(', ')}`
    )
  }

  return Promise.all(
    ticketIds.map(async (ticketId) => {
      console.log(
        'Moving ticket',
        ticketId,
        'to a list',
        listName,
        `(${listId})`
      )

      const url = `https://${jiraDomain}/rest/api/2/issue/${ticketId}/transitions`

      const body = {
        transition: {
          id: listId,
        },
      }

      return axios
        .post(url, body, {
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
          auth: {
            username: jiraUser,
            password: jiraApiToken,
          },
        })
        .catch((error) => {
          console.error(
            `Error ${error.response.status} ${error.response.statusText}`,
            url,
            error.response.data
          )
        })
    })
  )
}

run(payload.pull_request || payload.issue)
