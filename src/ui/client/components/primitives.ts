import type { UserSummary } from "../models.js";

export type Child = Node | string | number | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { className?: string; text?: string; id?: string; attrs?: Record<string, string>; dataset?: Record<string, string> } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.id) node.id = options.id;
  if (options.attrs) for (const [name, value] of Object.entries(options.attrs)) node.setAttribute(name, value);
  if (options.dataset) for (const [name, value] of Object.entries(options.dataset)) node.dataset[name] = value;
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function button(label: string, options: { className?: string | undefined; onClick?: ((event: MouseEvent) => void) | undefined; disabled?: boolean | undefined; title?: string | undefined } = {}): HTMLButtonElement {
  const node = el("button", { className: options.className ?? "button secondary", text: label, attrs: { type: "button" } });
  node.disabled = options.disabled ?? false;
  if (options.title) node.title = options.title;
  if (options.onClick) node.addEventListener("click", options.onClick);
  return node;
}

export function safeUrl(value: unknown, kind: "github" | "avatar" = "github"): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (kind === "avatar" && url.hostname !== "avatars.githubusercontent.com") return undefined;
    if (kind === "github" && url.hostname !== "github.com" && !url.hostname.endsWith(".github.com")) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function externalLink(label: string, urlValue: unknown, className = "text-link"): HTMLElement {
  const url = safeUrl(urlValue);
  if (!url) return el("span", { className: "disabled-link", text: `${label} (link unavailable)`, attrs: { title: "Gitasks only opens validated GitHub URLs." } });
  return el("a", { className, text: label, attrs: { href: url, target: "_blank", rel: "noreferrer" } });
}

function initials(login: string): string {
  return login.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
}

export function avatar(user: UserSummary | { login: string; avatarUrl?: string }, size: "sm" | "md" = "sm"): HTMLElement {
  const wrapper = el("span", { className: `avatar avatar-${size}`, attrs: { title: `@${user.login}` } });
  const url = safeUrl(user.avatarUrl, "avatar");
  if (url) {
    const image = el("img", { attrs: { src: url, alt: "", loading: "lazy", referrerpolicy: "no-referrer" } });
    image.addEventListener("error", () => image.replaceWith(el("span", { text: initials(user.login), attrs: { "aria-hidden": "true" } })), { once: true });
    wrapper.append(image);
  } else {
    wrapper.append(el("span", { text: initials(user.login), attrs: { "aria-hidden": "true" } }));
  }
  wrapper.append(el("span", { className: "visually-hidden", text: `@${user.login}` }));
  return wrapper;
}

export function avatarGroup(users: readonly UserSummary[], limit = 3): HTMLElement {
  const group = el("span", { className: "avatar-group", attrs: { "aria-label": users.length ? `Assigned to ${users.map(({ login }) => `@${login}`).join(", ")}` : "Unassigned" } });
  for (const user of users.slice(0, limit)) group.append(avatar(user));
  if (users.length > limit) group.append(el("span", { className: "avatar-more", text: `+${users.length - limit}` }));
  if (!users.length) group.append(el("span", { className: "muted", text: "Unassigned" }));
  return group;
}

export function badge(text: string, tone: "neutral" | "success" | "warning" | "danger" | "accent" = "neutral"): HTMLElement {
  return el("span", { className: `badge badge-${tone}`, text });
}

export function labelList(labels: readonly string[], limit = 3): HTMLElement {
  const list = el("span", { className: "label-list", attrs: { "aria-label": labels.length ? `Labels: ${labels.join(", ")}` : "No labels" } });
  for (const label of labels.slice(0, limit)) list.append(el("span", { className: "label-chip", text: label }));
  if (labels.length > limit) list.append(el("span", { className: "label-chip label-more", text: `+${labels.length - limit} more` }));
  return list;
}

export function formatDate(value: string | null | undefined, options: Intl.DateTimeFormatOptions = { dateStyle: "medium" }): string {
  if (!value) return "Not set";
  const calendarDate = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = calendarDate ? new Date(`${value}T00:00:00Z`) : new Date(value);
  const formatOptions = { ...options };
  if (calendarDate) formatOptions.timeZone = "UTC";
  return Number.isNaN(date.getTime()) ? "Unknown date" : new Intl.DateTimeFormat("en", formatOptions).format(date);
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3_600], ["minute", 60]];
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of units) if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  return formatter.format(seconds, "second");
}

export function timeElement(value: string | null | undefined, relative = true): HTMLElement {
  if (!value || Number.isNaN(new Date(value).getTime())) return el("span", { className: "muted", text: "Unknown time" });
  const node = el("time", { text: relative ? relativeTime(value) : formatDate(value), attrs: { datetime: value, title: formatDate(value, { dateStyle: "medium", timeStyle: "short" }) } });
  return node;
}

export function pageHeader(title: string, eyebrow: string, actions: HTMLElement[] = []): HTMLElement {
  const heading = el("h1", { text: title, attrs: { tabindex: "-1" } });
  const copy = el("div", {}, el("p", { className: "eyebrow", text: eyebrow }), heading);
  return el("header", { className: "page-header" }, copy, actions.length ? el("div", { className: "page-actions" }, ...actions) : null);
}

export function statePanel(kind: "loading" | "empty" | "error" | "partial" | "permission" | "unsupported", title: string, message: string, action?: HTMLElement): HTMLElement {
  const panel = el("section", { className: `state-panel state-${kind}`, attrs: kind === "error" ? { role: "alert" } : { role: "status" } }, el("div", {}, el("strong", { text: title }), el("p", { text: message })), action);
  return panel;
}

export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const id = control.id || `field-${crypto.randomUUID()}`;
  control.id = id;
  const wrapper = el("div", { className: "field" }, el("label", { text: label, attrs: { for: id } }), control);
  if (hint) {
    const hintId = `${id}-hint`;
    wrapper.append(el("p", { className: "field-hint", text: hint, id: hintId }));
    control.setAttribute("aria-describedby", hintId);
  }
  return wrapper;
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function enumValue<T extends string>(value: string | null, values: readonly T[], fallback: T): T {
  return value !== null && values.includes(value as T) ? value as T : fallback;
}
