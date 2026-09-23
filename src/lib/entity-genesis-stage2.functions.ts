import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabase } from "@/integrations/supabase/client";
import { auditIp } from "@/lib/request-ip.server";
import type { AtlasStatus, EinStatus, FinalOaStatus, StateFilingStatus, TinMatchResult } from "@/lib/entity-genesis";

/** Entity Genesis Stage 2 — callable surface (admin workflow + buyer signing). */

type Db = { from: (t: string) => any; storage?: any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function requireAdmin(userId: string) {
  const { data } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (!data) throw new Error("Not authorized");
}

const stage2 = () => import("@/lib/entity-genesis-stage2.server");

export interface Stage2View {
  property: { id: string; address: string; city: string; state: string; zip: string; listing_status: string | null } | null;
  pod: { retained: number; reserved: number; total: number; full: boolean };
  genesis: {
    id: string;
    llc_name: string;
    stage: string;
    ein: string | null;
    closing_ready_at: string | null;
    cap_table_locked_at: string | null;
    atlas_request_status: AtlasStatus;
    atlas_reference: string | null;
    atlas_fee: number;
    atlas_requested_at: string | null;
    state_filing_status: StateFilingStatus;
    filed_at: string | null;
    delaware_file_number: string | null;
    ein_status: EinStatus;
    ein_issued_at: string | null;
    tin_match_result: TinMatchResult | null;
    tin_checked_at: string | null;
    final_oa_status: FinalOaStatus;
    final_oa_hash: string | null;
    oa_executed_at: string | null;
  } | null;
  signers: Array<{ name: string; buyerAccountId: string; signedAt: string | null }>;
  vault: Array<{ id: string; document_type: string; title: string | null; file_url: string; stored_at: string; signed_url: string | null }>;
  llcFinancials: { ok: boolean; message: string };
}

export const getStage2 = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => {
    if (!input?.propertyId) throw new Error("Missing property");
    return input;
  })
  .handler(async ({ data, context }): Promise<Stage2View> => {
    await requireAdmin(context.claims?.sub as string);
    const db = await adminDb();
    const s = await stage2();
    const { data: property } = await db
      .from("properties")
      .select("id, address, city, state, zip, listing_status")
      .eq("id", data.propertyId)
      .maybeSingle();
    const { data: g } = await db.from("entity_genesis").select("*").eq("property_id", data.propertyId).maybeSingle();
    const pod = await s.podArithmetic(db, data.propertyId);

    let signers: Stage2View["signers"] = [];
    if (g?.final_oa_hash) {
      const list = await s.oaSigners(db, data.propertyId);
      const { data: sigs } = await db
        .from("operating_agreement_signatures")
        .select("account_member_id, signed_at")
        .eq("entity_genesis_id", g.id)
        .eq("document_hash", g.final_oa_hash);
      const byMember = new Map(((sigs ?? []) as Array<{ account_member_id: string; signed_at: string }>).map((x) => [x.account_member_id, x.signed_at]));
      signers = list.map((m) => ({ name: m.name, buyerAccountId: m.buyerAccountId, signedAt: byMember.get(m.accountMemberId) ?? null }));
    }

    const { data: vaultRows } = await db
      .from("property_records_vault")
      .select("id, document_type, title, file_url, stored_at")
      .eq("property_id", data.propertyId)
      .order("stored_at", { ascending: false });
    const rows = (vaultRows ?? []) as Array<{ id: string; document_type: string; title: string | null; file_url: string; stored_at: string }>;
    const signed = new Map<string, string>();
    if (rows.length) {
      try {
        const { data: urls } = await db.storage.from("property-documents").createSignedUrls(rows.map((r) => r.file_url), 3600);
        for (const u of (urls ?? []) as Array<{ path: string; signedUrl: string }>) if (u.signedUrl) signed.set(u.path, u.signedUrl);
      } catch {
        // listed without links
      }
    }

    return {
      property: property ?? null,
      pod: { retained: pod.retained, reserved: pod.reserved, total: pod.total, full: pod.full },
      genesis: g ?? null,
      signers,
      vault: rows.map((r) => ({ ...r, signed_url: signed.get(r.file_url) ?? null })),
      llcFinancials: await s.llcTinGate(db, data.propertyId),
    };
  });

type Action =
  | { kind: "closing_ready" }
  | { kind: "atlas_request"; reference?: string | null }
  | { kind: "state_filed" }
  | { kind: "state_confirmed"; llcName: string; delawareFileNumber: string; certificateFileUrl: string; certificateHash?: string | null }
  | { kind: "ein"; ein: string; confirmationFileUrl: string; confirmationHash?: string | null }
  | { kind: "tin_match"; result: TinMatchResult }
  | { kind: "final_oa" };

