# Gitasks

Gitasks is a local workspace and task protocol for humans and coding agents, powered entirely by GitHub Issues. GitHub remains the source of truth: Gitasks has no local task database, hosted backend, SaaS account, or browser credential store.

![Gitasks 0.4 workspace](https://raw.githubusercontent.com/bilalnrts/gitasks/main/.github/assets/gitasks-workspace.png)

## Requirements

- Node.js 20 or newer
- Git
- [GitHub CLI](https://cli.github.com/) (`gh`)
- A repository whose `origin` points to `github.com`

Authenticate with the GitHub CLI before using Gitasks:

```bash
gh auth login
gh auth status
```

Gitasks uses the active `gh` authentication and never asks the browser for a token.

## Install and initialize 0.4

Install the exact 0.4 release in a repository:

```bash
npm install --save-dev gitasks@0.4.0
npx gitasks init
npx gitasks ui
```

The workspace opens at `http://127.0.0.1:4317`. To select another port:

```bash
npx gitasks ui --port 4400
```

`gitasks init` detects the current GitHub repository, verifies `gh` authentication, creates any missing `status:*` labels, and creates missing protocol files:

```text
.gitasks/
  config.json
  protocol.md
AGENTS.md
```

Initialization does not modify issues. An existing `.gitasks/protocol.md` is never replaced. If `AGENTS.md` already contains the `gitasks:start` marker, it is left unchanged; otherwise Gitasks appends its marked section and preserves all existing content. Re-running `init` is safe for consumer customizations.

## Workspace

The 0.4 workspace has five routes in a persistent sidebar. Each route can be opened directly and revisited with browser Back and Forward.

- **Overview** — repository-scoped operational summaries, assigned work, upcoming milestones, and recent updates. An unavailable section is shown as unavailable rather than as a zero.
- **Tasks** — board and list views over the same filtered data. Filter by GitHub state, one or more Gitasks statuses (including Unclassified), assignee, milestone, labels, or search; choose deterministic sorting. The board keeps the six workflow columns and displays unclassified issues separately.
- **Activity** — real repository issue and timeline activity with actor/event filters, an explicit coverage note, and manual pagination.
- **Pull Requests** — browse and manage pull requests, details, reviewers, reviews, checks, files, draft state, assignments, milestones, and guarded merges according to GitHub permissions and repository settings.
- **Milestones** — browse, create, edit, close, and reopen milestones; inspect linked work and GitHub's issue-and-pull-request progress counts.

Task moves are available through an accessible **Move to** menu in board, list, and detail views. Board cards also support pointer drag from their dedicated handle and touch long-press. Unclassified is not a drop target. A move to the current column or outside a valid target makes no request.

All pages provide explicit loading, empty, filtered-empty, partial, permission or unsupported, pending, error, and retry states where applicable. Data is refreshed explicitly; Gitasks does not poll and does not use WebSockets.

Stop the local server with `Ctrl+C`.

## CLI commands

```bash
gitasks --version
gitasks --help
gitasks init
gitasks ui
gitasks ui --port 4400
gitasks list
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

Moving a completed task back to an active status reopens its GitHub Issue. Status transitions add and remove only `status:*` labels, preserving unrelated labels.

## Issue protocol

Each classified task has one canonical status label and a matching title prefix:

```text
status:backlog       [BACKLOG] Implement login
status:todo          [TODO] Implement login
status:in-progress   [IN PROGRESS] Implement login
status:review        [REVIEW] Implement login
status:done          [DONE] Implement login
status:blocked       [BLOCKED] Implement login
```

Labels are machine-readable and canonical; title prefixes mirror them for people. When an issue has no status label, Gitasks recognizes a matching title prefix. If neither exists, the issue is **Unclassified**—not a seventh status—and remains unchanged until a user explicitly assigns one of the six statuses. New Gitasks tasks default to `BACKLOG`.

If status labels conflict, a matching title prefix wins. Without a matching prefix, Gitasks resolves the first status in lifecycle order: `BACKLOG`, `TODO`, `IN PROGRESS`, `REVIEW`, `DONE`, then `BLOCKED`. The next explicit transition removes conflicting `status:*` labels.

GitHub open/closed state remains separate from Gitasks status. `gitasks list` defaults to open issues, excludes pull requests, and prints both values. Use `--state closed` or `--state all` to change the issue scope and combine it with a `--status` filter.

## Coding agents

Run `gitasks init`, then direct coding agents to `AGENTS.md` and `.gitasks/protocol.md`. The protocol asks agents to:

1. search existing issues before opening one;
2. reuse the relevant issue when it exists;
3. classify an unclassified issue explicitly before starting it;
4. move active implementation to `IN PROGRESS`;
5. move review-ready work to `REVIEW`;
6. use `BLOCKED` for an external dependency;
7. move work to `DONE` only when completion is explicit and appropriate.

GitHub Issues remain canonical for roadmap work, bug reports, and feature proposals.

### Ambiguous mutation recovery

Gitasks does not blindly replay a non-idempotent create, review, or merge when GitHub may already have accepted it. Follow the recovery guidance shown in the UI or CLI, inspect GitHub, and retry only after confirming the operation did not complete. A pull-request merge is tied to the reviewed head SHA and is rejected if that SHA changes.

## Architecture

```text
Browser on 127.0.0.1
        │ same-origin HTTP + per-process CSRF token
        ▼
Gitasks Node.js server
        │ gh api
        ▼
GitHub REST and GraphQL APIs
```

Gitasks is a Node.js 20+ TypeScript ESM application using Commander and the installed `gh` CLI. The browser never receives GitHub credentials. There is no web framework, database, background polling, WebSocket, service account, or long-lived cache. One UI server process represents one repository. Mutations for the same issue, pull request, or milestone are serialized within that process; separate processes do not share a queue.

## Security model

- The HTTP server binds only to `127.0.0.1` and checks `Host` and mutation `Origin`.
- Mutations require a random, per-process CSRF token delivered only with the local app shell.
- A restrictive Content Security Policy allows local assets and narrowly permits GitHub avatar images.
- Titles, bodies, labels, diffs, logins, and other user-controlled values render as text. Only validated HTTP(S) GitHub or avatar URLs become links or images.
- Every GitHub REST request uses `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2026-03-10` through `gh api`.
- Non-idempotent writes are not automatically retried after ambiguous transport results.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and supported versions.

## GitHub permissions

Gitasks can only perform operations allowed by the authenticated GitHub account, repository rules, branch protection, and enabled GitHub APIs.

- Browsing needs repository metadata plus read access to issues and pull requests. Showing current CI results also needs Checks read and Commit statuses read.
- Creating or editing tasks, labels, assignments, relations, and milestones needs Issues write.
- Creating or editing pull requests, requesting reviewers, submitting reviews, changing draft state, or updating a branch needs Pull requests write.
- Merging a pull request needs Contents write.
- Merge methods and eligibility come from repository settings and protection rules; Gitasks does not bypass them and never offers branch deletion.

Permission and unsupported-API failures remain visible instead of being replaced with fake controls or data. GitHub's accepted-permissions response is authoritative for a failed endpoint. Use `gh auth status` to inspect the current login and follow GitHub's prompt if additional authorization is required.

## Data scope and limits

- GitHub is queried on demand. There is no offline mode or durable local cache.
- Lists use explicit pages or **Load more** and distinguish loaded items, known totals, and incomplete results. They do not present a loaded page as a repository total.
- Activity contains real issue/timeline events from its stated source and date coverage; it does not synthesize activity from `updated_at` timestamps.
- GitHub can truncate or omit large or binary diffs and can reject features unavailable to the repository or account. Gitasks states those limits and links to GitHub when appropriate.
- GitHub API rate limits, repository visibility, organization policy, token scopes, and API availability still apply.
- Repository detection reads the `origin` remote and supports standard HTTPS and SSH GitHub URLs. No repository credentials are stored locally.

## What changed from 0.3

0.3 provided the CLI and a single manually refreshed task board. 0.4 keeps the same six-status issue protocol and CLI behavior while adding the five-route workspace, shared task board/list filters, richer issue details, accessible drag and Move-to workflows, real activity, pull-request operations, milestones, explicit pagination/partial states, and guarded per-entity mutations. The localhost Host, Origin, CSRF, and CSP protections remain part of the design.

## Contributing

Bug reports, focused feature proposals, design feedback, documentation, tests, and code contributions are welcome. Search open and closed issues first; contributors do not need repository write access or permission to run `gitasks init`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the fork, development, security, screenshot, and pull-request workflow, and [ROADMAP.md](ROADMAP.md) for the next release direction.

## Develop locally

Run this checkout as 0.4 without resolving a registry package:

```bash
npm ci
npm run typecheck
npm test
npm run build
node dist/cli.js --version
node dist/cli.js --help
node dist/cli.js ui
```

`node dist/cli.js --version` must print `0.4.0`. Package verification performs a clean build, creates a temporary tarball without invoking lifecycle scripts, checks its exact allowlist and executable shebang, installs it into a temporary project, then smokes the installed help, version, and UI routes:

```bash
npm run verify:package
```

The npm package contains only the CLI bundle, three UI assets, package metadata, README, license, changelog, and security policy. Source, tests, development scripts, CI files, and the screenshot are excluded. `prepack` builds from source, so a committed `dist/` directory is not required.

See [CONTRIBUTING.md](CONTRIBUTING.md), [CHANGELOG.md](CHANGELOG.md), and [ROADMAP.md](ROADMAP.md).

## License

[MIT](LICENSE)
