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
          jira-api-token: ${{ secrets.JIRA_API_TOKEN }}
          jira-list-pr-draft: ${{ vars.JIRA_LIST_PR_DRAFT }}
          jira-list-pr-ready: ${{ vars.JIRA_LIST_PR_READY }}
          jira-list-pr-merged: ${{ vars.JIRA_LIST_PR_MERGED }}

```
