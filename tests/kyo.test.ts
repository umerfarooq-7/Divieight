/** Know Your Owner: result + Standard version per member, declaration hash/version/date (admin only), data rights, and the agent boundary. */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import { getKyoForAdmin, getMyKyo, listKyoCorrectionsForAdmin, requestKyoCorrectionFn, resolveKyoCorrectionFn } from "@/lib/kyo.functions";
import { CORRECTION_FIELDS, KYO_MOST_SENSITIVE_PII } from "@/lib/kyo";
import { agentVisibleStage } from "@/lib/agent-visibility";
import { listMyTetheredBuyers } from "@/lib/agent-leads.functions";

const db = () => harness.db;
const as = (u: string) => (harness.userId = u);
const ALICE = IDS.b1m1;
const BOB = IDS.b1m2;
const yes = { q1: "yes", q2: "yes", q3: "yes", q4: "yes", q5: "yes", q6: "yes" };
const HASH_A = "sha256_" + "a".repeat(64);
const HASH_B = "sha256_" + "b".repeat(64);

beforeEach(() => {
  seedPod(db());
  for (const m of db().table("account_members")) Object.assign(m, { status: "active", role: m.role === "secondary" ? "member" : m.role });
});

/** Alice: complete declaration (hash A, Standard 1.1) with an eligible result. Bob: a held result on a corrected declaration. */
function seedKyo() {
  db().seed("eligibility_declarations", [
    { id: "dA", account_member_id: ALICE, buyer_account_id: IDS.b1, status: "complete", answers: yes, standard_version: "1.1", declared_at: "2026-11-02T10:00:00Z", declaration_hash: HASH_A },
    { id: "dB0", account_member_id: BOB, buyer_account_id: IDS.b1, status: "superseded", answers: yes, standard_version: "1.0", declared_at: "2026-10-01T10:00:00Z", declaration_hash: "sha256_" + "0".repeat(64) },
    { id: "dB", account_member_id: BOB, buyer_account_id: IDS.b1, status: "complete", answers: { ...yes, q3: "no" }, standard_version: "1.1", declared_at: "2026-11-03T10:00:00Z", declaration_hash: HASH_B },
    { id: "dL", account_member_id: ALICE, buyer_account_id: IDS.b1, status: "legacy", answers: null, standard_version: "legacy-background-check-consent", declared_at: "2026-09-01T00:00:00Z", declaration_hash: "sha256_" + "9".repeat(64) },
  ]);
  db().seed("eligibility_results", [
    { account_member_id: ALICE, buyer_account_id: IDS.b1, declaration_id: "dA", result: "eligible", reason_codes: ["all_clear"], standard_version: "1.1", determined_at: "2026-11-02T10:05:00Z" },
    // A result on Bob's old, superseded declaration must not be shown.
    { account_member_id: BOB, buyer_account_id: IDS.b1, declaration_id: "dB0", result: "eligible", reason_codes: ["all_clear"], standard_version: "1.0", determined_at: "2026-10-01T10:05:00Z" },
    { account_member_id: BOB, buyer_account_id: IDS.b1, declaration_id: "dB", result: "held", reason_codes: ["q3_pending_charge_disclosed"], standard_version: "1.1", determined_at: "2026-11-03T10:05:00Z" },
  ]);
}

