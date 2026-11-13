import { Link } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { TAX_FORM_GATE_MESSAGE } from "@/lib/payment-gate";

/**
 * Hard payment gate warning shown on the broker's Professional Portal when
 * their W-9/W-8 is not on file. Commission is paid at closing by title/escrow
 * from sale proceeds — it cannot be released without the tax form.
 */
export function TaxFormGateBanner() {
  return (
    <div className="flex flex-wrap items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-4">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-destructive">{TAX_FORM_GATE_MESSAGE}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Commission disbursement at closing is blocked for this brokerage until a completed
          W-9 (US) or W-8BEN / W-8BEN-E (non-US) is submitted and valid. A W-8 expires, so it is blocked again when it lapses.
        </p>
        <Link
          to="/broker/tax-form"
          className="mt-3 inline-flex items-center rounded-md bg-destructive px-3 py-2 text-sm font-medium text-destructive-foreground transition-opacity hover:opacity-90"
        >
          Submit your tax form
        </Link>
      </div>
    </div>
  );
}
