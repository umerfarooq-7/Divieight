/**
 * The Designated CPA (server side). The Manager designates one CPA per LLC and can rescind them; the CPA reads the LLC's books and
 * downloads statements and packets, read-only, for that one LLC only. The CPA's own login has no access to any table: every read here
 * first asks the database (is_property_cpa) whether this person is the ACTIVE designated CPA of THIS property, on every call, so rescinding
 * ends access at once and a CPA can never read another property. Nothing here writes anything except audit rows.
 */
import { renderStatementPdf } from "@/lib/statement-pdf";
import { statementFileName } from "@/lib/statements.server";
import type { StatementSnapshot } from "@/lib/statements";
import { viewTinAsCpa } from "@/lib/w9.server";

type Db = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => any; auth?: any };
export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}
const MISSING = "Database is missing the CPA credential: run cpa-role.sql and then cpa-credential.sql in Supabase.";
const meta = (r?: RequestContext) => ({ ip_address: r?.ip ?? null, user_agent: r?.userAgent ?? null });
const BAN_FOREVER = "876000h";

async function requireManager(db: Db, userId: string) {
  const { data } = await db.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (data !== true) throw new Error("Only the Manager can do that.");
}
async function call<T = Record<string, any>>(db: Db, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    const m = String(error.message ?? "");
    if (/does not exist|schema cache|Could not find/i.test(m) && /cpa|designat/i.test(m)) throw new Error(MISSING);
    throw new Error(m || "The books refused that.");
  }
  return data as T;
}

// ---------------------------------------------------------------------------------------------------------
// The Manager: designate and rescind
// ---------------------------------------------------------------------------------------------------------
export interface DesignateParams {
  userId: string;
  propertyId: string;
  name: string;
  firm: string;
  email: string;
  licenseNo?: string | null;
  /** Where the invite link leads (the app's address). */
  origin: string;
  request?: RequestContext;
}

/**
 * Designate a CPA and send the invite (existing auth: an emailed link that signs them in). The slot is taken first, so a second CPA is refused
 * before anything is sent; if the invite can't be sent the designation is rescinded again with that reason.
 */
export async function designateCpa(db: Db, p: DesignateParams): Promise<{ id: string; invited: boolean }> {
  await requireManager(db, p.userId);
  const email = p.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Enter the CPA's email address.");
  if (!p.name.trim() || !p.firm.trim()) throw new Error("Enter the CPA's name and firm.");
  const id = await call<string>(db, "designate_cpa", { _property: p.propertyId, _name: p.name, _firm: p.firm, _email: email, _license: p.licenseNo ?? null, _actor: p.userId, _meta: meta(p.request) });
  try {
    // A CPA who already has a login (another LLC's CPA) keeps it; it is opened again if it had been closed.
    const { data: earlier } = await db.from("cpa_designations").select("auth_user_id").eq("email", email).not("auth_user_id", "is", null).limit(1).maybeSingle();
    let authUser = (earlier?.auth_user_id as string | undefined) ?? null;
    let invited = false;
    if (authUser) {
      await db.auth?.admin?.updateUserById(authUser, { ban_duration: "none" });
    } else {
      const { data: made, error } = await db.auth.admin.inviteUserByEmail(email, { data: { account_type: "cpa", full_name: p.name.trim() }, redirectTo: `${p.origin.replace(/\/$/, "")}/cpa/login` });
      if (error || !made?.user?.id) throw new Error(error?.message?.includes("already") ? "That email already has a divieight login. Use the CPA's own email." : "The invite could not be sent.");
      authUser = made.user.id as string;
      invited = true;
    }
    await call(db, "attach_cpa_login", { _id: id, _auth_user: authUser });
    // The role marks the login as a CPA's. Access never depends on it: the designation does.
    await db.from("user_roles").upsert({ user_id: authUser, role: "cpa" }, { onConflict: "user_id,role" });
    return { id, invited };
  } catch (e) {
    await call(db, "rescind_cpa", { _id: id, _reason: `The invite could not be completed: ${(e as Error).message}`.slice(0, 300), _actor: p.userId, _meta: meta(p.request) }).catch(() => undefined);
    throw e;
  }
}

