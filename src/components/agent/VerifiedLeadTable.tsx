import { Link } from "@tanstack/react-router";
import type { TetheredBuyer } from "@/lib/agent-leads.functions";
import { residencyLabel } from "@/lib/markets";
import { listingStatusLabel } from "@/components/ListingStatusTimeline";

/**
 * Read-only status view of the buyers tethered to the signed-in agent.
 * PII boundary: identity + status flags only — no vetting report contents.
 */

function Badge({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "muted";
  children: React.ReactNode;
}) {
  const cls =
    tone === "ok"
      ? "border-accent/50 bg-accent/10 text-accent"
      : tone === "warn"
        ? "border-destructive/40 bg-destructive/10 text-destructive"
        : "border-border bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${cls}`}
    >
      {children}
    </span>
  );
}

export function VerifiedLeadTable({
  buyers,
  loading,
}: {
  buyers: TetheredBuyer[];
  loading?: boolean;
}) {
  if (loading) return <p className="text-sm text-muted-foreground">Loading your buyers…</p>;

  if (buyers.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No buyers are tethered to you yet. Tethering happens automatically when a buyer in your
        markets earns their Digital Key, or when a buyer designates you by name.
      </p>
    );
  }

  return (
    <ul className="space-y-4">
      {buyers.map((b) => (
        <li key={b.buyerAccountId} className="rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground [overflow-wrap:anywhere]">
                {b.name}
              </p>
              <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {b.email} · Target market {b.market ?? "—"}
                {b.priorityRank ? ` · Priority rank #${b.priorityRank}` : ""}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge tone={b.residency === "resident" ? "ok" : "muted"}>
                {residencyLabel(b.residency)}
              </Badge>
              <Badge tone={b.goldenTicketIssued ? "ok" : "muted"}>
                {b.goldenTicketIssued ? "Digital Key issued" : "Digital Key pending"}
              </Badge>
              <Badge tone={b.pefStatus === "paid" ? "ok" : b.pefStatus === "pending" ? "muted" : "warn"}>
                PEF {b.pefStatus}
              </Badge>
              <Badge tone={b.liquidityVerified ? "ok" : "muted"}>
                Liquidity {b.liquidityVerified ? "verified" : b.liquidityStatus.replace(/_/g, " ")}
              </Badge>
            </div>
          </div>

          {/* Display-only reservation status — sourced from existing pod data. */}
          <div className="mt-3 space-y-1 text-xs">
            {b.reservations.length === 0 ? (
              <p className="text-muted-foreground">Not yet committed to a property</p>
            ) : (
              b.reservations.map((r) => (
                <p key={r.reservationId} className="text-muted-foreground">
                  <Link
                    to="/agent/pods/$id"
                    params={{ id: r.propertyId }}

                    className="font-medium text-foreground underline underline-offset-2 [overflow-wrap:anywhere]"
                  >
                    {r.label}
                  </Link>{" "}
                  · {r.sharesReserved} share{r.sharesReserved === 1 ? "" : "s"} reserved ·{" "}
                  {listingStatusLabel(r.listingStatus)}
                </p>
              ))
            )}
          </div>

          {/* Rev 49 counsel items D2(a)/D2(b): this stage and the Digital Key badge are what the agent saw before and are
              kept exactly. The stage comes through agentVisibleStage: a held account reads as Pending, with no reason. */}
          {/* Binary-vetting rule: discrete stage only — no computed progress
              score, percentage, or band derived from vetting/financial state. */}
          <div className="mt-2 text-[11px] text-muted-foreground">
            Onboarding stage: {b.onboardingStatus.replace(/_/g, " ")}
          </div>
        </li>
      ))}
    </ul>
  );
}
