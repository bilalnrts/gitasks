# Gitasks Analytics Metric Dictionary

This document is the public calculation contract for Gitasks 0.5 analytics. GitHub is the source of truth. A missing event, permission, page, user, timestamp, or statistic is unknown data—not zero. Metrics return value, unit, period, calculation time, sample size, numerator/denominator where relevant, coverage, warnings, calculation text, filter basis, and drill-down record IDs.

## Shared time and counting contract

- Timestamps are stored and compared as UTC instants. Calendar buckets use the selected IANA time zone.
- Periods are inclusive at `from` and exclusive at `to`: `[from, to)`. Date controls map the first selected local day to its start and the day after the final selected day to the exclusive end.
- One Analytics request may materialize at most 4,000 calendar buckets. A custom range and grouping combination above that fixed bound is rejected before bucket allocation or metric computation.
- The current day and an unfinished selected period are marked incomplete. They are never compared with a completed period without an explicit warning.
- The previous comparison period has the same elapsed duration and ends at the selected period's start. Both boundaries are returned.
- Change percentage is `(current - previous) / abs(previous) * 100`. If the previous value is zero, change percentage is unavailable rather than infinite.
- Durations are elapsed calendar days, not working time or effort. Duration samples with no defensible start or end are excluded and counted in warnings. No-sample duration metrics return `null`, not zero.
- Median uses the midpoint average for an even sample. P75 uses nearest-rank: sorted value at `ceil(0.75 * n) - 1`.
- Current metrics use current record fields. Event metrics use event-time fields only where GitHub provides them. A filter based on current record fields is labeled `record-fields`; it is never described as event-time classification.
- Multi-label and multi-assignee groups count one issue in every applicable group, so grouped totals can exceed unique issue totals. Each metric still deduplicates its base record by stable GitHub database ID; events and reviews deduplicate by their own stable IDs.
- GitHub `CLOSED` state and Gitasks `DONE` status are separate. Closing events and current DONE records are separate metrics.
- Reopened and repeated closing events are event counts. A companion unique-record count is used where needed; neither is substituted for the other.
- Current `closed_at` alone cannot prove prior close/reopen episodes. Episode metrics require timeline events.
- Status history uses `labeled`/`unlabeled` status labels and `renamed` evidence. Adjacent Gitasks label/title events produced by one transition are coalesced. Unknown starts, contradictions, and gaps remain unknown.
- Person identity prefers stable GitHub user database ID. Login is display metadata. Deleted or inaccessible users use an explicit deleted-user identity; unmatched commit authors use an unmatched-author fallback. Bots are identified from GitHub type or the `[bot]` suffix.
- GitHub's general Events API is limited to 300 events and 30 days and is not used as complete history. Issue/timeline endpoints are used for issue and PR history. Statistics endpoints may return `202` while GitHub prepares data and exclude merge commits; contributor statistics also exclude empty commits.

## Coverage states

| State | Meaning |
| --- | --- |
| `complete` | Every required page and field for the stated scope was loaded. |
| `partial` | A useful subset was calculated; warnings name missing pages, fields, dates, or records. |
| `unsupported` | GitHub does not provide the required source for this repository or scope. |
| `pending` | GitHub accepted a statistics request and is preparing the result. |
| `error` | Permission, rate-limit, validation, or transport failure prevented calculation. |

Every source reports loaded count, known total when available, covered time range, excluded count, fetch time, reason, and limitations. One failed optional source does not invalidate unrelated metrics.
- Per-record hydration sources (issue/PR timelines, reviews, checks, requested teams, and issue dependencies) load at most 100 records per source for one Analytics request. If more applicable records exist, coverage is `partial`, the excluded count is reported, and metrics that require the omitted evidence are not presented as complete.

## Issue and flow metrics

