import type { AnalyticsSectionPayload } from "./types.js";

function safeCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
}

function csvCell(value: string | number | boolean | null | undefined): string {
  const safe = safeCell(value);
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function metadata(label: string, value: string | number | boolean | null): string {
  return [csvCell(`# ${label}`), csvCell(value)].join(",");
}

export function analyticsTableCsv(payload: AnalyticsSectionPayload, tableId: string): string {
  const detailTable = payload.tables.find((table) => table.id === tableId);
  const chart = payload.charts.find((candidate) => candidate.id === tableId);
  if (detailTable === undefined && chart === undefined) {
    throw new Error(`Analytics table not found: ${tableId}`);
  }

  const columns = detailTable?.columns ?? chart!.tableColumns;
  const rows = detailTable?.rows ?? chart!.tableRows;
  const state = detailTable?.coverage ?? chart!.coverage;
  const repository = payload.repository?.name ?? "Unavailable in section payload";
  const filterText = JSON.stringify({
    milestone: payload.filters.milestone,
    labels: payload.filters.labels,
    person: payload.filters.person,
    role: payload.filters.role,
    includeBots: payload.filters.includeBots,
    staleDays: payload.filters.staleDays,
    reviewWaitDays: payload.filters.reviewWaitDays,
  });
  const lines = [
    metadata("Repository", repository),
    metadata("Metric/table ID", tableId),
    metadata("Section", payload.section),
    metadata("Period from", payload.period.from),
    metadata("Period to (exclusive)", payload.period.to),
    metadata("Time zone", payload.period.timezone),
    metadata("Grouping", payload.period.grouping),
    metadata("Incomplete", payload.period.incomplete),
    metadata("Filters", filterText),
    metadata("Scope", detailTable?.scope ?? payload.scope),
    metadata("Coverage", state),
    metadata("Calculated at", payload.computedAt),
    "",
    columns.map((column) => csvCell(column.label)).join(","),
  ];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row[column.key])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
