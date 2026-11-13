/** Document access stages on the records: the Pre-Payment Review gate, executed copies pinned to what was signed, and Member Documents. */
import { describe, it, expect, beforeEach } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import { acknowledgePraReview, getMyExecutedCopy, getPraReviewState, keepExecutedText, listMyExecutedDocuments } from "@/lib/document-access.functions";
import { signMemberDocumentFn } from "@/lib/member-steps.functions";
import { createBuyerEnrollmentCheckout } from "@/utils/payments.functions";
import { saveExecutedSnapshot } from "@/lib/document-access.server";
import { PRE_PAYMENT_BLOCKED } from "@/lib/document-access";
import { buildListingAgreement, buildPRA, hashDocument, PRA_VERSION, LISTING_VERSION } from "@/lib/legal-documents";
import { HOLD_HARMLESS_VERSION, holdHarmlessDocumentText } from "@/lib/hold-harmless";

const db = () => harness.db;
const as = (u: string) => (harness.userId = u);
const ALICE = IDS.b1m1;
const BOB = IDS.b1m2;
const buyer = { intent: "personal_use", primary_target_market: "Lusk, WY" };
const praText = (name: string) => buildPRA(name, buyer);

beforeEach(() => {
  seedPod(db());
  for (const m of db().table("account_members")) Object.assign(m, { status: "active", role: m.role === "secondary" ? "member" : m.role });
});

const ack = (memberId: string, o: Partial<{ hash: string; version: string; reachedEnd: boolean }> = {}) =>
  acknowledgePraReview({ data: { actingMemberId: memberId, documentVersion: o.version ?? PRA_VERSION, documentHash: o.hash ?? hashDocument(praText("Alice One")), reachedEnd: o.reachedEnd ?? true } });

