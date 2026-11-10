/** Stronger signatures (server-side name checks, full signing records) and documented authority. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { harness } from "./setup";
import { seedPod, IDS, USERS, acceptBlock2ForAll } from "./fixtures";

// Record every email the platform would send, instead of sending it.
const sent: Array<{ email: string | null; subject: string; message: string }> = [];
vi.mock("@/lib/authorization.notify.server", async (original) => {
  const real = (await original()) as Record<string, unknown>;
  return {
    ...real,
    deliver: vi.fn(async (_db: unknown, recipient: { email?: string | null }, args: { subject: string; message: string }) => {
      sent.push({ email: recipient.email ?? null, subject: args.subject, message: args.message });
      return { portal: false, emailed: Boolean(recipient.email) };
    }),
  };
});

import { createAuthorizationRequest, respondToAuthorization } from "@/lib/authorization.functions";
import { acknowledgeAsMember, placeDiligenceDocument } from "@/lib/due-diligence.functions";
import { runStage2Action, signMyOperatingAgreement } from "@/lib/entity-genesis-stage2.functions";
import { ensureDigitalGenesis } from "@/lib/entity-genesis.server";
import { getMyAuthority, grantAuthorityFn, revokeAuthorityFn } from "@/lib/member-authority.functions";
import { signMemberDocumentFn, submitW9Fn, acceptAuthorizationFn } from "@/lib/member-steps.functions";
import { submitEligibilityDeclaration } from "@/lib/eligibility-declaration.functions";
import { saveMemberIdentityFn } from "@/lib/account-members.functions";
import { submitLivenessSelfie } from "@/lib/liveness.functions";
import { AUTHORITY_SCOPES, NEVER_DELEGATED, authorityGrantText } from "@/lib/member-authority";
import { assertTypedSignature } from "@/lib/signature-check";
import { sha256 } from "@/lib/entity-genesis-stage2.server";

const db = () => harness.db;
const as = (user: string) => (harness.userId = user);
const ALICE = IDS.b1m1;
const BOB = IDS.b1m2;
const grants = () => db().table("member_authority_grants");
const member = (id: string) => db().table("account_members").find((m) => m.id === id)!;

beforeEach(() => {
  sent.length = 0;
  seedPod(db());
  for (const m of db().table("account_members")) Object.assign(m, { status: "active", role: m.role === "secondary" ? "member" : m.role });
  member(ALICE).email = "alice@test.local";
  member(BOB).email = "bob@test.local";
});

/** Bob (the grantor) signs authority for Alice (the grantee), as himself. */
const grant = (scope: string[], o: { grantor?: string; grantee?: string; typedName?: string } = {}) => {
  as(USERS.b1);
  const grantor = o.grantor ?? BOB;
  return grantAuthorityFn({ data: { actingMemberId: grantor, granteeMemberId: o.grantee ?? ALICE, scope, typedName: o.typedName ?? (member(grantor).full_name as string) } });
};
const revoke = (grantId: string, acting = BOB) => (as(USERS.b1), revokeAuthorityFn({ data: { actingMemberId: acting, grantId } }));

// ---------------------------------------------------------------------------
// 1. The server checks the typed name
// ---------------------------------------------------------------------------

