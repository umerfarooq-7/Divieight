import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, CheckCircle2, FileText, Lock, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { DiligenceDocumentPreview } from "@/components/DiligenceDocumentPreview";
import {
  SecondaryVerification,
  TYPED_INITIALS_VERIFICATION,
} from "@/components/SecondaryVerification";
import {
  DD_CATEGORY_LABELS,
  deviceFingerprint,
  formatDate,
  gatingDocuments,
  type DdDocumentState,
} from "@/lib/due-diligence";
import {
  acknowledgeAsMember,
  getBuyerDiligence,
  type BuyerDiligencePayload,
} from "@/lib/due-diligence.functions";

export const Route = createFileRoute("/buyer/due-diligence/$id")({
  head: () => ({
    meta: [
      { title: "Due diligence acknowledgments — divieight" },
      {
        name: "description",
        content:
          "Review and acknowledge each required due-diligence document for your fractional home before authorization.",
      },
      { property: "og:title", content: "Due diligence acknowledgments — divieight" },
      {
        property: "og:description",
        content: "Per-document, per-Account-Member acknowledgment gate for divieight buyers.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: BuyerDueDiligencePage,
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

function BuyerDueDiligencePage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const load = useServerFn(getBuyerDiligence);
  const ack = useServerFn(acknowledgeAsMember);

  const [payload, setPayload] = useState<BuyerDiligencePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);

  // Switching property must never show the previous property's documents —
  // clear on change, and ignore a response that arrives for an older id.
  const currentId = useRef(id);
  currentId.current = id;
  useEffect(() => {
    setPayload(null);
    setLoading(true);
    setOpenId(null);
  }, [id]);

  const refresh = useCallback(async () => {
    const requestedId = id;
    const result = await load({ data: { propertyId: requestedId } });
    if (currentId.current !== requestedId) return;
    if (!result.allowed) {
      toast.error("This document set isn't available to your account.");
      navigate({ to: "/buyer/dashboard" });
      return;
    }
    setPayload(result);
    setLoading(false);
  }, [id, load, navigate]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const gating = useMemo(
    () => (payload ? gatingDocuments(payload.states) : []),
    [payload],
  );

  if (loading || !payload?.property) {
    return <p className="px-6 py-16 text-center text-sm text-muted-foreground">Loading…</p>;
  }

  const optional = payload.states.filter(
    (s) => !s.document.required && !s.document.superseded_by,
  );

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
        Due Diligence Acknowledgment Gate
      </p>
      <h1 className="font-display text-2xl font-semibold text-foreground sm:text-3xl">
        {payload.property.address}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Every required document needs each Account Member's acknowledgment and your Resident
        Agent's parallel acknowledgment before authorization can proceed.
      </p>

      <div
        className={`mt-5 flex items-start gap-3 rounded-xl border p-4 text-sm ${
          payload.gateClear
            ? "border-primary/40 bg-primary/5 text-foreground"
            : "border-border bg-card text-foreground"
        }`}
      >
        {payload.gateClear ? (
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        ) : (
          <Lock className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        )}
        <span>
          {payload.gateClear
            ? "All required acknowledgments are on file at the current document versions."
            : `${gating.filter((s) => !s.clear).length} of ${gating.length} required documents still need acknowledgment.`}
        </span>
      </div>

      <div className="mt-8 space-y-4">
        {gating.length === 0 ? (
          <p className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
            No required due-diligence materials have been placed for this home yet.
          </p>
        ) : null}

        {[...gating, ...optional].map((state) => (
          <DocumentCard
            key={state.document.id}
            state={state}
            members={payload.members}
            noticeText={payload.noticeText}
            memberAckText={payload.memberAckText}
            open={openId === state.document.id}
            onToggle={() =>
              setOpenId((p) => (p === state.document.id ? null : state.document.id))
            }
            onAcknowledge={async (memberId, verification, noticeShownAt) => {
              const r = await ack({
                data: {
                  documentId: state.document.id,
                  accountMemberId: memberId,
                  contentHash: state.document.content_hash,
                  signedName: payload.members.find((m) => m.id === memberId)?.full_name ?? "",
                  secondaryVerificationMethod: verification,
                  ipAddress: await clientIp(),
                  deviceFingerprint: deviceFingerprint(),
                  noticeShownAt,
                },
              });
              if (r.error) {
                toast.error(r.error);
                return;
              }
              toast.success("Acknowledgment recorded.");
              await refresh();
            }}
          />
        ))}
      </div>

      <Link
        to="/buyer/dashboard"
        className="mt-8 inline-block rounded-md border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary"
      >
        Back to dashboard
      </Link>
    </div>
  );
}

function DocumentCard({
  state,
  members,
  noticeText,
  memberAckText,
  open,
  onToggle,
  onAcknowledge,
}: {
  state: DdDocumentState;
  members: { id: string; full_name: string | null; role: string | null }[];
  noticeText: string;
  memberAckText: string;
  open: boolean;
  onToggle: () => void;
  onAcknowledge: (
    memberId: string,
    verification: string,
    noticeShownAt: string | null,
  ) => Promise<void>;
}) {
  const doc = state.document;
  const [scrolled, setScrolled] = useState(false);
  const [memberId, setMemberId] = useState(members[0]?.id ?? "");
  const [checked, setChecked] = useState(false);
  const [verification, setVerification] = useState<string>(TYPED_INITIALS_VERIFICATION);
  const [verificationReady, setVerificationReady] = useState(false);
  const [noticeShownAt, setNoticeShownAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && doc.is_governing_instrument && !noticeShownAt) {
      setNoticeShownAt(new Date().toISOString());
    }
  }, [open, doc.is_governing_instrument, noticeShownAt]);

  const pendingMembers = members.filter((m) => !state.memberAcked.includes(m.id));

  useEffect(() => {
    if (pendingMembers.length && !pendingMembers.some((m) => m.id === memberId)) {
      setMemberId(pendingMembers[0].id);
    }
  }, [pendingMembers, memberId]);

  useEffect(() => {
    if (!open) return;
    setScrolled(false);
    setChecked(false);
    setVerification(TYPED_INITIALS_VERIFICATION);
    setVerificationReady(false);
  }, [open, doc.id, doc.content_hash]);

  useEffect(() => {
    if (!open) return;
    setScrolled(false);
    setChecked(false);
    setVerificationReady(false);
  }, [memberId, open]);

  const selectedMember = pendingMembers.find((m) => m.id === memberId) ?? pendingMembers[0];

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
            {DD_CATEGORY_LABELS[doc.category]}
            {doc.required ? " · Required" : " · Optional"}
          </p>
          <p className="mt-1 break-words text-base font-medium text-foreground">
            {doc.document_title}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Placed {formatDate(doc.placed_at)} · version {doc.content_hash}
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
            state.clear
              ? "bg-primary/10 text-primary"
              : "bg-secondary text-muted-foreground"
          }`}
        >
          {state.clear ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
          {state.clear ? "Gate cleared" : "Acknowledgment required"}
        </span>
      </div>

      {state.staleAcks > 0 ? (
        <p className="mt-3 flex items-start gap-2 rounded-md border border-border bg-secondary/50 p-3 text-xs text-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          This document was revised. Earlier acknowledgments stay in the Audit Vault but are no
          longer current — the current version must be acknowledged again.
        </p>
      ) : null}

      <p className="mt-3 text-xs text-muted-foreground">
        Account Members acknowledged: {state.memberAcked.length}/{members.length} · Resident Agent:{" "}
        {state.agentAcked ? "acknowledged" : "pending"}
        {state.agentOverdue ? " (overdue — escalated)" : ""}
      </p>

      <button
        type="button"
        onClick={onToggle}
        className="mt-4 inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-secondary"
      >
        <FileText className="h-4 w-4" />
        {open ? "Hide document" : "Open and review"}
      </button>

      {open ? (
        <div className="mt-4 space-y-4">
          <DiligenceDocumentPreview
            title={doc.document_title}
            url={doc.signed_url}
            version={doc.content_hash}
            onScrolledToEnd={() => setScrolled(true)}
          />

          {doc.is_governing_instrument ? (
            <div className="rounded-lg border border-accent/40 bg-accent/5 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
                Independent-Review Notice
              </p>
              <p className="mt-2 text-sm leading-relaxed text-foreground">{noticeText}</p>
            </div>
          ) : null}

          {pendingMembers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Every Account Member has acknowledged this version.
            </p>
          ) : (
            <div className="space-y-3">
              {members.length > 1 ? (
                <label className="block text-xs font-medium text-muted-foreground">
                  Acknowledging Account Member
                  <select
                    value={memberId}
                    onChange={(e) => setMemberId(e.target.value)}
                    className="mt-1 block h-10 w-full max-w-sm rounded-md border border-border bg-background px-3 text-sm text-foreground"
                  >
                    {pendingMembers.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.full_name ?? "Account Member"} ({m.role ?? "member"})
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              <label className="flex items-start gap-3 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!scrolled}
                  onChange={(e) => setChecked(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-input"
                />
                <span>
                  {memberAckText}
                  {!scrolled ? (
                    <span className="block text-xs text-muted-foreground">
                      Scroll the document to the end to enable this.
                    </span>
                  ) : null}
                </span>
              </label>

              <SecondaryVerification
                signerName={selectedMember?.full_name ?? ""}
                value={verification}
                onChange={setVerification}
                onVerifiedChange={setVerificationReady}
                disabled={!checked || saving}
              />

              <button
                type="button"
                disabled={!checked || !scrolled || !verificationReady || saving || !memberId}
                onClick={async () => {
                  setSaving(true);
                  await onAcknowledge(memberId, verification, noticeShownAt);
                  setChecked(false);
                  setSaving(false);
                }}
                className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                <ShieldCheck className="h-4 w-4" />
                {saving ? "Recording…" : "Record acknowledgment"}
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
