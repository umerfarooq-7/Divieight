import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { auditIp } from "@/lib/request-ip.server";
import {
  AGENT_ACK_TEXT,
  GOVERNING_CATEGORIES,
  INDEPENDENT_REVIEW_NOTICE,
  MEMBER_ACK_TEXT,
  buildGateState,
  gateClear,
  gatingDocuments,
  type DdAcknowledgment,
  type DdCategory,
  type DdDocument,
  type DdDocumentState,
  type DdMember,
} from "@/lib/due-diligence";

/**
 * Due Diligence Acknowledgment Gate — server side.
 *
 * Reads and writes run with the service role because the gate spans the buyer
 * account, its Account Members, and the tethered Resident Agent (a buyer can't
 * read agents, an agent can't read buyer rows directly).
 */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function audit(
  db: Db,
  row: {
    actorId: string | null;
    actorType: string;
    actionType: string;
    entityId?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  await db.from("audit_log").insert({
    actor_id: row.actorId,
    actor_type: row.actorType,
    action_type: row.actionType,
    entity_type: "diligence_document",
    entity_id: row.entityId ?? null,
    metadata: row.metadata ?? {},
  });
}

async function signUrls(files: string[]): Promise<Map<string, string>> {
  const byPath = new Map<string, string>();
  if (files.length === 0) return byPath;
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
    const { data } = await supabaseAdmin.storage
      .from("property-documents")
      .createSignedUrls(files, 60 * 60);
    (data ?? []).forEach((s: any) => {
      if (s.path && s.signedUrl) byPath.set(s.path, s.signedUrl);
    });
  } catch {
    // documents still list; they just won't open
  }
  return byPath;
}

async function loadDocuments(db: Db, propertyId: string): Promise<DdDocument[]> {
  const { data } = await db
    .from("due_diligence_inventory")
    .select("*")
    .eq("property_id", propertyId)
    .order("placed_at", { ascending: true });
  const rows = (data ?? []) as DdDocument[];
  const signed = await signUrls(rows.map((r) => r.file_url));
  return rows.map((r) => ({ ...r, signed_url: signed.get(r.file_url) ?? null }));
}

async function loadAcks(
  db: Db,
  buyerAccountId: string,
  documentIds: string[],
): Promise<DdAcknowledgment[]> {
  if (documentIds.length === 0) return [];
  const { data } = await db
    .from("due_diligence_acknowledgments")
    .select(
      "id, document_id, actor_role, account_member_id, agent_id, signed_name, content_hash, acknowledged_at, independent_review_notice_shown_at",
    )
    .eq("buyer_account_id", buyerAccountId)
    .in("document_id", documentIds);
  return currentAgentAcks(db, buyerAccountId, (data ?? []) as DdAcknowledgment[]);
}

/**
 * Only the buyer's CURRENTLY tethered Resident Agent satisfies the parallel
 * acknowledgment. After a re-tether, the prior agent's acks stay in the Audit
 * Vault but no longer count toward the gate.
 */
export async function currentAgentAcks<T extends { actor_role: string; agent_id: string | null }>(
  db: Db,
  buyerAccountId: string,
  acks: T[],
): Promise<T[]> {
  if (!acks.some((a) => a.actor_role === "resident_agent")) return acks;
  const { data: buyer } = await db
    .from("buyer_accounts")
    .select("tethered_resident_agent_id")
    .eq("id", buyerAccountId)
    .maybeSingle();
  const tethered = (buyer?.tethered_resident_agent_id as string | null) ?? null;
  return acks.filter((a) => a.actor_role !== "resident_agent" || a.agent_id === tethered);
}

async function loadMembers(db: Db, buyerAccountId: string): Promise<DdMember[]> {
  const { data } = await db
    .from("account_members")
    .select("id, full_name, role")
    .eq("buyer_account_id", buyerAccountId);
  return (data ?? []) as DdMember[];
}

