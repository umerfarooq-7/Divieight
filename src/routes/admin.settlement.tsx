import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { CheckCircle2, ExternalLink, FileText, ShieldAlert } from "lucide-react";
import { generateSourceOfTruth, listSettlements, type SettlementRow } from "@/lib/settlement.functions";
import { HEAVY_LIFTER_PREMIUM_PERCENT, REFERRAL_SPLIT_PERCENT, formatUsdCents } from "@/lib/commission-cascade";

export const Route = createFileRoute("/admin/settlement")({
  head: () => ({
    meta: [
      { title: "Commission settlement — divieight admin" },
      { name: "description", content: "Source of Truth and Commission Disbursement Authorization for title/escrow." },
      { property: "og:title", content: "Commission settlement — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminSettlement,
});

function AdminSettlement() {
  const load = useServerFn(listSettlements);
  const { data, isLoading } = useQuery({ queryKey: ["admin-settlement"], queryFn: () => load() });
  const rows = data?.rows ?? [];
  return (
    <div>
      <h1 className="font-display text-2xl font-semibold text-foreground">Commission settlement</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        The Source of Truth is the Commission Disbursement Authorization (CDA) sent to title/escrow: the final buyer-side
        commission per share — {REFERRAL_SPLIT_PERCENT}% referral split where a NAR referral applies, a{" "}
        {HEAVY_LIFTER_PREMIUM_PERCENT}% Heavy Lifter Premium carved out of each other agent's portion — payable broker-to-broker.
        It is an instruction only: divieight never holds or disburses commission funds.
      </p>
      <div className="mt-6 space-y-5">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No property has a title order or a locked cap table yet.</p>
        ) : (
          rows.map((r) => <PropertySettlement key={r.propertyId} row={r} />)
        )}
      </div>
    </div>
  );
}

function PropertySettlement({ row }: { row: SettlementRow }) {
  const qc = useQueryClient();
  const generate = useServerFn(generateSourceOfTruth);
  const mut = useMutation({
    mutationFn: () => generate({ data: { propertyId: row.propertyId } }),
    onSuccess: (r) => {
      if (r.status === "blocked") toast.error(`Blocked by ${r.blockers.length} precondition(s).`);
      else toast.success(`Source of Truth v${r.version} generated and ${r.simulated ? "logged as transmitted (simulated)" : "transmitted"} — ${r.externalReference}.`);
      void qc.invalidateQueries({ queryKey: ["admin-settlement"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const sot = row.latest?.structured;

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="font-display text-base font-semibold text-foreground">{row.label}</h2>
        <button
          onClick={() => mut.mutate()}
          disabled={mut.isPending || row.blockers.length > 0}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          <FileText className="h-4 w-4" />
          {row.latest ? "Regenerate & retransmit CDA" : "Generate Source of Truth & transmit CDA"}
        </button>
      </div>

      {row.blockers.length > 0 ? (
        <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-destructive">
            <ShieldAlert className="h-4 w-4" /> Generation blocked — {row.blockers.length} precondition(s) failing
          </p>
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-destructive">
            {row.blockers.map((b, i) => (
              <li key={i}>
                <span className="font-mono text-[11px] opacity-70">{b.code}</span> — {b.message}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-emerald-700">
          <CheckCircle2 className="h-4 w-4" /> All pre-closing gates pass.
        </p>
      )}

      {row.latest && sot ? (
        <div className="mt-4 rounded-lg border border-border bg-background p-4 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-medium text-foreground">
              v{row.latest.version} · {row.latest.status}
              {row.latest.simulated ? " (simulated)" : ""} · {formatUsdCents(row.latest.total_commission_cents)} total
            </p>
            {row.latest.pdf_signed_url ? (
              <a href={row.latest.pdf_signed_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-primary">
                PDF <ExternalLink className="h-3 w-3" />
              </a>
            ) : null}
          </div>
          <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
            {row.latest.content_hash} · ref {row.latest.external_reference ?? "—"} · {row.versions} version(s)
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 pr-2">Share</th>
                <th className="py-1 pr-2">Agent (role)</th>
                <th className="py-1 pr-2">Broker of Record</th>
                <th className="py-1 pr-2 text-right">Gross</th>
                <th className="py-1 pr-2 text-right">HLA premium</th>
                <th className="py-1 text-right">Net</th>
              </tr>
            </thead>
            <tbody>
              {sot.shares.flatMap((s) =>
                s.lines.map((l, i) => (
                  <tr key={`${s.shareNumber}-${i}`} className="border-t border-border/60">
                    <td className="py-1 pr-2">{i === 0 ? `${s.shareNumber}/8` : ""}</td>
                    <td className="py-1 pr-2">
                      {l.agentName} <span className="text-muted-foreground">({l.role.replace(/_/g, " ")})</span>
                    </td>
                    <td className="py-1 pr-2">{l.brokerageName}</td>
                    <td className="py-1 pr-2 text-right">{formatUsdCents(l.grossCents)}</td>
                    <td className="py-1 pr-2 text-right">
                      {l.premiumToHlaCents ? `−${formatUsdCents(l.premiumToHlaCents)}` : l.premiumReceivedCents ? `+${formatUsdCents(l.premiumReceivedCents)}` : "—"}
                    </td>
                    <td className="py-1 text-right font-medium">{formatUsdCents(l.netCents)}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
          </div>
          <p className="mt-3 text-xs font-semibold text-foreground">Payees (broker-to-broker)</p>
          <ul className="mt-1 space-y-0.5 text-xs">
            {sot.payees.map((p) => (
              <li key={p.brokerId}>
                {p.brokerageName}: <span className="font-medium">{formatUsdCents(p.amountCents)}</span>
                <span className="text-muted-foreground"> — {p.creditedAgents.join(", ")}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
