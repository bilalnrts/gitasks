import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import type {
  CreateIssueInput,
  IssueTransition,
  TaskIssue,
} from "../src/tasks/types.js";
import { AmbiguousMilestoneCreateError, GitHubApiError } from "../src/github/api.js";
import type { TaskDetail } from "../src/workspace/types.js";
import { isStatusLabel } from "../src/tasks/statuses.js";
import {
  loadUiAssets,
  parseUiPort,
  startUiServer,
  type BoardGateway,
  type RunningUiServer,
} from "../src/ui/server.js";
import {
  AmbiguousCreateError,
  PartialCreateError,
  UserError,
} from "../src/utils/errors.js";

const BASE_ISSUE: TaskIssue = {
  number: 12,
  title: "[TODO] Secure local API",
  body: "Keep GitHub credentials on the local server.",
  state: "OPEN",
  labels: ["security", "status:todo"],
  assignees: ["octocat"],
  url: "https://github.com/acme/example/issues/12",
};

class FakeBoardGateway implements BoardGateway {
  issue = { ...BASE_ISSUE, labels: [...BASE_ISSUE.labels] };
  createCalls = 0;
  listCalls: Array<"open" | "closed" | "all"> = [];
  getCalls = 0;
  failTransition = false;
  failRecoveryRead = false;
  failClosedCreate = false;
  failAmbiguousCreate = false;
  transitionDelayMs = 0;
  activeTransitions = 0;
  maxActiveTransitions = 0;
  updateCalls = 0;
  assigneeCalls = 0;


  async listIssues(state: "open" | "closed" | "all"): Promise<TaskIssue[]> {
    this.listCalls.push(state);
    if (state === "all" || this.issue.state.toLowerCase() === state) {
      return [this.issue];
    }
    return [];
  }

  async getIssue(): Promise<TaskIssue> {
    this.getCalls += 1;
    if (this.failRecoveryRead && this.getCalls > 1) {
      throw new UserError("Recovery read failed.");
    }
    return this.issue;
  }

  async createIssue(input: CreateIssueInput): Promise<TaskIssue> {
    this.createCalls += 1;
    if (this.failAmbiguousCreate) {
      throw new AmbiguousCreateError(
        `Could not confirm whether GitHub created "${input.title}". Do not retry yet: check existing issues.`,
        input.title,
        "https://github.com/acme/example/issues",
      );
    }
    this.issue = {
      number: 13,
      title: input.title,
      body: input.body,
      state: "OPEN",
      labels: [input.label],
      assignees: [],
      url: "https://github.com/acme/example/issues/13",
    };
    if (this.failClosedCreate && input.state === "closed") {
      throw new PartialCreateError("Created issue #13 but could not close it.", this.issue);
    }
    this.issue.state = input.state === "closed" ? "CLOSED" : "OPEN";
    return this.issue;
  }

  async transitionIssue(
    _issueNumber: number,
    transition: IssueTransition,
  ): Promise<TaskIssue> {
    this.activeTransitions += 1;
    this.maxActiveTransitions = Math.max(this.maxActiveTransitions, this.activeTransitions);
    try {
      if (this.transitionDelayMs > 0) {
        await delay(this.transitionDelayMs);
      }
      if (this.failTransition) {
        throw new UserError("GitHub transition failed.");
      }
      this.issue = {
        ...this.issue,
        title: transition.title,
        state: transition.state === "closed" ? "CLOSED" : "OPEN",
        labels: [
          ...this.issue.labels.filter((label) => !isStatusLabel(label)),
          transition.nextStatusLabel,
        ],
      };
      return this.issue;
    } finally {
      this.activeTransitions -= 1;
    }
  }

  async updateIssue(
    _issueNumber: number,
    input: { title?: string; body?: string; milestone?: number | null },
  ): Promise<TaskIssue> {
    this.activeTransitions += 1;
    this.maxActiveTransitions = Math.max(this.maxActiveTransitions, this.activeTransitions);
    try {
      if (this.transitionDelayMs > 0) await delay(this.transitionDelayMs);
      this.updateCalls += 1;
      this.issue = {
        ...this.issue,
        ...(input.title === undefined ? {} : { title: `[TODO] ${input.title}` }),
        ...(input.body === undefined ? {} : { body: input.body }),
      };
      return this.issue;
    } finally {
      this.activeTransitions -= 1;
    }
  }

