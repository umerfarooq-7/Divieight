import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getOwnerCpa } from "@/lib/cpa.functions";
import { formatDate } from "@/lib/format-date";

/** What a member sees of the LLC's CPA: the name and firm, and since when. Nothing more. */
export function DesignatedCpaCard({ propertyId }: { propertyId: string }) {
  const load = useServerFn(getOwnerCpa);
  const q = useQuery({ queryKey: ["owner-cpa", propertyId], queryFn: () => load({ data: { propertyId } }), retry: false });
  if (!q.data || !q.data.allowed) return null;
  return (
    <section className="rounded-xl border border-border bg-card p-4 text-base">
      <h2 className="text-base font-semibold text-foreground">Designated CPA</h2>
      {q.data.cpa ? (
        <p className="text-muted-foreground">
          {q.data.cpa.name}, {q.data.cpa.firm} · since {formatDate(q.data.cpa.since)}. The CPA can read this LLC&apos;s books and statements, and nothing else.
        </p>
      ) : (
        <p className="text-muted-foreground">No CPA has been designated for this LLC.</p>
      )}
    </section>
  );
}