export interface BuyerDiligencePayload {
  allowed: boolean;
  reason: "ok" | "no_buyer_account" | "not_found";
  buyerAccountId: string | null;
  property: { id: string; address: string; city: string; state: string } | null;
  members: DdMember[];
  states: DdDocumentState[];
  gateClear: boolean;
  agent: { id: string; name: string | null } | null;
  noticeText: string;
  memberAckText: string;
  agentAckText: string;
}

/** Buyer-side Document Acknowledgment screen payload. */
export const getBuyerDiligence = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string }) => ({ propertyId: String(d.propertyId) }))
  .handler(async ({ data, context }): Promise<BuyerDiligencePayload> => {
    const db = await adminDb();
    const empty = {
      buyerAccountId: null,
      property: null,
      members: [],
      states: [],
      gateClear: false,
      agent: null,
      noticeText: INDEPENDENT_REVIEW_NOTICE,
      memberAckText: MEMBER_ACK_TEXT,
      agentAckText: AGENT_ACK_TEXT,
    };

    const { data: buyer } = await db
      .from("buyer_accounts")
      .select("id, tethered_resident_agent_id")
      .eq("auth_user_id", context.userId)
      .maybeSingle();
    if (!buyer) return { allowed: false, reason: "no_buyer_account", ...empty };

    const { data: property } = await db
      .from("properties")
      .select("id, address, city, state")
      .eq("id", data.propertyId)
      .maybeSingle();
    if (!property) return { allowed: false, reason: "not_found", ...empty };

    const documents = await loadDocuments(db, data.propertyId);
    const members = await loadMembers(db, buyer.id);
    const acks = await loadAcks(db, buyer.id, documents.map((d) => d.id));
    const states = buildGateState(documents, acks, members);

    let agent: { id: string; name: string | null } | null = null;
    if (buyer.tethered_resident_agent_id) {
      const { data: a } = await db
        .from("agents")
        .select("id, full_name")
        .eq("id", buyer.tethered_resident_agent_id)
        .maybeSingle();
      if (a) agent = { id: a.id, name: a.full_name ?? null };
    }

    return {
      allowed: true,
      reason: "ok",
      buyerAccountId: buyer.id,
      property,
      members,
      states,
      gateClear: gateClear(states),
      agent,
      noticeText: INDEPENDENT_REVIEW_NOTICE,
      memberAckText: MEMBER_ACK_TEXT,
      agentAckText: AGENT_ACK_TEXT,
    };
  });

interface AckInput {
  documentId: string;
  contentHash: string;
  signedName: string;
  secondaryVerificationMethod: string;
  ipAddress?: string | null;
  deviceFingerprint?: string | null;
  noticeShownAt?: string | null;
}

function parseAck(d: any): AckInput & { accountMemberId?: string } {
  return {
    documentId: String(d.documentId),
    contentHash: String(d.contentHash),
    signedName: String(d.signedName ?? "").trim(),
    secondaryVerificationMethod: String(d.secondaryVerificationMethod ?? "typed_initials"),
    ipAddress: d.ipAddress ? String(d.ipAddress) : null,
    deviceFingerprint: d.deviceFingerprint ? String(d.deviceFingerprint) : null,
    noticeShownAt: d.noticeShownAt ? String(d.noticeShownAt) : null,
    accountMemberId: d.accountMemberId ? String(d.accountMemberId) : undefined,
  };
}

