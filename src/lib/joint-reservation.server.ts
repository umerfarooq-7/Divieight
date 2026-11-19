import { accountById, accountFor, activeLinkOf, audit, nameOf, tell, type AccountRow } from "@/lib/co-buyer.server";
import {
  JOINT_MESSAGES,
  JOINT_REQUEST_HOURS,
  type CoBuyerOption,
  type IncomingJointRequest,
  type JointInfo,
} from "@/lib/joint-reservation";

/**
 * Joint reservations (server side). The initiator reserves the share as usual; the partner is asked, and on accepting becomes the
 * second holder of that same share. joint-reservations.sql holds the same limits in the database.
 */

type Db = { from: (t: string) => any };

interface RequestRow {
  id: string;
  reservation_id: string;
  property_id: string;
  initiator_account_id: string;
  partner_account_id: string;
  link_id: string | null;
  status: "pending" | "accepted" | "declined" | "cancelled" | "expired";
  created_at: string;
  expires_at: string;
}

interface JointRow {
  id: string;
  reservation_id: string;
  property_id: string;
  primary_account_id: string;
  partner_account_id: string;
  status: "active" | "ended";
}

async function property(db: Db, id: string): Promise<{ address: string; city: string; state: string }> {
  const { data } = await db.from("properties").select("address, city, state").eq("id", id).maybeSingle();
  const p = data as { address?: string; city?: string; state?: string } | null;
  return { address: p?.address ?? "this home", city: p?.city ?? "", state: p?.state ?? "" };
}

const where = (p: { address: string; city: string; state: string }) => [p.address, p.city, p.state].filter(Boolean).join(", ");

/** The other buyer on an active link, from either side. */
async function partnerOf(db: Db, account: AccountRow): Promise<{ linkId: string; partner: AccountRow } | null> {
  const link = await activeLinkOf(db, account.id);
  if (!link) return null;
  const otherId = link.inviter_account_id === account.id ? link.invitee_account_id : link.inviter_account_id;
  const partner = otherId ? await accountById(db, otherId) : null;
  return partner ? { linkId: link.id, partner } : null;
}

/** Whether this buyer already holds a share in the home, alone or as a joint holder. */
async function holdsShareIn(db: Db, accountId: string, propertyId: string): Promise<boolean> {
  const { data: own } = await db.from("pod_reservations").select("id").eq("property_id", propertyId).eq("buyer_account_id", accountId).eq("status", "reserved").limit(1);
  if (((own ?? []) as unknown[]).length > 0) return true;
  const { data: joint } = await db.from("joint_reservations").select("id").eq("property_id", propertyId).eq("partner_account_id", accountId).eq("status", "active").limit(1);
  return ((joint ?? []) as unknown[]).length > 0;
}

/** What the reserve screen offers: null with no active co-buyer, otherwise whether sharing is possible for this home right now. */
export async function coBuyerOption(db: Db, params: { accountId: string; propertyId: string }): Promise<CoBuyerOption | null> {
  const account = await accountById(db, params.accountId);
  if (!account) return null;
  const found = await partnerOf(db, account);
  if (!found) return null;
  const partnerName = await nameOf(db, found.partner);
  if (!found.partner.golden_ticket_issued) return { partnerName, available: false, unavailableReason: JOINT_MESSAGES.notReady };
  if (await holdsShareIn(db, found.partner.id, params.propertyId)) return { partnerName, available: false, unavailableReason: JOINT_MESSAGES.partnerHolds };
  return { partnerName, available: true, unavailableReason: null };
}

/** Checked before anything is reserved: the buyer who asks to share must be able to. Throws the plain-words reason. */
export async function assertCanShare(db: Db, params: { accountId: string; propertyId: string }): Promise<void> {
  const option = await coBuyerOption(db, params);
  if (!option) throw new Error(JOINT_MESSAGES.noLink);
  if (!option.available) throw new Error(option.unavailableReason ?? JOINT_MESSAGES.notReady);
}

