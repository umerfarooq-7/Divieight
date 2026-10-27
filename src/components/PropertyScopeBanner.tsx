import { Link } from "@tanstack/react-router";
import { Building2 } from "lucide-react";

/**
 * Shown on a buyer list page opened from one property's card: makes the
 * property scope explicit and offers the all-properties view.
 */
export function PropertyScopeBanner({
  to,
  property,
  label,
}: {
  to: string;
  property: string | undefined;
  label: string | null | undefined;
}) {
  if (!property) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
      <span className="flex min-w-0 items-center gap-2 text-foreground">
        <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">
          Showing only <span className="font-medium">{label || "this property"}</span>
        </span>
      </span>
      <Link to={to} search={{}} className="text-xs font-medium text-primary hover:underline">
        Show all properties
      </Link>
    </div>
  );
}
