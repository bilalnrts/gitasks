import { apiErrorDescription } from "../api.js";
import { confirmation, confirmDiscard, type DialogHandle } from "../components/overlays.js";
import { badge, button, el, externalLink, formatDate, pageHeader, relativeTime, statePanel } from "../components/primitives.js";
import type { ListPage, MilestoneItemsPayload, MilestoneSummary, PullRequestSummary, TaskSummary } from "../models.js";
import type { AppRoute } from "../router.js";
import { numericQuery } from "../router.js";
import type { AppServices, ViewController } from "../services.js";
import { segmented } from "../components/filters.js";

interface MilestoneMutation { milestone?: MilestoneSummary }

export class MilestonesView implements ViewController {
  private readonly root: HTMLElement;
  private readonly services: AppServices;
  private route: AppRoute;
  private milestones: MilestoneSummary[] = [];
  private loading = true;
  private refreshing = false;
  private complete = true;
  private error: string | undefined;
  private refreshedAt: Date | undefined;
  private detailHandle: DialogHandle | undefined;
  private detailNumber: number | undefined;
  private detailItems: MilestoneItemsPayload | undefined;
  private detailError: string | undefined;
  private readonly abort = new AbortController();

  constructor(root: HTMLElement, services: AppServices, route: AppRoute) {
    this.root = root;
    this.services = services;
    this.route = route;
    void this.load(true);
  }

  update(route: AppRoute): void {
    const changed = this.state() !== stateFrom(route);
    this.route = route;
    if (changed) void this.load(true);
    else this.render();
  }

  dispose(): void {
    this.abort.abort();
    this.detailHandle?.close("route", true);
  }

  private state(): "open" | "closed" | "all" {
    return stateFrom(this.route);
  }