/** Right after the share is reserved: ask the co-buyer. The share is already the initiator's, so a no or no answer loses nothing. */
export async function createJointRequest(db: Db, params: { userId: string; accountId: string; reservationId: string; propertyId: string }): Promise<{ id: string; partnerName: string }> {
  const account = await accountById(db, params.accountId);
  if (!account) throw new Error(JOINT_MESSAGES.noLink);
  const found = await partnerOf(db, account);
  if (!found) throw new Error(JOINT_MESSAGES.noLink);
  const { data, error } = await db
    .from("joint_reservation_requests")
    .insert({
      reservation_id: params.reservationId,
      property_id: params.propertyId,
      initiator_account_id: account.id,
      partner_account_id: found.partner.id,
      link_id: found.linkId,
      status: "pending",
      expires_at: new Date(Date.now() + JOINT_REQUEST_HOURS * 3_600_000).toISOString(),
    })
    .select("id")
    .maybeSingle();
  if (error || !data) throw new Error("The request to your co-buyer couldn't be saved. Run joint-reservations.sql in Supabase, then try again.");

  const [initiatorName, partnerName, prop] = await Promise.all([nameOf(db, account), nameOf(db, found.partner), property(db, params.propertyId)]);
  await tell(
    db,
    found.partner,
    `${initiatorName} wants to take a share with you`,
    `${initiatorName} reserved a 1/8th share of ${where(prop)} and would like to hold it together with you. Open your dashboard to accept or decline within ${JOINT_REQUEST_HOURS} hours. If you decline or do not answer, the share stays with ${initiatorName}.`,
    "/buyer/dashboard",
    "Open your dashboard",
  );
  await audit(db, params.userId, account.id, "buyer.joint_request_sent", { request_id: data.id, reservation_id: params.reservationId, property_id: params.propertyId, partner_account_id: found.partner.id });
  return { id: data.id as string, partnerName };
}

async function requestById(db: Db, id: string): Promise<RequestRow | null> {
  const { data } = await db.from("joint_reservation_requests").select("*").eq("id", id).maybeSingle();
  return (data as RequestRow | null) ?? null;
}

/** A pending request past its time is expired the first time anyone looks at it. */
async function expireIfStale(db: Db, row: RequestRow): Promise<RequestRow> {
  if (row.status !== "pending" || new Date(row.expires_at).getTime() > Date.now()) return row;
  await db.from("joint_reservation_requests").update({ status: "expired", responded_at: new Date().toISOString() }).eq("id", row.id).eq("status", "pending");
  const initiator = await accountById(db, row.initiator_account_id);
  const partner = await accountById(db, row.partner_account_id);
  if (initiator) {
    await tell(db, initiator, "Your co-buyer didn't answer", `${partner ? await nameOf(db, partner) : "Your co-buyer"} didn't answer in time, so the share stays yours alone. You can withdraw it or carry on.`, "/buyer/dashboard", "Open your dashboard");
  }
  return { ...row, status: "expired" };
}