describe("the KYO record (admin)", () => {
  it("shows each member's eligibility result and the Standard version it was determined against", async () => {
    seedKyo();
    as(USERS.admin);
    const kyo = await getKyoForAdmin({ data: { accountId: IDS.b1 } });
    const of = (id: string) => kyo.find((m) => m.memberId === id)!;
    expect(of(ALICE).eligibility).toEqual({ result: "eligible", standardVersion: "1.1", determinedAt: "2026-11-02T10:05:00Z" });
    expect(of(BOB).eligibility).toEqual({ result: "held", standardVersion: "1.1", determinedAt: "2026-11-03T10:05:00Z" });
    expect(kyo.map((m) => m.name)).toEqual(["Alice One", "Bob One"]);
  });

  it("the version is the one the result was determined against, whatever it is", async () => {
    seedKyo();
    db().table("eligibility_results").find((r) => r.declaration_id === "dA")!.standard_version = "1.4";
    as(USERS.admin);
    expect((await getKyoForAdmin({ data: { accountId: IDS.b1 } })).find((m) => m.memberId === ALICE)!.eligibility!.standardVersion).toBe("1.4");
  });

  it("an incomplete declaration has no result in the record, even if a result row points at it", async () => {
    seedKyo();
    db().table("eligibility_declarations").find((d) => d.id === "dA")!.status = "incomplete";
    as(USERS.admin);
    const alice = (await getKyoForAdmin({ data: { accountId: IDS.b1 } })).find((m) => m.memberId === ALICE)!;
    expect(alice.eligibility).toBeNull();
    expect(alice.declaration).toMatchObject({ status: "incomplete", declarationHash: HASH_A });
  });

  it("shows each member's declaration hash, Standard version and date; earlier versions are counted, legacy consents are not", async () => {
    seedKyo();
    as(USERS.admin);
    const kyo = await getKyoForAdmin({ data: { accountId: IDS.b1 } });
    expect(kyo.find((m) => m.memberId === ALICE)!.declaration).toEqual({ id: "dA", status: "complete", standardVersion: "1.1", declaredAt: "2026-11-02T10:00:00Z", declarationHash: HASH_A, versions: 1 });
    expect(kyo.find((m) => m.memberId === BOB)!.declaration).toMatchObject({ id: "dB", declarationHash: HASH_B, standardVersion: "1.1", declaredAt: "2026-11-03T10:00:00Z", versions: 2 });
  });

  it("a result on a superseded declaration is not the member's result", async () => {
    seedKyo();
    db().table("eligibility_results").splice(2, 1); // Bob's held result removed: only the stale 'eligible' on his old declaration remains
    as(USERS.admin);
    expect((await getKyoForAdmin({ data: { accountId: IDS.b1 } })).find((m) => m.memberId === BOB)!.eligibility).toBeNull();
  });

  it("there is no background check outcome field, and no consumer report data, in the record", async () => {
    seedKyo();
    as(USERS.admin);
    const json = JSON.stringify(await getKyoForAdmin({ data: { accountId: IDS.b1 } }));
    expect(json).not.toMatch(/background|consumer|fcra|report/i);
    for (const f of ["src/lib/kyo.ts", "src/lib/kyo.server.ts", "src/components/KyoPanel.tsx", "src/routes/buyer.kyo.tsx"]) {
      expect(readFileSync(f, "utf8").replace(/consumer report obtained under the Block 4 authorization|the platform does not obtain a consumer report in the ordinary course|does not obtain a consumer report/gi, "")).not.toMatch(/background[\s_-]?check/i);
    }
  });

  it("is admin only, and reading it is logged", async () => {
    seedKyo();
    as(USERS.b1);
    await expect(getKyoForAdmin({ data: { accountId: IDS.b1 } })).rejects.toThrow("Not authorized");
    as(USERS.ra);
    await expect(getKyoForAdmin({ data: { accountId: IDS.b1 } })).rejects.toThrow("Not authorized");
    expect(db().audits("kyo.viewed")).toEqual([]);
    as(USERS.admin);
    await getKyoForAdmin({ data: { accountId: IDS.b1 } });
    expect(db().audits("kyo.viewed")[0]).toMatchObject({ actor_id: USERS.admin, entity_id: IDS.b1 });
  });

  it("only active members appear", async () => {
    seedKyo();
    db().table("account_members").find((m) => m.id === BOB)!.status = "removed";
    as(USERS.admin);
    expect((await getKyoForAdmin({ data: { accountId: IDS.b1 } })).map((m) => m.memberId)).toEqual([ALICE]);
  });
});

describe("the most sensitive PII list", () => {
  it("says 'any consumer report obtained under the Block 4 authorization', not 'the underlying consumer report'", () => {
    expect(KYO_MOST_SENSITIVE_PII).toContain("any consumer report obtained under the Block 4 authorization");
    expect(KYO_MOST_SENSITIVE_PII.join(" | ")).not.toMatch(/underlying consumer report/i);
    for (const f of readdirSync("src", { recursive: true, withFileTypes: false }) as string[]) {
      if (/\.(ts|tsx)$/.test(f)) expect(readFileSync(`src/${f}`, "utf8")).not.toMatch(/the underlying consumer report/i);
    }
  });

  it("is shown to the admin and to the member", () => {
    expect(readFileSync("src/components/KyoPanel.tsx", "utf8")).toContain("KYO_MOST_SENSITIVE_PII.join");
    expect(readFileSync("src/routes/buyer.kyo.tsx", "utf8")).toContain("KYO_MOST_SENSITIVE_PII.join");
  });
});

