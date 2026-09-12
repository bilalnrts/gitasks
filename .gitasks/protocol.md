# Gitasks Task Protocol

GitHub Issues are this repository's task-management source of truth. Do not create or maintain a separate task database or roadmap list.

## Rules

- Every development task should have a GitHub Issue.
- Before opening an issue, search open and closed issues for the same work and reuse a suitable issue when one exists.
- Issue titles and labels follow the Gitasks status protocol.
- An issue without a recognized status label or title prefix is unclassified. Assign one of the six statuses explicitly before starting it.
- Before implementation, run `gitasks start <issue-number>` to move the task to `IN PROGRESS`.
- When implementation is complete and ready for review, run `gitasks review <issue-number>`.
- Move a task to `DONE` only when completion is explicit and appropriate.
- If missing information or an external dependency prevents progress, record the blocker on GitHub and run `gitasks block <issue-number>`.
- Do not silently change status outside this protocol.
- A status change must preserve unrelated labels, issue content, assignments, milestones, relations, and linked pull requests.
- If status labels conflict, a matching title prefix wins; otherwise Gitasks uses the first status in protocol order.
- GitHub open/closed state is separate from task status. Lists default to open issues; use `--state closed` or `--state all` to change scope.
- Treat permission, unsupported, partial, and ambiguous-result messages as real states. Inspect GitHub before retrying a create, review, or merge that may already have completed.

## Statuses

`BACKLOG` → `TODO` → `IN PROGRESS` → `REVIEW` → `DONE`

Use `BLOCKED` when work cannot continue. A blocked task may return to an appropriate active status after its blocker is removed.

## Commands

```bash
gitasks list
gitasks list --status unclassified
gitasks list --state all
gitasks create "Describe the task"
gitasks todo 42
gitasks start 42
gitasks review 42
gitasks done 42
gitasks block 42
gitasks backlog 42
gitasks ui
```

The local workspace is an interface to the same GitHub data, not a second store. Gitasks synchronizes each issue's `status:*` label, title prefix, and open/closed state; GitHub remains authoritative.

## Initialization and custom content

`gitasks init` creates missing protocol files and labels. It never replaces an existing `.gitasks/protocol.md`. It appends the marked Gitasks section to an existing `AGENTS.md` only when that file has no `<!-- gitasks:start -->` marker; existing content outside the marked section is preserved. Re-running initialization must not be used to reset consumer customizations.
