/**
 * Held accounts: the nightly reminder, and the admin list.
 *
 * A member whose result is 'held' (a disclosed charge not yet resolved) keeps the whole account held. Nothing here does
 * anything to the account: it is never warned, forfeited or charged, and neither the buyer nor the agent is told anything.
 * After a member has been held for heldReminderDays (30 by default), and no reminder has gone in that long, ONE
 * notification goes to the admins, and the account shows in the Held accounts list. An admin can snooze it for 30 days
 * with a note. The list and the notification carry a member label, the account, the days held and the last reminder:
 * never the declaration, the answers or the reason.
 */
import { adminRecipients, deliver } from "@/lib/authorization.notify.server";
import { currentResultOf, type EligibilityResult } from "@/lib/eligibility-engine";
import { HELD_SNOOZE_DAYS } from "@/lib/governance-config";
import { loadGovernanceConfig } from "@/lib/governance-config.server";

type Db = { from: (t: string) => any };

const DAY = 86_400_000;
const TABLE = "held_followups";
const MISSING_SCHEMA = "Database is missing the held-account follow-ups: run rules-and-held-decisions.sql in Supabase.";

export interface HeldMember {
  memberId: string;
  accountId: string;
  label: string;
  accountEmail: string | null;
  heldSince: number;
}

export interface HeldAccountRow {
  memberId: string;
  /** A name and a role, nothing else about the member. */
  memberLabel: string;
  accountEmail: string | null;
  daysHeld: number;
  lastReminderAt: string | null;
  snoozedUntil: string | null;
  snoozeNote: string | null;
}

type ResultRow = { account_member_id: string; declaration_id: string; determined_at: string; result: EligibilityResult };

/** Every active member whose current result is held, and since when (the start of the unbroken run of held results). */
export async function heldMembers(db: Db): Promise<HeldMember[]> {
  const { data: members } = await db.from("account_members").select("id, buyer_account_id, full_name, role").eq("status", "active");
  const { data: results, error } = await db.from("eligibility_results").select("account_member_id, declaration_id, determined_at, result");
  if (error) return [];
  const { data: declarations } = await db.from("eligibility_declarations").select("id, account_member_id, status");
  const { data: accounts } = await db.from("buyer_accounts").select("id, email");
  const emailOf = new Map(((accounts ?? []) as Array<{ id: string; email: string | null }>).map((a) => [a.id, a.email]));
  const all = (results ?? []) as ResultRow[];
  const out: HeldMember[] = [];
  for (const m of (members ?? []) as Array<{ id: string; buyer_account_id: string; full_name: string | null; role: string }>) {
    const decl = ((declarations ?? []) as Array<{ id: string; account_member_id: string; status: string }>).find((d) => d.account_member_id === m.id && d.status === "complete");
    const current = currentResultOf(all, m.id, decl?.id ?? null);
    if (current?.result !== "held") continue;
    const mine = all.filter((r) => r.account_member_id === m.id).sort((a, b) => (a.determined_at < b.determined_at ? -1 : 1));
    let i = mine.length - 1;
    while (i > 0 && mine[i - 1]!.result === "held") i -= 1;
    const role = m.role === "primary" ? "account holder" : "second member";
    out.push({
      memberId: m.id,
      accountId: m.buyer_account_id,
      label: (m.full_name ?? "").trim() ? `${(m.full_name ?? "").trim()} (${role})` : `Member (${role})`,
      accountEmail: emailOf.get(m.buyer_account_id) ?? null,
      heldSince: new Date(mine[i]!.determined_at).getTime(),
    });
  }
  return out;
}

type Followup = { account_member_id: string; kind: "reminder" | "snooze"; until: string | null; note: string | null; created_at: string };

async function followupsOf(db: Db, memberIds: string[]): Promise<Map<string, Followup[]>> {
  const map = new Map<string, Followup[]>();
  if (memberIds.length === 0) return map;
  const { data } = await db.from(TABLE).select("account_member_id, kind, until, note, created_at").in("account_member_id", memberIds);
  for (const f of (data ?? []) as Followup[]) map.set(f.account_member_id, [...(map.get(f.account_member_id) ?? []), f]);
  return map;
}

const latest = (rows: Followup[], kind: Followup["kind"]) => rows.filter((r) => r.kind === kind).sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] ?? null;