describe("data rights: each member sees their own KYO data and asks for corrections", () => {
  it("a member sees only their own data (through the switcher); the other member's is not in it", async () => {
    seedKyo();
    db().table("account_members").find((m) => m.id === ALICE)!.date_of_birth = "1980-01-01";
    db().table("account_members").find((m) => m.id === ALICE)!.id_document_number = "D1234567";
    db().seed("member_w9", [{ account_member_id: ALICE, buyer_account_id: IDS.b1, tin_kind: "ssn", tin_last4: "6789", signed_at: "2026-11-04T00:00:00Z" }]);
    as(USERS.b1);
    const mine = await getMyKyo({ data: { actingMemberId: ALICE } });
    expect(mine).toMatchObject({ memberId: ALICE, name: "Alice One", held: false, eligibility: { result: "eligible", standardVersion: "1.1" }, declaration: { declarationHash: HASH_A, standardVersion: "1.1" } });
    expect(mine.onFile).toMatchObject({ dateOfBirth: "on file", idDocumentNumber: "•••67", w9: { kind: "ssn", last4: "6789" } });
    const text = JSON.stringify(mine);
    expect(text).not.toContain("Bob");
    expect(text).not.toContain(HASH_B);
    expect(text).not.toContain("D1234567");
    expect(text).not.toContain("1980-01-01");
    const bob = await getMyKyo({ data: { actingMemberId: BOB } });
    expect(bob).toMatchObject({ memberId: BOB, held: true });
    expect(JSON.stringify(bob)).not.toContain(HASH_A);
  });

  it("a member's own view never carries the reason codes, only the result and the Standard version", async () => {
    seedKyo();
    as(USERS.b1);
    const bob = await getMyKyo({ data: { actingMemberId: BOB } });
    expect(JSON.stringify(bob)).not.toMatch(/reason|q3_pending|charge/i);
  });

  it("another account's member, a removed member, or a non-buyer can't be read", async () => {
    seedKyo();
    as(USERS.b1);
    await expect(getMyKyo({ data: { actingMemberId: IDS.b2m1 } })).rejects.toThrow("isn't on your account");
    db().table("account_members").find((m) => m.id === BOB)!.status = "removed";
    await expect(getMyKyo({ data: { actingMemberId: BOB } })).rejects.toThrow("isn't on your account");
    as(USERS.ra);
    await expect(getMyKyo({ data: { actingMemberId: ALICE } })).rejects.toThrow();
  });

  const ask = (member: string, field: string, requestedChange: string, user = USERS.b1) => (as(user), requestKyoCorrectionFn({ data: { actingMemberId: member, field, requestedChange } }));

  it("a member can ask for a correction; it is recorded for that member, with a time, IP and browser, and shown back to them", async () => {
    const r = await ask(ALICE, "address", "My address is 2 Oak St, Lusk, WY");
    expect(db().table("kyo_correction_requests")[0]).toMatchObject({ id: r.id, account_member_id: ALICE, buyer_account_id: IDS.b1, field: "address", status: "open", ip: harness.ip });
    expect("user_agent" in db().table("kyo_correction_requests")[0]!).toBe(true);
    as(USERS.b1);
    expect((await getMyKyo({ data: { actingMemberId: ALICE } })).corrections.map((c) => [c.field, c.status])).toEqual([["address", "open"]]);
    expect((await getMyKyo({ data: { actingMemberId: BOB } })).corrections).toEqual([]);
  });

  it("only listed fields, a real change, and only for the member themselves", async () => {
    await expect(ask(ALICE, "tin", "x")).rejects.toThrow("Choose what you want corrected");
    await expect(ask(ALICE, "address", "   ")).rejects.toThrow("Say what should be corrected");
    await expect(ask(IDS.b2m1, "address", "x")).rejects.toThrow("isn't on your account");
    expect(db().table("kyo_correction_requests")).toEqual([]);
    expect(CORRECTION_FIELDS.map((f) => f.value)).not.toContain("declaration");
  });

  it("the audit log records that a correction was asked for, but not what the new value is", async () => {
    await ask(ALICE, "id_document_number", "It should be Z9999999");
    const audit = JSON.stringify(db().audits("kyo.correction_requested"));
    expect(audit).toContain("id_document_number");
    expect(audit).not.toContain("Z9999999");
    expect(db().audits("kyo.correction_requested")[0]!.metadata).toMatchObject({ acted_by_member_id: ALICE, account_member_id: ALICE });
  });

  it("an admin sees open requests and marks them handled, once, with a note", async () => {
    const r = await ask(ALICE, "full_name", "Spell it Alicia");
    as(USERS.b1);
    await expect(listKyoCorrectionsForAdmin()).rejects.toThrow("Not authorized");
    await expect(resolveKyoCorrectionFn({ data: { requestId: r.id, note: "done" } })).rejects.toThrow("Not authorized");
    as(USERS.admin);
    expect((await listKyoCorrectionsForAdmin()).map((c) => c.id)).toEqual([r.id]);
    await expect(resolveKyoCorrectionFn({ data: { requestId: r.id, note: "  " } })).rejects.toThrow("Say how it was handled");
    await resolveKyoCorrectionFn({ data: { requestId: r.id, note: "Updated the name on file" } });
    expect(db().table("kyo_correction_requests")[0]).toMatchObject({ status: "resolved", resolved_by: USERS.admin, resolution_note: "Updated the name on file" });
    await expect(resolveKyoCorrectionFn({ data: { requestId: r.id, note: "again" } })).rejects.toThrow("already resolved");
    expect(await listKyoCorrectionsForAdmin()).toEqual([]);
    as(USERS.b1);
    expect((await getMyKyo({ data: { actingMemberId: ALICE } })).corrections[0]).toMatchObject({ status: "resolved", resolution_note: "Updated the name on file" });
  });

  it("answers in the declaration are corrected through Correct and resubmit, which recomputes the result", () => {
    expect(readFileSync("src/lib/kyo.ts", "utf8")).toContain("Correct and resubmit");
    expect(readFileSync("src/routes/buyer.kyo.tsx", "utf8")).toContain("DECLARATION_CORRECTION_NOTE");
  });
});

