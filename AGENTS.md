<!-- gitasks:start -->
## Gitasks Task Management

This repository uses GitHub Issues as its task management source of truth.

Before starting development work:

1. Read `.gitasks/protocol.md`.
2. Run `gitasks list` and search existing issues for the same work.
3. Reuse the relevant issue, or create one only when none exists.
4. Run `gitasks start <issue-number>`.

When implementation is ready for review, run:

`gitasks review <issue-number>`

Do not mark tasks as `DONE` automatically unless the work is truly complete and doing so is explicitly appropriate. If an external dependency prevents progress, move the task to `BLOCKED`.
<!-- gitasks:end -->

