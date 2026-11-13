/**
 * Versioned Terms and Conditions (server side): publishing, change notices, delivery records, implicit acceptance, and what each person is bound by.
 *
 * Only publishing a Terms version sends a Terms notice. A revision of the Priority Reservation Agreement or the Operating Agreement lives in
 * legal-documents.ts and the entity records; it never reaches this file, never notifies anyone as a Terms change, and never touches an executed document.
 */
import type { RequestContext } from "@/lib/account-members.server";
import { deliver } from "@/lib/authorization.notify.server";
import { BASELINE, diffPath, inForceVersion, noticeMessage, publishProblem, today, upcomingVersion, type PublishInput, type TcVersion } from "@/lib/tc";

type Db = { from: (t: string) => any; rpc?: (n: string, a: Record<string, unknown>) => any };
const MISSING_SCHEMA = "Database is missing the Terms tables: run tc-versions.sql in Supabase.";
const siteUrl = () => (process.env.SITE_URL ?? "https://divieight.vercel.app").replace(/\/$/, "");

export async function requireAdmin(db: Db, userId: string) {
  const { data } = await db.rpc!("has_role", { _user_id: userId, _role: "admin" });
  if (data !== true) throw new Error("Only the Manager can publish the Terms.");
}

/** The first version is the Terms as they stood when versioning began. It is made once, quietly: it is not a change, so it notifies no one. */
export async function ensureBaseline(db: Db): Promise<void> {
  const { data, error } = await db.from("tc_versions").select("id").limit(1);
  if (error) throw new Error(MISSING_SCHEMA);
  if (((data ?? []) as unknown[]).length > 0) return;
  const { error: insertError } = await db.from("tc_versions").insert({
    version: BASELINE.version,
    effective_date: BASELINE.effectiveDate,
    body: BASELINE.body,
    is_material: false,
    summary_of_changes: null,
    published_by: null,
    published_at: `${BASELINE.effectiveDate}T00:00:00.000Z`,
    previous_version_id: null,
    is_current: true,
  });
  if (insertError && insertError.code !== "23505") throw new Error(MISSING_SCHEMA);
}

/** Every published version, newest first. Previous versions stay readable here for good. */
export async function listVersions(db: Db): Promise<TcVersion[]> {
  await ensureBaseline(db);
  const { data, error } = await db.from("tc_versions").select("*");
  if (error) throw new Error(MISSING_SCHEMA);
  return ((data ?? []) as TcVersion[]).sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)) || b.effective_date.localeCompare(a.effective_date));
}

export async function getVersion(db: Db, version: string): Promise<TcVersion | null> {
  const all = await listVersions(db);
  return all.find((v) => v.version === version) ?? null;
}

/** What the public /terms page shows: the version in force today (or the one asked for), the upcoming one, and the history. No body for the list. */
export async function publicTerms(db: Db, p: { version?: string | null; now?: Date }) {
  const all = await listVersions(db);
  const day = today(p.now);
  const inForce = inForceVersion(all, day) ?? all[all.length - 1]!;
  const shown = (p.version ? all.find((v) => v.version === p.version) : null) ?? inForce;
  const upcoming = upcomingVersion(all, day);
  const previous = all.find((v) => v.id === shown.previous_version_id) ?? null;
  return {
    shown,
    inForceVersion: inForce.version,
    upcoming: upcoming ? { version: upcoming.version, effectiveDate: upcoming.effective_date } : null,
    previousVersion: previous?.version ?? null,
    history: all.map((v) => ({ version: v.version, effectiveDate: v.effective_date, isMaterial: v.is_material, summary: v.summary_of_changes, publishedAt: v.published_at, isCurrent: v.is_current, inForce: v.id === inForce.id })),
  };
}

/** Two versions for the marked diff. */
export async function versionPair(db: Db, fromVersion: string, toVersion: string) {
  const [from, to] = [await getVersion(db, fromVersion), await getVersion(db, toVersion)];
  if (!from || !to) throw new Error("That version does not exist.");
  return { from, to };
}

