import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { PreSigningReview } from "@/components/PreSigningReview";
import { propertySearch } from "@/lib/property-scope";
import { listMyOperatingAgreements } from "@/lib/entity-genesis-stage2.functions";

/** Pre-Signing Review of the LLC Operating Agreement: its own screen, before the signing screen. */
export const Route = createFileRoute("/buyer/operating-agreement-review")({
  head: () => ({ meta: [{ title: "Pre-Signing Review — LLC Operating Agreement" }, { name: "robots", content: "noindex" }] }),
  validateSearch: propertySearch,
  component: OaReview,
});

function OaReview() {
  const load = useServerFn(listMyOperatingAgreements);
  const { property } = Route.useSearch();
  const { data, isLoading } = useQuery({ queryKey: ["buyer-oa", property ?? "all"], queryFn: () => load({ data: { propertyId: property ?? null } }) });
  if (isLoading) return <p className="px-6 py-16 text-center text-base text-muted-foreground">Loading…</p>;
  const agreements = data?.agreements ?? [];
  if (agreements.length === 0) {
    return <PreSigningReview title="LLC Operating Agreement" version="" text={null} signHref="/buyer/operating-agreement" signDisabledNote="Your Operating Agreement opens for review once your pod is Closing-Ready and the LLC is filed." />;
  }
  return (
    <>
      {agreements.map((a) => (
        <PreSigningReview
          key={a.propertyId}
          title={`LLC Operating Agreement (${a.llcName})`}
          version={a.documentHash ? `text ${a.documentHash.slice(0, 12)}` : ""}
          text={a.text}
          hash={a.documentHash}
          signHref={`/buyer/operating-agreement?property=${a.propertyId}`}
          signLabel={a.status === "executed" ? "View the executed agreement" : "Continue to signing"}
        />
      ))}
    </>
  );
}