/** Account Member acknowledgment of one due-diligence document. */
export const acknowledgeAsMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(parseAck)
  .handler(async ({ data, context }): Promise<{ ok: boolean; error?: string }> => {
    const db = await adminDb();
    const { data: buyer } = await db
      .from("buyer_accounts")
      .select("id, tethered_resident_agent_id")
      .eq("auth_user_id", context.userId)
      .maybeSingle();
    if (!buyer) return { ok: false, error: "No buyer account on file." };

    const { data: doc } = await db
      .from("due_diligence_inventory")
      .select("*")
      .eq("id", data.documentId)
      .maybeSingle();
    if (!doc) return { ok: false, error: "Document not found." };
    if (doc.content_hash !== data.contentHash)
      return { ok: false, error: "This document changed — reload and review the current version." };

    const { data: member } = await db
      .from("account_members")
      .select("id, full_name")
      .eq("id", data.accountMemberId ?? "")
      .eq("buyer_account_id", buyer.id)
      .maybeSingle();
    if (!member) return { ok: false, error: "Account Member not found on this account." };

    const showNotice = Boolean(doc.is_governing_instrument);
    const { error } = await db.from("due_diligence_acknowledgments").insert({
      document_id: doc.id,
      property_id: doc.property_id,
      buyer_account_id: buyer.id,
      actor_role: "account_member",
      account_member_id: member.id,
      actor_auth_user_id: context.userId,
      signed_name: data.signedName || (member.full_name ?? "Account Member"),
      acknowledgment_text: MEMBER_ACK_TEXT,
      content_hash: doc.content_hash,
      ip_address: auditIp(data.ipAddress),
      device_fingerprint: data.deviceFingerprint,
      secondary_verification_method: data.secondaryVerificationMethod,
      independent_review_notice_text: showNotice ? INDEPENDENT_REVIEW_NOTICE : null,
      independent_review_notice_shown_at: showNotice
        ? (data.noticeShownAt ?? new Date().toISOString())
        : null,
    });
    if (error && !String(error.message).includes("duplicate key"))
      return { ok: false, error: error.message };

    await audit(db, {
      actorId: context.userId,
      actorType: "buyer",
      actionType: "diligence.member_acknowledged",
      entityId: doc.id,
      metadata: {
        property_id: doc.property_id,
        buyer_account_id: buyer.id,
        account_member_id: member.id,
        content_hash: doc.content_hash,
        is_governing_instrument: showNotice,
        independent_review_notice_shown: showNotice,
        secondary_verification_method: data.secondaryVerificationMethod,
      },
    });

    await maybeLogGateCleared(db, doc.property_id, buyer.id, context.userId);
    return { ok: true };
  });

async function maybeLogGateCleared(
  db: Db,
  propertyId: string,
  buyerAccountId: string,
  actorId: string,
) {
  const documents = await loadDocuments(db, propertyId);
  const members = await loadMembers(db, buyerAccountId);
  const acks = await loadAcks(db, buyerAccountId, documents.map((d) => d.id));
  const states = buildGateState(documents, acks, members);
  if (!gateClear(states)) return;
  await audit(db, {
    actorId,
    actorType: "system",
    actionType: "diligence.gate_cleared",
    entityId: propertyId,
    metadata: {
      buyer_account_id: buyerAccountId,
      documents: gatingDocuments(states).map((s) => ({
        id: s.document.id,
        content_hash: s.document.content_hash,
      })),
    },
  });
}

export interface AgentDiligenceTask {
  documentId: string;
  documentTitle: string;
  category: DdCategory;
  contentHash: string;
  signedUrl: string | null;
  isGoverning: boolean;
  placedAt: string;
  dueAt: string;
  overdue: boolean;
  acknowledged: boolean;
  propertyId: string;
  propertyLabel: string;
  buyerAccountId: string;
  buyerLabel: string;
}

