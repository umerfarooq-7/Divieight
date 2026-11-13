/**
 * Document access (server side): the Pre-Payment Review acknowledgment, the executed-copy snapshots, and Member Documents.
 *
 * Rules this file enforces:
 *   - Payment is open only to a member who has read the PRA to the end and acknowledged it (per account_member_id, per PRA version).
 *   - An executed document is never rebuilt from a template. Its text comes from the immutable snapshot taken at execution, or from text that is
 *     proven identical to what was signed by its hash. If neither exists the row says so rather than offering a different document.
 *   - Everything is read through the signed-in person's own records, and no account standing, payment, vote or lock can hide an executed document
 *     from its owner (Rev 48 floor).
 */
import { requireActingMember, type RequestContext } from "@/lib/account-members.server";
import { sha256 } from "@/lib/entity-genesis-stage2.server";
import { hashDocument, PRA_VERSION } from "@/lib/legal-documents";
import { PRE_PAYMENT_BLOCKED, TITLES, type DocKind, type ExecutedDoc, type ExecutedCopy } from "@/lib/document-access";

type Db = { from: (t: string) => any };
const MISSING_SCHEMA = "Database is missing the document access tables: run document-access.sql in Supabase.";

// ---------------------------------------------------------------------------------------------------------
// Pre-Payment Review: the PRA read to the end, acknowledged by this member
// ---------------------------------------------------------------------------------------------------------
export async function recordPraReviewAck(db: Db, p: { userId: string; actingMemberId: string; documentVersion: string; documentHash: string; reachedEnd: boolean; request: RequestContext }) {
  if (!p.reachedEnd) throw new Error("Read the whole agreement to the bottom before acknowledging it.");
  if (p.documentVersion !== PRA_VERSION) throw new Error("This version of the Priority Reservation Agreement is no longer current: reload the page.");
  if (!p.documentHash || p.documentHash.length > 200) throw new Error("Missing document hash");
  const { account, member } = await requireActingMember(db, p.userId, p.actingMemberId);
  const { data: existing, error: readError } = await db.from("document_review_acknowledgments").select("id, acknowledged_at, document_hash").eq("account_member_id", member.id).eq("document_type", "PRA").eq("document_version", p.documentVersion).maybeSingle();
  if (readError) throw new Error(MISSING_SCHEMA);
  if (existing) return { acknowledgedAt: (existing as { acknowledged_at: string }).acknowledged_at, already: true };
  const acknowledgedAt = new Date().toISOString();
  const { error } = await db.from("document_review_acknowledgments").insert({
    account_member_id: member.id,
    buyer_account_id: account.id,
    document_type: "PRA",
    document_version: p.documentVersion,
    document_hash: p.documentHash,
    reached_end: true,
    acknowledged_at: acknowledgedAt,
    ip_address: p.request.ip,
    user_agent: p.request.userAgent,
  });
  if (error && error.code !== "23505") throw new Error(MISSING_SCHEMA);
  await db.from("audit_log").insert({
    actor_id: p.userId,
    actor_type: "buyer",
    action_type: "buyer.pra_review_acknowledged",
    entity_type: "buyer_account",
    entity_id: account.id,
    metadata: { account_member_id: member.id, document_type: "PRA", document_version: p.documentVersion, document_hash: p.documentHash, ip_address: p.request.ip, user_agent: p.request.userAgent },
  });
  return { acknowledgedAt, already: false };
}

export async function praReviewState(db: Db, p: { userId: string; actingMemberId: string }) {
  const { account, member } = await requireActingMember(db, p.userId, p.actingMemberId);
  const { data } = await db.from("document_review_acknowledgments").select("acknowledged_at").eq("account_member_id", member.id).eq("document_type", "PRA").eq("document_version", PRA_VERSION).maybeSingle();
  const at = (data as { acknowledged_at: string } | null)?.acknowledged_at ?? null;
  return { acknowledged: !!at, acknowledgedAt: at, accountId: account.id, memberName: member.full_name ?? "", version: PRA_VERSION };
}

