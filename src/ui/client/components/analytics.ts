import { analyticsTableCsv } from "../../../analytics/csv.js";
import type {
  AnalyticsChart,
  AnalyticsCoverageSource,
  AnalyticsCoverageState,
  AnalyticsDetailRef,
  AnalyticsMetric,
  AnalyticsSectionPayload,
  AnalyticsTable,
  AnalyticsUnit,
  AnalyticsWarning,
} from "../../../analytics/types.js";
import { button, el, statePanel } from "./primitives.js";

export const ANALYTICS_TAB_LABELS = {
  summary: "Summary",
  issues: "Issues & Flow",
  "pull-requests": "Pull Requests",
  contributors: "Contributors",
  milestones: "Milestones",
  repository: "Repository",
} as const;

const DETAIL_KINDS = new Set<AnalyticsDetailRef["kind"]>([
  "issue",
  "issue-event",
  "pull-request",
  "review",
  "person",
  "milestone",
  "release",
  "commit-week",
]);

const SVG_NS = "http://www.w3.org/2000/svg";
const CHART_WIDTH = 720;
const CHART_HEIGHT = 288;
const PLOT_LEFT = 64;
const PLOT_RIGHT = 20;
const PLOT_TOP = 20;
const PLOT_BOTTOM = 56;
const PLOT_WIDTH = CHART_WIDTH - PLOT_LEFT - PLOT_RIGHT;
const PLOT_HEIGHT = CHART_HEIGHT - PLOT_TOP - PLOT_BOTTOM;
const TABLE_PAGE_SIZE = 25;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: Math.abs(value) >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

export function formatAnalyticsValue(value: number | null, unit: AnalyticsUnit): string {
  if (value === null || !Number.isFinite(value)) return "Unavailable";
  const formatted = new Intl.NumberFormat("en", { maximumFractionDigits: unit === "days" || unit === "percent" ? 1 : 2 }).format(value);
  if (unit === "percent") return `${formatted}%`;
  if (unit === "days") return `${formatted} ${Math.abs(value) === 1 ? "day" : "days"}`;
  if (unit === "bytes") return `${formatted} bytes`;
  if (unit === "lines") return `${formatted} lines`;
  return formatted;
}

function coverageLabel(coverage: AnalyticsCoverageState): string {
  return coverage[0]?.toUpperCase() + coverage.slice(1);
}

function coverageTone(coverage: AnalyticsCoverageState): "neutral" | "success" | "warning" | "danger" {
  if (coverage === "complete") return "success";
  if (coverage === "error") return "danger";
  if (coverage === "partial" || coverage === "pending" || coverage === "unsupported") return "warning";
  return "neutral";
}

function warningText(warning: AnalyticsWarning): string {
  const excluded = warning.excluded > 0 ? ` ${warning.excluded} record${warning.excluded === 1 ? " was" : "s were"} excluded.` : "";
  return `${warning.message}${excluded}`;
}

export function renderWarnings(warnings: readonly AnalyticsWarning[], label = "Analytics warnings"): HTMLElement | null {
  if (!warnings.length) return null;
  const list = el("ul", { className: "analytics-warning-list" });
  for (const warning of warnings) list.append(el("li", {}, el("strong", { text: warning.source ?? warning.code }), document.createTextNode(` — ${warningText(warning)}`)));
  return el("aside", { className: "state-panel state-partial analytics-warnings", attrs: { "aria-label": label } }, el("strong", { text: label }), list);
}

export function renderCoverage(sources: readonly AnalyticsCoverageSource[]): HTMLElement {
  const list = el("ul", { className: "coverage-list" });
  for (const source of sources) {
    const count = source.knownTotal === null ? `${source.loaded} loaded` : `${source.loaded} of ${source.knownTotal} loaded`;
    const limitations = source.limitations.length ? el("ul", { className: "coverage-limitations" }, ...source.limitations.map((item) => el("li", { text: item }))) : null;
    list.append(el("li", { className: `coverage-source coverage-${source.state}` },
      el("div", { className: "coverage-source-heading" },
        el("strong", { text: source.label }),
        el("span", { className: `badge badge-${coverageTone(source.state)}`, text: coverageLabel(source.state) }),
      ),
      el("p", { text: `${count}${source.excluded ? ` · ${source.excluded} excluded` : ""}` }),
      source.reason ? el("p", { text: source.reason }) : null,
      limitations,
    ));
  }
  const details = el("details", { className: "coverage-details" });
  details.append(el("summary", { text: `Data coverage (${sources.length} source${sources.length === 1 ? "" : "s"})` }), list);
  return details;
}