/** Parallel Resident Agent acknowledgment queue for the signed-in agent. */
export const getAgentDiligenceTasks = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{
    agentId: string | null;
    agentName: string;
    tasks: AgentDiligenceTask[];
    ackText: string;
  }> => {
    const db = await adminDb();
    const { data: agent } = await db
      .from("agents")
      .select("id, full_name")
      .eq("auth_user_id", context.userId)
      .maybeSingle();
    if (!agent)
      return { agentId: null, agentName: "Resident Agent", tasks: [], ackText: AGENT_ACK_TEXT };

    const { data: buyers } = await db
      .from("buyer_accounts")
      .select("id")
      .eq("tethered_resident_agent_id", agent.id);
    const buyerIds = ((buyers ?? []) as { id: string }[]).map((b) => b.id);
    if (buyerIds.length === 0)
      return {
        agentId: agent.id,
        agentName: agent.full_name ?? "Resident Agent",
        tasks: [],
        ackText: AGENT_ACK_TEXT,
      };

    // Properties those buyers have reserved into.
    const { data: reservations } = await db
      .from("pod_reservations")
      .select("buyer_account_id, property_id, status")
      .in("buyer_account_id", buyerIds)
      .eq("status", "reserved");

    const pairs = ((reservations ?? []) as any[]).map((r) => ({
      buyerAccountId: r.buyer_account_id as string,
      propertyId: r.property_id as string,
    }));
    if (pairs.length === 0)
      return {
        agentId: agent.id,
        agentName: agent.full_name ?? "Resident Agent",
        tasks: [],
        ackText: AGENT_ACK_TEXT,
      };

    const propertyIds = [...new Set(pairs.map((p) => p.propertyId))];
    const { data: props } = await db
      .from("properties")
      .select("id, address, city, state")
      .in("id", propertyIds);
    const propLabel = new Map<string, string>();
    ((props ?? []) as any[]).forEach((p) =>
      propLabel.set(p.id, `${p.address}, ${p.city} ${p.state}`),
    );

    const tasks: AgentDiligenceTask[] = [];
    for (const propertyId of propertyIds) {
      const documents = (await loadDocuments(db, propertyId)).filter(
        (d) => d.required && !d.superseded_by,
      );
      if (documents.length === 0) continue;
      for (const { buyerAccountId, propertyId: pid } of pairs.filter(
        (p) => p.propertyId === propertyId,
      )) {
        const members = await loadMembers(db, buyerAccountId);
        const acks = await loadAcks(db, buyerAccountId, documents.map((d) => d.id));
        const states = buildGateState(documents, acks, members);
        for (const s of states) {
          tasks.push({
            documentId: s.document.id,
            documentTitle: s.document.document_title,
            category: s.document.category,
            contentHash: s.document.content_hash,
            signedUrl: s.document.signed_url,
            isGoverning: s.document.is_governing_instrument,
            placedAt: s.document.placed_at,
            dueAt: s.agentDueAt,
            overdue: s.agentOverdue,
            acknowledged: s.agentAcked,
            propertyId: pid,
            propertyLabel: propLabel.get(pid) ?? "Subject Property",
            buyerAccountId,
            buyerLabel:
              members.map((m) => m.full_name).filter(Boolean).join(" & ") || "Buyer Account",
          });
        }
      }
    }

    return {
      agentId: agent.id,
      agentName: agent.full_name ?? "Resident Agent",
      tasks,
      ackText: AGENT_ACK_TEXT,
    };
  });

