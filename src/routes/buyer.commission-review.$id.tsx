import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { PreSigningReview } from "@/components/PreSigningReview";
import { getBuyerAuthorization, type BuyerAuthorizationPayload } from "@/lib/authorization.functions";
import { COMMISSION_CONFIRMATION_TEXT, commissionStatement } from "@/lib/commission-item";

/** Pre-Signing Review of the Commission Authorization: its own screen, before the authorization is given on the Authorization page. */
export const Route = createFileRoute("/buyer/commission-review/$id")({
  head: () => ({ meta: [{ title: "Pre-Signing Review — Commission Authorization" }, { name: "robots", content: "noindex" }] }),
  component: CommissionReview,
});

function CommissionReview() {
  const { id } = Route.useParams();
  const load = useServerFn(getBuyerAuthorization);
  const [payload, setPayload] = useState<BuyerAuthorizationPayload | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    load({ data: { id } }).then((r) => {
      if (cancelled) return;
      setPayload(r);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [id, load]);
  if (loading) return <p className="px-6 py-16 text-center text-base text-muted-foreground">Loading…</p>;
  const item = payload?.commissionItem ?? null;
  // The same statement the Authorization page shows, in the same words.
  const text = item ? `COMMISSION AUTHORIZATION\n\n${commissionStatement(item)}\n\n${COMMISSION_CONFIRMATION_TEXT}` : null;
  return (
    <PreSigningReview
      title="Commission Authorization"
      version={item ? `instrument ${item.instrument_hash.slice(0, 14)}` : ""}
      text={text}
      hash={item?.instrument_hash ?? null}
      signHref={`/buyer/authorizations/${id}`}
      signLabel="Continue to the authorization"
      signDisabledNote="No commission provision has been proposed on this request yet."
    />
  );
}
