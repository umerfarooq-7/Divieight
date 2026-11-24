import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { Banknote, RefreshCw } from "lucide-react";
import {
  issueEarnestMoney,
  listAdminEarnestMoney,
  markEarnestFunded,
  runEarnestMoneyDeadlineSweep,
} from "@/lib/earnest-money.functions";
import {
  DEFAULT_FUNDING_METHODS,
  DIRECT_TO_ESCROW_NOTICE,
  EARNEST_STATUS_LABELS,
  NOT_ENROLLMENT_FEE_NOTICE,
  formatDeadline,
  money,
  type EarnestStatus,
} from "@/lib/earnest-money";

export const Route = createFileRoute("/admin/earnest-money")({
  component: AdminEarnestMoney,
});

const BADGE: Record<EarnestStatus, string> = {
  pending: "bg-amber-100 text-amber-800",
  funded: "bg-emerald-100 text-emerald-800",
  late: "bg-orange-100 text-orange-800",
  missed: "bg-destructive/10 text-destructive",
};

function AdminEarnestMoney() {
  const qc = useQueryClient();
  const fetchAll = useServerFn(listAdminEarnestMoney);
  const issue = useServerFn(issueEarnestMoney);
  const markFunded = useServerFn(markEarnestFunded);
  const sweep = useServerFn(runEarnestMoneyDeadlineSweep);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-earnest-money"],
    queryFn: () => fetchAll(),
  });
  const properties = data?.properties ?? [];

  const [selected, setSelected] = useState<string>("");
  const [total, setTotal] = useState("");
  const [totalHint, setTotalHint] = useState("");

  // Picking a property fills the total from what the platform already knows; the field stays editable.
  function pickProperty(id: string) {
    setSelected(id);
    const p = properties.find((x) => x.propertyId === id);
    const s = p?.suggested;
    if (p?.terms?.total_amount != null) {
      setTotal(String(p.terms.total_amount));
      setTotalHint("Filled from the instructions already issued for this property.");
    } else if (s?.earnestMoney != null) {
      setTotal(String(s.earnestMoney));
      setTotalHint(
        s.earnestMoneySource === "offer"
          ? "Filled from the Earnest money term on the offer."
          : `Suggested: 1% of the ${s.purchasePriceSource === "offer" ? "offer" : "listing"} price (${money(s.purchasePrice ?? 0)}). Change it to the figure in the accepted offer.`,
      );
    } else {
      setTotal("");
      setTotalHint("");
    }
  }
  const [deadline, setDeadline] = useState("");
  const [company, setCompany] = useState("");
  const [details, setDetails] = useState("");
  const [reference, setReference] = useState("");
  const [contact, setContact] = useState("");
  const [methods, setMethods] = useState(DEFAULT_FUNDING_METHODS.join(", "));

  const invalidate = () => qc.invalidateQueries({ queryKey: ["admin-earnest-money"] });

  const issueMut = useMutation({
    mutationFn: () =>
      issue({
        data: {
          propertyId: selected,
          totalAmount: Number(total),
          fundingDeadline: deadline,
          escrowCompany: company,
          escrowAccountDetails: details,
          escrowReference: reference || null,
          escrowContactEmail: contact || null,
          fundingMethods: methods
            .split(",")
            .map((m) => m.trim())
            .filter(Boolean),
        },
      }),
    onSuccess: (r) => {
      toast.success(`Funding instructions issued to ${r.issued} Buyer Account(s).`);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const fundedMut = useMutation({
    mutationFn: (v: { obligationId: string; reference: string }) =>
      markFunded({ data: { obligationId: v.obligationId, reference: v.reference || null } }),
    onSuccess: () => {
      toast.success("Marked as funded to escrow.");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const sweepMut = useMutation({
    mutationFn: () => sweep(),
    onSuccess: (r) => {
      toast.success(`${r.markedLate} marked late · ${r.defaulted} Default(s) declared.`);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-foreground">Earnest money</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {DIRECT_TO_ESCROW_NOTICE} {NOT_ENROLLMENT_FEE_NOTICE}
          </p>
        </div>
        <button
          onClick={() => sweepMut.mutate()}
          disabled={sweepMut.isPending}
          className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${sweepMut.isPending ? "animate-spin" : ""}`} />
          Run deadline check
        </button>
      </header>

      <section className="mb-8 rounded-xl border border-border bg-card p-5 shadow-sm">
        <h2 className="font-display text-lg font-semibold text-foreground">
          Issue funding instructions
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Properties whose final acceptance is authorized are listed first. The total comes from
          the accepted offer; the platform splits it pro-rata by shares.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">Property</span>
            <select
              value={selected}
              onChange={(e) => pickProperty(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="">
                {isLoading ? "Loading properties…" : "Select a property with a live pod"}
              </option>
              {properties.map((p) => (
                <option key={p.propertyId} value={p.propertyId}>
                  {p.propertyLabel} · {p.shares} share(s)
                  {p.acceptanceAuthorized ? " · acceptance authorized" : " · manual entry"}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">
              Total earnest money (USD)
            </span>
            <input
              value={total}
              onChange={(e) => setTotal(e.target.value)}
              inputMode="decimal"
              placeholder="25000"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            />
            {totalHint ? <span className="mt-1 block text-xs text-muted-foreground">{totalHint}</span> : null}
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">Funding deadline</span>
            <input
              type="datetime-local"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">
              Title/escrow company
            </span>
            <input
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="Placeholder Title & Escrow Co."
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="mb-1 block text-xs text-muted-foreground">
              Escrow account details
            </span>
            <textarea
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              rows={3}
              placeholder={"Bank: …\nRouting: …\nAccount: …"}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">Escrow reference</span>
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">
              Escrow contact email (default notices)
            </span>
            <input
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="mb-1 block text-xs text-muted-foreground">
              Acceptable funding methods (comma separated)
            </span>
            <input
              value={methods}
              onChange={(e) => setMethods(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            />
          </label>
        </div>

        <button
          onClick={() => issueMut.mutate()}
          disabled={issueMut.isPending || !selected}
          className="mt-4 inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-foreground disabled:opacity-60"
        >
          <Banknote className="h-4 w-4" />
          {issueMut.isPending ? "Issuing…" : "Issue instructions"}
        </button>
      </section>

      <h2 className="mb-3 font-display text-lg font-semibold text-foreground">
        Obligation tracking
      </h2>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading obligations…</p>
      ) : (
        <div className="space-y-5">
          {properties
            .filter((p) => p.obligations.length > 0)
            .map((p) => (
              <section
                key={p.propertyId}
                className="rounded-xl border border-border bg-card p-5 shadow-sm"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="font-display text-base font-semibold text-foreground">
                    {p.propertyLabel}
                  </h3>
                  {p.terms ? (
                    <p className="text-xs text-muted-foreground">
                      {money(p.terms.total_amount)} total · due{" "}
                      {formatDeadline(p.terms.funding_deadline)} · {p.terms.escrow_company}
                    </p>
                  ) : null}
                </div>
                <ul className="mt-3 space-y-2">
                  {p.obligations.map((o) => (
                    <li
                      key={o.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background p-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">
                          {o.buyerEmail ?? o.buyer_account_id}
                          {o.is_substitute ? " · substitute member" : ""}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {money(o.amount)} · {o.shares} share(s) · due{" "}
                          {formatDeadline(o.funding_deadline)}
                          {o.funded_at ? ` · funded ${formatDeadline(o.funded_at)}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-medium ${BADGE[o.status]}`}
                        >
                          {EARNEST_STATUS_LABELS[o.status]}
                        </span>
                        {o.status !== "funded" && o.status !== "missed" ? (
                          <button
                            onClick={() => {
                              const ref = window.prompt("Escrow receipt reference (optional)") ?? "";
                              fundedMut.mutate({ obligationId: o.id, reference: ref });
                            }}
                            disabled={fundedMut.isPending}
                            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-60"
                          >
                            Mark funded
                          </button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          {properties.every((p) => p.obligations.length === 0) ? (
            <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
              No obligations issued yet.
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
