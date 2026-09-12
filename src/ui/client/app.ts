interface StatusDefinition {
  name: string;
  slug: string;
  color: string;
}

interface BoardTask {
  number: number;
  status: string | null;
  title: string;
  fullTitle: string;
  body: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  assignees: string[];
  url: string;
}

interface BoardPayload {
  repository: string;
  state: "open" | "closed" | "all";
  scope: string;
  complete: boolean;
  statuses: StatusDefinition[];
  tasks: BoardTask[];
}

interface ErrorPayload {
  error?: {
    message?: string;
    retryable?: boolean;
    stateVerified?: boolean;
  };
  task?: BoardTask;
  repair?: {
    issueNumber: number;
    status: string;
  };
  recovery?: {
    kind: "ambiguous-create";
    title: string;
    issuesUrl: string;
  };
}

class ApiRequestError extends Error {
  readonly payload: ErrorPayload;

  constructor(message: string, payload: ErrorPayload = {}) {
    super(message);
    this.name = "ApiRequestError";
    this.payload = payload;
  }
}

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`Missing UI element: ${id}`);
  }
  return node as T;
}

const csrfMeta = document.querySelector<HTMLMetaElement>('meta[name="gitasks-csrf"]')?.content;
if (!csrfMeta) {
  throw new Error("Missing Gitasks CSRF token.");
}
const csrfToken: string = csrfMeta;

const board = element<HTMLDivElement>("board");
const loadingState = element<HTMLElement>("loading-state");
const searchEmpty = element<HTMLElement>("search-empty");
const repositoryText = element<HTMLElement>("repository");
const scopeText = element<HTMLElement>("scope-text");
const statusMessage = element<HTMLElement>("status-message");
const stateFilter = element<HTMLSelectElement>("state-filter");
const refreshTime = element<HTMLTimeElement>("refresh-time");
const unclassifiedPanel = element<HTMLElement>("unclassified-panel");
const unclassifiedList = element<HTMLElement>("unclassified-list");
const unclassifiedCount = element<HTMLElement>("unclassified-count");
const refreshButton = element<HTMLButtonElement>("refresh-button");
const searchInput = element<HTMLInputElement>("search-input");
const connectionError = element<HTMLElement>("connection-error");
const connectionErrorMessage = element<HTMLElement>("connection-error-message");
const createDialog = element<HTMLDialogElement>("create-dialog");
const createForm = element<HTMLFormElement>("create-form");
const createSubmit = element<HTMLButtonElement>("create-submit");
const createError = element<HTMLElement>("create-error");
const taskStatusSelect = element<HTMLSelectElement>("task-status");
const detailDialog = element<HTMLDialogElement>("detail-dialog");
const detailNumber = element<HTMLElement>("detail-number");
const detailTitle = element<HTMLElement>("detail-title");
const detailContent = element<HTMLElement>("detail-content");
const toast = element<HTMLElement>("toast");
const toastMessage = element<HTMLElement>("toast-message");
const toastRetry = element<HTMLButtonElement>("toast-retry");
const toastTitle = element<HTMLElement>("toast-title");

let statuses: StatusDefinition[] = [];
let tasks: BoardTask[] = [];
let scope = "";
let stateScope: "open" | "closed" | "all" = "open";
let selectedIssue: number | undefined;
const pendingIssues = new Set<number>();
let retryAction: (() => void) | undefined;

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (init?.method !== undefined && init.method !== "GET") {
    headers.set("X-Gitasks-CSRF", csrfToken);
  }

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (error) {
    throw new ApiRequestError(
      error instanceof Error ? error.message : "Could not reach the local Gitasks server.",
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiRequestError(`The local server returned HTTP ${response.status}.`);
  }
  if (!response.ok) {
    const errorPayload = payload as ErrorPayload;
    throw new ApiRequestError(
      errorPayload.error?.message ?? `Request failed with HTTP ${response.status}.`,
      errorPayload,
    );
  }
  return payload as T;
}

