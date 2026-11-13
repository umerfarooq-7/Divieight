/**
 * Month 6, Prompt 13, the app side: the Broker of Record gate (refused at the Disbursement Check, a W-8 satisfies it for a non-US broker), the broker's
 * form and its sealed TIN, the tax vault, influencers and the 1099-NEC export (only payees at or over the threshold), the Tax-Ready Folder, and the
 * promise that a TIN never appears in a log, an error or a client response.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { harness } from "./setup";
import { IDS, USERS, seedPod } from "./fixtures";
import { seedClosing } from "./closing-fixture";
import { checkCommissionPaymentGate } from "@/lib/payment-gate";
import { generateAndTransmit, latestSourceOfTruth } from "@/lib/settlement.server";
import { enterTitleFigures, runDisbursementCheck } from "@/lib/disbursement-check.server";
import * as tax from "@/lib/tax-forms.server";
import { decryptPii, encryptPii } from "@/lib/pii-crypto.server";
import { BROKER_TAX_FORM_LINK, INFLUENCER_THRESHOLD_CENTS, formExpiry, gateMessage, gateStateFromForms, requiredFormType, tinProblem, type FormRow } from "@/lib/tax-forms";
import { LAUNCH_ITEMS } from "@/lib/launch-readiness";

const db = () => harness.db as any;
const KEY = randomBytes(32).toString("base64");
const FOUNDER = "u-founder";
const P = "11111111-1111-4111-8111-aaaaaaaaaaaa";
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------------------------------------------------
// The pure rules
// ---------------------------------------------------------------------------------------------------------
describe("the rules", () => {
  it("US persons and entities use a W-9; a non-US individual a W-8BEN; a non-US entity a W-8BEN-E", () => {
    expect(requiredFormType(true, "individual")).toBe("W-9");
    expect(requiredFormType(true, "entity")).toBe("W-9");
    expect(requiredFormType(false, "individual")).toBe("W-8BEN");
    expect(requiredFormType(false, "entity")).toBe("W-8BEN-E");
  });

  it("a W-8 lapses at the end of the third calendar year after it was signed; a W-9 never does", () => {
    expect(formExpiry("W-8BEN", "2026-03-01T00:00:00Z")).toBe("2029-12-31");
    expect(formExpiry("W-8BEN-E", "2026-12-31T23:59:59Z")).toBe("2029-12-31");
    expect(formExpiry("W-9", "2026-03-01T00:00:00Z")).toBeNull();
  });

  it("a TIN is checked for its shape, and the message never carries it", () => {
    expect(tinProblem("ssn", "123-45-6789")).toBeNull();
    expect(tinProblem("ein", "12-3456789")).toBeNull();
    expect(tinProblem("itin", "912-34-5678")).toBeNull();
    for (const [kind, v] of [["ssn", "123"], ["ssn", "000-12-3456"], ["ssn", "666-12-3456"], ["ssn", "123-00-6789"], ["ssn", "123-45-0000"], ["itin", "123-45-6789"], ["ein", "00-1234567"], ["ein", "07-1234567"]] as const) {
      const msg = tinProblem(kind, v);
      expect(msg, `${kind} ${v}`).not.toBeNull();
      expect(msg!).not.toContain(v);
    }
    expect(tinProblem("foreign_tin", "GB 123456")).toBeNull();
    expect(tinProblem("foreign_tin", "x")).not.toBeNull();
  });

  it("the gate: valid clears; no form, an expired W-8, a rejected form and a superseded-only history do not", () => {
    const f = (o: Partial<FormRow>): FormRow => ({ id: "f", form_type: "W-9", status: "valid", expiry_date: null, created_at: "2026-01-01T00:00:00Z", ...o });
    expect(gateStateFromForms([f({})], "2030-01-01")).toMatchObject({ allowed: true, state: "valid" });
    expect(gateStateFromForms([], "2026-06-01")).toMatchObject({ allowed: false, state: "missing", code: "tax_form_missing" });
    expect(gateStateFromForms([f({ form_type: "W-8BEN", expiry_date: "2029-12-31" })], "2029-12-31")).toMatchObject({ allowed: true });
    expect(gateStateFromForms([f({ form_type: "W-8BEN", expiry_date: "2029-12-31" })], "2030-01-01")).toMatchObject({ allowed: false, state: "expired", code: "tax_form_expired", expiry: "2029-12-31" });
    expect(gateStateFromForms([f({ status: "rejected" })], "2026-06-01")).toMatchObject({ allowed: false, state: "rejected", code: "tax_form_rejected" });
    expect(gateStateFromForms([f({ status: "superseded" })], "2026-06-01")).toMatchObject({ allowed: false, state: "missing" });
    expect(gateStateFromForms([f({ id: "old", status: "superseded" }), f({ id: "new" })], "2026-06-01")).toMatchObject({ allowed: true });
    expect(gateMessage("tax_form_missing")).toMatch(/^Tax form missing/);
  });

  it("the threshold is $600.00 and the filing assumption is on the launch readiness page", () => {
    expect(INFLUENCER_THRESHOLD_CENTS).toBe(60_000);
    const item = LAUNCH_ITEMS.find((i) => i.key === "influencer_1099_filing");
    expect(item).toMatchObject({ status: "Placeholder" });
    expect(item!.detail).toMatch(/ASSUMPTION.*does not file with the IRS/s);
  });
});

// ---------------------------------------------------------------------------------------------------------
// The gate where it is used
// ---------------------------------------------------------------------------------------------------------
const form = (broker: string, o: Record<string, unknown> = {}) => ({ id: `tf-${broker}-${Math.random()}`, broker_id: broker, form_type: "W-9", status: "valid", expiry_date: null, created_at: "2026-01-01T00:00:00Z", ...o });
const setForms = (rows: Array<Record<string, unknown>>) => {
  const t = db().table("broker_tax_forms") as any[];
  t.length = 0;
  t.push(...rows);
};

describe("the payout gate", () => {
  beforeEach(() => seedPod(db()));

  it("a broker with no form is refused: 'Tax form missing', with the link the broker fixes it at; a valid W-9 clears them", async () => {
    const r = await checkCommissionPaymentGate(IDS.broker, db());
    expect(r).toMatchObject({ allowed: false, code: "tax_form_missing", link: BROKER_TAX_FORM_LINK });
    expect(r.reason).toMatch(/^Tax form missing/);
    setForms([form(IDS.broker)]);
    expect(await checkCommissionPaymentGate(IDS.broker, db())).toEqual({ allowed: true });
  });

  it("a W-8 satisfies the gate for a non-US broker, until it lapses; then the broker is blocked again", async () => {
    setForms([form(IDS.broker, { form_type: "W-8BEN-E", expiry_date: "2029-12-31" })]);
    expect((await checkCommissionPaymentGate(IDS.broker, db(), "2027-06-01")).allowed).toBe(true);
    const lapsed = await checkCommissionPaymentGate(IDS.broker, db(), "2030-01-01");
    expect(lapsed).toMatchObject({ allowed: false, code: "tax_form_expired", link: BROKER_TAX_FORM_LINK });
    expect(lapsed.reason).toContain("2029-12-31");
  });

  it("a rejected form blocks, and the old 'verified' flag that a broker's own browser used to set clears nothing", async () => {
    db().table("brokers").find((b: any) => b.id === IDS.broker).tax_form_verified = true;
    expect((await checkCommissionPaymentGate(IDS.broker, db())).allowed).toBe(false);
    setForms([form(IDS.broker, { status: "rejected" })]);
    expect(await checkCommissionPaymentGate(IDS.broker, db())).toMatchObject({ allowed: false, code: "tax_form_rejected" });
  });

  it("fails closed: no broker, an unknown broker, or a database that can't say", async () => {
    expect((await checkCommissionPaymentGate("", db())).allowed).toBe(false);
    expect((await checkCommissionPaymentGate("nope", db())).allowed).toBe(false);
    const broken = { from: (t: string) => (t === "broker_tax_forms" ? { select: () => ({ eq: async () => ({ data: null, error: { message: "boom" } }) }) } : db().from(t)) };
    expect(await checkCommissionPaymentGate(IDS.broker, broken)).toMatchObject({ allowed: false, code: "tax_form_missing" });
  });

  it("the gate reads the forms, never the old flag, and no client code sets that flag any more", () => {
    const src = readFileSync("src/lib/payment-gate.ts", "utf8").split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*")).join("\n");
    expect(src).toContain("broker_tax_forms");
    expect(src).not.toMatch(/\.select\([^)]*tax_form_verified/);
    expect(readFileSync("src/lib/broker.ts", "utf8")).not.toMatch(/patch\.tax_form_verified/);
  });
});

describe("the Disbursement Check refuses a payout without a valid form", () => {
  const exact = (payees: Array<{ brokerId: string; amountCents: number }>) => payees.map((p) => ({ payeeReference: p.brokerId, amount: p.amountCents / 100 }));
  async function ready() {
    await seedClosing();
    const r = await generateAndTransmit(db(), USERS.admin, IDS.property);
    if (r.status !== "transmitted") throw new Error("SoT not generated");
    const payees = (await latestSourceOfTruth(db(), IDS.property))!.structured.payees;
    await enterTitleFigures(db(), USERS.admin, IDS.property, exact(payees), null);
    return payees;
  }
  const formOf = (broker: string) => (db().table("broker_tax_forms") as any[]).find((f) => f.broker_id === broker)!;

  it("passes when every amount matches and every payee has a valid form", async () => {
    await ready();
    const r = await runDisbursementCheck(db(), IDS.property);
    expect(r.status).toBe("pass");
    expect(r.lines.every((l) => l.taxForm?.ok)).toBe(true);
  });

  it("FAILS, though every amount matches to the cent, when a payee has no tax form: 'Tax form missing' and the link for the broker", async () => {
    await ready();
    (db().table("broker_tax_forms") as any[]).splice((db().table("broker_tax_forms") as any[]).findIndex((f) => f.broker_id === "broker-2"), 1);
    const r = await runDisbursementCheck(db(), IDS.property);
    expect(r.status).toBe("fail");
    expect(r.lines.every((l) => l.match)).toBe(true);
    const d = r.differences.find((x) => x.kind === "tax_form_missing")!;
    expect(d).toMatchObject({ brokerId: "broker-2", brokerage: "Summit Realty", link: BROKER_TAX_FORM_LINK });
    expect(d.detail).toMatch(/^Tax form missing/);
    expect(r.report).toContain("Tax form missing");
    expect(r.report).toContain(BROKER_TAX_FORM_LINK);
    expect(r.report).toContain("The wire must not proceed");
    expect(db().audits("disbursement_check.failed")).toHaveLength(1);
  });

  it("a W-8BEN-E satisfies it for a non-US broker; once it lapses the check fails again; a rejected form fails it", async () => {
    await ready();
    Object.assign(formOf("broker-2"), { form_type: "W-8BEN-E", expiry_date: "2099-12-31" });
    expect((await runDisbursementCheck(db(), IDS.property)).status).toBe("pass");
    formOf("broker-2").expiry_date = "2020-12-31";
    const lapsed = await runDisbursementCheck(db(), IDS.property);
    expect(lapsed.status).toBe("fail");
    expect(lapsed.differences.map((d) => d.kind)).toContain("tax_form_expired");
    Object.assign(formOf("broker-2"), { expiry_date: "2099-12-31", status: "rejected" });
    expect((await runDisbursementCheck(db(), IDS.property)).differences.map((d) => d.kind)).toContain("tax_form_rejected");
  });

  it("the Settlement preconditions block it too, with the same reason", async () => {
    await ready();
    const { settlementPreconditions } = await import("@/lib/settlement.server");
    expect((await settlementPreconditions(db(), IDS.property)).filter((b) => b.code === "broker_payment_gate")).toEqual([]);
    formOf("broker-2").status = "rejected";
    const blockers = (await settlementPreconditions(db(), IDS.property)).filter((b) => b.code === "broker_payment_gate");
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.message).toContain("Summit Realty");
    expect(blockers[0]!.message).toMatch(/Tax form rejected/);
  });
});

// ---------------------------------------------------------------------------------------------------------
// The broker's form, the vault, influencers, the folder
// ---------------------------------------------------------------------------------------------------------
const logs: string[] = [];
let rpcCalls: Array<[string, Record<string, any>]> = [];
const store = new Map<string, Uint8Array>();
const audits = (a: string) => (db().table("audit_log") as any[]).filter((x) => x.action_type === a);

function wire() {
  const d = db();
  d.rpcResults.has_role = (a: { _user_id: string; _role: string }) => (a._role === "admin" ? [USERS.admin, FOUNDER].includes(a._user_id) : a._role === "founder" ? a._user_id === FOUNDER : false);
  d.rpcResults.has_tax_vault_access = (a: { _user: string }) => a._user === FOUNDER || (d.table("tax_vault_grants") as any[]).some((g) => g.user_id === a._user && !g.revoked_at);
  d.rpcResults.record_broker_tax_form = vi.fn((a: any) => {
    rpcCalls.push(["record_broker_tax_form", a]);
    for (const f of d.table("broker_tax_forms") as any[]) if (f.broker_id === a._broker && f.status === "valid") f.status = "superseded";
    (d.table("broker_tax_forms") as any[]).push({ ...a._form, broker_id: a._broker, status: "valid", tin_last4: a._form.tin_last4 });
    if (a._secret) (d.table("broker_tax_form_secrets") as any[]).push({ form_id: a._form.id, ...a._secret });
    return a._form.id;
  });
  d.rpcResults.log_tax_vault_read = vi.fn((a: any) => {
    (d.table("audit_log") as any[]).push({ actor_id: a._actor, action_type: a._action, entity_type: a._entity_type, entity_id: a._id, metadata: a._meta });
  });
  d.rpcResults.reject_broker_tax_form = vi.fn();
  d.rpcResults.save_influencer_payee = vi.fn((a: any) => {
    rpcCalls.push(["save_influencer_payee", a]);
    const rows = d.table("influencer_payees") as any[];
    const row = { id: a._id, name: a._payee.name, tax_form_type: a._payee.tax_form_type, tax_form_status: a._payee.tax_form_type ? "valid" : "missing", is_us_person: a._payee.tax_form_type ? a._payee.tax_form_type === "W-9" : null, country: a._payee.country, address: a._payee.address, tin_kind: a._payee.tin_kind, tin_last4: a._payee.tin_last4 };
    const i = rows.findIndex((r) => r.id === a._id);
    if (i >= 0) rows[i] = row;
    else rows.push(row);
    if (a._secret) (d.table("influencer_payee_secrets") as any[]).push({ payee_id: a._id, ...a._secret });
    return a._id;
  });
  d.rpcResults.record_influencer_payment = vi.fn((a: any) => {
    rpcCalls.push(["record_influencer_payment", a]);
    const id = `pay-${(d.table("influencer_payments") as any[]).length + 1}`;
    (d.table("influencer_payments") as any[]).push({ id, payee_id: a._payee, amount_cents: a._amount_cents, paid_at: a._paid_at, year: Number(String(a._paid_at).slice(0, 4)), memo: a._memo, voided_at: null });
    return id;
  });
  // The same rule as influencer_annual_summary in tax-forms.sql (tested there against a real Postgres), so the app's export can be checked end to end.
  d.rpcResults.influencer_annual_summary = (a: { _year: number }) => {
    const out: any[] = [];
    for (const p of d.table("influencer_payees") as any[]) {
      const mine = (d.table("influencer_payments") as any[]).filter((x) => x.payee_id === p.id && x.year === a._year && !x.voided_at);
      if (mine.length === 0) continue;
      const total = mine.reduce((n, x) => n + Number(x.amount_cents), 0);
      const treatment = total < 60_000 ? "below_threshold" : p.is_us_person === false ? "w8_flag_for_cpa" : "1099_nec";
      out.push({ payee_id: p.id, name: p.name, address: p.address, country: p.country, tax_form_type: p.tax_form_type, form_status: p.tax_form_status, tin_last4: p.tin_last4, payments: mine.length, total_cents: total, treatment, issue: treatment === "w8_flag_for_cpa" ? `Non-US payee on a ${p.tax_form_type}: no 1099-NEC. Flagged for the CPA.` : treatment === "1099_nec" && p.tax_form_status !== "valid" ? "No valid tax form on file: collect a W-9." : null });
    }
    return out.sort((x, y) => x.name.localeCompare(y.name));
  };
  d.rpcResults.tax_ready_sections = () => ({
    year: 2025,
    shares: [{ share_number: 1, year_end_holder_key: "mem-b", days_accounted_for: 365, periods: [{ holder_key: "mem-a", from: "2025-01-01", to: "2025-06-14", days: 165 }, { holder_key: "mem-b", from: "2025-06-15", to: "2025-12-31", days: 200 }] }],
    members: [{ member_key: "mem-a", year_end_shares: 0, share_days: 165, percent_of_share_days: "45.2055" }, { member_key: "mem-b", year_end_shares: 1, share_days: 200, percent_of_share_days: "54.7945" }],
    transfers: [{ share_number: 1, date: "2025-06-15", transferor_member_key: "mem-a", transferee_member_key: "mem-b", resale_transaction_id: "rt-1" }],
    sales_1099s: [{ resale_transaction_id: "rt-1", date: "2025-06-15", share_number: 1, transferor_member_key: "mem-a", transferee_member_key: "mem-b", gross_proceeds_cents: 200_000, property_address: "5632 Independence Ave" }],
    reconciliation: { total_shares: 1, year_end_shares: 1, days_in_year: 365, share_days_total: 365, share_days_expected: 365, reconciled: true },
  });
  d.rpcResults.holder_shares_as_of = () => [{ member_id: "mem-b", shares: 1 }];
  d.rpcResults.record_tax_ready_folder = vi.fn((a: any) => {
    const version = (d.table("tax_ready_folders") as any[]).filter((x) => x.property_id === a._property && x.year === a._year).length + 1;
    const hash = sha(JSON.stringify(a._data));
    (d.table("tax_ready_folders") as any[]).push({ id: a._id, property_id: a._property, year: a._year, version, data: a._data, hash, generated_by: a._actor, generated_at: new Date().toISOString(), files: [] });
    return { id: a._id, version, hash };
  });
  d.rpcResults.set_tax_ready_files = (a: any) => {
    (d.table("tax_ready_folders") as any[]).find((x) => x.id === a._id).files = a._files;
  };
  d.rpcResults.sync_broker_tax_flag = vi.fn();
  d.storage = {
    from: (bucket: string) => ({
      upload: async (path: string, blob: Blob) => (store.set(`${bucket}/${path}`, new Uint8Array(await blob.arrayBuffer())), { data: { path }, error: null }),
      download: async (path: string) => (store.has(`${bucket}/${path}`) ? { data: new Blob([store.get(`${bucket}/${path}`) as BlobPart]), error: null } : { data: null, error: { message: "nf" } }),
    }),
  };
}

const setup = () => {
  vi.stubEnv("W9_TIN_ENCRYPTION_KEY", KEY);
  seedPod(db());
  store.clear();
  rpcCalls = [];
  logs.length = 0;
  for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")));
  db().table("brokers").find((b: any) => b.id === IDS.broker).email = "broker@test.local";
  for (const t of ["broker_tax_forms", "broker_tax_form_secrets", "influencer_payees", "influencer_payee_secrets", "influencer_payments", "tax_ready_folders", "tax_vault_grants"]) db().seed(t, []);
  wire();
};
const teardown = () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
};

const brokerForm = (o: Partial<Parameters<typeof tax.submitBrokerTaxForm>[1]> = {}) => ({
  userId: USERS.broker, isUsPerson: true, entityKind: "entity" as const, legalName: "Lusk Homes LLC", address: "1 Main St, Lusk, WY 82225", country: "US", tinKind: "ein" as const, tin: "12-3456789", signedName: "Pat Broker", certified: true, now: new Date("2026-03-01T09:00:00Z"), ...o,
});
const NO_TIN = /123-?45-?6789|12-?3456789|123456789|587-?65-?4321|587654321|GB ?123456/;
const everything = () => JSON.stringify([rpcCalls.map(([f, a]) => [f, a._form ?? a._payee ?? a._data ?? null]), db().table("audit_log"), db().table("notifications"), logs]);

describe("the broker's own tax form", () => {
  beforeEach(setup);
  afterEach(teardown);
  it("a US entity's W-9: checked, the EIN sealed (the same AES-256-GCM as members' W-9s), only the last four in the clear, no expiry, and no TIN comes back", async () => {
    const r = await tax.submitBrokerTaxForm(db(), brokerForm());
    expect(r).toMatchObject({ formType: "W-9", expiry: null, last4: "6789", tinKind: "ein" });
    expect(JSON.stringify(r)).not.toMatch(NO_TIN);
    const sent = rpcCalls[0]![1];
    expect(sent._form).toMatchObject({ form_type: "W-9", is_us_person: true, entity_kind: "entity", country: "US", tin_kind: "ein", tin_last4: "6789", expiry_date: null, signed_name: "Pat Broker" });
    expect(JSON.stringify(sent._form)).not.toMatch(NO_TIN);
    expect(sent._secret).toMatchObject({ key_version: 1 });
    expect(JSON.stringify(sent._secret)).not.toContain("123456789");
    expect(decryptPii(sent._secret, `broker_tax_form:${sent._form.id}`)).toBe("123456789");
    expect(() => decryptPii(sent._secret, "broker_tax_form:another-form")).toThrow(); // bound to its own row
    expect(await checkCommissionPaymentGate(IDS.broker, db())).toEqual({ allowed: true });
  });

  it("a non-US individual signs a W-8BEN (valid to the end of the third year); an entity a W-8BEN-E; a country with no tax ID needs no ID", async () => {
    const individual = await tax.submitBrokerTaxForm(db(), brokerForm({ isUsPerson: false, entityKind: "individual", country: "gb", tinKind: null, tin: "GB 123456", legalName: "Pat Broker", signedName: "pat broker" }));
    expect(individual).toMatchObject({ formType: "W-8BEN", expiry: "2029-12-31", tinKind: "foreign_tin", last4: "3456" });
    const entity = await tax.submitBrokerTaxForm(db(), brokerForm({ isUsPerson: false, entityKind: "entity", country: "CA", tinKind: null, tin: null, noForeignTin: true }));
    expect(entity).toMatchObject({ formType: "W-8BEN-E", tinKind: "none", last4: null });
    expect(rpcCalls[1]![1]._secret).toBeNull();
    expect((db().table("broker_tax_forms") as any[]).map((f) => f.status)).toEqual(["superseded", "valid"]); // a new form supersedes the old
  });

  it("refuses what is wrong, with a message that never repeats the ID", async () => {
    const bad = (o: Partial<Parameters<typeof tax.submitBrokerTaxForm>[1]>) => tax.submitBrokerTaxForm(db(), brokerForm(o));
    await expect(bad({ userId: "u-nobody" })).rejects.toThrow("No Broker of Record account");
    await expect(bad({ certified: false })).rejects.toThrow("Certify");
    await expect(bad({ signedName: " " })).rejects.toThrow("Sign");
    await expect(bad({ legalName: " " })).rejects.toThrow("legal name");
    await expect(bad({ address: "" })).rejects.toThrow("address");
    await expect(bad({ country: "GB" })).rejects.toThrow("country is US");
    await expect(bad({ isUsPerson: false, country: "US", entityKind: "individual" })).rejects.toThrow("can't be US");
    await expect(bad({ country: "USA" })).rejects.toThrow("two-letter");
    await expect(bad({ tin: "12-345" })).rejects.toThrow("nine digits");
    await expect(bad({ tin: null })).rejects.toThrow("needs your SSN, EIN or ITIN");
    await expect(bad({ entityKind: "individual", legalName: "Pat Broker", signedName: "Someone Else", tinKind: "ssn", tin: "123-45-6789" })).rejects.toThrow("own legal name");
    await expect(bad({ isUsPerson: false, country: "GB", entityKind: "entity", tinKind: null, tin: null })).rejects.toThrow("foreign tax ID");
    vi.stubEnv("W9_TIN_ENCRYPTION_KEY", "");
    await expect(bad({})).rejects.toThrow("encryption key");
    expect(db().table("broker_tax_forms")).toHaveLength(0);
    expect(everything()).not.toMatch(NO_TIN);
  });

  it("what the broker sees of their form is its type, status, expiry and the last four, never the TIN", async () => {
    await tax.submitBrokerTaxForm(db(), brokerForm());
    const s = await tax.brokerTaxFormStatus(db(), { userId: USERS.broker, today: "2026-06-01" });
    expect(s).toMatchObject({ state: "valid", allowed: true, formType: "W-9", last4: "6789", legalName: "Lusk Homes LLC" });
    expect(JSON.stringify(s)).not.toMatch(NO_TIN);
    expect((await tax.brokerTaxFormStatus(db(), { userId: USERS.broker, today: "2099-01-01" })).state).toBe("valid"); // a W-9 doesn't lapse
  });
});

describe("the Manager's view, and the tax vault", () => {
  beforeEach(setup);
  afterEach(teardown);
  it("lists every Broker of Record and where they stand, with no PII; opening a form is logged", async () => {
    await tax.submitBrokerTaxForm(db(), brokerForm());
    await expect(tax.adminBrokerForms(db(), { userId: USERS.b1 })).rejects.toThrow("Only the Manager");
    const list = await tax.adminBrokerForms(db(), { userId: USERS.admin });
    expect(list.brokers[0]).toMatchObject({ id: IDS.broker, state: "valid", allowed: true, formType: "W-9" });
    expect(JSON.stringify(list)).not.toMatch(/Lusk Homes LLC|1 Main St|6789/);
    expect(audits("tax_form.viewed")).toHaveLength(0);
    const v = await tax.adminViewBrokerForm(db(), { userId: USERS.admin, brokerId: IDS.broker });
    expect(v).toMatchObject({ legalName: "Lusk Homes LLC", last4: "6789" });
    expect(JSON.stringify(v)).not.toMatch(NO_TIN);
    expect(audits("tax_form.viewed")[0]).toMatchObject({ actor_id: USERS.admin, entity_id: IDS.broker });
    await expect(tax.adminViewBrokerForm(db(), { userId: USERS.b1, brokerId: IDS.broker })).rejects.toThrow("Only the Manager");
  });

  it("rejecting a form is the Manager's, with a reason", async () => {
    await tax.submitBrokerTaxForm(db(), brokerForm());
    await expect(tax.rejectBrokerTaxForm(db(), { userId: USERS.b1, formId: "x", reason: "no" })).rejects.toThrow("Only the Manager");
    await tax.rejectBrokerTaxForm(db(), { userId: USERS.admin, formId: "f1", reason: "Name doesn't match" });
    expect(db().rpcResults.reject_broker_tax_form).toHaveBeenCalledWith(expect.objectContaining({ _id: "f1", _reason: "Name doesn't match", _actor: USERS.admin }));
  });

  it("a TIN is shown only to someone with the tax-vault permission, with a reason, logged first, and never in the log", async () => {
    const { formId } = await tax.submitBrokerTaxForm(db(), brokerForm());
    await expect(tax.revealBrokerTin(db(), { userId: USERS.admin, formId, reason: "CPA asked" })).rejects.toThrow("access to the tax vault"); // a regular admin
    await expect(tax.revealBrokerTin(db(), { userId: USERS.broker, formId, reason: "x" })).rejects.toThrow("access to the tax vault");
    await expect(tax.revealBrokerTin(db(), { userId: FOUNDER, formId, reason: " " })).rejects.toThrow("reason");
    expect(audits("tax_vault.broker_tax_form_tin_viewed")).toHaveLength(0);
    expect(await tax.revealBrokerTin(db(), { userId: FOUNDER, formId, reason: "CPA asked for the EIN" })).toEqual({ tin: "12-3456789" });
    expect(audits("tax_vault.broker_tax_form_tin_viewed")[0]).toMatchObject({ actor_id: FOUNDER, entity_id: formId, metadata: expect.objectContaining({ reason: "CPA asked for the EIN" }) });
    expect(JSON.stringify(db().table("audit_log"))).not.toMatch(NO_TIN);
    // granted access works; revoked access doesn't
    (db().table("tax_vault_grants") as any[]).push({ user_id: USERS.admin, revoked_at: null });
    expect((await tax.revealBrokerTin(db(), { userId: USERS.admin, formId, reason: "CPA liaison" })).tin).toBe("12-3456789");
    (db().table("tax_vault_grants") as any[])[0].revoked_at = "2026-01-01";
    await expect(tax.revealBrokerTin(db(), { userId: USERS.admin, formId, reason: "CPA liaison" })).rejects.toThrow("access to the tax vault");
  });

  it("if the log can't be written nothing is shown; a tampered ciphertext says nothing about it; no failure carries the TIN", async () => {
    const { formId } = await tax.submitBrokerTaxForm(db(), brokerForm());
    const original = db().from.bind(db());
    db().from = (t: string) => {
      const q = original(t);
      if (t === "audit_log") q.insert = async () => ({ error: { message: "cannot write 123456789" } });
      return q;
    };
    const err = (await tax.revealBrokerTin(db(), { userId: FOUNDER, formId, reason: "x" }).catch((e) => e)) as Error;
    expect(err.message).toBe("The tax ID can't be shown: the audit log could not be written.");
    db().from = original;
    (db().table("broker_tax_form_secrets") as any[])[0].ciphertext = Buffer.from("tampered!!!!").toString("base64");
    const err2 = (await tax.revealBrokerTin(db(), { userId: FOUNDER, formId, reason: "x" }).catch((e) => e)) as Error;
    expect(err2.message).toBe("The tax ID could not be shown.");
    expect(`${err.message}${err2.message}`).not.toMatch(NO_TIN);
  });

  it("the vault's own state, and the founder grants and revokes (the database checks who may)", async () => {
    expect(await tax.vaultStatus(db(), { userId: USERS.admin })).toMatchObject({ hasAccess: false, isFounder: false, grants: [] });
    expect(await tax.vaultStatus(db(), { userId: FOUNDER })).toMatchObject({ hasAccess: true, isFounder: true });
    db().rpcResults.grant_tax_vault_access = vi.fn();
    db().rpcResults.revoke_tax_vault_access = vi.fn();
    await tax.grantVaultAccess(db(), { userId: FOUNDER, targetUserId: USERS.admin, reason: "CPA liaison" });
    await tax.revokeVaultAccess(db(), { userId: FOUNDER, targetUserId: USERS.admin });
    expect(db().rpcResults.grant_tax_vault_access).toHaveBeenCalledWith(expect.objectContaining({ _user: USERS.admin, _reason: "CPA liaison", _actor: FOUNDER }));
    expect(db().rpcResults.revoke_tax_vault_access).toHaveBeenCalled();
  });
});

describe("influencers: paid directly, never through a Broker of Record", () => {
  beforeEach(setup);
  afterEach(teardown);
  const save = (o: Partial<Parameters<typeof tax.saveInfluencerPayee>[1]> = {}) => tax.saveInfluencerPayee(db(), { userId: USERS.admin, name: "Ivy Influencer", formType: "W-9", address: "5 Elm St, Austin, TX", tinKind: "ssn", tin: "123-45-6789", signedOn: "2026-01-10", ...o });
  const pay = (payeeId: string, amount: number, paidAt = "2026-04-01") => tax.recordInfluencerPayment(db(), { userId: USERS.admin, payeeId, amount, paidAt });

  it("a payee's TIN is sealed with the same encryption and bound to the payee; only the last four stay in the clear", async () => {
    const r = await save();
    expect(r.last4).toBe("6789");
    const sent = rpcCalls[0]![1];
    expect(sent._payee).toMatchObject({ name: "Ivy Influencer", tax_form_type: "W-9", country: "US", tin_kind: "ssn", tin_last4: "6789", form_signed_on: "2026-01-10", form_expiry_date: null });
    expect(decryptPii(sent._secret, `influencer_payee:${r.id}`)).toBe("123456789");
    expect(JSON.stringify(sent._payee)).not.toMatch(NO_TIN);
    const w8 = await save({ name: "Noor Abroad", formType: "W-8BEN", country: "ae", tinKind: "none", tin: null, signedOn: "2026-03-05" });
    expect(rpcCalls[1]![1]._payee).toMatchObject({ tax_form_type: "W-8BEN", country: "AE", tin_kind: "none", form_expiry_date: "2029-12-31" });
    expect(rpcCalls[1]![1]._secret).toBeNull();
    expect(w8.last4).toBeNull();
    const none = await save({ name: "No Form Yet", formType: null, tin: null, address: null, signedOn: null });
    expect(rpcCalls[2]![1]._payee).toMatchObject({ tax_form_type: null, tin_kind: null });
    expect(none.id).toBeTruthy();
  });

  it("only the Manager; a W-9 needs a US ID and a signed date; a W-8's country isn't the US", async () => {
    await expect(save({ userId: USERS.b1 })).rejects.toThrow("Only the Manager");
    await expect(save({ name: " " })).rejects.toThrow("name");
    await expect(save({ signedOn: null })).rejects.toThrow("signed");
    await expect(save({ address: "" })).rejects.toThrow("address");
    await expect(save({ tin: null })).rejects.toThrow("needs the payee");
    await expect(save({ tin: "123" })).rejects.toThrow("nine digits");
    await expect(save({ formType: "W-8BEN", country: "US", tin: null, tinKind: "none" })).rejects.toThrow("other than US");
    expect(db().table("influencer_payees")).toHaveLength(0);
  });

  it("payments need the Manager, a real amount and date; the summary is for the calendar year", async () => {
    const { id } = await save();
    await expect(tax.recordInfluencerPayment(db(), { userId: USERS.b1, payeeId: id, amount: 10, paidAt: "2026-04-01" })).rejects.toThrow("Only the Manager");
    await expect(pay(id, 0)).rejects.toThrow("above zero");
    await expect(pay(id, 10.005)).rejects.toThrow("two decimal");
    await expect(tax.recordInfluencerPayment(db(), { userId: USERS.admin, payeeId: id, amount: 5, paidAt: "April" })).rejects.toThrow("date");
    expect((await pay(id, 599.99)).cents).toBe(59_999);
  });

  it("the 1099-NEC export lists ONLY payees at or over $600.00: exactly $600.00 is in, $599.99 is out; a W-8 payee is flagged for the CPA and gets no 1099-NEC", async () => {
    const at = (await save({ name: "At Threshold", tin: "123-45-6781" })).id;
    const under = (await save({ name: "Under", tin: "123-45-6782" })).id;
    const over = (await save({ name: "Over The Line", tin: "123-45-6783" })).id;
    const abroad = (await save({ name: "Noor Abroad", formType: "W-8BEN", country: "AE", tinKind: "none", tin: null, signedOn: "2026-03-05" })).id;
    const noForm = (await save({ name: "No Form Yet", formType: null, tin: null, address: null, signedOn: null })).id;
    await pay(at, 600);
    await pay(under, 599.99);
    await pay(over, 400);
    await pay(over, 600.5);
    await pay(abroad, 5_000);
    await pay(noForm, 750);
    await pay(at, 9_999, "2025-12-31"); // last year: not in 2026
    const r = await tax.export1099Nec(db(), { userId: USERS.admin, year: 2026 });
    expect(r.payees.map((x) => [x.name, x.totalCents])).toEqual([["At Threshold", 60_000], ["No Form Yet", 75_000], ["Over The Line", 100_050]]);
    expect(r.payees.every((x) => x.totalCents >= INFLUENCER_THRESHOLD_CENTS)).toBe(true);
    expect(r.payees.map((x) => x.name)).not.toContain("Under");
    expect(r.flaggedForCpa.map((x) => [x.name, x.treatment])).toEqual([["Noor Abroad", "w8_flag_for_cpa"]]);
    expect(r.payees.find((x) => x.name === "No Form Yet")!.issue).toContain("collect a W-9");
    // the files: the same payees, the amount as dollars, and no TIN
    expect(r.csv.split("\r\n").filter(Boolean)).toHaveLength(1 + 3);
    expect(r.csv).toContain("At Threshold");
    expect(r.csv).toContain("600.00");
    expect(r.csv).not.toContain("Noor Abroad");
    expect(r.json.payees).toHaveLength(3);
    expect(r.json.flagged_for_cpa).toEqual([expect.objectContaining({ name: "Noor Abroad", tax_form: "W-8BEN", total_cents: 500_000 })]);
    expect(r.json.note).toContain("Nothing was filed with the IRS");
    expect(JSON.stringify(r)).not.toMatch(NO_TIN);
    expect(r.csv).toContain("6781"); // the last four, so the payee can be told apart
    expect(audits("influencer.1099_export")[0]).toMatchObject({ actor_id: USERS.admin, metadata: expect.objectContaining({ year: 2026, payees: 3, flagged: 1 }) });
    await expect(tax.export1099Nec(db(), { userId: USERS.b1, year: 2026 })).rejects.toThrow("Only the Manager");
    expect((await tax.export1099Nec(db(), { userId: USERS.admin, year: 2024 })).payees).toEqual([]);
  });

  it("the export WITH TINs needs the tax-vault permission, reads each TIN through the audited function, keeps the files in the private vault, and logs every read", async () => {
    const a = (await save({ name: "Alpha", tin: "123-45-6781" })).id;
    const b = (await save({ name: "Beta", tin: "587-65-4321" })).id;
    await pay(a, 700);
    await pay(b, 800);
    await expect(tax.export1099NecWithTins(db(), { userId: USERS.admin, year: 2026 })).rejects.toThrow("access to the tax vault");
    expect(audits("tax_vault.influencer_payee_tin_viewed")).toHaveLength(0);
    const r = await tax.export1099NecWithTins(db(), { userId: FOUNDER, year: 2026 });
    const csv = Buffer.from(r.files.find((f) => f.name.endsWith(".csv"))!.base64, "base64").toString();
    expect(csv).toContain("123-45-6781");
    expect(csv).toContain("587-65-4321");
    const log = audits("tax_vault.influencer_payee_tin_viewed");
    expect(log).toHaveLength(2);
    expect(log.every((l) => l.metadata.reason === "1099-NEC export 2026" && l.actor_id === FOUNDER)).toBe(true);
    expect([...store.keys()].every((k) => k.startsWith("tax-ready/influencer-1099-nec/2026/"))).toBe(true);
    expect(store.size).toBe(2);
    expect(JSON.stringify(db().table("audit_log"))).not.toMatch(NO_TIN);
  });

  it("an influencer's TIN is shown only through the vault, with a reason, and logged", async () => {
    const { id } = await save();
    await expect(tax.revealInfluencerTin(db(), { userId: USERS.admin, payeeId: id, reason: "x" })).rejects.toThrow("access to the tax vault");
    expect(await tax.revealInfluencerTin(db(), { userId: FOUNDER, payeeId: id, reason: "Filing" })).toEqual({ tin: "123-45-6789" });
    expect(audits("tax_vault.influencer_payee_tin_viewed")).toHaveLength(1);
  });

  it("the board lists payees and the year's payments without any TIN, and voiding needs a reason", async () => {
    const { id } = await save();
    await pay(id, 650);
    const b = await tax.influencerBoard(db(), { userId: USERS.admin, year: 2026 });
    expect(b.payees[0]).toMatchObject({ name: "Ivy Influencer", formType: "W-9", last4: "6789" });
    expect(b.payments[0]).toMatchObject({ amountCents: 65_000, voided: false });
    expect(JSON.stringify(b)).not.toMatch(NO_TIN);
    db().rpcResults.void_influencer_payment = vi.fn();
    await tax.voidInfluencerPayment(db(), { userId: USERS.admin, paymentId: "pay-1", reason: "Entered twice" });
    expect(db().rpcResults.void_influencer_payment).toHaveBeenCalledWith(expect.objectContaining({ _reason: "Entered twice" }));
    await expect(tax.voidInfluencerPayment(db(), { userId: USERS.b1, paymentId: "pay-1", reason: "x" })).rejects.toThrow("Only the Manager");
  });

  it("influencers have nothing to do with a Broker of Record: no broker table or gate in their code", () => {
    const src = readFileSync("src/lib/tax-forms.server.ts", "utf8");
    const start = src.indexOf("// Influencers: paid directly");
    const end = src.indexOf("// The Tax-Ready Folder");
    const section = src.slice(start, end).split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*")).join("\n");
    expect(section).not.toMatch(/brokers|broker_tax|payment-gate|checkCommissionPaymentGate/i);
  });
});

describe("the Tax-Ready Folder", () => {
  beforeEach(setup);
  afterEach(teardown);
  beforeEach(() => {
    db().seed("properties", [{ id: P, address: "5632 Independence Ave", city: "Lusk", state: "WY", zip: "82225" }]);
    db().seed("buyer_accounts", [{ id: "mem-a", auth_user_id: USERS.b1 }, { id: "mem-b", auth_user_id: USERS.b2 }]);
    db().seed("account_members", [{ id: "am-a", buyer_account_id: "mem-a", full_name: "Ann Seller", status: "active" }, { id: "am-b", buyer_account_id: "mem-b", full_name: "Ben Buyer", status: "active" }]);
    db().seed("member_w9", [
      { id: "w9-a", account_member_id: "am-a", buyer_account_id: "mem-a", legal_name: "Ann Seller", address: "1 Oak St", tin_kind: "ssn" },
      { id: "w9-b", account_member_id: "am-b", buyer_account_id: "mem-b", legal_name: "Ben Buyer", address: "2 Pine Rd", tin_kind: "ssn" },
    ]);
    db().seed("member_w9_tin_secrets", [{ w9_id: "w9-a", ...encryptPii("123456789", "member_w9:w9-a") }, { w9_id: "w9-b", ...encryptPii("587654321", "member_w9:w9-b") }]);
  });
  const gen = (o: Partial<Parameters<typeof tax.generateTaxReadyFolder>[1]> = {}) => tax.generateTaxReadyFolder(db(), { userId: FOUNDER, propertyId: P, year: 2025, now: new Date("2026-01-05T09:00:00Z"), ...o });
  const filesOf = () => [...store.entries()];

  it("needs the tax-vault permission (a regular admin can't make one), and the year to have ended", async () => {
    await expect(gen({ userId: USERS.admin })).rejects.toThrow("access to the tax vault");
    await expect(gen({ userId: USERS.b1 })).rejects.toThrow("Only the Manager");
    await expect(gen({ year: 2026 })).rejects.toThrow("after the year has ended");
    expect(db().table("tax_ready_folders")).toHaveLength(0);
    expect(store.size).toBe(0);
  });

  it("records the reconciled ownership and the 1099-S sale (names, no TIN) and keeps every file in the private vault bucket, with the TIN files marked", async () => {
    const r = await gen();
    expect(r).toMatchObject({ version: 1, reconciled: true, sales: 1 });
    const row = (db().table("tax_ready_folders") as any[])[0];
    expect(row.data.reconciliation).toMatchObject({ reconciled: true, share_days_total: 365 });
    expect(row.data.sales_1099s[0]).toMatchObject({ gross_proceeds_cents: 200_000, transferor_names: ["Ann Seller"], transferee_names: ["Ben Buyer"], transferor_tin_status: "on_file" });
    expect(row.data.members.map((m: any) => [m.legal_names[0], m.year_end_shares])).toEqual([["Ann Seller", 0], ["Ben Buyer", 1]]);
    expect(JSON.stringify(row.data)).not.toMatch(NO_TIN); // the data in the database has no TIN
    expect(row.hash).toBe(r.hash);
    expect(filesOf().every(([k]) => k.startsWith(`tax-ready/${P}/2025/v1/`))).toBe(true); // all of it in the vault bucket
    expect((row.files as any[]).map((f) => [f.name, f.pii]).sort()).toEqual([["1099-s-data-with-tins.csv", true], ["1099-s-data.csv", false], ["ownership-records.csv", false], ["ownership-summary.csv", false], ["tax-ready-with-tins.json", true], ["tax-ready.json", false]]);
    for (const f of row.files as any[]) expect(sha(store.get(`tax-ready/${f.path}`)!)).toBe(f.sha256);
  });

  it("TINs are only in the files marked with them, each one read through the audited decrypt (reason: the folder), including the seller who no longer holds a share", async () => {
    await gen();
    for (const [key, bytes] of filesOf()) {
      const text = Buffer.from(bytes).toString();
      if (key.includes("with-tins")) continue;
      expect(text, key).not.toMatch(NO_TIN);
    }
    const withTins = JSON.parse(Buffer.from(store.get(`tax-ready/${P}/2025/v1/tax-ready-with-tins.json`)!).toString());
    expect(withTins.sales_1099s[0].transferor_tins).toEqual([{ legal_name: "Ann Seller", tin: "123-45-6789" }]);
    expect(Buffer.from(store.get(`tax-ready/${P}/2025/v1/1099-s-data-with-tins.csv`)!).toString()).toContain("123-45-6789");
    const log = audits("admin.w9_tin_decrypted");
    expect(log).toHaveLength(2);
    expect(log.every((l) => l.metadata.reason === "Tax-Ready Folder 2025" && l.metadata.property_id === P && l.actor_id === FOUNDER)).toBe(true);
    expect(JSON.stringify(db().table("audit_log"))).not.toMatch(NO_TIN);
  });

  it("the scheduled job makes one with no person, logged as the system's", async () => {
    await gen({ userId: null });
    expect((db().table("tax_ready_folders") as any[])[0].generated_by).toBeNull();
    expect(audits("admin.w9_tin_decrypted").every((l) => l.actor_type === "system")).toBe(true);
  });

  it("only the vault lists or downloads: a regular admin, an agent, an owner and a CPA all get nothing; a download is hash-checked and logged", async () => {
    await gen();
    const id = (db().table("tax_ready_folders") as any[])[0].id;
    for (const u of [USERS.admin, USERS.ra, USERS.b1, "u-cpa", "u-nobody"]) {
      await expect(tax.taxReadyFolders(db(), { userId: u, propertyId: P }), u).rejects.toThrow("access to the tax vault");
      await expect(tax.downloadTaxReadyFile(db(), { userId: u, folderId: id, file: "tax-ready.json" }), u).rejects.toThrow("access to the tax vault");
      await expect(tax.downloadTaxReadyFile(db(), { userId: u, folderId: id, file: "tax-ready-with-tins.json" }), u).rejects.toThrow("access to the tax vault");
    }
    const list = await tax.taxReadyFolders(db(), { userId: FOUNDER, propertyId: P });
    expect(list.folders[0]).toMatchObject({ year: 2025, version: 1, reconciled: true, sales: 1, byJob: false });
    const f = await tax.downloadTaxReadyFile(db(), { userId: FOUNDER, folderId: id, file: "tax-ready-with-tins.json" });
    expect(f.pii).toBe(true);
    expect(audits("tax_ready.pii_file_downloaded")[0]).toMatchObject({ actor_id: FOUNDER, metadata: expect.objectContaining({ file: "tax-ready-with-tins.json", pii: true }) });
    await tax.downloadTaxReadyFile(db(), { userId: FOUNDER, folderId: id, file: "ownership-summary.csv" });
    expect(audits("tax_ready.file_downloaded")).toHaveLength(1);
    store.set(`tax-ready/${P}/2025/v1/tax-ready.json`, new Uint8Array([1]));
    await expect(tax.downloadTaxReadyFile(db(), { userId: FOUNDER, folderId: id, file: "tax-ready.json" })).rejects.toThrow("doesn't match the hash");
    await expect(tax.downloadTaxReadyFile(db(), { userId: FOUNDER, folderId: id, file: "nope.csv" })).rejects.toThrow("File not found.");
  });

  it("each generation is a new version", async () => {
    await gen();
    await gen();
    expect((db().table("tax_ready_folders") as any[]).map((x) => x.version)).toEqual([1, 2]);
  });
});

describe("the daily sweep, and a TIN never leaks", () => {
  beforeEach(setup);
  afterEach(teardown);
  it("a Broker of Record whose W-8 has lapsed is told once, with the link, and the flag is brought in step", async () => {
    setForms([form(IDS.broker, { id: "tf-w8", form_type: "W-8BEN", expiry_date: "2029-12-31" })]);
    expect(await tax.runTaxFormSweep(db(), { now: new Date("2029-12-30T10:00:00Z") })).toEqual({ expired: 0, told: 0 });
    const r = await tax.runTaxFormSweep(db(), { now: new Date("2030-01-02T10:00:00Z") });
    expect(r).toEqual({ expired: 1, told: 1 });
    expect(db().rpcResults.sync_broker_tax_flag).toHaveBeenCalledWith({ _broker: IDS.broker });
    const n = (db().table("notifications") as any[]).filter((x) => x.seller_id === USERS.broker);
    expect(n).toHaveLength(1);
    expect(n[0].message).toContain("expired on 2029-12-31");
    expect((await tax.runTaxFormSweep(db(), { now: new Date("2030-01-03T10:00:00Z") })).told).toBe(0);
  });

  it("through a whole run of forms, payees, exports, reveals and folders, a TIN never reaches a log, an audit row, a notification, an error or a general response", async () => {
    await tax.submitBrokerTaxForm(db(), brokerForm());
    await tax.saveInfluencerPayee(db(), { userId: USERS.admin, name: "Ivy", formType: "W-9", address: "5 Elm St", tinKind: "ssn", tin: "587-65-4321", signedOn: "2026-01-10" });
    const payee = (db().table("influencer_payees") as any[])[0].id;
    await tax.recordInfluencerPayment(db(), { userId: USERS.admin, payeeId: payee, amount: 900, paidAt: "2026-02-02" });
    const general = [await tax.adminBrokerForms(db(), { userId: USERS.admin }), await tax.brokerTaxFormStatus(db(), { userId: USERS.broker }), await tax.influencerBoard(db(), { userId: USERS.admin, year: 2026 }), await tax.export1099Nec(db(), { userId: USERS.admin, year: 2026 })];
    const errors: string[] = [];
    for (const attempt of [() => tax.revealBrokerTin(db(), { userId: USERS.admin, formId: "x", reason: "x" }), () => tax.saveInfluencerPayee(db(), { userId: USERS.admin, name: "Bad", formType: "W-9", address: "x", tinKind: "ssn", tin: "587-65-43", signedOn: "2026-01-10" }), () => tax.submitBrokerTaxForm(db(), brokerForm({ tin: "123-45-67" }))]) errors.push(((await attempt().catch((e) => e)) as Error).message);
    expect(JSON.stringify(general)).not.toMatch(NO_TIN);
    expect(errors.join(" ")).not.toMatch(/587-?65-?43|123-?45-?67/);
    expect(everything()).not.toMatch(NO_TIN);
  });

  it("the TIN is read in exactly the existing audited functions: nothing else decrypts", () => {
    for (const f of ["src/lib/tax-forms.server.ts", "src/lib/payment-gate.ts", "src/lib/disbursement-check.server.ts", "src/lib/tax-forms.functions.ts"]) expect(readFileSync(f, "utf8"), f).not.toMatch(/decryptPii|decryptTinForTaxExport\(|_secrets/);
    expect(readFileSync("src/routes/admin.tax.tsx", "utf8")).not.toMatch(/_secrets|decryptPii/);
  });

  it("the screens and the sweep exist", () => {
    expect(readFileSync("src/routes/broker.tax-form.tsx", "utf8")).toContain("Submit my");
    expect(readFileSync("src/components/TaxFormGateBanner.tsx", "utf8")).toContain("/broker/tax-form");
    for (const l of ["1099-NEC data export (CSV and JSON)", "Generate the folder", "Grant access", "Open the form (logged)"]) expect(readFileSync("src/routes/admin.tax.tsx", "utf8"), l).toContain(l);
    expect(readFileSync("cron-sweeps.sql", "utf8")).toContain("tax-form-sweep");
    expect(readFileSync("src/routes/api.public.tax-form-sweep.ts", "utf8")).toContain("runTaxFormSweep");
  });
});
