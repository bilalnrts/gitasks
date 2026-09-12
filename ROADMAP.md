# Gitasks 0.5.0 Roadmap

GitHub Issues are the canonical source for roadmap scope, status, discussion, and acceptance criteria. This document records the intended 0.5.0 outcome; it is not a separate backlog, and no item ships until its GitHub Issue is accepted and assigned to the 0.5.0 milestone.

## Goal: truthful contribution analytics

Build an analytics workspace that helps maintainers understand repository flow without turning activity counts into a productivity score.

Candidate views:

- Open work by Gitasks status, assignee, and milestone, including unassigned and unclassified work.
- Workload distribution based on current assignments, clearly separated from historical contribution.
- Person-level assigned and completed issue activity plus pull-request and review contributions.
- Date-range, contributor, and milestone filters shared by summary tables and visualizations.
- Tables, charts, and time trends for supported metrics.
- Cycle-time views only where GitHub events provide defensible start and end transitions.
- Drill-through links from every aggregate to the GitHub records that produced it.

## Metric and attribution rules

Every metric must publish its definition, repository scope, time window, included event types, pagination coverage, and known gaps beside the result.

- Issue, commit, pull-request, review, or comment counts are contribution indicators—not hours worked, effort, quality, impact, or personal productivity.
- Gitasks will not estimate time worked when no real time-tracking source exists.
- Current assignees describe current ownership only; they must not be treated as the people who performed all earlier work.
- Completed-work attribution must come from available GitHub events, not from the issue's current assignee.
- Cycle time must name the exact state or status transitions used. Missing transitions produce unavailable or partial results, never invented timestamps.
- Bot, deleted-user, dismissed-review, reopened-item, and multi-author behavior must be explicit in each metric definition.
- Missing permissions, retention limits, API truncation, and incomplete history remain visible. Unknown data is not zero.
- No composite contributor score, leaderboard, ranking, or claim about individual performance is in scope.

## Architecture constraints

0.5.0 should query GitHub on demand and keep results repository-scoped and refresh-driven. It must not add a hosted service, analytics SDK, telemetry, persistent task database, offline synchronization, background polling, or speculative data collection. Small in-session caches and clearer typed read models are acceptable when they do not obscure coverage or make Gitasks a second source of truth.

The implementation should preserve the local Node server, `gh` authentication, plain-text rendering, explicit pagination, least-privilege permissions, and a small dependency footprint. Charting code is added only if a focused, accessible solution cannot be implemented with native browser primitives at lower package cost.

## How scope is decided

Use [GitHub Issues](https://github.com/bilalnrts/gitasks/issues) to propose, discuss, prioritize, and track every 0.5.0 item. Closing, editing, or moving an issue updates the canonical plan; this file does not override it.
