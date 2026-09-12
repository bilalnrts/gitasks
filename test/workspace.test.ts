import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { GitHubClient } from "../src/github/client.js";
import { AmbiguousMilestoneCreateError, GitHubApiError } from "../src/github/api.js";
import { CommandError } from "../src/utils/errors.js";
import type { CommandRunner } from "../src/utils/exec.js";

function issue(number: number, id: number, title = "[TODO] Task") {
  return {
    id,
    node_id: `I_${id}`,
    number,
    title,
    state: "open",
    body: "",
    labels: [{ name: "status:todo" }],
    assignees: [],
    milestone: null,
    user: { login: "octocat", avatar_url: "https://avatars.githubusercontent.com/u/1", html_url: "https://github.com/octocat" },
    html_url: `https://github.com/acme/example/issues/${number}`,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
  };
}

function pull(number: number, sha: string) {
  return {
    number,
    node_id: `PR_${number}`,
    title: "Improve workspace",
    body: "",
    state: "open",
    draft: false,
    merged_at: null,
    user: null,
    assignees: [],
    milestone: null,
    labels: [],
    head: { ref: "feature", sha },
    base: { ref: "main", sha: "b".repeat(40) },
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
    html_url: `https://github.com/acme/example/pull/${number}`,
  };
}

function apiPath(args: readonly string[]): string {
  return args.find((argument) => argument.startsWith("repos/")) ?? "";
}

describe("workspace GitHub REST contracts", () => {
  test("maps database IDs and sends the required REST headers", async () => {
    const invocations: string[][] = [];
    const runner: CommandRunner = async (_file, args) => {
      invocations.push([...args]);
      return { stdout: JSON.stringify([issue(3, 7003)]), stderr: "" };
    };
    const client = new GitHubClient("acme/example", runner);

    const page = await client.listIssuePage("open", 2);

    assert.equal(page.items[0]?.id, 7003);
    assert.equal(page.items[0]?.nodeId, "I_7003");
    assert.equal(page.items[0]?.assignees.length, 0);
    assert.deepEqual(invocations[0], [
      "api",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2026-03-10",
      "repos/acme/example/issues?state=open&per_page=100&page=2",
    ]);
  });

  test("preserves the current status prefix when editing a title", async () => {
    const patched: string[] = [];
    const runner: CommandRunner = async (_file, args) => {
      const path = apiPath(args);
      if (args.includes("PATCH")) {
        patched.push(...args);
        return { stdout: JSON.stringify(issue(4, 7004, "[TODO] Renamed")), stderr: "" };
      }
      assert.equal(path, "repos/acme/example/issues/4");
      return { stdout: JSON.stringify(issue(4, 7004, "[TODO] Original")), stderr: "" };
    };
    const client = new GitHubClient("acme/example", runner);

    const updated = await client.updateIssue(4, { title: "[DONE] Renamed" });

    assert.equal(updated.title, "[TODO] Renamed");
    assert.ok(patched.includes("title=[TODO] Renamed"));
  });

  test("uses a database ID and singular deletion path for sub-issues", async () => {
    const invocations: string[][] = [];
    const runner: CommandRunner = async (_file, args) => {
      invocations.push([...args]);
      const path = apiPath(args);
      if (path.endsWith("/parent")) {
        throw new CommandError({ command: "gh api", exitCode: 1, stdout: "", stderr: "HTTP 404: Not Found" });
      }
      if (path === "repos/acme/example/issues/1") return { stdout: JSON.stringify(issue(1, 7001)), stderr: "" };
      if (path === "repos/acme/example/issues/8") return { stdout: JSON.stringify(issue(8, 9008)), stderr: "" };
      if (path.endsWith("/sub_issue")) return { stdout: "{}", stderr: "" };
      return { stdout: "[]", stderr: "" };
    };
    const client = new GitHubClient("acme/example", runner);

    await client.mutateSubIssue(1, 8, false);

    const deletion = invocations.find((args) => args.includes("DELETE"));
    assert.ok(deletion);
    assert.equal(apiPath(deletion), "repos/acme/example/issues/1/sub_issue");
    assert.ok(deletion.includes("sub_issue_id=9008"));
    assert.equal(deletion.includes("sub_issue_id=8"), false);
  });

  test("uses the blocked-by dependency path and database issue_id", async () => {
    const invocations: string[][] = [];
    const runner: CommandRunner = async (_file, args) => {
      invocations.push([...args]);
      const path = apiPath(args);
      if (path.endsWith("/parent")) {
        throw new CommandError({ command: "gh api", exitCode: 1, stdout: "", stderr: "HTTP 404: Not Found" });
      }
      if (path === "repos/acme/example/issues/2") return { stdout: JSON.stringify(issue(2, 7002)), stderr: "" };
      if (path === "repos/acme/example/issues/9") return { stdout: JSON.stringify(issue(9, 9909)), stderr: "" };
      if (path === "repos/acme/example/issues/2/dependencies/blocked_by" && args.includes("POST")) {
        return { stdout: "{}", stderr: "" };
      }
      if (path.includes("/dependencies/blocked_by?")) return { stdout: JSON.stringify([issue(9, 9909)]), stderr: "" };
      return { stdout: "[]", stderr: "" };
    };
    const client = new GitHubClient("acme/example", runner);

    await client.mutateBlockedBy(2, 9, true);

    const addition = invocations.find((args) => args.includes("POST"));
    assert.ok(addition);
    assert.equal(apiPath(addition), "repos/acme/example/issues/2/dependencies/blocked_by");
    assert.ok(addition.includes("issue_id=9909"));
    assert.equal(addition.includes("issue_id=9"), false);
  });

  test("rejects a merge when the reviewed head SHA changed without calling merge", async () => {
    const oldSha = "a".repeat(40);
    const newSha = "c".repeat(40);
    const invocations: string[][] = [];
    const runner: CommandRunner = async (_file, args) => {
      invocations.push([...args]);
      return { stdout: JSON.stringify(pull(12, newSha)), stderr: "" };
    };
    const client = new GitHubClient("acme/example", runner);

    await assert.rejects(
      () => client.mergePullRequest(12, "squash", oldSha),
      (error: unknown) => error instanceof GitHubApiError && error.code === "stale-head",
    );
    assert.equal(invocations.some((args) => args.includes("PUT")), false);
  });

  test("verifies an ambiguous merge and never replays it", async () => {
    const sha = "d".repeat(40);
    let mergePuts = 0;
    let pullReads = 0;
    const runner: CommandRunner = async (_file, args) => {
      const path = apiPath(args);
      if (path.endsWith("/merge") && args.includes("PUT")) {
        mergePuts += 1;
        throw new CommandError({ command: "gh api", exitCode: 1, stdout: "", stderr: "connection reset after upload" });
      }
      if (path.endsWith("/merge")) return { stdout: "", stderr: "" };
      pullReads += 1;
      return { stdout: JSON.stringify(pull(14, sha)), stderr: "" };
    };
    const client = new GitHubClient("acme/example", runner);

    const merged = await client.mergePullRequest(14, "merge", sha);

    assert.equal(merged.number, 14);
    assert.equal(mergePuts, 1);
    assert.equal(pullReads, 2);
  });
});