describe("the typed signature is verified on the server", () => {
  it("the shared check: full name normalised, or initials for a typed-initials verification", () => {
    const ok = (typed: string, method?: string) => expect(() => assertTypedSignature({ typed, fullName: "Alice One", method })).not.toThrow();
    const no = (typed: string, method?: string) => expect(() => assertTypedSignature({ typed, fullName: "Alice One", method })).toThrow();
    ok("Alice One");
    ok("  alice   ONE ");
    ok("AO", "typed_initials");
    ok("a o", "typed_initials");
    no("AO");
    no("Bob One");
    no("Alice");
    no("X", "typed_initials");
    no("");
    expect(() => assertTypedSignature({ typed: "Alice One", fullName: null })).toThrow();
    expect(() => assertTypedSignature({ typed: "Alice One", fullName: "Alice One", method: "typed_initials", typedInitials: "BO" })).toThrow("initials");
    expect(() => assertTypedSignature({ typed: "Alice One", fullName: "Alice One", method: "typed_initials", typedInitials: "ao" })).not.toThrow();
  });

  it("authorizations: a wrong typed name is rejected, and the right one is recorded with a full signing record", async () => {
    as(USERS.admin);
    const { id } = await createAuthorizationRequest({ data: { propertyId: IDS.property, buyerAccountId: IDS.b1, actionType: "offer_tender", headline: "Offer", terms: { Price: "$1" } } });
    as(USERS.b1);
    const base = { requestId: id, accountMemberId: ALICE, decision: "confirmed" as const, secondaryVerificationMethod: "typed_initials" };
    for (const wrong of ["Bob One", "X", "Alicia One", "  "]) await expect(respondToAuthorization({ data: { ...base, signedName: wrong } })).rejects.toThrow();
    expect(db().table("authorization_responses")).toEqual([]);
    await respondToAuthorization({ data: { ...base, signedName: "alice  one" } });
    const row = db().table("authorization_responses")[0]!;
    expect(row).toMatchObject({ account_member_id: ALICE, acted_by_member_id: ALICE, signed_name: "alice  one", ip_address: harness.ip, on_behalf_of_member_id: null, authority_grant_id: null });
    expect(row.document_hash).toMatch(/^sha256_[0-9a-f]{64}$/);
    expect(row.responded_at).toBeTruthy();
    expect("user_agent" in row).toBe(true);
  });

  it("due diligence: a wrong typed name is rejected, and the right one is recorded with a full signing record", async () => {
    as(USERS.admin);
    const doc = await placeDiligenceDocument({ data: { propertyId: IDS.property, documentTitle: "Inspection", category: "inspection", fileUrl: "dd/i.pdf", contentHash: "h-i" } });
    const hash = db().table("due_diligence_inventory").find((d) => d.id === doc.id)!.content_hash;
    as(USERS.b1);
    for (const wrong of ["Bob One", "X", "", "Alicia One"]) {
      const r = await acknowledgeAsMember({ data: { documentId: doc.id!, contentHash: hash, accountMemberId: ALICE, signedName: wrong } });
      expect(r.ok).toBe(false);
    }
    expect(db().table("due_diligence_acknowledgments").filter((a) => a.actor_role === "account_member")).toEqual([]);
    expect(await acknowledgeAsMember({ data: { documentId: doc.id!, contentHash: hash, accountMemberId: ALICE, signedName: "Alice One" } })).toEqual({ ok: true });
    const row = db().table("due_diligence_acknowledgments").find((a) => a.actor_role === "account_member")!;
    expect(row).toMatchObject({ account_member_id: ALICE, acted_by_member_id: ALICE, signed_name: "Alice One", content_hash: hash, ip_address: harness.ip, on_behalf_of_member_id: null, authority_grant_id: null });
    expect("user_agent" in row).toBe(true);
  });

  it("the PRA and the Hold Harmless: a wrong typed name is rejected; the record carries the member, name, time, IP, browser and hash", async () => {
    as(USERS.b1);
    for (const documentType of ["PRA", "HOLD_HARMLESS"] as const) {
      await expect(signMemberDocumentFn({ data: { actingMemberId: ALICE, documentType, documentVersion: "v1", documentHash: "djb2_x", typedName: "Bob One" } })).rejects.toThrow("The signature must be");
      await signMemberDocumentFn({ data: { actingMemberId: ALICE, documentType, documentVersion: "v1", documentHash: "djb2_x", typedName: "alice one" } });
    }
    const rows = db().table("signed_documents");
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ account_member_id: ALICE, acted_by_member_id: ALICE, signed_name: "alice one", document_hash: "djb2_x", ip_address: harness.ip, authority_grant_id: null });
    expect(rows.every((r) => r.created_at)).toBe(true);
    expect(rows.every((r) => "user_agent" in r)).toBe(true);
  });

  async function openOa() {
    Object.assign(db().table("properties")[0], { exit_type: "hybrid_exit", retained_shares: 5, listing_status: "system_lock" });
    acceptBlock2ForAll(db());
    await ensureDigitalGenesis(db(), { propertyId: IDS.property, actorId: USERS.b1, reason: "hard_lock" });
    as(USERS.admin);
    const act = (action: unknown) => runStage2Action({ data: { propertyId: IDS.property, action: action as never } });
    await act({ kind: "closing_ready" });
    await act({ kind: "atlas_request", reference: "A" });
    await act({ kind: "state_filed" });
    await act({ kind: "state_confirmed", llcName: "D8 Test, LLC", delawareFileNumber: "1", certificateFileUrl: "e/c.pdf", certificateHash: "djb2_c" });
    await act({ kind: "final_oa" });
    return db().table("entity_genesis")[0]!.final_oa_hash as string;
  }
  const signOa = (acting: string, name: string, hash: string, onBehalfOfMemberId?: string) => {
    as(USERS.b1);
    return signMyOperatingAgreement({ data: { propertyId: IDS.property, accountMemberId: acting, signedName: name, documentHash: hash, secondaryVerificationMethod: "typed_initials", onBehalfOfMemberId } });
  };

  it("the Operating Agreement: a wrong name (and spacing-only differences are fine) is checked on the server; the record carries who signed and the document hash", async () => {
    const hash = await openOa();
    await expect(signOa(ALICE, "Alicia One", hash)).rejects.toThrow("exactly: Alice One");
    await expect(signOa(ALICE, "Bob One", hash)).rejects.toThrow("exactly: Alice One");
    await signOa(ALICE, "ALICE   one", hash);
    const row = db().table("operating_agreement_signatures")[0]!;
    expect(row).toMatchObject({ account_member_id: ALICE, acted_by_member_id: ALICE, document_hash: hash, ip_address: harness.ip, on_behalf_of_member_id: null, authority_grant_id: null });
    expect(row.signed_at).toBeTruthy();
    expect("user_agent" in row).toBe(true);
  });

  it("the old browser-only checks are gone: no path accepts a name without comparing it to the member's own", () => {
    for (const f of ["src/lib/authorization.functions.ts", "src/lib/due-diligence.functions.ts"]) expect(readFileSync(f, "utf8")).toContain("assertTypedSignature(");
    expect(readFileSync("src/lib/entity-genesis-stage2.server.ts", "utf8")).toContain("legalNamesMatch(input.signedName, actor.name)");
    expect(readFileSync("src/lib/member-steps.server.ts", "utf8")).toContain("legalNamesMatch(typed, member.full_name");
  });
});