/** The server's own check at the moment the payment is started. */
export async function assertPrePaymentReview(db: Db, p: { userId: string; actingMemberId: string | null | undefined }) {
  if (!p.actingMemberId) throw new Error(PRE_PAYMENT_BLOCKED);
  const state = await praReviewState(db, { userId: p.userId, actingMemberId: p.actingMemberId });
  if (!state.acknowledged) throw new Error(PRE_PAYMENT_BLOCKED);
  return state;
}

// ---------------------------------------------------------------------------------------------------------
// Executed copies
// ---------------------------------------------------------------------------------------------------------
async function snapshotFor(db: Db, hash: string, type: string): Promise<{ body: string; document_version: string } | null> {
  const { data } = await db.from("executed_document_texts").select("body, document_version").eq("document_hash", hash).eq("document_type", type).maybeSingle();
  return (data as { body: string; document_version: string } | null) ?? null;
}

async function writeSnapshot(db: Db, p: { hash: string; type: string; version: string; body: string; userId: string | null }) {
  if (await snapshotFor(db, p.hash, p.type)) return false;
  const { error } = await db.from("executed_document_texts").insert({ document_hash: p.hash, document_type: p.type, document_version: p.version, body: p.body, body_sha256: sha256(p.body), created_by: p.userId });
  if (error && error.code !== "23505") throw new Error(MISSING_SCHEMA);
  return !error;
}

/**
 * Keep the exact text just executed. The text is accepted only if it hashes to the hash the signature carries, and only for a document the caller signed:
 * what is stored is what was signed, never a later rebuild.
 */
export async function saveExecutedSnapshot(db: Db, p: { userId: string; documentType: "PRA" | "listing_agreement"; documentVersion: string; text: string }) {
  if (!p.text || p.text.length > 200_000) throw new Error("Missing document text");
  const hash = hashDocument(p.text);
  let found = false;
  if (p.documentType === "PRA") {
    const { data: acct } = await db.from("buyer_accounts").select("id").eq("auth_user_id", p.userId).maybeSingle();
    if (acct) {
      const { data } = await db.from("signed_documents").select("id").eq("buyer_account_id", (acct as { id: string }).id).eq("document_type", "PRA").eq("document_hash", hash).limit(1);
      found = ((data ?? []) as unknown[]).length > 0;
    }
  } else {
    const { data } = await db.from("signed_documents").select("id").eq("seller_id", p.userId).eq("document_type", "listing_agreement").eq("document_hash", hash).limit(1);
    found = ((data ?? []) as unknown[]).length > 0;
  }
  if (!found) throw new Error("No executed document of yours matches this text.");
  const saved = await writeSnapshot(db, { hash, type: p.documentType, version: p.documentVersion, body: p.text, userId: p.userId });
  return { hash, saved };
}

// ---------------------------------------------------------------------------------------------------------
// Member Documents
// ---------------------------------------------------------------------------------------------------------
type SignedRow = {
  id: string;
  document_type: string;
  document_version: string | null;
  document_hash: string | null;
  signed_name: string | null;
  created_at: string;
  executed_at?: string | null;
  status?: string | null;
  account_member_id?: string | null;
  acted_by_member_id?: string | null;
  on_behalf_of_member_id?: string | null;
  authority_grant_id?: string | null;
  document_body?: string | null;
  signed_by?: Array<{ agent_id: string; signed_name: string; signed_at: string }> | null;
  requires_signatures_from?: string[] | null;
  buyer_account_id?: string | null;
};

const BLOCK5_TYPE = "block_5_independent_advice";
const KIND_OF: Record<string, DocKind> = {
  PRA: "pra",
  HOLD_HARMLESS: "hold_harmless",
  listing_agreement: "listing_agreement",
  nar_referral_agreement: "nar_referral",
};