/**
 * The nightly job. Safe to repeat: a member who was reminded (or is snoozed) isn't reminded again until the days have run.
 * Returns how many reminders went out.
 */
export async function runHeldReminders(db: Db, now: number = Date.now()): Promise<{ held: number; reminded: number }> {
  const days = (await loadGovernanceConfig(db)).heldReminderDays;
  const held = await heldMembers(db);
  const followups = await followupsOf(db, held.map((h) => h.memberId));
  let reminded = 0;
  for (const h of held) {
    const heldDays = Math.floor((now - h.heldSince) / DAY);
    if (heldDays < days) continue;
    const mine = followups.get(h.memberId) ?? [];
    const snooze = latest(mine, "snooze");
    if (snooze?.until && new Date(snooze.until).getTime() > now) continue;
    const last = latest(mine, "reminder");
    if (last && now - new Date(last.created_at).getTime() < days * DAY) continue;

    // Written first: if it can't be recorded, nobody is notified, so a missing table can't mean a reminder every night.
    const { error } = await db.from(TABLE).insert({ account_member_id: h.memberId, buyer_account_id: h.accountId, kind: "reminder", days_held: heldDays, created_at: new Date(now).toISOString() });
    if (error) continue;
    reminded += 1;
    for (const admin of await adminRecipients(db as never)) {
      await deliver(db as never, admin, {
        subject: "A held account needs a look",
        message: `${h.label} on the account ${h.accountEmail ?? "(no email)"} has been held for ${heldDays} days. See the Held accounts list.`,
        link: "/admin/held-accounts",
        type: "held_reminder",
        dedupeKey: `held_reminder:${h.memberId}:${new Date(now).toISOString().slice(0, 10)}`,
      });
    }
    await db.from("audit_log").insert({ actor_id: null, actor_type: "system", action_type: "held.reminder_raised", entity_type: "buyer_account", entity_id: h.accountId, metadata: { account_member_id: h.memberId, days_held: heldDays } });
  }
  return { held: held.length, reminded };
}

/** The admin's Held accounts list: who, which account, how long, and when the last reminder was. No declaration, no reason. */
export async function adminHeldAccounts(db: Db, now: number = Date.now()): Promise<{ rows: HeldAccountRow[] }> {
  const held = await heldMembers(db);
  const followups = await followupsOf(db, held.map((h) => h.memberId));
  const rows = held.map((h) => {
    const mine = followups.get(h.memberId) ?? [];
    const snooze = latest(mine, "snooze");
    const snoozed = snooze?.until && new Date(snooze.until).getTime() > now;
    return {
      memberId: h.memberId,
      memberLabel: h.label,
      accountEmail: h.accountEmail,
      daysHeld: Math.floor((now - h.heldSince) / DAY),
      lastReminderAt: latest(mine, "reminder")?.created_at ?? null,
      snoozedUntil: snoozed ? (snooze!.until as string) : null,
      snoozeNote: snoozed ? snooze!.note : null,
    };
  });
  return { rows: rows.sort((a, b) => b.daysHeld - a.daysHeld) };
}

/** Snooze for 30 days, with a note. Only a member who is held can be snoozed. */
export async function snoozeHeldAccount(db: Db, params: { adminId: string; memberId: string; note: string; now?: number }): Promise<{ snoozedUntil: string }> {
  const note = params.note.trim();
  if (!note) throw new Error("Add a note saying why it is being snoozed.");
  const now = params.now ?? Date.now();
  const member = (await heldMembers(db)).find((h) => h.memberId === params.memberId);
  if (!member) throw new Error("That member isn't held.");
  const until = new Date(now + HELD_SNOOZE_DAYS * DAY).toISOString();
  const { error } = await db.from(TABLE).insert({ account_member_id: member.memberId, buyer_account_id: member.accountId, kind: "snooze", until, note: note.slice(0, 1000), admin_id: params.adminId, created_at: new Date(now).toISOString() });
  if (error) throw new Error(MISSING_SCHEMA);
  await db.from("audit_log").insert({ actor_id: params.adminId, actor_type: "admin", action_type: "held.snoozed", entity_type: "buyer_account", entity_id: member.accountId, metadata: { account_member_id: member.memberId, until, note: note.slice(0, 1000) } });
  return { snoozedUntil: until };
}
