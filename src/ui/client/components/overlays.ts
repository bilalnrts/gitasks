import { button, el } from "./primitives.js";

export interface DialogHandle {
  dialog: HTMLDialogElement;
  body: HTMLElement;
  footer: HTMLElement;
  error: HTMLElement;
  close(value?: string, force?: boolean): boolean;
  setBusy(busy: boolean, label?: string): void;
  setError(message?: string): void;
}

export interface DialogOptions {
  title: string;
  eyebrow?: string | undefined;
  kind?: "form" | "drawer" | "confirm" | "menu" | undefined;
  returnFocus?: HTMLElement | null | undefined;
  beforeClose?: (() => boolean) | undefined;
  defaultFocus?: "first" | "cancel" | undefined;
  onClose?: ((value: string) => void) | undefined;
}

export class OverlayManager {
  private readonly root: HTMLElement;
  private readonly stack: DialogHandle[] = [];

  constructor(root: HTMLElement) {
    this.root = root;
  }

  open(options: DialogOptions): DialogHandle {
    const dialog = el("dialog", { className: `overlay overlay-${options.kind ?? "form"}`, attrs: { "aria-modal": "true" } });
    const titleId = `overlay-title-${crypto.randomUUID()}`;
    dialog.setAttribute("aria-labelledby", titleId);
    const closeButton = button("Close", { className: "icon-button overlay-close", title: "Close" });
    closeButton.setAttribute("aria-label", `Close ${options.title}`);
    const header = el("header", { className: "overlay-header" }, el("div", {}, options.eyebrow ? el("p", { className: "eyebrow", text: options.eyebrow }) : null, el("h2", { id: titleId, text: options.title })), closeButton);
    const body = el("div", { className: "overlay-body" });
    const error = el("div", { className: "inline-error", attrs: { role: "alert" } });
    error.hidden = true;
    const footer = el("footer", { className: "overlay-footer" });
    dialog.append(header, body, error, footer);
    this.root.append(dialog);

    const returnFocus = options.returnFocus && options.returnFocus.isConnected ? options.returnFocus : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let handle!: DialogHandle;
    const requestClose = (value = ""): boolean => {
      if (options.beforeClose && !options.beforeClose()) return false;
      dialog.close(value);
      return true;
    };
    handle = {
      dialog,
      body,
      footer,
      error,
      close: (value = "", force = false) => {
        if (!force) return requestClose(value);
        dialog.close(value);
        return true;
      },
      setBusy: (busy, label = "Working…") => {
        dialog.setAttribute("aria-busy", String(busy));
        for (const control of dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("button, input, select, textarea")) {
          if (busy) {
            control.dataset.wasDisabled = String(control.disabled);
            control.disabled = true;
          } else {
            control.disabled = control.dataset.wasDisabled === "true";
            delete control.dataset.wasDisabled;
          }
        }
        const primary = footer.querySelector<HTMLButtonElement>(".primary");
        if (primary) {
          if (!primary.dataset.label) primary.dataset.label = primary.textContent ?? "Submit";
          primary.textContent = busy ? label : primary.dataset.label;
        }
      },
      setError: (message) => {
        error.hidden = !message;
        error.textContent = message ?? "";
      },
    };
    this.stack.push(handle);
    closeButton.addEventListener("click", () => requestClose("cancel"));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (this.stack.at(-1) === handle) requestClose("cancel");
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog && options.kind !== "drawer") requestClose("cancel");
    });
    dialog.addEventListener("close", () => {
      const index = this.stack.indexOf(handle);
      if (index >= 0) this.stack.splice(index, 1);
      options.onClose?.(dialog.returnValue);
      dialog.remove();
      const fallback = returnFocus?.isConnected ? returnFocus : document.querySelector<HTMLElement>("#main-content h1, #main-content button, #main-content a");
      window.setTimeout(() => fallback?.focus(), 0);
    }, { once: true });
    dialog.showModal();
    window.setTimeout(() => {
      const target = options.defaultFocus === "cancel"
        ? dialog.querySelector<HTMLElement>("[data-cancel]")
        : dialog.querySelector<HTMLElement>("[autofocus], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not(.overlay-close):not([disabled]), a[href]");
      target?.focus();
    }, 0);
    return handle;
  }

  closeAll(force = true): void {
    for (const overlay of [...this.stack].reverse()) overlay.close("route", force);
  }

  top(): DialogHandle | undefined {
    return this.stack.at(-1);
  }
}

export interface ToastOptions {
  tone?: "success" | "info" | "error";
  actionLabel?: string;
  action?: () => void;
}

export class ToastManager {
  private readonly root: HTMLElement;
  private readonly announcer: HTMLElement;
  private readonly queue: Array<{ message: string; options: ToastOptions }> = [];
  private active = false;

  constructor(root: HTMLElement, announcer: HTMLElement) {
    this.root = root;
    this.announcer = announcer;
  }

  show(message: string, options: ToastOptions = {}): void {
    this.queue.push({ message, options });
    if (!this.active) this.next();
  }

  announce(message: string, urgent = false): void {
    this.announcer.setAttribute("role", urgent ? "alert" : "status");
    this.announcer.textContent = "";
    window.setTimeout(() => { this.announcer.textContent = message; }, 0);
  }

  private next(): void {
    const item = this.queue.shift();
    if (!item) {
      this.active = false;
      return;
    }
    this.active = true;
    const tone = item.options.tone ?? "info";
    const toast = el("section", { className: `toast toast-${tone}`, attrs: { role: tone === "error" ? "alert" : "status" } }, el("p", { text: item.message }));
    if (item.options.action && item.options.actionLabel) {
      toast.append(button(item.options.actionLabel, { className: "button compact", onClick: () => { item.options.action?.(); toast.remove(); this.next(); } }));
    }
    toast.append(button("Dismiss", { className: "icon-button", onClick: () => { toast.remove(); this.next(); } }));
    const openDialogs = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")];
    const host = openDialogs.at(-1);
    if (host) {
      toast.classList.add("toast-in-overlay");
      host.append(toast);
      host.addEventListener("close", () => {
        if (toast.isConnected) {
          toast.classList.remove("toast-in-overlay");
          this.root.append(toast);
        }
      }, { once: true });
    } else {
      this.root.append(toast);
    }
    this.announce(item.message, tone === "error");
  }
}

export function confirmDiscard(message = "Discard your unsaved changes?"): boolean {
  return window.confirm(message);
}

export function confirmation(
  overlays: OverlayManager,
  options: { title: string; message: string; confirmLabel: string; destructive?: boolean; returnFocus?: HTMLElement | null | undefined },
): Promise<boolean> {
  const promiseConstructor = Promise as PromiseConstructor & {
    withResolvers<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason?: unknown): void };
  };
  const { promise, resolve } = promiseConstructor.withResolvers<boolean>();
  const handle = overlays.open({ title: options.title, kind: "confirm", returnFocus: options.returnFocus, defaultFocus: "cancel", onClose: (value) => resolve(value === "confirm") });
  handle.body.append(el("p", { className: "confirm-copy", text: options.message }));
  const cancel = button("Cancel", { onClick: () => handle.close("cancel", true) });
  cancel.dataset.cancel = "true";
  const confirm = button(options.confirmLabel, { className: `button ${options.destructive ? "danger" : "primary"}`, onClick: () => handle.close("confirm", true) });
  handle.footer.append(cancel, confirm);
  return promise;
}
