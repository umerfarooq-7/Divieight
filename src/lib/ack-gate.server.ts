/**
 * The acknowledgment gate in detail, late-arriving documents, and the Final Acknowledgment Posture Record (server side).
 *
 * The gate itself is unchanged: a property's Required, current documents each need every active Account Member's acknowledgment (or documented authority)
 * and the tethered Resident Agent's, pinned to the document's current content hash. Here it is spelled out (who still owes which document and version) so the
 * wire-instruction screens can say what is missing, and at the Closing Ping an immutable, hashed record of every acknowledgment is made and filed.
 * Property-scoped and per Account Member throughout: the agent is the buyer's agent ON THIS PROPERTY (the per-property agent resolver).
 */
import { createHash } from "node:crypto";
import { POSTURE_DOCUMENT_TYPE, POSTURE_SCHEMA, lockMessage, priorVersions, versionOf, type GateDoc, type Missing, type PostureAck } from "@/lib/ack-gate";
import { renderPosturePdf } from "@/lib/posture-pdf";
import { effectiveAgentId } from "@/lib/property-agent.server";

type Db = { from: (t: string) => any; storage?: any };

const BUCKET = "property-documents";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** JSON with sorted keys, so the same content always gives the same bytes and the same hash. */
export function stableStringify(value: unknown): string {
  const sort = (v: any): any => (Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);
  return JSON.stringify(sort(value));
}

export interface AckGate {
  clear: boolean;
  missing: Missing[];
  message: string;
  documents: GateDoc[];
  members: Array<{ id: string; name: string }>;
  agent: { id: string; name: string } | null;
  acks: Array<Record<string, any>>;
}

export async function acknowledgmentGate(db: Db, propertyId: string, buyerAccountId: string): Promise<AckGate> {
  const { data: docRows } = await db.from("due_diligence_inventory").select("*").eq("property_id", propertyId);
  const docs = ((docRows ?? []) as GateDoc[]).sort((a, b) => a.placed_at.localeCompare(b.placed_at));
  const current = docs.filter((d) => d.required && !d.superseded_by);
  const { data: memberRows } = await db.from("account_members").select("id, full_name, status").eq("buyer_account_id", buyerAccountId).eq("status", "active");
  const members = ((memberRows ?? []) as Array<{ id: string; full_name: string | null }>).map((m) => ({ id: m.id, name: (m.full_name ?? "").trim() || `Member ${m.id.slice(0, 8)}` })).sort((a, b) => a.id.localeCompare(b.id));
  const { data: ackRows } = docs.length ? await db.from("due_diligence_acknowledgments").select("*").eq("buyer_account_id", buyerAccountId).in("document_id", docs.map((d) => d.id)) : { data: [] };
  const acks = (ackRows ?? []) as Array<Record<string, any>>;
  const agentId = await effectiveAgentId(db, buyerAccountId, propertyId);
  let agent: { id: string; name: string } | null = null;
  if (agentId) {
    const { data: a } = await db.from("agents").select("id, full_name").eq("id", agentId).maybeSingle();
    agent = { id: agentId, name: (a?.full_name as string | undefined)?.trim() || `Agent ${agentId.slice(0, 8)}` };
  }
  // A report with flagged findings is a "material report item": it is one of the Required documents, and the message says so.
  const flagsBy = new Map<string, number>();
  if (current.length) {
    const { data: reports, error } = await db.from("property_reports").select("diligence_document_id, flags").in("diligence_document_id", current.map((d) => d.id));
    if (!error) for (const r of (reports ?? []) as Array<{ diligence_document_id: string; flags: unknown[] | null }>) flagsBy.set(r.diligence_document_id, (r.flags ?? []).length);
  }
  const missing: Missing[] = [];
  for (const d of current) {
    const base = { documentId: d.id, title: d.document_title, version: versionOf(docs, d.id), materialFlags: flagsBy.get(d.id) ?? 0 };
    const mine = acks.filter((a) => a.document_id === d.id && a.content_hash === d.content_hash);
    if (members.length === 0) missing.push({ ...base, who: "account", name: "an Account Member" });
    for (const m of members) if (!mine.some((a) => a.actor_role === "account_member" && a.account_member_id === m.id)) missing.push({ ...base, who: "member", memberId: m.id, name: m.name });
    if (!agent) missing.push({ ...base, who: "agent", agentId: null, name: "(none tethered)" });
    else if (!mine.some((a) => a.actor_role === "resident_agent" && a.agent_id === agent!.id)) missing.push({ ...base, who: "agent", agentId: agent.id, name: agent.name });
  }
  return { clear: missing.length === 0, missing, message: lockMessage(missing), documents: docs, members, agent, acks };
}