// ---------------------------------------------------------------------------
// The agent boundary (Rev 49 counsel items D2(a)/D2(b))
// ---------------------------------------------------------------------------

describe("the tethered agent sees only what they saw before; held reads as Pending and the reason is never shown", () => {
  it("agentVisibleStage: a held account is Pending before the ticket; everything else is unchanged", () => {
    expect(agentVisibleStage("vetting_pending", true, false)).toBe("vetting_pending");
    expect(agentVisibleStage("liquidity_pending", true, false)).toBe("vetting_pending");
    expect(agentVisibleStage("active", true, true)).toBe("active");
    expect(agentVisibleStage("verification_pending", false, false)).toBe("verification_pending");
    expect(agentVisibleStage("golden_ticket_pending", false, false)).toBe("golden_ticket_pending");
    expect(agentVisibleStage("held", false, false)).toBe("vetting_pending");
    expect(agentVisibleStage("application_held", false, false)).toBe("vetting_pending");
  });

  it("an agent's lead list shows a held account exactly as an account still in vetting, with no result or reason", async () => {
    seedKyo();
    const acct = db().table("buyer_accounts").find((a) => a.id === IDS.b1)!;
    acct.onboarding_status = "liquidity_pending";
    acct.golden_ticket_issued = false;
    as(USERS.ra);
    const leads = await listMyTetheredBuyers();
    const b1 = leads.find((l) => l.buyerAccountId === IDS.b1)!;
    expect(b1.onboardingStatus).toBe("vetting_pending");
    const json = JSON.stringify(b1);
    expect(json).not.toMatch(/held|q3|charge|reason|eligib|declaration|sha256|kyo/i);
    // An account that isn't held keeps exactly the stage it had.
    const b2 = leads.find((l) => l.buyerAccountId === IDS.b2)!;
    db().table("buyer_accounts").find((a) => a.id === IDS.b2)!.onboarding_status = "liquidity_pending";
    as(USERS.ra);
    expect((await listMyTetheredBuyers()).find((l) => l.buyerAccountId === IDS.b2)!.onboardingStatus).toBe("liquidity_pending");
    expect(b2.goldenTicketIssued).toBe(false);
  });

  it("the Module 8 wording is exactly as it was, and carries the counsel comment", () => {
    const dash = readFileSync("src/routes/agent.dashboard.tsx", "utf8");
    const leads = readFileSync("src/routes/agent.leads.tsx", "utf8");
    const items = readFileSync("src/components/AgentActionItems.tsx", "utf8");
    const table = readFileSync("src/components/agent/VerifiedLeadTable.tsx", "utf8");
    expect(dash).toContain("fully qualified. Vetting report contents remain private to the buyer and the Platform.");
    expect(leads).toContain("qualified — Platform Enrollment Fee paid and Digital Key issued. Vetting report contents");
    expect(leads).toContain("stay private to the buyer and the Platform.");
    expect(items).toContain("A buyer you referred is now vetted — choose how to proceed");
    expect(table).toContain("Onboarding stage: {b.onboardingStatus.replace(/_/g, \" \")}");
    expect(table).toContain('{b.goldenTicketIssued ? "Digital Key issued" : "Digital Key pending"}');
    for (const src of [dash, leads, items, table, readFileSync("src/lib/agent-leads.functions.ts", "utf8"), readFileSync("src/lib/agent-visibility.ts", "utf8")]) expect(src).toContain("Rev 49 counsel items D2(a)/D2(b)");
  });

  it("nothing an agent can reach reads the KYO record or the eligibility results", () => {
    const agentFiles = [...(readdirSync("src/routes") as string[]).filter((f) => f.startsWith("agent")).map((f) => `src/routes/${f}`), ...(readdirSync("src/components/agent") as string[]).map((f) => `src/components/agent/${f}`), "src/components/AgentActionItems.tsx", "src/lib/agent-pod.functions.ts", "src/lib/agent-pools.functions.ts"];
    for (const f of agentFiles) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/kyo\.functions|kyo\.server|eligibility_results|eligibility-engine|eligibility_declarations/);
    }
    const leads = readFileSync("src/lib/agent-leads.functions.ts", "utf8");
    // The only thing it takes from the engine is whether an account is held, to show it as Pending.
    expect(leads.match(/eligibility-engine/g) ?? []).toEqual(["eligibility-engine"]);
  });
});