// ---------------------------------------------------------------------------
// 3. Grants
// ---------------------------------------------------------------------------

describe("granting authority", () => {
  it("the grantor signs as themselves: the typed name must be their own, and everything is recorded", async () => {
    await expect(grant(["pra"], { typedName: "Alice One" })).rejects.toThrow("The signature must be");
    await expect(grant(["pra"], { typedName: "X" })).rejects.toThrow();
    expect(grants()).toEqual([]);
    const r = await grant(["pra", "authorizations"], { typedName: "bob  one" });
    expect(grants()).toHaveLength(1);
    expect(grants()[0]).toMatchObject({ buyer_account_id: IDS.b1, grantor_member_id: BOB, grantee_member_id: ALICE, scope: ["pra", "authorizations"], grantor_typed_name: "bob  one", ip: harness.ip, revoked_at: null });
    expect(grants()[0]!.granted_at).toBeTruthy();
    expect(grants()[0]!.document_hash).toBe(sha256(authorityGrantText("Bob One", "Alice One", ["pra", "authorizations"])));
    expect(r.grant.id).toBe(grants()[0]!.id);
    expect(db().audits("authority.granted")[0]!.metadata).toMatchObject({ grantor_member_id: BOB, grantee_member_id: ALICE, acted_by_member_id: BOB, scope: ["pra", "authorizations"] });
  });

  it("the grantee is emailed", async () => {
    const r = await grant(["pra"]);
    expect(r.granteeEmailed).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ email: "alice@test.local" });
    expect(sent[0]!.subject).toContain("has given you authority");
    expect(sent[0]!.message).toContain("Priority Reservation Agreement");
  });

  it("only the allowed scopes exist", async () => {
    expect([...AUTHORITY_SCOPES]).toEqual(["pra", "due_diligence_ack", "authorizations", "block3", "closing_docs"]);
    for (const s of AUTHORITY_SCOPES) {
      await grant([s]);
      await revoke(grants().at(-1)!.id as string);
    }
    await expect(grant(["everything"])).rejects.toThrow("isn't something authority can cover");
    await expect(grant([])).rejects.toThrow("Choose what");
    await expect(grant(["pra", "wire_funds"])).rejects.toThrow();
  });

  it.each(NEVER_DELEGATED.map((n) => [n.key, n.label] as const))("authority can never cover %s: it is not a scope, and any grant naming it is rejected", async (key, label) => {
    await expect(grant([key])).rejects.toThrow(`Authority can never cover ${label}`);
    await expect(grant(["pra", key])).rejects.toThrow("Authority can never cover");
    expect(grants()).toEqual([]);
  });

  it("the database list of scopes has no room for them either", () => {
    const sql = readFileSync("signature-authority.sql", "utf8");
    expect(sql).toContain("scope <@ ARRAY['pra', 'due_diligence_ack', 'authorizations', 'block3', 'closing_docs']::text[]");
    for (const n of NEVER_DELEGATED) expect(sql.match(/ARRAY\['pra'[^\]]*\]/)![0]).not.toContain(n.key);
  });

  it("to another active member of the same account only; not to yourself", async () => {
    await expect(grant(["pra"], { grantee: BOB })).rejects.toThrow("yourself");
    await expect(grant(["pra"], { grantee: IDS.b2m1 })).rejects.toThrow("isn't on your account");
    member(ALICE).status = "removed";
    await expect(grant(["pra"])).rejects.toThrow("isn't on your account");
    as(USERS.b1);
    await expect(grantAuthorityFn({ data: { actingMemberId: IDS.b2m1, granteeMemberId: ALICE, scope: ["pra"], typedName: "Carol Two" } })).rejects.toThrow("isn't on your account");
  });

  it("one live grant per pair: change it by revoking and granting again", async () => {
    await grant(["pra"]);
    await expect(grant(["authorizations"])).rejects.toThrow();
    expect(grants()).toHaveLength(1);
  });

  it("each member sees what they gave and received", async () => {
    await grant(["pra"]);
    as(USERS.b1);
    const bob = await getMyAuthority({ data: { actingMemberId: BOB } });
    const alice = await getMyAuthority({ data: { actingMemberId: ALICE } });
    expect(bob.grants[0]).toMatchObject({ gaveIt: true, granteeName: "Alice One" });
    expect(alice.grants[0]).toMatchObject({ gaveIt: false, grantorName: "Bob One" });
  });
});

