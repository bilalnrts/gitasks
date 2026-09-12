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
import {
  loadUiAssets,
  parseUiPort,
  startUiServer,
  type BoardGateway,
  type RunningUiServer,
} from "../src/ui/server.js";
import { PartialCreateError, UserError } from "../src/utils/errors.js";

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
  getCalls = 0;
  failTransition = false;
  failRecoveryRead = false;
  failClosedCreate = false;
  transitionDelayMs = 0;
  activeTransitions = 0;
  maxActiveTransitions = 0;

  async listIssues(): Promise<TaskIssue[]> {
    return [this.issue];
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
        labels: ["security", transition.nextStatusLabel],
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
});