function activateWithKeyboard(node: SVGElement, action: () => void): void {
  node.addEventListener("click", action);
  node.addEventListener("keydown", (event) => {
    if (!(event instanceof KeyboardEvent) || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    action();
  });
}

export function renderMetricCards(metrics: readonly AnalyticsMetric[], onDrilldown: (detail: AnalyticsDetailRef, title: string) => void): HTMLElement {
  const list = el("ul", { className: "analytics-metrics", attrs: { "aria-label": "Analytics key metrics" } });
  for (const metric of metrics) {
    const card = button(metric.label, { className: "analytics-metric", onClick: () => onDrilldown(metric.detail, metric.label) });
    card.setAttribute("aria-label", `${metric.label}: ${formatAnalyticsValue(metric.value, metric.unit)}. Open supporting records.`);
    const comparison = metric.previousValue === null
      ? null
      : el("span", { className: "metric-comparison", text: metric.changePercent === null
        ? `Previous ${formatAnalyticsValue(metric.previousValue, metric.unit)} · change unavailable`
        : `${metric.changePercent > 0 ? "+" : ""}${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(metric.changePercent)}% from previous`,
      });
    const contents: HTMLElement[] = [
      el("span", { className: "metric-card-topline" },
        el("span", { className: "metric-label", text: metric.label }),
        el("span", { className: `badge badge-${coverageTone(metric.coverage)}`, text: coverageLabel(metric.coverage) }),
      ),
      el("strong", { className: "analytics-metric-value", text: formatAnalyticsValue(metric.value, metric.unit) }),
    ];
    if (comparison) contents.push(comparison);
    if (metric.warnings.length) contents.push(el("span", { className: "metric-warning", text: metric.warnings.map(warningText).join(" ") }));
    const filterBasis = metric.filterBasis === "not-applicable" ? "Filters not applicable" : metric.filterBasis === "event-time" ? "Event-time filters" : metric.filterBasis === "current-fields" ? "Current-field filters" : "Record-field filters";
    contents.push(
      el("span", { className: "metric-context", text: metric.kind === "current" ? `Current state · period dates do not apply · ${filterBasis}` : `${metric.sampleSize} source record${metric.sampleSize === 1 ? "" : "s"} · ${filterBasis}` }),
      el("span", { className: "metric-calculation", text: metric.calculation }),
    );
    card.replaceChildren(...contents);
    list.append(el("li", {}, card));
  }
  return list;
}

function chartCategories(chart: AnalyticsChart): string[] {
  const categories: string[] = [];
  const seen = new Set<string>();
  for (const series of chart.series) for (const point of series.points) if (!seen.has(point.key)) {
    seen.add(point.key);
    categories.push(point.key);
  }
  return categories;
}

interface ChartExtent {
  minimum: number;
  maximum: number;
}

function chartExtent(chart: AnalyticsChart, categories: readonly string[]): ChartExtent {
  if (chart.kind === "stacked-bar") {
    const positive = categories.map((key) => chart.series.reduce((total, series) => {
      const value = series.points.find((point) => point.key === key)?.value ?? 0;
      return total + Math.max(0, value);
    }, 0));
    const negative = categories.map((key) => chart.series.reduce((total, series) => {
      const value = series.points.find((point) => point.key === key)?.value ?? 0;
      return total + Math.min(0, value);
    }, 0));
    return { minimum: Math.min(0, ...negative), maximum: Math.max(0, ...positive) };
  }
  const values = chart.series.flatMap((series) => series.points.map((point) => point.value));
  return { minimum: Math.min(0, ...values), maximum: Math.max(0, ...values) };
}

function chartY(value: number, extent: ChartExtent): number {
  const span = extent.maximum - extent.minimum;
  return span === 0 ? PLOT_TOP + PLOT_HEIGHT : PLOT_TOP + (extent.maximum - value) / span * PLOT_HEIGHT;
}

function pointLabel(chart: AnalyticsChart, seriesLabel: string, categoryLabel: string, value: number): string {
  return `${seriesLabel}, ${categoryLabel}: ${formatAnalyticsValue(value, chart.unit)}`;
}

function appendChartAxes(root: SVGSVGElement, categories: readonly string[], categoryLabels: ReadonlyMap<string, string>, extent: ChartExtent): void {
  const tickValues = [extent.minimum, extent.minimum / 2, 0, extent.maximum / 2, extent.maximum].filter((value, index, values) => values.indexOf(value) === index).sort((left, right) => left - right);
  for (const value of tickValues) {
    const y = chartY(value, extent);
    root.append(svg("line", { x1: String(PLOT_LEFT), x2: String(CHART_WIDTH - PLOT_RIGHT), y1: String(y), y2: String(y), class: value === 0 ? "chart-zero-line" : "chart-grid-line" }));
    const label = svg("text", { x: String(PLOT_LEFT - 8), y: String(y + 4), class: "chart-axis-label", "text-anchor": "end" });
    label.textContent = compactNumber(value);
    root.append(label);
  }
  const stride = Math.max(1, Math.ceil(categories.length / 8));
  categories.forEach((key, index) => {
    if (index % stride !== 0 && index !== categories.length - 1) return;
    const x = PLOT_LEFT + (index + .5) * (PLOT_WIDTH / Math.max(1, categories.length));
    const label = svg("text", { x: String(x), y: String(CHART_HEIGHT - 24), class: "chart-axis-label", "text-anchor": "middle" });
    const full = categoryLabels.get(key) ?? key;
    label.textContent = full.length > 18 ? `${full.slice(0, 17)}…` : full;
    root.append(label);
  });
}

function renderBars(chart: AnalyticsChart, root: SVGSVGElement, categories: readonly string[], extent: ChartExtent, onDrilldown: (detail: AnalyticsDetailRef, title: string) => void): void {
  const slot = PLOT_WIDTH / Math.max(1, categories.length);
  const groupedWidth = slot * .76;
  const barWidth = groupedWidth / Math.max(1, chart.series.length);
  categories.forEach((key, categoryIndex) => {
    let positiveStack = 0;
    let negativeStack = 0;
    chart.series.forEach((series, seriesIndex) => {
      const point = series.points.find((candidate) => candidate.key === key);
      if (!point) return;
      const startValue = chart.kind === "stacked-bar" ? point.value >= 0 ? positiveStack : negativeStack : 0;
      const endValue = startValue + point.value;
      const startY = chartY(startValue, extent);
      const endY = chartY(endValue, extent);
      const x = chart.kind === "stacked-bar"
        ? PLOT_LEFT + categoryIndex * slot + slot * .12
        : PLOT_LEFT + categoryIndex * slot + slot * .12 + seriesIndex * barWidth;
      const group = svg("g", { role: "button", tabindex: "0", class: "chart-mark", "aria-label": `${pointLabel(chart, series.label, point.label, point.value)}. Open supporting records.` });
      const title = svg("title");
      title.textContent = pointLabel(chart, series.label, point.label, point.value);
      const rect = svg("rect", {
        x: String(x),
        y: String(Math.min(startY, endY)),
        width: String(chart.kind === "stacked-bar" ? groupedWidth : Math.max(1, barWidth - 2)),
        height: String(Math.abs(endY - startY)),
        class: `chart-series-${seriesIndex % 8}`,
      });
      group.append(title, rect);
      activateWithKeyboard(group, () => onDrilldown(point.detail, `${chart.title}: ${point.label}`));
      root.append(group);
      if (chart.kind === "stacked-bar") {
        if (point.value >= 0) positiveStack = endValue;
        else negativeStack = endValue;
      }
    });
  });
}

function renderLines(chart: AnalyticsChart, root: SVGSVGElement, categories: readonly string[], extent: ChartExtent, onDrilldown: (detail: AnalyticsDetailRef, title: string) => void): void {
  const slot = PLOT_WIDTH / Math.max(1, categories.length);
  chart.series.forEach((series, seriesIndex) => {
    const coordinates = categories.map((key, index) => {
      const point = series.points.find((candidate) => candidate.key === key);
      if (!point) return null;
      return {
        point,
        x: PLOT_LEFT + (index + .5) * slot,
        y: chartY(point.value, extent),
      };
    }).filter((item): item is NonNullable<typeof item> => item !== null);
    if (coordinates.length) root.append(svg("polyline", { points: coordinates.map(({ x, y }) => `${x},${y}`).join(" "), class: `chart-line chart-stroke-${seriesIndex % 8}` }));
    for (const coordinate of coordinates) {
      const group = svg("g", { role: "button", tabindex: "0", class: "chart-mark", "aria-label": `${pointLabel(chart, series.label, coordinate.point.label, coordinate.point.value)}. Open supporting records.` });
      const title = svg("title");
      title.textContent = pointLabel(chart, series.label, coordinate.point.label, coordinate.point.value);
      group.append(title, svg("circle", { cx: String(coordinate.x), cy: String(coordinate.y), r: "5", class: `chart-series-${seriesIndex % 8}` }));
      activateWithKeyboard(group, () => onDrilldown(coordinate.point.detail, `${chart.title}: ${coordinate.point.label}`));
      root.append(group);
    }
  });
}

function renderStaticTable(columns: AnalyticsChart["tableColumns"], rows: AnalyticsChart["tableRows"], title: string): HTMLTableElement {
  const table = el("table", { className: "data-table analytics-alternative-table" });
  table.append(el("caption", { text: `${title} data` }));
  const head = el("thead", {}, el("tr"));
  for (const column of columns) head.firstElementChild?.append(el("th", { text: column.label, attrs: { scope: "col" } }));
  const body = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    columns.forEach((column, index) => {
      const cell = index === 0 ? el("th", { attrs: { scope: "row" } }) : el("td", { attrs: { "data-label": column.label } });
      cell.textContent = displayCell(row[column.key]);
      tr.append(cell);
    });
    body.append(tr);
  }
  table.append(head, body);
  return table;
}

