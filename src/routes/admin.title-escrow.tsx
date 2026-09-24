import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { AlertTriangle, FlaskConical, Send } from "lucide-react";
import {
  listTitleEscrowAdmin,
  resolveTitleDiscrepancy,
  sendTitleClosingBundle,
  simulateTitleMilestone,
  type AdminTitleRow,
  type DepositScenario,
} from "@/lib/title-escrow.functions";
import { DISCREPANCY_LABELS, MILESTONE_LABELS } from "@/lib/title-escrow";
import { TitleStatusTracker } from "@/components/TitleStatusTracker";

export const Route = createFileRoute("/admin/title-escrow")({
  head: () => ({
    meta: [
      { title: "Title & escrow — divieight admin" },
      { name: "description", content: "Real-Time Handshake with the title/escrow company and the Title Certainty Monitor." },
      { property: "og:title", content: "Title & escrow — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminTitleEscrow,
});

function AdminTitleEscrow() {
  const qc = useQueryClient();
  const load = useServerFn(listTitleEscrowAdmin);
  const resolve = useServerFn(resolveTitleDiscrepancy);
  const { data, isLoading } = useQuery({ queryKey: ["admin-title-escrow"], queryFn: () => load() });
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin-title-escrow"] });

  const resolveMut = useMutation({
    mutationFn: (id: string) => {
      const note = window.prompt("How was this reconciled?");
      if (!note) throw new Error("cancelled");
      return resolve({ data: { discrepancyId: id, note } });
    },
    onSuccess: () => {
      toast.success("Marked resolved.");
      void refresh();
    },
    onError: (e: Error) => e.message !== "cancelled" && toast.error(e.message),
  });

  const open = (data?.discrepancies ?? []).filter((d) => d.status === "open");

  return (
    <div>
      <h1 className="font-display text-2xl font-semibold text-foreground">Title &amp; escrow</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Real-Time Handshake with the title/escrow company. Milestones update every Buyer, Seller, Resident Agent and
        Heavy Lifting Agent dashboard automatically.
      </p>
      {data && !data.webhookConfigured ? (
        <p className="mt-3 flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          <FlaskConical className="h-4 w-4 shrink-0" />
          SIMULATED integration — no Qualia partnership credentials yet. Closing Bundles are logged instead of sent, and
          milestone webhooks are fired from this panel through the same code path real webhooks will use.
        </p>
      ) : null}

      <section className="mt-6">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <AlertTriangle className="h-4 w-4 text-destructive" /> Open discrepancies ({open.length})
        </h2>
        {open.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">None — title and platform records agree.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {open.map((d) => (
              <li key={d.id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
                <div>
                  <p className="font-medium text-foreground">{DISCREPANCY_LABELS[d.kind] ?? d.kind}</p>
                  <p className="text-xs text-muted-foreground">
                    {d.label}
                    {d.buyer_account_id ? ` · Buyer Account ${d.buyer_account_id.slice(0, 8)}` : ""} ·{" "}
                    {new Date(d.created_at).toLocaleString()}
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground">{JSON.stringify(d.details)}</p>
                </div>
                <button onClick={() => resolveMut.mutate(d.id)} className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium">
                  Mark resolved
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <h2 className="mt-8 text-sm font-semibold text-foreground">Properties</h2>
      <div className="mt-3 space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (data?.rows ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No live pods.</p>
        ) : (
          data!.rows.map((row) => <PropertyPanel key={row.propertyId} row={row} onChange={refresh} />)
        )}
      </div>
    </div>
  );
}

function PropertyPanel({ row, onChange }: { row: AdminTitleRow; onChange: () => void }) {
  const send = useServerFn(sendTitleClosingBundle);
  const simulate = useServerFn(simulateTitleMilestone);
  const [override, setOverride] = useState("");
  const [scenario, setScenario] = useState<DepositScenario>("match_platform");
  const [closingDate, setClosingDate] = useState("");
  const [variance, setVariance] = useState("0");

  const sendMut = useMutation({
    mutationFn: () => send({ data: { propertyId: row.propertyId, manualOverrideReason: override || null } }),
    onSuccess: (r) => {
      toast.success(`Closing Bundle ${r.simulated ? "logged (simulated)" : "sent"} — order ${r.externalOrderId}.`);
      onChange();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const simMut = useMutation({
    mutationFn: () =>
      simulate({
        data: {
          propertyId: row.propertyId,
          milestone: row.next!,
          depositScenario: scenario,
          closingDate: closingDate || null,
          commissionVarianceCents: Number(variance) || 0,
        },
      }),
    onSuccess: (r) => {
      if (r.status === "processed")
        toast.success(
          `${MILESTONE_LABELS[r.milestone]} received${r.discrepancies ? ` — ${r.discrepancies} discrepancy(ies) flagged` : ""}${
            r.closingSaga ? ` · Closing Ping Saga: ${r.closingSaga}` : ""
          }.`,
        );
      else toast.error(`Webhook ${r.status}.`);
      onChange();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-base font-semibold text-foreground">{row.label}</h3>
        <p className="text-xs text-muted-foreground">
          {row.order
            ? `${row.order.provider} order ${row.order.external_order_id}${row.order.simulated ? " (simulated)" : ""} · ${row.order.status}`
            : row.acceptanceAuthorized
              ? "Offer accepted — ready to open title"
              : "Offer not yet accepted through Buyer-Authorization"}
        </p>
      </div>

      {!row.order ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          {!row.acceptanceAuthorized ? (
            <label className="text-xs text-muted-foreground">
              Reason to open title manually
              <input
                value={override}
                onChange={(e) => setOverride(e.target.value)}
                className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm sm:w-72"
              />
            </label>
          ) : null}
          <button
            onClick={() => sendMut.mutate()}
            disabled={sendMut.isPending || (!row.acceptanceAuthorized && !override.trim())}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            <Send className="h-4 w-4" /> Send Closing Bundle
          </button>
        </div>
      ) : (
        <>
          <div className="mt-3">
            <TitleStatusTracker status={row.status} />
          </div>
          {row.next ? (
            <div className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-border p-3">
              <p className="w-full text-xs font-medium text-muted-foreground">
                <FlaskConical className="mr-1 inline h-3.5 w-3.5" /> Simulate next webhook: {MILESTONE_LABELS[row.next]}
              </p>
              {row.next === "earnest_money_deposited" ? (
                <label className="text-xs text-muted-foreground">
                  Title company reports
                  <select
                    value={scenario}
                    onChange={(e) => setScenario(e.target.value as DepositScenario)}
                    className="mt-1 block rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  >
                    <option value="match_platform">Exactly what the platform shows as funded</option>
                    <option value="all_obligations">Every Buyer Account deposited (tests mismatch)</option>
                    <option value="none">No deposits received (tests mismatch)</option>
                  </select>
                </label>
              ) : null}
              {row.next === "closing_scheduled" ? (
                <label className="text-xs text-muted-foreground">
                  Closing date
                  <input
                    type="date"
                    value={closingDate}
                    onChange={(e) => setClosingDate(e.target.value)}
                    className="mt-1 block rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  />
                </label>
              ) : null}
              {row.next === "funded_and_recorded" ? (
                <label className="text-xs text-muted-foreground">
                  Title's commission figures differ by (cents)
                  <input
                    type="number"
                    value={variance}
                    onChange={(e) => setVariance(e.target.value)}
                    className="mt-1 block w-40 rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  />
                </label>
              ) : null}
              <button
                onClick={() => simMut.mutate()}
                disabled={simMut.isPending || (row.next === "closing_scheduled" && !closingDate)}
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium disabled:opacity-50"
              >
                Fire webhook
              </button>
              {row.next === "earnest_money_deposited" && row.earnest.length > 0 ? (
                <p className="w-full text-[11px] text-muted-foreground">
                  Platform tracking:{" "}
                  {row.earnest.map((e) => `${e.buyerAccountId.slice(0, 8)} ${e.status} $${e.amount.toLocaleString()}`).join(" · ")}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="mt-3 text-xs text-emerald-700">All milestones received — funded and recorded.</p>
          )}
        </>
      )}
    </section>
  );
}
