/**
 * Tax forms and tax data (server side): the Broker of Record's W-9 / W-8 (encrypted, one valid at a time, a W-8 that lapses), the tax vault permission,
 * influencers paid directly (payees, payments, the annual summary, the 1099-NEC export), and the Tax-Ready Folder. The platform records and exports
 * data only: it files nothing with the IRS. Every TIN is sealed with the same AES-256-GCM as the members' W-9s, never returned or logged, and read only
 * through the audited vault functions in w9.server.ts.
 */
import { createHash, randomUUID } from "node:crypto";
import { deliver } from "@/lib/authorization.notify.server";
import { toCsv } from "@/lib/csv";
import { legalNamesMatch } from "@/lib/eligibility-declaration";
import { assertEncryptionKey, encryptPii } from "@/lib/pii-crypto.server";
import { digitsOnly, formExpiry, gateStateFromForms, INFLUENCER_THRESHOLD_CENTS, last4Of, requiredFormType, tinProblem, tinToSeal, type EntityKind, type FormRow, type TaxFormType } from "@/lib/tax-forms";
import { decryptTinsForPacket, formatTin, secretAad, viewTaxIdAsVault } from "@/lib/w9.server";
import { buildRoster, taxReadyPeople } from "@/lib/year-end-packet.server";

type Db = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => any; storage?: any };
export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}
const MISSING = "Database is missing the tax forms: run tax-forms.sql in Supabase.";
const VAULT = "tax-ready";
const meta = (r?: RequestContext) => ({ ip_address: r?.ip ?? null, user_agent: r?.userAgent ?? null });
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const bytesOf = (s: string) => new TextEncoder().encode(s);
const todayIso = () => new Date().toISOString().slice(0, 10);

async function requireManager(db: Db, userId: string) {
  const { data } = await db.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (data !== true) throw new Error("Only the Manager can do that.");
}
async function requireVault(db: Db, userId: string) {
  const { data } = await db.rpc("has_tax_vault_access", { _user: userId });
  if (data !== true) throw new Error("You don't have access to the tax vault.");
}
async function call<T = Record<string, any>>(db: Db, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    const m = String(error.message ?? "");
    if (/does not exist|schema cache|Could not find/i.test(m) && /tax|influencer|vault|broker_tax/i.test(m)) throw new Error(MISSING);
    throw new Error(m || "The books refused that.");
  }
  return data as T;
}

// ---------------------------------------------------------------------------------------------------------
// The Broker of Record's tax form
// ---------------------------------------------------------------------------------------------------------
export interface BrokerFormInput {
  userId: string;
  isUsPerson: boolean;
  entityKind: EntityKind;
  legalName: string;
  address: string;
  /** Two-letter country code. US for a US person. */
  country: string;
  tinKind?: "ssn" | "ein" | "itin" | "foreign_tin" | null;
  tin?: string | null;
  /** A non-US broker whose country issues no tax ID says so. */
  noForeignTin?: boolean;
  signedName: string;
  certified: boolean;
  request?: RequestContext;
  now?: Date;
}

async function brokerOf(db: Db, userId: string) {
  const { data } = await db.from("brokers").select("id, brokerage_name").eq("auth_user_id", userId).maybeSingle();
  if (!data) throw new Error("No Broker of Record account for this login.");
  return data as { id: string; brokerage_name: string | null };
}