/**
 * Rescind. The database ends the CPA's access in that instant (nothing is cached: every read asks again); then the login is closed so no session
 * can be refreshed, unless the same person is still the CPA of another LLC. Audit logged.
 */
export async function rescindCpa(db: Db, p: { userId: string; designationId: string; reason: string; request?: RequestContext }) {
  await requireManager(db, p.userId);
  const r = await call<{ status: string; auth_user_id: string | null; other_active: number }>(db, "rescind_cpa", { _id: p.designationId, _reason: p.reason, _actor: p.userId, _meta: meta(p.request) });
  let loginClosed = false;
  if (r.status === "rescinded" && r.auth_user_id && Number(r.other_active) === 0) {
    try {
      await db.auth?.admin?.updateUserById(r.auth_user_id, { ban_duration: BAN_FOREVER });
      await db.from("user_roles").delete().eq("user_id", r.auth_user_id).eq("role", "cpa");
      loginClosed = true;
    } catch {
      // Access is already cut by the database; the Manager is told the login itself couldn't be closed.
    }
  }
  return { rescinded: r.status === "rescinded", loginClosed };
}

export async function designationBoard(db: Db, p: { userId: string; propertyId: string }) {
  await requireManager(db, p.userId);
  const { data, error } = await db.from("cpa_designations").select("*").eq("property_id", p.propertyId).order("designated_at", { ascending: false });
  if (error) throw new Error(MISSING);
  const rows = ((data ?? []) as Array<Record<string, any>>).map((d) => ({
    id: d.id as string,
    name: d.cpa_name as string,
    firm: d.firm as string,
    email: d.email as string,
    licenseNo: (d.license_no ?? null) as string | null,
    status: d.status as "invited" | "active" | "rescinded",
    designatedAt: d.designated_at as string,
    activatedAt: (d.activated_at ?? null) as string | null,
    rescindedAt: (d.rescinded_at ?? null) as string | null,
    reason: (d.reason ?? null) as string | null,
  }));
  return { current: rows.find((r) => r.status !== "rescinded") ?? null, history: rows.filter((r) => r.status === "rescinded") };
}

/** What a member sees: the designated CPA's name and firm, and since when. Nothing else, and only for an owner of that LLC. */
export async function ownerCpa(db: Db, p: { userId: string; propertyId: string }) {
  const { holderFor } = await import("@/lib/votes.server");
  if (!(await holderFor(db as never, p.userId, p.propertyId))) return { allowed: false as const };
  const { data } = await db.from("cpa_designations").select("cpa_name, firm, designated_at, activated_at").eq("property_id", p.propertyId).in("status", ["invited", "active"]).maybeSingle();
  return { allowed: true as const, cpa: data ? { name: data.cpa_name as string, firm: data.firm as string, since: (data.activated_at ?? data.designated_at) as string } : null };
}

// ---------------------------------------------------------------------------------------------------------
// The CPA: read-only, one LLC
// ---------------------------------------------------------------------------------------------------------
/** The one test. It fails closed: a database that can't answer is a refusal. */
export async function requireCpa(db: Db, userId: string, propertyId: string) {
  let ok = false;
  try {
    const { data } = await db.rpc("is_property_cpa", { _user: userId, _property: propertyId });
    ok = data === true;
  } catch {
    ok = false;
  }
  if (!ok) throw new Error("Not authorized");
}

const label = (p: { address?: string | null; city?: string | null; state?: string | null } | null | undefined) => (p ? [p.address, p.city, p.state].filter(Boolean).join(", ") : "Property");

async function audit(db: Db, userId: string, action: string, entityType: string, entityId: string, metadata: Record<string, unknown>) {
  await db.from("audit_log").insert({ actor_id: userId, actor_type: "cpa", action_type: action, entity_type: entityType, entity_id: entityId, metadata: { ...metadata, at: new Date().toISOString() } });
}

/** What this login is designated to. The first sign-in turns an invitation into an active designation. */
export async function cpaPortal(db: Db, p: { userId: string }) {
  const { data, error } = await db.rpc("activate_cpa_designations", { _user: p.userId });
  if (error) throw new Error(MISSING);
  const rows = (data ?? []) as Array<{ designation_id: string; property_id: string; cpa_name: string; firm: string }>;
  const out = [];
  for (const r of rows) {
    const { data: prop } = await db.from("properties").select("address, city, state").eq("id", r.property_id).maybeSingle();
    const { data: g } = await db.from("entity_genesis").select("llc_name").eq("property_id", r.property_id).maybeSingle();
    out.push({ propertyId: r.property_id, property: label(prop), llcName: (g?.llc_name ?? null) as string | null, cpaName: r.cpa_name, firm: r.firm });
  }
  return { designations: out };
}