| ID / display name | Question and formula | Source, time, kind, unit, key | Roles and filters | Inclusion, edge cases, comparison, drill-down |
| --- | --- | --- | --- | --- |
| `issues.current.open` / Open issues | How much issue work is open now? Count unique non-PR issues with state `open`. | Issues API; current; issues; issue DB ID. | Current assignee, milestone, label, bot-author filters. | Includes every GitHub-open issue regardless of Gitasks status. Details: issue records. |
| `issues.current.in_progress` / In progress | What is actively marked IN PROGRESS? Count current open issues whose resolved Gitasks status is `IN PROGRESS`. | Issues API; current; issues; issue ID. | Current fields. | Conflicting status evidence follows protocol; conflicts warn. Details: issues. |
| `issues.current.blocked` / Blocked status | What is explicitly BLOCKED? Count current open issues with Gitasks `BLOCKED`. | Issues API; current; issues; issue ID. | Current fields. | Separate from dependency blockers. Details: issues. |
| `issues.current.unclassified` / Unclassified | Which open issues have no recognized Gitasks status? | Issues API; current; issues; issue ID. | Current fields. | Never changes those issues. Details: issues. |
| `issues.period.opened_events` / Issues opened | How many issue creation events occurred? Count issues with `created_at` in period. | Issues API; `created_at`; period event; count; issue ID. | Author plus current-record milestone/label filters when selected. | PRs excluded. Comparison uses previous equal period. Details: issue records. |
| `issues.period.closed_events` / Closing events | How many closing events occurred? Count timeline `closed` events in period. | Issue timeline/events API; event `created_at`; period event; count; event ID. | Actor where available; current-record filters labeled as such. | Repeated closes count separately; missing timeline is partial. Details: events. |
| `issues.period.closed_unique` / Issues closed | How many distinct issues had at least one closing event? Unique issue numbers among period closing events. | Timeline/events; event time; period event; issues; issue ID. | Actor/current-record filters. | Repeated closes deduplicated here only. Details include issues and events. |
| `issues.period.completed_unique` / Completed issues | How many distinct issues reached Gitasks DONE? Unique issues with a defensible DONE transition in period. | Status label/title timeline; event time; period event; issues. | Actor/current-record filters. | GitHub close without DONE excluded; unknown transition history is partial. |
| `issues.period.closed_not_completed` / Closed without DONE | Which closed issues did not have a proven DONE transition for that closing episode? | Close and status events; event time; period event; issues. | Actor/current-record filters. | Uses `state_reason` when known; otherwise reason is unknown, never guessed. |
| `issues.period.reopened_events` / Reopening events | How often were issues reopened? Count timeline `reopened` events in period. | Timeline/events; event time; period event; count; event ID. | Actor/current-record filters. | Multiple reopenings count. Details: events. |
| `issues.period.reopened_unique` / Reopened issues | How many distinct issues reopened? Unique issue number among reopening events. | Timeline/events; event time; period event; issues. | Actor/current-record filters. | Details retain all contributing events. |
| `issues.duration.close.median` / Median time to close | Typical elapsed creation-to-closing duration. Median of each closing episode's `created_at` or preceding reopen event to close event. | Issue + timeline; close event time; historical; days; close event ID. | Current-record filters. | Future/inverted timestamps excluded; sample and P75 companion reported. Details: closing episodes. |
| `issues.duration.close.p75` / P75 time to close | Upper-quartile elapsed creation/reopen-to-close duration using nearest rank. | Same as median; days. | Same. | No sample returns unavailable. |
| `issues.duration.cycle.median` / Median verified cycle time | Typical elapsed IN PROGRESS-to-DONE duration. Median of evidence-backed episodes. | Status label/title events; historical; days; status episode key. | Current-record filters. | Never falls back to issue creation. Contradictory or missing starts excluded. |
| `issues.duration.cycle.p75` / P75 verified cycle time | P75 of verified cycle-time episodes. | Status events; historical; days. | Current-record filters. | Same exclusions; sample count mandatory. |
| `issues.current.age` / Open issue age | How long has each open issue existed? `now - created_at`. | Issues API; current; days; issue ID. | Current fields. | Open issues only; not included in completed duration samples. Details: issues. |
| `issues.current.stale` / Stale open issues | Which open issues have not been updated for the configured threshold? `now - updated_at >= staleDays`. | Issues API; current; issues. | Current fields. | Measures record update age, not same-status waiting. Threshold returned. |
| `issues.current.status_distribution` / Status distribution | Where is current work? Count open issues by six statuses plus UNCLASSIFIED. | Issues API; current; issues. | Current fields. | One resolved status per issue. Details: issues per bucket. |
| `issues.current.label_distribution` / Label distribution | Which labels are attached to current issues? Count unique open issues per non-status label. | Issues API; current; issues. | Current fields. | Multi-label totals may exceed unique issues; Top-N includes Other and full table. |
| `issues.current.assignee_distribution` / Assignee distribution | How is current open work assigned? Count each issue once per current assignee, or Unassigned. | Issues API; current; issues. | Person/assignee, milestone, label; bot handling. | Multi-assignee totals may exceed unique issues. |
| `issues.history.status_time` / Time in status | How long did issues remain in REVIEW, BLOCKED, and other statuses? Sum evidence-backed status intervals by issue/status. | Status events; historical; days; episode key. | Current-record filters. | Open intervals end at calculation time and are labeled ongoing; unknown starts excluded. |
| `issues.history.cumulative_flow` / Known-history cumulative flow | How many issues were in each proven status over time? Replay evidence-backed status intervals at bucket boundaries. | Status events; historical snapshot; issues. | Current-record filters. | Only reconstructed records and supported range; gaps are not filled. Details: issue/status snapshots. |
| `issues.dependencies.waiting` / Dependency-blocked issues | Which open issues have unresolved native blockers? Count open issues with at least one open `blocked_by` relation. | Issue Dependencies API + Issues API; current; issues. | Current fields. | Separate from BLOCKED status; partial relation reads warn. |
| `issues.dependencies.blockers` / Multi-issue blockers | Which issues block multiple open issues? Count distinct open dependents per blocker. | Dependencies API; current; issues. | Current fields. | Table includes blocker and dependent links. |

