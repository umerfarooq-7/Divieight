import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { logAudit } from "@/lib/audit";

export const BLOCK_5_DOCUMENT_TYPE = "block_5_independent_advice";
export const BLOCK_5_VERSION = "v1";

export const BLOCK_5_TEXT =
  "divieight is a technology platform, not a law, accounting, tax, or investment advisory firm. Your real estate agent is licensed for brokerage services and is not authorized to give legal, tax, accounting, or investment advice. Co-ownership involves an LLC, an operating agreement, and tax consequences personal to you. divieight recommends you retain your own attorney and CPA. By checking this box, you acknowledge having been so advised — this does not require you to actually retain anyone, only that the recommendation was made to you.";

function hashDocument(text: string) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) & 0xffffffff;
  }
  return `djb2_${(hash >>> 0).toString(16)}_${text.length}`;
}

export const BLOCK_5_HASH = hashDocument(`${BLOCK_5_VERSION}::${BLOCK_5_TEXT}`);

export type Block5Member = { id: string; full_name: string | null; role: string | null };

/**
 * Block 5 — Independent Professional Advice notice.
 * Records acceptance in signed_documents using the same shape as Blocks 1/2/4
 * (member identity via signed_name, timestamp, IP address, document hash).
 */
export function Block5AdviceNotice({
  buyerAccountId,
  actorId,
  members,
  onAccepted,
}: {
  buyerAccountId: string;
  actorId: string;
  members: Block5Member[];
  onAccepted: () => void;
}) {
  const roster = members.length ? members : [];
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  const multi = roster.length > 1;
  const allChecked = roster.length > 0 && roster.every((m) => checked[m.id]);

  async function handleAccept() {
    if (!allChecked || saving) return;
    setSaving(true);

    let ip: string | null = null;
    try {
      const res = await fetch("https://api.ipify.org?format=json");
      if (res.ok) ip = (await res.json()).ip ?? null;
    } catch {
      ip = null;
    }

    const rows = roster.map((m) => ({
      buyer_account_id: buyerAccountId,
      account_member_id: m.id,
      document_type: BLOCK_5_DOCUMENT_TYPE,
      document_version: BLOCK_5_VERSION,
      signed_name: (m.full_name ?? "Account Member").trim(),
      document_hash: BLOCK_5_HASH,
      ip_address: ip,
    }));

    const { error } = await supabase.from("signed_documents").insert(rows);
    if (error) {
      setSaving(false);
      toast.error(error.message);
      return;
    }

    await logAudit({
      actorId,
      actionType: "buyer.pra_signed",
      entityType: "buyer_account",
      entityId: buyerAccountId,
      metadata: {
        block: "block_5_independent_advice",
        document_hash: BLOCK_5_HASH,
        members: roster.map((m) => m.id),
        secondary_verification_method: "checkbox_attestation",
        user_agent: typeof navigator === "undefined" ? null : navigator.userAgent,
        ip_address: ip,
      },
    });

    setSaving(false);
    toast.success("Acknowledgment recorded.");
    onAccepted();
  }

  return (
    <div className="mt-8 rounded-xl border border-border bg-card p-6 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
        Block 5 · Independent professional advice
      </p>
      <p className="mt-3 text-sm leading-relaxed text-foreground/90">{BLOCK_5_TEXT}</p>

      <div className="mt-5 space-y-3">
        {roster.map((m) => (
          <label key={m.id} className="flex items-start gap-3 text-sm text-foreground">
            <input
              type="checkbox"
              checked={!!checked[m.id]}
              onChange={(e) => setChecked((p) => ({ ...p, [m.id]: e.target.checked }))}
              className="mt-0.5 h-4 w-4 rounded border-input"
            />
            <span>
              I acknowledge this recommendation.
              {multi ? (
                <span className="text-muted-foreground">
                  {" "}
                  — {m.full_name ?? "Account Member"} ({m.role ?? "member"})
                </span>
              ) : null}
            </span>
          </label>
        ))}
        {multi ? (
          <p className="text-xs text-muted-foreground">
            Each Account Member must acknowledge, or the primary member may acknowledge
            under documented authority for the account.
          </p>
        ) : null}
      </div>

      <button
        type="button"
        onClick={handleAccept}
        disabled={!allChecked || saving}
        className="mt-5 inline-flex h-11 items-center justify-center rounded-md bg-primary px-8 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {saving ? "Saving…" : "Continue"}
      </button>
      <p className="mt-2 text-xs text-muted-foreground">
        The Priority Reservation Agreement unlocks once this acknowledgment is recorded.
      </p>
    </div>
  );
}
