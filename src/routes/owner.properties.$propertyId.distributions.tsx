import { useEffect, useState, type FormEvent } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { OwnerLoading, OwnerPageShell } from "@/components/owner/useOwnerProperty";
import { useAuth } from "@/hooks/use-auth";
import { formatCents } from "@/lib/bank-feed-display";
import { DISTRIBUTION_STATUS_LABELS, PAYMENT_STATUS_LABELS, bankDetailsProblem, maskedAccount } from "@/lib/distributions";
import { formatDate } from "@/lib/format-date";
import { getOwnerDistributions, removePayoutMethodFn, savePayoutMethodFn } from "@/lib/distributions.functions";

export const Route = createFileRoute("/owner/properties/$propertyId/distributions")({
  head: () => ({
    meta: [
      { title: "Distributions — divieight" },
      { name: "description", content: "Your distributions from this home's LLC, and where they are paid." },
      { property: "og:title", content: "Distributions — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: OwnerDistributionsPage,
});

const FIELD = "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-normal";

function PayoutMethodForm({ propertyId, current, done }: { propertyId: string; current: { last4: string; bankName: string | null } | null; done: () => void }) {
  const save = useServerFn(savePayoutMethodFn);
  const remove = useServerFn(removePayoutMethodFn);
  const [routing, setRouting] = useState("");
  const [account, setAccount] = useState("");
  const [bankName, setBankName] = useState("");
  const problem = routing || account ? bankDetailsProblem(routing, account) : null;
  const saveM = useMutation({
    mutationFn: () => save({ data: { propertyId, routing, account, bankName } }),
    onSuccess: (r) => {
      // The numbers are cleared at once: only a token and the last four digits are kept.
      setRouting("");
      setAccount("");
      setBankName("");
      toast.success(r.released > 0 ? "Payout method saved. A payment that was held for you is being sent." : "Payout method saved.");
      done();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const removeM = useMutation({
    mutationFn: () => remove({ data: { propertyId } }),
    onSuccess: () => {
      toast.success("Payout method removed. Distributions will be held until you add one.");
      done();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    saveM.mutate();
  };
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h2 className="font-display text-lg font-semibold text-foreground">Where you are paid</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {current ? `${maskedAccount(current.last4)}${current.bankName ? ` · ${current.bankName}` : ""}.` : "You have no payout method yet. A distribution to you is held, not lost, until you add one."}
      </p>
      <form onSubmit={submit} className="mt-3 space-y-3" autoComplete="off">
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-xs font-medium text-foreground">
            Bank name (optional)
            <input className={FIELD} value={bankName} maxLength={100} onChange={(e) => setBankName(e.target.value)} autoComplete="off" />
          </label>
          <label className="block text-xs font-medium text-foreground">
            Routing number
            <input className={FIELD} inputMode="numeric" maxLength={9} value={routing} onChange={(e) => setRouting(e.target.value.replace(/\D/g, ""))} autoComplete="off" />
          </label>
          <label className="block text-xs font-medium text-foreground">
            Account number
            <input className={FIELD} inputMode="numeric" maxLength={17} value={account} onChange={(e) => setAccount(e.target.value.replace(/\D/g, ""))} autoComplete="off" />
          </label>
        </div>
        {problem ? <p className="text-xs text-destructive">{problem}</p> : null}
        <p className="text-xs text-muted-foreground">Your bank details are tokenized when you save them. divieight keeps only a token and the last four digits, never the full numbers.</p>
        <div className="flex gap-3">
          <button type="submit" disabled={!routing || !account || !!problem || saveM.isPending} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {saveM.isPending ? "Saving…" : current ? "Replace payout method" : "Save payout method"}
          </button>
          {current ? (
            <button type="button" disabled={removeM.isPending} onClick={() => removeM.mutate()} className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary">
              Remove
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}

function OwnerDistributionsPage() {
  const { propertyId } = Route.useParams();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const load = useServerFn(getOwnerDistributions);
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ["owner-distributions", propertyId, user?.id], enabled: !!user, retry: false, queryFn: () => load({ data: { propertyId } }) });

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
      <h1 className="mt-4 font-display text-2xl font-semibold text-foreground sm:text-3xl">Distributions</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        What the LLC has distributed to you, by the owners on each record date. A distribution is paid by ACH to your payout method. If you have none, it is held for you and sent as soon as you add one; no one else's payment waits on yours. Your amounts are also in your capital account.
      </p>
      <div className="mt-6 space-y-4">
        {isLoading || authLoading ? <OwnerLoading /> : null}
        {isError ? (
          <p className="text-sm text-destructive">
            Couldn't load your distributions.{" "}
            <button type="button" className="underline" onClick={() => refetch()}>
              Try again
            </button>
          </p>
        ) : null}
        {data?.allowed ? <PayoutMethodForm propertyId={propertyId} current={data.payoutMethod} done={() => void refetch()} /> : null}
        {data?.allowed && data.distributions.length === 0 ? <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">No distributions yet.</p> : null}
        {data?.allowed
          ? data.distributions.map((d) => (
              <section key={`${d.distributionId}`} className="rounded-xl border border-border bg-card p-5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="font-medium text-foreground">Record date {formatDate(d.recordDate)}</p>
                  <p className={`font-semibold text-foreground ${d.distributionStatus === "voided" ? "line-through" : ""}`}>{formatCents(d.amountCents)}</p>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {DISTRIBUTION_STATUS_LABELS[d.distributionStatus]} · Your payment: {PAYMENT_STATUS_LABELS[d.status]}
                  {d.last4 ? ` · ${maskedAccount(d.last4)}` : ""}
                  {d.sentAt ? ` · Sent ${formatDate(d.sentAt)}` : ""}
                  {d.reversed ? " · Reversed in the books" : ""}
                </p>
                {d.reason ? <p className="mt-2 text-sm text-foreground">{d.reason}</p> : null}
                {d.distributionStatus === "voided" && d.voidReason ? <p className="mt-2 rounded-lg bg-muted px-3 py-2 text-sm">Voided: {d.voidReason}</p> : null}
                <p className="mt-1 text-xs text-muted-foreground">
                  {d.shares} {d.shares === 1 ? "share" : "shares"} held on the record date
                </p>
              </section>
            ))
          : null}
      </div>
    </OwnerPageShell>
  );
}