function makeStatusOptions(selected: string | null): HTMLOptionElement[] {
  const options = statuses.map((status) => {
    const option = document.createElement("option");
    option.value = status.name;
    option.textContent = status.name;
    option.selected = status.name === selected;
    return option;
  });
  if (selected === null) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Assign status…";
    placeholder.selected = true;
    placeholder.disabled = true;
    options.unshift(placeholder);
  }
  return options;
}

function statusColor(statusName: string | null): string {
  return `#${statuses.find(({ name }) => name === statusName)?.color ?? "667085"}`;
}

function upsertTask(task: BoardTask): void {
  const index = tasks.findIndex(({ number }) => number === task.number);
  if (index === -1) {
    tasks.unshift(task);
  } else {
    tasks[index] = task;
  }
}

function showError(message: string, retry?: () => void): void {
  toast.classList.remove("success");
  toastTitle.textContent = "Action failed";
  toastMessage.textContent = message;
  retryAction = retry;
  toastRetry.hidden = retry === undefined;
  const host = detailDialog.open ? detailDialog : createDialog.open ? createDialog : document.body;
  host.append(toast);
  toast.hidden = false;
}

function showSuccess(message: string): void {
  toast.classList.add("success");
  toastTitle.textContent = "Success";
  toastMessage.textContent = message;
  retryAction = undefined;
  toastRetry.hidden = true;
  document.body.append(toast);
  toast.hidden = false;
}

function closeToast(): void {
  toast.hidden = true;
  retryAction = undefined;
  if (toast.parentElement !== document.body) {
    document.body.append(toast);
  }
}

function createLabelList(labels: string[]): HTMLElement {
  const list = document.createElement("div");
  list.className = "label-list";
  for (const label of labels) {
    const chip = document.createElement("span");
    chip.className = "label-chip";
    chip.textContent = label;
    list.append(chip);
  }
  return list;
}

function setIssuePending(issueNumber: number, pending: boolean): void {
  const card = document.querySelector<HTMLElement>(`[data-issue="${issueNumber}"]`);
  card?.classList.toggle("is-pending", pending);
  for (const control of card?.querySelectorAll<HTMLButtonElement | HTMLSelectElement>("button, select") ?? []) {
    control.disabled = pending;
  }
  if (selectedIssue === issueNumber) {
    detailContent.querySelector<HTMLSelectElement>("#detail-status-select")?.toggleAttribute("disabled", pending);
  }
}

function createTaskCard(task: BoardTask): HTMLElement {
  const card = document.createElement("article");
  card.className = "task-card";
  card.dataset.issue = String(task.number);
  card.style.setProperty("--status-color", statusColor(task.status));
  const pending = pendingIssues.has(task.number);
  card.classList.toggle("is-pending", pending);

  const topline = document.createElement("div");
  topline.className = "card-topline";
  const number = document.createElement("span");
  number.className = "issue-number";
  number.textContent = `#${task.number}`;
  const state = document.createElement("span");
  state.className = `state-badge ${task.state === "CLOSED" ? "closed" : ""}`;
  state.textContent = task.state;
  topline.append(number, state);

  const title = document.createElement("button");
  title.className = "card-title-button";
  title.type = "button";
  title.disabled = pending;
  title.textContent = task.title || "Untitled task";
  title.addEventListener("click", () => {
    void openDetails(task.number);
  });

  card.append(topline, title);
  if (task.assignees.length > 0) {
    const assignee = document.createElement("p");
    assignee.className = "assignee";
    assignee.textContent = `Assigned to ${task.assignees.map((name) => `@${name}`).join(", ")}`;
    card.append(assignee);
  }
  if (task.labels.length > 0) {
    card.append(createLabelList(task.labels));
  }

  const footer = document.createElement("div");
  footer.className = "card-footer";
  const statusLabel = document.createElement("label");
  statusLabel.textContent = "Move to";
  const select = document.createElement("select");
  select.setAttribute("aria-label", `Change status for issue #${task.number}`);
  select.disabled = pending;
  select.append(...makeStatusOptions(task.status));
  select.addEventListener("change", () => {
    void changeStatus(task.number, select.value);
  });
  statusLabel.append(select);
  const link = document.createElement("a");
  link.className = "github-link";
  link.href = task.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "Open in GitHub ↗";
  footer.append(statusLabel, link);
  card.append(footer);
  return card;
}

