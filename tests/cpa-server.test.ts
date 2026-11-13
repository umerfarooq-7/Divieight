/** Month 6, Prompt 12, the app side: designating and rescinding, the CPA's read-only and scoped reads, the audited TIN view, and what members see. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { harness } from "./setup";
import { seedPod, USERS, IDS } from "./fixtures";
import * as cpa from "@/lib/cpa.server";
import { encryptPii } from "@/lib/pii-crypto.server";

const db = () => harness.db as any;
const A = IDS.property;
const B = "prop-other";
const CPA = "u-cpa";
const KEY = randomBytes(32).toString("base64");
const DIGITS = "123456789";
let calls: Array<[string, Record<string, any>]> = [];
const invite = vi.fn();
const update = vi.fn();

const designations = () => db().table("cpa_designations") as any[];
const audits = (action: string) => (db().table("audit_log") as any[]).filter((a) => a.action_type === action);
const active = (property: string, user = CPA) => designations().some((d) => d.auth_user_id === user && d.property_id === property && d.status === "active");

/** The database functions, in memory, with the rules the real ones have (tested for real in cpa-credential-sql.test.ts). */
function wireRpc() {
  const d = db();
  d.rpcResults.is_property_cpa = (a: any) => active(a._property, a._user);
  d.rpcResults.cpa_can_view_tin = (a: any) => {
    const w = (d.table("member_w9") as any[]).find((x) => x.id === a._w9);
    const holds = w && (d.table("cap_table_entries") as any[]).some((c) => c.property_id === a._property && c.buyer_account_id === w.buyer_account_id);
    return !!holds && active(a._property, a._user);
  };
  d.rpcResults.designate_cpa = vi.fn((a: any) => {
    calls.push(["designate_cpa", a]);
    if (designations().some((x) => x.property_id === a._property && ["invited", "active"].includes(x.status))) return { __error: "This LLC already has a designated CPA (Pat). Rescind that designation first: an LLC has one CPA at a time." };
    const row = { id: `des-${designations().length + 1}`, property_id: a._property, cpa_name: a._name, firm: a._firm, email: a._email, license_no: a._license, status: "invited", auth_user_id: null, designated_at: new Date().toISOString(), activated_at: null, rescinded_at: null, reason: null };
    designations().push(row);
    return row.id;
  });
  d.rpcResults.attach_cpa_login = vi.fn((a: any) => {
    calls.push(["attach", a]);
    const row = designations().find((x) => x.id === a._id);
    if (row && !row.auth_user_id) row.auth_user_id = a._auth_user;
  });
  d.rpcResults.activate_cpa_designations = (a: any) => {
    for (const x of designations().filter((r) => r.auth_user_id === a._user && r.status === "invited")) Object.assign(x, { status: "active", activated_at: new Date().toISOString() });
    return designations().filter((r) => r.auth_user_id === a._user && r.status === "active").map((r) => ({ designation_id: r.id, property_id: r.property_id, cpa_name: r.cpa_name, firm: r.firm }));
  };
  d.rpcResults.rescind_cpa = vi.fn((a: any) => {
    calls.push(["rescind", a]);
    const row = designations().find((x) => x.id === a._id)!;
    if (row.status === "rescinded") return { status: "already_rescinded", auth_user_id: row.auth_user_id, other_active: 0 };
    Object.assign(row, { status: "rescinded", rescinded_at: new Date().toISOString(), reason: a._reason });
    return { status: "rescinded", auth_user_id: row.auth_user_id, other_active: designations().filter((x) => x.auth_user_id === row.auth_user_id && ["invited", "active"].includes(x.status)).length };
  });
  d.rpcResults.capital_roll_forward = () => [{ member_key: IDS.b1, beginning_cents: 0, opening_cents: 400_000, contributions_cents: 0, income_cents: 25_000, expense_cents: -40_000, depreciation_cents: 0, distributions_cents: -30_000, transfer_in_cents: 0, transfer_out_cents: 0, ending_cents: 355_000 }];
}
// An rpc that returns { __error } is an error from the database.
const realRpc = (fn: any) => fn;
void realRpc;