/** Who each capital account is, by name: the legal names on the members' W-9s (no emails, no other PII). */
async function memberNames(db: Db, propertyId: string): Promise<Map<string, string>> {
  const { data: cap } = await db.from("cap_table_entries").select("holder_type, buyer_account_id, seller_id").eq("property_id", propertyId);
  const names = new Map<string, string>();
  const buyers = [...new Set(((cap ?? []) as Array<{ buyer_account_id: string | null }>).map((c) => c.buyer_account_id).filter(Boolean))] as string[];
  const sellers = [...new Set(((cap ?? []) as Array<{ holder_type: string; seller_id: string | null }>).map((c) => (c.holder_type === "retained_seller" ? c.seller_id : null)).filter(Boolean))] as string[];
  for (const b of buyers) {
    const { data: w9s } = await db.from("member_w9").select("legal_name").eq("buyer_account_id", b);
    const legal = ((w9s ?? []) as Array<{ legal_name: string }>).map((w) => w.legal_name).filter(Boolean);
    names.set(b, legal.length ? legal.join(" & ") : `Member account ${b.slice(0, 8)}`);
  }
  for (const s of sellers) {
    const { data } = await db.from("sellers").select("full_name").eq("id", s).maybeSingle();
    names.set(s, (data?.full_name as string | null) ? `${data.full_name} (retained)` : `Retained seller ${s.slice(0, 8)}`);
  }
  return names;
}

/** The general ledger for a year, entry by entry with every line. Reversals are entries like any other. */
export async function cpaLedger(db: Db, p: { userId: string; propertyId: string; year: number }) {
  await requireCpa(db, p.userId, p.propertyId);
  const names = await memberNames(db, p.propertyId);
  const { data: entries } = await db.from("journal_entries").select("id, entry_date, source, source_ref, memo, reverses_entry_id, is_adjustment").eq("property_id", p.propertyId).gte("entry_date", `${p.year}-01-01`).lte("entry_date", `${p.year}-12-31`).order("entry_date", { ascending: true });
  const rows = (entries ?? []) as Array<Record<string, any>>;
  const ids = rows.map((e) => e.id as string);
  const { data: lines } = ids.length ? await db.from("journal_lines").select("entry_id, account_id, member_id, debit_cents, credit_cents").in("entry_id", ids) : { data: [] };
  const { data: accounts } = await db.from("coa_accounts").select("id, code, name");
  const acct = new Map(((accounts ?? []) as Array<{ id: string; code: string; name: string }>).map((a) => [a.id, a]));
  const byEntry = new Map<string, Array<Record<string, any>>>();
  for (const l of (lines ?? []) as Array<Record<string, any>>) byEntry.set(l.entry_id, [...(byEntry.get(l.entry_id) ?? []), l]);
  let debit = 0;
  let credit = 0;
  const out = rows.map((e) => ({
    id: e.id as string,
    date: e.entry_date as string,
    source: e.source as string,
    memo: (e.memo ?? "") as string,
    reversal: !!e.reverses_entry_id,
    adjustment: !!e.is_adjustment,
    lines: (byEntry.get(e.id) ?? []).map((l) => {
      debit += Number(l.debit_cents);
      credit += Number(l.credit_cents);
      const a = acct.get(l.account_id);
      return { code: a?.code ?? "", account: a?.name ?? "", member: l.member_id ? (names.get(l.member_id as string) ?? "Member") : null, debitCents: Number(l.debit_cents), creditCents: Number(l.credit_cents) };
    }),
  }));
  return { year: p.year, entries: out, totals: { debitCents: debit, creditCents: credit } };
}

