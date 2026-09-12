import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  AmbiguousCreateError,
  CommandError,
} from "../src/utils/errors.js";
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

  test("prefers a canonical label, then title, and leaves unknown issues unclassified", () => {
    assert.equal(
      inferTaskStatus(["priority:high", "status:review"], "[TODO] Work"),
      "REVIEW",
    );
    assert.equal(inferTaskStatus([], "[TODO] Work"), "TODO");
    assert.equal(inferTaskStatus([], "Manual issue"), undefined);
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
      body: "",
      assignees: [],
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

  test("explicitly classifies an unclassified issue without losing unrelated labels", async () => {
    const gateway = new FakeGateway({
      number: 43,
      title: "Existing repository issue",
      state: "CLOSED",
      labels: ["bug", "needs-triage"],
      url: "https://github.com/acme/example/issues/43",
      body: "",
      assignees: [],
    });

    const updated = await transitionTask(gateway, "43", "TODO");

    assert.equal(updated.title, "[TODO] Existing repository issue");
    assert.equal(updated.state, "OPEN");
    assert.deepEqual(updated.labels, ["bug", "needs-triage", "status:todo"]);
    assert.deepEqual(gateway.transition?.previousStatusLabels, []);
  });

  test("DONE closes the issue", async () => {
    const gateway = new FakeGateway({
      number: 7,
      title: "[REVIEW] Ship release",
      state: "OPEN",
      labels: ["status:review"],
      url: "https://github.com/acme/example/issues/7",
      body: "",
      assignees: [],
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
    const first = {
      number: 1,
      title: "[TODO] First",
      state: "open",
      labels: [{ name: "status:todo" }],
      url: "https://api.github.com/repos/acme/example/issues/1",
      html_url: "https://github.com/acme/example/issues/1",
    };
    const pull = (number: number) => ({
      number,
      title: "A pull request",
      state: "open",
      labels: [],
      html_url: `https://github.com/acme/example/pull/${number}`,
      pull_request: {},
    });
    const runner: CommandRunner = async (_file, args) => {
      invocations.push([...args]);
      const path = args[5] ?? "";
      if (path.includes("state=all") && path.endsWith("page=1")) {
        return { stdout: JSON.stringify([first, ...Array.from({ length: 99 }, (_, index) => pull(index + 2))]), stderr: "" };
      }
      if (path.includes("state=all") && path.endsWith("page=2")) {
        return {
          stdout: JSON.stringify([{
            number: 3,
            title: "[DONE] Last",
            state: "closed",
            labels: [{ name: "status:done" }],
            html_url: "https://github.com/acme/example/issues/3",
          }]),
          stderr: "",
        };
      }
      return { stdout: JSON.stringify([first, pull(2)]), stderr: "" };
    };
    const client = new GitHubClient("acme/example", runner);

    const issues = await client.listIssues("all");

    assert.deepEqual(issues.map(({ number }) => number), [1, 3]);
    assert.equal(issues[0]?.url, "https://github.com/acme/example/issues/1");
    assert.deepEqual(invocations[0], [
      "api",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2026-03-10",
      "repos/acme/example/issues?state=all&per_page=100&page=1",
    ]);
    assert.equal(invocations[1]?.[5], "repos/acme/example/issues?state=all&per_page=100&page=2");

    const openIssues = await client.listIssues("open");
    assert.deepEqual(openIssues.map(({ number }) => number), [1]);
    assert.equal(
      invocations[2]?.[5],
      "repos/acme/example/issues?state=open&per_page=100&page=1",
    );
  });

  test("filters status and GitHub state independently", async () => {
    let requestedState: "open" | "closed" | "all" | undefined;
    const client = {
      async listIssues(state: "open" | "closed" | "all"): Promise<TaskIssue[]> {
        requestedState = state;
        return [{
          number: 4,
          title: "[TODO] Closed manually",
          state: "CLOSED",
          labels: ["status:todo"],
          url: "https://github.com/acme/example/issues/4",
          body: "",
          assignees: [],
        }];
      },
    };

    const output = await listTasks(client, { status: "todo", state: "closed" });

    assert.equal(requestedState, "closed");
    assert.match(output, /#4\s+\[TODO\]\s+\[CLOSED\]\s+Closed manually/);
  });

  test("lists unclassified open issues without changing them", async () => {
    const issue: TaskIssue = {
      number: 8,
      title: "Existing issue",
      state: "OPEN",
      labels: ["bug"],
      url: "https://github.com/acme/example/issues/8",
      body: "",
      assignees: [],
    };
    let requestedState: string | undefined;
    const output = await listTasks({
      async listIssues(state) {
        requestedState = state;
        return [issue];
      },
    }, { status: "unclassified" });

    assert.equal(requestedState, "open");
    assert.match(output, /#8\s+\[UNCLASSIFIED\]\s+\[OPEN\]\s+Existing issue/);
    assert.deepEqual(issue, {
      number: 8,
      title: "Existing issue",
      state: "OPEN",
      labels: ["bug"],
      url: "https://github.com/acme/example/issues/8",
      body: "",
      assignees: [],
    });
  });
});

describe("ambiguous issue creation", () => {
  test("does not disguise an unconfirmed create response as safely retryable", async () => {
    let createCalls = 0;
    const runner: CommandRunner = async () => {
      createCalls += 1;
      throw new CommandError({
        command: "gh api",
        exitCode: 1,
        stdout: "",
        stderr: "connection reset after request upload",
      });
    };
    const client = new GitHubClient("acme/example", runner);

    await assert.rejects(
      () => client.createIssue({
        title: "[BACKLOG] Possibly created",
        body: "",
        state: "open",
        label: "status:backlog",
      }),
      (error: unknown) => {
        assert.ok(error instanceof AmbiguousCreateError);
        assert.match(error.message, /Do not retry yet/);
        assert.match(error.message, /gitasks list --state all/);
        return true;
      },
    );
    assert.equal(createCalls, 1);
  });
});

describe("repository initialization", () => {
  test("preserves existing AGENTS.md and protocol content across repeated init", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gitasks-init-"));
    try {
      const agentsPath = join(directory, "AGENTS.md");
      const protocolPath = join(directory, ".gitasks", "protocol.md");
      await mkdir(join(directory, ".gitasks"), { recursive: true });
      await writeFile(agentsPath, "# Existing agent rules\n\nKeep this text.\n", "utf8");
      await writeFile(protocolPath, "# Custom protocol\n\nKeep this workflow.\n", "utf8");
      let labelChecks = 0;
      const client = {
        async ensureStatusLabels(): Promise<string[]> {
          labelChecks += 1;
          return [];
        },
      };

      await initializeRepository(client, directory);
      const first = await readFile(agentsPath, "utf8");
      await initializeRepository(client, directory);
      const second = await readFile(agentsPath, "utf8");

      assert.match(first, /^# Existing agent rules/m);
      assert.match(first, /search existing issues for the same work/);
      assert.equal(first.match(/<!-- gitasks:start -->/g)?.length, 1);
      assert.equal(second, first);
      assert.equal(
        await readFile(protocolPath, "utf8"),
        "# Custom protocol\n\nKeep this workflow.\n",
      );
      assert.equal(labelChecks, 2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