/** The broker submits their own form. It is checked here, the TIN is sealed, and the earlier form is superseded. Never returns the TIN. */
export async function submitBrokerTaxForm(db: Db, p: BrokerFormInput) {
  const broker = await brokerOf(db, p.userId);
  const country = p.country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new Error("Enter the country as a two-letter code (for example US).");
  if (p.isUsPerson !== (country === "US")) throw new Error(p.isUsPerson ? "A US person's country is US." : "A non-US broker's country can't be US.");
  if (!p.legalName.trim()) throw new Error("Enter the legal name exactly as it is on your tax records.");
  if (!p.address.trim()) throw new Error("Enter your address.");
  if (!p.certified) throw new Error("Certify the form to submit it.");
  if (!p.signedName.trim()) throw new Error("Sign with your full name.");
  if (p.entityKind === "individual" && !legalNamesMatch(p.signedName, p.legalName)) throw new Error("An individual signs with their own legal name.");
  const formType: TaxFormType = requiredFormType(p.isUsPerson, p.entityKind);
  let tinKind: "ssn" | "ein" | "itin" | "foreign_tin" | "none";
  let sealed: ReturnType<typeof encryptPii> | null = null;
  const id = randomUUID();
  let last4: string | null = null;
  if (p.isUsPerson) {
    if (!p.tinKind || p.tinKind === "foreign_tin" || !p.tin) throw new Error("A W-9 needs your SSN, EIN or ITIN.");
    const problem = tinProblem(p.tinKind, p.tin);
    if (problem) throw new Error(problem);
    tinKind = p.tinKind;
  } else if (p.tin && p.tin.trim()) {
    const problem = tinProblem("foreign_tin", p.tin);
    if (problem) throw new Error(problem);
    tinKind = "foreign_tin";
  } else if (p.noForeignTin) {
    tinKind = "none";
  } else {
    throw new Error("Enter your foreign tax ID, or say your country issues none.");
  }
  if (tinKind !== "none") {
    assertEncryptionKey();
    sealed = encryptPii(tinToSeal(p.tin!, tinKind), secretAad("broker_tax_form", id));
    last4 = last4Of(p.tin!, tinKind);
  }
  const signedAt = (p.now ?? new Date()).toISOString();
  const expiry = formExpiry(formType, signedAt);
  await call(db, "record_broker_tax_form", {
    _broker: broker.id,
    _form: { id, form_type: formType, is_us_person: p.isUsPerson, entity_kind: p.entityKind, legal_name: p.legalName.trim(), address: p.address.trim().slice(0, 500), country, tin_kind: tinKind, tin_last4: last4, signed_name: p.signedName.trim(), signed_at: signedAt, expiry_date: expiry },
    _secret: sealed,
    _actor: p.userId,
    _meta: meta(p.request),
  });
  return { formId: id, formType, expiry, last4, tinKind };
}

/** What the broker sees of their own form: type, status, expiry and the last four. */
export async function brokerTaxFormStatus(db: Db, p: { userId: string; today?: string }) {
  const broker = await brokerOf(db, p.userId);
  const { data } = await db.from("broker_tax_forms").select("id, form_type, status, expiry_date, created_at, tin_last4, legal_name, country, entity_kind").eq("broker_id", broker.id);
  const rows = (data ?? []) as Array<FormRow & { tin_last4: string | null; legal_name: string; country: string; entity_kind: EntityKind }>;
  const gate = gateStateFromForms(rows, p.today ?? todayIso());
  const current = rows.find((r) => r.status === "valid") ?? rows.filter((r) => r.status === "rejected").sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  return {
    brokerage: broker.brokerage_name,
    state: gate.state,
    allowed: gate.allowed,
    formType: gate.formType,
    expiry: gate.expiry,
    last4: current?.tin_last4 ?? null,
    legalName: current?.legal_name ?? null,
  };
}

/** The Manager's list: every Broker of Record and where they stand for payouts. No PII. */
export async function adminBrokerForms(db: Db, p: { userId: string; today?: string }) {
  await requireManager(db, p.userId);
  const { data: brokers } = await db.from("brokers").select("id, brokerage_name");
  const { data: forms } = await db.from("broker_tax_forms").select("id, broker_id, form_type, status, expiry_date, created_at");
  const all = (forms ?? []) as Array<FormRow & { broker_id: string }>;
  return {
    brokers: ((brokers ?? []) as Array<{ id: string; brokerage_name: string | null }>)
      .map((b) => {
        const gate = gateStateFromForms(all.filter((f) => f.broker_id === b.id), p.today ?? todayIso());
        return { id: b.id, brokerage: b.brokerage_name ?? "Brokerage", state: gate.state, allowed: gate.allowed, formType: gate.formType, expiry: gate.expiry, formId: all.find((f) => f.broker_id === b.id && f.status === "valid")?.id ?? null };
      })
      .sort((a, b) => Number(a.allowed) - Number(b.allowed) || a.brokerage.localeCompare(b.brokerage)),
  };
}