export function renderAnalyticsChart(chart: AnalyticsChart, onDrilldown: (detail: AnalyticsDetailRef, title: string) => void, onDownload: (tableId: string) => void): HTMLElement {
  const headingId = `analytics-chart-${crypto.randomUUID()}`;
  const descriptionId = `${headingId}-description`;
  const section = el("section", { className: "analytics-chart-card", attrs: { "aria-labelledby": headingId } },
    el("header", { className: "analytics-section-heading" },
      el("div", {}, el("h2", { id: headingId, text: chart.title }), el("p", { id: descriptionId, text: chart.description })),
      button("Download full CSV", { className: "button compact", onClick: () => onDownload(chart.id) }),
    ),
  );
  if (!chart.series.some((series) => series.points.length)) {
    section.append(statePanel("empty", "No chart data", "The returned series contains no points for this scope."));
  } else {
    const categories = chartCategories(chart);
    const categoryLabels = new Map<string, string>();
    for (const series of chart.series) for (const point of series.points) if (!categoryLabels.has(point.key)) categoryLabels.set(point.key, point.label);
    const extent = chartExtent(chart, categories);
    const wrapper = el("div", { className: "native-chart" });
    const graphic = svg("svg", { viewBox: `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`, role: "img", "aria-labelledby": `${headingId} ${descriptionId}`, preserveAspectRatio: "xMidYMid meet" });
    appendChartAxes(graphic, categories, categoryLabels, extent);
    if (chart.kind === "line") renderLines(chart, graphic, categories, extent, onDrilldown);
    else renderBars(chart, graphic, categories, extent, onDrilldown);
    const legend = el("ul", { className: "chart-legend", attrs: { "aria-label": `${chart.title} legend` } });
    chart.series.forEach((series, index) => legend.append(el("li", {}, el("span", { className: `legend-swatch chart-series-${index % 8}`, attrs: { "aria-hidden": "true" } }), el("span", { text: series.label }))));
    wrapper.append(graphic, legend);
    section.append(wrapper);
  }
  const alternative = el("details", { className: "chart-alternative" });
  alternative.append(el("summary", { text: `View data table for ${chart.title}` }), el("div", { className: "table-scroll" }, renderStaticTable(chart.tableColumns, chart.tableRows, chart.title)));
  section.append(alternative);
  const warnings = renderWarnings(chart.warnings, `${chart.title} warnings`);
  if (warnings) section.append(warnings);
  return section;
}

function displayCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

const DRILLDOWN_PRIORITY_FACTS: Record<string, true> = {
  type: true,
  event: true,
  status: true,
  statusFrom: true,
  statusTo: true,
  label: true,
  rename: true,
  renameFrom: true,
  renameTo: true,
};

const DRILLDOWN_FACT_LABELS: Record<string, string> = {
  eventId: "Event ID",
  issue: "Issue",
  pull: "Pull request",
  type: "Event",
  createdAt: "Occurred",
  reviewState: "Review state",
  rename: "Title change",
  renameFrom: "Previous title",
  renameTo: "New title",
  statusFrom: "Previous status",
  statusTo: "New status",
};


function drilldownFactValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object" && !Array.isArray(value)) {
    const rename = value as { from?: unknown; to?: unknown };
    if (typeof rename.from === "string" && typeof rename.to === "string") return `${rename.from} → ${rename.to}`;
  }
  return "Unavailable";
}

export function renderAnalyticsDrilldownFacts(row: Record<string, unknown>): HTMLElement {
  const entries = Object.entries(row).filter(([key]) => !key.startsWith("_") && !key.toLowerCase().includes("url"));
  const selected = entries.slice(0, 4);
  const selectedKeys = new Set(selected.map(([key]) => key));
  for (const entry of entries) {
    if (DRILLDOWN_PRIORITY_FACTS[entry[0]] && !selectedKeys.has(entry[0])) {
      selected.push(entry);
      selectedKeys.add(entry[0]);
    }
  }
  const facts = el("dl", { className: "drilldown-facts" });
  for (const [key, value] of selected) {
    const label = DRILLDOWN_FACT_LABELS[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
    facts.append(el("div", {}, el("dt", { text: label }), el("dd", { text: drilldownFactValue(value) })));
  }
  return facts;
}

function detailFromRow(row: Record<string, string | number | boolean | null>): AnalyticsDetailRef | null {
  const kind = row._detailKind;
  const rawIds = row._detailIds;
  if (typeof kind !== "string" || !DETAIL_KINDS.has(kind as AnalyticsDetailRef["kind"])) return null;
  const ids = Array.isArray(rawIds) ? rawIds.map(String) : String(rawIds ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  return ids.length ? { kind: kind as AnalyticsDetailRef["kind"], ids } : null;
}

function compareCells(left: unknown, right: unknown, numeric: boolean): number {
  if (left === null || left === undefined) return right === null || right === undefined ? 0 : 1;
  if (right === null || right === undefined) return -1;
  if (numeric) return Number(left) - Number(right);
  return String(left).localeCompare(String(right), "en", { numeric: true, sensitivity: "base" });
}

export interface AnalyticsTableController {
  element: HTMLElement;
  focusSearch(): void;
}

export function renderAnalyticsTable(table: AnalyticsTable, onDrilldown: (detail: AnalyticsDetailRef, title: string) => void, onDownload: (tableId: string) => void): AnalyticsTableController {
  const section = el("section", { className: "analytics-detail-table" });
  let search = "";
  let sortKey = table.columns[0]?.key ?? "";
  let sortDirection: "ascending" | "descending" = "ascending";
  let page = 1;

  const render = (restoreFocus?: string): void => {
    const normalizedSearch = search.trim().toLocaleLowerCase();
    const filtered = table.rows.filter((row) => !normalizedSearch || table.columns.some((column) => displayCell(row[column.key]).toLocaleLowerCase().includes(normalizedSearch)));
    const column = table.columns.find((candidate) => candidate.key === sortKey);
    const sorted = filtered.map((row, index) => ({ row, index })).sort((left, right) => {
      const order = compareCells(left.row[sortKey], right.row[sortKey], column?.numeric ?? false);
      return (order || left.index - right.index) * (sortDirection === "ascending" ? 1 : -1);
    }).map(({ row }) => row);
    const pageCount = Math.max(1, Math.ceil(sorted.length / TABLE_PAGE_SIZE));
    page = Math.min(page, pageCount);
    const start = (page - 1) * TABLE_PAGE_SIZE;
    const visible = sorted.slice(start, start + TABLE_PAGE_SIZE);
    const headingId = `analytics-table-${table.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const searchInput = el("input", { attrs: { type: "search", value: search, placeholder: "Search returned rows", autocomplete: "off", "aria-label": `Search ${table.title}`, "data-focus-key": "table-search" } });
    searchInput.value = search;
    searchInput.addEventListener("input", () => {
      search = searchInput.value;
      page = 1;
      render("table-search");
    });
    const header = el("header", { className: "analytics-section-heading" },
      el("div", {}, el("h2", { id: headingId, text: table.title }), el("p", { text: table.description })),
      button("Download full CSV", { className: "button compact", onClick: () => onDownload(table.id) }),
    );
    const tableElement = el("table", { className: "data-table" });
    tableElement.append(el("caption", { text: `${table.title}. ${table.scope}.` }));
    const headRow = el("tr");
    for (const item of table.columns) {
      const sort = button(item.label, { className: "table-sort", onClick: () => {
        if (sortKey === item.key) sortDirection = sortDirection === "ascending" ? "descending" : "ascending";
        else {
          sortKey = item.key;
          sortDirection = "ascending";
        }
        page = 1;
        render(`sort-${item.key}`);
      } });
      sort.dataset.focusKey = `sort-${item.key}`;
      sort.setAttribute("aria-label", `Sort ${table.title} by ${item.label}${sortKey === item.key ? `, currently ${sortDirection}` : ""}`);
      const th = el("th", { attrs: { scope: "col" } }, sort);
      if (sortKey === item.key) th.setAttribute("aria-sort", sortDirection);
      headRow.append(th);
    }
    tableElement.append(el("thead", {}, headRow));
    const body = el("tbody");
    for (const row of visible) {
      const tr = el("tr");
      const detail = detailFromRow(row);
      table.columns.forEach((item, index) => {
        const text = displayCell(row[item.key]);
        const cell = index === 0 ? el("th", { attrs: { scope: "row" } }) : el("td", { attrs: { "data-label": item.label } });
        if (index === 0 && detail) cell.append(button(text, { className: "table-title", onClick: () => onDrilldown(detail, `${table.title}: ${text}`) }));
        else cell.textContent = text;
        tr.append(cell);
      });
      body.append(tr);
    }
    tableElement.append(body);
    const count = el("p", { className: "table-range", attrs: { role: "status", "aria-live": "polite" }, text: sorted.length
      ? `Showing ${start + 1}–${Math.min(start + TABLE_PAGE_SIZE, sorted.length)} of ${sorted.length} matching rows · ${table.total} total · ${table.scope}`
      : `No matching rows · ${table.total} total · ${table.scope}`,
    });
    const pagination = el("nav", { className: "table-pagination", attrs: { "aria-label": `${table.title} pages` } },
      button("Previous", { className: "button compact", disabled: page === 1, onClick: () => { page -= 1; render("page-previous"); } }),
      el("span", { text: `Page ${page} of ${pageCount}` }),
      button("Next", { className: "button compact", disabled: page === pageCount, onClick: () => { page += 1; render("page-next"); } }),
    );
    (pagination.firstElementChild as HTMLElement | null)?.setAttribute("data-focus-key", "page-previous");
    (pagination.lastElementChild as HTMLElement | null)?.setAttribute("data-focus-key", "page-next");
    const content = visible.length ? el("div", { className: "table-scroll" }, tableElement) : statePanel("empty", "No rows match", "Clear the table search to see the returned full-scope rows.");
    section.replaceChildren(header, el("div", { className: "analytics-table-tools" }, searchInput, count), content, pagination);
    const warnings = renderWarnings(table.warnings, `${table.title} warnings`);
    if (warnings) section.append(warnings);
    if (restoreFocus) {
      const next = section.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(restoreFocus)}"]`);
      next?.focus({ preventScroll: true });
      if (next instanceof HTMLInputElement) next.setSelectionRange(next.value.length, next.value.length);
    }
  };

  render();
  return { element: section, focusSearch: () => section.querySelector<HTMLInputElement>('input[type="search"]')?.focus() };
}

export function triggerAnalyticsCsv(payload: AnalyticsSectionPayload, tableId: string): void {
  const csv = analyticsTableCsv(payload, tableId);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = el("a", { attrs: { href: url, download: `gitasks-${payload.section}-${tableId.replace(/[^a-zA-Z0-9_-]/g, "-")}.csv` } });
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
