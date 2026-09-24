import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { FileWarning, ShieldCheck } from "lucide-react";
import {
  AUTHORIZATION_ACTION_LABELS,
  authorizationStatusLabel,
  formatDeadline,
  type AuthorizationRequestRow,
  type PendingStage,
} from "@/lib/authorization";
import {
  listBuyerAuthorizations,
  type DiligenceGateBlocker,
} from "@/lib/authorization.functions";

export const Route = createFileRoute("/buyer/authorizations/")({
  head: () => ({
    meta: [
      { title: "Authorization requests — divieight" },
      {
        name: "description",
        content:
          "Review and expressly authorize each key moment in your divieight transaction.",
      },
      { property: "og:title", content: "Authorization requests — divieight" },
      {
        property: "og:description",
        content: "Review and expressly authorize each key moment in your divieight transaction.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: BuyerAuthorizations,
});

type Row = AuthorizationRequestRow & {
  propertyLabel: string;
  gateClear: boolean;
  gateBlocker: DiligenceGateBlocker;
  pendingStage: PendingStage | null;
};

function BuyerAuthorizations() {
  const load = useServerFn(listBuyerAuthorizations);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const result = await load({});
      setRows(result.rows as Row[]);
      setLoading(false);
    })();
  }, [load]);

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
        Buyer-Authorization Workflow
      </p>
      <h1 className="font-display text-2xl font-semibold text-foreground sm:text-3xl">
        Authorization requests
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Nothing is submitted, accepted or waived on your Buyer Account's behalf without your
        express confirmation here.
      </p>

      {loading ? (
        <p className="mt-10 text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="mt-8 rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
          No authorization requests yet. You'll be notified in your portal and by email the moment
          one is queued.
        </div>
      ) : (
        <ul className="mt-8 space-y-3">
          {rows.map((row) => {
            const blocked = row.status === "pending" && !row.gateClear;
            const buyerPending = row.gateBlocker === "buyer" || row.gateBlocker === "both";
            const bothPending = row.gateBlocker === "both";
            return (
              <li key={row.id} className="rounded-xl border border-border bg-card p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {AUTHORIZATION_ACTION_LABELS[row.action_type]}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">{row.propertyLabel}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Respond by {formatDeadline(row.deadline_at)}
                    </p>
                  </div>
                  {blocked ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-3 py-1 text-xs font-medium text-accent">
                      <FileWarning className="h-3.5 w-3.5" />
                      {bothPending ? "Review required (both)" : buyerPending ? "Document review required" : "Resident Agent review pending"}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium text-foreground">
                      <ShieldCheck className="h-3.5 w-3.5" />
                      {authorizationStatusLabel(row, row.pendingStage)}
                    </span>
                  )}
                </div>
                {blocked ? (
                  <>
                    <p className="mt-4 text-xs text-muted-foreground">
                      {bothPending
                        ? "Both you and your Resident Agent have unread documents — review yours first."
                        : buyerPending
                        ? "You have an unread required document — review it before you can act on this request."
                        : "Your Resident Agent still needs to review this document before you can proceed. No action is needed from you right now."}
                    </p>
                    {buyerPending ? (
                      <Link
                        to="/buyer/due-diligence/$id"
                        params={{ id: row.property_id }}
                        className="mt-2 inline-block text-sm font-medium text-primary hover:underline"
                      >
                        Review the required document
                      </Link>
                    ) : null}
                  </>
                ) : (
                  <Link
                    to="/buyer/authorizations/$id"
                    params={{ id: row.id }}
                    className="mt-4 inline-block text-sm font-medium text-primary hover:underline"
                  >
                    Review this request
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