/** Each member's capital account for a year: the roll-forward and the lines behind it. */
export async function cpaCapitalAccounts(db: Db, p: { userId: string; propertyId: string; year: number }) {
  await requireCpa(db, p.userId, p.propertyId);
  const names = await memberNames(db, p.propertyId);
  const { data: roll } = await db.rpc("capital_roll_forward", { _property: p.propertyId, _year: p.year });
  const { data: ledger } = await db.from("capital_account_ledger").select("member_key, line_type, amount_cents, effective_date, balance_after_cents").eq("property_id", p.propertyId).gte("effective_date", `${p.year}-01-01`).lte("effective_date", `${p.year}-12-31`).order("seq", { ascending: true });
  const lines = (ledger ?? []) as Array<Record<string, any>>;
  return {
    year: p.year,
    members: ((roll ?? []) as Array<Record<string, any>>).map((r) => ({
      memberKey: r.member_key as string,
      name: names.get(r.member_key as string) ?? "Member",
      beginningCents: Number(r.beginning_cents),
      contributionsCents: Number(r.contributions_cents) + Number(r.opening_cents),
      incomeCents: Number(r.income_cents),
      expenseCents: Number(r.expense_cents),
      depreciationCents: Number(r.depreciation_cents),
      distributionsCents: Number(r.distributions_cents),
      transfersCents: Number(r.transfer_in_cents) + Number(r.transfer_out_cents),
      endingCents: Number(r.ending_cents),
      lines: lines.filter((l) => l.member_key === r.member_key).map((l) => ({ date: l.effective_date as string, type: l.line_type as string, amountCents: Number(l.amount_cents), balanceCents: Number(l.balance_after_cents) })),
    })),
  };
}

/** Every issued and superseded statement of the LLC, every member. Never a draft. */
export async function cpaStatements(db: Db, p: { userId: string; propertyId: string }) {
  await requireCpa(db, p.userId, p.propertyId);
  const names = await memberNames(db, p.propertyId);
  const { data } = await db.from("monthly_statements").select("id, member_key, period, version, status, issued_at, data_snapshot").eq("property_id", p.propertyId).in("status", ["issued", "superseded"]);
  return {
    statements: ((data ?? []) as Array<Record<string, any>>)
      .sort((a, b) => (a.period === b.period ? (a.member_key === b.member_key ? b.version - a.version : String(a.member_key).localeCompare(b.member_key)) : a.period < b.period ? 1 : -1))
      .map((s) => ({ id: s.id as string, period: s.period as string, version: s.version as number, status: s.status as string, member: names.get(s.member_key as string) ?? "Member", issuedAt: s.issued_at as string | null, closingCents: Number((s.data_snapshot as StatementSnapshot).capital.closing_cents) })),
  };
}

async function loadStatement(db: Db, userId: string, statementId: string) {
  const denied = new Error("Statement not found.");
  const { data } = await db.from("monthly_statements").select("*").eq("id", statementId).maybeSingle();
  if (!data || data.status === "draft") throw denied;
  try {
    await requireCpa(db, userId, data.property_id as string);
  } catch {
    throw denied; // another LLC's statement looks exactly like one that doesn't exist
  }
  return data as Record<string, any>;
}

export async function cpaReadStatement(db: Db, p: { userId: string; statementId: string }) {
  const row = await loadStatement(db, p.userId, p.statementId);
  const names = await memberNames(db, row.property_id);
  return { id: row.id as string, propertyId: row.property_id as string, version: row.version as number, status: row.status as "issued" | "superseded", issuedAt: row.issued_at as string | null, holder: names.get(row.member_key) ?? "Member", snapshot: row.data_snapshot as StatementSnapshot };
}

export async function cpaStatementPdf(db: Db, p: { userId: string; statementId: string }) {
  const row = await loadStatement(db, p.userId, p.statementId);
  const names = await memberNames(db, row.property_id);
  const bytes = renderStatementPdf({ snapshot: row.data_snapshot, memberLabel: names.get(row.member_key) ?? "Member", version: row.version, status: row.status, issuedAt: row.issued_at });
  await audit(db, p.userId, "cpa.statement_downloaded", "monthly_statement", row.id, { property_id: row.property_id, period: row.period, version: row.version });
  return { filename: statementFileName(row.data_snapshot, row.version), base64: Buffer.from(bytes).toString("base64") };
}

