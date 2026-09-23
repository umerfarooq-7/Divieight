import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ShieldCheck } from "lucide-react";
import {
  castInsuranceVote,
  getBuyerInsurance,
  proposeInsuranceAlternative,
  type BuyerInsuranceProperty,
} from "@/lib/insurance.functions";
import {
  BLOCK2_AUTHORITY_NOTICE,
  DECLARED_USE_LABELS,
  RIGHT_TO_SHOP_NOTICE,
  formatDate,
  usd,
} from "@/lib/insurance";

export const Route = createFileRoute("/buyer/insurance")({
  head: () => ({
    meta: [
      { title: "Homeowners insurance — divieight" },
      {
        name: "description",
        content: "The homeowners coverage the Manager procures for your home, and your Right to Shop for an alternative.",
      },
      { property: "og:title", content: "Homeowners insurance — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: BuyerInsurance,
});

function BuyerInsurance() {
  const load = useServerFn(getBuyerInsurance);
  const { data, isLoading } = useQuery({ queryKey: ["buyer-insurance"], queryFn: () => load() });
  const properties = data?.properties ?? [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-semibold text-foreground">Homeowners insurance</h1>
        <p className="mt-1 text-sm text-muted-foreground">{BLOCK2_AUTHORITY_NOTICE}</p>
      </header>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : properties.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          Coverage details appear here once you've reserved a share.
        </p>
      ) : (
        <div className="space-y-6">
          {properties.map((p) => (
            <PropertyInsurance key={p.propertyId} p={p} />
          ))}
        </div>
      )}
    </div>
  );
}

const input = "mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground";

function PropertyInsurance({ p }: { p: BuyerInsuranceProperty }) {
  const qc = useQueryClient();
  const propose = useServerFn(proposeInsuranceAlternative);
  const vote = useServerFn(castInsuranceVote);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ carrierName: "", coverageAmount: "", liabilityCoverage: "", premium: "", policySummary: "" });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const refresh = () => qc.invalidateQueries({ queryKey: ["buyer-insurance"] });

  const proposeMut = useMutation({
    mutationFn: () =>
      propose({
        data: {
          propertyId: p.propertyId,
          carrierName: form.carrierName,
          policySummary: form.policySummary || null,
          coverageAmount: Number(form.coverageAmount),
          liabilityCoverage: Number(form.liabilityCoverage),
          premium: Number(form.premium),
        },
      }),
    onSuccess: () => {
      toast.success("Submitted — the Manager will review it against the coverage requirements.");
      setOpen(false);
      setForm({ carrierName: "", coverageAmount: "", liabilityCoverage: "", premium: "", policySummary: "" });
      void refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const voteMut = useMutation({
    mutationFn: (proposalId: string) => vote({ data: { propertyId: p.propertyId, proposalId } }),
    onSuccess: () => {
      toast.success("Vote recorded.");
      void refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const approved = p.proposals.filter((x) => x.status === "approved");

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">{DECLARED_USE_LABELS[p.declaredUse]}</p>
      <h2 className="font-display text-lg font-semibold text-foreground">{p.propertyLabel}</h2>

      <div className="mt-4 rounded-lg border border-border bg-background p-4 text-sm">
        {p.policy ? (
          <>
            <p className="flex items-center gap-2 font-medium text-foreground">
              <ShieldCheck className="h-4 w-4 text-accent" /> {p.policy.carrier_name} · policy {p.policy.policy_number}
              <span className="rounded-full bg-secondary px-2 py-0.5 text-xs">{p.policy.status}</span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {usd(p.policy.coverage_amount)} dwelling · {usd(p.policy.liability_coverage)} liability · annual premium{" "}
              {usd(p.policy.premium)} (LLC operating expense) · effective {formatDate(p.policy.effective_date)} · renews{" "}
              {formatDate(p.policy.renews_at)}
              {p.policy.procurement_method === "buyer_alternative" ? " · pod-selected alternative" : ""}
            </p>
          </>
        ) : (
          <p className="text-muted-foreground">
            The Manager has not bound coverage yet. It must be bound and effective by closing.
          </p>
        )}
        {p.minimums ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Required minimums: {usd(p.minimums.dwelling)} dwelling · {usd(p.minimums.liability)} liability
            {p.requirementsPlaceholder ? " (provisional — being finalized by platform compliance)" : ""}
          </p>
        ) : null}
      </div>

      <h3 className="mt-5 text-sm font-semibold text-foreground">Right to Shop</h3>
      <p className="mt-1 text-xs text-muted-foreground">{RIGHT_TO_SHOP_NOTICE}</p>

      {p.proposals.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {p.proposals.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm">
              <div>
                <p className="font-medium text-foreground">
                  {x.carrier_name}
                  {x.mine ? " · your proposal" : ""}
                </p>
                <p className="text-xs text-muted-foreground">
                  {usd(x.coverage_amount)} dwelling · {usd(x.liability_coverage)} liability · {usd(x.premium)}/yr · {x.status}
                  {p.voteOpen && x.status === "approved" ? ` · ${x.votes} vote(s)` : ""}
                </p>
                {x.review_notes ? <p className="text-xs text-muted-foreground">{x.review_notes}</p> : null}
              </div>
              {p.voteOpen && x.status === "approved" ? (
                <button
                  type="button"
                  disabled={voteMut.isPending || p.myVote === x.id}
                  onClick={() => voteMut.mutate(x.id)}
                  className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                >
                  {p.myVote === x.id ? "Your vote" : "Vote for this"}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {p.voteOpen ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {approved.length} approved alternatives — one vote per Buyer Account. You can change your vote until the Manager closes it.
        </p>
      ) : null}

      {open ? (
        <div className="mt-4 grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2">
          <label className="block text-xs text-muted-foreground sm:col-span-2">
            Carrier
            <input value={form.carrierName} onChange={set("carrierName")} className={input} />
          </label>
          <label className="block text-xs text-muted-foreground">
            Dwelling coverage ($)
            <input type="number" value={form.coverageAmount} onChange={set("coverageAmount")} className={input} />
          </label>
          <label className="block text-xs text-muted-foreground">
            Liability coverage ($)
            <input type="number" value={form.liabilityCoverage} onChange={set("liabilityCoverage")} className={input} />
          </label>
          <label className="block text-xs text-muted-foreground">
            Quoted annual premium ($)
            <input type="number" value={form.premium} onChange={set("premium")} className={input} />
          </label>
          <label className="block text-xs text-muted-foreground sm:col-span-2">
            Policy details (optional)
            <textarea value={form.policySummary} onChange={set("policySummary")} rows={3} className={input} />
          </label>
          <div className="flex gap-2 sm:col-span-2">
            <button
              type="button"
              disabled={proposeMut.isPending}
              onClick={() => proposeMut.mutate()}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              Submit for review
            </button>
            <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-border px-4 py-2 text-sm">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="mt-4 text-sm font-medium text-primary hover:underline">
          Propose an alternative carrier →
        </button>
      )}
    </section>
  );
}
