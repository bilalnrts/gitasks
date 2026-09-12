<!-- gitasks:start -->
## Gitasks Task Management

This repository uses GitHub Issues as its task-management source of truth.

Before starting development work:

1. Read `.gitasks/protocol.md`.
2. Run `gitasks list --state all` or use `gitasks ui` to search for the same work.
3. Reuse the relevant issue, or create one only when none exists.
4. Explicitly classify an unclassified issue when appropriate.
5. Run `gitasks start <issue-number>` before implementation.

When implementation is ready for review, run:

`gitasks review <issue-number>`

Do not mark work `DONE` automatically unless completion is explicit and appropriate. If missing information or an external dependency prevents progress, move the issue to `BLOCKED` and record the blocker on GitHub.

Gitasks updates GitHub directly. Do not create a parallel task list or overwrite issue content, unrelated labels, assignments, milestones, or relations while changing status.
<!-- gitasks:end -->