function pullDetailRunner(options: {
  number?: number;
  reviews?: unknown[];
  requestedReviewers?: unknown[];
  changedFiles?: number;
  filesForPage?: (page: number) => unknown[];
  status?: unknown;
  checks?: unknown;
  timeline?: unknown[];
  closingIssueNumbers?: number[];
} = {}): CommandRunner {
  const number = options.number ?? 20;
  const sha = "e".repeat(40);
  return async (_file, args) => {
    if (args[0] === "api" && args[1] === "graphql") {
      return {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                closingIssuesReferences: {
                  nodes: (options.closingIssueNumbers ?? []).map((issueNumber) => ({ number: issueNumber, repository: { nameWithOwner: "acme/example" } })),
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
        stderr: "",
      };
    }
    const path = apiPath(args);
    if (path === `repos/acme/example/pulls/${number}`) {
      return { stdout: JSON.stringify({ ...pull(number, sha), changed_files: options.changedFiles ?? 0, mergeable: true }), stderr: "" };
    }
    if (path === `repos/acme/example/pulls/${number}/requested_reviewers`) {
      return { stdout: JSON.stringify({ users: options.requestedReviewers ?? [] }), stderr: "" };
    }
    if (path.startsWith(`repos/acme/example/pulls/${number}/reviews?`)) {
      return { stdout: JSON.stringify(options.reviews ?? []), stderr: "" };
    }
    if (path.startsWith(`repos/acme/example/pulls/${number}/files?`)) {
      const page = Number(new URLSearchParams(path.split("?")[1]).get("page"));
      return { stdout: JSON.stringify(options.filesForPage?.(page) ?? []), stderr: "" };
    }
    if (path.includes("/status")) return { stdout: JSON.stringify(options.status ?? { state: "success", total_count: 0, statuses: [] }), stderr: "" };
    if (path.includes("/check-runs")) return { stdout: JSON.stringify(options.checks ?? { total_count: 0, check_runs: [] }), stderr: "" };
    if (path.startsWith(`repos/acme/example/issues/${number}/timeline?`)) return { stdout: JSON.stringify(options.timeline ?? []), stderr: "" };
    const closingNumber = options.closingIssueNumbers?.find((issueNumber) => path === `repos/acme/example/issues/${issueNumber}`);
    if (closingNumber !== undefined) return { stdout: JSON.stringify(issue(closingNumber, 7000 + closingNumber)), stderr: "" };
    if (path === "repos/acme/example") return { stdout: JSON.stringify({ allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true }), stderr: "" };
    throw new Error(`Unexpected API path: ${path}`);
  };
}

describe("workspace backend hardening", () => {
  test("derives pull request capability from the repository response", async () => {
    const runner: CommandRunner = async (_file, args) => {
      const path = apiPath(args);
      if (path === "repos/acme/example") return { stdout: JSON.stringify({ has_issues: true, has_pull_requests: false, permissions: {} }), stderr: "" };
      return { stdout: JSON.stringify({ login: "octocat" }), stderr: "" };
    };

    const context = await new GitHubClient("acme/example", runner).getContext();

    assert.equal(context.capabilities.pullRequests, false);
  });

  test("keeps ordinary 404 responses as not-found and maps native capability 404s to unsupported", async () => {
    const missingRunner: CommandRunner = async () => {
      throw new CommandError({ command: "gh api", exitCode: 1, stdout: "", stderr: "HTTP 404: Not Found" });
    };
    await assert.rejects(
      () => new GitHubClient("acme/example", missingRunner).getIssue(404),
      (error: unknown) => error instanceof GitHubApiError && error.code === "not-found" && error.statusCode === 404,
    );

    const nativeRunner: CommandRunner = async (_file, args) => {
      const path = apiPath(args);
      if (path === "repos/acme/example/issues/4") return { stdout: JSON.stringify(issue(4, 7004)), stderr: "" };
      if (path.includes("/sub_issues")) throw new CommandError({ command: "gh api", exitCode: 1, stdout: "", stderr: "HTTP 404: Not Found" });
      if (path.endsWith("/parent")) throw new CommandError({ command: "gh api", exitCode: 1, stdout: "", stderr: "HTTP 404: Not Found" });
      return { stdout: "[]", stderr: "" };
    };
    await assert.rejects(
      () => new GitHubClient("acme/example", nativeRunner).getIssueDetail(4),
      (error: unknown) => error instanceof GitHubApiError && error.code === "unsupported",
    );
  });

  test("classifies 403 rate limits before permission errors", async () => {
    const runner: CommandRunner = async () => {
      throw new CommandError({ command: "gh api", exitCode: 1, stdout: "", stderr: "HTTP 403: API rate limit exceeded" });
    };
    await assert.rejects(
      () => new GitHubClient("acme/example", runner).listIssuePage("open", 1),
      (error: unknown) => error instanceof GitHubApiError && error.code === "rate-limit" && error.retryable,
    );
  });

  test("rethrows classified API errors while listing overview issues", async () => {
    const runner: CommandRunner = async () => {
      throw new CommandError({ command: "gh api", exitCode: 1, stdout: "", stderr: "HTTP 403: Resource not accessible by integration" });
    };
    await assert.rejects(
      () => new GitHubClient("acme/example", runner).listIssues("open"),
      (error: unknown) => error instanceof GitHubApiError && error.code === "permission",
    );
  });

  test("updates all pull request issue fields in one atomic issue PATCH", async () => {
    const invocations: string[][] = [];
    const updated = {
      ...pull(7, "f".repeat(40)),
      title: "Renamed",
      body: "Updated",
      state: "closed",
      milestone: { number: 3, title: "M3", description: "", state: "open", due_on: null, open_issues: 0, closed_issues: 0, html_url: "" },
    };
    const runner: CommandRunner = async (_file, args) => {
      invocations.push([...args]);
      if (args.includes("PATCH")) return { stdout: "{}", stderr: "" };
      return { stdout: JSON.stringify(updated), stderr: "" };
    };

    await new GitHubClient("acme/example", runner).updatePullRequest(7, { title: "Renamed", body: "Updated", state: "closed", milestone: 3 });

    const patches = invocations.filter((args) => args.includes("PATCH"));
    assert.equal(patches.length, 1);
    assert.equal(apiPath(patches[0]!), "repos/acme/example/issues/7");
    assert.ok(patches[0]!.includes("title=Renamed"));
    assert.ok(patches[0]!.includes("body=Updated"));
    assert.ok(patches[0]!.includes("state=closed"));
    assert.ok(patches[0]!.includes("milestone=3"));
  });

  test("returns exact-title recovery for ambiguous milestone creation", async () => {
    const runner: CommandRunner = async () => {
      throw new CommandError({ command: "gh api", exitCode: 1, stdout: "", stderr: "connection reset after upload" });
    };
    await assert.rejects(
      () => new GitHubClient("acme/example", runner).createMilestone({ title: "Exact milestone" }),
      (error: unknown) => error instanceof AmbiguousMilestoneCreateError
        && error.title === "Exact milestone"
        && error.recoveryUrl === "https://github.com/acme/example/milestones"
        && !error.retryable,
    );
  });

  test("verifies assignee and reviewer logins case-insensitively", async () => {
    const issueAssigneeRunner: CommandRunner = async (_file, args) => {
      if (args.includes("POST")) return { stdout: "{}", stderr: "" };
      return { stdout: JSON.stringify({ ...issue(6, 7006), assignees: [{ login: "octocat" }] }), stderr: "" };
    };
    const assignedIssue = await new GitHubClient("acme/example", issueAssigneeRunner).mutateIssueAssignee(6, "OctoCat", true);
    assert.deepEqual(assignedIssue.assignees, ["octocat"]);

    const sha = "1".repeat(40);
    let pullReads = 0;
    const assigneeRunner: CommandRunner = async (_file, args) => {
      if (args.includes("POST")) return { stdout: "{}", stderr: "" };
      pullReads += 1;
      return { stdout: JSON.stringify({ ...pull(8, sha), assignees: [{ login: "octocat" }] }), stderr: "" };
    };
    const assigned = await new GitHubClient("acme/example", assigneeRunner).mutatePullAssignee(8, "OctoCat", true);
    assert.equal(assigned.assignees[0]?.login, "octocat");
    assert.equal(pullReads, 1);

    const base = pullDetailRunner({ number: 9, requestedReviewers: [{ login: "octocat" }] });
    const reviewerRunner: CommandRunner = async (file, args, options) => {
      if (args.includes("POST")) return { stdout: "{}", stderr: "" };
      return base(file, args, options);
    };
    const reviewed = await new GitHubClient("acme/example", reviewerRunner).mutateReviewer(9, "OctoCat", true);
    assert.equal(reviewed.requestedReviewers[0]?.login, "octocat");
  });

  test("verifies reviewer removal and successful review submission with controlled responses", async () => {
    let reviewerDeleteSeen = false;
    const removedReviewerDetail = pullDetailRunner({ number: 10, requestedReviewers: [] });
    const reviewerRunner: CommandRunner = async (file, args, options) => {
      if (apiPath(args) === "repos/acme/example/pulls/10/requested_reviewers" && args.includes("DELETE")) {
        reviewerDeleteSeen = true;
        return { stdout: "{}", stderr: "" };
      }
      return removedReviewerDetail(file, args, options);
    };
    const removed = await new GitHubClient("acme/example", reviewerRunner).mutateReviewer(10, "octocat", false);
    assert.equal(reviewerDeleteSeen, true);
    assert.deepEqual(removed.requestedReviewers, []);

    let reviewSubmitted = false;
    const review = {
      id: 44,
      user: { login: "octocat" },
      state: "COMMENTED",
      body: "Controlled review",
      submitted_at: "2026-09-12T00:00:00Z",
    };
    const reviewRunner: CommandRunner = async (file, args, options) => {
      if (apiPath(args) === "repos/acme/example/pulls/11/reviews" && args.includes("POST")) {
        reviewSubmitted = true;
        assert.ok(args.includes("event=COMMENT"));
        assert.ok(args.includes("body=Controlled review"));
        return { stdout: "{}", stderr: "" };
      }
      return pullDetailRunner({ number: 11, reviews: reviewSubmitted ? [review] : [] })(file, args, options);
    };
    const reviewed = await new GitHubClient("acme/example", reviewRunner).createReview(11, "COMMENT", "Controlled review");
    assert.equal(reviewSubmitted, true);
    assert.equal(reviewed.reviews[0]?.state, "COMMENTED");
    assert.equal(reviewed.reviews[0]?.body, "Controlled review");
  });

  test("uses each reviewer's latest non-dismissed decision", async () => {
    const reviews = [
      { id: 2, user: { login: "OctoCat" }, state: "APPROVED", body: "", submitted_at: "2026-09-02T00:00:00Z" },
      { id: 1, user: { login: "octocat" }, state: "CHANGES_REQUESTED", body: "", submitted_at: "2026-09-01T00:00:00Z" },
      { id: 3, user: { login: "other" }, state: "DISMISSED", body: "", submitted_at: "2026-09-03T00:00:00Z" },
    ];

    const detail = await new GitHubClient("acme/example", pullDetailRunner({ reviews })).getPullRequestDetail(20);

    assert.equal(detail.pullRequest.reviewState, "approved");
  });

  test("merges inbound timeline and outbound closing issue references", async () => {
    const timelineIssue = issue(21, 7021);
    const timeline = [{ event: "cross-referenced", source: { issue: timelineIssue } }];
    const detail = await new GitHubClient("acme/example", pullDetailRunner({ timeline, closingIssueNumbers: [22] })).getPullRequestDetail(20);

    assert.deepEqual(detail.linkedIssues.map(({ number }) => number).sort((left, right) => left - right), [21, 22]);
  });

  test("adds legacy statuses and check runs in the combined total", async () => {
    const status = { state: "success", total_count: 2, statuses: [{ id: 1, context: "a", state: "success" }, { id: 2, context: "b", state: "success" }] };
    const checks = { total_count: 3, check_runs: [
      { id: 3, name: "one", status: "completed", conclusion: "success" },
      { id: 4, name: "two", status: "completed", conclusion: "success" },
      { id: 5, name: "three", status: "completed", conclusion: "success" },
    ] };

    const detail = await new GitHubClient("acme/example", pullDetailRunner({ status, checks })).getPullRequestDetail(20);

    assert.equal(detail.combinedStatus.totalCount, 5);
  });

  test("reports partial file coverage at GitHub's 3000-file cap", async () => {
    const file = { filename: "file.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: null, blob_url: "" };
    const detail = await new GitHubClient("acme/example", pullDetailRunner({
      changedFiles: 3100,
      filesForPage: () => Array.from({ length: 100 }, () => file),
    })).getPullRequestDetail(20);

    assert.deepEqual(detail.fileCoverage, { complete: false, loaded: 3000, knownTotal: 3100, limit: 3000 });
    assert.equal(detail.files.length, 3000);
  });

  test("makes review hydration failures non-retryable with the pull request recovery URL", async () => {
    const base = pullDetailRunner({ number: 23 });
    let pullReads = 0;
    const runner: CommandRunner = async (file, args, options) => {
      const path = apiPath(args);
      if (path === "repos/acme/example/pulls/23/reviews" && args.includes("POST")) return { stdout: "{}", stderr: "" };
      if (path === "repos/acme/example/pulls/23") {
        pullReads += 1;
        if (pullReads > 1) throw new CommandError({ command: "gh api", exitCode: 1, stdout: "", stderr: "connection reset" });
      }
      return base(file, args, options);
    };

    await assert.rejects(
      () => new GitHubClient("acme/example", runner).createReview(23, "APPROVE", ""),
      (error: unknown) => error instanceof GitHubApiError
        && error.code === "ambiguous-review"
        && !error.retryable
        && error.message.includes("https://github.com/acme/example/pull/23"),
    );
  });

  test("makes inconclusive merge verification and hydration non-retryable", async () => {
    const sha = "2".repeat(40);
    let pullReads = 0;
    const verifyFailureRunner: CommandRunner = async (_file, args) => {
      const path = apiPath(args);
      if (path.endsWith("/merge") && args.includes("PUT")) throw new CommandError({ command: "gh api", exitCode: 1, stdout: "", stderr: "connection reset" });
      if (path.endsWith("/merge")) throw new CommandError({ command: "gh api", exitCode: 1, stdout: "", stderr: "HTTP 503: unavailable" });
      return { stdout: JSON.stringify(pull(24, sha)), stderr: "" };
    };
    await assert.rejects(
      () => new GitHubClient("acme/example", verifyFailureRunner).mergePullRequest(24, "merge", sha),
      (error: unknown) => error instanceof GitHubApiError && error.code === "ambiguous-merge" && !error.retryable && error.message.includes("/pull/24"),
    );

    const hydrationFailureRunner: CommandRunner = async (_file, args) => {
      const path = apiPath(args);
      if (path.endsWith("/merge")) return { stdout: JSON.stringify({ merged: true }), stderr: "" };
      pullReads += 1;
      if (pullReads > 1) throw new CommandError({ command: "gh api", exitCode: 1, stdout: "", stderr: "HTTP 503: unavailable" });
      return { stdout: JSON.stringify(pull(25, sha)), stderr: "" };
    };
    await assert.rejects(
      () => new GitHubClient("acme/example", hydrationFailureRunner).mergePullRequest(25, "squash", sha),
      (error: unknown) => error instanceof GitHubApiError && error.code === "ambiguous-merge" && !error.retryable && error.message.includes("/pull/25"),
    );
  });
});