/** Open a broker's form: the details (never the TIN). Logged every time. */
export async function adminViewBrokerForm(db: Db, p: { userId: string; brokerId: string; request?: RequestContext }) {
  await requireManager(db, p.userId);
  const { data } = await db.from("broker_tax_forms").select("*").eq("broker_id", p.brokerId).eq("status", "valid").maybeSingle();
  if (!data) throw new Error("No valid form on file for this broker.");
  await call(db, "log_tax_vault_read", { _actor: p.userId, _action: "tax_form.viewed", _entity_type: "broker", _id: p.brokerId, _meta: { form_id: data.id, ...meta(p.request) } });
  return { id: data.id as string, formType: data.form_type as TaxFormType, legalName: data.legal_name as string, address: data.address as string, country: data.country as string, tinKind: data.tin_kind as string, last4: (data.tin_last4 ?? null) as string | null, signedName: data.signed_name as string, signedAt: data.signed_at as string, expiry: (data.expiry_date ?? null) as string | null };
}

export async function rejectBrokerTaxForm(db: Db, p: { userId: string; formId: string; reason: string; request?: RequestContext }) {
  await requireManager(db, p.userId);
  await call(db, "reject_broker_tax_form", { _id: p.formId, _reason: p.reason, _actor: p.userId, _meta: meta(p.request) });
}

/** A broker's TIN, for someone with the tax-vault permission. Logged first; never in an error. */
export async function revealBrokerTin(db: Db, p: { userId: string; formId: string; reason: string }) {
  const { data } = await db.from("broker_tax_forms").select("tin_kind").eq("id", p.formId).maybeSingle();
  const r = await viewTaxIdAsVault(db as never, { userId: p.userId, kind: "broker_tax_form", id: p.formId, reason: p.reason });
  return { tin: formatTin(r.tin, (data?.tin_kind as string | undefined) ?? "ein") };
}

// ---------------------------------------------------------------------------------------------------------
// The tax vault permission
// ---------------------------------------------------------------------------------------------------------
export async function vaultStatus(db: Db, p: { userId: string }) {
  const { data: has } = await db.rpc("has_tax_vault_access", { _user: p.userId });
  const { data: founder } = await db.rpc("has_role", { _user_id: p.userId, _role: "founder" });
  let grants: Array<{ userId: string; grantedAt: string; reason: string | null }> = [];
  if (founder === true) {
    const { data } = await db.from("tax_vault_grants").select("user_id, granted_at, reason").is("revoked_at", null);
    grants = ((data ?? []) as Array<Record<string, any>>).map((g) => ({ userId: g.user_id as string, grantedAt: g.granted_at as string, reason: (g.reason ?? null) as string | null }));
  }
  return { hasAccess: has === true, isFounder: founder === true, grants };
}
export async function grantVaultAccess(db: Db, p: { userId: string; targetUserId: string; reason: string; request?: RequestContext }) {
  await call(db, "grant_tax_vault_access", { _user: p.targetUserId, _reason: p.reason, _actor: p.userId, _meta: meta(p.request) });
}
export async function revokeVaultAccess(db: Db, p: { userId: string; targetUserId: string; request?: RequestContext }) {
  await call(db, "revoke_tax_vault_access", { _user: p.targetUserId, _actor: p.userId, _meta: meta(p.request) });
}

// ---------------------------------------------------------------------------------------------------------
// Influencers: paid directly, never through a Broker of Record
// ---------------------------------------------------------------------------------------------------------
export interface PayeeInput {
  userId: string;
  id?: string | null;
  name: string;
  /** The form the payee gave, if any. */
  formType?: TaxFormType | null;
  address?: string | null;
  country?: string | null;
  tinKind?: "ssn" | "ein" | "itin" | "foreign_tin" | "none" | null;
  tin?: string | null;
  signedOn?: string | null;
  request?: RequestContext;
}