  async mutateIssueAssignee(
    _issueNumber: number,
    login: string,
    add: boolean,
  ): Promise<TaskIssue> {
    this.activeTransitions += 1;
    this.maxActiveTransitions = Math.max(this.maxActiveTransitions, this.activeTransitions);
    try {
      if (this.transitionDelayMs > 0) await delay(this.transitionDelayMs);
      this.assigneeCalls += 1;
      this.issue = {
        ...this.issue,
        assignees: add
          ? Array.from(new Set([...this.issue.assignees, login]))
          : this.issue.assignees.filter((assignee) => assignee !== login),
      };
      return this.issue;
    } finally {
      this.activeTransitions -= 1;
    }
  }
}

async function createAssetDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gitasks-assets-"));
  await Promise.all([
    writeFile(
      join(directory, "index.html"),
      '<meta name="gitasks-csrf" content="__GITASKS_CSRF_TOKEN__">',
      "utf8",
    ),
    writeFile(join(directory, "app.js"), "console.log('gitasks')", "utf8"),
    writeFile(join(directory, "styles.css"), "body { color: black; }", "utf8"),
  ]);
  return directory;
}

async function startTestServer(gateway = new FakeBoardGateway()): Promise<{
  gateway: FakeBoardGateway;
  running: RunningUiServer;
  assetDirectory: string;
}> {
  const assetDirectory = await createAssetDirectory();
  const running = await startUiServer({
    repository: "acme/example",
    gateway,
    port: 0,
    assetDirectory,
    csrfToken: "test-csrf-token",
  });
  return { gateway, running, assetDirectory };
}

async function stopTestServer(
  running: RunningUiServer,
  assetDirectory: string,
): Promise<void> {
  await running.close();
  await rm(assetDirectory, { recursive: true, force: true });
}

function mutationHeaders(running: RunningUiServer): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Origin: running.url,
    "X-Gitasks-CSRF": running.csrfToken,
  };
}

describe("UI port validation", () => {
  test("accepts valid ports and rejects malformed or unavailable ranges", () => {
    assert.equal(parseUiPort("4317"), 4317);
    assert.equal(parseUiPort("65535"), 65_535);
    for (const value of ["0", "65536", "43.17", "port", "-1", ""]) {
      assert.throws(() => parseUiPort(value), /Invalid port/);
    }
  });
});