/** Resident Agent parallel acknowledgment. */
export const acknowledgeAsAgent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: any) => ({ ...parseAck(d), buyerAccountId: String(d.buyerAccountId) }))
  .handler(async ({ data, context }): Promise<{ ok: boolean; error?: string }> => {
    const db = await adminDb();
    const { data: agent } = await db
      .from("agents")
      .select("id, full_name")
      .eq("auth_user_id", context.userId)
      .maybeSingle();
    if (!agent) return { ok: false, error: "No agent profile on file." };

    const { data: buyer } = await db
      .from("buyer_accounts")
      .select("id, tethered_resident_agent_id")
      .eq("id", data.buyerAccountId)
      .maybeSingle();
    if (!buyer || buyer.tethered_resident_agent_id !== agent.id)
      return { ok: false, error: "You are not the tethered Resident Agent for this account." };

    const { data: doc } = await db
      .from("due_diligence_inventory")
      .select("*")
      .eq("id", data.documentId)
      .maybeSingle();
    if (!doc) return { ok: false, error: "Document not found." };
    if (doc.content_hash !== data.contentHash)
      return { ok: false, error: "This document changed — reload and review the current version." };

    const showNotice = Boolean(doc.is_governing_instrument);
    const { error } = await db.from("due_diligence_acknowledgments").insert({
      document_id: doc.id,
      property_id: doc.property_id,
      buyer_account_id: buyer.id,
      actor_role: "resident_agent",
      agent_id: agent.id,
      actor_auth_user_id: context.userId,
      signed_name: data.signedName || (agent.full_name ?? "Resident Agent"),
      acknowledgment_text: AGENT_ACK_TEXT,
      content_hash: doc.content_hash,
      ip_address: auditIp(data.ipAddress),
      device_fingerprint: data.deviceFingerprint,
      secondary_verification_method: data.secondaryVerificationMethod,
      independent_review_notice_text: showNotice ? INDEPENDENT_REVIEW_NOTICE : null,
      independent_review_notice_shown_at: showNotice
        ? (data.noticeShownAt ?? new Date().toISOString())
        : null,
    });
    if (error && !String(error.message).includes("duplicate key"))
      return { ok: false, error: error.message };

    await audit(db, {
      actorId: context.userId,
      actorType: "agent",
      actionType: "diligence.agent_acknowledged",
      entityId: doc.id,
      metadata: {
        property_id: doc.property_id,
        buyer_account_id: buyer.id,
        agent_id: agent.id,
        content_hash: doc.content_hash,
        independent_review_notice_shown: showNotice,
        secondary_verification_method: data.secondaryVerificationMethod,
      },
    });

    await maybeLogGateCleared(db, doc.property_id, buyer.id, context.userId);
    return { ok: true };
  });

export interface GateStatus {
  clear: boolean;
  pending: {
    documentId: string;
    documentTitle: string;
    awaitingMembers: string[];
    awaitingAgent: boolean;
    reacknowledgmentRequired: boolean;
  }[];
}

/**
 * Buyer-Authorization gate check (consumed by the Prompt 3 workflow).
 * Any Required document that gained a new content_hash resets to "pending"
 * even though prior acknowledgments remain in the Audit Vault.
 */
export async function evaluateGate(
  propertyId: string,
  buyerAccountId: string,
): Promise<GateStatus> {
  const db = await adminDb();
  const documents = await loadDocuments(db, propertyId);
  const members = await loadMembers(db, buyerAccountId);
  const acks = await loadAcks(db, buyerAccountId, documents.map((d) => d.id));
  const states = gatingDocuments(buildGateState(documents, acks, members));

  return {
    clear: states.every((s) => s.clear),
    pending: states
      .filter((s) => !s.clear)
      .map((s) => ({
        documentId: s.document.id,
        documentTitle: s.document.document_title,
        awaitingMembers: members
          .filter((m) => !s.memberAcked.includes(m.id))
          .map((m) => m.full_name ?? "Account Member"),
        awaitingAgent: !s.agentAcked,
        reacknowledgmentRequired: s.staleAcks > 0,
      })),
  };
}

export const getAuthorizationGateStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string; buyerAccountId?: string }) => ({
    propertyId: String(d.propertyId),
    buyerAccountId: d.buyerAccountId ? String(d.buyerAccountId) : undefined,
  }))
  .handler(async ({ data, context }): Promise<GateStatus> => {
    const db = await adminDb();
    let buyerAccountId = data.buyerAccountId;
    if (!buyerAccountId) {
      const { data: buyer } = await db
        .from("buyer_accounts")
        .select("id")
        .eq("auth_user_id", context.userId)
        .maybeSingle();
      buyerAccountId = buyer?.id;
    }
    if (!buyerAccountId) return { clear: false, pending: [] };
    const status = await evaluateGate(data.propertyId, buyerAccountId);
    if (!status.clear) {
      await audit(db, {
        actorId: context.userId,
        actorType: "system",
        actionType: "diligence.gate_blocked",
        entityId: data.propertyId,
        metadata: { buyer_account_id: buyerAccountId, pending: status.pending.length },
      });
    }
    return status;
  });

