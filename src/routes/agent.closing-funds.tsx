import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listAgentClosingFunds } from "@/lib/closing-funds.functions";
import { ClosingFundsCard } from "@/components/ClosingFundsCard";

export const Route = createFileRoute("/agent/closing-funds")({
  head: () => ({
    meta: [
      { title: "Closing funds — divieight Professional Portal" },
      {
        name: "description",
        content: "Closing Funds Notices and wire status for your tethered buyers.",
      },
      { property: "og:title", content: "Closing funds — divieight Professional Portal" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AgentClosingFunds,
});

function AgentClosingFunds() {
  const fetchRows = useServerFn(listAgentClosingFunds);
  const { data, isLoading } = useQuery({
    queryKey: ["agent-closing-funds"],
    queryFn: () => fetchRows(),
  });
  const rows = data?.rows ?? [];

  return (
    <div>
      <h1 className="font-display text-xl font-semibold text-foreground">Closing funds</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Closing Funds Notices issued to your tethered buyers and whether escrow has confirmed each
        wire. Buyers wire directly to escrow; divieight never holds these funds.
      </p>
      <div className="mt-6 space-y-5">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No Closing Funds Notices for your buyers yet.</p>
        ) : (
          rows.map((r) => (
            <ClosingFundsCard
              key={r.obligation.id}
              obligation={r.obligation}
              terms={r.terms}
              propertyLabel={r.propertyLabel}
              eyebrow={`Buyer: ${r.buyerEmail ?? "Buyer Account"}`}
            />
          ))
        )}
      </div>
    </div>
  );
}