/** What the wire-instruction screens, the funding notices and the closing-funds confirmation ask. */
export async function gateForWire(db: Db, propertyId: string, buyerAccountId: string) {
  const g = await acknowledgmentGate(db, propertyId, buyerAccountId);
  return { clear: g.clear, message: g.message, missing: g.missing };
}

/** Every buyer account holding, or reserved into, a property. */
export async function accountsOnProperty(db: Db, propertyId: string): Promise<string[]> {
  const ids = new Set<string>();
  const { data: cap } = await db.from("cap_table_entries").select("buyer_account_id").eq("property_id", propertyId);
  for (const c of (cap ?? []) as Array<{ buyer_account_id: string | null }>) if (c.buyer_account_id) ids.add(c.buyer_account_id);
  const { data: res } = await db.from("pod_reservations").select("buyer_account_id").eq("property_id", propertyId).eq("status", "reserved");
  for (const r of (res ?? []) as Array<{ buyer_account_id: string }>) if (r.buyer_account_id) ids.add(r.buyer_account_id);
  return [...ids].sort();
}

// ---------------------------------------------------------------------------------------------------------
// A late-arriving document re-closes the gate
// ---------------------------------------------------------------------------------------------------------
/**
 * Record that a Required document was added (or a new version superseded one). The gate re-closes by itself, because it is worked out from the documents;
 * this records when, and who owed the new item, for the Posture Record. Earlier acknowledgments are not touched: they stay on the version they were made on.
 */
export async function recordRetrigger(db: Db, p: { documentId: string; propertyId: string; priorDocumentId?: string | null; actorId?: string | null }) {
  const { data: doc } = await db.from("due_diligence_inventory").select("*").eq("id", p.documentId).maybeSingle();
  if (!doc || !doc.required) return null;
  const { data: others } = await db.from("due_diligence_acknowledgments").select("id, document_id").eq("property_id", p.propertyId);
  const acknowledgedBefore = ((others ?? []) as Array<{ document_id: string }>).some((a) => a.document_id !== p.documentId);
  const owing = [];
  for (const buyerId of await accountsOnProperty(db, p.propertyId)) {
    const g = await acknowledgmentGate(db, p.propertyId, buyerId);
    // Who owes the new item.
    const mine = g.missing.filter((m) => m.documentId === p.documentId);
    owing.push({
      buyer_account_id: buyerId,
      members: g.members.filter((m) => mine.some((x) => x.memberId === m.id)).map((m) => ({ account_member_id: m.id, name: m.name })),
      agent: g.agent && mine.some((x) => x.who === "agent") ? { agent_id: g.agent.id, name: g.agent.name } : null,
    });
  }
  const row = {
    property_id: p.propertyId,
    document_id: p.documentId,
    prior_document_id: p.priorDocumentId ?? null,
    kind: p.priorDocumentId ? "new_version" : "new_required_document",
    document_title: doc.document_title as string,
    content_hash: doc.content_hash as string,
    acknowledged_before: acknowledgedBefore,
    owing,
    triggered_by: p.actorId ?? null,
  };
  const { error } = await db.from("diligence_retriggers").insert(row);
  if (error && !/duplicate|unique/i.test(error.message ?? "")) return null; // before acknowledgment-posture.sql is run the gate still re-closes; only the record is missing
  await db.from("audit_log").insert({
    actor_id: p.actorId ?? null,
    actor_type: p.actorId ? "admin" : "system",
    action_type: "diligence.gate_reclosed",
    entity_type: "diligence_document",
    entity_id: p.documentId,
    metadata: { property_id: p.propertyId, kind: row.kind, acknowledged_before: acknowledgedBefore, owing_accounts: owing.length, content_hash: row.content_hash },
  });
  return row;
}

