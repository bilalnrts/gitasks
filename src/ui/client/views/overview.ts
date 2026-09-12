import { apiErrorDescription } from "../api.js";
import { avatarGroup, badge, button, el, formatDate, pageHeader, relativeTime, statePanel } from "../components/primitives.js";
import type { MilestoneSummary, OverviewPayload, OverviewSection, PullRequestSummary, TaskSummary } from "../models.js";
import type { AppRoute } from "../router.js";
import type { AppServices, ViewController } from "../services.js";

function sectionItems<T>(section: OverviewSection<T[]>): { items: T[]; error?: string } {
  if (section.available && Array.isArray(section.data)) return { items: section.data };
  return { items: [], error: section.error?.error ?? "This section is unavailable with the current GitHub permissions or API support." };
}

function metricValue(section: OverviewSection<number>): string {
  return section.available && typeof section.data === "number" ? String(section.data) : "Unavailable";
}

export class OverviewView implements ViewController {
  private readonly root: HTMLElement;
  private readonly services: AppServices;
  private readonly abort = new AbortController();
  private payload: OverviewPayload | undefined;
  private error: string | undefined;
  private loading = true;
  private refreshing = false;
  private refreshedAt: Date | undefined;

  constructor(root: HTMLElement, services: AppServices, _route: AppRoute) {
    this.root = root;
    this.services = services;
    void this.load(true);
  }

  update(_route: AppRoute): void {
    this.render();
  }

  dispose(): void {
    this.abort.abort();
  }

  private async load(initial: boolean): Promise<void> {
    this.loading = initial && !this.payload;
    this.refreshing = !this.loading;
    this.error = undefined;
    this.render();
    try {
      const result = await this.services.api.latest<OverviewPayload>("overview", "/api/overview", { signal: this.abort.signal });
      if (!result.current) return;
      this.payload = result.data;
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
    const page = el("div", { className: "page" }, pageHeader("Overview", this.services.context.repository, [refresh]));
    if (this.refreshedAt) page.append(el("p", { className: "scope-line", text: `Last refreshed ${relativeTime(this.refreshedAt.toISOString())}` }));
    if (this.error) page.append(statePanel("error", "Overview could not be refreshed", this.error, button("Retry", { onClick: () => void this.load(!this.payload) })));
    if (this.loading) {
      page.append(statePanel("loading", "Loading workspace overview", "Reading independent repository sections from GitHub…"));
      this.root.replaceChildren(page);
      return;
    }
    if (!this.payload) {
      this.root.replaceChildren(page);
      return;
    }
    page.append(this.metrics(this.payload));
    const assigned = sectionItems(this.payload.assignedToMe);
    const milestones = sectionItems(this.payload.upcomingMilestones);
    const recent = sectionItems(this.payload.recentlyUpdated);
    page.append(el("div", { className: "overview-grid" }, this.taskSection("Assigned to me", assigned, "/tasks?assignee=me"), this.milestoneSection("Upcoming milestones", milestones)));
    page.append(this.recentSection("Recently updated", recent));
    this.root.replaceChildren(page);
  }

  private metrics(payload: OverviewPayload): HTMLElement {
    const values = [
      { label: "Open issues", value: metricValue(payload.openIssues), href: "/tasks", scope: "GitHub issues in the repository" },
      { label: "In progress", value: metricValue(payload.inProgressIssues), href: "/tasks?status=IN+PROGRESS", scope: "Open tasks with In Progress status" },
      { label: "Blocked", value: metricValue(payload.blockedIssues), href: "/tasks?status=BLOCKED", scope: "Open tasks with Blocked status" },
      { label: "Open pull requests", value: metricValue(payload.openPullRequests), href: "/pull-requests", scope: "Open pull requests in the repository" },
    ];
    const list = el("ul", { className: "metric-list", attrs: { "aria-label": "Repository summary" } });
    for (const item of values) list.append(el("li", {}, el("a", { attrs: { href: item.href, "data-route": "" } }, el("span", { className: "metric-value", text: item.value }), el("strong", { text: item.label }), el("small", { text: item.scope }))));
    return list;
  }

  private taskSection(title: string, section: { items: TaskSummary[]; error?: string }, href: string): HTMLElement {
    const content = el("section", { className: "overview-section" }, el("header", {}, el("h2", { text: title }), el("a", { text: "View all", attrs: { href, "data-route": "" } })));
    if (section.error) content.append(statePanel("permission", "Section unavailable", section.error));
    else if (!section.items.length) content.append(statePanel("empty", "No assigned tasks", "There are no loaded open tasks assigned to the signed-in GitHub user."));
    else {
      const list = el("ul", { className: "row-list" });
      for (const task of section.items) list.append(el("li", {}, el("a", { className: "row-link", attrs: { href: `/tasks?issue=${task.number}`, "data-route": "" } }, el("span", {}, el("strong", { text: `#${task.number} ${task.title}` }), el("small", { text: task.status ?? "Unclassified" })), avatarGroup(task.assignees))));
      content.append(list);
    }
    return content;
  }

  private milestoneSection(title: string, section: { items: MilestoneSummary[]; error?: string }): HTMLElement {
    const content = el("section", { className: "overview-section" }, el("header", {}, el("h2", { text: title }), el("a", { text: "View all", attrs: { href: "/milestones", "data-route": "" } })));
    if (section.error) content.append(statePanel("permission", "Section unavailable", section.error));
    else if (!section.items.length) content.append(statePanel("empty", "No upcoming milestones", "No open milestone with a due date was reported."));
    else {
      const list = el("ul", { className: "row-list" });
      for (const milestone of section.items) list.append(el("li", {}, el("a", { className: "row-link", attrs: { href: `/milestones?milestone=${milestone.number}`, "data-route": "" } }, el("span", {}, el("strong", { text: milestone.title }), el("small", { text: `Due ${formatDate(milestone.dueOn)}` })), badge(milestone.state))));
      content.append(list);
    }
    return content;
  }

  private recentSection(title: string, section: { items: Array<TaskSummary | PullRequestSummary>; error?: string }): HTMLElement {
    const content = el("section", { className: "overview-section overview-recent" }, el("header", {}, el("h2", { text: title })));
    if (section.error) content.append(statePanel("permission", "Section unavailable", section.error));
    else if (!section.items.length) content.append(statePanel("empty", "Nothing recently updated", "No recently updated issues or pull requests were reported."));
    else {
      const list = el("ul", { className: "row-list" });
      for (const item of section.items) {
        const isPull = "head" in item;
        const href = isPull ? `/pull-requests?pr=${item.number}` : `/tasks?issue=${item.number}`;
        list.append(el("li", {}, el("a", { className: "row-link", attrs: { href, "data-route": "" } }, el("span", {}, el("strong", { text: `${isPull ? "PR" : "Issue"} #${item.number} ${item.title}` }), el("small", { text: `Updated ${relativeTime(item.updatedAt)}` })), badge(isPull ? "Pull request" : "Issue", isPull ? "accent" : "neutral"))));
      }
      content.append(list);
    }
    return content;
  }
}