function filteredTasks(): BoardTask[] {
  const stateTasks = tasks.filter(
    (task) =>
      stateScope === "all" ||
      task.state.toLowerCase() === stateScope,
  );
  const query = searchInput.value.trim().toLowerCase();
  if (query.length === 0) {
    return stateTasks;
  }
  const issueQuery = query.startsWith("#") ? query.slice(1) : query;
  return stateTasks.filter(
    (task) =>
      task.title.toLowerCase().includes(query) ||
      task.fullTitle.toLowerCase().includes(query) ||
      String(task.number) === issueQuery,
  );
}

function renderBoard(): void {
  const visibleTasks = filteredTasks();
  board.replaceChildren();
  for (const status of statuses) {
    const column = document.createElement("section");
    column.className = "column";
    column.style.setProperty("--status-color", `#${status.color}`);
    column.setAttribute("aria-labelledby", `column-${status.slug}`);

    const header = document.createElement("header");
    header.className = "column-header";
    const title = document.createElement("div");
    title.className = "column-title";
    const dot = document.createElement("span");
    dot.className = "status-dot";
    dot.setAttribute("aria-hidden", "true");
    const heading = document.createElement("h2");
    heading.id = `column-${status.slug}`;
    heading.textContent = status.name;
    title.append(dot, heading);

    const columnTasks = visibleTasks.filter((task) => task.status === status.name);
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(columnTasks.length);
    header.append(title, count);

    const list = document.createElement("div");
    list.className = "card-list";
    if (columnTasks.length === 0) {
      const empty = document.createElement("p");
      empty.className = "column-empty";
      empty.textContent = searchInput.value.trim() ? "No matches" : "No tasks";
      list.append(empty);
    } else {
      list.append(...columnTasks.map(createTaskCard));
    }
    column.append(header, list);
    board.append(column);
  }
  const unclassifiedTasks = visibleTasks.filter((task) => task.status === null);
  unclassifiedCount.textContent = String(unclassifiedTasks.length);
  unclassifiedList.replaceChildren();
  if (unclassifiedTasks.length === 0) {
    const empty = document.createElement("p");
    empty.className = "column-empty";
    empty.textContent = searchInput.value.trim() ? "No matches" : "No unclassified issues";
    unclassifiedList.append(empty);
  } else {
    unclassifiedList.append(...unclassifiedTasks.map(createTaskCard));
  }
  unclassifiedPanel.hidden = false;

  searchEmpty.hidden = searchInput.value.trim().length === 0 || visibleTasks.length > 0;
  scopeText.textContent = `${scope} · ${tasks.length} issue${tasks.length === 1 ? "" : "s"}`;
}

function renderDetail(task: BoardTask): void {
  detailNumber.textContent = `Issue #${task.number}`;
  detailTitle.textContent = task.fullTitle;
  detailContent.replaceChildren();

  const overview = document.createElement("section");
  overview.className = "detail-section";
  const overviewTitle = document.createElement("h3");
  overviewTitle.textContent = "Overview";
  overview.append(overviewTitle);
  const rows: Array<[string, string]> = [
    ["Task status", task.status ?? "Unclassified"],
    ["GitHub state", task.state],
    ["Assignee", task.assignees.length > 0 ? task.assignees.map((name) => `@${name}`).join(", ") : "Unassigned"],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    row.className = "detail-row";
    const key = document.createElement("span");
    key.textContent = label;
    const text = document.createElement("strong");
    text.textContent = value;
    row.append(key, text);
    overview.append(row);
  }

  const description = document.createElement("section");
  description.className = "detail-section";
  const descriptionTitle = document.createElement("h3");
  descriptionTitle.textContent = "Description";
  const body = document.createElement("p");
  body.className = "detail-body";
  body.textContent = task.body.trim() || "No description provided.";
  description.append(descriptionTitle, body);

  const labels = document.createElement("section");
  labels.className = "detail-section";
  const labelsTitle = document.createElement("h3");
  labelsTitle.textContent = "Labels";
  labels.append(labelsTitle);
  labels.append(task.labels.length > 0 ? createLabelList(task.labels) : document.createTextNode("No additional labels."));

  const statusControl = document.createElement("section");
  statusControl.className = "detail-status";
  const statusLabel = document.createElement("label");
  statusLabel.htmlFor = "detail-status-select";
  statusLabel.textContent = "Change task status";
  const select = document.createElement("select");
  select.id = "detail-status-select";
  select.disabled = pendingIssues.has(task.number);
  select.append(...makeStatusOptions(task.status));
  select.addEventListener("change", () => {
    void changeStatus(task.number, select.value);
  });
  statusControl.append(statusLabel, select);

  const link = document.createElement("a");
  link.className = "button secondary detail-link";
  link.href = task.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "Open in GitHub ↗";

  detailContent.append(overview, description, labels, statusControl, link);
}

