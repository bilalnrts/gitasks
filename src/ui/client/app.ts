import { ApiClient, MutationCoordinator, apiErrorDescription } from "./api.js";
import { OverlayManager, ToastManager } from "./components/overlays.js";
import { button, el, statePanel } from "./components/primitives.js";
import type { RepositoryContext, RouteName } from "./models.js";
import { Router, type AppRoute } from "./router.js";
import type { AppServices, ViewController } from "./services.js";
import { Shell } from "./shell.js";
import { ActivityView } from "./views/activity.js";
import { MilestonesView } from "./views/milestones.js";
import { OverviewView } from "./views/overview.js";
import { PullRequestsView } from "./views/pull-requests.js";
import { TasksView } from "./views/tasks.js";

function requireElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing client shell element: ${id}`);
  return node as T;
}

const root = requireElement<HTMLElement>("view-root");
const overlayRoot = requireElement<HTMLElement>("overlay-root");
const announcer = requireElement<HTMLElement>("announcer");
const toastRoot = requireElement<HTMLElement>("toast-region");
const api = new ApiClient();
const router = new Router();
const overlays = new OverlayManager(overlayRoot);
const toasts = new ToastManager(toastRoot, announcer);
const mutations = new MutationCoordinator();
const shell = new Shell();
const context: RepositoryContext = { repository: "Repository unavailable", version: "0.5.0" };
const services: AppServices = {
  api,
  router,
  overlays,
  toasts,
  mutations,
  context,
  overlayRoot,
  announce: (message, urgent = false) => toasts.announce(message, urgent),
};

class LazyAnalyticsView implements ViewController {
  private readonly root: HTMLElement;
  private readonly services: AppServices;
  private route: AppRoute;
  private view: ViewController | undefined;
  private disposed = false;

  constructor(rootElement: HTMLElement, appServices: AppServices, route: AppRoute) {
    this.root = rootElement;
    this.services = appServices;
    this.route = route;
    this.root.replaceChildren(
      el("div", { className: "page" },
        pageHeaderForLazyAnalytics(),
        statePanel("loading", "Opening repository analytics", "Loading the analytics workspace…"),
      ),
    );
    void this.load();
  }

  update(route: AppRoute): void {
    this.route = route;
    this.view?.update(route);
  }

  dispose(): void {
    this.disposed = true;
    this.view?.dispose();
  }

  private async load(): Promise<void> {
    try {
      // Analytics is intentionally route-lazy so its charts, filters, and CSV code do not execute in the five existing routes.
      const { AnalyticsView } = await import("./views/analytics.js");
      if (this.disposed) return;
      this.view = new AnalyticsView(this.root, this.services, this.route);
    } catch (error) {
      if (this.disposed) return;
      this.root.replaceChildren(
        el("div", { className: "page" },
          pageHeaderForLazyAnalytics(),
          statePanel("error", "Analytics could not be opened", apiErrorDescription(error)),
        ),
      );
    }
  }
}

function pageHeaderForLazyAnalytics(): HTMLElement {
  return el("header", { className: "page-header" },
    el("div", {},
      el("p", { className: "eyebrow", text: "Repository intelligence" }),
      el("h1", { text: "Analytics", attrs: { tabindex: "-1" } }),
    ),
  );
}

let controller: ViewController | undefined;
let activeRoute: RouteName | undefined;
let unsubscribe: (() => void) | undefined;

function createView(route: AppRoute): ViewController {
  switch (route.name) {
    case "overview": return new OverviewView(root, services, route);
    case "tasks": return new TasksView(root, services, route);
    case "activity": return new ActivityView(root, services, route);
    case "pull-requests": return new PullRequestsView(root, services, route);
    case "milestones": return new MilestonesView(root, services, route);
    case "analytics": return new LazyAnalyticsView(root, services, route);
  }
}

function activate(route: AppRoute, kind: "push" | "replace" | "pop"): void {
  const title = route.name === "pull-requests" ? "Pull Requests" : route.name[0]?.toUpperCase() + route.name.slice(1);
  document.title = `${title} · Gitasks`;
  if (activeRoute === route.name && controller) {
    controller.update(route);
    return;
  }
  controller?.dispose();
  overlays.closeAll(true);
  activeRoute = route.name;
  controller = createView(route);
  if (kind !== "replace") {
    window.setTimeout(() => {
      const heading = root.querySelector<HTMLElement>("h1");
      heading?.focus();
      services.announce(`${heading?.textContent ?? route.name} page loaded.`);
    }, 0);
  }
}

async function loadContext(): Promise<void> {
  root.replaceChildren(statePanel("loading", "Opening Gitasks", "Reading repository context from the local server…"));
  try {
    const result = await api.latest<RepositoryContext>("context", "/api/context");
    if (!result.current) return;
    Object.assign(context, result.data);
    shell.setContext(context);
    unsubscribe?.();
    unsubscribe = router.subscribe(activate);
    activate(router.current(), "replace");
  } catch (error) {
    const retry = button("Retry", { onClick: () => void loadContext() });
    root.replaceChildren(el("div", { className: "page bootstrap-error" }, statePanel("error", "Gitasks could not read repository context", apiErrorDescription(error), retry), el("p", { className: "permission-note", text: "The browser never receives GitHub credentials. Verify the local Gitasks process and gh authentication, then retry." })));
  }
}

window.addEventListener("beforeunload", () => {
  unsubscribe?.();
  controller?.dispose();
  api.abortAll();
  router.dispose();
  shell.dispose();
}, { once: true });

void loadContext();