// ---------------------------------------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------------------------------------
export async function publishTcVersion(db: Db, p: { adminId: string; input: PublishInput; now?: Date; notify?: boolean }) {
  await requireAdmin(db, p.adminId);
  const all = await listVersions(db);
  const input: PublishInput = { ...p.input, version: p.input.version.trim(), summary: (p.input.summary ?? "").trim() };
  const problem = publishProblem(input, all, today(p.now));
  if (problem) throw new Error(problem);
  const current = all.find((v) => v.is_current) ?? null;
  // Exactly one current version: clear the old flag, insert the new one as current, and put the old one back if that fails.
  if (current) {
    const { error } = await db.from("tc_versions").update({ is_current: false }).eq("id", current.id);
    if (error) throw new Error(MISSING_SCHEMA);
  }
  const { data: row, error } = await db
    .from("tc_versions")
    .insert({
      version: input.version,
      effective_date: input.effectiveDate,
      body: input.body,
      is_material: input.isMaterial,
      summary_of_changes: input.summary || null,
      published_by: p.adminId,
      published_at: (p.now ?? new Date()).toISOString(),
      previous_version_id: current?.id ?? null,
      is_current: true,
    })
    .select("*")
    .single();
  if (error || !row) {
    if (current) await db.from("tc_versions").update({ is_current: true }).eq("id", current.id);
    throw new Error(error?.message ?? "The Terms could not be published.");
  }
  const version = row as TcVersion;
  await db.from("audit_log").insert({
    actor_id: p.adminId,
    actor_type: "admin",
    action_type: "tc.version_published",
    entity_type: "tc_version",
    entity_id: version.id,
    metadata: { version: version.version, effective_date: version.effective_date, is_material: version.is_material, previous_version: current?.version ?? null, summary_of_changes: version.summary_of_changes },
  });
  // A non-material edit is published and readable, but nobody is notified.
  const notices = version.is_material && p.notify !== false ? await sendTcNotices(db, { versionId: version.id, adminId: p.adminId }) : null;
  return { version, notices };
}

// ---------------------------------------------------------------------------------------------------------
// Change notices: every user, once, with the summary, the diff link and the effective date
// ---------------------------------------------------------------------------------------------------------
export interface Recipient {
  authUserId: string;
  email: string | null;
}

/** Every login on the platform: buyers, sellers, agents, brokers, designated CPAs and the Manager. One entry per person. */
export async function allRecipients(db: Db): Promise<Recipient[]> {
  const map = new Map<string, Recipient>();
  const add = (id: unknown, email: unknown) => {
    if (typeof id !== "string" || !id) return;
    const e = typeof email === "string" && email.trim() ? email.trim() : null;
    const have = map.get(id);
    if (!have) map.set(id, { authUserId: id, email: e });
    else if (!have.email && e) have.email = e;
  };
  const read = async (table: string, cols: string) => ((await db.from(table).select(cols)).data ?? []) as Array<Record<string, unknown>>;
  for (const r of await read("buyer_accounts", "auth_user_id, email")) add(r.auth_user_id, r.email);
  for (const r of await read("sellers", "id, email")) add(r.id, r.email);
  for (const r of await read("agents", "auth_user_id, email")) add(r.auth_user_id, r.email);
  for (const r of await read("brokers", "auth_user_id, email")) add(r.auth_user_id, r.email);
  for (const r of await read("cpa_designations", "auth_user_id, email")) add(r.auth_user_id, r.email);
  const { data: admins } = await db.from("user_roles").select("user_id").eq("role", "admin");
  for (const r of (admins ?? []) as Array<{ user_id: string }>) add(r.user_id, null);
  return [...map.values()];
}

/**
 * Notify every user of a material version, once each. Safe to run again: anyone already notified is skipped, so a retry reaches only those missed.
 * Each person gets the in-app notification and the email (to the login and to each member of a Buyer Account); both are recorded.
 */
export async function sendTcNotices(db: Db, p: { versionId: string; adminId?: string | null }) {
  const all = await listVersions(db);
  const version = all.find((v) => v.id === p.versionId);
  if (!version) throw new Error("Version not found.");
  if (!version.is_material) throw new Error("Only a material revision is notified.");
  const previous = all.find((v) => v.id === version.previous_version_id);
  const diffUrl = `${siteUrl()}${diffPath(previous?.version ?? BASELINE.version, version.version)}`;
  const { subject, message } = noticeMessage({ version: version.version, effectiveDate: version.effective_date, summary: version.summary_of_changes ?? "", diffUrl });

  const { data: done } = await db.from("tc_notice_deliveries").select("auth_user_id, channel").eq("tc_version_id", version.id);
  const already = new Set(((done ?? []) as Array<{ auth_user_id: string; channel: string }>).filter((d) => d.channel === "portal").map((d) => d.auth_user_id));
  const recipients = await allRecipients(db);
  let notified = 0;
  let emailed = 0;
  let skipped = 0;
  for (const r of recipients) {
    if (already.has(r.authUserId)) {
      skipped++;
      continue;
    }
    const result = await deliver(db as never, { authUserId: r.authUserId, email: r.email }, { subject, message, link: diffUrl, type: "tc_update", dedupeKey: `tc:${version.id}:${r.authUserId}` });
    if (result.duplicate) {
      skipped++;
      continue;
    }
    const at = new Date().toISOString();
    const rows = [
      { tc_version_id: version.id, auth_user_id: r.authUserId, channel: "portal", delivered: result.portal, delivered_at: at },
      { tc_version_id: version.id, auth_user_id: r.authUserId, channel: "email", delivered: result.emailed, delivered_at: at },
    ];
    const { error } = await db.from("tc_notice_deliveries").insert(rows);
    if (error && error.code !== "23505") throw new Error(MISSING_SCHEMA);
    if (result.portal) notified++;
    if (result.emailed) emailed++;
  }
  await db.from("audit_log").insert({
    actor_id: p.adminId ?? null,
    actor_type: p.adminId ? "admin" : "system",
    action_type: "tc.notices_sent",
    entity_type: "tc_version",
    entity_id: version.id,
    metadata: { version: version.version, recipients: recipients.length, notified, emailed, already_notified: skipped, effective_date: version.effective_date },
  });
  return { recipients: recipients.length, notified, emailed, skipped };
}