const snapshot = (period: string) => ({ schema: "monthly-statement.v1", period, period_start: `${period}-01`, period_end: `${period}-28`, property: { property_id: A, address: "5632 Independence Ave", city: "Lusk", state: "WY", zip: "82225", llc_name: "LLC", shares: 4, total_shares: 8, interest_percent: "50.00" }, member_key: IDS.b1, capital: { opening_cents: 0, contributions_cents: 0, distributions_cents: 0, income_cents: 0, expense_cents: 0, depreciation_cents: 0, transfers_cents: 0, closing_cents: 355_000, lines: [] }, llc_month: { income_cents: 0, expense_cents: 0, net_cents: 0, income: [], expense: [] }, ytd: { year: 2026, capital: { beginning_cents: 0, contributions_cents: 0, distributions_cents: 0, income_cents: 0, expense_cents: 0, depreciation_cents: 0, transfers_cents: 0, closing_cents: 355_000 }, llc: { income_cents: 0, expense_cents: 0, net_cents: 0, income: [], expense: [] } }, generated_at: "2026-11-02T10:00:00Z" });

beforeEach(() => {
  vi.stubEnv("W9_TIN_ENCRYPTION_KEY", KEY);
  seedPod(db());
  calls = [];
  invite.mockReset().mockResolvedValue({ data: { user: { id: CPA } }, error: null });
  update.mockReset().mockResolvedValue({ data: {}, error: null });
  db().auth = { admin: { inviteUserByEmail: invite, updateUserById: update } };
  db().seed("cpa_designations", []);
  db().seed("user_roles", [{ user_id: USERS.admin, role: "admin" }]);
  db().seed("cap_table_entries", [
    { property_id: A, share_number: 1, holder_type: "buyer_account", buyer_account_id: IDS.b1, seller_id: null },
    { property_id: A, share_number: 2, holder_type: "buyer_account", buyer_account_id: IDS.b2, seller_id: null },
    { property_id: B, share_number: 1, holder_type: "buyer_account", buyer_account_id: IDS.b3, seller_id: null },
  ]);
  db().seed("member_w9", [
    { id: "w9-a1", buyer_account_id: IDS.b1, legal_name: "Ann Member", tin_kind: "ssn" },
    { id: "w9-b3", buyer_account_id: IDS.b3, legal_name: "Zed Elsewhere", tin_kind: "ssn" },
  ]);
  db().seed("member_w9_tin_secrets", [{ w9_id: "w9-a1", ...encryptPii(DIGITS, "member_w9:w9-a1") }, { w9_id: "w9-b3", ...encryptPii("987654321", "member_w9:w9-b3") }]);
  db().seed("monthly_statements", [
    { id: "st-a-issued", property_id: A, member_key: IDS.b1, period: "2026-10", version: 1, status: "issued", data_snapshot: snapshot("2026-10"), issued_at: "2026-11-03T00:00:00Z" },
    { id: "st-a-draft", property_id: A, member_key: IDS.b1, period: "2026-11", version: 1, status: "draft", data_snapshot: snapshot("2026-11"), issued_at: null },
    { id: "st-b", property_id: B, member_key: IDS.b3, period: "2026-10", version: 1, status: "issued", data_snapshot: snapshot("2026-10"), issued_at: "2026-11-03T00:00:00Z" },
  ]);
  db().seed("journal_entries", [
    { id: "e-a", property_id: A, entry_date: "2026-04-10", source: "manual", memo: "Rent", reverses_entry_id: null, is_adjustment: false },
    { id: "e-b", property_id: B, entry_date: "2026-04-11", source: "manual", memo: "Secret other LLC", reverses_entry_id: null, is_adjustment: false },
  ]);
  db().seed("journal_lines", [
    { entry_id: "e-a", account_id: "acc-1000", member_id: null, debit_cents: 50_000, credit_cents: 0 },
    { entry_id: "e-a", account_id: "acc-4000", member_id: null, debit_cents: 0, credit_cents: 50_000 },
    { entry_id: "e-b", account_id: "acc-1000", member_id: null, debit_cents: 999, credit_cents: 0 },
  ]);
  db().seed("coa_accounts", [{ id: "acc-1000", code: "1000", name: "Cash" }, { id: "acc-4000", code: "4000", name: "Other Income" }]);
  db().seed("capital_account_ledger", [{ property_id: A, member_key: IDS.b1, seq: 1, line_type: "income", amount_cents: 25_000, effective_date: "2026-04-30", balance_after_cents: 425_000 }]);
  db().seed("cpa_worksheet_flags", [{ id: "f-a", property_id: A, flag_type: "section_754_review", note: "A share was resold", created_at: "2026-05-01T00:00:00Z" }, { id: "f-b", property_id: B, flag_type: "section_754_review", note: "Other LLC", created_at: "2026-05-01T00:00:00Z" }]);
  wireRpc();
});
afterEach(() => vi.unstubAllEnvs());