/** The partner answers. Accepting makes them the second holder of the same share. */
export async function respondToJointRequest(db: Db, params: { userId: string; requestId: string; accept: boolean }): Promise<{ status: "accepted" | "declined" }> {
  const account = await accountFor(db, params.userId);
  const found = await requestById(db, params.requestId);
  if (!found) throw new Error(JOINT_MESSAGES.notFound);
  if (found.partner_account_id !== account.id) throw new Error(JOINT_MESSAGES.notYours);
  const row = await expireIfStale(db, found);
  if (row.status === "expired") throw new Error(JOINT_MESSAGES.expired);
  if (row.status !== "pending") throw new Error(JOINT_MESSAGES.notFound);

  const initiator = await accountById(db, row.initiator_account_id);
  const initiatorName = initiator ? await nameOf(db, initiator) : "Your co-buyer";
  const myName = await nameOf(db, account);
  const prop = await property(db, row.property_id);
  const now = new Date().toISOString();

  if (!params.accept) {
    await db.from("joint_reservation_requests").update({ status: "declined", responded_at: now }).eq("id", row.id).eq("status", "pending");
    await audit(db, params.userId, account.id, "buyer.joint_request_declined", { request_id: row.id, reservation_id: row.reservation_id });
    if (initiator) await tell(db, initiator, `${myName} declined`, `${myName} declined to hold the share of ${where(prop)} with you. The share is still reserved in your name alone. You can carry on, or withdraw it from your dashboard.`, "/buyer/dashboard", "Open your dashboard");
    return { status: "declined" };
  }

  // The share must still be there, and you must still be linked.
  const { data: reservation } = await db.from("pod_reservations").select("id, status").eq("id", row.reservation_id).maybeSingle();
  if ((reservation as { status?: string } | null)?.status !== "reserved") {
    await db.from("joint_reservation_requests").update({ status: "cancelled", responded_at: now }).eq("id", row.id).eq("status", "pending");
    throw new Error(JOINT_MESSAGES.gone);
  }
  const link = await activeLinkOf(db, account.id);
  const stillLinked = link && (link.inviter_account_id === row.initiator_account_id || link.invitee_account_id === row.initiator_account_id);
  if (!stillLinked) throw new Error(JOINT_MESSAGES.linkEnded);
  if (!account.golden_ticket_issued) throw new Error("Finish your own onboarding first. You need your Golden Ticket before you can hold a share.");
  if (await holdsShareIn(db, account.id, row.property_id)) throw new Error("You already hold a share in this home.");
  // Once the cap table is locked for closing, who holds what is fixed.
  const { data: genesis } = await db.from("entity_genesis").select("cap_table_locked_at").eq("property_id", row.property_id).maybeSingle();
  if ((genesis as { cap_table_locked_at?: string | null } | null)?.cap_table_locked_at) throw new Error(JOINT_MESSAGES.locked);

  const { data: joint, error } = await db
    .from("joint_reservations")
    .insert({ reservation_id: row.reservation_id, property_id: row.property_id, primary_account_id: row.initiator_account_id, partner_account_id: account.id, request_id: row.id, status: "active" })
    .select("id")
    .maybeSingle();
  if (error || !joint) throw new Error(error?.code === "23505" ? "You already hold a share in this home." : "The share couldn't be shared. Run joint-reservations.sql in Supabase, then try again.");
  await db.from("joint_reservation_requests").update({ status: "accepted", responded_at: now }).eq("id", row.id).eq("status", "pending");
  await audit(db, params.userId, account.id, "buyer.joint_request_accepted", { request_id: row.id, reservation_id: row.reservation_id, joint_reservation_id: joint.id, property_id: row.property_id });
  // The cap table now names both holders, and the new holder is told what they owe: due diligence documents first.
  try {
    const { syncCapTable } = await import("@/lib/entity-genesis.server");
    await syncCapTable(db as never, { propertyId: row.property_id, actorId: params.userId, reason: "joint_accepted" });
    const { notifyOutstandingDiligence } = await import("@/lib/due-diligence-notify.server");
    await notifyOutstandingDiligence(db as never, { propertyId: row.property_id, buyerAccountId: account.id });
  } catch {
    // the joint hold stands; the cap table is rewritten on its next sync
  }
  if (initiator) await tell(db, initiator, `${myName} accepted`, `${myName} accepted. You now hold the share of ${where(prop)} together. You each complete your own due diligence and authorizations from your own account.`, "/buyer/dashboard", "Open your dashboard");
  return { status: "accepted" };
}

/** The initiator takes the share alone after all. The reservation itself is untouched. */
export async function cancelJointRequest(db: Db, params: { userId: string; requestId: string }): Promise<void> {
  const account = await accountFor(db, params.userId);
  const row = await requestById(db, params.requestId);
  if (!row || row.initiator_account_id !== account.id || row.status !== "pending") throw new Error(JOINT_MESSAGES.notFound);
  await db.from("joint_reservation_requests").update({ status: "cancelled", responded_at: new Date().toISOString() }).eq("id", row.id).eq("status", "pending");
  await audit(db, params.userId, account.id, "buyer.joint_request_cancelled", { request_id: row.id, reservation_id: row.reservation_id });
  const partner = await accountById(db, row.partner_account_id);
  if (partner) await tell(db, partner, "Request withdrawn", `${await nameOf(db, account)} withdrew the request and is keeping the share alone.`, "/buyer/dashboard", "Open your dashboard");
}