describe("packaged UI assets", () => {
  test("loads only the expected frontend files and injects the CSRF token", async () => {
    const { running, assetDirectory } = await startTestServer();
    try {
      const page = await fetch(running.url);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /content="test-csrf-token"/);

      const javascript = await fetch(`${running.url}/app.js`);
      assert.equal(javascript.status, 200);
      assert.match(await javascript.text(), /gitasks/);

      const traversal = await fetch(`${running.url}/..%2Fpackage.json`);
      assert.equal(traversal.status, 404);
    } finally {
      await stopTestServer(running, assetDirectory);
    }
  });

  test("reports missing packaged assets clearly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gitasks-missing-assets-"));
    try {
      await assert.rejects(() => loadUiAssets(directory), /UI assets could not be loaded/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("board issue scope", () => {
  test("defaults to open, supports closed/all, and read-only loads do not mutate issues", async () => {
    const gateway = new FakeBoardGateway();
    const { running, assetDirectory } = await startTestServer(gateway);
    try {
      const open = await fetch(`${running.url}/api/board`);
      assert.equal(open.status, 200);
      assert.deepEqual(await open.json() as { state: string; complete: boolean }, {
        repository: "acme/example",
        state: "open",
        scope: "Open GitHub Issues; search covers every loaded issue; pull requests excluded",
        complete: true,
        statuses: [
          { name: "BACKLOG", slug: "backlog", color: "BFD4F2" },
          { name: "TODO", slug: "todo", color: "FBCA04" },
          { name: "IN PROGRESS", slug: "in-progress", color: "1D76DB" },
          { name: "REVIEW", slug: "review", color: "A371F7" },
          { name: "DONE", slug: "done", color: "0E8A16" },
          { name: "BLOCKED", slug: "blocked", color: "D73A4A" },
        ],
        tasks: [{
          number: 12,
          status: "TODO",
          title: "Secure local API",
          fullTitle: "[TODO] Secure local API",
          body: "Keep GitHub credentials on the local server.",
          state: "OPEN",
          labels: ["security"],
          assignees: ["octocat"],
          url: "https://github.com/acme/example/issues/12",
        }],
      });

      gateway.issue = {
        ...gateway.issue,
        title: "Existing unclassified issue",
        state: "CLOSED",
        labels: ["security"],
      };
      const closed = await fetch(`${running.url}/api/board?state=closed`);
      const closedPayload = await closed.json() as {
        state: string;
        tasks: Array<{ status: string | null; state: string; fullTitle: string }>;
      };
      assert.equal(closedPayload.state, "closed");
      assert.deepEqual(closedPayload.tasks, [{
        number: 12,
        status: null,
        title: "Existing unclassified issue",
        fullTitle: "Existing unclassified issue",
        body: "Keep GitHub credentials on the local server.",
        state: "CLOSED",
        labels: ["security"],
        assignees: ["octocat"],
        url: "https://github.com/acme/example/issues/12",
      }]);

      const all = await fetch(`${running.url}/api/board?state=all`);
      assert.equal(all.status, 200);
      assert.deepEqual(gateway.listCalls, ["open", "closed", "all"]);
      assert.equal(gateway.createCalls, 0);
      assert.equal(gateway.activeTransitions, 0);
      assert.equal(gateway.getCalls, 0);
      assert.equal(gateway.issue.title, "Existing unclassified issue");
      assert.deepEqual(gateway.issue.labels, ["security"]);
    } finally {
      await stopTestServer(running, assetDirectory);
    }
  });
});

describe("local API security and validation", () => {
  test("rejects cross-origin mutations before touching GitHub", async () => {
    const { gateway, running, assetDirectory } = await startTestServer();
    try {
      const response = await fetch(`${running.url}/api/issues`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://attacker.example",
          "X-Gitasks-CSRF": running.csrfToken,
        },
        body: JSON.stringify({ title: "Should not exist" }),
      });
      assert.equal(response.status, 403);
      assert.equal(gateway.createCalls, 0);
    } finally {
      await stopTestServer(running, assetDirectory);
    }
  });

  test("rejects every workspace mutation family before route dispatch", async () => {
    const { gateway, running, assetDirectory } = await startTestServer();
    try {
      const mutations = [
        ["PATCH", "/api/issues/12"],
        ["POST", "/api/issues/12/status"],
        ["DELETE", "/api/issues/12/assignees"],
        ["POST", "/api/issues/12/sub-issues"],
        ["DELETE", "/api/issues/12/blocked-by"],
        ["POST", "/api/milestones"],
        ["PATCH", "/api/milestones/3"],
        ["POST", "/api/pulls"],
        ["PATCH", "/api/pulls/7"],
        ["POST", "/api/pulls/7/draft"],
        ["DELETE", "/api/pulls/7/reviewers"],
        ["POST", "/api/pulls/7/reviews"],
        ["POST", "/api/pulls/7/merge"],
      ] as const;
      for (const [method, path] of mutations) {
        const response = await fetch(`${running.url}${path}`, {
          method,
          headers: {
            "Content-Type": "application/json",
            Origin: "https://attacker.example",
            "X-Gitasks-CSRF": running.csrfToken,
          },
          body: "{}",
        });
        assert.equal(response.status, 403, `${method} ${path}`);
      }
      assert.equal(gateway.createCalls, 0);
      assert.equal(gateway.updateCalls, 0);
      assert.equal(gateway.assigneeCalls, 0);
      assert.equal(gateway.activeTransitions, 0);
    } finally {
      await stopTestServer(running, assetDirectory);
    }
  });

  test("rejects invalid fields, empty titles, and invalid statuses", async () => {
    const { gateway, running, assetDirectory } = await startTestServer();
    try {
      const cases = [
        { input: { title: "", status: "BACKLOG" }, message: "title" },
        { input: { title: "Task", status: "WAITING" }, message: "Invalid status" },
        { input: { title: "Task", repository: "other/repo" }, message: "Unknown field" },
      ];
      for (const entry of cases) {
        const response = await fetch(`${running.url}/api/issues`, {
          method: "POST",
          headers: mutationHeaders(running),
          body: JSON.stringify(entry.input),
        });
        assert.equal(response.status, 400);
        assert.match(JSON.stringify(await response.json()), new RegExp(entry.message, "i"));
      }
      assert.equal(gateway.createCalls, 0);
    } finally {
      await stopTestServer(running, assetDirectory);
    }
  });

  test("accepts a same-origin CSRF-protected task creation", async () => {
    const { gateway, running, assetDirectory } = await startTestServer();
    try {
      const response = await fetch(`${running.url}/api/issues`, {
        method: "POST",
        headers: mutationHeaders(running),
        body: JSON.stringify({
          title: "Created from UI",
          body: "Description",
          status: "backlog",
        }),
      });
      assert.equal(response.status, 201);
      const payload = await response.json() as { task: { title: string; body: string } };
      assert.equal(payload.task.title, "Created from UI");
      assert.equal(payload.task.body, "Description");
      assert.equal(gateway.createCalls, 1);
    } finally {
      await stopTestServer(running, assetDirectory);
    }
  });

  test("creates DONE tasks as closed issues", async () => {
    const { gateway, running, assetDirectory } = await startTestServer();
    try {
      const response = await fetch(`${running.url}/api/issues`, {
        method: "POST",
        headers: mutationHeaders(running),
        body: JSON.stringify({ title: "Already finished", status: "done" }),
      });
      assert.equal(response.status, 201);
      const payload = await response.json() as {
        task: { state: string; status: string; title: string };
      };
      assert.equal(payload.task.state, "CLOSED");
      assert.equal(payload.task.status, "DONE");
      assert.equal(payload.task.title, "Already finished");
      assert.equal(gateway.createCalls, 1);
    } finally {
      await stopTestServer(running, assetDirectory);
    }
  });

  test("returns a repair target when DONE creation closes only partially", async () => {
    const gateway = new FakeBoardGateway();
    gateway.failClosedCreate = true;
    const { running, assetDirectory } = await startTestServer(gateway);
    try {
      const createResponse = await fetch(`${running.url}/api/issues`, {
        method: "POST",
        headers: mutationHeaders(running),
        body: JSON.stringify({ title: "Repair close", status: "done" }),
      });
      assert.equal(createResponse.status, 502);
      const failed = await createResponse.json() as {
        task: { number: number; state: string; status: string };
        repair: { issueNumber: number; status: string };
      };
      assert.deepEqual(failed.repair, { issueNumber: 13, status: "DONE" });
      assert.equal(failed.task.state, "OPEN");
      assert.equal(failed.task.status, "DONE");

      const repairResponse = await fetch(`${running.url}/api/issues/13/status`, {
        method: "POST",
        headers: mutationHeaders(running),
        body: JSON.stringify({ status: failed.repair.status }),
      });
      assert.equal(repairResponse.status, 200);
      const repaired = await repairResponse.json() as { task: { state: string; status: string } };
      assert.equal(repaired.task.state, "CLOSED");
      assert.equal(repaired.task.status, "DONE");
      assert.equal(gateway.createCalls, 1);
    } finally {
      await stopTestServer(running, assetDirectory);
    }
  });

  test("returns a non-retryable recovery flow for an ambiguous create result", async () => {
    const gateway = new FakeBoardGateway();
    gateway.failAmbiguousCreate = true;
    const { running, assetDirectory } = await startTestServer(gateway);
    try {
      const response = await fetch(`${running.url}/api/issues`, {
        method: "POST",
        headers: mutationHeaders(running),
        body: JSON.stringify({ title: "Possibly created", status: "backlog" }),
      });
      assert.equal(response.status, 502);
      const payload = await response.json() as {
        error: { retryable: boolean; message: string };
        recovery: { kind: string; title: string; issuesUrl: string };
      };
      assert.equal(payload.error.retryable, false);
      assert.match(payload.error.message, /Do not retry yet/);
      assert.deepEqual(payload.recovery, {
        kind: "ambiguous-create",
        title: "[BACKLOG] Possibly created",
        issuesUrl: "https://github.com/acme/example/issues",
      });
      assert.equal(gateway.createCalls, 1);
    } finally {
      await stopTestServer(running, assetDirectory);
    }
  });

  test("classifies an existing unclassified issue only after an explicit transition", async () => {
    const gateway = new FakeBoardGateway();
    gateway.issue = {
      ...gateway.issue,
      title: "Existing issue",
      state: "CLOSED",
      labels: ["security", "needs-triage"],
    };
    const { running, assetDirectory } = await startTestServer(gateway);
    try {
      const before = await fetch(`${running.url}/api/board?state=closed`);
      const beforePayload = await before.json() as { tasks: Array<{ status: null }> };
      assert.equal(beforePayload.tasks[0]?.status, null);
      assert.equal(gateway.issue.title, "Existing issue");

      const response = await fetch(`${running.url}/api/issues/12/status`, {
        method: "POST",
        headers: mutationHeaders(running),
        body: JSON.stringify({ status: "in-progress" }),
      });
      assert.equal(response.status, 200);
      const payload = await response.json() as {
        task: { status: string; state: string; fullTitle: string; labels: string[] };
      };
      assert.deepEqual(payload.task, {
        number: 12,
        status: "IN PROGRESS",
        title: "Existing issue",
        fullTitle: "[IN PROGRESS] Existing issue",
        body: "Keep GitHub credentials on the local server.",
        state: "OPEN",
        labels: ["security", "needs-triage"],
        assignees: ["octocat"],
        url: "https://github.com/acme/example/issues/12",
      });
      assert.deepEqual(gateway.issue.labels, [
        "security",
        "needs-triage",
        "status:in-progress",
      ]);
    } finally {
      await stopTestServer(running, assetDirectory);
    }
  });

  test("serializes concurrent status transitions for one issue", async () => {
    const gateway = new FakeBoardGateway();
    gateway.transitionDelayMs = 20;
    const { running, assetDirectory } = await startTestServer(gateway);
    try {
      const responses = await Promise.all([
        fetch(`${running.url}/api/issues/12/status`, {
          method: "POST",
          headers: mutationHeaders(running),
          body: JSON.stringify({ status: "review" }),
        }),
        fetch(`${running.url}/api/issues/12/status`, {
          method: "POST",
          headers: mutationHeaders(running),
          body: JSON.stringify({ status: "done" }),
        }),
      ]);
      assert.deepEqual(responses.map(({ status }) => status), [200, 200]);
      assert.equal(gateway.maxActiveTransitions, 1);
      assert.equal(gateway.issue.labels.filter((label) => label.startsWith("status:")).length, 1);
    } finally {
      await stopTestServer(running, assetDirectory);
    }
  });

  test("returns verified GitHub state after a failed transition", async () => {
    const gateway = new FakeBoardGateway();
    gateway.failTransition = true;
    const { running, assetDirectory } = await startTestServer(gateway);
    try {
      const response = await fetch(`${running.url}/api/issues/12/status`, {
        method: "POST",
        headers: mutationHeaders(running),
        body: JSON.stringify({ status: "review" }),
      });
      assert.equal(response.status, 502);
      const payload = await response.json() as {
        error: { stateVerified: boolean };
        task: { status: string };
      };
      assert.equal(payload.error.stateVerified, true);
      assert.equal(payload.task.status, "TODO");
    } finally {
      await stopTestServer(running, assetDirectory);
    }
  });

  test("marks state unverified when transition recovery also fails", async () => {
    const gateway = new FakeBoardGateway();
    gateway.failTransition = true;
    gateway.failRecoveryRead = true;
    const { running, assetDirectory } = await startTestServer(gateway);
    try {
      const response = await fetch(`${running.url}/api/issues/12/status`, {
        method: "POST",
        headers: mutationHeaders(running),
        body: JSON.stringify({ status: "review" }),
      });
      assert.equal(response.status, 502);
      const payload = await response.json() as {
        error: { stateVerified: boolean };
      };
      assert.equal(payload.error.stateVerified, false);
    } finally {
      await stopTestServer(running, assetDirectory);
    }
  });

  test("serializes status, edit, and assignee mutations on the same issue key", async () => {
    const gateway = new FakeBoardGateway();
    gateway.transitionDelayMs = 15;
    const { running, assetDirectory } = await startTestServer(gateway);
    try {
      const responses = await Promise.all([
        fetch(`${running.url}/api/issues/12/status`, {
          method: "POST",
          headers: mutationHeaders(running),
          body: JSON.stringify({ status: "review" }),
        }),
        fetch(`${running.url}/api/issues/12`, {
          method: "PATCH",
          headers: mutationHeaders(running),
          body: JSON.stringify({ body: "Updated safely." }),
        }),
        fetch(`${running.url}/api/issues/12/assignees`, {
          method: "POST",
          headers: mutationHeaders(running),
          body: JSON.stringify({ login: "hubot" }),
        }),
      ]);
      assert.deepEqual(responses.map(({ status }) => status), [200, 200, 200]);
      assert.equal(gateway.maxActiveTransitions, 1);
      assert.equal(gateway.updateCalls, 1);
      assert.equal(gateway.assigneeCalls, 1);
    } finally {
      await stopTestServer(running, assetDirectory);
    }
  });

  test("serves only allowlisted history routes and permits only GitHub's avatar host", async () => {
    const { running, assetDirectory } = await startTestServer();
    try {
      for (const route of ["/overview", "/tasks", "/activity", "/pull-requests", "/milestones"]) {
        const response = await fetch(`${running.url}${route}`);
        assert.equal(response.status, 200);
        const policy = response.headers.get("content-security-policy") ?? "";
        assert.match(policy, /img-src 'self' data: https:\/\/avatars\.githubusercontent\.com/);
      }
      assert.equal((await fetch(`${running.url}/settings`)).status, 404);
    } finally {
      await stopTestServer(running, assetDirectory);
    }
  });
});

