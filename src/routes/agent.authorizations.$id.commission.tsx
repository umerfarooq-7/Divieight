import { useCallback, useEffect, useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  listAgentAuthorizations,
  proposeCommissionItem,
  type AgentAuthorizationRow,
} from "@/lib/authorization.functions";
import {
  COMMISSION_FUNDING_SOURCES,
  COMMISSION_PROPOSER_NOTE,
  NON_CONTINGENT_TEXT,
  commissionStatement,
  formatCents,
  perShareCommissionCents,
  type CommissionFundingSource,
} from "@/lib/commission-item";
import { AUTHORIZATION_ACTION_LABELS } from "@/lib/authorization";

export const Route = createFileRoute("/agent/authorizations/$id/commission")({
  component: ProposeCommission,
});

function ProposeCommission() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const load = useServerFn(listAgentAuthorizations);
  const propose = useServerFn(proposeCommissionItem);

  const [row, setRow] = useState<AgentAuthorizationRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [rate, setRate] = useState("3");
  const [funding, setFunding] = useState<CommissionFundingSource>("proceeds_at_closing");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    const result = await load({});
    const hit = (result.rows as AgentAuthorizationRow[]).find((r) => r.id === id) ?? null;
    setRow(hit);
    if (hit?.commissionItem) {
      setRate(String(hit.commissionItem.rate_percent));
      setFunding(hit.commissionItem.funding_source);
      setText(hit.commissionItem.provision_text ?? "");
    }
    setLoading(false);
  }, [id, load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  if (!row || !row.isHla) {
    return (
      <div className="rounded-xl border border-border bg-card p-6">
        <p className="text-sm text-foreground">
          Only the pod's Heavy Lifting Agent may propose the buyer-side commission provision for
          this request.
        </p>
        <Link
          to="/agent/authorizations"
          className="mt-3 inline-block text-sm font-medium text-primary hover:underline"
        >
          Back to authorization requests
        </Link>
      </div>
    );
  }

  const rateNumber = Number(rate);
  const validRate = Number.isFinite(rateNumber) && rateNumber >= 0 && rateNumber <= 100;
  const shareBasis = row.commissionItem?.share_price_cents ?? 0;
  const perShare = validRate
    ? row.commissionItem
      ? Math.round((shareBasis * rateNumber) / 100)
      : perShareCommissionCents(null, rateNumber)
    : 0;

  async function save() {
    if (!validRate) {
      toast.error("Enter the commission rate as a percentage");
      return;
    }
    setSaving(true);
    try {
      await propose({
        data: {
          requestId: id,
          ratePercent: rateNumber,
          fundingSource: funding,
          provisionText: text,
        },
      });
      toast.success("Provision proposed — each Preferred Member authorizes it separately.");
      await navigate({ to: "/agent/authorizations" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the provision");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <Link to="/agent/authorizations" className="text-sm text-muted-foreground hover:underline">
        ← Authorization requests
      </Link>
      <h1 className="mt-3 font-display text-xl font-semibold text-foreground">
        Propose the buyer-side commission provision
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {AUTHORIZATION_ACTION_LABELS[row.action_type]} · {row.propertyLabel}
      </p>
      <p className="mt-3 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
        You propose this provision as the Heavy Lifting Agent. Each Preferred Member's tethered
        Resident Agent reviews it, and each Member authorizes it as a separate act from the
        instrument itself.
      </p>

      <div className="mt-6 space-y-4">
        <label className="block">
          <span className="text-sm font-medium text-foreground">
            Buyer-side commission rate (% of the 1/8th share price)
          </span>
          <input
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            inputMode="decimal"
            placeholder="2.5"
            className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-foreground">Funding source</span>
          <select
            value={funding}
            onChange={(e) => setFunding(e.target.value as CommissionFundingSource)}
            className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
          >
            {COMMISSION_FUNDING_SOURCES.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-sm font-medium text-foreground">
            Provision text as it appears in the instrument
          </span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
          />
        </label>

        {row.commissionItem && validRate ? (
          <p className="text-xs text-muted-foreground">
            Per 1/8th share at this rate: {formatCents(perShare)}.
          </p>
        ) : null}

        <div className="rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">What each Member will see</p>
          <p className="mt-2 whitespace-pre-line">
            {row.commissionItem && validRate
              ? commissionStatement({
                  rate_percent: rateNumber,
                  funding_source: funding,
                  per_share_amount_cents: perShare,
                  provision_text: text,
                })
              : NON_CONTINGENT_TEXT}
          </p>
          <p className="mt-2">{COMMISSION_PROPOSER_NOTE}</p>
        </div>

        <button
          type="button"
          disabled={saving}
          onClick={save}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {row.commissionItem ? "Revise provision" : "Propose provision"}
        </button>
        {row.commissionItem ? (
          <p className="text-xs text-muted-foreground">
            Revising the provision clears any prior Member authorizations — each Member must
            authorize the revised provision again.
          </p>
        ) : null}
      </div>
    </div>
  );
}
