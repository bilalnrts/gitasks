import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { initializeRepository } from "../src/commands/init.js";
import { listTasks } from "../src/commands/list.js";
import { GitHubClient } from "../src/github/client.js";
import { parseGitHubRemote } from "../src/github/repo.js";
import {
  formatTaskTitle,
  inferTaskStatus,
  parseTaskTitle,
} from "../src/tasks/parser.js";
import { parseIssueNumber, transitionTask } from "../src/tasks/service.js";
import {
  isStatusLabel,
  normalizeStatus,
  statusFromLabel,
  statusLabel,
} from "../src/tasks/statuses.js";
import type {
  IssueTransition,
  TaskGateway,
  TaskIssue,
} from "../src/tasks/types.js";
import type { CommandRunner } from "../src/utils/exec.js";

class FakeGateway implements TaskGateway {
  transition?: IssueTransition;

  constructor(private readonly issue: TaskIssue) {}

  async getIssue(issueNumber: number): Promise<TaskIssue> {
    assert.equal(issueNumber, this.issue.number);
    return this.issue;
  }

  async transitionIssue(
    issueNumber: number,
    transition: IssueTransition,
  ): Promise<TaskIssue> {
    assert.equal(issueNumber, this.issue.number);
    this.transition = transition;
    return {
      ...this.issue,
      title: transition.title,
      state: transition.state === "closed" ? "CLOSED" : "OPEN",
      labels: [
        ...this.issue.labels.filter((label) => !isStatusLabel(label)),
        transition.nextStatusLabel,
      ],
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

  test("prefers one canonical label, then title, then BACKLOG", () => {
    assert.equal(
      inferTaskStatus(["priority:high", "status:review"], "[TODO] Work"),
      "REVIEW",
    );
    assert.equal(inferTaskStatus([], "[TODO] Work"), "TODO");
    assert.equal(inferTaskStatus([], "Manual issue"), "BACKLOG");
  });

  test("resolves conflicting status labels deterministically", () => {
    assert.equal(
      inferTaskStatus(["status:todo", "status:review"], "[REVIEW] Work"),
      "REVIEW",
    );
    assert.equal(
      inferTaskStatus(["status:review", "status:todo"], "Manual issue"),
      "TODO",
    );
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
    assert.deepEqual(gateway.transition, {
      title: "[IN PROGRESS] Implement login",
      state: "open",
      previousStatusLabels: ["status:done", "STATUS:legacy"],
      nextStatusLabel: "status:in-progress",
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

  test("does not replace unrelated labels during a GitHub transition", async () => {
    const invocations: string[][] = [];
    const runner: CommandRunner = async (_file, args) => {
      const invocation = [...args];
      invocations.push(invocation);
      if (invocation.includes("POST")) {
        return { stdout: "[]", stderr: "" };
      }
      if (invocation.includes("PATCH")) {
        return {
          stdout: JSON.stringify({
            number: 9,
            title: "[REVIEW] Work",
            state: "open",
            labels: [{ name: "priority:high" }, { name: "status:review" }],
            html_url: "https://github.com/acme/example/issues/9",
          }),
          stderr: "",
        };
      }
      if (invocation.includes("DELETE")) {
        return { stdout: "", stderr: "" };
      }
      return {
        stdout: JSON.stringify({
          number: 9,
          title: "[REVIEW] Work",
          state: "open",
          labels: [{ name: "priority:high" }, { name: "status:review" }],
          html_url: "https://github.com/acme/example/issues/9",
        }),
        stderr: "",
      };
    };
    const client = new GitHubClient("acme/example", runner);

    const updated = await client.transitionIssue(9, {
      title: "[REVIEW] Work",
      state: "open",
      previousStatusLabels: ["status:todo"],
      nextStatusLabel: "status:review",
    });

    const patch = invocations.find((args) => args.includes("PATCH"));
    assert.ok(patch);
    assert.equal(patch.some((argument) => argument.startsWith("labels[]=")), false);
    assert.deepEqual(updated.labels, ["priority:high", "status:review"]);
  });
});

describe("issue listing", () => {
  test("paginates REST results and excludes pull requests", async () => {
    const invocations: string[][] = [];
    const runner: CommandRunner = async (_file, args) => {
      invocations.push([...args]);
      return {
        stdout: JSON.stringify([
          [
            {
              number: 1,
              title: "[TODO] First",
              state: "open",
              labels: [{ name: "status:todo" }],
              url: "https://api.github.com/repos/acme/example/issues/1",
              html_url: "https://github.com/acme/example/issues/1",
            },
            {
              number: 2,
              title: "A pull request",
              state: "open",
              labels: [],
              html_url: "https://github.com/acme/example/pull/2",
              pull_request: {},
            },
          ],
          [
            {
              number: 3,
              title: "[DONE] Last",
              state: "closed",
              labels: [{ name: "status:done" }],
              html_url: "https://github.com/acme/example/issues/3",
            },
          ],
        ]),
        stderr: "",
      };
    };
    const client = new GitHubClient("acme/example", runner);

    const issues = await client.listIssues("all");

    assert.deepEqual(issues.map(({ number }) => number), [1, 3]);
    assert.equal(issues[0]?.url, "https://github.com/acme/example/issues/1");
    assert.deepEqual(invocations[0], [
      "api",
      "repos/acme/example/issues?state=all&per_page=100",
      "--paginate",
      "--slurp",
    ]);

    const openIssues = await client.listIssues("open");
    assert.deepEqual(openIssues.map(({ number }) => number), [1]);
    assert.equal(
      invocations[1]?.[1],
      "repos/acme/example/issues?state=open&per_page=100",
    );
  });

  test("explicit filters include manually closed issues", async () => {
    let requestedState: "open" | "all" | undefined;
    const client = {
      async listIssues(state: "open" | "all"): Promise<TaskIssue[]> {
        requestedState = state;
        return [{
          number: 4,
          title: "[TODO] Closed manually",
          state: "CLOSED",
          labels: ["status:todo"],
          url: "https://github.com/acme/example/issues/4",
        }];
      },
    };

    const output = await listTasks(client, { status: "todo" });

    assert.equal(requestedState, "all");
    assert.match(output, /#4\s+\[TODO\]\s+Closed manually/);
  });
});

describe("repository initialization", () => {
  test("preserves an existing AGENTS.md and inserts Gitasks once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gitasks-init-"));
    try {
      const agentsPath = join(directory, "AGENTS.md");
      await writeFile(agentsPath, "# Existing agent rules\n\nKeep this text.\n", "utf8");
      const client = {
        async ensureStatusLabels(): Promise<string[]> {
          return [];
        },
      };

      await initializeRepository(client, directory);
      const first = await readFile(agentsPath, "utf8");
      await initializeRepository(client, directory);
      const second = await readFile(agentsPath, "utf8");

      assert.match(first, /^# Existing agent rules/m);
      assert.match(first, /Keep this text\./);
      assert.equal(first.match(/<!-- gitasks:start -->/g)?.length, 1);
      assert.equal(second, first);
      assert.match(
        await readFile(join(directory, ".gitasks", "protocol.md"), "utf8"),
        /GitHub Issues are this repository's task management source of truth/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
