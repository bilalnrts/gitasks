import { ApiRequestError, apiErrorDescription } from "../api.js";
import { checkboxGroup, chipBar, filterDetails, searchField, segmented, selectField, type FilterChip } from "../components/filters.js";
import { confirmDiscard, type DialogHandle } from "../components/overlays.js";
import { openPicker, type PickerOption } from "../components/picker.js";
import { avatarGroup, badge, button, el, externalLink, labelList, pageHeader, relativeTime, statePanel } from "../components/primitives.js";
import type { PageEnvelope, StatusDefinition, TaskDetail, TaskSummary, UserSummary, ViewKind, WorkflowStatus } from "../models.js";
import { WORKFLOW_STATUSES } from "../models.js";
import type { AppRoute } from "../router.js";
import { setRepeated, numericQuery } from "../router.js";
import type { AppServices, ViewController } from "../services.js";
import { TaskDragController } from "./task-drag.js";

interface BoardResponse extends Partial<PageEnvelope<TaskSummary>> {
  tasks?: TaskSummary[];
  items?: TaskSummary[];
}

interface TaskResponse {
  task?: TaskSummary;
  detail?: TaskDetail;
  parent?: TaskSummary | null;
  subIssues?: TaskSummary[];
  blockedBy?: TaskSummary[];
  blocking?: TaskSummary[];
  linkedPullRequests?: unknown[];
}

interface TaskFilters {
  view: ViewKind;
  state: "open" | "closed" | "all";
  query: string;
  statuses: string[];
  assignees: string[];
  milestones: string[];
  labels: string[];
  sort: string;
}

const DEFAULT_STATUSES: StatusDefinition[] = [
  { name: "BACKLOG", slug: "backlog", color: "BFD4F2" },
  { name: "TODO", slug: "todo", color: "FBCA04" },
  { name: "IN PROGRESS", slug: "in-progress", color: "1D76DB" },
  { name: "REVIEW", slug: "review", color: "A371F7" },
  { name: "DONE", slug: "done", color: "0E8A16" },
  { name: "BLOCKED", slug: "blocked", color: "D73A4A" },
];

function users(task: TaskSummary): UserSummary[] {
  const raw = task.assignees as unknown;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => typeof item === "string" ? { login: item, avatarUrl: "", url: `https://github.com/${encodeURIComponent(item)}` } : item as UserSummary).filter((item) => typeof item.login === "string");
}

function issueState(task: TaskSummary): "open" | "closed" {
  return String(task.state).toLowerCase() === "closed" ? "closed" : "open";
}

function taskTitle(task: TaskSummary): string {
  return String(task.title || task.fullTitle || `Issue #${task.number}`);
}

function statusOf(task: TaskSummary): WorkflowStatus | null {
  return WORKFLOW_STATUSES.includes(task.status as WorkflowStatus) ? task.status as WorkflowStatus : null;
}

function detailFrom(payload: TaskResponse | TaskDetail): TaskDetail {
  const response = payload as TaskResponse;
  if (response.detail) return response.detail;
  if (response.task) {
    return {
      task: response.task,
      parent: response.parent ?? null,
      subIssues: response.subIssues ?? [],
      blockedBy: response.blockedBy ?? [],
      blocking: response.blocking ?? [],
      linkedPullRequests: (response.linkedPullRequests ?? []) as TaskDetail["linkedPullRequests"],
    };
  }
  return payload as TaskDetail;
}

function taskFromMutation(payload: unknown): TaskSummary {
  const value = payload as { task?: TaskSummary };
  return value.task ?? payload as TaskSummary;
}

export class TasksView implements ViewController {
  private readonly root: HTMLElement;
  private readonly services: AppServices;
  private route: AppRoute;
  private tasks: TaskSummary[] = [];
  private statuses: StatusDefinition[] = DEFAULT_STATUSES;
  private complete = true;
  private hasNext = false;
  private nextPage: number | null = null;
  private knownTotal: number | null = null;
  private scope = "GitHub Issues";
  private refreshedAt: Date | undefined;
  private loading = true;
  private refreshing = false;
  private error: string | undefined;
  private detailHandle: DialogHandle | undefined;
  private detailNumber: number | undefined;
  private detail: TaskDetail | undefined;
  private detailError: string | undefined;
  private detailDirty = false;
  private drag: TaskDragController | undefined;
  private assignees: UserSummary[] = [];
  private milestones: Array<{ number: number; title: string; state: string }> = [];
  private metadataError: string | undefined;
  private readonly abort = new AbortController();

  constructor(root: HTMLElement, services: AppServices, route: AppRoute) {
    this.root = root;
    this.services = services;
    this.route = route;
    void this.load(true);
  }

  update(route: AppRoute): void {
    const stateChanged = this.filters().state !== parseFilters(route).state;
    this.route = route;
    if (stateChanged) void this.load(true);
    else this.render();
  }

  dispose(): void {
    this.abort.abort();
    this.drag?.dispose();
    this.detailHandle?.close("route", true);
  }

  private filters(): TaskFilters {
    return parseFilters(this.route);
  }

