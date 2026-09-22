import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, CheckCircle2, Lock, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import {
  SecondaryVerification,
  TYPED_INITIALS_VERIFICATION,
} from "@/components/SecondaryVerification";
import { deviceFingerprint } from "@/lib/due-diligence";
import {
  AUTHORIZATION_ACTION_LABELS,
  CONFIRMATION_TEXT,
  DECLINE_TEXT,
  authorizationState,
  authorizationStatusLabel,
  diffTerms,
  formatDeadline,
  recommendationLabel,
} from "@/lib/authorization";
import {
  getBuyerAuthorization,
  respondToAuthorization,
  respondToCommissionItem,
  type BuyerAuthorizationPayload,
} from "@/lib/authorization.functions";
import {
  COMMISSION_CONFIRMATION_TEXT,
  COMMISSION_DECLINE_NOT_DEFAULT,
  COMMISSION_DECLINE_TEXT,
  COMMISSION_PROPOSER_NOTE,
  NON_CONTINGENT_TEXT,
  commissionItemState,
  formatCents,
  formatRate,
  fundingSourceSentence,
} from "@/lib/commission-item";

export const Route = createFileRoute("/buyer/authorizations/$id")({
  head: () => ({
    meta: [
      { title: "Authorization request — divieight" },
      {
        name: "description",
        content: "Confirm or decline a key transaction action for your divieight Buyer Account.",
      },
      { property: "og:title", content: "Authorization request — divieight" },
      {
        property: "og:description",
        content: "Confirm or decline a key transaction action for your divieight Buyer Account.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: BuyerAuthorizationDetail,
});

async function clientIp(): Promise<string | null> {
  try {
    const res = await fetch("https://api.ipify.org?format=json");
    if (res.ok) return (await res.json()).ip ?? null;
  } catch {
    /* ignore */
  }
  return null;
}

function BuyerAuthorizationDetail() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const load = useServerFn(getBuyerAuthorization);
  const respond = useServerFn(respondToAuthorization);
  const respondCommission = useServerFn(respondToCommissionItem);

  const [payload, setPayload] = useState<BuyerAuthorizationPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [memberId, setMemberId] = useState<string>("");
  const [onBehalf, setOnBehalf] = useState<string>("");
  const [authorityBasis, setAuthorityBasis] = useState("");
  const [method, setMethod] = useState(TYPED_INITIALS_VERIFICATION);
  const [verified, setVerified] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // The commission provision is a SEPARATE affirmative act with its own state.
  const [commMemberId, setCommMemberId] = useState<string>("");
  const [commMethod, setCommMethod] = useState(TYPED_INITIALS_VERIFICATION);
  const [commVerified, setCommVerified] = useState(false);
  const [commChecked, setCommChecked] = useState(false);
  const [commSubmitting, setCommSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    const result = await load({ data: { id } });
    // Precondition: the Due Diligence Acknowledgment Gate must be current.
    if (
      result.gateBlockedPropertyId &&
      (result.gateBlocker === "buyer" || result.gateBlocker === "both")
    ) {
      toast.error(
        result.gateBlocker === "both"
          ? "Both you and your Resident Agent have unread documents — review yours first."
          : "You have an unread required document — review it before you can act on this request.",
      );
      navigate({
        to: "/buyer/due-diligence/$id",
        params: { id: result.gateBlockedPropertyId },
      });
      return;
    }
    if (result.gateBlockedPropertyId && result.gateBlocker === "agent") {
      setPayload(result);
      setLoading(false);
      return;
    }
    if (!result.allowed) {
      toast.error("This authorization request isn't available to your account.");
      navigate({ to: "/buyer/authorizations" });
      return;
    }
    setPayload(result);
    setMemberId((prev) => prev || (result.members[0]?.id ?? ""));
    setCommMemberId((prev) => prev || (result.members[0]?.id ?? ""));
    setLoading(false);
  }, [id, load, navigate]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setVerified(false);
    setOnBehalf("");
    setAuthorityBasis("");
  }, [memberId]);

  useEffect(() => {
    setCommVerified(false);
    setCommChecked(false);
  }, [commMemberId]);

  const request = payload?.request ?? null;
  const members = payload?.members ?? [];
  const state = useMemo(
    () => (request ? authorizationState(request, payload?.responses ?? [], members) : null),
    [request, payload?.responses, members],
  );
  const lines = useMemo(
    () => (request ? diffTerms(request.terms ?? {}, request.prior_terms) : []),
    [request],
  );
  const signer = members.find((m) => m.id === memberId) ?? null;
  const alreadyAnswered = (payload?.responses ?? []).some(
    (r) => r.account_member_id === memberId || r.on_behalf_of_member_id === memberId,
  );

  async function submit(decision: "confirmed" | "declined") {
    if (!signer || !verified) return;
    if (onBehalf && !authorityBasis.trim()) {
      toast.error("Describe the documented authority you're acting under.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await respond({
        data: {
          requestId: id,
          accountMemberId: signer.id,
          decision,
          signedName: signer.full_name ?? "",
          secondaryVerificationMethod: method,
          onBehalfOfMemberId: onBehalf || null,
          authorityBasis: onBehalf ? authorityBasis.trim() : null,
          ipAddress: await clientIp(),
          deviceFingerprint: deviceFingerprint(),
        },
      });
      toast.success(
        result.disposition === "authorized"
          ? "Authorization granted."
          : result.disposition === "declined"
            ? "Recorded — the action will not proceed."
            : "Recorded. Awaiting the remaining member's response.",
      );
      setVerified(false);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not record your response");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitCommission(decision: "confirmed" | "declined") {
    const member = members.find((m) => m.id === commMemberId);
    if (!member || !commVerified) return;
    if (decision === "confirmed" && !commChecked) {
      toast.error("Tick the commission authorization box to authorize this provision.");
      return;
    }
    setCommSubmitting(true);
    try {
      const result = await respondCommission({
        data: {
          requestId: id,
          accountMemberId: member.id,
          decision,
          signedName: member.full_name ?? "",
          secondaryVerificationMethod: commMethod,
          ipAddress: await clientIp(),
          deviceFingerprint: deviceFingerprint(),
        },
      });
      toast.success(
        result.itemStatus === "declined"
          ? "Recorded. The instrument will not be tendered; your Resident Agent and the Heavy Lifting Agent have been notified."
          : result.itemStatus === "authorized"
            ? "Commission provision authorized."
            : "Recorded. Awaiting the remaining member's commission authorization.",
      );
      setCommVerified(false);
      setCommChecked(false);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not record your response");
    } finally {
      setCommSubmitting(false);
    }
  }

  if (loading) {
    return <p className="px-6 py-16 text-center text-sm text-muted-foreground">Loading…</p>;
  }

  if (payload?.gateBlocker === "agent") {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <Link to="/buyer/authorizations" className="text-xs text-muted-foreground hover:underline">
          ← All authorization requests
        </Link>
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-border bg-card p-5 text-sm">
          <Lock className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div>
            <h1 className="font-medium text-foreground">Resident Agent review pending</h1>
            <p className="mt-1 text-muted-foreground">
              Your Resident Agent still needs to review this document before you can proceed. No
              action is needed from you right now.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!request || !state) {
    return <p className="px-6 py-16 text-center text-sm text-muted-foreground">Request unavailable.</p>;
  }

  const open = request.status === "pending";

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <Link to="/buyer/authorizations" className="text-xs text-muted-foreground hover:underline">
        ← All authorization requests
      </Link>
      <p className="mt-4 text-xs font-semibold uppercase tracking-[0.18em] text-accent">
        Action under consideration
      </p>
      <h1 className="font-display text-2xl font-semibold text-foreground sm:text-3xl">
        {AUTHORIZATION_ACTION_LABELS[request.action_type]}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {payload?.property
          ? `${payload.property.address}, ${payload.property.city}, ${payload.property.state}`
          : ""}
      </p>
      <p className="mt-3 text-sm text-foreground">{request.headline}</p>

      <div className="mt-5 flex items-start gap-3 rounded-xl border border-border bg-card p-4 text-sm">
        {request.status === "authorized" ? (
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        ) : (
          <Lock className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        )}
        <div>
          <p className="font-medium text-foreground">{authorizationStatusLabel(request)}</p>
          <p className="mt-1 text-muted-foreground">
            Response deadline: {formatDeadline(request.deadline_at)}
            {state.overdue && open ? " — passed" : ""}
          </p>
        </div>
      </div>

      {/* Proposed terms, with a diff against the prior version where applicable. */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold text-foreground">Proposed terms</h2>
        {request.prior_terms ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Changes from the prior version are marked.
          </p>
        ) : null}
        <dl className="mt-3 divide-y divide-border rounded-xl border border-border bg-card">
          {lines.map((line) => (
            <div key={line.label} className="grid gap-1 px-4 py-3 sm:grid-cols-[200px_1fr]">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                {line.label}
              </dt>
              <dd className="text-sm text-foreground">
                {line.kind === "changed" ? (
                  <>
                    <span className="text-muted-foreground line-through">{line.priorValue}</span>{" "}
                    <span className="font-medium">{line.value}</span>
                    <span className="ml-2 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] text-accent">
                      changed
                    </span>
                  </>
                ) : line.kind === "added" ? (
                  <>
                    {line.value}
                    <span className="ml-2 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] text-accent">
                      added
                    </span>
                  </>
                ) : line.kind === "removed" ? (
                  <span className="text-muted-foreground line-through">{line.priorValue}</span>
                ) : (
                  line.value
                )}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Parallel Resident Agent recommendation. */}
      <section className="mt-8 rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold text-foreground">
          Your Resident Agent{payload?.agentName ? ` — ${payload.agentName}` : ""}
        </h2>
        <p className="mt-2 text-sm text-foreground">
          {recommendationLabel(request.recommendation_kind)}
        </p>
        {request.recommendation_text ? (
          <p className="mt-2 text-sm text-muted-foreground">{request.recommendation_text}</p>
        ) : null}
      </section>

      <section className="mt-6 flex items-start gap-3 rounded-xl border border-border bg-muted/40 p-4 text-sm text-foreground">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <span>{request.consequence_text}</span>
      </section>

      {/* Per-member confirmation. */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold text-foreground">Preferred Member confirmation</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Every Preferred Member on this Buyer Account must respond, or one may respond under
          documented authority for the other.
        </p>

        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
          {members.map((m) => {
            const answered = !state.outstanding.some((o) => o.id === m.id);
            return (
              <li key={m.id}>
                {m.full_name ?? "Account Member"} — {answered ? "responded" : "awaiting response"}
              </li>
            );
          })}
        </ul>

        {open ? (
          <div className="mt-5 space-y-4 rounded-xl border border-border bg-card p-5">
            <div>
              <label className="text-xs text-muted-foreground" htmlFor="authz-member">
                Responding as
              </label>
              <select
                id="authz-member"
                value={memberId}
                onChange={(e) => setMemberId(e.target.value)}
                className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              >
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.full_name ?? "Account Member"}
                  </option>
                ))}
              </select>
            </div>

            {members.length > 1 ? (
              <div>
                <label className="text-xs text-muted-foreground" htmlFor="authz-behalf">
                  Also responding for (under documented authority)
                </label>
                <select
                  id="authz-behalf"
                  value={onBehalf}
                  onChange={(e) => setOnBehalf(e.target.value)}
                  className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="">No one — I'm responding only for myself</option>
                  {members
                    .filter((m) => m.id !== memberId)
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.full_name ?? "Account Member"}
                      </option>
                    ))}
                </select>
                {onBehalf ? (
                  <input
                    value={authorityBasis}
                    onChange={(e) => setAuthorityBasis(e.target.value)}
                    placeholder="Describe the documented authority on file"
                    className="mt-2 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  />
                ) : null}
              </div>
            ) : null}

            <p className="text-sm text-foreground">{CONFIRMATION_TEXT}</p>
            {payload?.commissionItem ? (
              <p className="text-xs text-muted-foreground">
                This authorizes the instrument only. The buyer-side commission provision is a
                separate item below and requires its own authorization.
              </p>
            ) : payload?.request?.commission_expected ? (
              <p className="text-xs text-muted-foreground">
                This instrument contains a buyer-side commission provision. The Heavy Lifting Agent
                has not proposed it yet; once they do, it will appear here as a separate item for
                your own authorization. The instrument will not be tendered until then.
              </p>
            ) : null}

            <SecondaryVerification
              signerName={signer?.full_name ?? ""}
              value={method}
              onChange={setMethod}
              onVerifiedChange={setVerified}
              disabled={submitting}
            />

            {alreadyAnswered ? (
              <p className="text-xs text-muted-foreground">
                This member has already responded. Submitting again replaces that response while
                the request is still pending.
              </p>
            ) : null}

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                disabled={!verified || submitting}
                onClick={() => submit("confirmed")}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                <ShieldCheck className="h-4 w-4" /> Confirm authorization
              </button>
              <button
                type="button"
                disabled={!verified || submitting}
                onClick={() => submit("declined")}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground disabled:opacity-50"
              >
                Decline
              </button>
            </div>
            <p className="text-xs text-muted-foreground">{DECLINE_TEXT}</p>
          </div>
        ) : null}
      </section>

      {/* Itemized commission authorization — a separate, discrete affirmative act. */}
      {payload?.commissionItem ? (() => {
        const item = payload.commissionItem;
        const commState = commissionItemState(
          payload.commissionResponses ?? [],
          members.map((m) => m.id),
        );
        const commMember = members.find((m) => m.id === commMemberId) ?? null;
        const commAnswered = (payload.commissionResponses ?? []).some(
          (r) => r.account_member_id === commMemberId,
        );
        return (
          <section className="mt-10 rounded-xl border-2 border-accent/40 bg-card p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
              Separate authorization item
            </p>
            <h2 className="mt-1 font-display text-lg font-semibold text-foreground">
              Buyer-side commission provision
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">{COMMISSION_PROPOSER_NOTE}</p>

            <dl className="mt-4 divide-y divide-border rounded-lg border border-border">
              <div className="grid gap-1 px-4 py-3 sm:grid-cols-[220px_1fr]">
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  Attributable to your 1/8th share
                </dt>
                <dd className="text-sm font-medium text-foreground">
                  {formatRate(item.rate_percent)} — {formatCents(item.per_share_amount_cents)}
                </dd>
              </div>
              <div className="grid gap-1 px-4 py-3 sm:grid-cols-[220px_1fr]">
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  How it is funded
                </dt>
                <dd className="text-sm text-foreground">
                  {fundingSourceSentence(item.funding_source)}
                </dd>
              </div>
              <div className="grid gap-1 px-4 py-3 sm:grid-cols-[220px_1fr]">
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  Non-contingent obligation
                </dt>
                <dd className="text-sm text-foreground">{NON_CONTINGENT_TEXT}</dd>
              </div>
              {item.provision_text ? (
                <div className="grid gap-1 px-4 py-3 sm:grid-cols-[220px_1fr]">
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    Provision as proposed
                  </dt>
                  <dd className="text-sm text-foreground">{item.provision_text}</dd>
                </div>
              ) : null}
            </dl>

            <ul className="mt-4 space-y-1 text-xs text-muted-foreground">
              {members.map((m) => {
                const hit = (payload.commissionResponses ?? []).find(
                  (r) => r.account_member_id === m.id,
                );
                return (
                  <li key={m.id}>
                    {m.full_name ?? "Account Member"} —{" "}
                    {hit
                      ? hit.decision === "confirmed"
                        ? "commission authorized"
                        : "commission declined"
                      : "awaiting commission authorization"}
                  </li>
                );
              })}
            </ul>

            {item.status === "declined" || commState.anyDeclined ? (
              <p className="mt-4 rounded-lg border border-border bg-muted/40 p-3 text-sm text-foreground">
                This provision was declined. The instrument will not be tendered; the matter is with
                your Resident Agent and the Heavy Lifting Agent for resolution.{" "}
                {COMMISSION_DECLINE_NOT_DEFAULT}
              </p>
            ) : open ? (
              <div className="mt-5 space-y-4 rounded-lg border border-border bg-background p-4">
                <div>
                  <label className="text-xs text-muted-foreground" htmlFor="comm-member">
                    Responding as
                  </label>
                  <select
                    id="comm-member"
                    value={commMemberId}
                    onChange={(e) => setCommMemberId(e.target.value)}
                    className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  >
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.full_name ?? "Account Member"}
                      </option>
                    ))}
                  </select>
                </div>

                <label className="flex items-start gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={commChecked}
                    onChange={(e) => setCommChecked(e.target.checked)}
                    className="mt-1"
                  />
                  <span>{COMMISSION_CONFIRMATION_TEXT}</span>
                </label>

                <SecondaryVerification
                  signerName={commMember?.full_name ?? ""}
                  value={commMethod}
                  onChange={setCommMethod}
                  onVerifiedChange={setCommVerified}
                  disabled={commSubmitting}
                />

                {commAnswered ? (
                  <p className="text-xs text-muted-foreground">
                    This member has already acted on the commission provision. Submitting again
                    replaces that response while the request is still pending.
                  </p>
                ) : null}

                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    disabled={!commVerified || !commChecked || commSubmitting}
                    onClick={() => submitCommission("confirmed")}
                    className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                  >
                    <ShieldCheck className="h-4 w-4" /> Authorize commission provision
                  </button>
                  <button
                    type="button"
                    disabled={!commVerified || commSubmitting}
                    onClick={() => submitCommission("declined")}
                    className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground disabled:opacity-50"
                  >
                    Decline commission provision
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">{COMMISSION_DECLINE_TEXT}</p>
              </div>
            ) : null}
          </section>
        );
      })() : null}
    </div>
  );
}
