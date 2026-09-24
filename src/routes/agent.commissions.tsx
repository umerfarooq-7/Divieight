import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listMyCommissions } from "@/lib/closing-saga.functions";
import { formatUsdCents } from "@/lib/commission-cascade";

export const Route = createFileRoute("/agent/commissions")({
  head: () => ({
    meta: [
      { title: "Commission Dashboard — divieight Professional Portal" },
      { name: "description", content: "Your buyer-side commissions per closed share, payable by title/escrow through your Broker of Record." },
      { property: "og:title", content: "Commission Dashboard — divieight Professional Portal" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AgentCommissions,
});

const ROLE: Record<string, string> = {
  resident_agent: "Resident Agent",
  referring_agent: "Referral (25%)",
  heavy_lifting_agent: "Heavy Lifter Premium",
};

function AgentCommissions() {
  const load = useServerFn(listMyCommissions);
  const { data, isLoading } = useQuery({ queryKey: ["agent-commissions"], queryFn: () => load() });
  const rows = data?.rows ?? [];
  const total = rows.reduce((s, r) => s + r.net_cents, 0);

  return (
    <div>
      <h1 className="font-display text-xl font-semibold text-foreground">Commission Dashboard</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Buyer-side commission per closed share. Title/escrow pays it from sale proceeds to your Broker of Record —
        divieight never pays agents directly.
      </p>
      {isLoading ? (
        <p className="mt-6 text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">No closed shares yet.</p>
      ) : (
        <>
          <p className="mt-4 text-sm text-foreground">
            Closed — Payable by Title/Escrow: <span className="font-semibold">{formatUsdCents(total)}</span>
          </p>
          <div className="mt-3 overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Property · share</th>
                  <th className="px-3 py-2">Role</th>
                  <th className="px-3 py-2 text-right">Gross</th>
                  <th className="px-3 py-2 text-right">HLA premium</th>
                  <th className="px-3 py-2 text-right">Net</th>
                  <th className="px-3 py-2">Paid to</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      {r.propertyLabel} · {r.share_number}/8
                    </td>
                    <td className="px-3 py-2">{ROLE[r.role] ?? r.role}</td>
                    <td className="px-3 py-2 text-right">{formatUsdCents(r.gross_cents)}</td>
                    <td className="px-3 py-2 text-right">
                      {r.premium_to_hla_cents ? `−${formatUsdCents(r.premium_to_hla_cents)}` : r.premium_received_cents ? `+${formatUsdCents(r.premium_received_cents)}` : "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-medium">{formatUsdCents(r.net_cents)}</td>
                    <td className="px-3 py-2">{r.brokerageName}</td>
                    <td className="px-3 py-2">
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">Closed — Payable by Title/Escrow</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
