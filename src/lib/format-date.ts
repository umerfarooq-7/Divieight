/** One date style across the buyer portal: "Oct 10, 2026". */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(`${value}T00:00:00`) // a bare date is a calendar day, not UTC midnight
      : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