// ---------------------------------------------------------------------------------------------------------
// The Final Acknowledgment Posture Record
// ---------------------------------------------------------------------------------------------------------
export class PostureIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostureIncompleteError";
  }
}

const ackOf = (a: Record<string, any>, docs: GateDoc[]): PostureAck => {
  const doc = docs.find((d) => d.id === a.document_id);
  return {
    document_id: a.document_id as string,
    title: doc?.document_title ?? "(document)",
    version: doc ? versionOf(docs, doc.id) : 1,
    content_hash: a.content_hash as string,
    acknowledged_at: isoOrNull(a.acknowledged_at) ?? "",
    ip_address: (a.ip_address ?? null) as string | null,
    device_fingerprint: (a.device_fingerprint ?? null) as string | null,
    user_agent: (a.user_agent ?? null) as string | null,
    method: a.authority_grant_id || a.on_behalf_of_member_id ? "authority" : "typed_signature",
    secondary_verification: (a.secondary_verification_method ?? null) as string | null,
    signed_name: (a.signed_name ?? null) as string | null,
    acted_by_member_id: (a.acted_by_member_id ?? null) as string | null,
    authority_grant_id: (a.authority_grant_id ?? null) as string | null,
    current: !!doc && doc.required && !doc.superseded_by && doc.content_hash === a.content_hash,
  };
};
const byAck = (x: PostureAck, y: PostureAck) => x.title.localeCompare(y.title) || x.version - y.version || x.acknowledged_at.localeCompare(y.acknowledged_at);

/** Everything on one page: each buyer account member and each tethered agent, each Required document and version, and what was acknowledged. */
export async function buildPosture(db: Db, propertyId: string, now: Date = new Date()) {
  const { data: prop } = await db.from("properties").select("address, city, state").eq("id", propertyId).maybeSingle();
  const accounts = [];
  const missingAll: Array<{ account: string; message: string }> = [];
  let documents: GateDoc[] = [];
  let first = true;
  const { data: flagRows } = await db.from("property_reports").select("diligence_document_id, flags").eq("property_id", propertyId);
  const flags = new Map(((flagRows ?? []) as Array<{ diligence_document_id: string | null; flags: unknown[] | null }>).filter((r) => r.diligence_document_id).map((r) => [r.diligence_document_id as string, (r.flags ?? []).length]));
  for (const buyerId of await accountsOnProperty(db, propertyId)) {
    const g = await acknowledgmentGate(db, propertyId, buyerId);
    if (first) {
      documents = g.documents;
      first = false;
    }
    if (!g.clear) missingAll.push({ account: buyerId, message: g.message });
    const docsAll = g.documents;
    accounts.push({
      buyer_account_id: buyerId,
      members: g.members.map((m) => ({
        account_member_id: m.id,
        name: m.name,
        acknowledgments: g.acks.filter((a) => a.actor_role === "account_member" && a.account_member_id === m.id).map((a) => ackOf(a, docsAll)).sort(byAck),
        missing: g.missing.filter((x) => x.memberId === m.id).map((x) => ({ document_id: x.documentId, title: x.title, version: x.version })),
      })),
      agent: g.agent
        ? {
            agent_id: g.agent.id,
            name: g.agent.name,
            acknowledgments: g.acks.filter((a) => a.actor_role === "resident_agent" && a.agent_id === g.agent!.id).map((a) => ackOf(a, docsAll)).sort(byAck),
            missing: g.missing.filter((x) => x.who === "agent").map((x) => ({ document_id: x.documentId, title: x.title, version: x.version })),
          }
        : null,
    });
  }
  const current = documents.filter((d) => d.required && !d.superseded_by);
  const { data: rt } = await db.from("diligence_retriggers").select("*").eq("property_id", propertyId).order("triggered_at", { ascending: true });
  const retriggers = ((rt ?? []) as Array<Record<string, any>>).map((r) => ({
    kind: r.kind as string,
    document_id: r.document_id as string,
    title: r.document_title as string,
    version: versionOf(documents, r.document_id as string),
    prior_document_id: (r.prior_document_id ?? null) as string | null,
    content_hash: r.content_hash as string,
    triggered_at: isoOrNull(r.triggered_at),
    after_acknowledgments: !!r.acknowledged_before,
    owing: r.owing,
  }));
  const ackCount = accounts.reduce((n, a) => n + a.members.reduce((m, x) => m + x.acknowledgments.length, 0) + (a.agent?.acknowledgments.length ?? 0), 0);
  const agents = [...new Map(accounts.filter((a) => a.agent).map((a) => [a.agent!.agent_id, a.agent!.name])).entries()];
  const data = {
    schema: POSTURE_SCHEMA,
    property: { property_id: propertyId, address: [prop?.address, prop?.city, prop?.state].filter(Boolean).join(", ") || null },
    generated_at: now.toISOString(),
    documents: current.map((d) => ({
      document_id: d.id,
      title: d.document_title,
      category: d.category,
      version: versionOf(documents, d.id),
      content_hash: d.content_hash,
      placed_at: isoOrNull(d.placed_at),
      material_report_flags: flags.get(d.id) ?? 0,
      earlier_versions: priorVersions(documents, d.id).map((p) => ({ document_id: p.id, version: versionOf(documents, p.id), content_hash: p.content_hash, placed_at: isoOrNull(p.placed_at) })),
    })),
    buyer_accounts: accounts,
    agents: agents.map(([id, name]) => ({ agent_id: id, name })),
    retriggers,
    summary: {
      buyer_accounts: accounts.length,
      members: accounts.reduce((n, a) => n + a.members.length, 0),
      agents: agents.length,
      required_documents: current.length,
      acknowledgments: ackCount,
      complete: missingAll.length === 0 && accounts.length > 0,
    },
  };
  return { data, missing: missingAll };
}

