import { ApiRequestError, apiErrorDescription } from "../api.js";
import { checkboxGroup, chipBar, filterDetails, searchField, segmented, selectField, type FilterChip } from "../components/filters.js";
import { confirmation, confirmDiscard, type DialogHandle } from "../components/overlays.js";
import { openPicker } from "../components/picker.js";
import { avatar, avatarGroup, badge, button, el, externalLink, labelList, pageHeader, relativeTime, statePanel, timeElement } from "../components/primitives.js";
import type { BranchSummary, ListPage, MilestoneSummary, PullRequestDetail, PullRequestSummary, UserSummary } from "../models.js";
import type { AppRoute } from "../router.js";
import { numericQuery } from "../router.js";
import type { AppServices, ViewController } from "../services.js";

interface PullMutation { pullRequest?: PullRequestSummary; detail?: PullRequestDetail }
interface PullDetailResponse { detail?: PullRequestDetail }

function pullState(pull: PullRequestSummary): "open" | "closed" | "merged" {
  if (pull.mergedAt) return "merged";
  return pull.state;
}

function reviewLabel(value: unknown): { text: string; tone: "neutral" | "success" | "warning" | "danger" } {
  const state = typeof value === "string" ? value.toLowerCase() : "unknown";
  if (state.includes("approved")) return { text: "Approved", tone: "success" };
  if (state.includes("change")) return { text: "Changes requested", tone: "danger" };
  if (state.includes("review")) return { text: "Review pending", tone: "warning" };
  return { text: "Review state unknown", tone: "neutral" };
}

function checksLabel(value: unknown): { text: string; tone: "neutral" | "success" | "warning" | "danger" } {
  const state = typeof value === "string" ? value.toLowerCase() : "unknown";
  if (state === "success" || state === "passing") return { text: "Checks passing", tone: "success" };
  if (state.includes("fail") || state === "error") return { text: "Checks failing", tone: "danger" };
  if (state.includes("pending") || state.includes("progress")) return { text: "Checks pending", tone: "warning" };
  return { text: "Checks unknown", tone: "neutral" };
}

export class PullRequestsView implements ViewController {
  private readonly root: HTMLElement;
  private readonly services: AppServices;
  private route: AppRoute;
  private pulls: PullRequestSummary[] = [];
  private loading = true;
  private refreshing = false;
  private error: string | undefined;
  private complete = true;
  private hasNext = false;
  private nextPage: number | null = null;
  private knownTotal: number | null = null;
  private refreshedAt: Date | undefined;
  private detailHandle: DialogHandle | undefined;
  private detailNumber: number | undefined;
  private detail: PullRequestDetail | undefined;
  private detailError: string | undefined;
  private detailDirty = false;
  private branches: BranchSummary[] = [];
  private assignees: UserSummary[] = [];
  private milestones: MilestoneSummary[] = [];
  private metadataError: string | undefined;
  private readonly abort = new AbortController();

  constructor(root: HTMLElement, services: AppServices, route: AppRoute) {
    this.root = root;
    this.services = services;
    this.route = route;
    void this.load(true);
  }

  update(route: AppRoute): void {
    const previousState = this.state();
    this.route = route;
    if (previousState !== this.state()) void this.load(true);
    else this.render();
  }

  dispose(): void {
    this.abort.abort();
    this.detailHandle?.close("route", true);
  }

  private state(): "open" | "closed" | "merged" | "all" {
    const value = this.route.query.get("state");
    return value === "closed" || value === "merged" || value === "all" ? value : "open";
  }