// The mock rpc returns { __error } when the database would refuse: turn that into an error like the real client does.
beforeEach(() => {
  const original = db().rpc.bind(db());
  db().rpc = async (fn: string, args: any) => {
    const r = await original(fn, args);
    if (r.data && typeof r.data === "object" && "__error" in r.data) return { data: null, error: { message: r.data.__error } };
    return r;
  };
});

const designate = (o: Partial<Parameters<typeof cpa.designateCpa>[1]> = {}) => cpa.designateCpa(db(), { userId: USERS.admin, propertyId: A, name: "Pat Accountant", firm: "Accountant & Co", email: "Pat@Accountant.example", origin: "https://divieight.vercel.app", ...o });
const portal = () => cpa.cpaPortal(db(), { userId: CPA });
async function signedInCpa(property = A) {
  await designate({ propertyId: property });
  return portal();
}

describe("designating", () => {
  it("only the Manager; a valid email, name and firm; one CPA per LLC", async () => {
    await expect(designate({ userId: USERS.b1 })).rejects.toThrow("Only the Manager");
    await expect(designate({ email: "nope" })).rejects.toThrow("email");
    await expect(designate({ name: " " })).rejects.toThrow("name and firm");
    expect(invite).not.toHaveBeenCalled();
    await designate();
    await expect(designate({ email: "other@accountant.example" })).rejects.toThrow("already has a designated CPA");
    expect(invite).toHaveBeenCalledTimes(1); // the second was refused before anything was sent
  });

  it("sends the invite as a CPA login (existing auth), attaches it, and marks the login a CPA's", async () => {
    const r = await designate({ licenseNo: "CPA-1" });
    expect(r).toMatchObject({ invited: true });
    expect(invite).toHaveBeenCalledWith("pat@accountant.example", expect.objectContaining({ data: { account_type: "cpa", full_name: "Pat Accountant" }, redirectTo: "https://divieight.vercel.app/cpa/login" }));
    expect(calls.find(([f]) => f === "attach")![1]).toMatchObject({ _auth_user: CPA });
    expect(db().table("user_roles").some((x: any) => x.user_id === CPA && x.role === "cpa")).toBe(true);
    expect(calls.find(([f]) => f === "designate_cpa")![1]).toMatchObject({ _email: "pat@accountant.example", _license: "CPA-1", _actor: USERS.admin });
  });

  it("a CPA who already has a login (another LLC) keeps it and it is opened again", async () => {
    await designate();
    await cpa.rescindCpa(db(), { userId: USERS.admin, designationId: "des-1", reason: "Change of CPA" });
    expect(update).toHaveBeenLastCalledWith(CPA, { ban_duration: "876000h" });
    invite.mockClear();
    const r = await designate({ propertyId: A });
    expect(r.invited).toBe(false);
    expect(invite).not.toHaveBeenCalled();
    expect(update).toHaveBeenLastCalledWith(CPA, { ban_duration: "none" });
  });

  it("if the invite can't be sent the designation is rescinded again, so the LLC is not stuck", async () => {
    invite.mockResolvedValue({ data: null, error: { message: "smtp down" } });
    await expect(designate()).rejects.toThrow("invite could not be sent");
    expect(designations()[0]).toMatchObject({ status: "rescinded" });
    expect(designations()[0].reason).toContain("invite could not be completed");
    invite.mockResolvedValue({ data: { user: { id: CPA } }, error: null });
    await expect(designate()).resolves.toMatchObject({ invited: true });
  });
});