async function constantTexts(): Promise<Array<{ kind: DocKind; type: string; version: string; text: string; hash: string }>> {
  const hh = await import("@/lib/hold-harmless");
  const out = [{ kind: "hold_harmless" as DocKind, type: "HOLD_HARMLESS", version: hh.HOLD_HARMLESS_VERSION, text: hh.holdHarmlessDocumentText, hash: hashDocument(`${hh.HOLD_HARMLESS_VERSION}::${hh.holdHarmlessDocumentText}`) }];
  try {
    const b5 = await import("@/components/Block5AdviceNotice");
    out.push({ kind: "block5" as DocKind, type: b5.BLOCK_5_DOCUMENT_TYPE, version: b5.BLOCK_5_VERSION, text: b5.BLOCK_5_TEXT, hash: b5.BLOCK_5_HASH });
  } catch {
    /* the advice acknowledgment is listed without a copy */
  }
  return out;
}

/** Which audit entry records this execution: matched on the document hash (and the signer where the entry names one). Newest first is not assumed: the earliest is the signing. */
async function auditRefFor(db: Db, p: { entityIds: string[]; hash: string; memberId?: string | null }) {
  for (const id of p.entityIds) {
    const { data } = await db.from("audit_log").select("id, action_type, created_at, metadata").eq("entity_id", id);
    const rows = ((data ?? []) as Array<{ id: string; action_type: string; created_at: string; metadata: Record<string, any> | null }>)
      .filter((r) => r.metadata?.document_hash === p.hash && !/review_acknowledged/.test(r.action_type) && (!p.memberId || !r.metadata?.account_member_id || r.metadata.account_member_id === p.memberId))
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    if (rows[0]) return { id: rows[0].id, action: rows[0].action_type, at: rows[0].created_at };
  }
  return null;
}

/** The text of an executed document, or null when none can be proven identical to what was signed. */
async function executedText(db: Db, row: { type: string; hash: string | null; body?: string | null; version: string | null; oaText?: string | null }): Promise<string | null> {
  if (!row.hash) return null;
  const snap = await snapshotFor(db, row.hash, row.type);
  if (snap) return snap.body;
  // Text stored with the signed row itself (the NAR Referral Agreement keeps its body there).
  if (row.body && (hashDocument(`${row.version}::${row.body}`) === row.hash || sha256(row.body) === row.hash)) return row.body;
  if (row.oaText && sha256(row.oaText) === row.hash) return row.oaText;
  // Texts that are constants: used only when they hash to exactly what was executed.
  for (const c of await constantTexts()) if (c.type === row.type && c.hash === row.hash) return c.text;
  return null;
}

const NO_COPY = "No copy of the exact text is on file for this document, so none is offered: a rebuilt copy could differ from what was signed. The hash and Audit Vault reference above identify it.";

