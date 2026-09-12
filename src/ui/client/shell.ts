import type { RepositoryContext, RouteName } from "./models.js";
import { safeUrl } from "./components/primitives.js";

const NAV_PATHS: Record<RouteName, string> = {
  overview: "/overview",
  tasks: "/tasks",
  activity: "/activity",
  "pull-requests": "/pull-requests",
  milestones: "/milestones",
};

export class Shell {
  private readonly sidebar: HTMLElement;
  private readonly workspace: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly backdrop: HTMLButtonElement;
  private readonly repository: HTMLElement;
  private readonly repositoryLink: HTMLAnchorElement;
  private readonly version: HTMLElement;
  private readonly media = window.matchMedia("(max-width: 799px)");
  private open = false;

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.open || !this.media.matches) return;
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...this.sidebar.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((node) => !node.hidden);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  constructor() {
    this.sidebar = this.require("sidebar");
    this.workspace = this.require("workspace");
    this.toggle = this.require("sidebar-toggle");
    this.closeButton = this.require("sidebar-close");
    this.backdrop = this.require("sidebar-backdrop");
    this.repository = this.require("repository-name");
    this.repositoryLink = this.require("repository-link");
    this.version = this.require("app-version");
    this.toggle.addEventListener("click", () => this.openDrawer());
    this.closeButton.addEventListener("click", () => this.close());
    this.backdrop.addEventListener("click", () => this.close());
    this.sidebar.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest("a[data-route]")) this.close(false);
    });
    document.addEventListener("keydown", this.onKeyDown);
    this.media.addEventListener("change", () => this.syncMode());
    this.syncMode();
  }

  setContext(context: RepositoryContext): void {
    this.repository.textContent = context.repository || "Repository unavailable";
    this.repository.title = context.repository || "Repository unavailable";
    this.version.textContent = context.version ? `v${context.version}` : "v0.4.0";
    const url = safeUrl(context.repositoryUrl);
    if (url) {
      this.repositoryLink.href = url;
      this.repositoryLink.hidden = false;
    } else {
      this.repositoryLink.removeAttribute("href");
      this.repositoryLink.hidden = true;
    }
  }

  setRoute(route: RouteName): void {
    for (const link of this.sidebar.querySelectorAll<HTMLAnchorElement>("a[data-route]")) {
      const active = new URL(link.href, window.location.href).pathname === NAV_PATHS[route];
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }

  dispose(): void {
    document.removeEventListener("keydown", this.onKeyDown);
  }

  private require<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) throw new Error(`Missing shell element: ${id}`);
    return node as T;
  }

  private openDrawer(): void {
    if (!this.media.matches) return;
    this.open = true;
    document.body.classList.add("nav-open");
    this.sidebar.setAttribute("role", "dialog");
    this.sidebar.setAttribute("aria-modal", "true");
    this.sidebar.setAttribute("aria-label", "Primary navigation");
    this.toggle.setAttribute("aria-expanded", "true");
    this.backdrop.hidden = false;
    this.workspace.inert = true;
    this.closeButton.focus();
  }

  private close(restoreFocus = true): void {
    if (!this.open) return;
    this.open = false;
    document.body.classList.remove("nav-open");
    this.sidebar.removeAttribute("role");
    this.sidebar.removeAttribute("aria-modal");
    this.sidebar.setAttribute("aria-label", "Gitasks navigation");
    this.toggle.setAttribute("aria-expanded", "false");
    this.backdrop.hidden = true;
    this.workspace.inert = false;
    if (restoreFocus) this.toggle.focus();
  }

  private syncMode(): void {
    if (!this.media.matches) this.close(false);
    this.closeButton.hidden = !this.media.matches;
    if (!this.media.matches) {
      this.sidebar.setAttribute("aria-label", "Gitasks navigation");
      this.backdrop.hidden = true;
      this.workspace.inert = false;
    }
  }
}