describe("rescinding", () => {
  it("only the Manager, with a reason; access ends at once, the login is closed and the CPA role removed", async () => {
    await signedInCpa();
    expect(active(A)).toBe(true);
    await expect(cpa.rescindCpa(db(), { userId: USERS.b1, designationId: "des-1", reason: "x" })).rejects.toThrow("Only the Manager");
    const r = await cpa.rescindCpa(db(), { userId: USERS.admin, designationId: "des-1", reason: "Dissolution" });
    expect(r).toEqual({ rescinded: true, loginClosed: true });
    expect(active(A)).toBe(false);
    expect(update).toHaveBeenCalledWith(CPA, { ban_duration: "876000h" });
    expect(db().table("user_roles").some((x: any) => x.role === "cpa")).toBe(false);
    expect(calls.find(([f]) => f === "rescind")![1]).toMatchObject({ _reason: "Dissolution", _actor: USERS.admin });
  });

  it("every read fails on the very next call, whatever the CPA was doing", async () => {
    await signedInCpa();
    const reads: Array<[string, () => Promise<unknown>]> = [
      ["ledger", () => cpa.cpaLedger(db(), { userId: CPA, propertyId: A, year: 2026 })],
      ["capital", () => cpa.cpaCapitalAccounts(db(), { userId: CPA, propertyId: A, year: 2026 })],
      ["statements", () => cpa.cpaStatements(db(), { userId: CPA, propertyId: A })],
      ["statement", () => cpa.cpaReadStatement(db(), { userId: CPA, statementId: "st-a-issued" })],
      ["pdf", () => cpa.cpaStatementPdf(db(), { userId: CPA, statementId: "st-a-issued" })],
      ["worksheet", () => cpa.cpaWorksheet(db(), { userId: CPA, propertyId: A })],
      ["packets", () => cpa.cpaPackets(db(), { userId: CPA, propertyId: A })],
      ["roster", () => cpa.cpaRoster(db(), { userId: CPA, propertyId: A })],
      ["tin", () => cpa.cpaRevealTin(db(), { userId: CPA, propertyId: A, w9Id: "w9-a1" })],
    ];
    for (const [name, read] of reads) await expect(read(), `${name} before`).resolves.toBeDefined();
    await cpa.rescindCpa(db(), { userId: USERS.admin, designationId: "des-1", reason: "Change of CPA" });
    for (const [name, read] of reads) await expect(read(), `${name} after`).rejects.toThrow(/Not authorized|Statement not found/);
    expect((await portal()).designations).toEqual([]); // and the portal shows nothing
    expect(audits("cpa.w9_tin_viewed")).toHaveLength(1); // only the view made while they had access
  });

  it("the login stays open if the same person is still the CPA of another LLC", async () => {
    await designate();
    await designate({ propertyId: B });
    await portal();
    const r = await cpa.rescindCpa(db(), { userId: USERS.admin, designationId: "des-1", reason: "Dissolution" });
    expect(r).toEqual({ rescinded: true, loginClosed: false });
    expect(update).not.toHaveBeenCalledWith(CPA, { ban_duration: "876000h" });
    expect(active(B)).toBe(true);
  });

  it("if closing the login fails the access is still gone (the database cut it first)", async () => {
    await signedInCpa();
    update.mockRejectedValue(new Error("auth down"));
    expect(await cpa.rescindCpa(db(), { userId: USERS.admin, designationId: "des-1", reason: "Done" })).toEqual({ rescinded: true, loginClosed: false });
    await expect(cpa.cpaLedger(db(), { userId: CPA, propertyId: A, year: 2026 })).rejects.toThrow("Not authorized");
  });
});