## Pull request metrics

| ID / display name | Question and formula | Source, time, kind, unit, key | Roles and filters | Inclusion, edge cases, comparison, drill-down |
| --- | --- | --- | --- | --- |
| `prs.period.opened` / PRs opened | Count PRs with `created_at` in period. | Pulls API; period event; pull requests; PR ID. | Author, current milestone/label, bot. | Comparison supported. Details: PRs. |
| `prs.period.merged` / PRs merged | Count unique PRs with `merged_at` in period. | Pulls API; period event; pull requests; PR ID. | Author/current fields. | Attribution is PR author, not merge actor. |
| `prs.period.closed_unmerged` / Closed without merge | Count PRs with `closed_at` in period and no `merged_at`. | Pulls API; period event; pull requests. | Author/current fields. | Drafts included and identified. |
| `prs.current.state_distribution` / Open PR state | Count current open PRs as draft or ready. | Pulls API; current; PRs. | Author/current fields. | Re-draft history does not change this current metric. |
| `prs.current.review_waiting` / Review waiting | Count open ready PRs with requested reviewers or review-required state. | Pulls + requested reviewers; current; PRs. | Author/reviewer/current fields. | Drafts excluded. Missing review data is unknown, not waiting. |
| `prs.current.changes_requested` / Changes requested | Count open PRs whose latest non-dismissed reviewer decisions include changes requested. | Reviews API; current; PRs. | Author/reviewer/current fields. | Per reviewer, latest submitted non-dismissed decision wins. Pending reviews excluded. |
| `prs.current.checks_distribution` / Current checks | Count open PR current heads by success, failure, pending, neutral, unknown. | Check runs + commit statuses for current `head.sha`; current; PRs. | Author/current fields. | No checks is `unknown`, never success. |
| `prs.duration.merge.median` / Median time to merge | Median elapsed `created_at` to `merged_at` for PRs merged in period. | Pulls API; merged time; historical; days; PR ID. | Author/current fields. | Future/inverted values excluded; P75 and sample reported. |
| `prs.duration.merge.p75` / P75 time to merge | P75 nearest-rank elapsed create-to-merge. | Pulls API; days. | Same. | No sample is unavailable. |
| `prs.duration.first_review.median` / Median time to first review | Median `created_at` to first submitted, non-pending, non-dismissed review. | Pulls + Reviews; review submitted time; historical; days. | Author/reviewer/current fields. | Owner/self review remains visible and separately classifiable; normal comments excluded. |
| `prs.duration.ready_review.median` / Ready to first review | Median from latest ready-for-review event that starts the reviewed ready episode to first valid review. | Timeline + Reviews; historical; days. | Author/reviewer/current fields. | Draft→ready→draft→ready uses the ready episode containing the review; missing events excluded. |
| `prs.duration.ready_merge.median` / Ready to merge | Median from the ready event for the final ready episode to merge. | Timeline + Pulls; historical; days. | Author/current fields. | Re-drafted intervals are not treated as continuously ready. |
| `prs.reviews.submitted` / Submitted reviews | Count submitted non-pending reviews in period; dismissed reviews remain a separate state and are excluded from decision metrics. | Reviews API; `submitted_at`; period event; reviews; review ID. | Reviewer, PR author, bot. | Review count can exceed reviewed PR count. Details: reviews. |
| `prs.reviews.reviewed_unique` / PRs reviewed | Count distinct PRs with at least one valid submitted review in period. | Reviews; period event; PRs. | Reviewer/author/bot. | Pending excluded; dismissed explicitly reported. |
| `prs.current.request_wait` / Review request age | For each current requested reviewer, elapsed time since latest unmatched request event. | Timeline + current requested reviewers; current; days; PR/reviewer pair. | Reviewer/author. | Missing request event yields unknown age, not PR creation fallback. |
| `prs.current.stale_review` / Long-waiting review | Current ready PR/reviewer requests older than `reviewWaitDays`. | Timeline + current reviewers; current; requests. | Reviewer/author. | Threshold returned; unknown request ages excluded and warned. |
| `prs.size.files` / Changed files distribution | Distribution of changed file counts for period PRs. | Pull detail; record fields; files; PR ID. | Author/current fields. | Partial when GitHub omits totals; not effort/quality. |
| `prs.size.lines` / Line change distribution | Additions and deletions by period PR. | Pull detail; record fields; lines; PR ID. | Author/current fields. | Binary/generated semantics are not inferred; not effort/quality. |