/** The content, without the time it was made: what makes a retry the same record. */
export const postureContentHash = (data: { generated_at?: string } & Record<string, unknown>) => {
  const { generated_at: _t, ...rest } = data;
  return sha256(stableStringify(rest));
};

/**
 * Make the record at the Closing Ping. It is refused (the saga fails to the dead-letter queue) if any member's or agent's acknowledgment of any Required
 * document is missing. Immutable and hashed; the same acknowledgments give the same record, so a retried saga does not make another.
 */
export async function generatePostureRecord(db: Db, p: { propertyId: string; sagaKey?: string | null; now?: Date }) {
  const { data, missing } = await buildPosture(db, p.propertyId, p.now);
  if (!data.summary.complete) {
    const why = missing.length ? missing.map((m) => `Buyer Account ${m.account.slice(0, 8)}: ${m.message}`).join(" ") : "No buyer account is on this property.";
    throw new PostureIncompleteError(`The Final Acknowledgment Posture Record can't be made: ${why}`);
  }
  const contentHash = postureContentHash(data);
  const { data: existing } = await db.from("acknowledgment_posture_records").select("id, version, hash, content_hash").eq("property_id", p.propertyId);
  const rows = ((existing ?? []) as Array<{ id: string; version: number; hash: string; content_hash: string }>).sort((a, b) => b.version - a.version);
  if (rows[0] && rows[0].content_hash === contentHash) return { id: rows[0].id, version: rows[0].version, hash: rows[0].hash, reused: true, data };
  const version = (rows[0]?.version ?? 0) + 1;
  const hash = sha256(stableStringify(data));
  const { data: inserted, error } = await db
    .from("acknowledgment_posture_records")
    .insert({ property_id: p.propertyId, version, content_hash: contentHash, data, hash, saga_key: p.sagaKey ?? null })
    .select("id")
    .maybeSingle();
  if (error || !inserted) throw new Error(`The Final Acknowledgment Posture Record could not be stored (${error?.message ?? "no row"}): run acknowledgment-posture.sql in Supabase.`);
  // The Audit Vault.
  await db.from("audit_log").insert({
    actor_id: null,
    actor_type: "system",
    action_type: "diligence.posture_record_generated",
    entity_type: "property",
    entity_id: p.propertyId,
    metadata: { record_id: inserted.id, version, hash, content_hash: contentHash, saga_key: p.sagaKey ?? null, ...data.summary },
  });
  return { id: inserted.id as string, version, hash, reused: false, data };
}