  private async load(initial: boolean): Promise<void> {
    this.error = undefined;
    this.loading = initial && this.tasks.length === 0;
    this.refreshing = !this.loading;
    this.render();
    const filters = this.filters();
    try {
      const result = await this.services.api.latest<BoardResponse>("tasks", `/api/board?state=${filters.state}&page=1`, { signal: this.abort.signal });
      if (!result.current) return;
      const payload = result.data;
      this.tasks = payload.items ?? payload.tasks ?? [];
      this.statuses = payload.statuses?.length ? payload.statuses : DEFAULT_STATUSES;
      this.complete = payload.complete ?? !payload.hasNext;
      this.hasNext = payload.hasNext ?? false;
      this.nextPage = payload.nextPage ?? (this.hasNext ? 2 : null);
      this.knownTotal = payload.knownTotal ?? null;
      this.scope = payload.scope ?? "GitHub Issues";
      this.refreshedAt = new Date();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) this.error = apiErrorDescription(error);
    } finally {
      this.loading = false;
      this.refreshing = false;
      if (!this.abort.signal.aborted) this.render();
    }
  }

  private async loadMore(trigger: HTMLButtonElement): Promise<void> {
    if (!this.nextPage) return;
    trigger.disabled = true;
    const page = this.nextPage;
    try {
      const payload = await this.services.api.request<BoardResponse>(`/api/board?state=${this.filters().state}&page=${page}`, { signal: this.abort.signal });
      const incoming = payload.items ?? payload.tasks ?? [];
      const byNumber = new Map(this.tasks.map((task) => [task.number, task]));
      for (const task of incoming) byNumber.set(task.number, task);
      this.tasks = [...byNumber.values()];
      this.hasNext = payload.hasNext ?? false;
      this.complete = payload.complete ?? !this.hasNext;
      this.nextPage = payload.nextPage ?? (this.hasNext ? page + 1 : null);
      this.knownTotal = payload.knownTotal ?? this.knownTotal;
      this.services.announce(`${incoming.length} more issues loaded.`);
      this.render();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.services.toasts.show(apiErrorDescription(error), { tone: "error", actionLabel: "Retry", action: () => void this.loadMore(trigger) });
      trigger.disabled = false;
    }
  }

  private visibleTasks(): TaskSummary[] {
    const filters = this.filters();
    const query = filters.query.trim().toLowerCase();
    const currentLogin = this.services.context.currentUser?.login;
    const tasks = this.tasks.filter((task) => {
      if (filters.state !== "all" && issueState(task) !== filters.state) return false;
      const status = statusOf(task);
      if (filters.statuses.length && !filters.statuses.includes(status ?? "unclassified")) return false;
      if (query) {
        const numeric = query.startsWith("#") ? query.slice(1) : query;
        if (!taskTitle(task).toLowerCase().includes(query) && String(task.fullTitle ?? "").toLowerCase().includes(query) === false && String(task.number) !== numeric) return false;
      }
      const taskUsers = users(task).map(({ login }) => login);
      if (filters.assignees.length && !filters.assignees.some((value) => value === "unassigned" ? !taskUsers.length : value === "me" ? Boolean(currentLogin && taskUsers.includes(currentLogin)) : taskUsers.includes(value))) return false;
      const milestone = task.milestone;
      if (filters.milestones.length && !filters.milestones.some((value) => value === "none" ? !milestone : String(milestone?.number) === value)) return false;
      if (filters.labels.length && !filters.labels.every((label) => task.labels.includes(label))) return false;
      return true;
    });
    const [field, direction] = filters.sort.split("-");
    const multiplier = direction === "asc" ? 1 : -1;
    return tasks.sort((left, right) => {
      if (field === "title") return taskTitle(left).localeCompare(taskTitle(right)) * multiplier;
      const leftValue = new Date(field === "created" ? left.createdAt : left.updatedAt).getTime() || 0;
      const rightValue = new Date(field === "created" ? right.createdAt : right.updatedAt).getTime() || 0;
      return (leftValue - rightValue || left.number - right.number) * multiplier;
    });
  }

  private render(): void {
    this.drag?.dispose();
    this.drag = undefined;
    const filters = this.filters();
    const refresh = button(this.refreshing ? "Refreshing…" : "Refresh", { onClick: () => void this.load(false), disabled: this.refreshing });
    const create = button("New task", { className: "button primary", onClick: (event) => void this.openCreate(event.currentTarget as HTMLElement) });
    const content = el("div", { className: "page page-wide" }, pageHeader("Tasks", this.scope, [refresh, create]));
    content.append(this.renderFilters(filters));
    if (this.refreshedAt) content.append(el("p", { className: "scope-line", text: `${this.visibleTasks().length} loaded issue${this.visibleTasks().length === 1 ? "" : "s"} match these filters${this.knownTotal !== null ? ` · ${this.knownTotal} known total` : ""}${this.hasNext ? " · more results available" : ""} · refreshed ${relativeTime(this.refreshedAt.toISOString())}` }));
    if (!this.complete) content.append(statePanel("partial", "Partial results", "GitHub returned only part of the issue set. Counts and filters apply to loaded issues only."));
    if (this.error) content.append(statePanel("error", "Issues could not be loaded", this.error, button("Retry", { onClick: () => void this.load(this.tasks.length === 0) })));
    if (this.loading) content.append(statePanel("loading", "Loading tasks", "Reading canonical issues from GitHub…"));
    else if (!this.tasks.length && !this.error) content.append(statePanel("empty", "No tasks yet", "Create the first task to start organizing this repository.", button("New task", { className: "button primary", onClick: (event) => void this.openCreate(event.currentTarget as HTMLElement) })));
    else if (!this.visibleTasks().length) content.append(statePanel("empty", "No tasks match", "Clear or change filters to see loaded issues.", button("Clear filters", { onClick: () => this.clearFilters() })));
    else content.append(filters.view === "board" ? this.renderBoard() : this.renderList());
    if (this.hasNext) content.append(button("Load more issues", { className: "button secondary load-more", onClick: (event) => void this.loadMore(event.currentTarget as HTMLButtonElement) }));
    this.root.replaceChildren(content);
    if (filters.view === "board") {
      const board = content.querySelector<HTMLElement>(".board-scroll");
      if (board) this.drag = new TaskDragController(board, this.services.overlayRoot, {
        labelFor: (status) => status ?? "Unclassified",
        announce: (message) => this.services.announce(message),
        openMoveMenu: (number, trigger) => this.openMoveMenu(number, trigger),
        drop: (number, source, target) => void this.moveTask(number, target, source),
        remains: (number, status) => this.services.announce(`Issue #${number} remains in ${status ?? "Unclassified"}.`),
        canStart: (number) => !this.services.mutations.isPending(`issue:${number}`),
      });
    }
    this.syncDetail();
  }

  private renderFilters(filters: TaskFilters): HTMLElement {
    const bar = el("section", { className: "filter-bar", attrs: { "aria-label": "Task filters" } });
    bar.append(searchField(filters.query, "Search title or #number", (value) => this.services.router.updateQuery((query) => value.trim() ? query.set("q", value) : query.delete("q"), { replace: true })));
    bar.append(segmented("GitHub state", filters.state, [{ value: "open", label: "Open" }, { value: "closed", label: "Closed" }, { value: "all", label: "All" }], (value) => this.services.router.updateQuery((query) => value === "open" ? query.delete("state") : query.set("state", value))));
    bar.append(segmented("Task view", filters.view, [{ value: "board", label: "Board" }, { value: "list", label: "List" }], (value) => this.services.router.updateQuery((query) => value === "board" ? query.delete("view") : query.set("view", value))));
    const assigneeValues = [{ value: "me", label: "Me" }, { value: "unassigned", label: "Unassigned" }, ...[...new Set(this.tasks.flatMap((task) => users(task).map(({ login }) => login)))].map((login) => ({ value: login, label: `@${login}` }))];
    const milestonesByNumber = new Map(this.tasks.flatMap((task) => task.milestone ? [[String(task.milestone.number), task.milestone.title] as const] : []));
    const milestoneValues = [{ value: "none", label: "No milestone" }, ...[...milestonesByNumber].map(([value, label]) => ({ value, label }))];
    const labelValues = [...new Set(this.tasks.flatMap((task) => task.labels))].sort();
    const advanced = el("div", { className: "filter-grid" },
      checkboxGroup("Status", "status", [...WORKFLOW_STATUSES.map((value) => ({ value, label: value })), { value: "unclassified", label: "Unclassified" }], filters.statuses, (values) => this.services.router.updateQuery((query) => setRepeated(query, "status", values))),
      checkboxGroup("Assignee", "assignee", assigneeValues, filters.assignees, (values) => this.services.router.updateQuery((query) => setRepeated(query, "assignee", values))),
      checkboxGroup("Milestone", "milestone", milestoneValues, filters.milestones, (values) => this.services.router.updateQuery((query) => setRepeated(query, "milestone", values))),
      checkboxGroup("Labels", "label", labelValues, filters.labels, (values) => this.services.router.updateQuery((query) => setRepeated(query, "label", values))),
      selectField("Sort", filters.sort, [{ value: "updated-desc", label: "Recently updated" }, { value: "updated-asc", label: "Least recently updated" }, { value: "created-desc", label: "Newest created" }, { value: "created-asc", label: "Oldest created" }, { value: "title-asc", label: "Title A–Z" }, { value: "title-desc", label: "Title Z–A" }], (value) => this.services.router.updateQuery((query) => value === "updated-desc" ? query.delete("sort") : query.set("sort", value))),
    );
    const advancedCount = filters.statuses.length + filters.assignees.length + filters.milestones.length + filters.labels.length + (filters.sort === "updated-desc" ? 0 : 1);
    bar.append(filterDetails("Filters", advancedCount, advanced));
    const chips: FilterChip[] = [];
    if (filters.query) chips.push({ label: `Search: ${filters.query}`, parameter: "q" });
    if (filters.state !== "open") chips.push({ label: `State: ${filters.state}`, parameter: "state" });
    for (const value of filters.statuses) chips.push({ label: `Status: ${value}`, parameter: "status", value });
    for (const value of filters.assignees) chips.push({ label: `Assignee: ${value}`, parameter: "assignee", value });
    for (const value of filters.milestones) chips.push({ label: `Milestone: ${value}`, parameter: "milestone", value });
    for (const value of filters.labels) chips.push({ label: `Label: ${value}`, parameter: "label", value });
    if (filters.sort !== "updated-desc") chips.push({ label: `Sort: ${filters.sort}`, parameter: "sort" });
    const chipsNode = chipBar(this.services.router, chips, () => this.clearFilters());
    return el("div", { className: "filters-wrap" }, bar, chipsNode);
  }

  private clearFilters(): void {
    this.services.router.navigate(`/tasks${this.filters().view === "list" ? "?view=list" : ""}`);
  }

  private renderBoard(): HTMLElement {
    const board = el("div", { className: "board-scroll", attrs: { tabindex: "0", "aria-label": "Task board. Scroll horizontally to view workflow columns." } });
    const selected = this.filters().statuses;
    for (const status of this.statuses.filter(({ name }) => !selected.length || selected.includes(name))) {
      const columnTasks = this.visibleTasks().filter((task) => statusOf(task) === status.name);
      const headingId = `column-${status.slug}`;
      const list = el("ol", { className: "task-list" });
      if (!columnTasks.length) list.append(el("li", { className: "column-empty", text: `No loaded tasks in ${status.name}.` }));
      else for (const task of columnTasks) list.append(el("li", {}, this.taskCard(task)));
      board.append(el("section", { className: "board-column", attrs: { "aria-labelledby": headingId }, dataset: { dropStatus: status.name } }, el("header", { className: "column-header" }, el("h2", { id: headingId, text: status.name }), badge(String(columnTasks.length))), list));
    }
    if (!selected.length || selected.includes("unclassified")) {
      const unclassified = this.visibleTasks().filter((task) => statusOf(task) === null);
      const list = el("ol", { className: "task-list" });
      if (!unclassified.length) list.append(el("li", { className: "column-empty", text: "No loaded unclassified issues." }));
      else for (const task of unclassified) list.append(el("li", {}, this.taskCard(task)));
      board.append(el("section", { className: "board-column unclassified-column", attrs: { "aria-labelledby": "column-unclassified" } }, el("header", { className: "column-header" }, el("div", {}, el("h2", { id: "column-unclassified", text: "Unclassified" }), el("p", { text: "Readable, but never a drop target." })), badge(String(unclassified.length))), list));
    }
    return board;
  }

  private taskCard(task: TaskSummary): HTMLElement {
    const pending = this.services.mutations.isPending(`issue:${task.number}`);
    const card = el("article", { className: `task-card${pending ? " is-pending" : ""}`, dataset: { issue: String(task.number), status: statusOf(task) ?? "unclassified" }, attrs: { "aria-busy": String(pending) } });
    const handle = button("Move", { className: "drag-handle", disabled: pending, title: "Drag, or activate to choose a status" });
    handle.dataset.dragHandle = "true";
    handle.setAttribute("aria-label", `Move issue #${task.number}`);
    const title = button(taskTitle(task), { className: "task-title", disabled: pending, onClick: (event) => this.services.router.openDetail("issue", task.number) });
    const body = String(task.body ?? "").trim();
    card.append(el("div", { className: "card-topline" }, el("span", { className: "issue-number", text: `#${task.number}` }), badge(issueState(task), issueState(task) === "open" ? "success" : "neutral"), handle), title);
    if (body) card.append(el("p", { className: "task-excerpt", text: body }));
    card.append(el("div", { className: "task-meta" }, avatarGroup(users(task)), task.milestone ? el("span", { className: "meta-item", text: `Milestone: ${task.milestone.title}` }) : null));
    if (task.labels.length) card.append(labelList(task.labels));
    const relations = [task.relationCount !== undefined ? `${task.relationCount} relation${task.relationCount === 1 ? "" : "s"}` : "", task.linkedPullRequestCount !== undefined ? `${task.linkedPullRequestCount} linked PR${task.linkedPullRequestCount === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
    if (relations) card.append(el("p", { className: "card-relations", text: relations }));
    card.append(el("footer", { className: "card-footer" }, button("Move to…", { className: "button compact", disabled: pending, onClick: (event) => this.openMoveMenu(task.number, event.currentTarget as HTMLElement) }), externalLink("GitHub ↗", task.url)));
    return card;
  }

  private renderList(): HTMLElement {
    const table = el("table", { className: "data-table task-table" });
    table.append(el("thead", {}, el("tr", {}, ...["Task", "Status", "State", "Assignees", "Milestone", "Labels", "Updated", "Actions"].map((name) => el("th", { text: name, attrs: { scope: "col" } })))));
    const body = el("tbody");
    for (const task of this.visibleTasks()) {
      const pending = this.services.mutations.isPending(`issue:${task.number}`);
      const action = button("Move to…", { className: "button compact", disabled: pending, onClick: (event) => this.openMoveMenu(task.number, event.currentTarget as HTMLElement) });
      body.append(el("tr", { dataset: { issue: String(task.number), status: statusOf(task) ?? "unclassified" }, attrs: { "aria-busy": String(pending) } },
        el("th", { attrs: { scope: "row", "data-label": "Task" } }, button(`#${task.number} ${taskTitle(task)}`, { className: "table-title", onClick: () => this.services.router.openDetail("issue", task.number) }), task.body ? el("span", { className: "table-excerpt", text: task.body }) : null),
        el("td", { attrs: { "data-label": "Status" } }, badge(statusOf(task) ?? "Unclassified", statusOf(task) ? "accent" : "warning")),
        el("td", { attrs: { "data-label": "State" } }, issueState(task)),
        el("td", { attrs: { "data-label": "Assignees" } }, avatarGroup(users(task))),
        el("td", { attrs: { "data-label": "Milestone" }, text: task.milestone?.title ?? "None" }),
        el("td", { attrs: { "data-label": "Labels" } }, labelList(task.labels)),
        el("td", { attrs: { "data-label": "Updated" }, text: relativeTime(task.updatedAt) }),
        el("td", { attrs: { "data-label": "Actions" } }, action, externalLink("GitHub ↗", task.url)),
      ));
    }
    table.append(body);
    return el("div", { className: "table-scroll", attrs: { tabindex: "0", "aria-label": "Task list" } }, table);
  }

  private openMoveMenu(issueNumber: number, trigger: HTMLElement): void {
    const task = this.tasks.find((item) => item.number === issueNumber);
    if (!task) return;
    const current = statusOf(task);
    const handle = this.services.overlays.open({ title: `Move issue #${issueNumber}`, eyebrow: "Workflow status", kind: "menu", returnFocus: trigger });
    const list = el("div", { className: "move-menu", attrs: { role: "menu" } });
    for (const status of WORKFLOW_STATUSES) {
      const item = button(status, { className: "menu-item", disabled: status === current, onClick: () => { handle.close("select", true); void this.moveTask(issueNumber, status, current); } });
      item.setAttribute("role", "menuitem");
      if (status === current) item.textContent = `${status} (current)`;
      list.append(item);
    }
    list.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const enabled = [...list.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
      enabled[(index + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length]?.focus();
    });
    handle.body.append(list);
  }

  private async moveTask(issueNumber: number, target: WorkflowStatus, source: WorkflowStatus | null): Promise<void> {
    if (target === source || this.services.mutations.isPending(`issue:${issueNumber}`)) {
      this.services.announce(`Issue #${issueNumber} remains in ${source ?? "Unclassified"}.`);
      return;
    }
    const snapshot = [...this.tasks];
    const detailSnapshot = this.detail;
    this.tasks = this.tasks.map((task) => task.number === issueNumber ? { ...task, status: target } : task);
    if (this.detail?.task.number === issueNumber) this.detail = { ...this.detail, task: { ...this.detail.task, status: target } };
    const operation = this.services.mutations.run(`issue:${issueNumber}`, () => this.services.api.request<unknown>(`/api/issues/${issueNumber}/status`, { method: "POST", body: JSON.stringify({ status: target }) }));
    this.render();
    this.renderDetail();
    try {
      const payload = await operation;
      const updated = taskFromMutation(payload);
      this.upsert(updated);
      this.services.api.invalidate("tasks");
      const hidden = this.filters().state === "open" && issueState(updated) === "closed";
      const message = hidden ? `Issue #${issueNumber} moved to ${target} and closed; hidden by the Open filter.` : `Issue #${issueNumber} moved to ${target}.`;
      this.services.toasts.show(message, { tone: "success" });
      this.services.announce(message);
    } catch (error) {
      this.tasks = snapshot;
      this.detail = detailSnapshot;
      this.services.toasts.show(apiErrorDescription(error), { tone: "error" });
      try {
        const result = await this.services.api.latest<TaskResponse | TaskDetail>(`issue:${issueNumber}:repair`, `/api/issues/${issueNumber}`, { signal: this.abort.signal });
        if (result.current) this.upsert(detailFrom(result.data).task);
      } catch {
        if (!this.abort.signal.aborted) this.services.toasts.show("The move was rolled back locally, but GitHub could not be re-read. Refresh before continuing.", { tone: "error" });
      }
    } finally {
      if (!this.abort.signal.aborted) {
        this.render();
        this.renderDetail();
        const movedHandle = this.root.querySelector<HTMLElement>(`[data-issue="${issueNumber}"] [data-drag-handle]`);
        const destination = [...this.root.querySelectorAll<HTMLElement>("[data-drop-status]")].find((column) => column.dataset.dropStatus === target)?.querySelector<HTMLElement>(".column-heading");
        const focusTarget = movedHandle ?? destination ?? this.root.querySelector<HTMLElement>(".page-header h1, .filter-details > summary");
        if (focusTarget) {
          if (!focusTarget.matches("button, a, input, select, textarea, summary, [tabindex]")) focusTarget.tabIndex = -1;
          focusTarget.focus();
        }
      }
    }
  }

  private upsert(task: TaskSummary): void {
    const index = this.tasks.findIndex((item) => item.number === task.number);
    if (index < 0) this.tasks.unshift(task);
    else this.tasks[index] = task;
    if (this.detail?.task.number === task.number) this.detail = { ...this.detail, task };
  }

  private async openCreate(trigger: HTMLElement): Promise<void> {
    await this.loadMetadata();
    if (this.abort.signal.aborted) return;
    let dirty = false;
    const handle = this.services.overlays.open({ title: "Create task", eyebrow: this.services.context.repository, kind: "form", returnFocus: trigger, beforeClose: () => !dirty || confirmDiscard(), defaultFocus: "first" });
    const form = el("form", { className: "form-grid" });
    const title = el("input", { attrs: { type: "text", name: "title", required: "", maxlength: "256", autocomplete: "off" } });
    const body = el("textarea", { attrs: { name: "body", rows: "7" } });
    const status = el("select", { attrs: { name: "status" } });
    for (const item of WORKFLOW_STATUSES) status.append(el("option", { text: item, attrs: { value: item } }));
    const assigneeBox = el("div", { className: "choice-grid" });
    for (const user of this.assignees) {
      const checkbox = el("input", { attrs: { type: "checkbox", name: "assignee", value: user.login } });
      assigneeBox.append(el("label", {}, checkbox, el("span", { text: `@${user.login}` })));
    }
    const milestone = el("select", { attrs: { name: "milestone" } }, el("option", { text: "No milestone", attrs: { value: "" } }));
    for (const item of this.milestones.filter(({ state }) => state === "open")) milestone.append(el("option", { text: item.title, attrs: { value: String(item.number) } }));
    form.append(field("Title", title), field("Description (plain text)", body), field("Initial status", status), field("Assignees", assigneeBox), field("Milestone", milestone));
    if (this.metadataError) form.append(el("p", { className: "permission-note", text: `Assignee or milestone options are unavailable: ${this.metadataError}` }));
    form.addEventListener("input", () => { dirty = true; });
    const cancel = button("Cancel", { onClick: () => handle.close("cancel") });
    cancel.dataset.cancel = "true";
    const submit = button("Create task", { className: "button primary", onClick: () => form.requestSubmit() });
    handle.body.append(form);
    handle.footer.append(cancel, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      void (async () => {
        handle.setBusy(true, "Creating…");
        handle.setError();
        const data = new FormData(form);
        const input = { title: String(data.get("title") ?? "").trim(), body: String(data.get("body") ?? ""), status: String(data.get("status") ?? "BACKLOG"), assignees: data.getAll("assignee").map(String), milestone: data.get("milestone") ? Number(data.get("milestone")) : null };
        try {
          const payload = await this.services.api.request<unknown>("/api/issues", { method: "POST", body: JSON.stringify(input) });
          const task = taskFromMutation(payload);
          this.upsert(task);
          dirty = false;
          handle.close("created", true);
          this.services.toasts.show(`Issue #${task.number} created.`, { tone: "success" });
          if (!this.abort.signal.aborted) this.render();
        } catch (error) {
          if (error instanceof ApiRequestError && error.payload.task && typeof error.payload.task === "object") {
            const task = error.payload.task as TaskSummary;
            this.upsert(task);
            dirty = false;
            handle.close("partial", true);
            const repair = error.payload.repair as { status?: string } | undefined;
            const target = repair?.status;
            const message = apiErrorDescription(error);
            if (target && WORKFLOW_STATUSES.includes(target as WorkflowStatus)) {
              this.services.toasts.show(message, { tone: "error", actionLabel: `Repair ${target}`, action: () => void this.moveTask(task.number, target as WorkflowStatus, statusOf(task)) });
            } else {
              this.services.toasts.show(message, { tone: "error" });
            }
            if (!this.abort.signal.aborted) this.render();
          } else {
            handle.setError(apiErrorDescription(error));
            handle.setBusy(false);
          }
        }
      })();
    });
  }

  private async loadMetadata(): Promise<void> {
    if (this.assignees.length || this.milestones.length || this.metadataError) return;
    try {
      const [assignees, milestones] = await Promise.all([
        this.services.api.request<UserSummary[] | { items: UserSummary[] }>("/api/assignees", { signal: this.abort.signal }),
        this.services.api.request<Array<{ number: number; title: string; state: string }> | { items: Array<{ number: number; title: string; state: string }> }>("/api/milestones?state=all", { signal: this.abort.signal }),
      ]);
      this.assignees = Array.isArray(assignees) ? assignees : assignees.items;
      this.milestones = Array.isArray(milestones) ? milestones : milestones.items;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.metadataError = apiErrorDescription(error);
    }
  }

  private syncDetail(): void {
    const number = numericQuery(this.route.query, "issue");
    if (!number) {
      if (this.detailHandle) {
        const handle = this.detailHandle;
        this.detailHandle = undefined;
        this.detailNumber = undefined;
        this.detail = undefined;
        this.detailDirty = false;
        handle.close("route", true);
      }
      return;
    }
    if (this.detailHandle && this.detailNumber === number) return;
    this.detailHandle?.close("route", true);
    this.detailNumber = number;
    this.detailDirty = false;
    const handle = this.services.overlays.open({ title: `Issue #${number}`, eyebrow: "Task detail", kind: "drawer", beforeClose: () => !this.detailDirty || confirmDiscard(), onClose: (value) => {
      if (this.detailHandle === handle) this.detailHandle = undefined;
      if (value !== "route" && numericQuery(this.services.router.current().query, "issue") === number) this.services.router.closeDetail("issue");
    } });
    this.detailHandle = handle;
    handle.body.append(statePanel("loading", "Loading issue", "Reading details and relations from GitHub…"));
    void this.loadDetail(number);
  }

  private async loadDetail(number: number): Promise<void> {
    this.detailError = undefined;
    try {
      const result = await this.services.api.latest<TaskResponse | TaskDetail>(`issue:${number}:detail`, `/api/issues/${number}`, { signal: this.abort.signal });
      if (!result.current || this.detailNumber !== number) return;
      this.detail = detailFrom(result.data);
      this.upsert(this.detail.task);
      await this.loadMetadata();
      if (this.abort.signal.aborted) return;
      this.renderDetail();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.detailError = apiErrorDescription(error);
      this.renderDetail();
    }
  }

  private renderDetail(): void {
    const handle = this.detailHandle;
    const number = this.detailNumber;
    if (!handle || !number) return;
    handle.body.replaceChildren();
    handle.footer.replaceChildren();
    if (this.detailError) {
      handle.body.append(statePanel("error", "Issue could not be loaded", this.detailError, button("Retry", { onClick: () => void this.loadDetail(number) })));
      return;
    }
    if (!this.detail) {
      handle.body.append(statePanel("loading", "Loading issue", "Reading details and relations from GitHub…"));
      return;
    }
    const detail = this.detail;
    const task = detail.task;
    const pending = this.services.mutations.isPending(`issue:${number}`);
    const form = el("form", { className: "form-grid detail-edit" });
    const title = el("input", { attrs: { type: "text", required: "", maxlength: "256", value: taskTitle(task) } });
    title.value = taskTitle(task);
    const body = el("textarea", { attrs: { rows: "8" } });
    body.value = String(task.body ?? "");
    form.append(field("Title", title), field("Description (plain text)", body));
    const save = button("Save title and description", { className: "button primary", disabled: pending, onClick: () => form.requestSubmit() });
    form.append(save);
    form.addEventListener("input", () => { this.detailDirty = true; });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      void this.mutateIssue(number, () => this.services.api.request<unknown>(`/api/issues/${number}`, { method: "PATCH", body: JSON.stringify({ title: title.value.trim(), body: body.value }) }), "Issue details saved.", false, true);
    });
    const summary = el("section", { className: "detail-section" }, el("h3", { text: "Summary" }), el("dl", { className: "detail-list" }, term("GitHub state", issueState(task)), term("Status", statusOf(task) ?? "Unclassified"), term("Author", task.author ? `@${task.author.login}` : "Unknown"), term("Updated", relativeTime(task.updatedAt))), externalLink("Open in GitHub ↗", task.url, "button secondary"));
    const move = button("Move to…", { disabled: pending, onClick: (event) => this.openMoveMenu(number, event.currentTarget as HTMLElement) });
    const assignment = button("Edit assignees", { disabled: pending || Boolean(this.metadataError), title: this.metadataError, onClick: (event) => void this.editAssignees(task, event.currentTarget as HTMLElement) });
    const milestone = button("Set milestone", { disabled: pending || Boolean(this.metadataError), title: this.metadataError, onClick: (event) => void this.editMilestone(task, event.currentTarget as HTMLElement) });
    const management = el("section", { className: "detail-section" }, el("h3", { text: "Workflow and ownership" }), el("div", { className: "detail-actions" }, move, assignment, milestone), el("p", { className: "detail-copy", text: `Assignees: ${users(task).length ? users(task).map(({ login }) => `@${login}`).join(", ") : "Unassigned"}` }), el("p", { className: "detail-copy", text: `Milestone: ${task.milestone?.title ?? "None"}` }));
    const relations = el("section", { className: "detail-section" }, el("h3", { text: "Relations" }));
    relations.append(this.relationGroup("Parent", detail.parent ? [detail.parent] : [], "sub-issues", number, true), this.relationGroup("Sub-issues", detail.subIssues, "sub-issues", number), this.relationGroup("Blocked by", detail.blockedBy, "blocked-by", number), this.relationGroup("Blocks", detail.blocking, "blocked-by", number, true));
    const addRelation = button("Add relation", { disabled: pending, onClick: (event) => void this.addRelation(number, event.currentTarget as HTMLElement) });
    relations.append(addRelation);
    const linked = el("section", { className: "detail-section" }, el("h3", { text: "Linked pull requests" }));
    if (!detail.linkedPullRequests.length) linked.append(el("p", { className: "muted", text: "No linked pull requests were reported." }));
    else for (const item of detail.linkedPullRequests as Array<{ number: number; title: string; url: string }>) linked.append(el("p", {}, externalLink(`#${item.number} ${item.title}`, item.url)));
    handle.body.append(summary, form, management, relations, linked);
  }

  private relationGroup(label: string, items: readonly TaskSummary[], endpoint: "sub-issues" | "blocked-by", issueNumber: number, reverse = false): HTMLElement {
    const group = el("div", { className: "relation-group" }, el("h4", { text: label }));
    if (!items.length) group.append(el("p", { className: "muted", text: `No ${label.toLowerCase()} reported.` }));
    for (const item of items) group.append(el("div", { className: "relation-row" }, button(`#${item.number} ${taskTitle(item)}`, { className: "table-title", onClick: () => this.services.router.updateQuery((query) => query.set("issue", String(item.number))) }), button("Remove", { className: "button compact", onClick: () => void this.removeRelation(reverse ? item.number : issueNumber, endpoint, reverse ? issueNumber : item.number) })));
    return group;
  }

  private async addRelation(issueNumber: number, trigger: HTMLElement): Promise<void> {
    const type = await openPicker(this.services.overlays, { title: "Choose relation type", label: "Relation", options: [
      { value: "sub-issues", label: "Sub-issue", description: "This issue will be the parent of the selected issue." },
      { value: "parent", label: "Parent", description: "The selected issue will be the parent of this issue." },
      { value: "blocked-by", label: "Blocked by", description: "This issue cannot proceed until the selected issue is resolved." },
      { value: "blocks", label: "Blocks", description: "The selected issue cannot proceed until this issue is resolved." },
    ], selected: [], returnFocus: trigger });
    if (!type?.[0]) return;
    const candidates: PickerOption[] = this.tasks.filter((task) => task.number !== issueNumber).map((task) => ({ value: String(task.number), label: `#${task.number} ${taskTitle(task)}` }));
    const target = await openPicker(this.services.overlays, { title: "Choose issue", label: "Issue", options: candidates, selected: [], returnFocus: trigger });
    if (!target?.[0]) return;
    const targetNumber = Number(target[0]);
    const reverse = type[0] === "parent" || type[0] === "blocks";
    const endpoint = type[0] === "sub-issues" || type[0] === "parent" ? "sub-issues" : "blocked-by";
    const pathNumber = reverse ? targetNumber : issueNumber;
    const relatedNumber = reverse ? issueNumber : targetNumber;
    await this.mutateIssue(issueNumber, () => this.services.api.request<unknown>(`/api/issues/${pathNumber}/${endpoint}`, { method: "POST", body: JSON.stringify({ issueNumber: relatedNumber }) }), "Relation added.", true);
  }

  private async removeRelation(issueNumber: number, endpoint: "sub-issues" | "blocked-by", relatedNumber: number): Promise<void> {
    await this.mutateIssue(issueNumber, () => this.services.api.request<unknown>(`/api/issues/${issueNumber}/${endpoint}`, { method: "DELETE", body: JSON.stringify({ issueNumber: relatedNumber }) }), "Relation removed.", true);
  }

  private async editAssignees(task: TaskSummary, trigger: HTMLElement): Promise<void> {
    const selected = users(task).map(({ login }) => login);
    const next = await openPicker(this.services.overlays, { title: `Assignees for #${task.number}`, label: "Assignees", multiple: true, options: this.assignees.map((user) => ({ value: user.login, label: `@${user.login}` })), selected, disabledReason: this.metadataError, returnFocus: trigger });
    if (!next) return;
    if (selected.length === next.length && selected.every((login) => next.includes(login))) {
      this.services.announce("Assignees remain unchanged.");
      return;
    }
    await this.mutateIssue(task.number, async () => {
      let result: unknown = { task };
      for (const login of selected.filter((login) => !next.includes(login))) result = await this.services.api.request(`/api/issues/${task.number}/assignees`, { method: "DELETE", body: JSON.stringify({ login }) });
      for (const login of next.filter((login) => !selected.includes(login))) result = await this.services.api.request(`/api/issues/${task.number}/assignees`, { method: "POST", body: JSON.stringify({ login }) });
      return result;
    }, "Assignees updated.");
  }

  private async editMilestone(task: TaskSummary, trigger: HTMLElement): Promise<void> {
    const next = await openPicker(this.services.overlays, { title: `Milestone for #${task.number}`, label: "Milestone", allowNone: true, noneLabel: "No milestone", options: this.milestones.map((item) => ({ value: String(item.number), label: item.title, description: item.state === "closed" ? "Closed milestone" : "Open milestone" })), selected: task.milestone ? [String(task.milestone.number)] : [], disabledReason: this.metadataError, returnFocus: trigger });
    if (!next) return;
    if ((task.milestone ? String(task.milestone.number) : "") === (next[0] ?? "")) {
      this.services.announce("Milestone remains unchanged.");
      return;
    }
    await this.mutateIssue(task.number, () => this.services.api.request<unknown>(`/api/issues/${task.number}`, { method: "PATCH", body: JSON.stringify({ milestone: next[0] ? Number(next[0]) : null }) }), "Milestone updated.");
  }

  private async mutateIssue(number: number, mutation: () => Promise<unknown>, success: string, reloadDetail = false, clearsDirty = false): Promise<void> {
    const handle = this.detailHandle;
    handle?.setBusy(true);
    try {
      const payload = await this.services.mutations.run(`issue:${number}`, mutation);
      const response = payload as TaskResponse;
      if (response.task) this.upsert(response.task);
      if (clearsDirty) this.detailDirty = false;
      this.services.toasts.show(success, { tone: "success" });
      this.services.api.invalidate("tasks");
      if (this.abort.signal.aborted) return;
      if (reloadDetail || !response.task) await this.loadDetail(number);
      else this.renderDetail();
      if (!this.abort.signal.aborted) this.render();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      handle?.setError(apiErrorDescription(error));
      this.services.toasts.show(apiErrorDescription(error), { tone: "error" });
    } finally {
      handle?.setBusy(false);
    }
  }
}

function parseFilters(route: AppRoute): TaskFilters {
  const view = route.query.get("view") === "list" ? "list" : "board";
  const state = route.query.get("state");
  const sort = route.query.get("sort") ?? "updated-desc";
  return {
    view,
    state: state === "closed" || state === "all" ? state : "open",
    query: route.query.get("q") ?? "",
    statuses: route.query.getAll("status").filter((value) => value === "unclassified" || WORKFLOW_STATUSES.includes(value as WorkflowStatus)),
    assignees: route.query.getAll("assignee"),
    milestones: route.query.getAll("milestone"),
    labels: route.query.getAll("label"),
    sort: ["updated-desc", "updated-asc", "created-desc", "created-asc", "title-asc", "title-desc"].includes(sort) ? sort : "updated-desc",
  };
}

function field(label: string, control: HTMLElement): HTMLLabelElement {
  return el("label", { className: "field" }, el("span", { text: label }), control);
}

function term(label: string, value: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(el("dt", { text: label }), el("dd", { text: value }));
  return fragment;
}
