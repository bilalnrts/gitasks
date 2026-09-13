import type { RouteName } from "./models.js";

export interface AppRoute {
  name: RouteName;
  path: string;
  query: URLSearchParams;
  key: string;
}

const ROUTE_NAMES: Record<string, RouteName> = {
  "/": "overview",
  "/overview": "overview",
  "/tasks": "tasks",
  "/activity": "activity",
  "/pull-requests": "pull-requests",
  "/milestones": "milestones",
  "/analytics": "analytics",
};

export type RouteListener = (route: AppRoute, kind: "push" | "replace" | "pop") => void;

export function parseRoute(location: Location = window.location): AppRoute {
  const name = ROUTE_NAMES[location.pathname] ?? "overview";
  const path = name === "overview" ? "/overview" : `/${name}`;
  const query = new URLSearchParams(location.search);
  return { name, path, query, key: `${path}?${query.toString()}` };
}

export class Router {
  private readonly listeners = new Set<RouteListener>();
  private readonly onPop = (): void => this.emit("pop");
  private readonly onClick = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[data-route]") : null;
    if (!target || target.target || target.hasAttribute("download")) return;
    const url = new URL(target.href, window.location.href);
    if (url.origin !== window.location.origin || ROUTE_NAMES[url.pathname] === undefined) return;
    event.preventDefault();
    this.navigate(`${url.pathname}${url.search}${url.hash}`);
  };

  constructor() {
    window.addEventListener("popstate", this.onPop);
    document.addEventListener("click", this.onClick);
    if (window.location.pathname === "/" || ROUTE_NAMES[window.location.pathname] === undefined) {
      history.replaceState({ gitasks: true }, "", `/overview${window.location.search}`);
    }
  }

  current(): AppRoute {
    return parseRoute();
  }

  subscribe(listener: RouteListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  navigate(href: string, options: { replace?: boolean } = {}): void {
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin || ROUTE_NAMES[url.pathname] === undefined) return;
    const kind = options.replace ? "replace" : "push";
    history[kind === "replace" ? "replaceState" : "pushState"]({ gitasks: true }, "", `${url.pathname}${url.search}${url.hash}`);
    this.emit(kind);
  }

  updateQuery(update: (query: URLSearchParams) => void, options: { replace?: boolean } = {}): void {
    const route = this.current();
    const query = new URLSearchParams(route.query);
    update(query);
    const search = query.toString();
    this.navigate(`${route.path}${search ? `?${search}` : ""}`, options);
  }

  openDetail(parameter: "issue" | "pr" | "milestone", value: number): void {
    this.updateQuery((query) => query.set(parameter, String(value)));
  }

  closeDetail(parameter: "issue" | "pr" | "milestone"): void {
    const state = history.state as { gitasks?: boolean } | null;
    if (state?.gitasks && this.current().query.has(parameter)) {
      history.back();
      return;
    }
    this.updateQuery((query) => query.delete(parameter), { replace: true });
  }

  dispose(): void {
    window.removeEventListener("popstate", this.onPop);
    document.removeEventListener("click", this.onClick);
    this.listeners.clear();
  }

  private emit(kind: "push" | "replace" | "pop"): void {
    const route = this.current();
    for (const listener of this.listeners) listener(route, kind);
  }
}

export function setRepeated(query: URLSearchParams, name: string, values: readonly string[]): void {
  query.delete(name);
  for (const value of values) query.append(name, value);
}

export function numericQuery(query: URLSearchParams, name: string): number | undefined {
  const raw = query.get(name);
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
