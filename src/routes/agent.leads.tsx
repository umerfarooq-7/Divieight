import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { ShieldCheck } from "lucide-react";
import { listMyTetheredBuyers, type TetheredBuyer } from "@/lib/agent-leads.functions";
import { VerifiedLeadTable } from "@/components/agent/VerifiedLeadTable";

export const Route = createFileRoute("/agent/leads")({
  head: () => ({
    meta: [
      { title: "Verified leads — divieight Professional Portal" },
      {
        name: "description",
        content:
          "Confirm which tethered buyers have paid the Platform Enrollment Fee, cleared liquidity, and earned a Digital Key.",
      },
      { property: "og:title", content: "Verified leads — divieight" },
      {
        property: "og:description",
        content: "Real-time qualification status for every buyer tethered to you.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AgentLeadsPage,
});

function AgentLeadsPage() {
  const loadBuyers = useServerFn(listMyTetheredBuyers);
  const [buyers, setBuyers] = useState<TetheredBuyer[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    loadBuyers({})
      .then((rows) => {
        if (!cancelled) setBuyers(rows);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadBuyers]);

  const qualified = buyers.filter((b) => b.goldenTicketIssued && b.pefStatus === "paid").length;

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <p className="inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.2em] text-accent">
          <ShieldCheck className="h-4 w-4" /> Verified leads
        </p>
        <h1 className="font-display text-3xl font-semibold text-foreground">
          Your tethered buyers
        </h1>
        {/* Rev 49 counsel items D2(a)/D2(b): the KYO Access Controls sentence below is queued for counsel review. Do not change it. */}
        <p className="text-sm text-muted-foreground">
          {qualified} of {buyers.length} tethered buyer{buyers.length === 1 ? "" : "s"} are fully
          qualified — Platform Enrollment Fee paid and Digital Key issued. Vetting report contents
          stay private to the buyer and the Platform.
        </p>
      </header>

      <section className="rounded-xl border border-border bg-card p-6">
        <VerifiedLeadTable buyers={buyers} loading={loading} />
      </section>
    </div>
  );
}
