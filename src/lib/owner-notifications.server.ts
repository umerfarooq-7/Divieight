/**
 * Owner notifications (server side). Everything goes through deliver(): the existing
 * notifications table and the existing email sender. The dedupe key is what makes
 * each event one notification per owner, however often a sweep runs.
 */

import { deliver } from "@/lib/authorization.notify.server";
import { expenseMoney, isValidMoney, splitProRata, todayIso } from "@/lib/expenses";
import { holderRecipient } from "@/lib/expenses.server";
import { isMandatoryNotification, OWNER_NOTIFICATION_TYPES, type OwnerNotificationType } from "@/lib/owner-notifications";
import { holdersAsOf } from "@/lib/record-date-holders.server";
import { holderRecipients } from "@/lib/votes.server";

type Db = { from: (t: string) => any };

const MISSING_SCHEMA = "Database is missing owner notifications — run owner-notifications.sql in Supabase.";
const HOUR = 3_600_000;

/** Everyone who owns this property right now, once each, and no one else. */
export async function notifyOwners(
  db: Db,
  propertyId: string,
  args: { type: OwnerNotificationType; subject: string; message: string; link: string; dedupeKey: string; exceptUserId?: string },
) {
  let sent = 0;
  for (const owner of await holderRecipients(db, propertyId)) {
    if (owner.authUserId === args.exceptUserId) continue;
    const result = await deliver(db as never, owner, { subject: args.subject, message: args.message, link: args.link, type: args.type, propertyId, dedupeKey: args.dedupeKey });
    if (!result.duplicate) sent += 1;
  }
  return sent;
}

