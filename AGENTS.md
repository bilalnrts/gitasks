<!-- gitasks:start -->
## Gitasks Task Management

This repository uses GitHub Issues as its task management source of truth.

Before starting development work:

1. Run `gitasks list`.
2. Identify the relevant task.
3. Run `gitasks start <issue-number>`.
4. Read `.gitasks/protocol.md`.

When implementation is ready for review, run:

`gitasks review <issue-number>`

Do not mark tasks as `DONE` automatically unless the work is truly complete and doing so is explicitly appropriate. If an external dependency prevents progress, move the task to `BLOCKED`.
<!-- gitasks:end -->

