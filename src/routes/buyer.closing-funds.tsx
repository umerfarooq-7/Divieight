import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listBuyerClosingFunds } from "@/lib/closing-funds.functions";
import { CLOSING_DIRECT_TO_ESCROW_NOTICE } from "@/lib/closing-funds";
import { ClosingFundsCard } from "@/components/ClosingFundsCard";

export const Route = createFileRoute("/buyer/closing-funds")({
  head: () => ({
    meta: [
      { title: "Closing funds — divieight" },
      {
        name: "description",
        content: "Your Closing Funds Notice: exact pro-rata amount, escrow wire details and deadline.",
      },
      { property: "og:title", content: "Closing funds — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: BuyerClosingFunds,
});

function BuyerClosingFunds() {
  const fetchRows = useServerFn(listBuyerClosingFunds);
  const { data, isLoading } = useQuery({
    queryKey: ["buyer-closing-funds"],
    queryFn: () => fetchRows(),
  });
  const rows = data?.rows ?? [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-semibold text-foreground">Closing funds</h1>
        <p className="mt-1 text-sm text-muted-foreground">{CLOSING_DIRECT_TO_ESCROW_NOTICE}</p>
      </header>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading your Closing Funds Notice…</p>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          No Closing Funds Notice yet. One is issued 7–14 days before closing.
        </div>
      ) : (
        <div className="space-y-5">
          {rows.map((r) => (
            <ClosingFundsCard
              key={r.obligation.id}
              obligation={r.obligation}
              terms={r.terms}
              propertyLabel={r.propertyLabel}
            />
          ))}
        </div>
      )}
    </div>
  );
}
