import { readFile } from 'fs/promises'

const inputs = JSON.parse(await readFile('./mock-inputs.json', 'utf8'))

/** @type {import('@actions/github').context} */
export const context = {
  eventName: 'pull_request',
  actor: 'DUMMY-USER',
  payload: {
    action: 'opened',
    organization: {
      owner: 'DUMMY-OWNER',
    },
    repository: {
      owner: 'DUMMY-REPO-OWNER',
      name: 'dumy-repository-name',
    },
    pull_request: {
      state: 'open',
      draft: true,
      number: 42,
      title: 'Dummy PR Title',
      body: `Closes https://${inputs['jira-domain']}/browse/${inputs['test-issue-id']}`,
      html_url: 'https://dummy-pr-html.test/',
    },
  },
}
export const setFailed = console.error
export const getInput = (name) => inputs[name]
export const getOctokit = () => ({
  rest: {
    issues: {
      listComments: () => ({ data: [] }),
    },
  },
})