/**
 * Place or amend a due-diligence document (admin/compliance only).
 * A revision supersedes the prior row; prior acknowledgments stay in the Audit
 * Vault but stop being current, forcing re-acknowledgment.
 */
export const placeDiligenceDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: any) => ({
    propertyId: String(d.propertyId),
    documentTitle: String(d.documentTitle),
    category: String(d.category) as DdCategory,
    fileUrl: String(d.fileUrl),
    contentHash: String(d.contentHash),
    required: d.required !== false,
    isGoverningInstrument:
      typeof d.isGoverningInstrument === "boolean" ? d.isGoverningInstrument : undefined,
    supersedesId: d.supersedesId ? String(d.supersedesId) : null,
  }))
  .handler(async ({ data, context }): Promise<{ ok: boolean; id?: string; error?: string }> => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("has_role", {
      _user_id: userId,
      _role: "admin",
    });
    if (!isAdmin) return { ok: false, error: "Admins only." };

    const db = await adminDb();
    const governing =
      data.isGoverningInstrument ?? GOVERNING_CATEGORIES.includes(data.category);

    const { data: inserted, error } = await db
      .from("due_diligence_inventory")
      .insert({
        property_id: data.propertyId,
        document_title: data.documentTitle,
        category: data.category,
        file_url: data.fileUrl,
        content_hash: data.contentHash,
        required: data.required,
        is_governing_instrument: governing,
      })
      .select("id")
      .maybeSingle();
    if (error || !inserted) return { ok: false, error: error?.message ?? "Insert failed." };

    if (data.supersedesId) {
      await db
        .from("due_diligence_inventory")
        .update({ superseded_by: inserted.id })
        .eq("id", data.supersedesId);
      await audit(db, {
        actorId: userId,
        actorType: "admin",
        actionType: "diligence.document_superseded",
        entityId: data.supersedesId,
        metadata: { replaced_by: inserted.id, property_id: data.propertyId },
      });
      await audit(db, {
        actorId: userId,
        actorType: "system",
        actionType: "diligence.reacknowledgment_required",
        entityId: inserted.id,
        metadata: {
          property_id: data.propertyId,
          reason: "amended_required_document",
          prior_document_id: data.supersedesId,
        },
      });
    }

    await audit(db, {
      actorId: userId,
      actorType: "admin",
      actionType: "diligence.document_placed",
      entityId: inserted.id,
      metadata: {
        property_id: data.propertyId,
        category: data.category,
        required: data.required,
        is_governing_instrument: governing,
        content_hash: data.contentHash,
      },
    });

    if (data.required) {
      await notifyNewRequiredDocument(db, {
        id: inserted.id,
        property_id: data.propertyId,
        document_title: data.documentTitle,
        amended: Boolean(data.supersedesId),
      });
    }

    return { ok: true, id: inserted.id };
  });

/**
 * Alert every Buyer Account reserved into this property, and their tethered
 * Resident Agents, that a new Required document is on file.
 */
async function notifyNewRequiredDocument(
  db: Db,
  doc: { id: string; property_id: string; document_title: string; amended: boolean },
) {
  const mod = await import("@/lib/due-diligence-notify.server");
  await mod.notifyNewRequiredDocument(db as never, doc);
}

export interface PropertyDdDocument {
  id: string;
  document_title: string;
  category: DdCategory;
  required: boolean;
  is_governing_instrument: boolean;
  placed_at: string;
  superseded_by: string | null;
  signed_url: string | null;
}

