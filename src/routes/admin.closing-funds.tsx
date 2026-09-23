import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { Banknote, RefreshCw } from "lucide-react";
import {
  issueClosingFunds,
  listAdminClosingFunds,
  markClosingFundsFunded,
  runClosingFundsDeadlineSweep,
} from "@/lib/closing-funds.functions";
import {
  CLOSING_DIRECT_TO_ESCROW_NOTICE,
  CLOSING_STATUS_LABELS,
  ENROLLMENT_FEE_DOES_NOT_FUND,
  ENROLLMENT_FEE_FUNDS,
} from "@/lib/closing-funds";
import {
  formatDeadline,
  money,
  type EarnestStatus,
} from "@/lib/earnest-money";

export const Route = createFileRoute("/admin/closing-funds")({
  component: AdminClosingFunds,
});

const BADGE: Record<EarnestStatus, string> = {
  pending: "bg-amber-100 text-amber-800",
  funded: "bg-emerald-100 text-emerald-800",
  late: "bg-orange-100 text-orange-800",
  missed: "bg-destructive/10 text-destructive",
};

function AdminClosingFunds() {
  const qc = useQueryClient();
  const fetchAll = useServerFn(listAdminClosingFunds);
  const issue = useServerFn(issueClosingFunds);
  const markFunded = useServerFn(markClosingFundsFunded);
  const sweep = useServerFn(runClosingFundsDeadlineSweep);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-closing-funds"],
    queryFn: () => fetchAll(),
  });
  const properties = data?.properties ?? [];

  const [selected, setSelected] = useState<string>("");
  const [total, setTotal] = useState("");
  const [deadline, setDeadline] = useState("");
  const [company, setCompany] = useState("");
  const [details, setDetails] = useState("");
  const [reference, setReference] = useState("");
  const [contact, setContact] = useState("");
  const [methods, setMethods] = useState("Wire transfer");

  const invalidate = () => qc.invalidateQueries({ queryKey: ["admin-closing-funds"] });

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
          <h1 className="font-display text-2xl font-semibold text-foreground">Closing funds</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {CLOSING_DIRECT_TO_ESCROW_NOTICE} Trigger this 7–14 days before closing.
          </p>
          <div className="mt-3 grid max-w-2xl gap-3 text-xs sm:grid-cols-2">
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <p className="font-semibold text-foreground">Platform Enrollment Fee funds</p>
              <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                {ENROLLMENT_FEE_FUNDS.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <p className="font-semibold text-foreground">
                NOT funded by it — each Buyer Account's closing-table cost
              </p>
              <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                {ENROLLMENT_FEE_DOES_NOT_FUND.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          </div>
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
          Issue Closing Funds Notices
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Enter the Buyer Group's total closing-table amount from the settlement statement; the
          platform splits it pro-rata by shares and sends each Buyer Account its exact amount.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">Property</span>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="">
                {isLoading ? "Loading properties…" : "Select a property with a live pod"}
              </option>
              {properties.map((p) => (
                <option key={p.propertyId} value={p.propertyId}>
                  {p.propertyLabel} · {p.shares} share(s)
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">
              Total closing-table funds (USD)
            </span>
            <input
              value={total}
              onChange={(e) => setTotal(e.target.value)}
              inputMode="decimal"
              placeholder="250000"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-muted-foreground">Wire deadline</span>
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
          {issueMut.isPending ? "Issuing…" : "Issue notices"}
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
                          {CLOSING_STATUS_LABELS[o.status]}
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
              No Closing Funds Notices issued yet.
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