async function openDetails(issueNumber: number): Promise<void> {
  selectedIssue = issueNumber;
  const localTask = tasks.find(({ number }) => number === issueNumber);
  if (localTask !== undefined) {
    renderDetail(localTask);
  }
  if (!detailDialog.open) {
    detailDialog.showModal();
    detailDialog.querySelector<HTMLButtonElement>(".icon-button")?.focus();
  }
  try {
    const { task } = await apiRequest<{ task: BoardTask }>(`/api/issues/${issueNumber}`);
    upsertTask(task);
    if (selectedIssue === issueNumber && detailDialog.open) {
      renderDetail(task);
    }
  } catch (error) {
    showError(error instanceof Error ? error.message : "Could not load issue details.", () => {
      void openDetails(issueNumber);
    });
  }
}

async function changeStatus(issueNumber: number, status: string): Promise<void> {
  if (pendingIssues.has(issueNumber)) {
    return;
  }
  const startedInDetail = selectedIssue === issueNumber && detailDialog.open;
  let succeeded = false;
  pendingIssues.add(issueNumber);
  setIssuePending(issueNumber, true);

  try {
    const { task } = await apiRequest<{ task: BoardTask }>(
      `/api/issues/${issueNumber}/status`,
      { method: "POST", body: JSON.stringify({ status }) },
    );
    upsertTask(task);
    succeeded = true;
  } catch (error) {
    if (error instanceof ApiRequestError && error.payload.task !== undefined) {
      upsertTask(error.payload.task);
    }
    const unverified = error instanceof ApiRequestError && error.payload.error?.stateVerified === false;
    const message = `${error instanceof Error ? error.message : "Status change failed."}${unverified ? " The issue state could not be verified; refresh before continuing." : ""}`;
    showError(message, () => {
      void changeStatus(issueNumber, status);
    });
  } finally {
    pendingIssues.delete(issueNumber);
    renderBoard();
    const current = tasks.find(({ number }) => number === issueNumber);
    if (selectedIssue === issueNumber && current !== undefined && detailDialog.open) {
      renderDetail(current);
      if (startedInDetail) {
        detailContent.querySelector<HTMLSelectElement>("#detail-status-select")?.focus();
      }
    } else {
      document.querySelector<HTMLButtonElement>(`[data-issue="${issueNumber}"] .card-title-button`)?.focus();
    }
    if (succeeded) {
      statusMessage.textContent = `Issue #${issueNumber} moved to ${status}.`;
      const current = tasks.find(({ number }) => number === issueNumber);
      if (status === "DONE" && current?.state === "CLOSED" && stateScope === "open") {
        showSuccess(`Issue #${issueNumber} moved to DONE and closed. It is hidden by the Open filter.`);
      }
    }
  }
}

async function loadBoard(): Promise<void> {
  refreshButton.disabled = true;
  stateFilter.disabled = true;
  connectionError.hidden = true;
  if (tasks.length === 0) {
    loadingState.hidden = false;
    board.hidden = true;
    unclassifiedPanel.hidden = true;
  }
  try {
    const requestedState = stateFilter.value;
    const payload = await apiRequest<BoardPayload>(
      `/api/board?state=${encodeURIComponent(requestedState)}`,
    );
    statuses = payload.statuses;
    tasks = payload.tasks;
    scope = payload.scope;
    stateScope = payload.state;
    stateFilter.value = payload.state;
    repositoryText.textContent = payload.repository;
    const refreshed = new Date();
    refreshTime.dateTime = refreshed.toISOString();
    refreshTime.textContent = refreshed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    taskStatusSelect.replaceChildren(...makeStatusOptions(statuses[0]?.name ?? "BACKLOG"));
    board.hidden = false;
    loadingState.hidden = true;
    renderBoard();
  } catch (error) {
    loadingState.hidden = true;
    if (tasks.length === 0) {
      board.hidden = true;
      unclassifiedPanel.hidden = true;
    }
    connectionErrorMessage.textContent = error instanceof Error ? error.message : "Could not read GitHub Issues.";
    connectionError.hidden = false;
  } finally {
    refreshButton.disabled = false;
    stateFilter.disabled = false;
  }
}

