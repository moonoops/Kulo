export interface DataColumn {
  key: string;
  label: string;
}

export type DataRow = Record<string, string | number | boolean | null>;

function csvCell(value: DataRow[string] | undefined): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (typeof value === "string" && (/^[\s\u0000-\u001f\u007f\u200b\ufeff]*[=+\-@＝＋－＠]/u.test(text) || /^[\t\r\n]/u.test(text))) {
    // Quoting alone does not stop spreadsheet formulas; a leading tab keeps these strings literal in Excel.
    text = `\t${text}`;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

export function buildTableCsv(columns: readonly DataColumn[], rows: readonly DataRow[]): string {
  const names = new Set(columns.map((column) => column.key));
  const completeColumns = [...columns];
  for (const row of rows) for (const key of Object.keys(row)) {
    if (!names.has(key)) {
      names.add(key);
      completeColumns.push({ key, label: key });
    }
  }
  return [
    completeColumns.map((column) => csvCell(column.label)).join(","),
    ...rows.map((row) => completeColumns.map((column) => csvCell(row[column.key])).join(",")),
  ].join("\r\n") + "\r\n";
}

export function tableCsvFileName(caption?: string): string {
  const name = (caption || "数据表").replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_").trim().replace(/^\.+/u, "").trim().slice(0, 80);
  return `${name || "数据表"}.csv`;
}
