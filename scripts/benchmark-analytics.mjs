import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

if (process.env.GITASKS_BENCHMARK_TSX !== "1") {
  const require = createRequire(import.meta.url);
  const result = spawnSync(process.execPath, [require.resolve("tsx/cli"), fileURLToPath(import.meta.url)], {
    cwd: process.cwd(),
    env: { ...process.env, GITASKS_BENCHMARK_TSX: "1" },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else {
  const { buildAnalyticsSection } = await import("../src/analytics/compute.ts");
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const fixture = await createFixture(controller.signal);
  const query = {
    from: "2026-01-01T00:00:00.000Z",
    to: "2027-01-01T00:00:00.000Z",
    timezone: "UTC",
    grouping: "week",
    milestone: null,
    labels: [],
    person: null,
    role: null,
    includeBots: false,
    compare: true,
    staleDays: 14,
    reviewWaitDays: 3,
  };
  const before = process.memoryUsage().heapUsed;
  const started = performance.now();
  for (const section of ["summary", "issues", "pull-requests", "contributors", "milestones", "repository"]) {
    buildAnalyticsSection(fixture, { ...query, section }, new Date("2027-01-02T00:00:00.000Z"));
  }
  const elapsed = performance.now() - started;
  const memoryDelta = process.memoryUsage().heapUsed - before;

  console.log(`Fixture size: issues=${fixture.issues.length}, pullRequests=${fixture.pullRequests.length}, reviews=${fixture.reviews.length}, events=${fixture.events.length}`);
  console.log(`Elapsed milliseconds: ${elapsed.toFixed(2)}`);
  console.log(`Memory delta bytes: ${memoryDelta}`);
}

async function createFixture(signal) {
  const people = Array.from({ length: 120 }, (_, index) => ({
    id: `user:${index}`,
    login: `user-${index}`,
    displayName: `User ${index}`,
    avatarUrl: null,
    url: `https://github.com/users/user-${index}`,
    bot: false,
    deleted: false,
  }));
  const milestone = {
    number: 1,
    title: "Benchmark",
    description: "Deterministic benchmark fixture",
    state: "open",
    dueOn: "2026-12-31T00:00:00.000Z",
    openIssues: 0,
    closedIssues: 0,
    url: "https://github.com/acme/benchmark/milestone/1",
    updatedAt: "2026-12-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
  };
  const issues = [];
  const pullRequests = [];
  const reviews = [];
  const events = [];
  for (let index = 0; index < 12_000; index += 1) {
    if (signal.aborted) throw new Error("Analytics benchmark cancelled");
    const number = index + 1;
    const day = index % 330;
    const createdAt = new Date(Date.UTC(2026, 0, 1 + day)).toISOString();
    const closed = index % 3 === 0;
    const person = people[index % people.length];
    const status = index % 7 === 0 ? "BLOCKED" : index % 5 === 0 ? "IN PROGRESS" : index % 3 === 0 ? "DONE" : "TODO";
    issues.push({
      id: 100_000 + index,
      nodeId: `I_${100_000 + index}`,
      number,
      title: `Benchmark issue ${number}`,
      fullTitle: `[${status}] Benchmark issue ${number}`,
      state: closed ? "closed" : "open",
      stateReason: closed ? "completed" : "unknown",
      status,
      labels: [`area:${index % 20}`],
      statusLabels: [`status:${status.toLowerCase().replaceAll(" ", "-")}`],
      author: person,
      assignees: index % 4 === 0 ? [person, people[(index + 1) % people.length]] : [person],
      milestone,
      createdAt,
      updatedAt: new Date(Date.parse(createdAt) + 7 * 86_400_000).toISOString(),
      closedAt: closed ? new Date(Date.parse(createdAt) + 5 * 86_400_000).toISOString() : null,
      url: `https://github.com/acme/benchmark/issues/${number}`,
      blockedBy: index % 7 === 0 && index > 0 ? [number - 1] : [],
      blocking: [],
    });
    events.push({ id: `status-${number}`, subject: "issue", number, type: "labeled", createdAt, actor: person, label: "status:in-progress", assignee: null, reviewer: null, milestoneTitle: null, reviewId: null, reviewState: null, rename: null });
    events.push({ id: `milestone-${number}`, subject: "issue", number, type: "milestoned", createdAt, actor: person, label: null, assignee: null, reviewer: null, milestoneTitle: milestone.title, reviewId: null, reviewState: null, rename: null });
    if (closed) {
      events.push({ id: `done-${number}`, subject: "issue", number, type: "labeled", createdAt: new Date(Date.parse(createdAt) + 4 * 86_400_000).toISOString(), actor: person, label: "status:done", assignee: null, reviewer: null, milestoneTitle: null, reviewId: null, reviewState: null, rename: null });
      events.push({ id: `close-${number}`, subject: "issue", number, type: "closed", createdAt: new Date(Date.parse(createdAt) + 5 * 86_400_000).toISOString(), actor: person, label: null, assignee: null, reviewer: null, milestoneTitle: null, reviewId: null, reviewState: null, rename: null });
    }
    if (index % 500 === 499) await new Promise((resolve) => setImmediate(resolve));
  }
  for (let index = 0; index < 4_000; index += 1) {
    if (signal.aborted) throw new Error("Analytics benchmark cancelled");
    const number = 20_000 + index;
    const createdAt = new Date(Date.UTC(2026, 0, 1 + index % 330)).toISOString();
    const mergedAt = index % 2 === 0 ? new Date(Date.parse(createdAt) + 3 * 86_400_000).toISOString() : null;
    const author = people[index % people.length];
    const requested = people[(index + 1) % people.length];
    pullRequests.push({
      id: 300_000 + index,
      nodeId: `PR_${300_000 + index}`,
      number,
      title: `Benchmark pull request ${number}`,
      state: mergedAt === null ? "open" : "closed",
      draft: index % 11 === 0,
      mergedAt,
      closedAt: mergedAt,
      createdAt,
      updatedAt: new Date(Date.parse(createdAt) + 2 * 86_400_000).toISOString(),
      author,
      assignees: [author],
      requestedReviewers: mergedAt === null ? [requested] : [],
      requestedTeams: [],
      milestone,
      labels: [`area:${index % 20}`],
      reviewState: mergedAt === null ? "review-required" : "approved",
      checksState: index % 5 === 0 ? "failure" : "success",
      headSha: index.toString(16).padStart(40, "0"),
      changedFiles: 1 + index % 40,
      additions: 10 + index % 500,
      deletions: index % 100,
      url: `https://github.com/acme/benchmark/pull/${number}`,
    });
    events.push({ id: `ready-${number}`, subject: "pull-request", number, type: "ready-for-review", createdAt: new Date(Date.parse(createdAt) + 86_400_000).toISOString(), actor: author, label: null, assignee: null, reviewer: null, milestoneTitle: null, reviewId: null, reviewState: null, rename: null });
    if (mergedAt === null) events.push({ id: `request-${number}`, subject: "pull-request", number, type: "review-requested", createdAt: new Date(Date.parse(createdAt) + 86_400_000).toISOString(), actor: author, label: null, assignee: null, reviewer: requested, milestoneTitle: null, reviewId: null, reviewState: null, rename: null });
    const review = { id: 400_000 + index, pullNumber: number, reviewer: requested, state: index % 6 === 0 ? "changes-requested" : "approved", submittedAt: new Date(Date.parse(createdAt) + 2 * 86_400_000).toISOString(), commitId: null, url: null };
    reviews.push(review);
    events.push({ id: `review-${number}`, subject: "pull-request", number, type: "review-submitted", createdAt: review.submittedAt, actor: requested, label: null, assignee: null, reviewer: requested, milestoneTitle: null, reviewId: review.id, reviewState: review.state, rename: null });
    if (index % 500 === 499) await new Promise((resolve) => setImmediate(resolve));
  }
  return {
    repository: {
      name: "acme/benchmark",
      description: "Benchmark",
      visibility: "private",
      defaultBranch: "main",
      license: "MIT",
      url: "https://github.com/acme/benchmark",
      languages: [{ name: "TypeScript", bytes: 2_000_000 }, { name: "CSS", bytes: 200_000 }],
      releases: Array.from({ length: 24 }, (_, index) => ({ id: 500_000 + index, tagName: `v0.${index}.0`, name: `Release ${index}`, draft: false, prerelease: false, createdAt: new Date(Date.UTC(2025, 0, 1 + index * 20)).toISOString(), publishedAt: new Date(Date.UTC(2025, 0, 1 + index * 20)).toISOString(), url: `https://github.com/acme/benchmark/releases/${index}`, author: people[index % people.length] })),
      tags: Array.from({ length: 100 }, (_, index) => ({ name: `tag-${index}`, commitSha: index.toString(16).padStart(40, "0"), url: `https://github.com/acme/benchmark/tree/tag-${index}` })),
      commitWeeks: [
        ...Array.from({ length: 52 }, (_, index) => ({ week: new Date(Date.UTC(2026, 0, 1 + index * 7)).toISOString(), source: "aggregate", commits: 100 + index, additions: 1_000 + index, deletions: -(500 + index), author: null })),
        ...Array.from({ length: 52 }, (_, index) => ({ week: new Date(Date.UTC(2026, 0, 1 + index * 7)).toISOString(), source: "contributor", commits: 100 + index, additions: null, deletions: null, author: people[index % people.length] })),
      ],
    },
    issues,
    pullRequests,
    reviews,
    events,
    milestones: [milestone],
    coverage: [],
    fetchedAt: "2027-01-01T00:00:00.000Z",
  };
}
