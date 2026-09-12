# Changelog

All notable changes to Gitasks are documented here. GitHub Issues remain canonical for individual work items.

## 0.4.0 — 2026-09-12

### Added

- A five-route local workspace for Overview, Tasks, Activity, Pull Requests, and Milestones, with direct History API routes and a responsive navigation drawer.
- Shared task board and list filtering, deterministic sorting, richer issue details, accessible Move-to actions, pointer drag handles, and touch long-press movement.
- Real repository activity with explicit source/date coverage and manual pagination.
- Pull-request browsing and guarded create, edit, assignment, milestone, reviewer, review, draft, and merge workflows governed by GitHub permissions and repository rules.
- Milestone list, detail, create, edit, close, and reopen workflows with issue-and-pull-request progress wording.
- Explicit loading, empty, filtered-empty, partial, permission, unsupported, pending, ambiguous-result, and retry states throughout the workspace.
- Contributor, security, roadmap, issue-template, pull-request-template, and least-privilege CI documentation.
- A clean modular build and installed-tarball verifier covering the release allowlist, version, shebang, UI assets, CLI help/version, and local UI routes.

### Changed

- Bumped package metadata and CLI output from 0.3.0 to 0.4.0.
- Extended task summaries and details with assignees, milestones, relations, and linked pull-request context where GitHub supplies it.
- Made list coverage explicit through pagination metadata instead of presenting a loaded page as a repository total.
- Serialized same-entity mutations and protected current views from stale request results.
- Pinned every GitHub REST request to `application/vnd.github+json` and API version `2026-03-10`.
- Expanded initialization and agent guidance while preserving consumer-owned protocol and `AGENTS.md` content.
- Reduced the npm package to its executable bundle, required UI assets, package metadata, README, license, changelog, and security policy.

### Security

- Preserved loopback-only serving, strict Host and Origin validation, per-process CSRF protection, and restrictive CSP behavior.
- Continued to keep GitHub credentials in the `gh` CLI process rather than the browser.
- Required plain-text rendering for user content and validated HTTP(S) GitHub/avatar destinations.
- Added SHA verification and explicit ambiguous-result handling for pull-request merges; Gitasks does not offer protection bypass or branch deletion.

### Compatibility

- Requires Node.js 20 or newer, Git, and GitHub CLI authentication.
- Keeps the 0.3 six-status issue protocol and CLI lifecycle commands.