async function submitCreate(): Promise<void> {
  if (!createForm.reportValidity()) {
    return;
  }
  const formData = new FormData(createForm);
  const input = {
    title: String(formData.get("title") ?? "").trim(),
    body: String(formData.get("body") ?? ""),
    status: String(formData.get("status") ?? "BACKLOG"),
  };
  createSubmit.disabled = true;
  createSubmit.textContent = "Creating…";
  createError.hidden = true;
  try {
    const { task } = await apiRequest<{ task: BoardTask }>("/api/issues", {
      method: "POST",
      body: JSON.stringify(input),
    });
    upsertTask(task);
    renderBoard();
    createDialog.close();
    createForm.reset();
    taskStatusSelect.value = statuses[0]?.name ?? "BACKLOG";
  } catch (error) {
    const message = error instanceof Error ? error.message : "Task creation failed.";
    if (
      error instanceof ApiRequestError &&
      error.payload.task !== undefined &&
      error.payload.repair !== undefined
    ) {
      const { task, repair } = error.payload;
      upsertTask(task);
      renderBoard();
      createDialog.close();
      createForm.reset();
      taskStatusSelect.value = statuses[0]?.name ?? "BACKLOG";
      showError(message, () => {
        void changeStatus(repair.issueNumber, repair.status);
      });
    } else {
      createError.textContent = message;
      createError.hidden = false;
      const retryable =
        !(error instanceof ApiRequestError) ||
        error.payload.error?.retryable !== false;
      showError(message, retryable ? () => {
        void submitCreate();
      } : undefined);
    }
  } finally {
    createSubmit.disabled = false;
    createSubmit.textContent = "Create task";
  }
}

refreshButton.addEventListener("click", () => {
  void loadBoard();
});
stateFilter.addEventListener("change", () => {
  void loadBoard();
});
element<HTMLButtonElement>("connection-retry").addEventListener("click", () => {
  void loadBoard();
});
element<HTMLButtonElement>("new-task-button").addEventListener("click", () => {
  createError.hidden = true;
  createDialog.showModal();
});
searchInput.addEventListener("input", renderBoard);
createForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitCreate();
});

for (const closeButton of document.querySelectorAll<HTMLButtonElement>("[data-close]")) {
  closeButton.addEventListener("click", () => {
    const dialogId = closeButton.dataset.close;
    if (dialogId !== undefined) {
      element<HTMLDialogElement>(dialogId).close();
    }
  });
}
for (const dialog of [createDialog, detailDialog]) {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      dialog.close();
    }
  });
}
detailDialog.addEventListener("close", () => {
  const issueNumber = selectedIssue;
  selectedIssue = undefined;
  if (toast.parentElement === detailDialog) {
    closeToast();
  }
  renderBoard();
  if (issueNumber !== undefined) {
    window.setTimeout(() => {
      board.querySelector<HTMLButtonElement>(`[data-issue="${issueNumber}"] .card-title-button`)?.focus();
    }, 0);
  }
});
createDialog.addEventListener("close", () => {
  if (toast.parentElement === createDialog) {
    closeToast();
  }
});
toastRetry.addEventListener("click", () => {
  const retry = retryAction;
  closeToast();
  retry?.();
});
element<HTMLButtonElement>("toast-dismiss").addEventListener("click", closeToast);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeToast();
    if (detailDialog.open) {
      detailDialog.close();
    } else if (createDialog.open) {
      createDialog.close();
    }
  }
});

void loadBoard();
