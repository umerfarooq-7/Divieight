import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Lock } from "lucide-react";
import { toast } from "sonner";
import { timeLeft } from "@/components/owner/VoteBits";
import { OwnerLoading, OwnerPageShell } from "@/components/owner/useOwnerProperty";
import { useAuth } from "@/hooks/use-auth";
import { formatDate } from "@/lib/format-date";
import { RESALE_FLAT_FEE, RESALE_ROFR_HOURS, RESALE_STATUS_LABELS, resaleMoney, ROFR_WINNER_RULE, type RofrPosition } from "@/lib/resale";
import {
  createResaleListing,
  exerciseResaleRofr,
  getOwnerResale,
  recordResalePosition,
  withdrawResaleElection,
  withdrawResaleListing,
} from "@/lib/resale.functions";
import type { CoOwnerResaleListing, OwnerResaleListing, OwnerResaleShare } from "@/lib/resale.server";

export const Route = createFileRoute("/owner/properties/$propertyId/resale")({
  head: () => ({
    meta: [
      { title: "Resale Shop — divieight" },
      { name: "description", content: "List your share, or exercise your right of first refusal on a co-owner's." },
      { property: "og:title", content: "Resale Shop — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: OwnerResalePage,
});

const panel = "rounded-xl border border-border bg-card p-5 shadow-sm";
const primaryButton = "rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50";
const quietButton = "rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary disabled:opacity-50";

const untilClose = (closesAt: string) => timeLeft(new Date(closesAt).getTime(), Date.now());

function useRefresh(propertyId: string) {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ["owner-resale", propertyId] });
}

function OwnerResalePage() {
  const { propertyId } = Route.useParams();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const load = useServerFn(getOwnerResale);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["owner-resale", propertyId, user?.id],
    enabled: !!user,
    retry: false,
    queryFn: () => load({ data: { propertyId } }),
  });

  useEffect(() => {
    if (!authLoading && !user) navigate({ to: "/owner/login", search: { redirect: window.location.pathname } });
  }, [authLoading, user, navigate]);

  const denied = data?.allowed === false;
  useEffect(() => {
    if (!denied) return;
    toast.error("You don't have ownership in that property.");
    navigate({ to: "/owner" });
  }, [denied, navigate]);

  return (
    <OwnerPageShell>
      <Link to="/owner/properties/$propertyId" params={{ propertyId }} className="text-sm text-muted-foreground hover:text-foreground">
        ← Owner dashboard
      </Link>
      <h1 className="mt-4 font-display text-2xl font-semibold text-foreground sm:text-3xl">Resale Shop</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Co-owners get the first chance to buy a listed share. If none of them does within 10 days, it goes on the open market.
        If more than one co-owner elects to buy: {ROFR_WINNER_RULE.toLowerCase()}.
      </p>
      <div className="mt-6 space-y-6">
        {isError ? (
          <p className="text-sm text-muted-foreground">
            We couldn't load the Resale Shop.{" "}
            <button type="button" onClick={() => void refetch()} className="font-medium text-primary hover:underline">
              Try again
            </button>
          </p>
        ) : authLoading || isLoading || !data || denied ? (
          <OwnerLoading />
        ) : (
          <>
            <ListShare propertyId={propertyId} shares={data.shares} />
            {data.mine.length > 0 ? (
              <section>
                <h2 className="font-display text-lg font-semibold text-foreground">My listings</h2>
                <div className="mt-3 space-y-3">
                  {data.mine.map((l) => (
                    <MyListing key={l.id} propertyId={propertyId} listing={l} />
                  ))}
                </div>
              </section>
            ) : null}
            <section>
              <h2 className="font-display text-lg font-semibold text-foreground">Co-owners' shares</h2>
              <div className="mt-3 space-y-3">
                {data.coOwners.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                    No co-owner shares are on offer right now.
                  </p>
                ) : (
                  data.coOwners.map((l) => <CoOwnerListing key={l.id} propertyId={propertyId} listing={l} />)
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </OwnerPageShell>
  );
}

function ListShare({ propertyId, shares }: { propertyId: string; shares: OwnerResaleShare[] }) {
  const refresh = useRefresh(propertyId);
  const create = useServerFn(createResaleListing);
  const listable = shares.filter((s) => !s.locked && !s.listed);
  const locked = shares.filter((s) => s.locked);
  const [shareNumber, setShareNumber] = useState<number | null>(null);
  const [price, setPrice] = useState("");
  const [confirming, setConfirming] = useState(false);
  const chosen = shareNumber ?? listable[0]?.shareNumber ?? null;
  const askingPrice = Number(price);
  const validPrice = Number.isFinite(askingPrice) && askingPrice > 0;
  const mut = useMutation({
    mutationFn: () => create({ data: { propertyId, shareNumber: chosen!, askingPrice, feeAcknowledged: true } }),
    onSuccess: (r) => {
      if (r.error) {
        toast.error(r.error);
        return;
      }
      toast.success("Listed. Your co-owners have been told.");
      setPrice("");
      setShareNumber(null);
      setConfirming(false);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <section className={panel}>
      <h2 className="font-display text-lg font-semibold text-foreground">List a share</h2>
      {locked.length > 0 ? (
        <ul className="mt-3 space-y-1.5 text-sm text-muted-foreground">
          {locked.map((s) => (
            <li key={s.shareNumber} className="flex items-center gap-2">
              <Lock className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
              Share #{s.shareNumber} is under the Retention Lock{s.lockExpiresAt ? ` until ${formatDate(s.lockExpiresAt)}` : ""}.
            </li>
          ))}
          <li>
            <Link to="/owner/properties/$propertyId/retention" params={{ propertyId }} className="font-medium text-primary hover:underline">
              View Retention Lock and exceptions
            </Link>
          </li>
        </ul>
      ) : null}

      {listable.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">You have no shares that can be listed right now.</p>
      ) : !confirming ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium text-foreground">
            Share
            <select
              value={chosen ?? ""}
              onChange={(e) => setShareNumber(Number(e.target.value))}
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-normal"
            >
              {listable.map((s) => (
                <option key={s.shareNumber} value={s.shareNumber}>
                  Share #{s.shareNumber}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium text-foreground">
            Asking price (USD)
            <input
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-normal"
            />
          </label>
          <div className="sm:col-span-2">
            <button type="button" disabled={!validPrice} onClick={() => setConfirming(true)} className={primaryButton}>
              Continue
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="rounded-lg border border-accent/50 bg-accent/10 p-4 text-sm">
            <p className="font-medium text-foreground">
              Share #{chosen} at {resaleMoney(askingPrice)}
            </p>
            <p className="mt-2 text-foreground">
              A {resaleMoney(RESALE_FLAT_FEE)} flat technology-service fee applies. It is collected at sale; nothing is charged now.
            </p>
            <p className="mt-2 text-muted-foreground">
              Your co-owners are told now and have {RESALE_ROFR_HOURS} hours (10 days) to buy at this price before it goes on the open market.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={mut.isPending} onClick={() => mut.mutate()} className={primaryButton}>
              {mut.isPending ? "Listing…" : "Confirm listing"}
            </button>
            <button type="button" disabled={mut.isPending} onClick={() => setConfirming(false)} className={quietButton}>
              Back
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function MyListing({ propertyId, listing: l }: { propertyId: string; listing: OwnerResaleListing }) {
  const refresh = useRefresh(propertyId);
  const withdraw = useServerFn(withdrawResaleListing);
  const mut = useMutation({
    mutationFn: () => withdraw({ data: { propertyId, listingId: l.id } }),
    onSuccess: (r) => {
      if (r.error) toast.error(r.error);
      else toast.success("Listing withdrawn.");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className={panel}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="font-medium text-foreground">
          Share #{l.shareNumber} · {resaleMoney(l.askingPrice)}
        </p>
        <span className="rounded-full bg-muted px-3 py-1 text-xs text-foreground">{l.statusLabel}</span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {resaleMoney(l.flatFee)} technology-service fee at sale.
        {l.status === "rofr_open" ? ` Window closes in ${untilClose(l.rofrClosesAt)}.` : ""}
        {l.electionCount > 0 ? ` ${l.electionCount} co-owner election${l.electionCount === 1 ? "" : "s"}.` : ""}
        {l.saleStatus === "pending_closing" ? " A co-owner is confirmed as the buyer; divieight will contact you about closing." : ""}
      </p>
      {l.canWithdraw ? (
        <button type="button" disabled={mut.isPending} onClick={() => mut.mutate()} className={`mt-3 ${quietButton}`}>
          Withdraw listing
        </button>
      ) : null}
    </div>
  );
}

function CoOwnerListing({ propertyId, listing: l }: { propertyId: string; listing: CoOwnerResaleListing }) {
  const refresh = useRefresh(propertyId);
  const exercise = useServerFn(exerciseResaleRofr);
  const withdraw = useServerFn(withdrawResaleElection);
  const [confirming, setConfirming] = useState(false);
  const onResult = (message: string) => (r: { error?: string }) => {
    setConfirming(false);
    if (r.error) toast.error(r.error);
    else toast.success(message);
    refresh();
  };
  const onError = (e: Error) => toast.error(e.message);
  const exerciseMut = useMutation({ mutationFn: () => exercise({ data: { propertyId, listingId: l.id } }), onSuccess: onResult("Right of first refusal exercised."), onError });
  const withdrawMut = useMutation({ mutationFn: () => withdraw({ data: { propertyId, listingId: l.id } }), onSuccess: onResult("Election withdrawn."), onError });
  const windowOpen = l.status === "rofr_open";
  const multiMember = l.consensus.members.length > 1;
  const ready = !multiMember || (l.consensus.state === "agreed" && l.consensus.choice === "exercise");

  return (
    <div className={panel}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="font-medium text-foreground">
          Share #{l.shareNumber} · {resaleMoney(l.askingPrice)}
        </p>
        <span className="rounded-full bg-muted px-3 py-1 text-xs text-foreground">
          {windowOpen ? `Closes in ${untilClose(l.rofrClosesAt)}` : RESALE_STATUS_LABELS[l.status]}
        </span>
      </div>

      {l.myElection === "active" ? (
        <p className="mt-2 text-sm text-foreground">You exercised your right of first refusal. The outcome is confirmed after the window closes. {ROFR_WINNER_RULE}.</p>
      ) : l.myElection === "won" ? (
        <p className="mt-2 text-sm text-foreground">
          {l.saleStatus === "completed" ? "This purchase is complete. The share is now yours." : "You've been confirmed as the buyer. divieight will contact you about closing."}
        </p>
      ) : l.myElection === "lost" ? (
        <p className="mt-2 text-sm text-muted-foreground">Another co-owner was confirmed as the buyer, or the listing closed. {ROFR_WINNER_RULE}.</p>
      ) : null}

      {l.canElect && multiMember ? (
        <div className="mt-3 space-y-2">
          <p className="text-sm text-muted-foreground">Every member of your account must agree before you can exercise.</p>
          {l.consensus.members.map((m) => (
            <MemberRow key={m.memberId} propertyId={propertyId} listingId={l.id} memberId={m.memberId} name={m.name} position={m.position} />
          ))}
          {l.consensus.state === "disagree" ? <p className="text-sm text-destructive">Your account members disagree.</p> : null}
        </div>
      ) : null}

      {l.canElect ? (
        confirming ? (
          <div className="mt-3 space-y-2">
            <p className="text-sm text-foreground">
              Elect to buy share #{l.shareNumber} at {resaleMoney(l.askingPrice)}? If more than one co-owner elects: {ROFR_WINNER_RULE.toLowerCase()}.
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={exerciseMut.isPending} onClick={() => exerciseMut.mutate()} className={primaryButton}>
                Confirm
              </button>
              <button type="button" onClick={() => setConfirming(false)} className={quietButton}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" disabled={!ready} onClick={() => setConfirming(true)} className={`mt-3 ${primaryButton}`}>
            Exercise ROFR
          </button>
        )
      ) : null}

      {l.myElection === "active" && windowOpen ? (
        <button type="button" disabled={withdrawMut.isPending} onClick={() => withdrawMut.mutate()} className={`mt-3 ${quietButton}`}>
          Withdraw my election
        </button>
      ) : null}
    </div>
  );
}

function MemberRow(props: { propertyId: string; listingId: string; memberId: string; name: string; position: string | null }) {
  const refresh = useRefresh(props.propertyId);
  const record = useServerFn(recordResalePosition);
  const [position, setPosition] = useState<RofrPosition>((props.position as RofrPosition) ?? "exercise");
  const [initials, setInitials] = useState("");
  const mut = useMutation({
    mutationFn: () => record({ data: { propertyId: props.propertyId, listingId: props.listingId, accountMemberId: props.memberId, position, initials } }),
    onSuccess: (r) => {
      if (r.error) toast.error(r.error);
      setInitials("");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2 text-sm">
      <span className="min-w-0 flex-1 font-medium text-foreground">
        {props.name}
        <span className="ml-2 font-normal text-muted-foreground">
          {props.position === "exercise" ? "Exercise" : props.position === "decline" ? "Decline" : "No position yet"}
        </span>
      </span>
      <select
        value={position}
        onChange={(e) => setPosition(e.target.value as RofrPosition)}
        aria-label={`${props.name}'s position`}
        className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
      >
        <option value="exercise">Exercise</option>
        <option value="decline">Decline</option>
      </select>
      <input
        value={initials}
        onChange={(e) => setInitials(e.target.value)}
        placeholder="Initials"
        aria-label={`${props.name}'s initials`}
        className="w-20 rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
      />
      <button type="button" disabled={!initials.trim() || mut.isPending} onClick={() => mut.mutate()} className={quietButton}>
        Record
      </button>
    </div>
  );
}
