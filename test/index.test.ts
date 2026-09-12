import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseGitHubRemote } from "../src/github/repo.js";
import {
  formatTaskTitle,
  inferTaskStatus,
  parseTaskTitle,
} from "../src/tasks/parser.js";
import { parseIssueNumber, transitionTask } from "../src/tasks/service.js";
import {
  normalizeStatus,
  statusFromLabel,
  statusLabel,
} from "../src/tasks/statuses.js";
import type { IssueUpdate, TaskGateway, TaskIssue } from "../src/tasks/types.js";

class FakeGateway implements TaskGateway {
  update?: IssueUpdate;

  constructor(private readonly issue: TaskIssue) {}

  async getIssue(issueNumber: number): Promise<TaskIssue> {
    assert.equal(issueNumber, this.issue.number);
    return this.issue;
  }

  async updateIssue(issueNumber: number, update: IssueUpdate): Promise<TaskIssue> {
    assert.equal(issueNumber, this.issue.number);
    this.update = update;
    return {
      ...this.issue,
      title: update.title,
      state: update.state === "closed" ? "CLOSED" : "OPEN",
      labels: update.labels,
    };
  }
}

describe("GitHub repository parsing", () => {
  test("normalizes HTTPS remotes", () => {
    assert.equal(
      parseGitHubRemote("https://github.com/bilalnrts/gitasks.git"),
      "bilalnrts/gitasks",
    );
    assert.equal(
      parseGitHubRemote("http://github.com/bilalnrts/gitasks/"),
      "bilalnrts/gitasks",
    );
  });

  test("normalizes SCP-style and URL-style SSH remotes", () => {
    assert.equal(
      parseGitHubRemote("git@github.com:bilalnrts/gitasks.git"),
      "bilalnrts/gitasks",
    );
    assert.equal(
      parseGitHubRemote("ssh://git@github.com/bilalnrts/gitasks.git"),
      "bilalnrts/gitasks",
    );
  });

  test("rejects non-GitHub and malformed remotes", () => {
    assert.equal(parseGitHubRemote("https://gitlab.com/acme/tasks.git"), undefined);
    assert.equal(parseGitHubRemote("github.com/acme/tasks"), undefined);
  });
});

describe("task status protocol", () => {
  test("normalizes status names, slugs, and labels", () => {
    assert.equal(normalizeStatus("in progress"), "IN PROGRESS");
    assert.equal(normalizeStatus("IN_PROGRESS"), "IN PROGRESS");
    assert.equal(normalizeStatus("status:in-progress"), "IN PROGRESS");
    assert.equal(normalizeStatus("backlog"), "BACKLOG");
    assert.throws(() => normalizeStatus("waiting"), /Invalid status/);
  });

  test("generates and recognizes canonical labels", () => {
    assert.equal(statusLabel("IN PROGRESS"), "status:in-progress");
    assert.equal(statusFromLabel("STATUS:REVIEW"), "REVIEW");
    assert.equal(statusFromLabel("priority:high"), undefined);
  });

  test("parses titles with case and spacing variations", () => {
    assert.deepEqual(parseTaskTitle(" [ in_progress ]   Implement login "), {
      status: "IN PROGRESS",
      title: "Implement login",
    });
    assert.deepEqual(parseTaskTitle("A manually created issue"), {
      title: "A manually created issue",
    });
    assert.deepEqual(parseTaskTitle("[UNKNOWN] Keep this prefix"), {
      title: "[UNKNOWN] Keep this prefix",
    });
  });

  test("formats titles without stacking recognized prefixes", () => {
    assert.equal(formatTaskTitle("Implement login", "REVIEW"), "[REVIEW] Implement login");
    assert.equal(
      formatTaskTitle("[TODO] [IN PROGRESS] Implement login", "REVIEW"),
      "[REVIEW] Implement login",
    );
  });

  test("prefers a canonical label, then title, then BACKLOG", () => {
    assert.equal(
      inferTaskStatus(["priority:high", "status:review"], "[TODO] Work"),
      "REVIEW",
    );
    assert.equal(inferTaskStatus([], "[TODO] Work"), "TODO");
    assert.equal(inferTaskStatus([], "Manual issue"), "BACKLOG");
  });
});

describe("task transitions", () => {
  test("accepts plain and hash-prefixed issue numbers", () => {
    assert.equal(parseIssueNumber("42"), 42);
    assert.equal(parseIssueNumber("#42"), 42);
    assert.throws(() => parseIssueNumber("0"), /Invalid issue number/);
    assert.throws(() => parseIssueNumber("task-42"), /Invalid issue number/);
  });

  test("replaces prefixes and status labels while preserving unrelated labels", async () => {
    const gateway = new FakeGateway({
      number: 42,
      title: "[DONE] [TODO] Implement login",
      state: "CLOSED",
      labels: ["bug", "status:done", "STATUS:legacy"],
      url: "https://github.com/acme/example/issues/42",
    });

    const updated = await transitionTask(gateway, "#42", "IN PROGRESS");

    assert.equal(updated.title, "[IN PROGRESS] Implement login");
    assert.equal(updated.state, "OPEN");
    assert.deepEqual(updated.labels, ["bug", "status:in-progress"]);
    assert.deepEqual(gateway.update, {
      title: "[IN PROGRESS] Implement login",
      state: "open",
      labels: ["bug", "status:in-progress"],
    });
  });

  test("DONE closes the issue", async () => {
    const gateway = new FakeGateway({
      number: 7,
      title: "[REVIEW] Ship release",
      state: "OPEN",
      labels: ["status:review"],
      url: "https://github.com/acme/example/issues/7",
    });

    const updated = await transitionTask(gateway, "7", "DONE");

    assert.equal(updated.title, "[DONE] Ship release");
    assert.equal(updated.state, "CLOSED");
    assert.deepEqual(updated.labels, ["status:done"]);
  });
});
