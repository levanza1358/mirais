type Cell = string | number | boolean | undefined | null;

function escapeCell(value: Cell): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes("\"") || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function toCsv<T extends Record<string, Cell>>(rows: T[], columns?: Array<keyof T>): string {
  if (rows.length === 0 && !columns?.length) return "";
  const cols = (columns ?? (Object.keys(rows[0] ?? {}) as Array<keyof T>)) as Array<keyof T>;
  const header = cols.map((c) => escapeCell(String(c))).join(",");
  const body = rows
    .map((row) => cols.map((c) => escapeCell(row[c])).join(","))
    .join("\n");
  return `${header}\n${body}`;
}

export function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 500);
}