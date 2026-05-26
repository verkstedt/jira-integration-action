# Jira integration action

Based on Remato’s [Trello integration action](https://github.com/rematocorp/trello-integration-action).

When PR status changes, moves Jira tickets to the appropriate column on the board.

> [!WARNING]
> **Deprecated — moved to [`verkstedt/actions`](https://github.com/verkstedt/actions/tree/HEAD/jira-integration).**
>
> Existing workflows using `verkstedt/jira-integration-action@v1` will
> keep working — `v1` of this repo is now a thin composite shim that
> forwards to `verkstedt/actions/jira-integration@v1`. Please migrate
> your workflows to reference the new location directly:
>
> ```yaml
> - uses: verkstedt/actions/jira-integration@v1
> ```


## License

[MIT](./LICENSE)
