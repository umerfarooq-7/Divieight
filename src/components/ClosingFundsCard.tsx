import type { ReactNode } from "react";
import { Banknote, ShieldAlert } from "lucide-react";
import {
  CLOSING_PRA8_NOTICE,
  CLOSING_STATUS_LABELS,
  CLOSING_SUBSTITUTE_NOTICE,
  ENROLLMENT_FEE_DOES_NOT_FUND,
  ENROLLMENT_FEE_FUNDS,
  type ClosingObligation,
  type ClosingTerms,
} from "@/lib/closing-funds";
import { formatDeadline, money } from "@/lib/earnest-money";

export const CLOSING_BADGE: Record<ClosingObligation["status"], string> = {
  pending: "bg-amber-100 text-amber-800",
  funded: "bg-emerald-100 text-emerald-800",
  late: "bg-orange-100 text-orange-800",
  missed: "bg-destructive/10 text-destructive",
};

/** One Buyer Account's Closing Funds Notice, as the buyer (and their agent) see it. */
export function ClosingFundsCard({
  obligation: o,
  terms,
  propertyLabel,
  eyebrow = "Closing Funds Notice",
  children,
}: {
  obligation: ClosingObligation;
  terms: ClosingTerms | null;
  propertyLabel: string;
  eyebrow?: string;
  children?: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">{eyebrow}</p>
          <h2 className="font-display text-lg font-semibold text-foreground">{propertyLabel}</h2>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-medium ${CLOSING_BADGE[o.status]}`}>
          {CLOSING_STATUS_LABELS[o.status]}
        </span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border bg-background p-4">
          <p className="text-xs text-muted-foreground">Exact amount to wire</p>
          <p className="font-display text-2xl font-semibold text-foreground">{money(o.amount)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Pro-rata for {o.shares} of eight shares
            {terms ? ` · ${money(terms.total_amount)} total for the buyer group` : ""}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-background p-4">
          <p className="text-xs text-muted-foreground">Wire deadline</p>
          <p className="text-sm font-medium text-foreground">{formatDeadline(o.funding_deadline)}</p>
          {o.funded_at ? (
            <p className="mt-1 text-xs text-emerald-700">
              Receipt confirmed by escrow {formatDeadline(o.funded_at)}
              {o.funded_reference ? ` · ref ${o.funded_reference}` : ""}
            </p>
          ) : null}
        </div>
      </div>

      {terms ? (
        <div className="mt-4 rounded-lg border border-border bg-background p-4 text-sm">
          <p className="flex items-center gap-2 font-medium text-foreground">
            <Banknote className="h-4 w-4 text-accent" />
            {terms.escrow_company}
          </p>
          <pre className="mt-2 whitespace-pre-wrap font-sans text-xs text-muted-foreground">
            {terms.escrow_account_details}
          </pre>
          {terms.escrow_reference ? (
            <p className="mt-2 text-xs text-muted-foreground">Reference: {terms.escrow_reference}</p>
          ) : null}
          <p className="mt-2 text-xs text-muted-foreground">
            Accepted methods: {(terms.funding_methods ?? ["Wire transfer"]).join(", ")}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Wire directly to escrow — divieight never receives, holds, or distributes closing funds.
          </p>
        </div>
      ) : null}

      <div className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
        <div className="rounded-lg border border-border bg-muted/40 p-3">
          <p className="font-semibold text-foreground">Your Platform Enrollment Fee already paid for</p>
          <ul className="mt-1 list-disc pl-4 text-muted-foreground">
            {ENROLLMENT_FEE_FUNDS.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-lg border border-border bg-muted/40 p-3">
          <p className="font-semibold text-foreground">This notice covers (not the Enrollment Fee)</p>
          <ul className="mt-1 list-disc pl-4 text-muted-foreground">
            {ENROLLMENT_FEE_DOES_NOT_FUND.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      </div>

      {o.is_substitute ? (
        <p className="mt-4 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          {CLOSING_SUBSTITUTE_NOTICE}
        </p>
      ) : null}

      <p className="mt-4 flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{CLOSING_PRA8_NOTICE}</span>
      </p>
      {children}
    </section>
  );
}