export async function saveInfluencerPayee(db: Db, p: PayeeInput) {
  await requireManager(db, p.userId);
  if (!p.name.trim()) throw new Error("Enter the payee's name.");
  const ft = p.formType ?? null;
  let sealed: ReturnType<typeof encryptPii> | null = null;
  const id = p.id ?? randomUUID();
  let last4: string | null = null;
  let expiry: string | null = null;
  let country = p.country?.trim().toUpperCase() || null;
  let tinKind = p.tinKind ?? null;
  if (ft) {
    if (!p.signedOn || !/^\d{4}-\d{2}-\d{2}$/.test(p.signedOn)) throw new Error("Enter the date the form was signed.");
    if (!p.address?.trim()) throw new Error("Enter the payee's address.");
    if (ft === "W-9") {
      country = "US";
      if (!tinKind || tinKind === "foreign_tin" || tinKind === "none" || !p.tin) throw new Error("A W-9 needs the payee's SSN, EIN or ITIN.");
      const problem = tinProblem(tinKind, p.tin);
      if (problem) throw new Error(problem);
    } else {
      if (!country || country === "US" || !/^[A-Z]{2}$/.test(country)) throw new Error("A W-8 payee's country is a two-letter code other than US.");
      if (p.tin && p.tin.trim()) {
        tinKind = "foreign_tin";
        const problem = tinProblem("foreign_tin", p.tin);
        if (problem) throw new Error(problem);
      } else tinKind = "none";
    }
    expiry = formExpiry(ft, `${p.signedOn}T00:00:00Z`);
    if (tinKind && tinKind !== "none" && p.tin) {
      assertEncryptionKey();
      sealed = encryptPii(tinToSeal(p.tin, tinKind), secretAad("influencer_payee", id));
      last4 = last4Of(p.tin, tinKind);
    }
  }
  await call(db, "save_influencer_payee", {
    _id: id,
    _payee: { name: p.name.trim(), tax_form_type: ft, country, address: p.address ?? null, tin_kind: ft ? tinKind : null, tin_last4: last4, form_signed_on: ft ? p.signedOn : null, form_expiry_date: expiry },
    _secret: sealed,
    _actor: p.userId,
    _meta: meta(p.request),
  });
  return { id, last4 };
}