## Contributor metrics

| ID / display name | Question and formula | Source, time, kind, unit, key | Roles and filters | Inclusion, edge cases, comparison, drill-down |
| --- | --- | --- | --- | --- |
| `people.current.assigned_open` / Assigned open issues | Count current open issue assignments per person; Unassigned is separate. | Issues API; current; issues; issue/person pair. | Assignee, milestone, label, bot. | Multi-assignment counts in each person's row. |
| `people.current.in_progress` / In-progress assignments | Current assigned open IN PROGRESS issues per assignee. | Issues API; current; issues. | Assignee/current fields. | Not historical contribution. |
| `people.current.blocked` / Blocked assignments | Current assigned open BLOCKED issues per assignee. | Issues API; current; issues. | Assignee/current fields. | Separate from native dependency blocking. |
| `people.current.review_requests` / Pending review requests | Current requested-reviewer pairs per reviewer. | Pulls API; current; requests; PR/reviewer pair. | Reviewer, author, bot. | Teams are reported as unsupported until modeled, never assigned to a fake person. |
| `people.period.issues_authored` / Issues opened | Issues created in period by author. | Issues API; `created_at`; period event; issues. | Author, bot, current record filters. | Deleted author explicit. |
| `people.period.prs_authored` / PRs opened | PRs created in period by author. | Pulls API; `created_at`; period event; PRs. | Author, bot, current fields. | No performance ranking. |
| `people.period.prs_merged` / Own PRs merged | PRs merged in period grouped by PR author. | Pulls API; `merged_at`; period event; PRs. | Author, bot, current fields. | Merger actor is not substituted for author. |
| `people.period.prs_reviewed` / Different PRs reviewed | Distinct PRs with a valid submitted review by reviewer in period. | Reviews API; `submitted_at`; period event; PRs. | Reviewer, bot. | Latest decision is irrelevant to contribution count; pending excluded. |
| `people.period.reviews_submitted` / Reviews submitted | Submitted non-pending review count by reviewer in period. | Reviews API; review time; period event; reviews. | Reviewer, bot. | Dismissed retained as state but excluded from decision summaries; normal comments excluded. |
| `people.period.contribution_trend` / Contribution trend | Per bucket, separate authored issues, authored PRs, merged own PRs, and submitted reviews for the selected person. | Issues, Pulls, Reviews; event times; counts. | Selected person/role and bot. | Series remain separate; no composite score. Details preserve source type. |

## Milestone metrics

