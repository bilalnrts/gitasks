import type { OverlayManager } from "./overlays.js";
import { button, el } from "./primitives.js";

export interface PickerOption {
  value: string;
  label: string;
  description?: string | undefined;
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
}

export interface PickerConfig {
  title: string;
  label: string;
  options: readonly PickerOption[];
  selected: readonly string[];
  multiple?: boolean | undefined;
  allowNone?: boolean | undefined;
  noneLabel?: string | undefined;
  disabledReason?: string | undefined;
  returnFocus?: HTMLElement | null | undefined;
}

interface PromiseResolvers<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function withResolvers<T>(): PromiseResolvers<T> {
  const promiseConstructor = Promise as PromiseConstructor & { withResolvers<U>(): PromiseResolvers<U> };
  return promiseConstructor.withResolvers<T>();
}

export function openPicker(overlays: OverlayManager, config: PickerConfig): Promise<string[] | undefined> {
  const { promise, resolve } = withResolvers<string[] | undefined>();
  const handle = overlays.open({ title: config.title, eyebrow: config.label, kind: "form", returnFocus: config.returnFocus, onClose: (value) => resolve(value === "apply" ? collect() : undefined) });
  const selected = new Set(config.selected);
  const search = el("input", { className: "picker-search", attrs: { type: "search", placeholder: `Search ${config.label.toLowerCase()}`, "aria-label": `Search ${config.label}` } });
  const list = el("div", { className: "picker-options", attrs: { role: config.multiple ? "group" : "radiogroup", "aria-label": config.label } });
  const inputs: HTMLInputElement[] = [];

  const addOption = (option: PickerOption, none = false): void => {
    const id = `picker-${crypto.randomUUID()}`;
    const input = el("input", { attrs: { id, type: config.multiple ? "checkbox" : "radio", name: "picker-option", value: option.value } });
    input.checked = selected.has(option.value) || (none && selected.size === 0);
    input.disabled = option.disabled ?? false;
    const copy = el("span", { className: "picker-option-copy" }, el("strong", { text: option.label }), option.description ? el("small", { text: option.description }) : null, option.disabledReason ? el("small", { className: "permission-note", text: option.disabledReason }) : null);
    list.append(el("label", { className: "picker-option", attrs: { for: id } }, input, copy));
    inputs.push(input);
  };

  if (config.allowNone) addOption({ value: "", label: config.noneLabel ?? "None" }, true);
  for (const option of config.options) addOption(option);
  const empty = el("p", { className: "state-inline", text: "No options match your search." });
  empty.hidden = true;
  const renderFilter = (): void => {
    const query = search.value.trim().toLowerCase();
    let visible = 0;
    for (const label of list.querySelectorAll<HTMLLabelElement>("label")) {
      const show = !query || (label.textContent ?? "").toLowerCase().includes(query);
      label.hidden = !show;
      if (show) visible += 1;
    }
    empty.hidden = visible > 0;
  };
  search.addEventListener("input", renderFilter);
  handle.body.append(search);
  if (config.disabledReason) handle.body.append(el("p", { className: "permission-note", text: config.disabledReason }));
  handle.body.append(list, empty);
  const cancel = button("Cancel", { onClick: () => handle.close("cancel", true) });
  cancel.dataset.cancel = "true";
  const apply = button("Apply", { className: "button primary", disabled: Boolean(config.disabledReason), title: config.disabledReason, onClick: () => handle.close("apply", true) });
  handle.footer.append(cancel, apply);

  function collect(): string[] {
    return inputs.filter((input) => input.checked && input.value).map((input) => input.value);
  }

  return promise;
}
