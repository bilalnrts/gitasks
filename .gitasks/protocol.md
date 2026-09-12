# Gitasks Task Protocol

GitHub Issues are this repository's task management source of truth. Do not create or maintain a separate task database.

## Rules

- Every development task should have a GitHub Issue.
- Before opening a new issue, search existing issues for the same work and reuse a suitable issue when one exists.
- Issue titles and labels must follow the Gitasks status protocol.
- Before starting a task, run `gitasks start <issue-number>` to move it to `IN PROGRESS`.
- When implementation is complete and ready for review, run `gitasks review <issue-number>`.
- Move a task to `DONE` only when the work is truly complete.
- If progress depends on missing information or an external dependency, run `gitasks block <issue-number>`.
- Do not silently change issue status outside this protocol.
- Preserve unrelated issue labels during status changes.
- If an issue has conflicting status labels, its matching title prefix wins; otherwise Gitasks uses the first status in protocol order.
- Issues without a recognized status label or title prefix are unclassified; assign a status explicitly before starting them.
- GitHub open/closed state is separate from task status. Lists default to open issues; use `--state closed` or `--state all` to change scope.

## Statuses

`BACKLOG` → `TODO` → `IN PROGRESS` → `REVIEW` → `DONE`

Use `BLOCKED` when work cannot continue. A blocked task may return to any active status when its blocker is removed.

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
```

Gitasks synchronizes each issue's `status:*` label, title prefix, and open/closed state. GitHub remains authoritative.