/** The CPA Cooperation Worksheet: the flags and, once the Year-End packet exists, its items. Read-only: the CPA annotates nothing here. */
export async function cpaWorksheet(db: Db, p: { userId: string; propertyId: string }) {
  await requireCpa(db, p.userId, p.propertyId);
  const { data: flags } = await db.from("cpa_worksheet_flags").select("*").eq("property_id", p.propertyId).order("created_at", { ascending: false });
  const items = await db.from("cpa_worksheet_items").select("*").eq("property_id", p.propertyId);
  return {
    flags: ((flags ?? []) as Array<Record<string, any>>).map((f) => ({ id: f.id as string, type: f.flag_type as string, note: (f.note ?? null) as string | null, createdAt: (f.created_at ?? null) as string | null })),
    items: items.error ? [] : ((items.data ?? []) as Array<Record<string, any>>).map((i) => ({ id: i.id as string, kind: (i.kind ?? i.item_type ?? "") as string, note: (i.manager_note ?? i.note ?? null) as string | null })),
  };
}

/** The Year-End Export Packets generated for this LLC. Only their general files are listed: the files with TINs are never offered here. */
export async function cpaPackets(db: Db, p: { userId: string; propertyId: string }) {
  await requireCpa(db, p.userId, p.propertyId);
  const r = await db.from("year_end_packets").select("id, year, version, hash, generated_at, files").eq("property_id", p.propertyId).order("year", { ascending: false });
  return {
    packets: r.error
      ? []
      : ((r.data ?? []) as Array<Record<string, any>>).map((x) => ({
          id: x.id as string,
          year: x.year as number,
          version: x.version as number,
          hash: x.hash as string,
          createdAt: x.generated_at as string,
          files: ((x.files ?? []) as Array<{ name: string; kind: string; bytes: number; pii: boolean }>).filter((f) => !f.pii).map((f) => ({ name: f.name, kind: f.kind, bytes: f.bytes })),
        })),
  };
}

/** Download a general file of a packet (the CPA never gets the TIN files). Logged. */
export async function cpaDownloadPacketFile(db: Db, p: { userId: string; packetId: string; file: string }) {
  const denied = new Error("File not found.");
  const { data } = await db.from("year_end_packets").select("id, property_id").eq("id", p.packetId).maybeSingle();
  if (!data) throw denied;
  try {
    await requireCpa(db, p.userId, data.property_id as string);
  } catch {
    throw denied;
  }
  const { readGeneralPacketFile } = await import("@/lib/year-end-packet.server");
  const f = await readGeneralPacketFile(db, { propertyId: data.property_id as string, packetId: p.packetId, file: p.file });
  await audit(db, p.userId, "cpa.packet_downloaded", "year_end_packet", p.packetId, { property_id: data.property_id, file: f.filename });
  return { filename: f.filename, base64: f.base64 };
}

/** The members of the LLC, by legal name. The TIN is not here: it is shown only through cpaRevealTin, which logs every view. */
export async function cpaRoster(db: Db, p: { userId: string; propertyId: string }) {
  await requireCpa(db, p.userId, p.propertyId);
  const { data: cap } = await db.from("cap_table_entries").select("buyer_account_id").eq("property_id", p.propertyId);
  const shares = new Map<string, number>();
  for (const c of (cap ?? []) as Array<{ buyer_account_id: string | null }>) if (c.buyer_account_id) shares.set(c.buyer_account_id, (shares.get(c.buyer_account_id) ?? 0) + 1);
  const members = [];
  for (const [account, n] of shares) {
    const { data: w9s } = await db.from("member_w9").select("id, legal_name, tin_kind").eq("buyer_account_id", account);
    for (const w of (w9s ?? []) as Array<{ id: string; legal_name: string; tin_kind: string }>) members.push({ w9Id: w.id, legalName: w.legal_name, tinKind: w.tin_kind, accountShares: n });
  }
  return { members: members.sort((a, b) => a.legalName.localeCompare(b.legalName)) };
}

/** Show one member's TIN to the CPA, for K-1 preparation. Logged every time, with the property; never in an error. */
export async function cpaRevealTin(db: Db, p: { userId: string; propertyId: string; w9Id: string; note?: string | null }) {
  await requireCpa(db, p.userId, p.propertyId);
  return viewTinAsCpa(db, p);
}
