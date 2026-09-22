import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { formatCents, formatRate, fundingSourceLabel } from "@/lib/commission-item";
import {
  AUTHORIZATION_ACTIONS,
  COMMISSION_BEARING_ACTIONS,
  AUTHORIZATION_ACTION_LABELS,
  authorizationStatusLabel,
  formatDeadline,
  type AuthorizationAction,
  type AuthorizationRequestRow,
} from "@/lib/authorization";
import {
  createAuthorizationRequest,
  listAdminAuthorizations,
  listAuthorizationTargets,
  runAuthorizationEscalation,
} from "@/lib/authorization.functions";

export const Route = createFileRoute("/admin/authorizations")({
  head: () => ({
    meta: [
      { title: "Buyer authorizations — divieight Admin" },
      {
        name: "description",
        content: "Queue and monitor Buyer Account authorization requests.",
      },
      { property: "og:title", content: "Buyer authorizations — divieight Admin" },
      {
        property: "og:description",
        content: "Queue and monitor Buyer Account authorization requests.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminAuthorizations,
});

type Row = AuthorizationRequestRow & {
  propertyLabel: string;
  buyerEmail: string | null;
  outstanding: number;
  memberCount: number;
  confirmedCount: number;
  declinedCount: number;
  memberResponses: Array<{
    memberId: string;
    name: string;
    decision: "confirmed" | "declined" | null;
    respondedAt: string | null;
    onBehalfOf: string | null;
  }>;
  commissionItem: {
    id: string;
    rate_percent: number;
    funding_source: string;
    per_share_amount_cents: number;
    status: "proposed" | "authorized" | "declined";
  } | null;
  commissionMembers: Array<{
    memberId: string;
    name: string;
    decision: "confirmed" | "declined" | null;
    respondedAt: string | null;
  }>;
};


type Target = {
  buyerAccountId: string;
  propertyId: string;
  buyerEmail: string | null;
  propertyLabel: string;
  gateClear: boolean;
};

function AdminAuthorizations() {
  const list = useServerFn(listAdminAuthorizations);
  const loadTargets = useServerFn(listAuthorizationTargets);
  const create = useServerFn(createAuthorizationRequest);
  const escalate = useServerFn(runAuthorizationEscalation);

  const [rows, setRows] = useState<Row[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState("");
  const [action, setAction] = useState<AuthorizationAction>("offer_tender");
  const [headline, setHeadline] = useState("");
  const [terms, setTerms] = useState("Purchase price: \nClosing date: \nContingencies: ");
  const [deadline, setDeadline] = useState("");
  const [priorId, setPriorId] = useState("");
  const [commissionExpected, setCommissionExpected] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [a, b] = await Promise.all([list({}), loadTargets({})]);
    setRows(a.rows as Row[]);
    setTargets(b.targets as Target[]);
    setLoading(false);
  }, [list, loadTargets]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function parseTerms(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of terms.split("\n")) {
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      const label = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (label && value) out[label] = value;
    }
    return out;
  }

  async function queue() {
    const selected = targets.find((t) => `${t.buyerAccountId}:${t.propertyId}` === target);
    if (!selected) {
      toast.error("Pick a buyer and property");
      return;
    }
    setBusy(true);
    try {
      await create({
        data: {
          propertyId: selected.propertyId,
          buyerAccountId: selected.buyerAccountId,
          actionType: action,
          headline,
          terms: parseTerms(),
          priorRequestId: priorId || null,
          deadlineAt: deadline ? new Date(deadline).toISOString() : null,
          commissionExpected,
        },
      });
      toast.success("Authorization request queued and the buyer notified.");
      setHeadline("");
      setPriorId("");
      setDeadline("");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not queue the request");
    } finally {
      setBusy(false);
    }
  }

  async function sweep() {
    try {
      const result = await escalate({});
      toast.success(
        `Checked ${result.checked} overdue request(s) — ${result.escalated} escalated, ${result.secondEscalations} widened.`,
      );
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Sweep failed");
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-foreground">
            Buyer authorizations
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Queue a triggering action for a Buyer Account's express consent. Non-response never
            grants authorization.
          </p>
        </div>
        <button
          type="button"
          onClick={sweep}
          className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground"
        >
          Run escalation sweep
        </button>
      </div>

      <section className="mt-6 space-y-3 rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold text-foreground">Queue an authorization request</h2>
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          disabled={loading}
          aria-busy={loading}
          className="block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
        >
          <option value="">
            {loading ? "Loading buyers and properties…" : "Select buyer and property…"}
          </option>
          {targets.map((t) => (
            <option key={`${t.buyerAccountId}:${t.propertyId}`} value={`${t.buyerAccountId}:${t.propertyId}`}>
              {t.buyerEmail ?? t.buyerAccountId} — {t.propertyLabel}
              {t.gateClear ? "" : " (due-diligence gate outstanding)"}
            </option>
          ))}
        </select>
        <select
          value={action}
          onChange={(e) => {
            const next = e.target.value as AuthorizationAction;
            setAction(next);
            setCommissionExpected(COMMISSION_BEARING_ACTIONS.includes(next));
          }}
          className="block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
        >
          {AUTHORIZATION_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {AUTHORIZATION_ACTION_LABELS[a]}
            </option>
          ))}
        </select>
        <input
          value={headline}
          onChange={(e) => setHeadline(e.target.value)}
          placeholder="One-line description of the action under consideration"
          className="block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
        />
        <textarea
          value={terms}
          onChange={(e) => setTerms(e.target.value)}
          rows={5}
          className="block w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs"
        />
        <p className="text-xs text-muted-foreground">
          One term per line as <code>Label: value</code>. Link a prior request below to show the
          buyer a diff.
        </p>
        <label className="flex items-start gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={commissionExpected}
            onChange={(e) => setCommissionExpected(e.target.checked)}
            className="mt-1"
          />
          <span>
            This instrument contains a buyer-side commission provision
            <span className="block text-xs text-muted-foreground">
              The Heavy Lifting Agent is asked to propose it, and the instrument cannot be tendered
              until every Preferred Member authorizes that provision separately.
            </span>
          </span>
        </label>
        <select
          value={priorId}
          onChange={(e) => setPriorId(e.target.value)}
          className="block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
        >
          <option value="">No prior version</option>
          {rows
            .filter((r) => `${r.buyer_account_id}:${r.property_id}` === target)
            .map((r) => (
              <option key={r.id} value={r.id}>
                {AUTHORIZATION_ACTION_LABELS[r.action_type]} — {formatDeadline(r.created_at)}
              </option>
            ))}
        </select>
        <div>
          <label className="text-xs text-muted-foreground" htmlFor="authz-deadline">
            Response deadline (leave blank for the default window)
          </label>
          <input
            id="authz-deadline"
            type="datetime-local"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
            className="mt-1 block rounded-lg border border-border bg-background px-3 py-2 text-sm"
          />
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={queue}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          Queue request
        </button>
      </section>

      <h2 className="mt-8 text-sm font-semibold text-foreground">All requests</h2>
      {loading ? (
        <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No authorization requests yet.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {rows.map((row) => (
            <li key={row.id} className="rounded-xl border border-border bg-card p-4 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-foreground">
                    {AUTHORIZATION_ACTION_LABELS[row.action_type]}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {row.buyerEmail ?? row.buyer_account_id} — {row.propertyLabel}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Deadline {formatDeadline(row.deadline_at)} · {row.confirmedCount} of{" "}
                    {row.memberCount} member(s) confirmed
                    {row.declinedCount > 0 ? ` · ${row.declinedCount} declined` : ""} ·{" "}
                    {row.outstanding} outstanding
                    {row.escalated_at ? " · escalated" : ""}
                    {row.escalated_second_at ? " · Manager alerted" : ""}
                  </p>
                  {row.memberResponses.length > 0 ? (
                    <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                      {row.memberResponses.map((m) => (
                        <li key={m.memberId}>
                          <span className="text-foreground">{m.name}</span>:{" "}
                          {m.decision === "confirmed"
                            ? "Authorized"
                            : m.decision === "declined"
                              ? "Declined"
                              : "Awaiting response"}
                          {m.respondedAt ? ` · ${formatDeadline(m.respondedAt)}` : ""}
                          {m.onBehalfOf ? ` · on behalf by ${m.onBehalfOf}` : ""}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {row.commissionItem ? (
                    <div className="mt-2 rounded-lg border border-border bg-muted/40 p-2 text-xs text-muted-foreground">
                      <p className="text-foreground">
                        Commission provision (proposed by the Heavy Lifting Agent):{" "}
                        {formatRate(row.commissionItem.rate_percent)} —{" "}
                        {formatCents(row.commissionItem.per_share_amount_cents)} per 1/8th share ·{" "}
                        {fundingSourceLabel(row.commissionItem.funding_source)} ·{" "}
                        {row.commissionItem.status === "authorized"
                          ? "authorized by all members"
                          : row.commissionItem.status === "declined"
                            ? "declined — instrument not tendered (not a Default under PRA Section 8)"
                            : "awaiting member authorization"}
                      </p>
                      <ul className="mt-1 space-y-0.5">
                        {row.commissionMembers.map((m) => (
                          <li key={m.memberId}>
                            {m.name}:{" "}
                            {m.decision === "confirmed"
                              ? "Commission authorized"
                              : m.decision === "declined"
                                ? "Commission declined"
                                : "Awaiting commission authorization"}
                            {m.respondedAt ? ` · ${formatDeadline(m.respondedAt)}` : ""}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {row.recommendation_kind ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Resident Agent:{" "}
                      {row.recommendation_kind === "recommend"
                        ? "Recommended"
                        : row.recommendation_kind === "recommend_against"
                          ? "Recommended against"
                          : "No recommendation"}
                      {row.recommendation_text ? ` — ${row.recommendation_text}` : ""}
                    </p>
                  ) : null}
                </div>
                <span className="rounded-full bg-muted px-3 py-1 text-xs text-foreground">
                  {authorizationStatusLabel(row)}
                </span>

              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