describe("the CPA reads one LLC, read-only", () => {
  it("the portal activates an invitation on first sign-in and lists only what the login is designated to", async () => {
    await designate();
    expect(designations()[0].status).toBe("invited");
    const r = await portal();
    expect(designations()[0].status).toBe("active");
    expect(r.designations).toEqual([expect.objectContaining({ propertyId: A, cpaName: "Pat Accountant", firm: "Accountant & Co" })]);
    expect((await cpa.cpaPortal(db(), { userId: "u-someone" })).designations).toEqual([]);
  });

  it("the general ledger and the capital accounts are this LLC's only", async () => {
    await signedInCpa();
    const l = await cpa.cpaLedger(db(), { userId: CPA, propertyId: A, year: 2026 });
    expect(l.entries.map((e) => e.memo)).toEqual(["Rent"]);
    expect(l.totals).toEqual({ debitCents: 50_000, creditCents: 50_000 });
    expect(JSON.stringify(l)).not.toContain("Secret other LLC");
    const c = await cpa.cpaCapitalAccounts(db(), { userId: CPA, propertyId: A, year: 2026 });
    expect(c.members[0]).toMatchObject({ name: "Ann Member", beginningCents: 0, endingCents: 355_000, distributionsCents: -30_000 });
  });

  it("another LLC, an owner, the Manager's own session and a stranger are all refused, with the same answer", async () => {
    await signedInCpa();
    for (const [who, property] of [[CPA, B], [USERS.b1, A], [USERS.admin, A], ["u-stranger", A]] as const) {
      await expect(cpa.cpaLedger(db(), { userId: who, propertyId: property, year: 2026 }), `${who} ${property}`).rejects.toThrow("Not authorized");
      await expect(cpa.cpaWorksheet(db(), { userId: who, propertyId: property })).rejects.toThrow("Not authorized");
      await expect(cpa.cpaRoster(db(), { userId: who, propertyId: property })).rejects.toThrow("Not authorized");
    }
  });

  it("a database that can't answer is a refusal", async () => {
    await signedInCpa();
    db().rpcResults.is_property_cpa = () => {
      throw new Error("connection lost");
    };
    await expect(cpa.cpaLedger(db(), { userId: CPA, propertyId: A, year: 2026 })).rejects.toThrow("Not authorized");
  });

  it("statements: issued and superseded only, every member; a draft or another LLC's statement is 'not found'; the PDF download is logged", async () => {
    await signedInCpa();
    expect((await cpa.cpaStatements(db(), { userId: CPA, propertyId: A })).statements.map((s) => s.id)).toEqual(["st-a-issued"]);
    for (const id of ["st-a-draft", "st-b", "nope"]) await expect(cpa.cpaReadStatement(db(), { userId: CPA, statementId: id }), id).rejects.toThrow("Statement not found.");
    for (const id of ["st-a-draft", "st-b", "nope"]) await expect(cpa.cpaStatementPdf(db(), { userId: CPA, statementId: id }), id).rejects.toThrow("Statement not found.");
    expect((await cpa.cpaReadStatement(db(), { userId: CPA, statementId: "st-a-issued" })).holder).toBe("Ann Member");
    const f = await cpa.cpaStatementPdf(db(), { userId: CPA, statementId: "st-a-issued" });
    expect(f.filename).toBe("statement-2026-10-v1.pdf");
    expect(Buffer.from(f.base64, "base64").toString("latin1").startsWith("%PDF-1.4")).toBe(true);
    expect(audits("cpa.statement_downloaded")[0]).toMatchObject({ actor_id: CPA, actor_type: "cpa", metadata: expect.objectContaining({ property_id: A, period: "2026-10" }) });
  });

  it("the worksheet shows this LLC's flags, and the packet list is empty until packets exist", async () => {
    await signedInCpa();
    expect((await cpa.cpaWorksheet(db(), { userId: CPA, propertyId: A })).flags.map((f) => f.note)).toEqual(["A share was resold"]);
    expect(await cpa.cpaPackets(db(), { userId: CPA, propertyId: A })).toEqual({ packets: [] });
  });

  it("the roster is legal names and TIN kind, never a TIN or an email", async () => {
    await signedInCpa();
    const r = await cpa.cpaRoster(db(), { userId: CPA, propertyId: A });
    expect(r.members).toEqual([{ w9Id: "w9-a1", legalName: "Ann Member", tinKind: "ssn", accountShares: 1 }]);
    expect(JSON.stringify(r)).not.toMatch(/123|@/);
  });

  it("the CPA writes nothing: the read functions only ever read, apart from their audit rows", () => {
    const src = readFileSync("src/lib/cpa.server.ts", "utf8");
    const reads = src.slice(src.indexOf("The CPA: read-only, one LLC"));
    expect(reads).not.toMatch(/\.(update|delete|upsert)\(/);
    expect(reads.match(/\.insert\(/g)).toHaveLength(1); // the audit helper
    expect(reads).not.toMatch(/\.rpc\("(?!is_property_cpa|activate_cpa_designations|capital_roll_forward)/);
    // and the CPA's own login has no way to the tables: no policy mentions a CPA, no grant
    const sql = readFileSync("cpa-credential.sql", "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(sql).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*TO[^;]*authenticated/i);
    expect(sql).not.toMatch(/ON public\.(journal_entries|journal_lines|capital_account_ledger|monthly_statements)/);
  });
});

describe("a TIN view is audit logged, and only inside the CPA's LLC", () => {
  it("shows the TIN for a member of this LLC, logs who, when, why and which LLC (never the TIN), every time", async () => {
    await signedInCpa();
    const r = await cpa.cpaRevealTin(db(), { userId: CPA, propertyId: A, w9Id: "w9-a1" });
    expect(r).toEqual({ tin: "123-45-6789", legalName: "Ann Member", tinKind: "ssn" });
    await cpa.cpaRevealTin(db(), { userId: CPA, propertyId: A, w9Id: "w9-a1", note: "1065 prep" });
    const log = audits("cpa.w9_tin_viewed");
    expect(log).toHaveLength(2); // each view is its own entry
    expect(log[0]).toMatchObject({ actor_id: CPA, actor_type: "cpa", entity_type: "member_w9", entity_id: "w9-a1" });
    expect(log[0].metadata).toMatchObject({ property_id: A, reason: "K-1 preparation (CPA permissible purpose)" });
    expect(log[1].metadata.reason).toContain("1065 prep");
    expect(log[0].metadata.at).toBeTruthy();
    expect(JSON.stringify(db().table("audit_log"))).not.toMatch(/123-?45-?6789/);
  });

  it("refuses another LLC's member, and a W-9 that doesn't exist, without logging a view or saying why", async () => {
    await signedInCpa();
    await expect(cpa.cpaRevealTin(db(), { userId: CPA, propertyId: A, w9Id: "w9-b3" })).rejects.toThrow("Not authorized");
    await expect(cpa.cpaRevealTin(db(), { userId: CPA, propertyId: B, w9Id: "w9-b3" })).rejects.toThrow("Not authorized");
    await expect(cpa.cpaRevealTin(db(), { userId: CPA, propertyId: A, w9Id: "nope" })).rejects.toThrow("Not authorized");
    expect(audits("cpa.w9_tin_viewed")).toHaveLength(0);
  });

  it("if the audit row can't be written nothing is shown; and no failure ever carries the TIN", async () => {
    await signedInCpa();
    const original = db().from.bind(db());
    db().from = (t: string) => {
      const q = original(t);
      if (t === "audit_log") q.insert = async () => ({ error: { message: `could not write ${DIGITS}` } });
      return q;
    };
    const err = await cpa.cpaRevealTin(db(), { userId: CPA, propertyId: A, w9Id: "w9-a1" }).catch((e) => e as Error);
    expect((err as Error).message).toBe("The TIN could not be shown.");
    expect((err as Error).message).not.toContain(DIGITS);
  });

  it("a tampered ciphertext fails with a message that says nothing about it", async () => {
    await signedInCpa();
    (db().table("member_w9_tin_secrets") as any[])[0].ciphertext = Buffer.from("tampered!!!!").toString("base64");
    const err = await cpa.cpaRevealTin(db(), { userId: CPA, propertyId: A, w9Id: "w9-a1" }).catch((e) => e as Error);
    expect((err as Error).message).toBe("The TIN could not be shown.");
  });

  it("the TIN is decrypted in exactly the one existing function", () => {
    const src = readFileSync("src/lib/cpa.server.ts", "utf8");
    expect(src).not.toMatch(/decryptPii|decryptTinForTaxExport|member_w9_tin_secrets/);
  });
});

describe("what members see", () => {
  it("the CPA's name and firm and since when, for an owner of the LLC only, and nothing else", async () => {
    await signedInCpa();
    const r = await cpa.ownerCpa(db(), { userId: USERS.b1, propertyId: A });
    expect(r).toMatchObject({ allowed: true, cpa: { name: "Pat Accountant", firm: "Accountant & Co" } });
    if (!r.allowed || !r.cpa) throw new Error("expected a CPA");
    expect(Object.keys(r.cpa).sort()).toEqual(["firm", "name", "since"]);
    expect(JSON.stringify(r)).not.toMatch(/pat@|CPA-/i);
    expect(await cpa.ownerCpa(db(), { userId: USERS.b3, propertyId: A })).toEqual({ allowed: false });
    expect(await cpa.ownerCpa(db(), { userId: "u-stranger", propertyId: A })).toEqual({ allowed: false });
  });

  it("none once the CPA is rescinded; and the Manager sees the history with reasons", async () => {
    await signedInCpa();
    await cpa.rescindCpa(db(), { userId: USERS.admin, designationId: "des-1", reason: "Change of CPA" });
    expect(await cpa.ownerCpa(db(), { userId: USERS.b1, propertyId: A })).toEqual({ allowed: true, cpa: null });
    const board = await cpa.designationBoard(db(), { userId: USERS.admin, propertyId: A });
    expect(board.current).toBeNull();
    expect(board.history[0]).toMatchObject({ name: "Pat Accountant", reason: "Change of CPA", email: "pat@accountant.example" });
    await expect(cpa.designationBoard(db(), { userId: USERS.b1, propertyId: A })).rejects.toThrow("Only the Manager");
  });

  it("the screens carry the flow", () => {
    expect(readFileSync("src/routes/admin.books.$propertyId.tsx", "utf8")).toContain("Designate and invite");
    expect(readFileSync("src/routes/admin.books.$propertyId.tsx", "utf8")).toContain("Rescind now");
    expect(readFileSync("src/routes/cpa.index.tsx", "utf8")).toContain("Show TIN (logged)");
    expect(readFileSync("src/lib/account-routing.ts", "utf8")).toContain('metaRole === "cpa"');
    expect(readFileSync("src/routes/owner.properties.$propertyId.capital.tsx", "utf8")).toContain("DesignatedCpaCard");
  });
});
