# Gitasks Roadmap

GitHub Issues are the canonical source for roadmap scope, status, discussion, and acceptance criteria. This file summarizes release direction; it is not a second backlog and does not override an issue, milestone, or accepted decision.

## 0.5.0: Repository Analytics

The planned 0.5 Repository Analytics scope is implemented in the source checkout and remains unreleased. A source version or Git tag does not by itself mean that a GitHub Release exists, and a GitHub Release does not mean that an npm package has been published. Check those channels independently.

### Implemented scope

- A read-only **Analytics** workspace route with **Summary**, **Issues**, **Pull Requests**, **Contributors**, **Milestones**, and **Repository** tabs.
- Shared period, IANA time zone, grouping, comparison, milestone, label, person, role, bot, stale-issue, and review-wait controls, with irrelevant controls disabled.
- Explicit separation of current ownership/state, period events, and evidence-backed historical metrics.
- Accessible native charts with matching table alternatives, stable-ID drill-downs, deterministic table behavior, and CSV export from the same filtered rows.
- Published metric IDs and formulas, source coverage, calculation text, sample and exclusion counts, comparison rules, and visible limitations.
- Progressive per-tab GitHub loading, bounded concurrency and in-memory caching, superseded-request cancellation, and no analytics reads outside the Analytics route.
- Truthful **complete**, **partial**, **unsupported**, **pending**, and **error** states. A missing optional source does not disable unrelated metrics, and unknown data is never shown as zero.

### Metric and attribution rules

Every metric publishes its definition, repository scope, time window, included event types, pagination coverage, and known gaps beside the result.

- Issue, commit, pull-request, review, or comment counts are contribution indicators—not hours worked, effort, quality, impact, or personal productivity.
- Gitasks does not estimate time worked when no real time-tracking source exists.
- Current assignees describe current ownership only; they are not treated as the people who performed all earlier work.
- Completed-work attribution comes from available GitHub events, not from the issue's current assignee.
- Cycle time names the exact state or status transitions used. Missing transitions produce unavailable or partial results, never invented timestamps.
- Bot, deleted-user, dismissed-review, reopened-item, and multi-author behavior is explicit in each metric definition.
- Missing permissions, retention limits, API truncation, and incomplete history remain visible. Unknown data is not zero.
- No composite contributor score, leaderboard, ranking, or claim about individual performance is included.

### Architecture constraints retained

0.5 queries GitHub on demand and keeps results repository-scoped and refresh-driven. It adds no hosted service, analytics SDK, telemetry, persistent task database, offline synchronization, background polling, or speculative data collection. Bounded in-process caching never replaces GitHub as the source of truth.

The implementation preserves the local Node server, `gh` authentication, plain-text rendering, explicit coverage, least-privilege permissions, localhost Host/Origin/CSRF/CSP protections, and the existing runtime dependency footprint. Charts use native DOM, SVG, and CSS.

## After 0.5

No post-0.5 feature is committed by this document. Proposals, priorities, release milestones, and acceptance criteria continue to be decided in [GitHub Issues](https://github.com/bilalnrts/gitasks/issues). Direction after 0.5 is to evolve only from accepted repository needs while preserving the issue protocol and GitHub source-of-truth model; metric correctness and coverage honesty, accessibility, security, compatibility, and large-repository performance remain release gates rather than a list of invented features.
