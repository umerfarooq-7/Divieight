import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { PreSigningReview } from "@/components/PreSigningReview";
import { getAgentReferralDocument, type ReferralDocument } from "@/lib/nar-referral.functions";

/** Pre-Signing Review of the Standard NAR Referral Agreement: its own screen, before the signing screen. */
export const Route = createFileRoute("/agent/document-review/$id")({
  head: () => ({ meta: [{ title: "Pre-Signing Review — Standard NAR Referral Agreement" }, { name: "robots", content: "noindex" }] }),
  component: NarReview,
});

function NarReview() {
  const { id } = Route.useParams();
  const load = useServerFn(getAgentReferralDocument);
  const [doc, setDoc] = useState<ReferralDocument | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    load({ data: { documentId: id } }).then((d) => {
      if (cancelled) return;
      setDoc(d);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [id, load]);
  if (loading) return <p className="px-6 py-16 text-center text-base text-muted-foreground">Loading…</p>;
  return <PreSigningReview title="Standard NAR Referral Agreement" version={doc?.version ?? ""} text={doc?.body} hash={doc?.hash} signHref={`/agent/documents/${id}`} signDisabledNote="This agreement is not available to your account." />;
}
