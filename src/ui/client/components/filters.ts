import type { Router } from "../router.js";
import { button, el } from "./primitives.js";

export interface FilterChip {
  label: string;
  parameter: string;
  value?: string;
}

export function searchField(value: string, placeholder: string, onChange: (value: string) => void): HTMLLabelElement {
  const input = el("input", { attrs: { type: "search", value, placeholder, autocomplete: "off" } });
  input.value = value;
  let timer: number | undefined;
  input.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => onChange(input.value), 180);
  });
  return el("label", { className: "search-field" }, el("span", { className: "visually-hidden", text: "Search" }), input);
}

export function segmented(
  label: string,
  value: string,
  options: ReadonlyArray<{ value: string; label: string }>,
  onChange: (value: string) => void,
): HTMLElement {
  const group = el("div", { className: "segmented", attrs: { role: "radiogroup", "aria-label": label } });
  for (const option of options) {
    const control = button(option.label, { className: "segment", onClick: () => onChange(option.value) });
    control.setAttribute("role", "radio");
    control.setAttribute("aria-checked", String(option.value === value));
    group.append(control);
  }
  return group;
}

export function selectField(label: string, value: string, options: ReadonlyArray<{ value: string; label: string }>, onChange: (value: string) => void): HTMLLabelElement {
  const select = el("select");
  for (const option of options) {
    const item = el("option", { text: option.label, attrs: { value: option.value } });
    item.selected = option.value === value;
    select.append(item);
  }
  select.addEventListener("change", () => onChange(select.value));
  return el("label", { className: "select-field" }, el("span", { text: label }), select);
}

export function chipBar(router: Router, chips: readonly FilterChip[], onClear: () => void): HTMLElement | null {
  if (!chips.length) return null;
  const region = el("div", { className: "active-filters", attrs: { "aria-label": "Active filters" } });
  for (const chip of chips) {
    const remove = button(`${chip.label} ×`, { className: "filter-chip", onClick: () => {
      router.updateQuery((query) => {
        if (chip.value === undefined) query.delete(chip.parameter);
        else {
          const remaining = query.getAll(chip.parameter).filter((value) => value !== chip.value);
          query.delete(chip.parameter);
          for (const value of remaining) query.append(chip.parameter, value);
        }
      });
    } });
    remove.setAttribute("aria-label", `Remove filter ${chip.label}`);
    region.append(remove);
  }
  region.append(button("Clear filters", { className: "button link-button", onClick: onClear }));
  return region;
}

export function filterDetails(label: string, count: number, content: HTMLElement): HTMLDetailsElement {
  const details = el("details", { className: "filter-details" });
  const summary = el("summary", { className: "button secondary", text: `${label}${count ? ` (${count})` : ""}` });
  details.append(summary, el("div", { className: "filter-sheet" }, el("div", { className: "filter-sheet-header" }, el("strong", { text: label }), button("Done", { className: "button compact sheet-close", onClick: () => { details.open = false; } })), content));
  details.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && details.open) {
      event.preventDefault();
      event.stopPropagation();
      details.open = false;
      summary.focus();
    }
  });
  return details;
}

export function checkboxGroup(label: string, name: string, values: ReadonlyArray<string | { value: string; label: string }>, selected: readonly string[], onChange: (next: string[]) => void): HTMLFieldSetElement {
  const fieldset = el("fieldset", { className: "check-group" });
  fieldset.append(el("legend", { text: label }));
  for (const item of values) {
    const value = typeof item === "string" ? item : item.value;
    const display = typeof item === "string" ? item : item.label;
    const input = el("input", { attrs: { type: "checkbox", value, name } });
    input.checked = selected.includes(value);
    input.addEventListener("change", () => {
      const next = [...fieldset.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')].map((node) => node.value);
      onChange(next);
    });
    fieldset.append(el("label", {}, input, el("span", { text: display })));
  }
  return fieldset;
}