/** Requests waiting for this buyer's answer. */
export async function incomingJointRequests(db: Db, params: { userId: string }): Promise<IncomingJointRequest[]> {
  const account = await accountFor(db, params.userId);
  const { data } = await db.from("joint_reservation_requests").select("*").eq("partner_account_id", account.id).eq("status", "pending");
  const out: IncomingJointRequest[] = [];
  for (const raw of (data ?? []) as RequestRow[]) {
    const row = await expireIfStale(db, raw);
    if (row.status !== "pending") continue;
    const initiator = await accountById(db, row.initiator_account_id);
    const prop = await property(db, row.property_id);
    out.push({ id: row.id, initiatorName: initiator ? await nameOf(db, initiator) : "Your co-buyer", propertyId: row.property_id, address: prop.address, city: prop.city, state: prop.state, createdAt: row.created_at, expiresAt: row.expires_at });
  }
  return out;
}

/** For the initiator's own reservation cards: where each joint request stands. */
export async function jointInfoForInitiator(db: Db, params: { accountId: string; reservationIds: string[] }): Promise<Map<string, JointInfo>> {
  const out = new Map<string, JointInfo>();
  if (params.reservationIds.length === 0) return out;
  const { data } = await db.from("joint_reservation_requests").select("*").eq("initiator_account_id", params.accountId).in("reservation_id", params.reservationIds);
  for (const raw of (data ?? []) as RequestRow[]) {
    const row = await expireIfStale(db, raw);
    const partner = await accountById(db, row.partner_account_id);
    const status = row.status === "accepted" ? "active" : row.status;
    out.set(row.reservation_id, { role: "initiator", partnerName: partner ? await nameOf(db, partner) : "Your co-buyer", status, requestId: row.id });
  }
  // A joint share that later ended shows as ended through its request; an active one shows as active.
  const { data: ended } = await db.from("joint_reservations").select("reservation_id, status").eq("primary_account_id", params.accountId).in("reservation_id", params.reservationIds).eq("status", "ended");
  for (const j of (ended ?? []) as Array<{ reservation_id: string }>) out.delete(j.reservation_id);
  return out;
}

/** Shares this buyer holds together with a co-buyer who started the reservation. */
export async function partnerReservations(db: Db, params: { accountId: string }): Promise<Array<{ reservationId: string; propertyId: string; sharesReserved: number; status: string; reservedAt: string; initiatorName: string }>> {
  const { data } = await db.from("joint_reservations").select("*").eq("partner_account_id", params.accountId).eq("status", "active");
  const out: Array<{ reservationId: string; propertyId: string; sharesReserved: number; status: string; reservedAt: string; initiatorName: string }> = [];
  for (const j of (data ?? []) as JointRow[]) {
    const { data: res } = await db.from("pod_reservations").select("id, shares_reserved, status, reserved_at").eq("id", j.reservation_id).maybeSingle();
    const r = res as { id: string; shares_reserved?: number; status: string; reserved_at?: string } | null;
    if (!r) continue;
    const initiator = await accountById(db, j.primary_account_id);
    out.push({ reservationId: r.id, propertyId: j.property_id, sharesReserved: r.shares_reserved ?? 1, status: r.status, reservedAt: r.reserved_at ?? "", initiatorName: initiator ? await nameOf(db, initiator) : "Your co-buyer" });
  }
  return out;
}

