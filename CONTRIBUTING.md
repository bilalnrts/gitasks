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
src/analytics/            Analytics query, time, compute, CSV, and service logic
docs/analytics-metrics.md Public metric IDs, formulas, source, coverage, and limits
scripts/benchmark-analytics.mjs
                          Large-fixture analytics benchmark
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

A source version, Git tag, published GitHub Release, and npm publication are separate states. Ordinary contributions must not create a tag or GitHub Release, and must not run `npm publish`. Maintainers decide and perform each release action separately.

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

## Adding or changing an Analytics metric

Repository Analytics has two frozen public contracts:

- `src/analytics/types.ts` is the only cross-layer model. Extend that model when a genuinely new returned field is required; do not define a second analytics payload shape in the server, browser, tests, or CSV code.
- `docs/analytics-metrics.md` is the calculation contract. A metric change is incomplete until its stable ID, display name, question, formula, source, time basis, kind, unit, deduplication key, supported roles and filters, inclusions, exclusions, comparison behavior, coverage limits, and drill-down record type agree with the implementation.

Use the existing dotted metric-ID namespace and preserve an existing ID when its meaning is unchanged. Never reuse an ID for a different question or silently change its denominator, event type, attribution, or time basis. If the formula's observable meaning must change, update the public dictionary and changelog in the same pull request and call out compatibility impact.

Keep formulas centralized in `src/analytics/compute.ts`. The service loads and validates source data; the browser renders the returned payload and must not independently recalculate totals, durations, comparisons, buckets, or filter semantics. CSV must derive from the returned table rows through the shared CSV implementation rather than reproducing a metric formula.

For each metric:

1. Identify whether it is **current**, **period event**, or **historical**, and use the shared `[from, to)` and IANA-time-zone bucketing rules.
2. Select the stable GitHub database ID used for record, event, review, release, or week deduplication and drill-down. Do not deduplicate repeated close/reopen events as if they were unique issues unless the metric explicitly asks for a unique-record count.
3. State whether each filter is based on event-time evidence, current record fields, record fields, or is not applicable. Disable irrelevant filters rather than accepting and ignoring them.
4. Return complete metadata: sample size, numerator and denominator where relevant, period, calculation time, previous value and change when supported, calculation text, warnings, detail IDs, and coverage.
5. Treat missing pages, fields, permissions, dates, identities, or optional sources as unknown. Use **partial**, **unsupported**, **pending**, or **error** with a reason and limitations; never replace unknown data with zero or disable unrelated metrics.

### Hand-calculated fixtures

Add a small deterministic fixture whose expected result can be calculated by hand. Include boundary timestamps at the inclusive start and exclusive end where relevant, an even-sized median sample, a nearest-rank P75 sample, repeated events, multi-label or multi-assignee records when supported, and a missing or contradictory source case that exercises truthful coverage. Use synthetic IDs, logins, titles, and timestamps; fixtures must not contain repository data, screenshots, credentials, prompts, model output, or personal data.

Write down the arithmetic in the test structure through explicit inputs and expected values, not by calling production helpers to calculate the expectation. Assert the observable metric contract—value, sample, numerator/denominator, period and comparison, filter basis, coverage/warnings, and exact drill-down IDs. A fixture for a duration metric must prove which records were included and excluded; a grouped fixture must prove whether totals may legitimately exceed the unique-record count.

### Large-fixture benchmark

Extend `scripts/benchmark-analytics.mjs` when a new source, join, grouping, or fan-out can change large-repository cost. Use deterministic generated records with stable synthetic IDs and fixed timestamps. Exercise the affected section at representative large-fixture sizes, keep the input reproducible, and report elapsed time, record counts, and relevant process memory without network access. Benchmark the full changed calculation path rather than a toy helper, and verify that per-record GitHub reads remain concurrency-bounded. Benchmark results are diagnostic evidence, not a correctness test or a reason to hide partial coverage.

Run the benchmark explicitly when applicable:

```bash
node scripts/benchmark-analytics.mjs
```

Include the fixture size, command, environment, and observed before/after measurements in the pull request. Do not present unrun or incomparable measurements as results.

### Chart, table, drill-down, and CSV parity

For every KPI or chart change, validate the browser against the same returned payload used by the test:

- each chart series total equals its table alternative total for the same filters and buckets;
- chart points and KPI drill-downs retain exactly the returned stable IDs, including event IDs when events—not unique records—are counted;
- search, sorting, and pagination change table presentation without changing the reported total scope;
- CSV exports all filtered table rows rather than only the visible page, with the same columns, values, ordering contract, period, filters, coverage, and calculation metadata;
- RFC 4180 quoting preserves Unicode and embedded CR/LF, and optional leading whitespace before `=`, `+`, `-`, or `@` cannot bypass spreadsheet formula-injection protection;
- complete, partial, unsupported, pending, error, incomplete-period, unavailable-value, and disabled-filter states remain distinguishable in both chart and table views.

Record which focused tests and manual browser scenarios were actually run. Do not claim chart/table/CSV parity from a unit test alone, and do not claim a browser check that was not performed.

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