async function buyerRows(db: Db, userId: string): Promise<ExecutedDoc[]> {
  const { data: acct } = await db.from("buyer_accounts").select("id").eq("auth_user_id", userId).maybeSingle();
  if (!acct) return [];
  const accountId = (acct as { id: string }).id;
  const { data: people } = await db.from("account_members").select("id, full_name").eq("buyer_account_id", accountId);
  const names = new Map(((people ?? []) as Array<{ id: string; full_name: string | null }>).map((m) => [m.id, m.full_name ?? "Account Member"]));
  const { data } = await db.from("signed_documents").select("*").eq("buyer_account_id", accountId);
  const out: ExecutedDoc[] = [];
  for (const r of ((data ?? []) as SignedRow[]).filter((x) => x.document_type !== "nar_referral_agreement")) {
    const kind: DocKind = KIND_OF[r.document_type] ?? (r.document_type === BLOCK5_TYPE ? "block5" : "other");
    const text = await executedText(db, { type: r.document_type, hash: r.document_hash, version: r.document_version });
    const signer = r.signed_name ?? "";
    const onBehalf = r.on_behalf_of_member_id ? `on behalf of ${names.get(r.on_behalf_of_member_id) ?? "a member"} under documented authority` : null;
    out.push({
      id: `sd:${r.id}`,
      kind,
      title: kind === "other" ? r.document_type : TITLES[kind],
      version: r.document_version ?? "",
      executedAt: r.created_at,
      signers: [{ name: signer || (r.account_member_id ? names.get(r.account_member_id) ?? "" : ""), at: r.created_at, note: onBehalf }],
      hash: r.document_hash,
      auditRef: r.document_hash ? await auditRefFor(db, { entityIds: [accountId], hash: r.document_hash, memberId: r.account_member_id ?? null }) : null,
      copyAvailable: text != null,
      copyNote: text == null ? NO_COPY : null,
    });
  }
  // Operating Agreements: one per property whose LLC's agreement is executed, signed by this account's members.
  const { data: cap } = await db.from("cap_table_entries").select("property_id").eq("buyer_account_id", accountId);
  for (const pid of [...new Set(((cap ?? []) as Array<{ property_id: string }>).map((c) => c.property_id))]) {
    const { data: g } = await db.from("entity_genesis").select("*").eq("property_id", pid).maybeSingle();
    if (!g || g.final_oa_status !== "executed" || !g.final_oa_hash) continue;
    const { data: sigs } = await db.from("operating_agreement_signatures").select("account_member_id, signed_name, signed_at, on_behalf_of_member_id").eq("entity_genesis_id", g.id).eq("document_hash", g.final_oa_hash);
    const mine = ((sigs ?? []) as Array<{ account_member_id: string; signed_name: string | null; signed_at: string; on_behalf_of_member_id: string | null }>).filter((s) => names.has(s.account_member_id));
    if (mine.length === 0) continue;
    // The executed text is fixed from here on (an executed Operating Agreement is never regenerated): keep its snapshot.
    if (g.final_oa_text && sha256(g.final_oa_text) === g.final_oa_hash) await writeSnapshot(db, { hash: g.final_oa_hash, type: "operating_agreement", version: `OA ${g.final_oa_hash.slice(0, 12)}`, body: g.final_oa_text, userId: null });
    const text = await executedText(db, { type: "operating_agreement", hash: g.final_oa_hash, version: null, oaText: g.final_oa_text });
    out.push({
      id: `oa:${pid}`,
      kind: "operating_agreement",
      title: `${TITLES.operating_agreement} (${g.llc_name ?? "Property LLC"})`,
      version: `Executed text ${String(g.final_oa_hash).slice(0, 12)}`,
      executedAt: g.oa_executed_at ?? mine.map((s) => s.signed_at).sort().at(-1) ?? "",
      signers: mine.map((s) => ({ name: s.signed_name ?? names.get(s.account_member_id) ?? "", at: s.signed_at, note: s.on_behalf_of_member_id ? "signed under documented authority" : null })),
      hash: g.final_oa_hash,
      auditRef: await auditRefFor(db, { entityIds: [pid], hash: g.final_oa_hash, memberId: mine[0]!.account_member_id }),
      copyAvailable: text != null,
      copyNote: text == null ? NO_COPY : null,
    });
  }
  return out;
}

async function sellerRows(db: Db, userId: string): Promise<ExecutedDoc[]> {
  const { data } = await db.from("signed_documents").select("*").eq("seller_id", userId);
  const out: ExecutedDoc[] = [];
  for (const r of (data ?? []) as Array<SignedRow & { property_id?: string | null }>) {
    const kind: DocKind = KIND_OF[r.document_type] ?? "listing_agreement";
    const text = await executedText(db, { type: r.document_type, hash: r.document_hash, version: r.document_version });
    out.push({
      id: `sd:${r.id}`,
      kind,
      title: TITLES[kind],
      version: r.document_version ?? "",
      executedAt: r.created_at,
      signers: [{ name: r.signed_name ?? "", at: r.created_at, note: null }],
      hash: r.document_hash,
      auditRef: r.document_hash ? await auditRefFor(db, { entityIds: [r.property_id ?? "", userId].filter(Boolean) as string[], hash: r.document_hash }) : null,
      copyAvailable: text != null,
      copyNote: text == null ? NO_COPY : null,
    });
  }
  return out;
}

