import { apiErrorDescription } from "../api.js";
import { checkboxGroup, chipBar, filterDetails, searchField, type FilterChip } from "../components/filters.js";
import { avatar, button, el, externalLink, formatDate, pageHeader, statePanel, timeElement } from "../components/primitives.js";
import type { ActivityEnvelope, ActivityEvent } from "../models.js";
import type { AppRoute } from "../router.js";
import { setRepeated } from "../router.js";
import type { AppServices, ViewController } from "../services.js";

export class ActivityView implements ViewController {
  private readonly root: HTMLElement;
  private readonly services: AppServices;
  private route: AppRoute;
  private events: ActivityEvent[] = [];
  private hasNext = false;
  private nextPage: number | null = null;
  private complete = true;
  private coverage = "Coverage details are unavailable. This feed never claims to represent complete repository history.";
  private source = "GitHub repository issue and timeline events";
  private refreshedAt: Date | undefined;
  private loading = true;
  private refreshing = false;
  private error: string | undefined;
  private readonly abort = new AbortController();

  constructor(root: HTMLElement, services: AppServices, route: AppRoute) {
    this.root = root;
    this.services = services;
    this.route = route;
    void this.load(true);
  }

  update(route: AppRoute): void {
    this.route = route;
    this.render();
  }

  dispose(): void {
    this.abort.abort();
  }

  private async load(initial: boolean): Promise<void> {
    this.loading = initial && this.events.length === 0;
    this.refreshing = !this.loading;
    this.error = undefined;
    this.render();
    try {
      const result = await this.services.api.latest<ActivityEnvelope>("activity", "/api/activity?page=1", { signal: this.abort.signal });
      if (!result.current) return;
      this.events = result.data.items;
      this.hasNext = result.data.hasNext;
      this.nextPage = result.data.nextPage;
      this.complete = result.data.complete;
      this.coverage = result.data.coverage ?? this.coverage;
      this.source = result.data.source ?? this.source;
      this.refreshedAt = new Date();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) this.error = apiErrorDescription(error);
    } finally {
      this.loading = false;
      this.refreshing = false;
      if (!this.abort.signal.aborted) this.render();
    }
  }

  private filtered(): ActivityEvent[] {
    const actor = this.route.query.get("actor")?.trim().toLowerCase() ?? "";
    const types = this.route.query.getAll("event");
    return this.events.filter((event) => (!actor || (event.actor?.login ?? "unknown actor").toLowerCase().includes(actor)) && (!types.length || types.includes(event.type))).sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  }

  private render(): void {
    const refresh = button(this.refreshing ? "Refreshing…" : "Refresh", { disabled: this.refreshing, onClick: () => void this.load(false) });
    const page = el("div", { className: "page" }, pageHeader("Activity", this.source, [refresh]), this.renderFilters());
    page.append(el("aside", { className: "coverage-note" }, el("strong", { text: "Feed coverage" }), el("p", { text: this.coverage })));
    if (!this.complete) page.append(statePanel("partial", "Partial activity", "More repository events may exist beyond the loaded source/date coverage."));
    if (this.error) page.append(statePanel("error", "Activity could not be loaded", this.error, button("Retry", { onClick: () => void this.load(this.events.length === 0) })));
    if (this.loading) page.append(statePanel("loading", "Loading activity", "Reading real repository events from GitHub…"));
    else if (!this.events.length && !this.error) page.append(statePanel("empty", "No events in this coverage window", "GitHub did not return issue or pull request events for the reported source and date range."));
    else if (!this.filtered().length) page.append(statePanel("empty", "No activity matches", "Clear the actor or event filters to see loaded events.", button("Clear filters", { onClick: () => this.services.router.navigate("/activity") })));
    else page.append(this.renderFeed());
    if (this.hasNext && this.nextPage) page.append(button("Load more activity", { className: "button secondary load-more", onClick: (event) => void this.loadMore(event.currentTarget as HTMLButtonElement) }));
    this.root.replaceChildren(page);
  }

  private renderFilters(): HTMLElement {
    const actor = this.route.query.get("actor") ?? "";
    const types = this.route.query.getAll("event");
    const available = [...new Set(this.events.map((event) => event.type))].sort();
    const bar = el("section", { className: "filter-bar", attrs: { "aria-label": "Activity filters" } }, searchField(actor, "Filter by actor", (value) => this.services.router.updateQuery((query) => value.trim() ? query.set("actor", value.trim()) : query.delete("actor"), { replace: true })), filterDetails("Event types", types.length, checkboxGroup("Event type", "event", available, types, (values) => this.services.router.updateQuery((query) => setRepeated(query, "event", values)))));
    const chips: FilterChip[] = [];
    if (actor) chips.push({ label: `Actor: ${actor}`, parameter: "actor" });
    for (const type of types) chips.push({ label: `Event: ${type}`, parameter: "event", value: type });
    return el("div", { className: "filters-wrap" }, bar, chipBar(this.services.router, chips, () => this.services.router.navigate("/activity")));
  }

  private renderFeed(): HTMLElement {
    const groups = new Map<string, ActivityEvent[]>();
    for (const event of this.filtered()) {
      const key = formatDate(event.createdAt, { dateStyle: "full" });
      const current = groups.get(key) ?? [];
      current.push(event);
      groups.set(key, current);
    }
    const feed = el("div", { className: "activity-feed" });
    for (const [date, events] of groups) {
      const headingId = `activity-${crypto.randomUUID()}`;
      const list = el("ol", { className: "activity-list", attrs: { "aria-labelledby": headingId } });
      for (const event of events) {
        const subject = externalLink(`#${event.subject.number} ${event.subject.title}`, event.subject.url);
        const actorName = event.actor ? `@${event.actor.login}` : "An unknown actor";
        const sentence = el("p", { className: "activity-sentence" }, el("strong", { text: actorName }), document.createTextNode(` ${event.action} `), subject);
        const actorVisual = event.actor ? avatar(event.actor, "md") : el("span", { className: "avatar avatar-md", text: "?" });
        list.append(el("li", { id: `event-${event.id}` }, el("article", { className: "activity-event" }, actorVisual, el("div", {}, sentence, el("p", { className: "event-meta" }, el("span", { text: event.type }), document.createTextNode(" · "), timeElement(event.createdAt))))));
      }
      feed.append(el("section", { className: "activity-group" }, el("h2", { id: headingId, className: "activity-date", text: date }), list));
    }
    return feed;
  }

  private async loadMore(trigger: HTMLButtonElement): Promise<void> {
    if (!this.nextPage) return;
    trigger.disabled = true;
    try {
      const payload = await this.services.api.request<ActivityEnvelope>(`/api/activity?page=${this.nextPage}`, { signal: this.abort.signal });
      const known = new Set(this.events.map(({ id }) => id));
      const appended = payload.items.filter(({ id }) => !known.has(id));
      this.events.push(...appended);
      this.hasNext = payload.hasNext;
      this.nextPage = payload.nextPage;
      this.complete = payload.complete;
      this.coverage = payload.coverage ?? this.coverage;
      this.services.announce(`${appended.length} more activity event${appended.length === 1 ? "" : "s"} loaded.`);
      this.render();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.services.toasts.show(apiErrorDescription(error), { tone: "error", actionLabel: "Retry", action: () => void this.loadMore(trigger) });
      trigger.disabled = false;
    }
  }
}