// ---------------------------------------------------------------------------
// 4. Using authority
// ---------------------------------------------------------------------------

describe("acting under authority", () => {
  async function request() {
    as(USERS.admin);
    return (await createAuthorizationRequest({ data: { propertyId: IDS.property, buyerAccountId: IDS.b1, actionType: "offer_tender", headline: "Offer", terms: { Price: "$1" } } })).id;
  }
  const respond = (requestId: string, onBehalf?: string) => {
    as(USERS.b1);
    return respondToAuthorization({ data: { requestId, accountMemberId: ALICE, decision: "confirmed", signedName: "Alice One", secondaryVerificationMethod: "typed_initials", onBehalfOfMemberId: onBehalf ?? null } });
  };

  it("authorizations: needs a live grant for 'authorizations'; a free-text basis is not enough", async () => {
    const id = await request();
    await expect(
      (as(USERS.b1), respondToAuthorization({ data: { requestId: id, accountMemberId: ALICE, decision: "confirmed", signedName: "Alice One", secondaryVerificationMethod: "typed_initials", onBehalfOfMemberId: BOB, authorityBasis: "POA 2026" } })),
    ).rejects.toThrow("hasn't given you live authority");
    expect(db().table("authorization_responses")).toEqual([]);
    await grant(["pra"]); // the wrong scope
    await expect(respond(id, BOB)).rejects.toThrow("hasn't given you live authority");
    await revoke(grants()[0]!.id as string);
    await grant(["authorizations"]);
    await respond(id, BOB);
    expect(db().table("authorization_responses")).toHaveLength(1);
  });

  it("the record names who acted, for whom and under which grant; it is in the Audit Vault; the grantor is emailed", async () => {
    const id = await request();
    await grant(["authorizations"]);
    sent.length = 0;
    await respond(id, BOB);
    const g = grants()[0]!;
    expect(db().table("authorization_responses")[0]).toMatchObject({ account_member_id: ALICE, acted_by_member_id: ALICE, on_behalf_of_member_id: BOB, authority_grant_id: g.id });
    const used = db().audits("authority.used");
    expect(used).toHaveLength(1);
    expect(used[0]!.metadata).toMatchObject({ acted_by_member_id: ALICE, on_behalf_of_member_id: BOB, authority_grant_id: g.id, scope: "authorizations", record_table: "authorization_responses", ip_address: harness.ip });
    expect(db().audits("authorization.member_confirmed")[0]!.metadata).toMatchObject({ acted_by_member_id: ALICE, on_behalf_of_member_id: BOB, authority_grant_id: g.id });
    const mail = sent.filter((m) => m.email === "bob@test.local");
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toContain("acted for you");
  });

  it("due diligence: under a 'due_diligence_ack' grant the acknowledgment counts for the grantor and names the actor", async () => {
    as(USERS.admin);
    const doc = await placeDiligenceDocument({ data: { propertyId: IDS.property, documentTitle: "Inspection", category: "inspection", fileUrl: "dd/i.pdf", contentHash: "h-i" } });
    const hash = db().table("due_diligence_inventory").find((d) => d.id === doc.id)!.content_hash;
    const ack = () => (as(USERS.b1), acknowledgeAsMember({ data: { documentId: doc.id!, contentHash: hash, accountMemberId: ALICE, signedName: "Alice One", onBehalfOfMemberId: BOB } }));
    expect((await ack()).error).toContain("hasn't given you live authority");
    await grant(["authorizations"]);
    expect((await ack()).ok).toBe(false);
    await revoke(grants()[0]!.id as string);
    await grant(["due_diligence_ack"]);
    sent.length = 0;
    expect(await ack()).toEqual({ ok: true });
    const row = db().table("due_diligence_acknowledgments").find((a) => a.authority_grant_id)!;
    expect(row).toMatchObject({ account_member_id: BOB, acted_by_member_id: ALICE, on_behalf_of_member_id: BOB, signed_name: "Alice One", authority_grant_id: grants().at(-1)!.id });
    expect(db().audits("authority.used")[0]!.metadata).toMatchObject({ scope: "due_diligence_ack", acted_by_member_id: ALICE, on_behalf_of_member_id: BOB });
    expect(sent.filter((m) => m.email === "bob@test.local")).toHaveLength(1);
  });

  it("the PRA: signed for the grantor under a 'pra' grant, with the actor's own typed name", async () => {
    const sign = (typedName: string) => (as(USERS.b1), signMemberDocumentFn({ data: { actingMemberId: ALICE, documentType: "PRA", documentVersion: "v1", documentHash: "djb2_x", typedName, onBehalfOfMemberId: BOB } }));
    await expect(sign("Alice One")).rejects.toThrow("hasn't given you live authority");
    await grant(["pra"]);
    await expect(sign("Bob One")).rejects.toThrow("The signature must be"); // the actor types their own name, not the grantor's
    sent.length = 0;
    await sign("Alice One");
    expect(db().table("signed_documents")[0]).toMatchObject({ account_member_id: BOB, acted_by_member_id: ALICE, on_behalf_of_member_id: BOB, signed_name: "Alice One", authority_grant_id: grants()[0]!.id });
    expect(db().audits("buyer.pra_signed")[0]!.metadata).toMatchObject({ account_member_id: BOB, acted_by_member_id: ALICE, on_behalf_of_member_id: BOB });
    expect(sent.filter((m) => m.email === "bob@test.local")).toHaveLength(1);
  });

  it("the Operating Agreement: signed for the grantor under a 'closing_docs' grant", async () => {
    Object.assign(db().table("properties")[0], { exit_type: "hybrid_exit", retained_shares: 5, listing_status: "system_lock" });
    acceptBlock2ForAll(db());
    await ensureDigitalGenesis(db(), { propertyId: IDS.property, actorId: USERS.b1, reason: "hard_lock" });
    as(USERS.admin);
    const act = (action: unknown) => runStage2Action({ data: { propertyId: IDS.property, action: action as never } });
    for (const a of [{ kind: "closing_ready" }, { kind: "atlas_request", reference: "A" }, { kind: "state_filed" }, { kind: "state_confirmed", llcName: "D8 Test, LLC", delawareFileNumber: "1", certificateFileUrl: "e/c.pdf", certificateHash: "djb2_c" }, { kind: "final_oa" }]) await act(a);
    const hash = db().table("entity_genesis")[0]!.final_oa_hash as string;
    const sign = () => (as(USERS.b1), signMyOperatingAgreement({ data: { propertyId: IDS.property, accountMemberId: ALICE, signedName: "Alice One", documentHash: hash, secondaryVerificationMethod: "typed_initials", onBehalfOfMemberId: BOB } }));
    await expect(sign()).rejects.toThrow("hasn't given you live authority");
    await grant(["authorizations"]);
    await expect(sign()).rejects.toThrow("hasn't given you live authority");
    await revoke(grants()[0]!.id as string);
    await grant(["closing_docs"]);
    await sign();
    expect(db().table("operating_agreement_signatures")[0]).toMatchObject({ account_member_id: BOB, acted_by_member_id: ALICE, on_behalf_of_member_id: BOB, authority_grant_id: grants().at(-1)!.id, document_hash: hash });
    expect(db().audits("authority.used")[0]!.metadata).toMatchObject({ scope: "closing_docs" });
  });

  it("authority can't be claimed over a member of another account", async () => {
    const id = await request();
    await grant(["authorizations"]);
    await expect(respond(id, IDS.b2m1)).rejects.toThrow("That member isn't on your account.");
    expect(db().table("authorization_responses")).toEqual([]);
  });

  it("another account's members can never use it", async () => {
    await grant(["authorizations"]);
    as(USERS.b2);
    await expect(
      respondToAuthorization({ data: { requestId: "x", accountMemberId: IDS.b2m1, decision: "confirmed", signedName: "Carol Two", secondaryVerificationMethod: "typed_initials", onBehalfOfMemberId: BOB } }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. What authority can never cover
// ---------------------------------------------------------------------------

describe("Block 4, ID scan, liveness, Block 1, Block 2, Hold Harmless and W-9 reject authority on the server", () => {
  const attempt = { onBehalfOfMemberId: BOB };
  const refused = (what: string) => `Authority can never cover ${what}`;

  it("each is refused even with a live grant for every real scope", async () => {
    await grant([...AUTHORITY_SCOPES]);
    as(USERS.b1);
    await expect(submitEligibilityDeclaration({ data: { actingMemberId: ALICE, answers: { q1: "yes", q2: "yes", q3: "yes", q4: "yes", q5: "yes", q6: "yes" }, attestedPersonally: true, signedName: "Alice One", supersedesId: null, ...attempt } as never })).rejects.toThrow(refused("Block 4"));
    await expect(saveMemberIdentityFn({ data: { actingMemberId: ALICE, fullName: "Bob One", address: "1 Main", dateOfBirth: "1980-01-01", idDocumentNumber: "D1", ...attempt } as never })).rejects.toThrow(refused("the ID scan"));
    await expect(submitLivenessSelfie({ data: { actingMemberId: ALICE, selfiePath: `${USERS.b1}/s.jpg`, selfieFileName: "s.jpg", ...attempt } as never })).rejects.toThrow(refused("the liveness check"));
    await expect(acceptAuthorizationFn({ data: { actingMemberId: ALICE, block: "block1", ...attempt } as never })).rejects.toThrow(refused("Block 1"));
    await expect(acceptAuthorizationFn({ data: { actingMemberId: ALICE, block: "block2", ...attempt } as never })).rejects.toThrow(refused("Block 2"));
    await expect(signMemberDocumentFn({ data: { actingMemberId: ALICE, documentType: "HOLD_HARMLESS", documentVersion: "v1", documentHash: "h", typedName: "Alice One", ...attempt } as never })).rejects.toThrow(refused("the Hold Harmless"));
    await expect(submitW9Fn({ data: { actingMemberId: ALICE, legalName: "Alice One", taxClassification: "individual", address: "1 Main", tinKind: "ssn", tin: "123-45-6789", signedName: "Alice One", ...attempt } as never })).rejects.toThrow(refused("the W-9"));
    // ...and a grant id or a scope smuggled in is refused the same way.
    await expect(signMemberDocumentFn({ data: { actingMemberId: ALICE, documentType: "HOLD_HARMLESS", documentVersion: "v1", documentHash: "h", typedName: "Alice One", authorityGrantId: grants()[0]!.id } as never })).rejects.toThrow("Authority can never cover");
    expect(db().table("signed_documents")).toEqual([]);
    expect(db().table("member_w9")).toEqual([]);
    expect(db().table("eligibility_declarations")).toEqual([]);
  });

  it("the Hold Harmless is refused under authority at the service layer too, not only at the door", async () => {
    await grant([...AUTHORITY_SCOPES]);
    const { signMemberDocument } = await import("@/lib/member-steps.server");
    await expect(signMemberDocument(db(), { userId: USERS.b1, actingMemberId: ALICE, documentType: "HOLD_HARMLESS", documentVersion: "v1", documentHash: "h", typedName: "Alice One", onBehalfOfMemberId: BOB, request: { ip: null, userAgent: null } })).rejects.toThrow("Authority can never cover the Hold Harmless");
  });

  it("without any attempt these all still work for the member themselves", async () => {
    as(USERS.b1);
    await signMemberDocumentFn({ data: { actingMemberId: ALICE, documentType: "HOLD_HARMLESS", documentVersion: "v1", documentHash: "h", typedName: "Alice One" } });
    expect(db().table("signed_documents")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Revoking
// ---------------------------------------------------------------------------

describe("revoking authority", () => {
  it("only the grantor can revoke, once", async () => {
    await grant(["authorizations"]);
    const id = grants()[0]!.id as string;
    await expect(revoke(id, ALICE)).rejects.toThrow("Only the member who gave");
    await revoke(id);
    expect(grants()[0]!.revoked_at).toBeTruthy();
    await expect(revoke(id)).rejects.toThrow("already revoked");
    expect(db().audits("authority.revoked")).toHaveLength(1);
    expect(sent.some((m) => m.email === "alice@test.local" && /revoked/.test(m.subject))).toBe(true);
  });

  it("after revocation no new action can use it, and past records stay intact", async () => {
    as(USERS.admin);
    const { id: first } = await createAuthorizationRequest({ data: { propertyId: IDS.property, buyerAccountId: IDS.b1, actionType: "offer_tender", headline: "Offer 1", terms: {} } });
    const { id: second } = await createAuthorizationRequest({ data: { propertyId: IDS.property, buyerAccountId: IDS.b1, actionType: "offer_tender", headline: "Offer 2", terms: {} } });
    await grant(["authorizations", "pra"]);
    const gid = grants()[0]!.id as string;
    const respond = (requestId: string) => (as(USERS.b1), respondToAuthorization({ data: { requestId, accountMemberId: ALICE, decision: "confirmed", signedName: "Alice One", secondaryVerificationMethod: "typed_initials", onBehalfOfMemberId: BOB } }));
    await respond(first);
    const before = JSON.stringify(db().table("authorization_responses")[0]);
    const grantBefore = { ...grants()[0]! };

    await revoke(gid);
    await expect(respond(second)).rejects.toThrow("hasn't given you live authority");
    await expect((as(USERS.b1), signMemberDocumentFn({ data: { actingMemberId: ALICE, documentType: "PRA", documentVersion: "v1", documentHash: "h", typedName: "Alice One", onBehalfOfMemberId: BOB } }))).rejects.toThrow("hasn't given you live authority");

    // The earlier record, the grant and the audit entries are untouched.
    expect(JSON.stringify(db().table("authorization_responses")[0])).toBe(before);
    expect(db().table("authorization_responses")).toHaveLength(1);
    expect({ ...grants()[0]!, revoked_at: null }).toEqual({ ...grantBefore, revoked_at: null });
    expect(db().audits("authority.used")).toHaveLength(1);
  });

  it("a new grant can be made after revoking", async () => {
    await grant(["pra"]);
    await revoke(grants()[0]!.id as string);
    await grant(["authorizations"]);
    expect(grants().map((g) => g.revoked_at !== null && g.revoked_at !== undefined)).toEqual([true, false]);
  });

  it("removing a member ends their authority too: the grants stop resolving", async () => {
    await grant(["authorizations"]);
    member(BOB).status = "removed";
    as(USERS.b1);
    await expect(respondToAuthorization({ data: { requestId: "x", accountMemberId: ALICE, decision: "confirmed", signedName: "Alice One", secondaryVerificationMethod: "typed_initials", onBehalfOfMemberId: BOB } })).rejects.toThrow();
  });
});

describe("the grants table is the only source of authority", () => {
  it("no code path allows an on-behalf action from a free-text flag", () => {
    const auth = readFileSync("src/lib/authorization.functions.ts", "utf8");
    expect(auth).toContain("resolveAuthority(");
    expect(auth).not.toMatch(/authorityBasis\?\.trim\(\)\)\s*\n?\s*throw/);
    expect(auth).toContain("authority_grant_id: use?.authorityGrantId ?? null");
    expect(readFileSync("src/lib/due-diligence.functions.ts", "utf8")).toContain('scope: "due_diligence_ack"');
    expect(readFileSync("src/lib/entity-genesis-stage2.server.ts", "utf8")).toContain('scope: "closing_docs"');
    expect(readFileSync("src/lib/member-steps.server.ts", "utf8")).toContain('scope: "pra"');
  });

  it("the SQL makes the database refuse a use of a revoked grant, the wrong scope or the wrong people", () => {
    const sql = readFileSync("signature-authority.sql", "utf8");
    expect(sql).toContain("That authority has been revoked, or doesn''t exist.");
    expect(sql).toContain("That authority doesn''t cover this.");
    expect(sql).toContain("That authority was not given by this member to this member.");
    expect(sql).toContain("Authority can never cover this document.");
  });
});