  private async load(initial: boolean): Promise<void> {
    this.loading = initial && !this.milestones.length;
    this.refreshing = !this.loading;
    this.error = undefined;
    this.render();
    try {
      const result = await this.services.api.latest<ListPage<MilestoneSummary>>("milestones", `/api/milestones?state=${this.state()}`, { signal: this.abort.signal });
      if (!result.current) return;
      this.milestones = result.data.items;
      this.complete = result.data.complete;
      this.refreshedAt = new Date();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) this.error = apiErrorDescription(error);
    } finally {
      this.loading = false;
      this.refreshing = false;
      if (!this.abort.signal.aborted) this.render();
    }
  }

  private render(): void {
    const refresh = button(this.refreshing ? "Refreshing…" : "Refresh", { disabled: this.refreshing, onClick: () => void this.load(false) });
    const create = button("Create milestone", { className: "button primary", onClick: (event) => this.openForm(undefined, event.currentTarget as HTMLElement) });
    const page = el("div", { className: "page" }, pageHeader("Milestones", this.services.context.repository, [refresh, create]), segmented("Milestone state", this.state(), [{ value: "open", label: "Open" }, { value: "closed", label: "Closed" }, { value: "all", label: "All" }], (value) => this.services.router.updateQuery((query) => value === "open" ? query.delete("state") : query.set("state", value))));
    if (this.refreshedAt) page.append(el("p", { className: "scope-line", text: `${this.milestones.length} loaded milestone${this.milestones.length === 1 ? "" : "s"} · refreshed ${relativeTime(this.refreshedAt.toISOString())}` }));
    if (!this.complete) page.append(statePanel("partial", "Partial milestones", "The loaded milestone list is incomplete; counts apply only to loaded rows."));
    if (this.error) page.append(statePanel("error", "Milestones could not be loaded", this.error, button("Retry", { onClick: () => void this.load(!this.milestones.length) })));
    if (this.loading) page.append(statePanel("loading", "Loading milestones", "Reading milestone state and counters from GitHub…"));
    else if (!this.milestones.length && !this.error) page.append(statePanel("empty", this.state() === "open" ? "No open milestones" : "No milestones in this state", "Create a milestone to group issues and pull requests around a delivery goal.", button("Create milestone", { className: "button primary", onClick: (event) => this.openForm(undefined, event.currentTarget as HTMLElement) })));
    else page.append(this.rows());
    this.root.replaceChildren(page);
    this.syncDetail();
  }

  private rows(): HTMLElement {
    const list = el("ul", { className: "milestone-list" });
    for (const milestone of this.milestones) {
      const pending = this.services.mutations.isPending(`milestone:${milestone.number}`);
      list.append(el("li", {}, el("article", { className: "milestone-row", attrs: { "aria-busy": String(pending) } },
        el("div", { className: "milestone-main" }, el("div", { className: "row-heading" }, el("h2", { text: milestone.title }), badge(milestone.state, milestone.state === "open" ? "success" : "neutral")), milestone.description ? el("p", { className: "row-description", text: milestone.description }) : el("p", { className: "muted", text: "No description." }), el("p", { className: "due-date", text: `Due date: ${formatDate(milestone.dueOn)}` })),
        this.progress(milestone),
        el("div", { className: "row-actions" }, button("View details", { onClick: () => this.services.router.openDetail("milestone", milestone.number) }), button("Edit", { disabled: pending, onClick: (event) => this.openForm(milestone, event.currentTarget as HTMLElement) }), button(milestone.state === "open" ? "Close" : "Reopen", { className: milestone.state === "open" ? "button danger-quiet" : "button secondary", disabled: pending, onClick: (event) => void this.changeState(milestone, event.currentTarget as HTMLElement) }), externalLink("GitHub ↗", milestone.url))
      )));
    }
    return list;
  }

  private progress(milestone: MilestoneSummary): HTMLElement {
    const total = milestone.openIssues + milestone.closedIssues;
    const copy = total === 0 ? "No linked issues or pull requests" : `Items closed (issues and pull requests): ${milestone.closedIssues} of ${total}`;
    const region = el("div", { className: "milestone-progress" }, el("p", { text: copy }));
    if (total > 0) region.append(el("progress", { attrs: { max: String(total), value: String(milestone.closedIssues), "aria-label": copy } }));
    return region;
  }

  private openForm(milestone: MilestoneSummary | undefined, trigger: HTMLElement): void {
    let dirty = false;
    const handle = this.services.overlays.open({ title: milestone ? "Edit milestone" : "Create milestone", eyebrow: milestone ? `Milestone #${milestone.number}` : this.services.context.repository, kind: "form", returnFocus: trigger, beforeClose: () => !dirty || confirmDiscard() });
    const form = el("form", { className: "form-grid" });
    const title = el("input", { attrs: { type: "text", required: "", maxlength: "256" } });
    title.value = milestone?.title ?? "";
    const description = el("textarea", { attrs: { rows: "6" } });
    description.value = milestone?.description ?? "";
    const due = el("input", { attrs: { type: "date" } });
    due.value = milestone?.dueOn?.slice(0, 10) ?? "";
    form.append(field("Title", title), field("Description (optional, plain text)", description), field("Due date (optional)", due));
    form.addEventListener("input", () => { dirty = true; });
    const cancel = button("Cancel", { onClick: () => handle.close("cancel") });
    cancel.dataset.cancel = "true";
    const submit = button(milestone ? "Save milestone" : "Create milestone", { className: "button primary", onClick: () => form.requestSubmit() });
    handle.body.append(form);
    handle.footer.append(cancel, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      void (async () => {
        handle.setBusy(true, milestone ? "Saving…" : "Creating…");
        handle.setError();
        const input = { title: title.value.trim(), description: description.value, dueOn: due.value || null };
        try {
          const payload = await this.services.api.request<MilestoneMutation>(milestone ? `/api/milestones/${milestone.number}` : "/api/milestones", { method: milestone ? "PATCH" : "POST", body: JSON.stringify(input) });
          if (!payload.milestone) throw new Error("The server did not return the saved milestone.");
          this.upsert(payload.milestone);
          dirty = false;
          handle.close("saved", true);
          this.services.toasts.show(`Milestone ${milestone ? "updated" : "created"}.`, { tone: "success" });
          if (!this.abort.signal.aborted) this.render();
        } catch (error) {
          handle.setError(apiErrorDescription(error));
          handle.setBusy(false);
        }
      })();
    });
  }

  private async changeState(milestone: MilestoneSummary, trigger: HTMLElement): Promise<void> {
    if (milestone.state === "open") {
      const confirmed = await confirmation(this.services.overlays, { title: "Close milestone?", message: `Close “${milestone.title}”? Linked issues and pull requests remain unchanged.`, confirmLabel: "Close milestone", destructive: true, returnFocus: trigger });
      if (!confirmed) return;
    }
    try {
      const payload = await this.services.mutations.run(`milestone:${milestone.number}`, () => this.services.api.request<MilestoneMutation>(`/api/milestones/${milestone.number}`, { method: "PATCH", body: JSON.stringify({ state: milestone.state === "open" ? "closed" : "open" }) }));
      if (!payload.milestone) throw new Error("The server did not return the updated milestone.");
      this.upsert(payload.milestone);
      this.services.toasts.show(`Milestone ${payload.milestone.state === "open" ? "reopened" : "closed"}.`, { tone: "success" });
      if (!this.abort.signal.aborted) this.render();
    } catch (error) {
      this.services.toasts.show(apiErrorDescription(error), { tone: "error" });
    }
  }

  private upsert(milestone: MilestoneSummary): void {
    const index = this.milestones.findIndex((item) => item.number === milestone.number);
    const included = this.state() === "all" || milestone.state === this.state();
    if (index >= 0 && included) this.milestones[index] = milestone;
    else if (index >= 0) this.milestones.splice(index, 1);
    else if (included) this.milestones.unshift(milestone);
  }

  private syncDetail(): void {
    const number = numericQuery(this.route.query, "milestone");
    if (!number) {
      if (this.detailHandle) {
        const handle = this.detailHandle;
        this.detailHandle = undefined;
        this.detailNumber = undefined;
        handle.close("route", true);
      }
      return;
    }
    if (this.detailHandle && this.detailNumber === number) return;
    this.detailHandle?.close("route", true);
    this.detailNumber = number;
    const milestone = this.milestones.find((item) => item.number === number);
    const handle = this.services.overlays.open({ title: milestone?.title ?? `Milestone #${number}`, eyebrow: `Milestone #${number}`, kind: "drawer", onClose: (value) => {
      if (this.detailHandle === handle) this.detailHandle = undefined;
      if (value !== "route" && numericQuery(this.services.router.current().query, "milestone") === number) this.services.router.closeDetail("milestone");
    } });
    this.detailHandle = handle;
    handle.body.append(statePanel("loading", "Loading milestone items", "Reading linked issues and pull requests from GitHub…"));
    void this.loadDetail(number);
  }

  private async loadDetail(number: number): Promise<void> {
    this.detailItems = undefined;
    this.detailError = undefined;
    try {
      const result = await this.services.api.latest<MilestoneItemsPayload>(`milestone:${number}:items`, `/api/milestones/${number}/items`, { signal: this.abort.signal });
      if (!result.current || number !== this.detailNumber) return;
      this.detailItems = result.data;
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
    const milestone = this.milestones.find((item) => item.number === number);
    if (milestone) handle.body.append(el("section", { className: "detail-section" }, el("h3", { text: "Summary" }), el("p", { className: "detail-copy", text: milestone.description || "No description." }), el("p", { className: "detail-copy", text: `Due date: ${formatDate(milestone.dueOn)}` }), this.progress(milestone), el("div", { className: "detail-actions" }, button("Edit", { onClick: (event) => this.openForm(milestone, event.currentTarget as HTMLElement) }), button(milestone.state === "open" ? "Close" : "Reopen", { onClick: (event) => void this.changeState(milestone, event.currentTarget as HTMLElement) }), externalLink("GitHub ↗", milestone.url, "button secondary"))));
    if (this.detailError) {
      handle.body.append(statePanel("error", "Items could not be loaded", this.detailError, button("Retry", { onClick: () => void this.loadDetail(number) })));
      return;
    }
    if (!this.detailItems) {
      handle.body.append(statePanel("loading", "Loading linked items", "Reading GitHub milestone contents…"));
      return;
    }
    if (this.detailItems.complete === false) handle.body.append(statePanel("partial", "Partial milestone items", "Additional linked items may exist on GitHub."));
    handle.body.append(linkedSection("Issues", this.detailItems.issues, "issue"), linkedSection("Pull requests", this.detailItems.pullRequests, "pr"));
  }
}

function stateFrom(route: AppRoute): "open" | "closed" | "all" {
  const value = route.query.get("state");
  return value === "closed" || value === "all" ? value : "open";
}

function field(label: string, control: HTMLElement): HTMLLabelElement {
  return el("label", { className: "field" }, el("span", { text: label }), control);
}

function linkedSection(title: string, items: Array<TaskSummary | PullRequestSummary>, kind: "issue" | "pr"): HTMLElement {
  const section = el("section", { className: "detail-section" }, el("h3", { text: title }));
  if (!items.length) section.append(el("p", { className: "muted", text: `No linked ${title.toLowerCase()} were reported.` }));
  else {
    const list = el("ul", { className: "row-list" });
    for (const item of items) list.append(el("li", {}, el("a", { className: "row-link", attrs: { href: kind === "issue" ? `/tasks?issue=${item.number}` : `/pull-requests?pr=${item.number}`, "data-route": "" } }, el("span", {}, el("strong", { text: `#${item.number} ${item.title}` }), el("small", { text: String(item.state).toLowerCase() })))));
    section.append(list);
  }
  return section;
}