/** Inventory for one property, for the admin and seller upload surfaces. */
export const listPropertyDiligence = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { propertyId: string }) => ({ propertyId: String(d.propertyId) }))
  .handler(
    async ({
      data,
      context,
    }): Promise<{
      allowed: boolean;
      isAdmin: boolean;
      property: { id: string; address: string; city: string; state: string } | null;
      documents: PropertyDdDocument[];
    }> => {
      const { supabase, userId } = context;
      const { data: adminFlag } = await supabase.rpc("has_role", {
        _user_id: userId,
        _role: "admin",
      });
      const isAdmin = Boolean(adminFlag);

      const db = await adminDb();
      const { data: property } = await db
        .from("properties")
        .select("id, address, city, state, seller_id")
        .eq("id", data.propertyId)
        .maybeSingle();
      if (!property) return { allowed: false, isAdmin, property: null, documents: [] };
      if (!isAdmin && property.seller_id !== userId)
        return { allowed: false, isAdmin, property: null, documents: [] };

      const documents = await loadDocuments(db, data.propertyId);
      return {
        allowed: true,
        isAdmin,
        property: {
          id: property.id,
          address: property.address,
          city: property.city,
          state: property.state,
        },
        documents: documents.map((d) => ({
          id: d.id,
          document_title: d.document_title,
          category: d.category,
          required: d.required,
          is_governing_instrument: d.is_governing_instrument,
          placed_at: d.placed_at,
          superseded_by: d.superseded_by,
          signed_url: d.signed_url,
        })),
      };
    },
  );

/**
 * Seller-placed disclosure document. Category is fixed to sellers_disclosure,
 * never a governing instrument, and always Required.
 */
export const placeSellerDisclosure = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: any) => ({
    propertyId: String(d.propertyId),
    documentTitle: String(d.documentTitle),
    fileUrl: String(d.fileUrl),
    contentHash: String(d.contentHash),
    supersedesId: d.supersedesId ? String(d.supersedesId) : null,
  }))
  .handler(async ({ data, context }): Promise<{ ok: boolean; id?: string; error?: string }> => {
    const db = await adminDb();
    const { data: property } = await db
      .from("properties")
      .select("id, seller_id")
      .eq("id", data.propertyId)
      .maybeSingle();
    if (!property || property.seller_id !== context.userId)
      return { ok: false, error: "This property isn't on your account." };

    const { data: inserted, error } = await db
      .from("due_diligence_inventory")
      .insert({
        property_id: data.propertyId,
        document_title: data.documentTitle,
        category: "sellers_disclosure",
        file_url: data.fileUrl,
        content_hash: data.contentHash,
        required: true,
        is_governing_instrument: false,
      })
      .select("id")
      .maybeSingle();
    if (error || !inserted) return { ok: false, error: error?.message ?? "Upload failed." };

    if (data.supersedesId) {
      await db
        .from("due_diligence_inventory")
        .update({ superseded_by: inserted.id })
        .eq("id", data.supersedesId);
      await audit(db, {
        actorId: context.userId,
        actorType: "seller",
        actionType: "diligence.document_superseded",
        entityId: data.supersedesId,
        metadata: { replaced_by: inserted.id, property_id: data.propertyId },
      });
      await audit(db, {
        actorId: context.userId,
        actorType: "system",
        actionType: "diligence.reacknowledgment_required",
        entityId: inserted.id,
        metadata: {
          property_id: data.propertyId,
          reason: "amended_required_document",
          prior_document_id: data.supersedesId,
        },
      });
    }

    await audit(db, {
      actorId: context.userId,
      actorType: "seller",
      actionType: "diligence.document_placed",
      entityId: inserted.id,
      metadata: {
        property_id: data.propertyId,
        category: "sellers_disclosure",
        required: true,
        is_governing_instrument: false,
        content_hash: data.contentHash,
      },
    });

    await notifyNewRequiredDocument(db, {
      id: inserted.id,
      property_id: data.propertyId,
      document_title: data.documentTitle,
      amended: Boolean(data.supersedesId),
    });

    return { ok: true, id: inserted.id };
  });
