import type { ReactNode } from "react";
import { AlertTriangle, ExternalLink, FileText } from "lucide-react";
import {
  DELIVERY_NOTICE,
  FLAG_NOTICE,
  REPORT_TYPE_LABELS,
  formatReportDate,
  money,
  type PropertyReportRow,
} from "@/lib/reports";

/**
 * A delivered report exactly as received: metadata, the file, and any
 * non-substantive flags. No summary, rating or interpretation is rendered —
 * that restraint is the point of this component.
 */
export function ReportCard({
  report,
  signedUrl,
  superseded,
  propertyLabel,
  children,
}: {
  report: PropertyReportRow;
  signedUrl: string | null;
  superseded?: boolean;
  propertyLabel?: string;
  children?: ReactNode;
}) {
  return (
    <article className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {REPORT_TYPE_LABELS[report.report_type]}
            {superseded ? " · superseded by a revised report" : ""}
          </p>
          <h3 className="mt-1 font-display text-base font-semibold text-foreground">{report.title}</h3>
          {propertyLabel ? <p className="text-sm text-muted-foreground">{propertyLabel}</p> : null}
          <p className="mt-1 text-xs text-muted-foreground">
            {report.vendor_name ? `${report.vendor_name} · ` : ""}
            Report date {formatReportDate(report.report_date)} · received{" "}
            {formatReportDate(report.received_at)}
          </p>
          {report.report_type === "appraisal" && report.appraised_value != null ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Appraised value as stated in the report: {money(report.appraised_value)}
              {report.contract_price != null ? ` · contract price: ${money(report.contract_price)}` : ""}
            </p>
          ) : null}
        </div>
        {signedUrl ? (
          <a
            href={signedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-secondary"
          >
            <FileText className="h-4 w-4" /> Open report <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span className="text-xs text-muted-foreground">File link unavailable</span>
        )}
      </div>

      {report.flags.length > 0 ? (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide">
            <AlertTriangle className="h-3.5 w-3.5" /> Flagged finding
          </p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-sm">
            {report.flags.map((f, i) => (
              <li key={i}>{f.message}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs opacity-80">{FLAG_NOTICE}</p>
        </div>
      ) : null}

      <p className="mt-4 text-xs text-muted-foreground">{DELIVERY_NOTICE}</p>
      {children}
    </article>
  );
}