describe("Pre-Payment Review: the PRA read to the bottom and acknowledged, per member", () => {
  it("cannot be acknowledged without reaching the bottom, or against a version that is no longer current", async () => {
    as(USERS.b1);
    await expect(ack(ALICE, { reachedEnd: false })).rejects.toThrow(/bottom/);
    await expect(ack(ALICE, { version: "v1" })).rejects.toThrow(/no longer current/);
    expect(db().table("document_review_acknowledgments")).toHaveLength(0);
  });

  it("is stored per account_member_id: one member's acknowledgment does not open payment for the other", async () => {
    as(USERS.b1);
    expect((await getPraReviewState({ data: { actingMemberId: ALICE } })).acknowledged).toBe(false);
    await ack(ALICE);
    expect((await getPraReviewState({ data: { actingMemberId: ALICE } })).acknowledged).toBe(true);
    expect((await getPraReviewState({ data: { actingMemberId: BOB } })).acknowledged).toBe(false);
    const row = db().table("document_review_acknowledgments")[0]!;
    expect(row).toMatchObject({ account_member_id: ALICE, buyer_account_id: IDS.b1, document_type: "PRA", document_version: PRA_VERSION, reached_end: true });
    expect(db().table("audit_log").some((a) => a.action_type === "buyer.pra_review_acknowledged")).toBe(true);
  });

  it("acknowledging twice records it once", async () => {
    as(USERS.b1);
    await ack(ALICE);
    expect((await ack(ALICE)).already).toBe(true);
    expect(db().table("document_review_acknowledgments")).toHaveLength(1);
  });

  it("a member of another account cannot acknowledge for this one", async () => {
    as(USERS.b2);
    await expect(ack(ALICE)).rejects.toThrow(/isn't on your account/);
  });

  it("the server refuses to start the payment until this member has acknowledged", async () => {
    as(USERS.b1);
    const blocked = await createBuyerEnrollmentCheckout({ data: { returnUrl: "http://x", environment: "sandbox", actingMemberId: ALICE } as never });
    expect(blocked).toEqual({ error: PRE_PAYMENT_BLOCKED });
    // No member named at all: also refused.
    expect(await createBuyerEnrollmentCheckout({ data: { returnUrl: "http://x", environment: "sandbox" } as never })).toEqual({ error: PRE_PAYMENT_BLOCKED });
    // Bob acknowledging does not open it for Alice.
    await ack(BOB);
    expect(await createBuyerEnrollmentCheckout({ data: { returnUrl: "http://x", environment: "sandbox", actingMemberId: ALICE } as never })).toEqual({ error: PRE_PAYMENT_BLOCKED });
  });
});

describe("executed documents: pinned to what was signed", () => {
  async function executePra(memberId = ALICE, name = "Alice One") {
    const text = praText(name);
    const hash = hashDocument(text);
    await signMemberDocumentFn({ data: { actingMemberId: memberId, documentType: "PRA", documentVersion: PRA_VERSION, documentHash: hash, typedName: name } });
    return { text, hash };
  }

  it("the hash on the signing screen is the hash stored with the signature, and the executed copy hashes to it", async () => {
    as(USERS.b1);
    const { text, hash } = await executePra();
    expect(db().table("signed_documents").at(-1)!.document_hash).toBe(hash);
    await keepExecutedText({ data: { documentType: "PRA", documentVersion: PRA_VERSION, text } });
    const { documents } = await listMyExecutedDocuments({ data: { role: "buyer" } });
    const pra = documents.find((d) => d.kind === "pra")!;
    expect(pra.hash).toBe(hash);
    const copy = await getMyExecutedCopy({ data: { role: "buyer", id: pra.id } });
    expect(copy.text).toBe(text);
    expect(hashDocument(copy.text)).toBe(hash);
  });

  it("text that is not what was signed is not kept", async () => {
    as(USERS.b1);
    await executePra();
    await expect(keepExecutedText({ data: { documentType: "PRA", documentVersion: PRA_VERSION, text: `${praText("Alice One")}\nA quiet change.` } })).rejects.toThrow(/No executed document of yours matches/);
    expect(db().table("executed_document_texts")).toHaveLength(0);
  });

  it("an executed document never changes after a template revision: the copy is the kept text, whatever the template says now", async () => {
    as(USERS.b1);
    const { text } = await executePra();
    await keepExecutedText({ data: { documentType: "PRA", documentVersion: PRA_VERSION, text } });
    const id = (await listMyExecutedDocuments({ data: { role: "buyer" } })).documents.find((d) => d.kind === "pra")!.id;
    // A revised template: a different text for the same person from now on.
    const revised = `${praText("Alice One")}\n13. A NEW CLAUSE\nAdded in a later revision.`;
    expect(revised).not.toBe(text);
    const copy = await getMyExecutedCopy({ data: { role: "buyer", id } });
    expect(copy.text).toBe(text);
    expect(copy.text).not.toContain("A NEW CLAUSE");
    // The kept text cannot be overwritten, even by the same document hash with different content.
    const wrote = await saveExecutedSnapshot(db() as never, { userId: USERS.b1, documentType: "PRA", documentVersion: PRA_VERSION, text });
    expect(wrote.saved).toBe(false);
    expect(db().table("executed_document_texts")).toHaveLength(1);
    expect(db().table("executed_document_texts")[0]!.body).toBe(text);
  });

  it("with no kept text and no proof the text is identical, no copy is offered rather than a rebuilt one", async () => {
    as(USERS.b1);
    await executePra();
    const pra = (await listMyExecutedDocuments({ data: { role: "buyer" } })).documents.find((d) => d.kind === "pra")!;
    expect(pra.copyAvailable).toBe(false);
    expect(pra.copyNote).toMatch(/rebuilt copy could differ/);
    await expect(getMyExecutedCopy({ data: { role: "buyer", id: pra.id } })).rejects.toThrow(/rebuilt copy could differ/);
  });

  it("a constant text is offered only when it hashes to exactly what was executed", async () => {
    as(USERS.b1);
    const good = hashDocument(`${HOLD_HARMLESS_VERSION}::${holdHarmlessDocumentText}`);
    db().seed("signed_documents", [
      { id: "hh-ok", buyer_account_id: IDS.b1, account_member_id: ALICE, document_type: "HOLD_HARMLESS", document_version: HOLD_HARMLESS_VERSION, signed_name: "Alice One", document_hash: good, created_at: "2026-10-01T00:00:00Z" },
      { id: "hh-old", buyer_account_id: IDS.b1, account_member_id: BOB, document_type: "HOLD_HARMLESS", document_version: "hh-v1", signed_name: "Bob One", document_hash: "djb2_old_0", created_at: "2026-09-01T00:00:00Z" },
    ]);
    const docs = (await listMyExecutedDocuments({ data: { role: "buyer" } })).documents;
    expect(docs.find((d) => d.id === "sd:hh-ok")!.copyAvailable).toBe(true);
    expect(docs.find((d) => d.id === "sd:hh-old")!.copyAvailable).toBe(false);
  });
});

describe("Member Documents", () => {
  it("lists every executed document with its version, date, signers, hash and Audit Vault reference", async () => {
    as(USERS.b1);
    const text = praText("Alice One");
    const hash = hashDocument(text);
    await signMemberDocumentFn({ data: { actingMemberId: ALICE, documentType: "PRA", documentVersion: PRA_VERSION, documentHash: hash, typedName: "Alice One" } });
    const { documents } = await listMyExecutedDocuments({ data: { role: "buyer" } });
    expect(documents).toHaveLength(1);
    const d = documents[0]!;
    expect(d).toMatchObject({ kind: "pra", title: "Priority Reservation Agreement", version: PRA_VERSION, hash });
    expect(d.signers[0]!.name).toBe("Alice One");
    expect(new Date(d.executedAt).getTime()).not.toBeNaN();
    const entry = db().table("audit_log").find((a) => a.action_type === "buyer.pra_signed")!;
    expect(d.auditRef).toMatchObject({ id: entry.id, action: "buyer.pra_signed" });
  });

  it("a member sees their own account's documents only", async () => {
    as(USERS.b1);
    await signMemberDocumentFn({ data: { actingMemberId: ALICE, documentType: "PRA", documentVersion: PRA_VERSION, documentHash: hashDocument(praText("Alice One")), typedName: "Alice One" } });
    as(USERS.b2);
    expect((await listMyExecutedDocuments({ data: { role: "buyer" } })).documents).toHaveLength(0);
    const id = db().table("signed_documents")[0]!.id;
    await expect(getMyExecutedCopy({ data: { role: "buyer", id: `sd:${id}` } })).rejects.toThrow(/not found/i);
  });

  it("an owner keeps access to every executed document whatever the account's status (Rev 48 floor)", async () => {
    as(USERS.b1);
    const text = praText("Alice One");
    await signMemberDocumentFn({ data: { actingMemberId: ALICE, documentType: "PRA", documentVersion: PRA_VERSION, documentHash: hashDocument(text), typedName: "Alice One" } });
    await keepExecutedText({ data: { documentType: "PRA", documentVersion: PRA_VERSION, text } });
    Object.assign(db().table("buyer_accounts").find((a) => a.id === IDS.b1)!, { onboarding_status: "held", held: true, status: "suspended", golden_ticket_issued: false });
    db().seed("cap_table_entries", [{ property_id: IDS.property, share_number: 1, holder_type: "buyer_account", buyer_account_id: IDS.b1 }]);
    db().seed("entity_genesis", [{ id: "g1", property_id: IDS.property, llc_name: "Lusk LLC", final_oa_status: "executed", final_oa_text: "OA TEXT", final_oa_hash: "oa-hash", oa_executed_at: "2026-11-01T00:00:00Z" }]);
    const { documents } = await listMyExecutedDocuments({ data: { role: "buyer" } });
    expect(documents.map((d) => d.kind).sort()).toEqual(["pra"]);
    expect(documents[0]!.copyAvailable).toBe(true);
  });

  it("an executed Operating Agreement is listed with its signers, and its text is kept the moment it is listed", async () => {
    as(USERS.b1);
    const oaText = "OPERATING AGREEMENT\n1. PURPOSE\nHold the property.";
    const { sha256 } = await import("@/lib/entity-genesis-stage2.server");
    const oaHash = sha256(oaText);
    db().seed("cap_table_entries", [{ property_id: IDS.property, share_number: 1, holder_type: "buyer_account", buyer_account_id: IDS.b1 }]);
    db().seed("entity_genesis", [{ id: "g1", property_id: IDS.property, llc_name: "Lusk LLC", final_oa_status: "executed", final_oa_text: oaText, final_oa_hash: oaHash, oa_executed_at: "2026-11-01T00:00:00Z" }]);
    db().seed("operating_agreement_signatures", [
      { entity_genesis_id: "g1", account_member_id: ALICE, signed_name: "Alice One", document_hash: oaHash, signed_at: "2026-10-30T00:00:00Z" },
      { entity_genesis_id: "g1", account_member_id: BOB, signed_name: "Bob One", document_hash: oaHash, signed_at: "2026-10-31T00:00:00Z" },
    ]);
    db().seed("audit_log", [{ id: "audit-oa", action_type: "entity.oa_signed", entity_id: IDS.property, created_at: "2026-10-30T00:00:00Z", metadata: { document_hash: oaHash, account_member_id: ALICE } }]);
    const oa = (await listMyExecutedDocuments({ data: { role: "buyer" } })).documents.find((d) => d.kind === "operating_agreement")!;
    expect(oa.signers.map((s) => s.name)).toEqual(["Alice One", "Bob One"]);
    expect(oa.hash).toBe(oaHash);
    expect(oa.auditRef?.id).toBe("audit-oa");
    // A later regeneration cannot change the copy: it comes from the kept text.
    db().table("entity_genesis")[0]!.final_oa_text = "A DIFFERENT TEXT";
    expect((await getMyExecutedCopy({ data: { role: "buyer", id: oa.id } })).text).toBe(oaText);
  });

  it("a seller sees the Listing Agreement they signed, with its kept text", async () => {
    as("u-seller");
    const text = buildListingAgreement({ full_name: "Sam Seller", exit_type: "full_exit", retained_shares: 0 }, null);
    const hash = hashDocument(text);
    db().seed("signed_documents", [{ id: "la-1", seller_id: "u-seller", document_type: "listing_agreement", document_version: LISTING_VERSION, signed_name: "Sam Seller", document_hash: hash, created_at: "2026-10-01T00:00:00Z" }]);
    await keepExecutedText({ data: { documentType: "listing_agreement", documentVersion: LISTING_VERSION, text } });
    const d = (await listMyExecutedDocuments({ data: { role: "seller" } })).documents[0]!;
    expect(d).toMatchObject({ kind: "listing_agreement", version: LISTING_VERSION, hash });
    expect((await getMyExecutedCopy({ data: { role: "seller", id: d.id } })).text).toBe(text);
    // Another user's seller documents are not visible.
    as(USERS.b1);
    expect((await listMyExecutedDocuments({ data: { role: "seller" } })).documents).toHaveLength(0);
  });

  it("a professional sees the executed NAR Referral Agreement, its signers, and its own stored body as the copy", async () => {
    as(USERS.ra);
    const body = "STANDARD NAR REFERRAL AGREEMENT\n1. PARTIES\nTwo agents.";
    const hash = hashDocument(`v1::${body}`);
    db().seed("signed_documents", [
      {
        id: "nar-1",
        document_type: "nar_referral_agreement",
        document_version: "v1",
        document_body: body,
        document_hash: hash,
        status: "executed",
        executed_at: "2026-10-05T00:00:00Z",
        created_at: "2026-10-01T00:00:00Z",
        buyer_account_id: IDS.b1,
        requires_signatures_from: [IDS.ra, IDS.ra2],
        signed_by: [
          { agent_id: IDS.ra, signed_name: "Rita Resident", signed_at: "2026-10-02T00:00:00Z" },
          { agent_id: IDS.ra2, signed_name: "Rory Resident", signed_at: "2026-10-05T00:00:00Z" },
        ],
      },
    ]);
    db().seed("audit_log", [{ id: "audit-nar", action_type: "agent.nar_referral_signed", entity_id: "nar-1", created_at: "2026-10-05T00:00:00Z", metadata: {} }]);
    const d = (await listMyExecutedDocuments({ data: { role: "professional" } })).documents[0]!;
    expect(d).toMatchObject({ kind: "nar_referral", version: "v1", hash });
    expect(d.signers.map((s) => s.name)).toEqual(["Rita Resident", "Rory Resident"]);
    expect(d.auditRef?.id).toBe("audit-nar");
    expect((await getMyExecutedCopy({ data: { role: "professional", id: d.id } })).text).toBe(body);
    // Not executed yet: not listed. And the buyer never sees the agents' agreement.
    as(USERS.b1);
    expect((await listMyExecutedDocuments({ data: { role: "buyer" } })).documents).toHaveLength(0);
  });

  it("downloading an executed copy is itself recorded", async () => {
    as(USERS.b1);
    const text = praText("Alice One");
    await signMemberDocumentFn({ data: { actingMemberId: ALICE, documentType: "PRA", documentVersion: PRA_VERSION, documentHash: hashDocument(text), typedName: "Alice One" } });
    await keepExecutedText({ data: { documentType: "PRA", documentVersion: PRA_VERSION, text } });
    const id = (await listMyExecutedDocuments({ data: { role: "buyer" } })).documents[0]!.id;
    await getMyExecutedCopy({ data: { role: "buyer", id } });
    expect(db().table("audit_log").some((a) => a.action_type === "document.executed_copy_downloaded")).toBe(true);
  });
});