function issueDetail(number: number): TaskDetail {
  return {
    task: {
      id: number,
      nodeId: `I_${number}`,
      number,
      status: null,
      fullTitle: `Issue ${number}`,
      title: `Issue ${number}`,
      body: "",
      state: "OPEN",
      labels: [],
      url: `https://github.com/acme/example/issues/${number}`,
      createdAt: "",
      updatedAt: "",
      author: null,
      assignees: [],
      milestone: null,
    },
    parent: null,
    subIssues: [],
    blockedBy: [],
    blocking: [],
    linkedPullRequests: [],
  };
}

describe("backend API hardening", () => {
  test("accepts multibyte titles by character count", async () => {
    const { running, assetDirectory } = await startTestServer();
    try {
      const titleResponse = await fetch(`${running.url}/api/issues/12`, {
        method: "PATCH",
        headers: mutationHeaders(running),
        body: JSON.stringify({ title: "é".repeat(200) }),
      });
      assert.equal(titleResponse.status, 200);
    } finally {
      await stopTestServer(running, assetDirectory);
    }
  });

  test("preserves GitHub rate limits as HTTP 429", async () => {
    class RateLimitedGateway extends FakeBoardGateway {
      override async getIssue(): Promise<TaskIssue> {
        throw new GitHubApiError("API rate limit exceeded.", "rate-limit", true, true, 429);
      }
    }
    const { running, assetDirectory } = await startTestServer(new RateLimitedGateway());
    try {
      const response = await fetch(`${running.url}/api/issues/12`);
      assert.equal(response.status, 429);
      const payload = await response.json() as { error: { code: string; retryable: boolean } };
      assert.deepEqual(payload.error, { code: "rate-limit", message: "API rate limit exceeded.", retryable: true, stateVerified: true });
    } finally {
      await stopTestServer(running, assetDirectory);
    }
  });

  test("returns milestone exact-title recovery metadata", async () => {
    class AmbiguousMilestoneGateway extends FakeBoardGateway {
      async createMilestone(input: { title: string }): Promise<never> {
        throw new AmbiguousMilestoneCreateError("Milestone creation is ambiguous.", input.title, "https://github.com/acme/example/milestones");
      }
    }
    const { running, assetDirectory } = await startTestServer(new AmbiguousMilestoneGateway());
    try {
      const response = await fetch(`${running.url}/api/milestones`, {
        method: "POST",
        headers: mutationHeaders(running),
        body: JSON.stringify({ title: "Exact milestone" }),
      });
      assert.equal(response.status, 502);
      const payload = await response.json() as {
        error: { retryable: boolean };
        recovery: { kind: string; title: string; milestonesUrl: string };
      };
      assert.equal(payload.error.retryable, false);
      assert.deepEqual(payload.recovery, {
        kind: "ambiguous-milestone-create",
        title: "Exact milestone",
        milestonesUrl: "https://github.com/acme/example/milestones",
      });
    } finally {
      await stopTestServer(running, assetDirectory);
    }
  });
  test("queues relation writes under both sorted issue keys", async () => {
    class RelationGateway extends FakeBoardGateway {
      mutationFinished = false;
      relatedReadSawMutation = false;

      async mutateSubIssue(parentNumber: number): Promise<TaskDetail> {
        await delay(25);
        this.mutationFinished = true;
        return issueDetail(parentNumber);
      }

      async getIssueDetail(number: number): Promise<TaskDetail> {
        if (number === 13) this.relatedReadSawMutation = this.mutationFinished;
        return issueDetail(number);
      }
    }
    const gateway = new RelationGateway();
    const { running, assetDirectory } = await startTestServer(gateway);
    try {
      const mutation = fetch(`${running.url}/api/issues/12/sub-issues`, {
        method: "POST",
        headers: mutationHeaders(running),
        body: JSON.stringify({ issueNumber: 13 }),
      });
      await delay(5);
      const relatedRead = fetch(`${running.url}/api/issues/13`);
      const [mutationResponse, readResponse] = await Promise.all([mutation, relatedRead]);
      assert.equal(mutationResponse.status, 200);
      assert.equal(readResponse.status, 200);
      assert.equal(gateway.relatedReadSawMutation, true);
    } finally {
      await stopTestServer(running, assetDirectory);
    }
  });

  test("waits for issue milestone mutations before reading milestone items", async () => {
    class MilestoneItemsGateway extends FakeBoardGateway {
      itemReadSawUpdate = false;

      async getMilestoneItems() {
        this.itemReadSawUpdate = this.updateCalls === 1;
        return { issues: [], pullRequests: [], complete: true };
      }
    }
    const gateway = new MilestoneItemsGateway();
    gateway.transitionDelayMs = 25;
    const { running, assetDirectory } = await startTestServer(gateway);
    try {
      const mutation = fetch(`${running.url}/api/issues/12`, {
        method: "PATCH",
        headers: mutationHeaders(running),
        body: JSON.stringify({ milestone: 3 }),
      });
      await delay(5);
      const itemRead = fetch(`${running.url}/api/milestones/3/items`);
      const [mutationResponse, readResponse] = await Promise.all([mutation, itemRead]);
      assert.equal(mutationResponse.status, 200);
      assert.equal(readResponse.status, 200);
      assert.equal(gateway.itemReadSawUpdate, true);
    } finally {
      await stopTestServer(running, assetDirectory);
    }
  });
});
