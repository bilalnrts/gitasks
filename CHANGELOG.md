# Changelog

All notable changes to Gitasks are documented here. GitHub Issues remain canonical for individual work items.

## 0.5.0 — Unreleased

Repository Analytics is implemented in the source checkout. This entry does not assert that a `v0.5.0` Git tag exists, that a GitHub Release has been published, or that `gitasks@0.5.0` is available from npm; those are separate release actions.

### Added

- A read-only **Analytics** workspace route with six tabs: **Summary**, **Issues**, **Pull Requests**, **Contributors**, **Milestones**, and **Repository**.
- Repository flow metrics covering current issue state and status, period issue events, verified close and cycle durations, stale issues, known status history, and native dependency blockers.
- Pull-request metrics covering opened, merged, and closed-unmerged work; current draft, review, and checks state; review events and waits; evidence-backed merge/review durations; and changed-file/line distributions.
- Contributor views that keep current assignments and review requests separate from period-authored issues, authored and merged pull requests, and submitted reviews. No composite score, ranking, or performance claim is produced.
- Milestone views for current issue and pull-request progress, remaining ownership and blocked signals, and evidence-backed known-history scope and burnup.
- Repository views for current GitHub language bytes and tags, GitHub-supported commit/code-frequency/contributor history, and published GitHub Releases.
- Shared 7-, 30-, 90-day and custom period controls; IANA time zones; day/week/month grouping; equal-duration previous-period comparison; milestone, label, person, role, and bot filters; and configurable stale-issue and review-wait thresholds. Custom ranges are rejected before computation if their grouping would exceed 4,000 calendar buckets.
- Native DOM/SVG/CSS charts with accessible table alternatives, stable-ID KPI and point drill-downs, deterministic search/sort/pagination, and CSV export from the complete filtered table rows.
- A public metric dictionary defining stable IDs, formulas, sources, time and filter bases, attribution, exclusions, comparisons, drill-downs, coverage, and GitHub limits.
- Deterministic hand-calculated analytics fixtures and a large-fixture benchmark entry point for focused correctness and performance validation.

### Changed

- Expanded the persistent workspace from five operational routes to six routes while preserving the 0.4 Overview, Tasks, Activity, Pull Requests, and Milestones behavior.
- Added one frozen typed analytics model shared by data loading, calculation, HTTP payloads, UI rendering, drill-downs, tables, and CSV.
- Added lightweight Analytics bootstrap data and progressive per-tab source loading. Analytics does not request data before the Analytics route is opened.
- Centralized metric calculation on the server; the browser renders returned values and does not maintain a second formula implementation.
- Added bounded TTL caching and in-flight request deduplication inside the repository-scoped local process, mutation-driven invalidation, bounded detail-read concurrency, and cancellation of superseded browser requests. No durable cache or database was added.
- Kept GitHub Issues and GitHub APIs as the source of truth and retained explicit user-driven refresh with no polling, WebSocket, hosted service, telemetry, or analytics SDK.

### Coverage and compatibility

- Metrics distinguish **current**, **period event**, and **historical** values. Current cards ignore date bounds and say so; period filters use inclusive-start/exclusive-end `[from, to)` instants grouped by the selected IANA time zone.
- Incomplete current days and periods are labeled. Equal-duration comparisons expose both periods, and percentage change is unavailable rather than infinite when the previous value is zero.
- Every source can report **complete**, **partial**, **unsupported**, **pending**, or **error** coverage with loaded count, known total, covered range, exclusions, reason, fetch time, and limitations. Optional-source failures do not disable unrelated metrics, and unknown or no-sample values are not changed to zero.
- Current record-field filters are labeled and are not represented as event-time attribution. GitHub `CLOSED` remains separate from Gitasks `DONE`; current assignees remain separate from historical contribution.
- Multi-label and multi-assignee grouping can exceed unique-record totals. Repeated close/reopen events remain events unless a metric explicitly calculates unique records.
- General GitHub Events API history is not treated as complete because GitHub limits it to 300 events and 30 days. GitHub statistics may remain pending, exclude merge commits (and empty commits for contributor statistics), and limit code-frequency support to repositories below 10,000 commits.
- Requires Node.js 20 or newer, Git, and GitHub CLI authentication. The TypeScript ESM, Commander CLI, six-status issue protocol, existing CLI lifecycle, `gh api` transport, and framework-free browser UI remain compatible with 0.4.

### Security

- Analytics server endpoints are read-only and validate every query key and value. They do not accept a client-supplied repository, URL, path, or command and perform no GitHub mutation.
- Preserved loopback-only binding, Host and mutation-Origin validation, per-process CSRF tokens, restrictive CSP, browser credential isolation, and text-only rendering of GitHub/user content.
- CSV applies RFC 4180 quoting and protects values beginning with `=`, `+`, `-`, or `@` after optional whitespace from spreadsheet formula execution.
- Analytics deduplicates by stable GitHub IDs, bounds concurrent detail reads, and caps per-record timeline/review/check/requested-team/dependency hydration at 100 applicable records per source. Truncation is reported as partial coverage with excluded counts; permission, pagination, retention, transport, and rate-limit failures remain explicit.

### Package and release

- Package metadata and local CLI output target 0.5.0, but repository metadata is not proof of an npm publication.
- No analytics charting or framework runtime dependency was added; charts use native browser primitives and Commander remains the only runtime dependency.
- The package allowlist contains the CLI bundle, three UI assets, package metadata, README, license, changelog, security policy, and `docs/analytics-metrics.md`. Analytics is included in the bundled UI app; source, tests, development scripts, CI files, release screenshots, and `.github/assets/gitasks-analytics.png` are excluded from the npm tarball.
- `prepack` builds from source, and `prepublishOnly` gates maintainer publication on type checking, tests, and package verification. No result from those commands, CI, or a browser check is claimed by this changelog entry.

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
