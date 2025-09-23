# Jira integration action

Based on Remato’s [Trello integration action](https://github.com/rematocorp/trello-integration-action).

When PR status changes, moves Jira tickets to the appropriate column on the board.

```yaml
name: Jira integration
on:
  pull_request:
    types:
      - opened
      - edited
      - closed
      - reopened
      - ready_for_review
      - converted_to_draft
  issue_comment:
    types:
      - created
      - edited
jobs:
  jira:
    runs-on: ubuntu-latest
    steps:
      - uses: verkstedt/jira-integration-action@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          # Hint: Set these on an organisation level and override in repos only when necessary
          jira-domain: ${{ vars.JIRA_DOMAIN }}
          jira-user: ${{ secrets.JIRA_USER }}
          # Create one at: https://id.atlassian.com/manage-profile/security/api-tokens
          # Note that user whose API token is used, will “touch” all of
          # the issues, so it’s best to create a dedicated user for
          # this sort of things.
          jira-api-token: ${{ secrets.JIRA_API_TOKEN }}
          # e.g. “In Progress”
          jira-status-pr-draft: ${{ vars.JIRA_STATUS_PR_DRAFT }}
          # e.g. “In Review|In Dev Review”
          jira-status-pr-ready: ${{ vars.JIRA_STATUS_PR_READY }}
          # e.g. “QA|In PO Review|Done”
          jira-status-pr-merged: ${{ vars.JIRA_STATUS_PR_MERGED }}
```

## Debugging

- Create `mock-inputs.json` with input values AND additional `test-issue-id`.
- Run `node index.mjs`.