async function professionalRows(db: Db, userId: string): Promise<ExecutedDoc[]> {
  const { data: agent } = await db.from("agents").select("id, full_name").eq("auth_user_id", userId).maybeSingle();
  if (!agent) return [];
  const agentId = (agent as { id: string }).id;
  const { data } = await db.from("signed_documents").select("*").eq("document_type", "nar_referral_agreement");
  const out: ExecutedDoc[] = [];
  for (const r of ((data ?? []) as SignedRow[]).filter((x) => (x.requires_signatures_from ?? []).includes(agentId) && x.status === "executed")) {
    const text = await executedText(db, { type: r.document_type, hash: r.document_hash, version: r.document_version, body: r.document_body });
    const { data: names } = await db.from("agents").select("id, full_name").in("id", r.requires_signatures_from ?? []);
    const nameOf = new Map(((names ?? []) as Array<{ id: string; full_name: string | null }>).map((a) => [a.id, a.full_name ?? ""]));
    out.push({
      id: `sd:${r.id}`,
      kind: "nar_referral",
      title: TITLES.nar_referral,
      version: r.document_version ?? "",
      executedAt: r.executed_at ?? r.created_at,
      signers: (r.signed_by ?? []).map((s) => ({ name: s.signed_name || nameOf.get(s.agent_id) || "", at: s.signed_at, note: null })),
      hash: r.document_hash,
      auditRef: await auditRefFor(db, { entityIds: [r.id], hash: r.document_hash ?? "" }) ?? (await anyAudit(db, r.id)),
      copyAvailable: text != null,
      copyNote: text == null ? NO_COPY : null,
    });
  }
  return out;
}

/** The NAR agreement's audit entries name the document by entity id rather than by hash: the first signing entry. */
async function anyAudit(db: Db, entityId: string) {
  const { data } = await db.from("audit_log").select("id, action_type, created_at").eq("entity_id", entityId);
  const rows = ((data ?? []) as Array<{ id: string; action_type: string; created_at: string }>).filter((r) => /nar_referral_signed/.test(r.action_type)).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return rows.length ? { id: rows.at(-1)!.id, action: rows.at(-1)!.action_type, at: rows.at(-1)!.created_at } : null;
}

export type DocumentsRole = "buyer" | "seller" | "professional";

/** Every executed document for this person, newest first. Not gated on payment, standing, votes or any lock (Rev 48 floor). */
export async function listExecutedDocuments(db: Db, p: { userId: string; role: DocumentsRole }): Promise<ExecutedDoc[]> {
  const rows = p.role === "buyer" ? await buyerRows(db, p.userId) : p.role === "seller" ? await sellerRows(db, p.userId) : await professionalRows(db, p.userId);
  return rows.sort((a, b) => String(b.executedAt).localeCompare(String(a.executedAt)));
}

/** The executed copy for one listed document, only if it belongs to this person. */
export async function executedCopy(db: Db, p: { userId: string; role: DocumentsRole; id: string }): Promise<ExecutedCopy> {
  const docs = await listExecutedDocuments(db, { userId: p.userId, role: p.role });
  const doc = docs.find((d) => d.id === p.id);
  if (!doc) throw new Error("Document not found.");
  if (!doc.copyAvailable || !doc.hash) throw new Error(doc.copyNote ?? NO_COPY);
  const type = doc.kind === "pra" ? "PRA" : doc.kind === "hold_harmless" ? "HOLD_HARMLESS" : doc.kind === "listing_agreement" ? "listing_agreement" : doc.kind === "nar_referral" ? "nar_referral_agreement" : doc.kind === "operating_agreement" ? "operating_agreement" : null;
  let text: string | null = null;
  if (type) {
    text = await executedText(db, { type, hash: doc.hash, version: doc.version, body: null });
    if (!text && type === "nar_referral_agreement") {
      const { data } = await db.from("signed_documents").select("document_body, document_version, document_hash").eq("id", p.id.replace(/^sd:/, "")).maybeSingle();
      const r = data as { document_body: string | null; document_version: string | null; document_hash: string | null } | null;
      if (r?.document_body) text = await executedText(db, { type, hash: r.document_hash, body: r.document_body, version: r.document_version });
    }
  }
  if (!text) {
    // The advice acknowledgment's own text, only if it hashes to what was executed.
    for (const c of await constantTexts()) if (c.hash === doc.hash) text = c.text;
  }
  if (!text) throw new Error(NO_COPY);
  return { doc, text, textSha256: sha256(text) };
}
