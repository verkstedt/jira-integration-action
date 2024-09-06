import { readFile } from 'fs/promises'

const inputs = JSON.parse(await readFile('./mock-inputs.json', 'utf8'))

const payload = {
  organization: {
    owner: 'DUMMY',
  },
  repository: {
    owner: 'DUMMY',
    name: 'jira-integration-action',
  },
  pull_request: {
    state: 'open',
    draft: true,
    number: 42,
    title: 'Dummy PR',
    body: `Closes https://${inputs['jira-domain']}/browse/${inputs['test-issue-id']}`,
    html_url: 'https://example.com',
  },
}

export const context = { payload }
export const setFailed = console.error
export const getInput = (name) => inputs[name]
export const getOctokit = () => ({
  rest: {
    issues: {
      listComments: () => ({ data: [] }),
    },
  },
})