/** The share was withdrawn (or otherwise ended): the joint hold ends with it and the other buyer is told. */
export async function endJointForReservation(db: Db, params: { reservationId: string; actorUserId: string | null; reason: string }): Promise<void> {
  const now = new Date().toISOString();
  const { data: joint } = await db.from("joint_reservations").select("*").eq("reservation_id", params.reservationId).eq("status", "active").maybeSingle();
  const j = joint as JointRow | null;
  if (j) {
    await db.from("joint_reservations").update({ status: "ended", ended_at: now, ended_reason: params.reason }).eq("id", j.id).eq("status", "active");
    const partner = await accountById(db, j.partner_account_id);
    const prop = await property(db, j.property_id);
    if (partner) await tell(db, partner, "Your shared reservation ended", `The share of ${where(prop)} you held together was withdrawn.`, "/buyer/dashboard", "Open your dashboard");
  }
  const { data: pending } = await db.from("joint_reservation_requests").select("*").eq("reservation_id", params.reservationId).eq("status", "pending").maybeSingle();
  const p = pending as RequestRow | null;
  if (p) {
    await db.from("joint_reservation_requests").update({ status: "cancelled", responded_at: now }).eq("id", p.id).eq("status", "pending");
    const partner = await accountById(db, p.partner_account_id);
    if (partner) await tell(db, partner, "Request withdrawn", "The share was withdrawn, so the request to hold it together is closed.", "/buyer/dashboard", "Open your dashboard");
  }
  if (j || p) await db.from("audit_log").insert({ actor_id: params.actorUserId, actor_type: "buyer", action_type: "buyer.joint_reservation_ended", entity_type: "pod_reservation", entity_id: params.reservationId, metadata: { reason: params.reason, had_joint: Boolean(j), had_pending_request: Boolean(p) } });
}

/** A shared share, or a request still waiting, on either side. Keeps the co-buyer link in place until it is settled. */
export async function hasOpenJoint(db: Db, accountId: string): Promise<boolean> {
  for (const col of ["primary_account_id", "partner_account_id"]) {
    const { data } = await db.from("joint_reservations").select("id").eq(col, accountId).eq("status", "active").limit(1);
    if (((data ?? []) as unknown[]).length > 0) return true;
  }
  for (const col of ["initiator_account_id", "partner_account_id"]) {
    const { data } = await db.from("joint_reservation_requests").select("id, expires_at").eq(col, accountId).eq("status", "pending");
    if (((data ?? []) as Array<{ expires_at: string }>).some((r) => new Date(r.expires_at).getTime() > Date.now())) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------
// Joint holders, as the rest of the platform asks about them
// ---------------------------------------------------------------------------------------------------------

/** The buyer accounts that hold a share in this home together with whoever reserved it. */
export async function jointPartnerAccountIds(db: Db, propertyId: string): Promise<string[]> {
  const { data } = await db.from("joint_reservations").select("partner_account_id").eq("property_id", propertyId).eq("status", "active");
  return [...new Set(((data ?? []) as Array<{ partner_account_id: string }>).map((j) => j.partner_account_id).filter(Boolean))];
}

/** Every property where this account is the second holder of a shared share. */
export async function jointPropertyIdsOfPartner(db: Db, accountId: string): Promise<string[]> {
  const { data } = await db.from("joint_reservations").select("property_id").eq("partner_account_id", accountId).eq("status", "active");
  return [...new Set(((data ?? []) as Array<{ property_id: string }>).map((j) => j.property_id))];
}

/** The account that reserved the share this account co-holds on this property, or null if this account is not a co-holder there. */
export async function primaryAccountForPartner(db: Db, partnerAccountId: string, propertyId: string): Promise<string | null> {
  const { data } = await db.from("joint_reservations").select("primary_account_id").eq("partner_account_id", partnerAccountId).eq("property_id", propertyId).eq("status", "active").maybeSingle();
  return (data as { primary_account_id?: string } | null)?.primary_account_id ?? null;
}

/** The co-holder of the share this account reserved on this property, if any. */
export async function coHolderAccountOf(db: Db, primaryAccountId: string, propertyId: string): Promise<string | null> {
  const { data } = await db.from("joint_reservations").select("partner_account_id").eq("primary_account_id", primaryAccountId).eq("property_id", propertyId).eq("status", "active").maybeSingle();
  return (data as { partner_account_id?: string } | null)?.partner_account_id ?? null;
}

/**
 * The share-holding identity an account acts as on a property: its own, or, for a co-holder, the account that reserved the share.
 * Owner-area records (the share, the ballot, the calendar turn) belong to that one holder, so a co-holder acts through it.
 */
export async function holderAccountFor(db: Db, accountId: string, propertyId: string): Promise<{ accountId: string; asPartner: boolean }> {
  const primary = await primaryAccountForPartner(db, accountId, propertyId);
  return primary ? { accountId: primary, asPartner: true } : { accountId, asPartner: false };
}
