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

`gitasks init` detects the current GitHub repository, verifies `gh` authentication, creates missing `status:*` labels, and adds the following files without replacing existing content or modifying issues:

```text
.gitasks/
  config.json
  protocol.md
AGENTS.md
```

If `AGENTS.md` already exists, Gitasks appends a clearly marked task-management section. An existing `.gitasks/protocol.md` is never replaced. Re-running `init` is safe.

## Local task board

Start the lightweight local board from anywhere inside the target Git repository:

```bash
npx gitasks ui
```

The default address is `http://127.0.0.1:4317`. Choose another port when needed:

```bash
npx gitasks ui --port 4400
```

The board keeps the six Gitasks status columns and shows issues without a recognized status in a separate **Unclassified issues** section. Its **Open / Closed / All** filter defaults to **Open**; GitHub issue state remains independent from task status, so a manually closed `IN PROGRESS` issue stays `IN PROGRESS` under **Closed** or **All**. Search covers every issue loaded for the selected state scope. All pages are fetched, so the board does not silently truncate results. Pull requests are excluded.

The server listens only on `127.0.0.1`, validates the request host and origin, and requires a per-process CSRF token for mutations. Stop it with `Ctrl+C`.

Current limitations: one repository per server process, manual refresh only, no drag-and-drop, no comments or PR management, and no offline mode.

## Commands

```bash
gitasks list
gitasks ui
gitasks ui --port 4400
gitasks list --status in-progress
gitasks list --status unclassified
gitasks list --state closed
gitasks list --state all
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

Moving a completed task back to an active state reopens its GitHub Issue. Assigning any of the six statuses to an unclassified issue adds the title prefix and canonical label at that explicit point; reading, refreshing, opening the board, and `init` never classify or otherwise mutate existing issues. Transitions add and remove only `status:*` labels instead of replacing the complete label collection, so unrelated labels added concurrently are preserved.

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

Labels are machine-readable and canonical. Titles mirror them for humans. If a manually created issue has no status label, Gitasks infers a recognized title prefix. If neither exists, the issue is **unclassified**—not a seventh task status—and remains unchanged until a user explicitly assigns one of the six statuses. New tasks created through Gitasks still default to `BACKLOG`.

If multiple status labels conflict, a matching title prefix wins. Without a matching prefix, Gitasks resolves the first status in lifecycle definition order: `BACKLOG`, `TODO`, `IN PROGRESS`, `REVIEW`, `DONE`, then `BLOCKED`. The next explicit transition removes all conflicting `status:*` labels.

`gitasks list` defaults to all open issues and prints task status (or `UNCLASSIFIED`) separately from GitHub `OPEN`/`CLOSED` state. Use `--state open`, `--state closed`, or `--state all` to choose the issue scope, and combine it with any `--status` filter. Gitasks fetches every REST page and excludes pull requests; results are not silently capped.

## Coding agents

Run `gitasks init`, then point coding agents to `AGENTS.md` and `.gitasks/protocol.md`. The generated protocol requires agents to:

1. search existing issues for the same work before opening a new issue;
2. reuse the relevant GitHub Issue when one exists;
3. explicitly classify an unclassified issue when appropriate;
4. move it to `IN PROGRESS` before implementation;
5. move completed implementation to `REVIEW`;
6. use `BLOCKED` when an external dependency prevents progress;
7. avoid marking work `DONE` unless completion is explicit and appropriate.

Because every transition updates GitHub directly, humans and agents share one task state.

Within one local UI server process, Gitasks serializes complete status-transition attempts per issue number, including the GitHub update and the recovery read after a failure. Different issues, separate CLI/server processes, task creation, and read-only requests are not part of that queue.

### Ambiguous create recovery

If GitHub may have accepted a create request but `gh` returned no usable response, Gitasks does not offer a blind create retry. Run `gitasks list --state all` or open the repository's Issues page, search for the exact proposed title, and reuse the issue if it exists. Retry creation only after confirming that it does not.

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
node dist/cli.js ui
```

To run this checkout without confusing it with any registry package, use `node dist/cli.js <command>` after `npm run build`, or install the exact local tarball produced by `npm pack`:

```bash
npm install -D C:/path/to/gitasks/gitasks-<version>.tgz
npx gitasks --version
```

The production bundle contains the executable Node.js shebang and targets Node.js 20+ ESM. `npm pack` and `npm publish` run the `prepack` build automatically, so a clean checkout does not require a committed `dist/` directory.

## License

[MIT](LICENSE)
