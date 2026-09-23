import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, ShieldAlert } from "lucide-react";
import {
  bindInsurancePolicy,
  getAdminInsurance,
  lapseInsurancePolicy,
  markInsurancePremiumPaid,
  recordInsurancePolicy,
  renewInsurancePolicy,
  resolveInsuranceAlternatives,
  reviewInsuranceProposal,
} from "@/lib/insurance.functions";
import {
  BLOCK2_AUTHORITY_NOTICE,
  DECLARED_USE_LABELS,
  PLACEHOLDER_WARNING,
  checkCoverage,
  formatDate,
  usd,
  type InsurancePolicy,
} from "@/lib/insurance";

export const Route = createFileRoute("/admin/properties/$id/insurance")({
  head: () => ({
    meta: [
      { title: "Insurance procurement — divieight admin" },
      { name: "description", content: "Manager procurement of homeowners/hazard coverage for a property." },
      { property: "og:title", content: "Insurance procurement — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminPropertyInsurance,
});

const STATUS_BADGE: Record<InsurancePolicy["status"], string> = {
  pending: "bg-amber-100 text-amber-800",
  bound: "bg-emerald-100 text-emerald-800",
  lapsed: "bg-destructive/10 text-destructive",
};

const input = "mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground";

function AdminPropertyInsurance() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const load = useServerFn(getAdminInsurance);
  const record = useServerFn(recordInsurancePolicy);
  const bind = useServerFn(bindInsurancePolicy);
  const premium = useServerFn(markInsurancePremiumPaid);
  const lapse = useServerFn(lapseInsurancePolicy);
  const renew = useServerFn(renewInsurancePolicy);
  const review = useServerFn(reviewInsuranceProposal);
  const resolve = useServerFn(resolveInsuranceAlternatives);

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-insurance", id],
    queryFn: () => load({ data: { propertyId: id } }),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin-insurance", id] });
  const onError = (e: Error) => toast.error(e.message);

  const [form, setForm] = useState({
    carrierName: "",
    policyNumber: "",
    coverageAmount: "",
    liabilityCoverage: "",
    premium: "",
    effectiveDate: "",
    renewsAt: "",
    replacementCost: "",
    alternativeProposalId: "",
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const replacementCost = Number(form.replacementCost || data?.property?.listing_price || 0);
  const check =
    data?.requirements && replacementCost > 0
      ? checkCoverage(data.requirements.rules, {
          replacementCost,
          use: data.declaredUse,
          coverage: Number(form.coverageAmount || 0),
          liability: Number(form.liabilityCoverage || 0),
        })
      : null;

  const selected = data?.proposals.find((p) => p.status === "selected") ?? null;

  const recordMut = useMutation({
    mutationFn: () =>
      record({
        data: {
          propertyId: id,
          carrierName: selected && form.alternativeProposalId ? selected.carrier_name : form.carrierName,
          policyNumber: form.policyNumber,
          coverageAmount: Number(form.coverageAmount),
          liabilityCoverage: form.liabilityCoverage ? Number(form.liabilityCoverage) : null,
          premium: Number(form.premium),
          effectiveDate: form.effectiveDate,
          renewsAt: form.renewsAt || null,
          replacementCost,
          method: form.alternativeProposalId ? "buyer_alternative" : "default",
          alternativeProposalId: form.alternativeProposalId || null,
        },
      }),
    onSuccess: () => {
      toast.success("Policy recorded as pending — bind it once the carrier confirms.");
      setForm((f) => ({ ...f, policyNumber: "", premium: "" }));
      void refresh();
    },
    onError,
  });

  const act = useMutation({
    mutationFn: async (v: { kind: "bind" | "premium" | "lapse"; policyId: string }) => {
      const fn = v.kind === "bind" ? bind : v.kind === "premium" ? premium : lapse;
      return fn({ data: { policyId: v.policyId } });
    },
    onSuccess: (_r, v) => {
      toast.success(v.kind === "bind" ? "Policy bound." : v.kind === "premium" ? "Premium payment recorded." : "Policy marked lapsed.");
      void refresh();
    },
    onError,
  });

  const renewMut = useMutation({
    mutationFn: (p: InsurancePolicy) => {
      const policyNumber = window.prompt("Renewal policy number", p.policy_number);
      if (!policyNumber) throw new Error("Renewal cancelled");
      const effectiveDate = window.prompt("Renewal effective date (YYYY-MM-DD)", p.renews_at ?? "");
      if (!effectiveDate) throw new Error("Renewal cancelled");
      const renewsAt = window.prompt("Next renewal date (YYYY-MM-DD)", "") || null;
      const prem = window.prompt("Renewal premium (USD)", String(p.premium));
      return renew({
        data: {
          policyId: p.id,
          policyNumber,
          coverageAmount: p.coverage_amount,
          liabilityCoverage: p.liability_coverage,
          premium: Number(prem),
          effectiveDate,
          renewsAt,
        },
      });
    },
    onSuccess: () => {
      toast.success("Renewal recorded as pending — bind it when confirmed.");
      void refresh();
    },
    onError: (e: Error) => {
      if (e.message !== "Renewal cancelled") toast.error(e.message);
    },
  });

  const reviewMut = useMutation({
    mutationFn: (v: { proposalId: string; approve: boolean }) =>
      review({
        data: {
          proposalId: v.proposalId,
          approve: v.approve,
          replacementCost,
          notes: v.approve ? null : window.prompt("Reason for rejection (sent to the buyer)") || null,
        },
      }),
    onSuccess: (r) => {
      toast.success(`Proposal ${r.status}.`);
      void refresh();
    },
    onError,
  });

  const resolveMut = useMutation({
    mutationFn: () => resolve({ data: { propertyId: id } }),
    onSuccess: (r) => {
      toast.success(
        r.selectedId
          ? "Alternative selected — record its policy below."
          : r.reason === "tie"
            ? "Vote tied — the Manager's default policy stands."
            : r.reason === "no_votes"
              ? "No votes cast yet — the default stands for now."
              : "No approved alternatives.",
      );
      void refresh();
    },
    onError,
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error || !data) return <p className="text-sm text-destructive">{(error as Error)?.message ?? "Unavailable"}</p>;
  const p = data.property;

  return (
    <div>
      <Link
        to="/admin/properties"
        className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground"
      >
        ← Properties
      </Link>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight text-foreground">Insurance procurement</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {p ? `${p.address}, ${p.city}, ${p.state}` : "Property"} · declared use: {DECLARED_USE_LABELS[data.declaredUse]}
        {p?.anticipated_closing_date ? ` · closing ${formatDate(p.anticipated_closing_date)}` : ""}
      </p>
      <p className="mt-1 max-w-3xl text-xs text-muted-foreground">{BLOCK2_AUTHORITY_NOTICE}</p>

      <div
        className={`mt-5 flex gap-2 rounded-xl border p-4 text-sm ${
          data.gate.ok
            ? "border-emerald-300 bg-emerald-50 text-emerald-900"
            : "border-destructive/40 bg-destructive/5 text-destructive"
        }`}
      >
        {data.gate.ok ? <CheckCircle2 className="h-5 w-5 shrink-0" /> : <ShieldAlert className="h-5 w-5 shrink-0" />}
        <div>
          <p className="font-semibold">Disbursement Check: {data.gate.ok ? "insurance precondition met" : "BLOCKED"}</p>
          <p className="text-xs">{data.gate.message}</p>
        </div>
      </div>

      {data.requirements?.is_placeholder ? (
        <p className="mt-3 flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs font-medium text-amber-900">
          <AlertTriangle className="h-4 w-4 shrink-0" /> Coverage requirements v{data.requirements.version}: {PLACEHOLDER_WARNING}{" "}
          <Link to="/admin/insurance-requirements" className="underline">
            Edit requirements
          </Link>
        </p>
      ) : null}

      <section className="mt-6 rounded-xl border border-border bg-card p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-foreground">Record a procured policy</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {selected ? (
            <label className="block text-xs text-muted-foreground sm:col-span-3">
              Procurement
              <select value={form.alternativeProposalId} onChange={set("alternativeProposalId")} className={input}>
                <option value="">Manager's default carrier</option>
                <option value={selected.id}>Pod-selected alternative: {selected.carrier_name}</option>
              </select>
            </label>
          ) : null}
          {!form.alternativeProposalId ? (
            <label className="block text-xs text-muted-foreground">
              Carrier
              <input value={form.carrierName} onChange={set("carrierName")} className={input} />
            </label>
          ) : null}
          <label className="block text-xs text-muted-foreground">
            Policy number
            <input value={form.policyNumber} onChange={set("policyNumber")} className={input} />
          </label>
          <label className="block text-xs text-muted-foreground">
            Replacement cost ($)
            <input
              type="number"
              value={form.replacementCost}
              placeholder={p?.listing_price ? String(p.listing_price) : ""}
              onChange={set("replacementCost")}
              className={input}
            />
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
            Annual premium ($) — LLC operating expense
            <input type="number" value={form.premium} onChange={set("premium")} className={input} />
          </label>
          <label className="block text-xs text-muted-foreground">
            Effective date (must cover closing)
            <input type="date" value={form.effectiveDate} onChange={set("effectiveDate")} className={input} />
          </label>
          <label className="block text-xs text-muted-foreground">
            Renews on
            <input type="date" value={form.renewsAt} onChange={set("renewsAt")} className={input} />
          </label>
        </div>
        {check ? (
          <p className={`mt-3 text-xs ${check.meets ? "text-emerald-700" : "text-destructive"}`}>
            {check.rule
              ? `Minimums: ${usd(check.rule.min_dwelling_coverage)} dwelling · ${usd(check.rule.min_liability_coverage)} liability. `
              : ""}
            {check.meets ? "Meets requirements." : check.shortfalls.join(" ")}
          </p>
        ) : null}
        <button
          type="button"
          disabled={recordMut.isPending}
          onClick={() => recordMut.mutate()}
          className="mt-3 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          Record policy
        </button>
      </section>

      <h2 className="mt-8 text-sm font-semibold text-foreground">Policies</h2>
      <div className="mt-3 space-y-3">
        {data.policies.length === 0 ? (
          <p className="text-sm text-muted-foreground">No policy recorded yet.</p>
        ) : (
          data.policies.map((pol) => (
            <div key={pol.id} className="rounded-xl border border-border bg-card p-4 text-sm shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-medium text-foreground">
                    {pol.carrier_name} · {pol.policy_number}
                    {pol.procurement_method === "buyer_alternative" ? " · buyer alternative" : " · Manager default"}
                    {pol.renewed_from_policy_id ? " · renewal" : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {usd(pol.coverage_amount)} dwelling · {usd(pol.liability_coverage)} liability · premium {usd(pol.premium)}
                    {pol.premium_paid_at ? ` (paid ${formatDate(pol.premium_paid_at)} from LLC operating account)` : " (premium unpaid)"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Effective {formatDate(pol.effective_date)} · renews {formatDate(pol.renews_at)} · requirements v
                    {pol.requirement_version ?? "—"}
                  </p>
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_BADGE[pol.status]}`}>{pol.status}</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {pol.status === "pending" ? (
                  <button className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground" onClick={() => act.mutate({ kind: "bind", policyId: pol.id })}>
                    Mark bound
                  </button>
                ) : null}
                {!pol.premium_paid_at && pol.status !== "lapsed" ? (
                  <button className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium" onClick={() => act.mutate({ kind: "premium", policyId: pol.id })}>
                    Record premium paid
                  </button>
                ) : null}
                {pol.status === "bound" ? (
                  <button className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium" onClick={() => renewMut.mutate(pol)}>
                    Record renewal
                  </button>
                ) : null}
                {pol.status !== "lapsed" ? (
                  <button
                    className="rounded-lg border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive"
                    onClick={() => window.confirm("Mark this policy lapsed?") && act.mutate({ kind: "lapse", policyId: pol.id })}
                  >
                    Mark lapsed
                  </button>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>

      <h2 className="mt-8 text-sm font-semibold text-foreground">Right to Shop — buyer-proposed alternatives</h2>
      <div className="mt-3 space-y-3">
        {data.proposals.length === 0 ? (
          <p className="text-sm text-muted-foreground">No alternatives proposed.</p>
        ) : (
          data.proposals.map((prop) => {
            const c = data.requirements
              ? checkCoverage(data.requirements.rules, {
                  replacementCost,
                  use: data.declaredUse,
                  coverage: prop.coverage_amount,
                  liability: prop.liability_coverage,
                })
              : null;
            return (
              <div key={prop.id} className="rounded-xl border border-border bg-card p-4 text-sm shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-medium text-foreground">
                      {prop.carrier_name} <span className="text-xs text-muted-foreground">· proposed by {prop.buyerEmail ?? "Buyer Account"}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {usd(prop.coverage_amount)} dwelling · {usd(prop.liability_coverage)} liability · premium {usd(prop.premium)}
                      {prop.status === "approved" && data.tally ? ` · ${prop.votes} vote(s)` : ""}
                    </p>
                    {prop.policy_summary ? <p className="mt-1 text-xs text-muted-foreground">{prop.policy_summary}</p> : null}
                    {c && prop.status === "submitted" ? (
                      <p className={`mt-1 text-xs ${c.meets ? "text-emerald-700" : "text-destructive"}`}>
                        {c.meets ? "Meets requirements." : c.shortfalls.join(" ")}
                      </p>
                    ) : null}
                    {prop.review_notes ? <p className="mt-1 text-xs text-muted-foreground">Note: {prop.review_notes}</p> : null}
                  </div>
                  <span className="rounded-full bg-secondary px-3 py-1 text-xs font-medium text-foreground">{prop.status}</span>
                </div>
                {prop.status === "submitted" ? (
                  <div className="mt-3 flex gap-2">
                    <button
                      disabled={!c?.meets}
                      className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                      onClick={() => reviewMut.mutate({ proposalId: prop.id, approve: true })}
                    >
                      Approve
                    </button>
                    <button
                      className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium"
                      onClick={() => reviewMut.mutate({ proposalId: prop.id, approve: false })}
                    >
                      Reject
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
      {data.proposals.some((x) => x.status === "approved") ? (
        <button
          type="button"
          onClick={() => resolveMut.mutate()}
          className="mt-3 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground"
        >
          {data.tally ? `Close vote (${data.tally.totalVotes} cast) & select` : "Select the approved alternative"}
        </button>
      ) : null}
    </div>
  );
}