/** Hourly. Each reminder goes once, inside its window. Passed deadlines send nothing. */
export async function sendOwnerReminders(db: Db, now = new Date()): Promise<{ sent: number }> {
  const at = now.toISOString();
  const within = (hours: number) => new Date(now.getTime() + hours * HOUR).toISOString();
  let sent = 0;

  // Votes closing in 48 hours.
  const { data: votes } = await db.from("votes").select("id, property_id, title, closes_at").eq("status", "open").gt("closes_at", at).lte("closes_at", within(48));
  for (const v of (votes ?? []) as Array<{ id: string; property_id: string; title: string }>) {
    sent += await notifyOwners(db, v.property_id, {
      type: "governance_vote_window",
      subject: "A vote closes within 48 hours",
      message: `The vote "${v.title}" closes within 48 hours. Cast your ballot from your owner dashboard.`,
      link: `/owner/properties/${v.property_id}/votes/${v.id}`,
      dedupeKey: `vote_closing:${v.id}`,
    });
  }

  // Capital calls due within 7 days: only those who still owe, with their own amount.
  const weekOut = todayIso(new Date(now.getTime() + 7 * 24 * HOUR));
  const { data: calls, error: callsError } = await db.from("capital_calls").select("id, property_id, title, due_date").eq("status", "issued").gte("due_date", todayIso(now)).lte("due_date", weekOut);
  if (!callsError) {
    for (const c of (calls ?? []) as Array<{ id: string; property_id: string; title: string; due_date: string }>) {
      const { data: owing } = await db.from("capital_call_allocations").select("holder_key, amount").eq("capital_call_id", c.id).eq("status", "due");
      for (const a of (owing ?? []) as Array<{ holder_key: string; amount: number }>) {
        const recipient = await holderRecipient(db, a.holder_key);
        if (!recipient) continue;
        const r = await deliver(db as never, recipient, {
          subject: "A capital call is due within 7 days",
          message: `Your ${expenseMoney(a.amount)} share of "${c.title}" is due ${c.due_date}.`,
          link: `/owner/properties/${c.property_id}/capital-calls`,
          type: "capital_call_alert",
          propertyId: c.property_id,
          dedupeKey: `call_due:${c.id}`,
        });
        if (!r.duplicate) sent += 1;
      }
    }
  }

  // Use Calendar turns ending within 12 hours: only the holder whose turn it is.
  const { data: years } = await db.from("use_calendar_years").select("id, property_id, year, turn_holder_key, turn_seq").eq("status", "selection_open").gt("turn_deadline_at", at).lte("turn_deadline_at", within(12));
  for (const y of (years ?? []) as Array<{ id: string; property_id: string; year: number; turn_holder_key: string | null; turn_seq: number }>) {
    if (!y.turn_holder_key) continue;
    const recipient = await holderRecipient(db, y.turn_holder_key);
    if (!recipient) continue;
    const r = await deliver(db as never, recipient, {
      subject: "Your Use Calendar turn ends within 12 hours",
      message: `Your turn to pick a ${y.year} Use Calendar week ends within 12 hours.`,
      link: `/owner/properties/${y.property_id}/calendar`,
      type: "calendar_turn",
      propertyId: y.property_id,
      dedupeKey: `calendar_deadline:${y.id}:${y.turn_seq}`,
    });
    if (!r.duplicate) sent += 1;
  }

  // Rights of first refusal closing within 24 hours: the co-owners, not the seller.
  const { data: listings, error: listingsError } = await db.from("resale_listings").select("id, property_id, share_number, seller_user_id").eq("status", "rofr_open").gt("rofr_closes_at", at).lte("rofr_closes_at", within(24));
  if (!listingsError) {
    for (const l of (listings ?? []) as Array<{ id: string; property_id: string; share_number: number; seller_user_id: string }>) {
      sent += await notifyOwners(db, l.property_id, {
        type: "resale_activity",
        subject: "A right of first refusal closes within 24 hours",
        message: `Your right of first refusal on share #${l.share_number} closes within 24 hours.`,
        link: `/owner/properties/${l.property_id}/resale`,
        dedupeKey: `rofr_closing:${l.id}`,
        exceptUserId: l.seller_user_id,
      });
    }
  }
  return { sent };
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

async function isOwner(db: Db, userId: string): Promise<boolean> {
  const { data: buyer } = await db.from("buyer_accounts").select("id").eq("auth_user_id", userId).maybeSingle();
  if (buyer) {
    const { data } = await db.from("cap_table_entries").select("property_id").eq("buyer_account_id", buyer.id).limit(1);
    if ((data ?? []).length) return true;
  }
  const { data } = await db.from("cap_table_entries").select("property_id").eq("seller_id", userId).limit(1);
  return (data ?? []).length > 0;
}

export async function ownerPreferences(db: Db, userId: string) {
  if (!(await isOwner(db, userId))) return { isOwner: false, preferences: [] };
  const { data } = await db.from("owner_notification_preferences").select("type, email_enabled").eq("user_id", userId);
  const off = new Set(((data ?? []) as Array<{ type: string; email_enabled: boolean }>).filter((r) => r.email_enabled === false).map((r) => r.type));
  return {
    isOwner: true,
    preferences: (Object.keys(OWNER_NOTIFICATION_TYPES) as OwnerNotificationType[]).map((type) => ({
      type,
      label: OWNER_NOTIFICATION_TYPES[type].label,
      mandatory: OWNER_NOTIFICATION_TYPES[type].mandatory,
      emailEnabled: isMandatoryNotification(type) || !off.has(type),
    })),
  };
}

export async function setOwnerPreference(db: Db, params: { userId: string; type: OwnerNotificationType; emailEnabled: boolean }) {
  if (isMandatoryNotification(params.type)) throw new Error("This notice is required and can't be switched off.");
  if (!(await isOwner(db, params.userId))) throw new Error("Not authorized");
  const { error } = await db
    .from("owner_notification_preferences")
    .upsert({ user_id: params.userId, type: params.type, email_enabled: params.emailEnabled, updated_at: new Date().toISOString() }, { onConflict: "user_id,type" });
  if (error) throw new Error(MISSING_SCHEMA);
}

/** Names for the bell's headings: only properties this person has notifications about. */
export async function notificationPropertyLabels(db: Db, userId: string, propertyIds: string[]): Promise<Record<string, string>> {
  if (propertyIds.length === 0) return {};
  const { data: own } = await db.from("notifications").select("property_id").eq("seller_id", userId).in("property_id", propertyIds);
  const allowed = [...new Set(((own ?? []) as Array<{ property_id: string }>).map((n) => n.property_id))];
  if (allowed.length === 0) return {};
  const { data } = await db.from("properties").select("id, address, city, state").in("id", allowed);
  return Object.fromEntries(((data ?? []) as Array<{ id: string; address: string | null; city: string | null; state: string | null }>).map((p) => [p.id, [p.address, p.city, p.state].filter(Boolean).join(", ") || "A property"]));
}

// ---------------------------------------------------------------------------
// Distributions (display only)
// ---------------------------------------------------------------------------

export async function adminDistributions(db: Db) {
  const { data: rows, error } = await db.from("distribution_events").select("*").order("created_at", { ascending: false });
  if (error) throw new Error(MISSING_SCHEMA);
  const { data: cap } = await db.from("cap_table_entries").select("property_id");
  const propertyIds = [...new Set([...((cap ?? []) as Array<{ property_id: string }>).map((c) => c.property_id), ...((rows ?? []) as Array<{ property_id: string }>).map((r) => r.property_id)])];
  const { data: properties } = propertyIds.length ? await db.from("properties").select("id, address, city, state").in("id", propertyIds) : { data: [] };
  const labels = new Map(((properties ?? []) as Array<{ id: string; address: string | null; city: string | null; state: string | null }>).map((p) => [p.id, [p.address, p.city, p.state].filter(Boolean).join(", ")]));
  const owned = new Set(((cap ?? []) as Array<{ property_id: string }>).map((c) => c.property_id));
  return {
    properties: [...owned].map((id) => ({ id, label: labels.get(id) ?? "Property" })).sort((a, b) => a.label.localeCompare(b.label)),
    rows: ((rows ?? []) as DistributionRow[]).map((r) => ({
      id: r.id,
      propertyLabel: labels.get(r.property_id) ?? "Property",
      totalAmount: Number(r.total_amount),
      recordDate: r.record_date,
      note: r.note,
      createdAt: r.created_at,
      status: (r.status ?? "posted") as "posted" | "voided",
      voidReason: r.void_reason ?? null,
      voidedAt: r.voided_at ?? null,
      replacesId: r.replaces_id ?? null,
      replacedById: r.replaced_by_id ?? null,
    })),
  };
}

interface DistributionRow {
  id: string;
  property_id: string;
  total_amount: number;
  record_date: string;
  note: string | null;
  created_at: string;
  status?: string | null;
  void_reason?: string | null;
  voided_at?: string | null;
  replaces_id?: string | null;
  replaced_by_id?: string | null;
  lines?: Array<{ holder_key: string; share_count: number; amount: number }> | null;
}

/**
 * Tells each owner their pro-rata amount, split on the holders ON THE RECORD DATE (rebuilt from cap_table_history), not
 * on today's cap table. Pays nothing and changes no balance. A posted distribution is never edited: a mistake is voided
 * and re-posted, and every version is kept.
 */
export async function postDistribution(db: Db, params: { adminId: string; propertyId: string; totalAmount: number; recordDate: string; note: string | null; replacesId?: string | null }): Promise<{ id: string }> {
  if (!isValidMoney(params.totalAmount)) throw new Error("The total must be above zero, with at most two decimal places.");
  const holders = await holdersAsOf(db, params.propertyId, params.recordDate);
  const lines = splitProRata(params.totalAmount, holders.map((h) => ({ holderKey: h.holderKey, shares: h.shares, rank: h.rank })));
  const base = { property_id: params.propertyId, total_amount: params.totalAmount, record_date: params.recordDate, note: params.note, created_by: params.adminId };
  let { data, error } = await db
    .from("distribution_events")
    .insert({ ...base, status: "posted", lines, replaces_id: params.replacesId ?? null })
    .select("id")
    .maybeSingle();
  // Before governance-and-money-decisions.sql is run the new columns aren't there: post the old way.
  if ((error || !data) && !params.replacesId) ({ data, error } = await db.from("distribution_events").insert(base).select("id").maybeSingle());
  if (error || !data) throw new Error(MISSING_SCHEMA);
  if (params.replacesId) await db.from("distribution_events").update({ replaced_by_id: data.id }).eq("id", params.replacesId);
  await db.from("audit_log").insert({
    actor_id: params.adminId,
    actor_type: "admin",
    action_type: "distribution.posted",
    entity_type: "distribution_event",
    entity_id: data.id,
    metadata: { property_id: params.propertyId, total_amount: params.totalAmount, record_date: params.recordDate, lines, holders_as_of: params.recordDate, replaces_id: params.replacesId ?? null },
  });
  for (const line of lines) {
    const recipient = await holderRecipient(db, line.holder_key);
    if (!recipient) continue;
    await deliver(db as never, recipient, {
      subject: "A distribution was posted",
      message: `A distribution of ${expenseMoney(params.totalAmount)} was posted for record date ${params.recordDate}. Your pro-rata amount is ${expenseMoney(line.amount)} (${line.share_count} ${line.share_count === 1 ? "share" : "shares"}). This is a notice only: no payment is made through divieight.${params.note ? ` Note: ${params.note}` : ""}`,
      link: `/owner/properties/${params.propertyId}`,
      type: "distribution_event",
      propertyId: params.propertyId,
      dedupeKey: `distribution:${data.id}`,
    });
  }
  return { id: data.id as string };
}

/**
 * Void a posted distribution, with a reason. Owners are told it is voided. Nothing is deleted: the row stays, marked
 * voided, with who voided it and why. It never paid anything, so there is nothing to claw back.
 */
export async function voidDistribution(db: Db, params: { adminId: string; distributionId: string; reason: string }): Promise<void> {
  const reason = params.reason.trim();
  if (!reason) throw new Error("Say why it is being voided.");
  const { data: found } = await db.from("distribution_events").select("*").eq("id", params.distributionId).maybeSingle();
  const row = found as DistributionRow | null;
  if (!row) throw new Error("Distribution not found.");
  if ((row.status ?? "posted") === "voided") throw new Error("This distribution is already voided.");
  const { data: voided, error } = await db
    .from("distribution_events")
    .update({ status: "voided", voided_at: new Date().toISOString(), voided_by: params.adminId, void_reason: reason.slice(0, 1000) })
    .eq("id", row.id)
    .eq("status", "posted")
    .select("id")
    .maybeSingle();
  if (error) throw new Error(MISSING_SCHEMA);
  if (!voided) throw new Error("This distribution is already voided.");
  await db.from("audit_log").insert({
    actor_id: params.adminId,
    actor_type: "admin",
    action_type: "distribution.voided",
    entity_type: "distribution_event",
    entity_id: row.id,
    metadata: { property_id: row.property_id, total_amount: Number(row.total_amount), record_date: row.record_date, reason },
  });
  // The same owners who were told about it.
  const lines = row.lines ?? splitProRata(Number(row.total_amount), (await holdersAsOf(db, row.property_id, row.record_date)).map((h) => ({ holderKey: h.holderKey, shares: h.shares, rank: h.rank })));
  for (const line of lines) {
    const recipient = await holderRecipient(db, line.holder_key);
    if (!recipient) continue;
    await deliver(db as never, recipient, {
      subject: "A distribution notice was voided",
      message: `The distribution of ${expenseMoney(Number(row.total_amount))} posted for record date ${row.record_date} is voided. Reason: ${reason}. Ignore the earlier amount; a corrected notice may follow. No payment was made through divieight, and no balance changed.`,
      link: `/owner/properties/${row.property_id}`,
      type: "distribution_event",
      propertyId: row.property_id,
      dedupeKey: `distribution_voided:${row.id}`,
    });
  }
}

/** Void and re-post: the old notice is voided with a reason and a corrected one is posted, linked to it. Both are kept. */
export async function repostDistribution(
  db: Db,
  params: { adminId: string; distributionId: string; reason: string; totalAmount: number; recordDate: string; note: string | null },
): Promise<{ id: string }> {
  if (!isValidMoney(params.totalAmount)) throw new Error("The total must be above zero, with at most two decimal places.");
  const { data: found } = await db.from("distribution_events").select("*").eq("id", params.distributionId).maybeSingle();
  const row = found as DistributionRow | null;
  if (!row) throw new Error("Distribution not found.");
  // Check the corrected split can be made before anything is voided.
  splitProRata(params.totalAmount, (await holdersAsOf(db, row.property_id, params.recordDate)).map((h) => ({ holderKey: h.holderKey, shares: h.shares, rank: h.rank })));
  await voidDistribution(db, { adminId: params.adminId, distributionId: params.distributionId, reason: params.reason });
  return postDistribution(db, { adminId: params.adminId, propertyId: row.property_id, totalAmount: params.totalAmount, recordDate: params.recordDate, note: params.note, replacesId: row.id });
}