export async function recordInfluencerPayment(db: Db, p: { userId: string; payeeId: string; amount: number; paidAt: string; memo?: string | null; request?: RequestContext }) {
  await requireManager(db, p.userId);
  const cents = Math.round(Number(p.amount) * 100);
  if (!Number.isFinite(p.amount) || cents <= 0 || Math.abs(Number(p.amount) * 100 - cents) > 1e-6) throw new Error("The amount is above zero, with at most two decimal places.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.paidAt)) throw new Error("Enter the date the payment was made.");
  const id = await call<string>(db, "record_influencer_payment", { _payee: p.payeeId, _amount_cents: cents, _paid_at: p.paidAt, _memo: p.memo ?? null, _actor: p.userId, _meta: meta(p.request) });
  return { id, cents };
}
export async function voidInfluencerPayment(db: Db, p: { userId: string; paymentId: string; reason: string; request?: RequestContext }) {
  await requireManager(db, p.userId);
  await call(db, "void_influencer_payment", { _id: p.paymentId, _reason: p.reason, _actor: p.userId, _meta: meta(p.request) });
}

export async function influencerBoard(db: Db, p: { userId: string; year: number }) {
  await requireManager(db, p.userId);
  const { data: payees, error } = await db.from("influencer_payees").select("id, name, tax_form_type, tax_form_status, is_us_person, country, tin_last4, form_expiry_date").order("name");
  if (error) throw new Error(MISSING);
  const { data: payments } = await db.from("influencer_payments").select("id, payee_id, amount_cents, paid_at, memo, year, voided_at, void_reason").eq("year", p.year).order("paid_at", { ascending: false });
  const summary = await annualSummary(db, { userId: p.userId, year: p.year });
  return {
    year: p.year,
    payees: ((payees ?? []) as Array<Record<string, any>>).map((x) => ({ id: x.id as string, name: x.name as string, formType: (x.tax_form_type ?? null) as TaxFormType | null, formStatus: x.tax_form_status as string, isUsPerson: (x.is_us_person ?? null) as boolean | null, country: (x.country ?? null) as string | null, last4: (x.tin_last4 ?? null) as string | null })),
    payments: ((payments ?? []) as Array<Record<string, any>>).map((x) => ({ id: x.id as string, payeeId: x.payee_id as string, amountCents: Number(x.amount_cents), paidAt: x.paid_at as string, memo: (x.memo ?? null) as string | null, voided: !!x.voided_at, voidReason: (x.void_reason ?? null) as string | null })),
    summary,
  };
}

export interface SummaryRow {
  payeeId: string;
  name: string;
  address: string | null;
  country: string | null;
  formType: TaxFormType | null;
  formStatus: string;
  last4: string | null;
  payments: number;
  totalCents: number;
  treatment: "1099_nec" | "w8_flag_for_cpa" | "below_threshold";
  issue: string | null;
}

/** Every payee paid in the year, with their total and how they are treated. $600.00 and over is a 1099-NEC payee; a non-US W-8 payee is flagged, not issued one. */
export async function annualSummary(db: Db, p: { userId: string; year: number }): Promise<SummaryRow[]> {
  await requireManager(db, p.userId);
  const rows = await call<Array<Record<string, any>>>(db, "influencer_annual_summary", { _year: p.year });
  return (rows ?? []).map((r) => ({ payeeId: r.payee_id, name: r.name, address: r.address ?? null, country: r.country ?? null, formType: r.tax_form_type ?? null, formStatus: r.form_status, last4: r.tin_last4 ?? null, payments: Number(r.payments), totalCents: Number(r.total_cents), treatment: r.treatment, issue: r.issue ?? null }));
}

const usd = (c: number) => (c / 100).toFixed(2);

/**
 * The 1099-NEC data export for a year: only payees at or over $600.00 who are not non-US W-8 payees. Non-US payees over the line are listed apart,
 * flagged for the CPA, with no 1099-NEC. No TIN is in this export (the last four only). It is data: nothing is filed with the IRS.
 */
export async function export1099Nec(db: Db, p: { userId: string; year: number; request?: RequestContext }) {
  const summary = await annualSummary(db, p);
  const nec = summary.filter((r) => r.treatment === "1099_nec");
  const flagged = summary.filter((r) => r.treatment === "w8_flag_for_cpa");
  const headers = ["payee", "address", "tin_last4", "tax_form", "form_status", "payments", "box_1_nonemployee_compensation", "issue"];
  const csv = toCsv(headers, nec.map((r) => [r.name, r.address, r.last4, r.formType, r.formStatus, r.payments, usd(r.totalCents), r.issue]));
  const json = {
    schema: "divieight.1099-nec-data.v1",
    tax_year: p.year,
    threshold_cents: INFLUENCER_THRESHOLD_CENTS,
    payees: nec.map((r) => ({ payee_id: r.payeeId, name: r.name, address: r.address, tin_last4: r.last4, tax_form: r.formType, form_status: r.formStatus, payments: r.payments, nonemployee_compensation_cents: r.totalCents, issue: r.issue })),
    flagged_for_cpa: flagged.map((r) => ({ payee_id: r.payeeId, name: r.name, country: r.country, tax_form: r.formType, total_cents: r.totalCents, note: r.issue })),
    note: "Recorded and exported by divieight. Nothing was filed with the IRS.",
  };
  await call(db, "log_tax_vault_read", { _actor: p.userId, _action: "influencer.1099_export", _entity_type: "influencer_export", _id: String(p.year), _meta: { year: p.year, payees: nec.length, flagged: flagged.length, ...meta(p.request) } });
  return { year: p.year, payees: nec, flaggedForCpa: flagged, csv, json };
}

/**
 * The same export WITH each payee's TIN, for someone with the tax-vault permission. Each TIN is read through the audited vault function (reason: the
 * export). The files are kept in the private vault bucket and returned once to the person who asked.
 */
export async function export1099NecWithTins(db: Db, p: { userId: string; year: number; request?: RequestContext }) {
  await requireVault(db, p.userId);
  const base = await export1099Nec(db, p);
  const tins: Record<string, string> = {};
  for (const r of base.payees) {
    const { data } = await db.from("influencer_payees").select("tin_kind").eq("id", r.payeeId).maybeSingle();
    try {
      const v = await viewTaxIdAsVault(db as never, { userId: p.userId, kind: "influencer_payee", id: r.payeeId, reason: `1099-NEC export ${p.year}` });
      tins[r.payeeId] = formatTin(v.tin, (data?.tin_kind as string | undefined) ?? "ssn");
    } catch (e) {
      if (/audit log/.test((e as Error).message)) throw new Error("The tax IDs can't be shown: the audit log could not be written.");
    }
  }
  const headers = ["payee", "address", "tin", "tax_form", "payments", "box_1_nonemployee_compensation", "issue"];
  const csv = toCsv(headers, base.payees.map((r) => [r.name, r.address, tins[r.payeeId] ?? null, r.formType, r.payments, usd(r.totalCents), r.issue]));
  const json = { ...base.json, payees: base.json.payees.map((r) => ({ ...r, tin: tins[r.payee_id] ?? null })) };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const files = [
    { name: `1099-nec-${p.year}-with-tins.csv`, bytes: bytesOf(csv), type: "text/csv" },
    { name: `1099-nec-${p.year}-with-tins.json`, bytes: bytesOf(JSON.stringify(json, null, 2) + "\n"), type: "application/json" },
  ];
  for (const f of files) await db.storage?.from(VAULT).upload(`influencer-1099-nec/${p.year}/${stamp}/${f.name}`, new Blob([f.bytes as BlobPart], { type: f.type }), { contentType: f.type, upsert: false });
  return { year: p.year, files: files.map((f) => ({ name: f.name, base64: Buffer.from(f.bytes).toString("base64"), type: f.type })) };
}

export async function revealInfluencerTin(db: Db, p: { userId: string; payeeId: string; reason: string }) {
  const { data } = await db.from("influencer_payees").select("tin_kind").eq("id", p.payeeId).maybeSingle();
  const r = await viewTaxIdAsVault(db as never, { userId: p.userId, kind: "influencer_payee", id: p.payeeId, reason: p.reason });
  return { tin: formatTin(r.tin, (data?.tin_kind as string | undefined) ?? "ssn") };
}

// ---------------------------------------------------------------------------------------------------------
// The Tax-Ready Folder
// ---------------------------------------------------------------------------------------------------------
export interface FolderFile {
  name: string;
  path: string;
  kind: "json" | "csv";
  bytes: number;
  sha256: string;
  pii: boolean;
}

/**
 * The folder for a property and a year: the 1099-S data from resales and the per-share ownership records, reconciled, for the CPA's K-1 preparation.
 * The folder's data (in the database) has no TIN; every file is kept in the private tax vault, and the ones with TINs are marked. A person needs the
 * tax-vault permission to make or read one; the scheduled job makes them with no person.
 */
export async function generateTaxReadyFolder(db: Db, p: { userId: string | null; propertyId: string; year: number; request?: RequestContext; now?: Date }) {
  if (p.userId) {
    await requireManager(db, p.userId);
    await requireVault(db, p.userId);
  }
  const now = p.now ?? new Date();
  if (!Number.isInteger(p.year) || p.year < 2000 || p.year >= now.getUTCFullYear()) throw new Error("A Tax-Ready Folder is made after the year has ended.");
  const sections = await call<Record<string, any>>(db, "tax_ready_sections", { _property: p.propertyId, _year: p.year });
  const roster = await buildRoster(db as never, p.propertyId, p.year, taxReadyPeople(sections));
  const everyone = [...roster.members, ...roster.others];
  const peopleOf = (memberKey: string) => everyone.filter((m) => m.member_key === memberKey);
  const nameOf = (memberKey: string) => peopleOf(memberKey).map((m) => m.legal_name).join(" & ") || `Member ${String(memberKey).slice(0, 8)}`;
  const { data: prop } = await db.from("properties").select("address, city, state, zip").eq("id", p.propertyId).maybeSingle();
  const members: Array<Record<string, any>> = (sections["members"] as Array<Record<string, any>>).map((m) => ({ ...m, legal_names: peopleOf(m.member_key).map((x) => x.legal_name), mailing_address: peopleOf(m.member_key)[0]?.mailing_address ?? null }));
  const sales: Array<Record<string, any>> = (sections["sales_1099s"] as Array<Record<string, any>>).map((s) => ({ ...s, transferor_names: peopleOf(s.transferor_member_key).map((x) => x.legal_name), transferee_names: peopleOf(s.transferee_member_key).map((x) => x.legal_name), transferor_tin_status: peopleOf(s.transferor_member_key).length > 0 && peopleOf(s.transferor_member_key).every((x) => x.tin_status === "on_file") ? "on_file" : "missing" }));
  const data = {
    schema: "tax-ready-folder.v1",
    year: p.year,
    property: { property_id: p.propertyId, address: prop?.address ?? null, city: prop?.city ?? null, state: prop?.state ?? null, zip: prop?.zip ?? null },
    note: "Ownership and sale records for the CPA. No TIN is in this data. It is not a K-1, a 1099-S or any filing.",
    ownership: sections["shares"],
    members,
    transfers: sections["transfers"],
    sales_1099s: sales,
    reconciliation: sections["reconciliation"],
  };
  const id = randomUUID();
  const rec = await call<{ id: string; version: number; hash: string }>(db, "record_tax_ready_folder", { _id: id, _property: p.propertyId, _year: p.year, _data: data, _actor: p.userId, _meta: meta(p.request) });

  // TINs: one audited decryption each, into the private files only.
  const tinByKey: Record<string, string> = {};
  if (roster.w9.length > 0) {
    const tins = await decryptTinsForPacket(db as never, { actorId: p.userId, propertyId: p.propertyId, year: p.year, w9Ids: roster.w9.map((w) => w.w9Id), purpose: `Tax-Ready Folder ${p.year}` });
    for (const w of roster.w9) if (tins[w.w9Id]) tinByKey[w.key] = formatTin(tins[w.w9Id]!, w.kind);
  }
  const tinOf = (m: { member_key: string; legal_name: string }) => tinByKey[`${m.member_key}:${m.legal_name}`] ?? null;
  const dir = `${p.propertyId}/${p.year}/v${rec.version}`;
  const made: Array<{ file: FolderFile; bytes: Uint8Array; type: string }> = [];
  const add = (name: string, kind: "json" | "csv", bytes: Uint8Array, type: string, pii = false) => made.push({ file: { name, path: `${dir}/${name}`, kind, bytes: bytes.length, sha256: sha256(bytes), pii }, bytes, type });
  add("tax-ready.json", "json", bytesOf(JSON.stringify(data, null, 2) + "\n"), "application/json");
  add("ownership-records.csv", "csv", bytesOf(toCsv(["share_number", "holder", "from", "to", "days"], (data.ownership as Array<Record<string, any>>).flatMap((s) => (s["periods"] as Array<Record<string, any>>).map((x) => [s["share_number"], nameOf(x["holder_key"]), x["from"], x["to"], x["days"]])))), "text/csv");
  add("ownership-summary.csv", "csv", bytesOf(toCsv(["member", "year_end_shares", "share_days", "percent_of_share_days"], members.map((m) => [nameOf(m["member_key"]), m["year_end_shares"], m["share_days"], m["percent_of_share_days"]]))), "text/csv");
  add("1099-s-data.csv", "csv", bytesOf(toCsv(["date", "share_number", "property", "gross_proceeds", "transferor", "transferee", "transferor_tin_status"], sales.map((s) => [s["date"], s["share_number"], s["property_address"], usd(Number(s["gross_proceeds_cents"])), (s["transferor_names"] as string[]).join(" & "), (s["transferee_names"] as string[]).join(" & "), s["transferor_tin_status"]]))), "text/csv");
  const hasTins = Object.keys(tinByKey).length > 0;
  if (hasTins) {
    const withTin = { ...data, members: members.map((m) => ({ ...m, tins: peopleOf(m["member_key"]).map((x) => ({ legal_name: x.legal_name, tin: tinOf(x) })) })), sales_1099s: sales.map((s) => ({ ...s, transferor_tins: peopleOf(s["transferor_member_key"]).map((x) => ({ legal_name: x.legal_name, tin: tinOf(x) })) })) };
    add("tax-ready-with-tins.json", "json", bytesOf(JSON.stringify(withTin, null, 2) + "\n"), "application/json", true);
    add("1099-s-data-with-tins.csv", "csv", bytesOf(toCsv(["date", "share_number", "property", "gross_proceeds", "transferor", "transferor_tin", "transferee"], sales.map((s) => [s["date"], s["share_number"], s["property_address"], usd(Number(s["gross_proceeds_cents"])), (s["transferor_names"] as string[]).join(" & "), peopleOf(s["transferor_member_key"]).map((x) => tinOf(x) ?? "missing").join(" & "), (s["transferee_names"] as string[]).join(" & ")]))), "text/csv", true);
  }
  for (const m of made) {
    const up = await db.storage?.from(VAULT).upload(m.file.path, new Blob([m.bytes as BlobPart], { type: m.type }), { contentType: m.type, upsert: false });
    if (!up || up.error) throw new Error(`The folder was recorded (version ${rec.version}) but ${m.file.name} could not be stored. Generate it again for a complete set.`);
  }
  await call(db, "set_tax_ready_files", { _id: id, _files: made.map((m) => m.file) });
  return { id, version: rec.version, hash: rec.hash, files: made.length, reconciled: Boolean((sections["reconciliation"] as Record<string, any>)["reconciled"]), sales: sales.length };
}

/** The folders for a property. Needs the tax-vault permission: a regular admin sees nothing. */
export async function taxReadyFolders(db: Db, p: { userId: string; propertyId: string }) {
  await requireVault(db, p.userId);
  const { data } = await db.from("tax_ready_folders").select("id, year, version, hash, generated_by, generated_at, files, data").eq("property_id", p.propertyId).order("year", { ascending: false });
  return {
    folders: ((data ?? []) as Array<Record<string, any>>)
      .sort((a, b) => Number(b.year) - Number(a.year) || Number(b.version) - Number(a.version))
      .map((f) => ({ id: f.id as string, year: f.year as number, version: f.version as number, hash: f.hash as string, generatedAt: f.generated_at as string, byJob: f.generated_by == null, reconciled: !!f.data?.reconciliation?.reconciled, sales: (f.data?.sales_1099s ?? []).length, files: ((f.files ?? []) as FolderFile[]).map((x) => ({ name: x.name, pii: x.pii, bytes: x.bytes })) })),
  };
}

/** A file from a folder: the tax-vault permission, the hash checked, and the download logged. */
export async function downloadTaxReadyFile(db: Db, p: { userId: string; folderId: string; file: string; request?: RequestContext }) {
  await requireVault(db, p.userId);
  const { data } = await db.from("tax_ready_folders").select("id, files").eq("id", p.folderId).maybeSingle();
  const file = ((data?.files ?? []) as FolderFile[]).find((f) => f.name === p.file);
  if (!data || !file) throw new Error("File not found.");
  const got = await db.storage?.from(VAULT).download(file.path);
  if (!got || got.error || !got.data) throw new Error("The file could not be read.");
  const bytes = new Uint8Array(await (got.data as Blob).arrayBuffer());
  if (sha256(bytes) !== file.sha256) throw new Error("The stored file doesn't match the hash recorded for it. It was not served.");
  await call(db, "log_tax_vault_read", { _actor: p.userId, _action: file.pii ? "tax_ready.pii_file_downloaded" : "tax_ready.file_downloaded", _entity_type: "tax_ready_folder", _id: p.folderId, _meta: { file: file.name, pii: file.pii, ...meta(p.request) } });
  return { filename: file.name, base64: Buffer.from(bytes).toString("base64"), pii: file.pii };
}

// ---------------------------------------------------------------------------------------------------------
// The scheduled sweep: W-8s that have lapsed
// ---------------------------------------------------------------------------------------------------------
/** Daily. A Broker of Record whose W-8 has lapsed is blocked (the gate already says so) and is told, once, with the link to fix it. */
export async function runTaxFormSweep(db: Db, p: { now?: Date } = {}) {
  const today = (p.now ?? new Date()).toISOString().slice(0, 10);
  const { data } = await db.from("broker_tax_forms").select("id, broker_id, form_type, expiry_date").eq("status", "valid").not("expiry_date", "is", null).lt("expiry_date", today);
  let told = 0;
  for (const f of (data ?? []) as Array<{ id: string; broker_id: string; form_type: string; expiry_date: string }>) {
    await db.rpc("sync_broker_tax_flag", { _broker: f.broker_id });
    const { data: b } = await db.from("brokers").select("auth_user_id, email").eq("id", f.broker_id).maybeSingle();
    if (!b?.auth_user_id) continue;
    const r = await deliver(db as never, { authUserId: b.auth_user_id as string, email: (b.email ?? null) as string | null }, {
      subject: "Your tax form has expired",
      message: `Your ${f.form_type} expired on ${String(f.expiry_date).slice(0, 10)}. No payout can be released to your brokerage until you submit a new one. It takes a few minutes.`,
      link: "/broker/tax-form",
      type: "tax_form_expired",
      dedupeKey: `tax_form_expired:${f.id}`,
    });
    if (!r.duplicate) told += 1;
  }
  return { expired: (data ?? []).length, told };
}

export { digitsOnly };