export const runStage2Action = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; action: Action }) => {
    if (!input?.propertyId || !input?.action?.kind) throw new Error("Missing action");
    const a = input.action;
    if (a.kind === "state_confirmed") {
      if (!a.llcName?.trim()) throw new Error("Enter the LLC name exactly as filed");
      if (!a.delawareFileNumber?.trim()) throw new Error("Enter the Delaware file number");
      if (!a.certificateFileUrl) throw new Error("Upload the filed Certificate of Formation");
    }
    if (a.kind === "ein" && !a.confirmationFileUrl) throw new Error("Upload the IRS EIN confirmation");
    if (a.kind === "tin_match" && !["match", "not_found", "name_mismatch"].includes(a.result))
      throw new Error("Choose the TIN Matching result");
    return input;
  })
  .handler(async ({ data, context }) => {
    const userId = context.claims?.sub as string;
    await requireAdmin(userId);
    const db = await adminDb();
    const s = await stage2();
    const a = data.action;
    const pid = data.propertyId;
    switch (a.kind) {
      case "closing_ready":
        await s.markClosingReady(db, userId, pid);
        break;
      case "atlas_request":
        await s.requestAtlas(db, userId, pid, a.reference?.trim() || null);
        break;
      case "state_filed":
        await s.markStateFiled(db, userId, pid);
        break;
      case "state_confirmed":
        await s.confirmStateFiling(db, userId, pid, {
          llcName: a.llcName.trim(),
          delawareFileNumber: a.delawareFileNumber.trim(),
          certificateFileUrl: a.certificateFileUrl,
          certificateHash: a.certificateHash ?? null,
        });
        break;
      case "ein":
        await s.recordEin(db, userId, pid, {
          ein: a.ein.trim(),
          confirmationFileUrl: a.confirmationFileUrl,
          confirmationHash: a.confirmationHash ?? null,
        });
        break;
      case "tin_match":
        await s.recordTinMatch(db, userId, pid, a.result);
        break;
      case "final_oa":
        await s.generateFinalOa(db, userId, pid);
        break;
    }
    return { ok: true };
  });

// ---------------------------------------------------------------------------
// Buyer signing
// ---------------------------------------------------------------------------

export interface BuyerOaView {
  propertyId: string;
  llcName: string;
  status: FinalOaStatus;
  text: string | null;
  documentHash: string | null;
  executedAt: string | null;
  members: Array<{ id: string; name: string; signedAt: string | null }>;
}

async function buyerFor(db: Db, userId: string) {
  const { data } = await db.from("buyer_accounts").select("id").eq("auth_user_id", userId).maybeSingle();
  return (data as { id: string } | null) ?? null;
}

export const listMyOperatingAgreements = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ agreements: BuyerOaView[] }> => {
    const db = await adminDb();
    const buyer = await buyerFor(db, context.claims?.sub as string);
    if (!buyer) return { agreements: [] };
    const { data: cap } = await db.from("cap_table_entries").select("property_id").eq("buyer_account_id", buyer.id);
    const ids = [...new Set(((cap ?? []) as Array<{ property_id: string }>).map((c) => c.property_id))];
    const s = await stage2();
    const out: BuyerOaView[] = [];
    for (const pid of ids) {
      const { data: g } = await db.from("entity_genesis").select("*").eq("property_id", pid).maybeSingle();
      if (!g || g.final_oa_status === "not_started" || !g.final_oa_hash) continue;
      const signers = (await s.oaSigners(db, pid)).filter((x) => x.buyerAccountId === buyer.id);
      const { data: sigs } = await db
        .from("operating_agreement_signatures")
        .select("account_member_id, signed_at")
        .eq("entity_genesis_id", g.id)
        .eq("document_hash", g.final_oa_hash);
      const byMember = new Map(((sigs ?? []) as Array<{ account_member_id: string; signed_at: string }>).map((x) => [x.account_member_id, x.signed_at]));
      out.push({
        propertyId: pid,
        llcName: g.llc_name,
        status: g.final_oa_status,
        text: g.final_oa_text,
        documentHash: g.final_oa_hash,
        executedAt: g.oa_executed_at ?? null,
        members: signers.map((m) => ({ id: m.accountMemberId, name: m.name, signedAt: byMember.get(m.accountMemberId) ?? null })),
      });
    }
    return { agreements: out };
  });

export const signMyOperatingAgreement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { propertyId: string; accountMemberId: string; signedName: string; documentHash: string; secondaryVerificationMethod: string; ipAddress?: string | null; deviceFingerprint?: string | null }) => {
      if (!input?.propertyId || !input?.accountMemberId) throw new Error("Missing signer");
      if (!input.signedName?.trim()) throw new Error("Type your full legal name to sign");
      if (!input.secondaryVerificationMethod) throw new Error("Secondary verification is required");
      if (!input.documentHash) throw new Error("Missing document version");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const userId = context.claims?.sub as string;
    const db = await adminDb();
    const buyer = await buyerFor(db, userId);
    if (!buyer) throw new Error("No buyer account");
    return (await stage2()).signOperatingAgreement(db, userId, buyer.id, {
      propertyId: data.propertyId,
      accountMemberId: data.accountMemberId,
      signedName: data.signedName,
      documentHash: data.documentHash,
      secondaryVerificationMethod: data.secondaryVerificationMethod,
      ipAddress: auditIp(data.ipAddress ?? null),
      deviceFingerprint: data.deviceFingerprint ?? null,
    });
  });