| ID / display name | Question and formula | Source, time, kind, unit, key | Roles and filters | Inclusion, edge cases, comparison, drill-down |
| --- | --- | --- | --- | --- |
| `milestones.current.open` / Open milestones | Count current open milestones. | Milestones API; current; count; milestone ID. | Milestone filter only. | Details: milestones. |
| `milestones.current.closed` / Closed milestones | Count current closed milestones. | Milestones API; current; count. | Milestone. | Closing a milestone does not imply child completion. |
| `milestones.current.overdue` / Overdue milestones | Open milestones with `due_on < now`. | Milestones API; current; milestones. | Milestone. | Missing due date excluded. |
| `milestones.current.issue_progress` / Issue progress | Current unique issue members split open/closed and Gitasks status. | Issues + milestone; current; issues. | Milestone, label, assignee. | Empty milestone is `0 of 0`, not 100%. PRs excluded. |
| `milestones.current.pr_progress` / PR progress | Current unique PR members split open/closed/merged. | Issues/Pulls + milestone; current; PRs. | Milestone, author. | Separate from issue progress. |
| `milestones.current.remaining_assignment` / Remaining ownership | Current open milestone issues by assignee and Unassigned. | Issues; current; issues. | Milestone, assignee, label. | Multi-assignee note applies. |
| `milestones.current.remaining_blocked` / Remaining blocked work | Current open milestone issues split BLOCKED status and dependency-blocked. | Issues + Dependencies; current; issues. | Milestone/current fields. | Two signals remain separate. |
| `milestones.history.scope` / Known scope history | At each supported bucket, replay issue milestoned/demilestoned events to count known issue scope. | Timeline milestone events; historical snapshot; issues. | Milestone. | Never backfills today's membership before earliest evidence; supported range shown. PRs excluded. |
| `milestones.history.burnup` / Known-history burnup | Known issue scope and issues with closing events while in proven milestone membership. | Milestone + close events; historical; issues. | Milestone. | Later additions/removals change scope; partial if membership start unknown. No forecast. |

## Repository metrics

| ID / display name | Question and formula | Source, time, kind, unit, key | Roles and filters | Inclusion, edge cases, comparison, drill-down |
| --- | --- | --- | --- | --- |
| `repository.current.languages` / Language bytes | Current language byte counts by GitHub linguist classification. | Languages API; current; bytes; language name. | Repository only; person/milestone filters disabled. | Bytes are not lines or effort. Top-N includes Other and full table. |
| `repository.history.commits` / Commit activity | Weekly commit counts for the default branch over GitHub's supported last-year window. | `stats/commit_activity`; historical; count; week timestamp. | Repository only. | Excludes merge commits per GitHub; `202` is pending; API time granularity is not refined. |
| `repository.history.code_frequency` / Code frequency | Weekly additions/deletions on default branch. | `stats/code_frequency`; historical; lines; week timestamp. | Repository only. | Under 10,000 commits only; merge commits excluded; not effort/quality. |
| `repository.history.contributors` / Contributor commit activity | Per GitHub contributor, commits/additions/deletions by week. | `stats/contributors`; historical; count/lines; person/week. | Contributor and bot where supported. | Excludes merge and empty commits; unmatched authors use explicit fallback; 10k repositories can report zero line changes. |
| `repository.releases.published` / Published releases | Published non-draft releases by `published_at`. | Releases API; period event; releases; release ID. | Repository only. | Stable and prerelease are separate; ordinary tags are not releases. |
| `repository.releases.interval` / Release interval | Elapsed days between adjacent published releases, separately labeled stable/prerelease sequence. | Releases API; historical; days; release pair. | Repository only. | No-sample unavailable; draft releases excluded. |
| `repository.current.latest_release` / Latest release | Most recent published GitHub release by `published_at`. | Releases API; current; count metadata; release ID. | Repository only. | Absence says no GitHub release; it says nothing about npm publication. |
| `repository.current.tags` / Git tags | Current repository tags and commit SHAs. | Repository Tags API; current; count; tag name. | Repository only. | Tags without GitHub releases remain tags. Details link to GitHub. |

## Charts, tables, and CSV

- Every chart series point carries the source event or record IDs used to calculate it. Drill-down tables use those exact IDs; event charts preserve event rows rather than silently deduplicating them.
- Chart table alternatives contain the same series totals. CSV is generated from the same filtered rows, not the visible page, and includes comment-prefixed metadata rows for repository, metric/table ID, period, time zone, filters, scope, coverage, and calculation time.
- CSV follows RFC 4180 quoting. Values beginning with `=`, `+`, `-`, or `@` after optional whitespace receive a leading apostrophe to prevent spreadsheet formula execution. Unicode and embedded CR/LF are preserved inside quoted fields.
- Tables provide search, deterministic sorting, pagination, visible range, and total scope. Links open existing issue, PR, milestone, or GitHub release detail surfaces.
- Current cards ignore period bounds by definition and say so. Repository-only metrics disable milestone and person filters. A filter based on today's record fields is explicitly labeled `current record fields`.
