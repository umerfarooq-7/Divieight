/** CSV for the packet's sections: RFC 4180 quoting, UTF-8, CRLF line ends, and no cell that a spreadsheet would run as a formula. */
export type Cell = string | number | boolean | null | undefined;

const safe = (v: string) => (/^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? `'${v}` : v);

export function toCsv(headers: string[], rows: Cell[][]): string {
  const cell = (c: Cell) => {
    if (c === null || c === undefined) return "";
    const s = typeof c === "string" ? safe(c) : String(c);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