  private async load(initial: boolean): Promise<void> {
    this.loading = initial && !this.pulls.length;
    this.refreshing = !this.loading;
    this.error = undefined;
    this.render();
    try {
      const result = await this.services.api.latest<ListPage<PullRequestSummary>>("pulls", `/api/pulls?state=${this.state()}&page=1`, { signal: this.abort.signal });
      if (!result.current) return;
      this.pulls = result.data.items;
      this.complete = result.data.complete;
      this.hasNext = result.data.hasNext;
      this.nextPage = result.data.nextPage;
      this.knownTotal = result.data.knownTotal;
      this.refreshedAt = new Date();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) this.error = apiErrorDescription(error);
    } finally {
      this.loading = false;
      this.refreshing = false;
      if (!this.abort.signal.aborted) this.render();
    }
  }

  private filtered(): PullRequestSummary[] {
    const query = this.route.query.get("q")?.trim().toLowerCase() ?? "";
    const author = this.route.query.get("author")?.trim().toLowerCase() ?? "";
    const assignee = this.route.query.get("assignee") ?? "";
    const current = this.services.context.currentUser?.login;
    const sort = this.route.query.get("sort") ?? "updated-desc";
    const [field, direction] = sort.split("-");
    const multiplier = direction === "asc" ? 1 : -1;
    return this.pulls.filter((pull) => {
      const numeric = query.startsWith("#") ? query.slice(1) : query;
      if (query && !pull.title.toLowerCase().includes(query) && String(pull.number) !== numeric) return false;
      if (author && !pull.author?.login.toLowerCase().includes(author)) return false;
      const logins = pull.assignees.map(({ login }) => login);
      if (assignee === "me" && (!current || !logins.includes(current))) return false;
      if (assignee === "unassigned" && logins.length) return false;
      if (assignee && assignee !== "me" && assignee !== "unassigned" && !logins.includes(assignee)) return false;
      return true;
    }).sort((left, right) => {
      if (field === "title") return left.title.localeCompare(right.title) * multiplier;
      const leftValue = new Date(field === "created" ? left.createdAt : left.updatedAt).getTime() || 0;
      const rightValue = new Date(field === "created" ? right.createdAt : right.updatedAt).getTime() || 0;
      return (leftValue - rightValue || left.number - right.number) * multiplier;
    });
  }

  private render(): void {
    const refresh = button(this.refreshing ? "Refreshing…" : "Refresh", { disabled: this.refreshing, onClick: () => void this.load(false) });
    const create = button("New pull request", { className: "button primary", onClick: (event) => void this.openCreate(event.currentTarget as HTMLElement) });
    const page = el("div", { className: "page page-wide" }, pageHeader("Pull Requests", this.services.context.repository, [refresh, create]), this.filters());
    if (this.refreshedAt) page.append(el("p", { className: "scope-line", text: `${this.filtered().length} loaded pull request${this.filtered().length === 1 ? "" : "s"} match${this.knownTotal !== null ? ` · ${this.knownTotal} known total` : ""}${this.hasNext ? " · more results available" : ""} · refreshed ${relativeTime(this.refreshedAt.toISOString())}` }));
    if (!this.complete) page.append(statePanel("partial", "Partial pull requests", "More pull requests are available on GitHub. Filters apply to loaded rows only."));
    if (this.error) page.append(statePanel("error", "Pull requests could not be loaded", this.error, button("Retry", { onClick: () => void this.load(!this.pulls.length) })));
    if (this.loading) page.append(statePanel("loading", "Loading pull requests", "Reading pull request summaries from GitHub…"));
    else if (!this.pulls.length && !this.error) page.append(statePanel("empty", "No pull requests in this state", "Create a pull request from an existing pushed branch.", button("New pull request", { className: "button primary", onClick: (event) => void this.openCreate(event.currentTarget as HTMLElement) })));
    else if (!this.filtered().length) page.append(statePanel("empty", "No pull requests match", "Clear filters to see loaded pull requests.", button("Clear filters", { onClick: () => this.services.router.navigate("/pull-requests") })));
    else page.append(this.table());
    if (this.hasNext && this.nextPage) page.append(button("Load more pull requests", { className: "button secondary load-more", onClick: (event) => void this.loadMore(event.currentTarget as HTMLButtonElement) }));
    this.root.replaceChildren(page);
    this.syncDetail();
  }

  private filters(): HTMLElement {
    const query = this.route.query.get("q") ?? "";
    const author = this.route.query.get("author") ?? "";
    const assignee = this.route.query.get("assignee") ?? "";
    const sort = this.route.query.get("sort") ?? "updated-desc";
    const assigneeOptions = [{ value: "", label: "Any assignee" }, { value: "me", label: "Assigned to me" }, { value: "unassigned", label: "Unassigned" }, ...[...new Set(this.pulls.flatMap((pull) => pull.assignees.map(({ login }) => login)))].map((login) => ({ value: login, label: `@${login}` }))];
    const advanced = el("div", { className: "filter-grid" }, searchField(author, "Filter by author", (value) => this.services.router.updateQuery((params) => value.trim() ? params.set("author", value.trim()) : params.delete("author"), { replace: true })), selectField("Assignee", assignee, assigneeOptions, (value) => this.services.router.updateQuery((params) => value ? params.set("assignee", value) : params.delete("assignee"))), selectField("Sort", sort, [{ value: "updated-desc", label: "Recently updated" }, { value: "updated-asc", label: "Least recently updated" }, { value: "created-desc", label: "Newest created" }, { value: "created-asc", label: "Oldest created" }, { value: "title-asc", label: "Title A–Z" }], (value) => this.services.router.updateQuery((params) => value === "updated-desc" ? params.delete("sort") : params.set("sort", value))));
    const bar = el("section", { className: "filter-bar", attrs: { "aria-label": "Pull request filters" } }, searchField(query, "Search title or #number", (value) => this.services.router.updateQuery((params) => value.trim() ? params.set("q", value) : params.delete("q"), { replace: true })), segmented("Pull request state", this.state(), [{ value: "open", label: "Open" }, { value: "closed", label: "Closed" }, { value: "merged", label: "Merged" }, { value: "all", label: "All" }], (value) => this.services.router.updateQuery((params) => value === "open" ? params.delete("state") : params.set("state", value))), filterDetails("Filters", Number(Boolean(author)) + Number(Boolean(assignee)) + Number(sort !== "updated-desc"), advanced));
    const chips: FilterChip[] = [];
    if (query) chips.push({ label: `Search: ${query}`, parameter: "q" });
    if (author) chips.push({ label: `Author: ${author}`, parameter: "author" });
    if (assignee) chips.push({ label: `Assignee: ${assignee}`, parameter: "assignee" });
    if (sort !== "updated-desc") chips.push({ label: `Sort: ${sort}`, parameter: "sort" });
    return el("div", { className: "filters-wrap" }, bar, chipBar(this.services.router, chips, () => this.services.router.navigate("/pull-requests")));
  }

  private table(): HTMLElement {
    const table = el("table", { className: "data-table pull-table" });
    table.append(el("thead", {}, el("tr", {}, ...["Pull request", "Author", "Assignees", "Branches", "Review", "Checks", "Updated", "Actions"].map((name) => el("th", { text: name, attrs: { scope: "col" } })))));
    const body = el("tbody");
    for (const pull of this.filtered()) {
      const review = reviewLabel(pull.reviewState);
      const checks = checksLabel(pull.checksState);
      body.append(el("tr", {},
        el("th", { attrs: { scope: "row", "data-label": "Pull request" } }, el("div", { className: "table-heading" }, pull.draft ? badge("Draft", "warning") : badge(pullState(pull), pullState(pull) === "open" ? "success" : "neutral"), button(`#${pull.number} ${pull.title}`, { className: "table-title", onClick: () => this.services.router.openDetail("pr", pull.number) }))),
        el("td", { attrs: { "data-label": "Author" } }, pull.author ? el("span", { className: "person" }, avatar(pull.author), `@${pull.author.login}`) : el("span", { className: "muted", text: "Unknown" })),
        el("td", { attrs: { "data-label": "Assignees" } }, avatarGroup(pull.assignees)),
        el("td", { attrs: { "data-label": "Branches" }, text: `${pull.head.ref} → ${pull.base.ref}` }),
        el("td", { attrs: { "data-label": "Review" } }, badge(review.text, review.tone)),
        el("td", { attrs: { "data-label": "Checks" } }, badge(checks.text, checks.tone)),
        el("td", { attrs: { "data-label": "Updated" }, text: relativeTime(pull.updatedAt) }),
        el("td", { attrs: { "data-label": "Actions" } }, externalLink("GitHub ↗", pull.url)),
      ));
    }
    table.append(body);
    return el("div", { className: "table-scroll", attrs: { tabindex: "0", "aria-label": "Pull request list" } }, table);
  }

  private async loadMore(trigger: HTMLButtonElement): Promise<void> {
    if (!this.nextPage) return;
    trigger.disabled = true;
    try {
      const page = this.nextPage;
      const payload = await this.services.api.request<ListPage<PullRequestSummary>>(`/api/pulls?state=${this.state()}&page=${page}`, { signal: this.abort.signal });
      const byNumber = new Map(this.pulls.map((pull) => [pull.number, pull]));
      for (const pull of payload.items) byNumber.set(pull.number, pull);
      this.pulls = [...byNumber.values()];
      this.hasNext = payload.hasNext;
      this.complete = payload.complete;
      this.nextPage = payload.nextPage;
      this.knownTotal = payload.knownTotal;
      this.services.announce(`${payload.items.length} more pull requests loaded.`);
      this.render();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.services.toasts.show(apiErrorDescription(error), { tone: "error", actionLabel: "Retry", action: () => void this.loadMore(trigger) });
      trigger.disabled = false;
    }
  }

  private async loadMetadata(): Promise<void> {
    if (this.branches.length || this.assignees.length || this.milestones.length || this.metadataError) return;
    try {
      const [branches, assignees, milestones] = await Promise.all([
        this.services.api.request<{ items: string[] }>("/api/branches", { signal: this.abort.signal }),
        this.services.api.request<{ items: UserSummary[] }>("/api/assignees", { signal: this.abort.signal }),
        this.services.api.request<ListPage<MilestoneSummary>>("/api/milestones?state=all", { signal: this.abort.signal }),
      ]);
      this.branches = branches.items.map((name) => ({ name }));
      this.assignees = assignees.items;
      this.milestones = milestones.items;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.metadataError = apiErrorDescription(error);
    }
  }

  private async openCreate(trigger: HTMLElement): Promise<void> {
    await this.loadMetadata();
    if (this.abort.signal.aborted) return;
    let dirty = false;
    const handle = this.services.overlays.open({ title: "Create pull request", eyebrow: this.services.context.repository, kind: "form", returnFocus: trigger, beforeClose: () => !dirty || confirmDiscard() });
    const form = el("form", { className: "form-grid" });
    const title = el("input", { attrs: { type: "text", required: "", maxlength: "256" } });
    const body = el("textarea", { attrs: { rows: "7" } });
    const head = el("select");
    const base = el("select");
    for (const branch of this.branches) {
      head.append(el("option", { text: branch.name, attrs: { value: branch.name } }));
      base.append(el("option", { text: branch.name, attrs: { value: branch.name } }));
    }
    if (this.branches.some(({ name }) => name === "main")) base.value = "main";
    const draft = el("input", { attrs: { type: "checkbox" } });
    form.append(field("Title", title), field("Description (plain text)", body), field("Head branch", head), field("Base branch", base), el("label", { className: "check-field" }, draft, el("span", { text: "Create as draft" })));
    if (this.metadataError || this.branches.length < 2) form.append(el("p", { className: "permission-note", text: this.metadataError ?? "At least two pushed branches are required to create a pull request." }));
    form.addEventListener("input", () => { dirty = true; });
    const cancel = button("Cancel", { onClick: () => handle.close("cancel") });
    cancel.dataset.cancel = "true";
    const submit = button("Create pull request", { className: "button primary", disabled: Boolean(this.metadataError) || this.branches.length < 2, title: this.metadataError, onClick: () => form.requestSubmit() });
    handle.body.append(form);
    handle.footer.append(cancel, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      if (head.value === base.value) {
        handle.setError("Head and base branches must be different.");
        return;
      }
      void (async () => {
        handle.setBusy(true, "Creating…");
        handle.setError();
        try {
          const payload = await this.services.api.request<PullMutation>("/api/pulls", { method: "POST", body: JSON.stringify({ title: title.value.trim(), body: body.value, head: head.value, base: base.value, draft: draft.checked }) });
          if (!payload.pullRequest) throw new Error("The server did not return the created pull request.");
          this.upsert(payload.pullRequest);
          dirty = false;
          handle.close("created", true);
          this.services.toasts.show(`Pull request #${payload.pullRequest.number} created.`, { tone: "success" });
          if (!this.abort.signal.aborted) this.render();
        } catch (error) {
          handle.setError(apiErrorDescription(error));
          handle.setBusy(false);
        }
      })();
    });
  }

  private syncDetail(): void {
    const number = numericQuery(this.route.query, "pr");
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
    const handle = this.services.overlays.open({ title: `Pull request #${number}`, eyebrow: "Pull request detail", kind: "drawer", beforeClose: () => !this.detailDirty || confirmDiscard(), onClose: (value) => {
      if (this.detailHandle === handle) this.detailHandle = undefined;
      if (value !== "route" && numericQuery(this.services.router.current().query, "pr") === number) this.services.router.closeDetail("pr");
    } });
    this.detailHandle = handle;
    handle.body.append(statePanel("loading", "Loading pull request", "Reading reviews, checks, files, and merge state from GitHub…"));
    void this.loadDetail(number);
  }

  private async loadDetail(number: number): Promise<void> {
    this.detailError = undefined;
    try {
      const result = await this.services.api.latest<PullDetailResponse | PullRequestDetail>(`pr:${number}:detail`, `/api/pulls/${number}`, { signal: this.abort.signal });
      if (!result.current || number !== this.detailNumber) return;
      this.detail = (result.data as PullDetailResponse).detail ?? result.data as PullRequestDetail;
      this.upsert(this.detail.pullRequest);
      await this.loadMetadata();
      if (this.abort.signal.aborted) return;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) this.detailError = apiErrorDescription(error);
    }
    this.renderDetail();
  }

  private renderDetail(): void {
    const handle = this.detailHandle;
    const number = this.detailNumber;
    if (!handle || !number) return;
    handle.body.replaceChildren();
    handle.footer.replaceChildren();
    if (this.detailError) {
      handle.body.append(statePanel("error", "Pull request could not be loaded", this.detailError, button("Retry", { onClick: () => void this.loadDetail(number) })));
      return;
    }
    if (!this.detail) {
      handle.body.append(statePanel("loading", "Loading pull request", "Reading GitHub details…"));
      return;
    }
    const detail = this.detail;
    const pull = detail.pullRequest;
    const pending = this.services.mutations.isPending(`pr:${number}`);
    const form = el("form", { className: "form-grid detail-edit" });
    const title = el("input", { attrs: { type: "text", required: "", maxlength: "256" } }); title.value = pull.title;
    const body = el("textarea", { attrs: { rows: "8" } }); body.value = pull.body;
    form.append(field("Title", title), field("Description (plain text)", body), button("Save title and description", { className: "button primary", disabled: pending, onClick: () => form.requestSubmit() }));
    form.addEventListener("input", () => { this.detailDirty = true; });
    form.addEventListener("submit", (event) => { event.preventDefault(); if (form.reportValidity()) void this.mutate(number, () => this.services.api.request<PullMutation>(`/api/pulls/${number}`, { method: "PATCH", body: JSON.stringify({ title: title.value.trim(), body: body.value }) }), "Pull request details saved.", false, true); });
    const review = reviewLabel(pull.reviewState);
    const checks = checksLabel(pull.checksState);
    const summary = el("section", { className: "detail-section" }, el("h3", { text: "Summary" }), el("p", { className: "detail-body", text: pull.body || "No description." }), el("dl", { className: "detail-list" }, term("State", pullState(pull)), term("Author", pull.author ? `@${pull.author.login}` : "Unknown"), term("Branches", `${pull.head.ref} → ${pull.base.ref}`), term("Head SHA", pull.head.sha), term("Updated", relativeTime(pull.updatedAt))), el("div", { className: "badge-row" }, pull.draft ? badge("Draft", "warning") : badge("Ready for review", "success"), badge(review.text, review.tone), badge(checks.text, checks.tone)), externalLink("Open in GitHub ↗", pull.url, "button secondary"));
    const actions = el("section", { className: "detail-section" }, el("h3", { text: "Actions" }), el("div", { className: "detail-actions" }, button(pullState(pull) === "open" ? "Close" : "Reopen", { disabled: pending || pullState(pull) === "merged", title: pullState(pull) === "merged" ? "Merged pull requests cannot be reopened here." : undefined, onClick: () => void this.mutate(number, () => this.services.api.request<PullMutation>(`/api/pulls/${number}`, { method: "PATCH", body: JSON.stringify({ state: pullState(pull) === "open" ? "closed" : "open" }) }), `Pull request ${pullState(pull) === "open" ? "closed" : "reopened"}.`) }), button(pull.draft ? "Mark ready" : "Convert to draft", { disabled: pending || pullState(pull) !== "open", title: pullState(pull) !== "open" ? "Only open pull requests can change draft state." : undefined, onClick: () => void this.mutate(number, () => this.services.api.request<PullMutation>(`/api/pulls/${number}/draft`, { method: "POST", body: JSON.stringify({ draft: !pull.draft }) }), pull.draft ? "Pull request marked ready." : "Pull request converted to draft.") }), button("Edit assignees", { disabled: pending || Boolean(this.metadataError), title: this.metadataError, onClick: (event) => void this.editAssignees(pull, event.currentTarget as HTMLElement) }), button("Set milestone", { disabled: pending || Boolean(this.metadataError), title: this.metadataError, onClick: (event) => void this.editMilestone(pull, event.currentTarget as HTMLElement) }), button("Reviewers", { disabled: pending || Boolean(this.metadataError), title: this.metadataError, onClick: (event) => void this.editReviewers(detail, event.currentTarget as HTMLElement) }), button("Submit review", { disabled: pending || pullState(pull) !== "open", title: pullState(pull) !== "open" ? "Reviews can only be submitted to open pull requests." : undefined, onClick: (event) => this.openReview(detail, event.currentTarget as HTMLElement) }), button("Merge…", { className: "button primary", disabled: pending || pullState(pull) !== "open" || pull.draft || detail.mergeable !== true, title: this.mergeDisabledReason(detail), onClick: (event) => this.openMerge(detail, event.currentTarget as HTMLElement) })));
    const linked = this.linkedIssues(detail);
    const files = this.files(detail);
    const reviews = this.reviews(detail);
    const checksSection = this.checks(detail);
    handle.body.append(summary, form, actions, linked, files, reviews, checksSection);
  }

  private linkedIssues(detail: PullRequestDetail): HTMLElement {
    const section = el("section", { className: "detail-section" }, el("h3", { text: "Linked issues" }));
    if (!detail.linkedIssues.length) section.append(el("p", { className: "muted", text: "No linked issues were reported." }));
    else for (const issue of detail.linkedIssues) section.append(el("p", {}, el("a", { text: `#${issue.number} ${issue.title}`, attrs: { href: `/tasks?issue=${issue.number}`, "data-route": "" } })));
    return section;
  }

  private files(detail: PullRequestDetail): HTMLElement {
    const section = el("section", { className: "detail-section" }, el("h3", { text: `Files / Diff (${detail.files.length})` }));
    if (!detail.files.length) section.append(el("p", { className: "muted", text: "No changed files were reported." }));
    for (const file of detail.files) {
      const notice = file.patch === null
        ? "Textual diff unavailable, binary, or oversized. Open in GitHub for the complete change."
        : undefined;
      section.append(
        el(
          "article",
          { className: "diff-file" },
          el("header", {}, el("strong", { text: file.filename }), el("span", { text: `+${file.additions} / −${file.deletions}` })),
          notice
            ? el("p", { className: "partial-note", text: notice })
            : el("pre", { className: "diff-text", text: file.patch ?? "" }),
        ),
      );
    }
    section.append(externalLink("Open complete diff in GitHub ↗", detail.pullRequest.url));
    return section;
  }

  private reviews(detail: PullRequestDetail): HTMLElement {
    const section = el("section", { className: "detail-section" }, el("h3", { text: "Reviews and requested reviewers" }));
    if (detail.requestedReviewers.length) section.append(el("p", { className: "detail-copy", text: `Requested: ${detail.requestedReviewers.map(({ login }) => `@${login}`).join(", ")}` }));
    else section.append(el("p", { className: "muted", text: "No reviewers are currently requested." }));
    for (const review of detail.reviews) {
      const user = review.user;
      section.append(el("article", { className: "review-row" }, el("strong", { text: user ? `@${user.login}` : "Unknown reviewer" }), badge(review.state || "Unknown"), review.body ? el("p", { className: "detail-body", text: review.body }) : null, review.submittedAt ? timeElement(review.submittedAt) : null));
    }
    return section;
  }

  private checks(detail: PullRequestDetail): HTMLElement {
    const combined = detail.combinedStatus;
    const summary = checksLabel(detail.pullRequest.checksState);
    const section = el("section", { className: "detail-section" }, el("h3", { text: "Checks" }), el("div", { className: "badge-row" }, badge(summary.text, summary.tone), badge(`${combined.totalCount} reported check${combined.totalCount === 1 ? "" : "s"}`)));
    if (!combined.complete) section.append(el("p", { className: "partial-note", text: "Check coverage is incomplete. Open GitHub before relying on this result." }));
    const rows = el("ul", { className: "row-list" });
    for (const status of combined.statuses) rows.append(el("li", { className: "check-row" }, el("span", {}, el("strong", { text: status.context }), status.description ? el("small", { text: status.description }) : null), badge(status.state), status.targetUrl ? externalLink("Details ↗", status.targetUrl) : null));
    for (const run of combined.checkRuns) rows.append(el("li", { className: "check-row" }, el("span", {}, el("strong", { text: run.name }), el("small", { text: run.conclusion ?? run.status })), badge(run.conclusion ?? run.status), run.detailsUrl ? externalLink("Details ↗", run.detailsUrl) : null));
    if (!combined.statuses.length && !combined.checkRuns.length) rows.append(el("li", { className: "muted", text: "No individual check details were reported." }));
    section.append(rows);
    return section;
  }

  private mergeDisabledReason(detail: PullRequestDetail): string | undefined {
    const pull = detail.pullRequest;
    if (pullState(pull) !== "open") return "Only open pull requests can be merged.";
    if (pull.draft) return "Mark the pull request ready before merging.";
    if (detail.mergeable === false) return `GitHub reports this pull request is not mergeable${detail.mergeableState ? ` (${detail.mergeableState})` : ""}.`;
    if (detail.mergeable !== true) return "Merge eligibility is still unknown. Refresh the pull request before merging.";
    if (!detail.allowedMergeMethods.length) return "No merge method is allowed for this repository.";
    return undefined;
  }

  private async editAssignees(pull: PullRequestSummary, trigger: HTMLElement): Promise<void> {
    const selected = pull.assignees.map(({ login }) => login);
    const next = await openPicker(this.services.overlays, { title: `Assignees for #${pull.number}`, label: "Assignees", multiple: true, options: this.assignees.map((user) => ({ value: user.login, label: `@${user.login}` })), selected, disabledReason: this.metadataError, returnFocus: trigger });
    if (!next) return;
    if (selected.length === next.length && selected.every((login) => next.includes(login))) {
      this.services.announce("Assignees remain unchanged.");
      return;
    }
    await this.mutate(pull.number, async () => {
      let result: PullMutation = {};
      for (const login of selected.filter((login) => !next.includes(login))) result = await this.services.api.request(`/api/pulls/${pull.number}/assignees`, { method: "DELETE", body: JSON.stringify({ login }) });
      for (const login of next.filter((login) => !selected.includes(login))) result = await this.services.api.request(`/api/pulls/${pull.number}/assignees`, { method: "POST", body: JSON.stringify({ login }) });
      return result;
    }, "Assignees updated.", true);
  }

  private async editMilestone(pull: PullRequestSummary, trigger: HTMLElement): Promise<void> {
    const next = await openPicker(this.services.overlays, { title: `Milestone for #${pull.number}`, label: "Milestone", allowNone: true, noneLabel: "No milestone", options: this.milestones.map((item) => ({ value: String(item.number), label: item.title, description: item.state === "closed" ? "Closed milestone" : "Open milestone" })), selected: pull.milestone ? [String(pull.milestone.number)] : [], disabledReason: this.metadataError, returnFocus: trigger });
    if (!next) return;
    if ((pull.milestone ? String(pull.milestone.number) : "") === (next[0] ?? "")) {
      this.services.announce("Milestone remains unchanged.");
      return;
    }
    await this.mutate(pull.number, () => this.services.api.request<PullMutation>(`/api/pulls/${pull.number}`, { method: "PATCH", body: JSON.stringify({ milestone: next[0] ? Number(next[0]) : null }) }), "Milestone updated.");
  }

  private async editReviewers(detail: PullRequestDetail, trigger: HTMLElement): Promise<void> {
    const selected = detail.requestedReviewers.map(({ login }) => login);
    const next = await openPicker(this.services.overlays, { title: `Reviewers for #${detail.pullRequest.number}`, label: "Requested reviewers", multiple: true, options: this.assignees.map((user) => ({ value: user.login, label: `@${user.login}` })), selected, disabledReason: this.metadataError, returnFocus: trigger });
    if (!next) return;
    if (selected.length === next.length && selected.every((login) => next.includes(login))) {
      this.services.announce("Requested reviewers remain unchanged.");
      return;
    }
    await this.mutate(detail.pullRequest.number, async () => {
      let result: PullMutation = { detail };
      for (const login of selected.filter((login) => !next.includes(login))) result = await this.services.api.request(`/api/pulls/${detail.pullRequest.number}/reviewers`, { method: "DELETE", body: JSON.stringify({ login }) });
      for (const login of next.filter((login) => !selected.includes(login))) result = await this.services.api.request(`/api/pulls/${detail.pullRequest.number}/reviewers`, { method: "POST", body: JSON.stringify({ login }) });
      return result;
    }, "Requested reviewers updated.", true);
  }

  private openReview(detail: PullRequestDetail, trigger: HTMLElement): void {
    let dirty = false;
    const handle = this.services.overlays.open({ title: `Submit review for #${detail.pullRequest.number}`, eyebrow: "Review", kind: "form", returnFocus: trigger, beforeClose: () => !dirty || confirmDiscard() });
    const form = el("form", { className: "form-grid" });
    const event = el("select", {}, el("option", { text: "Comment", attrs: { value: "COMMENT" } }), el("option", { text: "Approve", attrs: { value: "APPROVE" } }), el("option", { text: "Request changes", attrs: { value: "REQUEST_CHANGES" } }));
    const body = el("textarea", { attrs: { rows: "7", placeholder: "Review comment (required for comment or request changes)" } });
    form.append(field("Review decision", event), field("Comment (plain text)", body));
    form.addEventListener("input", () => { dirty = true; });
    const cancel = button("Cancel", { onClick: () => handle.close("cancel") }); cancel.dataset.cancel = "true";
    const submit = button("Submit review", { className: "button primary", onClick: () => form.requestSubmit() });
    handle.body.append(form); handle.footer.append(cancel, submit);
    form.addEventListener("submit", (submitEvent) => {
      submitEvent.preventDefault();
      if ((event.value === "COMMENT" || event.value === "REQUEST_CHANGES") && !body.value.trim()) {
        handle.setError("A review comment is required for this decision.");
        return;
      }
      void (async () => {
        handle.setBusy(true, "Submitting…");
        const saved = await this.mutate(detail.pullRequest.number, () => this.services.api.request<PullMutation>(`/api/pulls/${detail.pullRequest.number}/reviews`, { method: "POST", body: JSON.stringify({ event: event.value, body: body.value }) }), "Review submitted.", true);
        if (saved) {
          dirty = false;
          handle.close("submitted", true);
        } else {
          handle.setBusy(false);
        }
      })();
    });
  }

  private openMerge(detail: PullRequestDetail, trigger: HTMLElement): void {
    const pull = detail.pullRequest;
    const handle = this.services.overlays.open({ title: `Merge pull request #${pull.number}?`, eyebrow: this.services.context.repository, kind: "confirm", returnFocus: trigger, defaultFocus: "cancel" });
    const method = el("select");
    for (const value of detail.allowedMergeMethods) method.append(el("option", { text: String(value), attrs: { value: String(value) } }));
    handle.body.append(el("dl", { className: "detail-list" }, term("Pull request", `#${pull.number} ${pull.title}`), term("Repository", this.services.context.repository), term("Branches", `${pull.head.ref} → ${pull.base.ref}`), term("Reviewed head SHA", pull.head.sha)), field("Merge method", method), el("p", { className: "warning-note", text: "Gitasks will merge only if the head SHA is unchanged. It will not bypass protections or delete the branch." }));
    const cancel = button("Cancel", { onClick: () => handle.close("cancel", true) }); cancel.dataset.cancel = "true";
    const confirm = button("Confirm merge", { className: "button primary", onClick: () => void (async () => {
      handle.setBusy(true, "Merging…");
      handle.setError();
      try {
        const payload = await this.services.mutations.run(`pr:${pull.number}`, () => this.services.api.request<PullMutation>(`/api/pulls/${pull.number}/merge`, { method: "POST", body: JSON.stringify({ method: method.value, expectedHeadSha: pull.head.sha }) }));
        if (payload.pullRequest) this.upsert(payload.pullRequest);
        handle.close("merged", true);
        this.services.toasts.show(`Pull request #${pull.number} merged.`, { tone: "success" });
        if (!this.abort.signal.aborted) {
          await this.loadDetail(pull.number);
          if (!this.abort.signal.aborted) this.render();
        }
      } catch (error) {
        const changed = error instanceof ApiRequestError && (error.code === "stale" || error.code === "head_changed");
        handle.setError(changed ? "The head SHA changed. This confirmation is no longer valid; review the new changes before merging." : apiErrorDescription(error));
        handle.setBusy(false);
        if (changed) confirm.disabled = true;
      }
    })() });
    handle.footer.append(cancel, confirm);
  }

  private async mutate(number: number, operation: () => Promise<PullMutation>, success: string, reload = false, clearsDirty = false): Promise<boolean> {
    const handle = this.detailHandle;
    handle?.setBusy(true);
    try {
      const payload = await this.services.mutations.run(`pr:${number}`, operation);
      if (payload.pullRequest) this.upsert(payload.pullRequest);
      if (payload.detail) {
        this.detail = payload.detail;
        this.upsert(payload.detail.pullRequest);
      }
      if (clearsDirty) this.detailDirty = false;
      this.services.api.invalidate("pulls");
      this.services.toasts.show(success, { tone: "success" });
      if (this.abort.signal.aborted) return true;
      if (reload || (!payload.pullRequest && !payload.detail)) await this.loadDetail(number);
      else this.renderDetail();
      if (!this.abort.signal.aborted) this.render();
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return false;
      const message = apiErrorDescription(error);
      (this.services.overlays.top() ?? handle)?.setError(message);
      this.services.toasts.show(message, { tone: "error" });
      return false;
    } finally {
      handle?.setBusy(false);
    }
  }

  private upsert(pull: PullRequestSummary): void {
    const index = this.pulls.findIndex((item) => item.number === pull.number);
    const included = this.state() === "all" || pullState(pull) === this.state();
    if (index >= 0 && included) this.pulls[index] = pull;
    else if (index >= 0) this.pulls.splice(index, 1);
    else if (included) this.pulls.unshift(pull);
    if (this.detail?.pullRequest.number === pull.number) this.detail = { ...this.detail, pullRequest: pull };
  }
}

function field(label: string, control: HTMLElement): HTMLLabelElement {
  return el("label", { className: "field" }, el("span", { text: label }), control);
}

function term(label: string, value: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(el("dt", { text: label }), el("dd", { text: value }));
  return fragment;
}