/** File the latest record in the Property Records Vault, once. Admin only: it names every member with their IP and device, so co-owners' vault lists leave it out. */
export async function attachPostureToVault(db: Db, p: { propertyId: string }) {
  const { data: recs } = await db.from("acknowledgment_posture_records").select("*").eq("property_id", p.propertyId);
  const rec = ((recs ?? []) as Array<Record<string, any>>).sort((a, b) => b.version - a.version)[0];
  if (!rec) return { attached: false as const, reason: "no_record" as const };
  if (rec.vault_document_id) return { attached: false as const, reason: "already_attached" as const, version: rec.version as number };
  const { data: present } = await db.from("property_records_vault").select("id, content_hash").eq("property_id", p.propertyId).eq("document_type", POSTURE_DOCUMENT_TYPE);
  const same = ((present ?? []) as Array<{ id: string; content_hash: string | null }>).find((x) => x.content_hash === rec.hash);
  if (same) {
    await db.from("acknowledgment_posture_records").update({ vault_document_id: same.id }).eq("id", rec.id);
    return { attached: false as const, reason: "already_attached" as const, version: rec.version as number };
  }
  const base = `closing/${p.propertyId}/${POSTURE_DOCUMENT_TYPE}_v${rec.version}`;
  const pdf = renderPosturePdf(rec.data, rec.version as number, rec.hash as string);
  await db.storage?.from(BUCKET).upload(`${base}.pdf`, new Blob([pdf as BlobPart], { type: "application/pdf" }), { upsert: true, contentType: "application/pdf" });
  await db.storage?.from(BUCKET).upload(`${base}.json`, new Blob([stableStringify(rec.data) + "\n"], { type: "application/json" }), { upsert: true, contentType: "application/json" });
  const { data: genesis } = await db.from("entity_genesis").select("id").eq("property_id", p.propertyId).maybeSingle();
  const { data: row, error } = await db
    .from("property_records_vault")
    .insert({ property_id: p.propertyId, entity_genesis_id: genesis?.id ?? null, document_type: POSTURE_DOCUMENT_TYPE, title: `Final Acknowledgment Posture Record v${rec.version}`, file_url: `${base}.pdf`, content_hash: rec.hash, stored_by: null })
    .select("id")
    .maybeSingle();
  if (error || !row) throw new Error(`The posture record could not be filed in the Records Vault: ${error?.message ?? "no row"}`);
  await db.from("acknowledgment_posture_records").update({ vault_document_id: row.id }).eq("id", rec.id);
  await db.from("audit_log").insert({
    actor_id: null,
    actor_type: "system",
    action_type: "closing_saga.posture_record_attached",
    entity_type: "property",
    entity_id: p.propertyId,
    metadata: { record_id: rec.id, version: rec.version, hash: rec.hash, vault_document_id: row.id },
  });
  return { attached: true as const, version: rec.version as number, hash: rec.hash as string, vaultDocumentId: row.id as string };
}

/** The records for a property, newest first (the Manager). */
export async function postureRecords(db: Db, p: { propertyId: string }) {
  const { data } = await db.from("acknowledgment_posture_records").select("id, version, hash, generated_at, vault_document_id, saga_key, data").eq("property_id", p.propertyId);
  return ((data ?? []) as Array<Record<string, any>>).sort((a, b) => b.version - a.version).map((r) => ({ id: r.id as string, version: r.version as number, hash: r.hash as string, generatedAt: r.generated_at as string, inVault: !!r.vault_document_id, summary: r.data?.summary as Record<string, unknown> }));
}

/** A timestamp as ISO text, or null when the row carries none (never throws on a missing or odd value). */
function isoOrNull(v: unknown): string | null {
  if (v == null) return null;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