describe("existing PII access rules, retention and vaults are unchanged", () => {
  it("the new SQL touches only the correction table", () => {
    const sql = readFileSync("kyo-corrections.sql", "utf8");
    const tables = [...sql.matchAll(/(?:CREATE TABLE IF NOT EXISTS|ALTER TABLE|\bON|REVOKE ALL ON|GRANT [A-Z, ]+ ON|FROM) public\.([a-z_0-9]+)/g)].map((m) => m[1]);
    // account_members and buyer_accounts are only read (the member guard and the read policy).
    expect(new Set(tables)).toEqual(new Set(["kyo_correction_requests", "account_members", "buyer_accounts"]));
    // account_members is only read, by the member guard's lookup.
    expect(sql).not.toMatch(/ALTER TABLE public\.account_members|POLICY[^;]*ON public\.account_members/);
    // The statements (not the comments) mention neither retention nor any vault.
    expect(sql.replace(/^--.*$/gm, "")).not.toMatch(/retention|vault/i);
  });

  it("the KYO code never touches the encrypted TIN, the vault, or the audit log's rules", () => {
    for (const f of ["src/lib/kyo.server.ts", "src/lib/kyo.functions.ts", "src/lib/kyo.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/member_w9_tin_secrets|pii-crypto|decryptPii|storage\.from|property_records_vault/);
    }
    // Reading the record writes to the audit log, as every other sensitive read does; it does not change how it works.
    expect(readFileSync("src/lib/audit.ts", "utf8")).toContain("PII Sub-Vault");
  });
});
