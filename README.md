# Gitasks

A lightweight local task protocol for humans and coding agents, powered entirely by GitHub Issues.

Gitasks is a small, development-only CLI. GitHub Issues remain the single source of truth: there is no local task database, hosted backend, SaaS account, or additional credential store.

## Requirements

- Node.js 20 or newer
- Git
- [GitHub CLI](https://cli.github.com/) (`gh`)
- A repository whose `origin` points to `github.com`

Authenticate once with GitHub CLI:

```bash
gh auth login
```

Gitasks uses that existing authentication. It never asks for or stores a personal access token.

## Installation

```bash
npm install -D gitasks
npx gitasks init
```

`gitasks init` detects the current GitHub repository, verifies `gh` authentication, creates the required `status:*` labels, and adds the following files without replacing existing content:

```text
.gitasks/
  config.json
  protocol.md
AGENTS.md
```

If `AGENTS.md` already exists, Gitasks appends a clearly marked task-management section. Re-running `init` is safe.

## Commands

```bash
gitasks list
gitasks list --status in-progress
gitasks create "Implement login"
gitasks create "Implement login" --status todo
gitasks create "Implement login" --body "Add email/password authentication."
gitasks backlog 42
gitasks todo 42
gitasks start 42
gitasks review 42
gitasks done 42
gitasks block 42
```

Issue numbers may be written as `42` or `#42`.

### Task lifecycle

```text
BACKLOG → TODO → IN PROGRESS → REVIEW → DONE
                         ↘ BLOCKED
```

| Command | Result |
| --- | --- |
| `backlog` | Moves the issue to `BACKLOG` |
| `todo` | Moves the issue to `TODO` |
| `start` | Moves the issue to `IN PROGRESS` |
| `review` | Moves the issue to `REVIEW` |
| `done` | Moves the issue to `DONE` and closes it |
| `block` | Moves the issue to `BLOCKED` |

Moving a completed task back to an active state reopens its GitHub Issue. Transitions add and remove only `status:*` labels instead of replacing the complete label collection, so unrelated labels added concurrently are preserved.

## Issue protocol

Each task has one canonical status label and a matching title:

```text
status:backlog       [BACKLOG] Implement login
status:todo          [TODO] Implement login
status:in-progress   [IN PROGRESS] Implement login
status:review        [REVIEW] Implement login
status:done          [DONE] Implement login
status:blocked       [BLOCKED] Implement login
```

Labels are machine-readable and canonical. Titles mirror them for humans. If a manually created issue has no status label, Gitasks infers the title prefix; if neither exists, it treats the issue as `BACKLOG`.

If multiple status labels conflict, a matching title prefix wins. Without a matching prefix, Gitasks resolves the first status in lifecycle definition order: `BACKLOG`, `TODO`, `IN PROGRESS`, `REVIEW`, `DONE`, then `BLOCKED`. The next transition removes all conflicting `status:*` labels.

By default, `gitasks list` displays open, non-`DONE` tasks. An explicit `--status` filter searches both open and closed issues, so manually closed active tasks and completed tasks remain queryable. Open/closed state does not override the canonical label or inferred title status.

## Coding agents

Run `gitasks init`, then point coding agents to `AGENTS.md` and `.gitasks/protocol.md`. The generated protocol requires agents to:

1. identify the relevant GitHub Issue;
2. move it to `IN PROGRESS` before implementation;
3. move completed implementation to `REVIEW`;
4. use `BLOCKED` when an external dependency prevents progress;
5. avoid marking work `DONE` unless completion is explicit and appropriate.

Because every transition updates GitHub directly, humans and agents share one task state.

## Repository detection

Gitasks works from any directory inside a Git worktree. It reads `origin` and supports common GitHub remote forms:

```text
https://github.com/owner/repo.git
git@github.com:owner/repo.git
```

No repository configuration is stored locally.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
node dist/cli.js --help
```

The production bundle contains the executable Node.js shebang and targets Node.js 20+ ESM. `npm pack` and `npm publish` run the `prepack` build automatically, so a clean checkout does not require a committed `dist/` directory.

## License

[MIT](LICENSE)
