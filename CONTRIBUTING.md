# Contributing to Gitasks

Thanks for helping improve Gitasks. GitHub Issues are the canonical record for bugs, feature proposals, and roadmap work.

## Before making a change

1. Search [existing issues](https://github.com/bilalnrts/gitasks/issues) for the same problem or proposal.
2. Reuse the relevant issue when one exists. Otherwise open the appropriate bug or feature form.
3. Keep the change focused on that issue and describe any observable behavior decisions there.
4. For security vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

For this repository's task workflow, read `.gitasks/protocol.md` and move the issue to the appropriate Gitasks status.

External contributors are not expected to have permission to change repository labels, assignees, milestones, or Gitasks statuses. You can contribute without running `gitasks init` or having write access; a maintainer will coordinate task metadata when needed.

## Development environment

Requirements:

- Node.js 20 or newer
- npm
- Git
- GitHub CLI (`gh`) for CLI and local-workspace integration

Fork the repository on GitHub, then clone your fork and install dependencies:

```bash
git clone https://github.com/<your-account>/gitasks.git
cd gitasks
npm ci
```

## Architecture map

```text
src/cli.ts                 Commander entry point
src/commands/              CLI command adapters
src/tasks/                 Shared status and task rules
src/github/                gh-backed GitHub transport and mapping
src/workspace/             Workspace API contracts
src/ui/server.ts           Loopback HTTP API and security boundary
src/ui/client/             Framework-free browser routes and components
test/                      Command, server, and workspace contract tests
```

The browser calls only the local same-origin API. The Node process performs GitHub operations through `gh api`; GitHub credentials never enter browser code.

Run the relevant checks before submitting a pull request:

```bash
npm run typecheck
npm test
npm run build
npm run verify:package
```

`npm test` discovers every `test/*.test.ts` file. `npm run verify:package` deletes reliance on any previous build by producing a clean bundle, packs the allowlisted release files, installs that tarball in a temporary project, and smokes its CLI and local UI.

To exercise the checkout against a repository using your existing `gh` login:

```bash
npm run build
node dist/cli.js --version
node dist/cli.js ui
```

### Test safely

Unit and integration tests must use fixtures or command fakes and must not mutate the developer's repository through their normal `gh` session. Use a separate disposable test repository for manual mutation checks. Never test review requests or review submission against real collaborators without their explicit consent; those actions send notifications. A real merge requires a dedicated authorized test branch or repository—otherwise cover it with controlled fixtures and read-only live checks.

Do not publish a package or create a release as part of a contribution.

## Implementation expectations

- Preserve Node.js 20+ TypeScript ESM and Commander conventions.
- Keep GitHub Issues canonical. Do not introduce a database, hosted service, browser credential, polling loop, or WebSocket.
- Send GitHub requests through `gh api`; never expose a GitHub token to the browser.
- Preserve the localhost Host, Origin, CSRF, and CSP protections.
- Render GitHub and user content as text. Validate allowed HTTP(S) URLs before creating links or images.
- Keep non-idempotent mutation recovery explicit; do not blindly retry a create, review, or merge whose result is ambiguous.
- Preserve unrelated issue fields during status changes and serialize conflicting mutations by entity.
- Show loading, empty, filtered-empty, partial, permission, unsupported, pending, error, and retry states honestly. Do not add fake controls or inferred totals.
- Add or update tests for observable contracts changed by the contribution. Do not place tokens, personal data, issue content, screenshots, prompts, or model output in tests or logs.

## Pull requests

A pull request should:

- link its canonical issue;
- explain the user-visible behavior and security impact;
- remain scoped and avoid unrelated formatting changes;
- include focused verification steps and results;

- include before-and-after screenshots for user-interface changes, using sanitized or disposable test data;
- update documentation and the changelog when the public contract changes;
- avoid generated `dist/`, tarballs, dependencies, credentials, and local repository data.

CI runs with `contents: read` only and never publishes. Maintainers decide release timing and package publication separately from pull-request validation.

Maintainers review contributions for scope, observable behavior, tests, accessibility, security, package cost, and compatibility. They may update canonical issue metadata or request focused changes before merging; the project does not promise a review or release service-level agreement.
