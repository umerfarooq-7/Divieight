import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { BellRing } from "lucide-react";
import { toast } from "sonner";
import {
  listDesignationRequests,
  listReferOnlyElections,
  respondToDesignation,
  respondToReferOnly,
  type DesignationRequest,
  type ReferOnlyElection,
} from "@/lib/designation.functions";
import { listMyHlaInvitations } from "@/lib/hla.functions";
import {
  listMyListingEngagements,
  listMyListingProperties,
  type ListingEngagementInvitation,
} from "@/lib/listing-approval.functions";
import type { ListingAgentProperty } from "@/lib/listing-approval";
import type { HlaInvitation } from "@/lib/hla";
import { Link } from "@tanstack/react-router";
import { listPropertyAssignmentOffers, respondToPropertyAssignment } from "@/lib/agent-assignment.functions";

/**
 * Action-required queue: buyer designations awaiting a 3-day response, and
 * Refer-Only elections for buyers this agent referred into their own market.
 *
 * Either way the agent is paid only from the buyer-side commission cascade at
 * closing (full amount if tethered, 25% referral split if refer-only) — the
 * Platform never pays a referral fee.
 */
export function AgentActionItems() {
  const loadDesignations = useServerFn(listDesignationRequests);
  const loadElections = useServerFn(listReferOnlyElections);
  const respondDesignation = useServerFn(respondToDesignation);
  const respondElection = useServerFn(respondToReferOnly);
  const loadHlaInvites = useServerFn(listMyHlaInvitations);
  const loadListings = useServerFn(listMyListingProperties);
  const loadEngagements = useServerFn(listMyListingEngagements);

  const [designations, setDesignations] = useState<DesignationRequest[]>([]);
  const [elections, setElections] = useState<ReferOnlyElection[]>([]);
  const [hlaInvites, setHlaInvites] = useState<HlaInvitation[]>([]);
  const [listingReviews, setListingReviews] = useState<ListingAgentProperty[]>([]);
  const [engagements, setEngagements] = useState<ListingEngagementInvitation[]>([]);
  const [busy, setBusy] = useState(false);
  const loadOffers = useServerFn(listPropertyAssignmentOffers);
  const respondOffer = useServerFn(respondToPropertyAssignment);
  const [offers, setOffers] = useState<Array<{ requestId: string; propertyLabel: string }>>([]);

  const refresh = useCallback(async () => {
    setOffers(await loadOffers({}).catch(() => []));
    const [d, e, h, l, g] = await Promise.all([
      loadDesignations({}),
      loadElections({}),
      loadHlaInvites({}),
      loadListings({}).catch(() => [] as ListingAgentProperty[]),
      loadEngagements({}).catch(() => [] as ListingEngagementInvitation[]),
    ]);
    setDesignations(d);
    setElections(e);
    setHlaInvites(h);
    setListingReviews((l ?? []).filter((p) => p.pending_items > 0));
    setEngagements(g ?? []);
  }, [loadDesignations, loadElections, loadHlaInvites, loadListings, loadEngagements, loadOffers]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (
    designations.length === 0 &&
    offers.length === 0 &&
    elections.length === 0 &&
    hlaInvites.length === 0 &&
    listingReviews.length === 0 &&
    engagements.length === 0
  )
    return null;

  return (
    <section className="rounded-xl border border-accent/40 bg-accent/5 p-6">
      <div className="flex items-center gap-2">
        <BellRing className="h-5 w-5 text-accent" />
        <h2 className="font-display text-lg font-semibold text-foreground">Action required</h2>
      </div>

      <ul className="mt-4 space-y-4">
        {engagements.map((inv) => (
          <li key={`engagement-${inv.propertyId}`} className="rounded-lg border border-border bg-card p-4">
            <p className="text-sm font-medium text-foreground">
              A seller asked you to act as their Listing Agent
            </p>
            <p className="mt-1 break-words text-xs text-muted-foreground">
              {inv.address}, {inv.city}, {inv.state} {inv.zip}
              {inv.sellerName ? ` · Seller: ${inv.sellerName}` : ""}
            </p>
            <Link
              to="/agent/listings"
              className="mt-3 inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Accept or decline
            </Link>
          </li>
        ))}

        {listingReviews.map((p) => (
          <li key={`listing-${p.id}`} className="rounded-lg border border-border bg-card p-4">
            <p className="text-sm font-medium text-foreground">
              Listing content is awaiting your approval ({p.pending_items})
            </p>
            <p className="mt-1 break-words text-xs text-muted-foreground">
              {p.address}, {p.city}, {p.state} {p.zip}
              {p.seller_name ? ` · Seller: ${p.seller_name}` : ""}
            </p>
            <Link
              to="/agent/listings"
              className="mt-3 inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Review listing content
            </Link>
          </li>
        ))}

        {hlaInvites.map((inv) => (
          <li key={inv.podId} className="rounded-lg border border-border bg-card p-4">
            <p className="text-sm font-medium text-foreground">
              You have been selected as Heavy Lifting Agent for a pod
            </p>
            <p className="mt-1 break-words text-xs text-muted-foreground">
              {inv.address}, {inv.city}, {inv.state} {inv.zip} · {inv.buyersInPod} reserved share
              {inv.buyersInPod === 1 ? "" : "s"}
              {inv.acceptanceDeadlineAt
                ? ` · respond by ${new Date(inv.acceptanceDeadlineAt).toLocaleDateString()}`
                : ""}
            </p>
            <Link
              to="/agent/pods/$id/hla-invitation"
              params={{ id: inv.podId }}
              className="mt-3 inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Review and respond
            </Link>
          </li>
        ))}

        {designations.map((d) => (
          <li key={d.buyerAccountId} className="rounded-lg border border-border bg-card p-4">
            <p className="text-sm font-medium text-foreground">
              A buyer designated you as their agent
            </p>
            <p className="mt-1 break-words text-xs text-muted-foreground">
              {d.buyerEmail ?? "Vetted buyer"} · Target market {d.market ?? "—"}
              {d.deadlineAt
                ? ` · respond by ${new Date(d.deadlineAt).toLocaleDateString()}`
                : ""}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  const r = await respondDesignation({
                    data: { buyerAccountId: d.buyerAccountId, accept: true },
                  });
                  setBusy(false);
                  if (r.error) toast.error(r.error);
                  else toast.success("You're now tethered to this buyer.");
                  void refresh();
                }}
                className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                Accept tethering
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  await respondDesignation({
                    data: { buyerAccountId: d.buyerAccountId, accept: false },
                  });
                  setBusy(false);
                  toast.success("Declined.");
                  void refresh();
                }}
                className="h-9 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted"
              >
                Decline
              </button>
            </div>
          </li>
        ))}

        {offers.map((o) => (
          <li key={o.requestId} className="rounded-lg border border-border bg-card p-4">
            <p className="text-sm font-medium text-foreground">
              divieight assigned you as Resident Agent for a buyer on one property
            </p>
            <p className="mt-1 break-words text-xs text-muted-foreground">{o.propertyLabel}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {[true, false].map((accept) => (
                <button
                  key={String(accept)}
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    const r = await respondOffer({ data: { requestId: o.requestId, accept } });
                    setBusy(false);
                    if (r.error) toast.error(r.error);
                    else toast.success(accept ? "You're this buyer's agent on this property." : "Declined.");
                    void refresh();
                  }}
                  className={
                    accept
                      ? "h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
                      : "h-9 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted"
                  }
                >
                  {accept ? "Accept" : "Decline"}
                </button>
              ))}
            </div>
          </li>
        ))}

        {elections.map((e) => (
          <li key={e.id} className="rounded-lg border border-border bg-card p-4">
            <p className="text-sm font-medium text-foreground">
              A buyer you referred is now vetted — choose how to proceed
            </p>
            <p className="mt-1 break-words text-xs text-muted-foreground">
              {e.buyerEmail ?? "Vetted buyer"} · Target market {e.market ?? "—"}. Keep this buyer and
              you become their tethered Resident Agent, holding the full buyer-side commission at
              closing (before any Heavy Lifter Premium) with no referral agreement. Hand off and
              another Resident Agent in that market is tethered, a Standard NAR Referral Agreement is
              generated for you both to sign, and the buyer-side commission splits 25% to you / 75%
              to them.
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  const r = await respondElection({
                    data: { electionId: e.id, choice: "accept_tether" },
                  });
                  setBusy(false);
                  if (r.error) toast.error(r.error);
                  else toast.success("You're now tethered to this buyer.");
                  void refresh();
                }}
                className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                Keep this buyer
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  const r = await respondElection({
                    data: { electionId: e.id, choice: "refer_only" },
                  });
                  setBusy(false);
                  if (r.error) toast.error(r.error);
                  else toast.success("Handed off — another Resident Agent will be tethered and a referral agreement generated.");
                  void refresh();
                }}
                className="h-9 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted"
              >
                Hand off
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