/** The delivery record: who was told, when, on which channel, and who was missed. */
export async function deliveryReport(db: Db, p: { adminId: string; versionId: string }) {
  await requireAdmin(db, p.adminId);
  const { data } = await db.from("tc_notice_deliveries").select("*").eq("tc_version_id", p.versionId);
  const rows = ((data ?? []) as Array<{ auth_user_id: string; channel: string; delivered: boolean; delivered_at: string }>).sort((a, b) => String(a.delivered_at).localeCompare(String(b.delivered_at)));
  const recipients = await allRecipients(db);
  const portal = new Set(rows.filter((r) => r.channel === "portal" && r.delivered).map((r) => r.auth_user_id));
  return {
    recipients: recipients.length,
    portalDelivered: portal.size,
    emailDelivered: rows.filter((r) => r.channel === "email" && r.delivered).length,
    emailNotDelivered: rows.filter((r) => r.channel === "email" && !r.delivered).length,
    notYetNotified: recipients.filter((r) => !portal.has(r.authUserId)).length,
    rows: rows.slice(0, 500).map((r) => ({ userId: r.auth_user_id, channel: r.channel, delivered: r.delivered, at: r.delivered_at })),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Implicit acceptance, and what a person is bound by
// ---------------------------------------------------------------------------------------------------------
/**
 * Continued use after a version's effective date is acceptance of it, as the Terms' own change clause says. Recorded once per person per version, with the
 * version. Nobody is made to re-sign. (ASSUMPTION: counsel confirms that continued use is enough.)
 */
export async function recordImplicitAcceptance(db: Db, p: { userId: string; request: RequestContext; now?: Date }) {
  const all = await listVersions(db);
  const version = inForceVersion(all, today(p.now));
  if (!version) return { recorded: false as const, version: null };
  const { data: existing } = await db.from("tc_acceptances").select("id").eq("auth_user_id", p.userId).eq("tc_version_id", version.id).maybeSingle();
  if (existing) return { recorded: false as const, version: version.version };
  const { error } = await db.from("tc_acceptances").insert({
    auth_user_id: p.userId,
    tc_version_id: version.id,
    version: version.version,
    kind: "implicit_continued_use",
    accepted_at: (p.now ?? new Date()).toISOString(),
    ip_address: p.request.ip,
    user_agent: p.request.userAgent,
  });
  if (error && error.code !== "23505") throw new Error(MISSING_SCHEMA);
  if (error) return { recorded: false as const, version: version.version };
  await db.from("audit_log").insert({
    actor_id: p.userId,
    actor_type: "user",
    action_type: "tc.implicit_acceptance",
    entity_type: "tc_version",
    entity_id: version.id,
    metadata: { version: version.version, kind: "implicit_continued_use", effective_date: version.effective_date, ip_address: p.request.ip },
  });
  return { recorded: true as const, version: version.version };
}

/** For account settings: the version this person is bound by, any version still to come, their acceptances, and every version's history. */
export async function myTermsStatus(db: Db, p: { userId: string; now?: Date }) {
  const all = await listVersions(db);
  const day = today(p.now);
  const inForce = inForceVersion(all, day);
  const upcoming = upcomingVersion(all, day);
  const { data } = await db.from("tc_acceptances").select("*").eq("auth_user_id", p.userId);
  const acceptances = ((data ?? []) as Array<{ version: string; kind: string; accepted_at: string }>).sort((a, b) => String(b.accepted_at).localeCompare(String(a.accepted_at)));
  const { data: notices } = await db.from("tc_notice_deliveries").select("tc_version_id, channel, delivered, delivered_at").eq("auth_user_id", p.userId);
  const told = (notices ?? []) as Array<{ tc_version_id: string; channel: string; delivered: boolean; delivered_at: string }>;
  return {
    boundBy: inForce ? { version: inForce.version, effectiveDate: inForce.effective_date, acceptedAt: acceptances.find((a) => a.version === inForce.version)?.accepted_at ?? null } : null,
    upcoming: upcoming ? { version: upcoming.version, effectiveDate: upcoming.effective_date, summary: upcoming.summary_of_changes } : null,
    acceptances: acceptances.map((a) => ({ version: a.version, kind: a.kind, acceptedAt: a.accepted_at })),
    history: all.map((v) => ({
      version: v.version,
      effectiveDate: v.effective_date,
      isMaterial: v.is_material,
      summary: v.summary_of_changes,
      isCurrent: v.is_current,
      previousVersion: all.find((x) => x.id === v.previous_version_id)?.version ?? null,
      notifiedAt: told.find((n) => n.tc_version_id === v.id && n.channel === "portal" && n.delivered)?.delivered_at ?? null,
    })),
  };
}
