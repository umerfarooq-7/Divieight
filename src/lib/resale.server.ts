/**
 * Resale Shop (server side). Owner access rests only on holding a share, never
 * on a Digital Key or property status (Rev 48 floor); the only limit is that a
 * locked share can't be listed. No money moves here: the fee is a ledger line on
 * the sale and the platform never disburses. Every step goes to the audit log.
 */

import { adminRecipients, deliver } from "@/lib/authorization.notify.server";
import { hoursAsText } from "@/lib/governance-config";
import { loadGovernanceConfig } from "@/lib/governance-config.server";
import {
  openMarketExpiresAt,
  pickNextElector,
  pickRofrWinner,
  RESALE_LIVE_STATUSES,
  RESALE_STATUS_LABELS,
  resaleMoney,
  rofrCloseAt,
  ROFR_WINNER_RULE,
  type ResaleStatus,
  type ResaleTransactionStatus,
  type RofrPosition,
} from "@/lib/resale";
import { assertShareListable, shareLock } from "@/lib/retention.server";
import { isIncompatibleIntent } from "@/lib/substitution";
import { rankedHolders } from "@/lib/use-calendar.server";
import { consensusState, nameInitials, type ConsensusState, type MemberPosition } from "@/lib/votes";
import { holderFor, holderRecipients } from "@/lib/votes.server";

type Db = { from: (t: string) => any };

export interface ResaleListingRow {
  id: string;
  property_id: string;
  share_number: number;
  seller_holder_key: string;
  seller_user_id: string;
  asking_price: number;
  status: ResaleStatus;
  rofr_opens_at: string;
  rofr_closes_at: string;
  flat_fee: number;
  created_at: string;
  /** Set when the listing reaches the open market (resale-decisions.sql). */
  expires_at?: string | null;
  /** After a cancelled sale: the co-owner holding the offer, and until when (resale-decisions.sql). */
  offer_holder_key?: string | null;
  offer_closes_at?: string | null;
}

type ElectionRow = { id: string; listing_id: string; holder_key: string; user_id: string | null; elected_at: string; priority_rank_at_election: number | null; status: string };

async function audit(db: Db, actor: { id: string | null; type: string }, action: string, listing: Pick<ResaleListingRow, "id" | "property_id" | "share_number">, extra: Record<string, unknown> = {}) {
  await db.from("audit_log").insert({
    actor_id: actor.id,
    actor_type: actor.type,
    action_type: action,
    entity_type: "resale_listing",
    entity_id: listing.id,
    metadata: { property_id: listing.property_id, share_number: listing.share_number, at: new Date().toISOString(), ...extra },
  });
}

const ownerLink = (propertyId: string) => `/owner/properties/${propertyId}/resale`;
/** The read-only page for a seller who no longer holds a share on the property. */
export const formerSellerLink = (propertyId: string) => `/owner/former/${propertyId}`;

async function tell(db: Db, listing: ResaleListingRow, recipients: Array<{ authUserId: string; email: string | null }>, subject: string, message: string, dedupeKey?: string) {
  for (const r of recipients) {
    await deliver(db as never, r, { subject, message, link: ownerLink(listing.property_id), type: "resale_activity", propertyId: listing.property_id, dedupeKey });
  }
}

async function tellAdmins(db: Db, subject: string, message: string) {
  for (const admin of await adminRecipients(db as never)) {
    await deliver(db as never, admin, { subject, message, link: "/admin/resale", type: "resale" });
  }
}

async function userRecipient(db: Db, userId: string) {
  const { data } = await db.from("buyer_accounts").select("email").eq("auth_user_id", userId).maybeSingle();
  return { authUserId: userId, email: (data?.email as string | null) ?? null };
}

async function activeElections(db: Db, listingId: string): Promise<ElectionRow[]> {
  const { data } = await db.from("resale_rofr_elections").select("*").eq("listing_id", listingId).eq("status", "active");
  return (data ?? []) as ElectionRow[];
}

/** Everyone else holding shares on this property, and only this property. */
async function otherCoOwners(db: Db, listing: Pick<ResaleListingRow, "property_id" | "seller_user_id">) {
  const recipients = await holderRecipients(db, listing.property_id);
  return recipients.filter((r) => r.authUserId !== listing.seller_user_id) as Array<{ authUserId: string; email: string | null }>;
}

export interface ResaleTransactionRow {
  id: string;
  listing_id: string;
  buyer_holder_key: string;
  buyer_user_id: string;
  price: number;
  flat_fee: number;
  status: ResaleTransactionStatus;
  completed_at: string | null;
  cancel_reason: string | null;
  created_at: string;
}

async function liveTransaction(db: Db, listingId: string): Promise<ResaleTransactionRow | null> {
  const { data } = await db.from("resale_transactions").select("*").eq("listing_id", listingId).in("status", ["pending_closing", "completed"]).maybeSingle();
  return (data as ResaleTransactionRow) ?? null;
}

/**
 * Conflict resolution: the best rank wins and the sale opens. Creating the sale
 * comes first because only one can exist per listing, which makes this safe to
 * repeat and to resume if it stopped part way.
 */
async function resolveElections(db: Db, listing: ResaleListingRow): Promise<boolean> {
  const elections = await activeElections(db, listing.id);
  let sale = await liveTransaction(db, listing.id);
  if (!sale) {
    const winner = pickRofrWinner(elections);
    if (!winner?.user_id) return false;
    const { data, error } = await db
      .from("resale_transactions")
      .insert({
        listing_id: listing.id,
        buyer_holder_key: winner.holder_key,
        buyer_user_id: winner.user_id,
        price: listing.asking_price,
        flat_fee: listing.flat_fee,
        status: "pending_closing",
      })
      .select("*")
      .maybeSingle();
    sale = error?.code === "23505" ? await liveTransaction(db, listing.id) : ((data as ResaleTransactionRow) ?? null);
    if (!sale) return false; // before resale-completion.sql is run
  }

  // Marking the winner decides who sends the notifications, so they go once.
  const { data: won } = await db
    .from("resale_rofr_elections")
    .update({ status: "won" })
    .eq("listing_id", listing.id)
    .eq("holder_key", sale.buyer_holder_key)
    .eq("status", "active")
    .select("*")
    .maybeSingle();
  const { data: lost } = await db
    .from("resale_rofr_elections")
    .update({ status: "lost" })
    .eq("listing_id", listing.id)
    .eq("status", "active")
    .neq("holder_key", sale.buyer_holder_key)
    .select("*");
  if (!won) return false;

  const losers = (lost ?? []) as ElectionRow[];
  const winnerKey = `resale_winner:${listing.id}:${sale.id}`;
  await audit(db, { id: null, type: "system" }, "resale.winner_confirmed", listing, {
    transaction_id: sale.id,
    winner_holder_key: sale.buyer_holder_key,
    winner_rank: (won as ElectionRow).priority_rank_at_election,
    losers: losers.map((e) => ({ holder_key: e.holder_key, rank: e.priority_rank_at_election })),
    rule: ROFR_WINNER_RULE,
  });
  await tell(db, listing, [await userRecipient(db, sale.buyer_user_id)], "You won the right of first refusal", `You are confirmed as the buyer of share #${listing.share_number} at ${resaleMoney(listing.asking_price)}. divieight will contact you about closing.`, winnerKey);
  const loserRecipients = await Promise.all(losers.filter((e) => e.user_id).map((e) => userRecipient(db, e.user_id!)));
  await tell(db, listing, loserRecipients, "Right of first refusal: another co-owner was confirmed", `Another co-owner was confirmed as the buyer of share #${listing.share_number}. ${ROFR_WINNER_RULE}.`, winnerKey);
  await tell(db, listing, [await userRecipient(db, listing.seller_user_id)], "A co-owner is buying your share", `A co-owner is confirmed as the buyer of share #${listing.share_number} at ${resaleMoney(listing.asking_price)}. divieight will contact you about closing.`, winnerKey);
  // Same key throughout: each owner hears this once, the most specific message first.
  await tell(db, listing, await holderRecipients(db, listing.property_id) as Array<{ authUserId: string; email: string | null }>, "A co-owner was confirmed as a resale buyer", `A co-owner was confirmed as the buyer of share #${listing.share_number}.`, winnerKey);
  await tellAdmins(db, "Resale winner confirmed", `Share #${listing.share_number} has a confirmed buyer and is ready for closing.`);
  return true;
}

/**
 * Listings past their window move on: no election means the open market, any
 * election goes to conflict resolution. Safe to repeat; each moves only once.
 */
export async function settleRofr(db: Db, propertyId?: string): Promise<{ openMarket: number; exercised: number; resolved: number }> {
  let query = db.from("resale_listings").select("*").eq("status", "rofr_open").lte("rofr_closes_at", new Date().toISOString());
  if (propertyId) query = query.eq("property_id", propertyId);
  const { data, error } = await query;
  const moved = { openMarket: 0, exercised: 0, resolved: 0 };
  if (error) return moved; // before resale-shop.sql is run
  for (const found of (data ?? []) as ResaleListingRow[]) {
    const elections = await activeElections(db, found.id);
    const status: ResaleStatus = elections.length > 0 ? "rofr_exercised" : "open_market";
    const { data: updated } = await db.from("resale_listings").update({ status }).eq("id", found.id).eq("status", "rofr_open").select("*").maybeSingle();
    const listing = updated as ResaleListingRow | null;
    if (!listing) continue;
    await audit(db, { id: null, type: "system" }, "resale.rofr_closed", listing, { result: status, elections: elections.length });
    const seller = await userRecipient(db, listing.seller_user_id);
    if (status === "open_market") {
      moved.openMarket += 1;
      // When it expires is fixed now, from the setting in force today. (Best effort: the column arrives with resale-decisions.sql.)
      const days = (await loadGovernanceConfig(db)).openMarketExpiryDays;
      await db.from("resale_listings").update({ expires_at: openMarketExpiresAt(new Date(), days).toISOString() }).eq("id", listing.id);
      await tell(db, listing, [seller], "Your share is on the open market", `No co-owner exercised the right of first refusal on share #${listing.share_number}, so it is now on the open market. It stays listed for ${days} days.`);
    } else {
      moved.exercised += 1;
    }
  }

  // A co-owner offered the share after a cancelled sale who let their window run out: on to the next.
  await settleOffers(db, propertyId);

  // Everything waiting on a winner, including any that stopped part way last time.
  let waiting = db.from("resale_listings").select("*").eq("status", "rofr_exercised");
  if (propertyId) waiting = waiting.eq("property_id", propertyId);
  const { data: exercised } = await waiting;
  for (const listing of (exercised ?? []) as ResaleListingRow[]) {
    if (await resolveElections(db, listing)) moved.resolved += 1;
  }
  return moved;
}

/**
 * After a cancelled sale: offer the share to the next best-ranked co-owner who elected, with a fresh short window.
 * Returns the offer, or null when nobody remains (or resale-decisions.sql hasn't been run, in which case the
 * caller falls back to withdrawing the listing).
 */
async function offerToNextElector(db: Db, listing: ResaleListingRow): Promise<{ election: ElectionRow; closesAt: string; hours: number } | null> {
  const { data } = await db.from("resale_rofr_elections").select("*").eq("listing_id", listing.id).eq("status", "lost");
  const next = pickNextElector(((data ?? []) as ElectionRow[]).filter((e) => e.user_id), []);
  if (!next) return null;
  const hours = (await loadGovernanceConfig(db)).rofrNextOfferHours;
  const closesAt = new Date(Date.now() + hours * 3_600_000).toISOString();
  const { data: offered, error } = await db.from("resale_rofr_elections").update({ status: "offered" }).eq("id", next.id).eq("status", "lost").select("*").maybeSingle();
  if (error || !offered) return null;
  const { error: listingError } = await db.from("resale_listings").update({ offer_holder_key: next.holder_key, offer_closes_at: closesAt }).eq("id", listing.id);
  if (listingError) {
    await db.from("resale_rofr_elections").update({ status: "lost" }).eq("id", next.id);
    return null;
  }
  return { election: next, closesAt, hours };
}

/** Nobody is left to offer the share to: the listing is withdrawn and everyone involved is told. */
async function withdrawForWant(db: Db, listing: ResaleListingRow, involved: Array<{ authUserId: string; email: string | null }>, why: string) {
  const { data } = await db.from("resale_listings").update({ status: "withdrawn", offer_holder_key: null, offer_closes_at: null }).eq("id", listing.id).in("status", RESALE_LIVE_STATUSES).select("*").maybeSingle();
  const withdrawn = (data as ResaleListingRow | null) ?? null;
  if (!withdrawn) return;
  await audit(db, { id: null, type: "system" }, "resale.listing_withdrawn", withdrawn, { reason: why, no_electing_co_owner_left: true });
  await tell(db, withdrawn, involved, "A share is no longer for sale", `Share #${withdrawn.share_number} was withdrawn: ${why}`);
}

/** Everyone who took part in this listing: the seller and every co-owner who elected. */
async function involvedIn(db: Db, listing: ResaleListingRow, extraUserIds: string[] = []) {
  const { data } = await db.from("resale_rofr_elections").select("user_id").eq("listing_id", listing.id);
  const ids = new Set<string>([listing.seller_user_id, ...extraUserIds, ...((data ?? []) as Array<{ user_id: string | null }>).map((e) => e.user_id ?? "").filter(Boolean)]);
  return Promise.all([...ids].map((id) => userRecipient(db, id)));
}

/** Moves a listing whose current offer ended (declined or timed out) to the next co-owner, or withdraws it. */
async function advanceOffer(db: Db, listing: ResaleListingRow, why: "declined" | "lapsed") {
  await db.from("resale_listings").update({ offer_holder_key: null, offer_closes_at: null }).eq("id", listing.id);
  const next = await offerToNextElector(db, listing);
  if (!next) {
    await withdrawForWant(db, listing, await involvedIn(db, listing), "no co-owner who elected is left to offer it to.");
    await tellAdmins(db, "Resale listing withdrawn", `Share #${listing.share_number} was withdrawn: the offer was ${why} and no co-owner who elected is left.`);
    return;
  }
  await audit(db, { id: null, type: "system" }, "resale.offered_to_next", listing, { holder_key: next.election.holder_key, rank: next.election.priority_rank_at_election, closes_at: next.closesAt, after: why });
  await tell(db, listing, [await userRecipient(db, next.election.user_id!)], "You can buy this share", `The sale of share #${listing.share_number} fell through and you are next in line, at ${resaleMoney(listing.asking_price)}. Confirm within ${hoursAsText(next.hours)} to buy it.`, `resale_offer:${listing.id}:${next.election.id}`);
  await tell(db, listing, [await userRecipient(db, listing.seller_user_id)], "Your share was offered to the next co-owner", `The next co-owner who elected has ${hoursAsText(next.hours)} to confirm share #${listing.share_number}.`);
  await tellAdmins(db, "Resale share offered to the next co-owner", `Share #${listing.share_number} was offered to the next co-owner, who has ${hoursAsText(next.hours)} to confirm.`);
}

/** Offers whose window ran out. Safe to repeat. */
export async function settleOffers(db: Db, propertyId?: string): Promise<number> {
  let query = db.from("resale_listings").select("*").eq("status", "rofr_exercised").lte("offer_closes_at", new Date().toISOString());
  if (propertyId) query = query.eq("property_id", propertyId);
  const { data, error } = await query;
  if (error) return 0; // before resale-decisions.sql is run
  let n = 0;
  for (const listing of (data ?? []) as ResaleListingRow[]) {
    if (!listing.offer_holder_key) continue;
    const { data: closed } = await db.from("resale_rofr_elections").update({ status: "passed" }).eq("listing_id", listing.id).eq("holder_key", listing.offer_holder_key).eq("status", "offered").select("*").maybeSingle();
    if (!closed) continue;
    await audit(db, { id: null, type: "system" }, "resale.offer_lapsed", listing, { holder_key: listing.offer_holder_key });
    await tell(db, listing, [await userRecipient(db, (closed as ElectionRow).user_id!)], "Your offer on a share ended", `The time to confirm share #${listing.share_number} ran out.`);
    await advanceOffer(db, listing, "lapsed");
    n += 1;
  }
  return n;
}

/** Open-market listings past their expiry. The seller is told and can list the share again. */
export async function expireOpenMarketListings(db: Db): Promise<number> {
  const { data, error } = await db.from("resale_listings").select("*").eq("status", "open_market");
  if (error) return 0;
  const days = (await loadGovernanceConfig(db)).openMarketExpiryDays;
  let n = 0;
  for (const found of (data ?? []) as ResaleListingRow[]) {
    // A listing from before expiry was recorded counts from when its right of first refusal ended.
    const expiresAt = found.expires_at ? new Date(found.expires_at) : openMarketExpiresAt(new Date(found.rofr_closes_at), days);
    if (expiresAt.getTime() > Date.now()) continue;
    const { data: updated } = await db.from("resale_listings").update({ status: "expired" }).eq("id", found.id).eq("status", "open_market").select("*").maybeSingle();
    const listing = updated as ResaleListingRow | null;
    if (!listing) continue;
    // A buyer who had a sale started from their interest keeps it: only a listing with no live sale expires.
    if (await liveTransaction(db, listing.id)) {
      await db.from("resale_listings").update({ status: "open_market" }).eq("id", listing.id);
      continue;
    }
    await audit(db, { id: null, type: "system" }, "resale.listing_expired", listing, { expired_at: expiresAt.toISOString(), open_market_days: days });
    await tell(db, listing, [await userRecipient(db, listing.seller_user_id)], "Your listing expired", `Share #${listing.share_number} was on the open market for ${days} days and has expired. You can list it again from your Resale Shop.`);
    await tellAdmins(db, "Resale listing expired", `The open-market listing of share #${listing.share_number} expired after ${days} days.`);
    n += 1;
  }
  return n;
}

async function members(db: Db, holder: { type: string; buyerAccountId: string | null; holderKey: string }, listingId: string): Promise<MemberPosition[]> {
  if (holder.type !== "buyer" || !holder.buyerAccountId) return [];
  const { data: rows } = await db.from("account_members").select("id, full_name").eq("buyer_account_id", holder.buyerAccountId).eq("status", "active");
  const { data: positions } = await db.from("resale_rofr_member_positions").select("account_member_id, position").eq("listing_id", listingId).eq("holder_key", holder.holderKey);
  const byMember = new Map(((positions ?? []) as Array<{ account_member_id: string; position: string }>).map((p) => [p.account_member_id, p.position]));
  return ((rows ?? []) as Array<{ id: string; full_name: string | null }>).map((m) => ({
    memberId: m.id,
    name: m.full_name || "Account Member",
    position: byMember.get(m.id) ?? null,
  }));
}

const rofrProblem = (listing: ResaleListingRow, now = Date.now()): string | null =>
  listing.status !== "rofr_open" || now >= new Date(listing.rofr_closes_at).getTime() ? "The right of first refusal isn't open on this share." : null;

export interface OwnerResaleShare {
  shareNumber: number;
  locked: boolean;
  lockExpiresAt: string | null;
  listed: boolean;
}

export interface OwnerResaleListing {
  id: string;
  shareNumber: number;
  askingPrice: number;
  flatFee: number;
  status: ResaleStatus;
  statusLabel: string;
  rofrClosesAt: string;
  electionCount: number;
  canWithdraw: boolean;
  saleStatus: ResaleTransactionStatus | null;
  /** When an open-market listing expires, and the notice about what stays with the seller. */
  expiresAt: string | null;
  /** The next co-owner has been offered the share after a cancelled sale, until this time. */
  offerClosesAt: string | null;
}

export interface CoOwnerResaleListing {
  id: string;
  shareNumber: number;
  askingPrice: number;
  status: ResaleStatus;
  rofrClosesAt: string;
  saleStatus: ResaleTransactionStatus | null;
  myElection: "active" | "won" | "lost" | "withdrawn" | "offered" | "passed" | null;
  canElect: boolean;
  /** This share was offered to this co-owner after a cancelled sale: they can confirm until this time. */
  offer: { closesAt: string } | null;
  consensus: { state: ConsensusState; choice: string | null; members: MemberPosition[] };
}

/** /owner/properties/:id/resale. Never gated on anything but holding a share. */
export async function ownerResale(db: Db, userId: string, propertyId: string): Promise<{ allowed: boolean; rofrHours?: number; shares: OwnerResaleShare[]; mine: OwnerResaleListing[]; coOwners: CoOwnerResaleListing[] }> {
  const holder = await holderFor(db, userId, propertyId);
  if (!holder) return { allowed: false, shares: [], mine: [], coOwners: [] };
  const rofrHours = (await loadGovernanceConfig(db)).rofrWindowHours;
  await settleRofr(db, propertyId);
  await expireOpenMarketListings(db);
  const { data } = await db.from("resale_listings").select("*").eq("property_id", propertyId).order("created_at", { ascending: false });
  const listings = (data ?? []) as ResaleListingRow[];

  const shares: OwnerResaleShare[] = [];
  for (const shareNumber of holder.shareNumbers) {
    const lock = await shareLock(db, propertyId, shareNumber);
    shares.push({
      shareNumber,
      locked: lock.issued ? lock.locked : true,
      lockExpiresAt: lock.issued ? lock.expiresAt : null,
      listed: listings.some((l) => l.share_number === shareNumber && RESALE_LIVE_STATUSES.includes(l.status)),
    });
  }

  const mine: OwnerResaleListing[] = [];
  const coOwners: CoOwnerResaleListing[] = [];
  for (const l of listings) {
    const saleStatus = (await liveTransaction(db, l.id))?.status ?? null;
    if (l.seller_holder_key === holder.holderKey) {
      const { data: all } = await db.from("resale_rofr_elections").select("status").eq("listing_id", l.id);
      const elections = (all ?? []) as Array<{ status: string }>;
      mine.push({
        id: l.id,
        shareNumber: l.share_number,
        askingPrice: Number(l.asking_price),
        flatFee: Number(l.flat_fee),
        status: l.status,
        statusLabel: RESALE_STATUS_LABELS[l.status],
        rofrClosesAt: l.rofr_closes_at,
        electionCount: elections.filter((e) => e.status === "active").length,
        canWithdraw: RESALE_LIVE_STATUSES.includes(l.status) && !elections.some((e) => e.status === "won") && !saleStatus,
        saleStatus,
        expiresAt: l.status === "open_market" ? (l.expires_at ?? null) : null,
        offerClosesAt: l.offer_holder_key ? (l.offer_closes_at ?? null) : null,
      });
      continue;
    }
    const { data: election } = await db.from("resale_rofr_elections").select("status").eq("listing_id", l.id).eq("holder_key", holder.holderKey).maybeSingle();
    const myElection = (election?.status as CoOwnerResaleListing["myElection"]) ?? null;
    // Closed-out listings stay out of a co-owner's view unless they took part.
    if (l.status !== "rofr_open" && !myElection) continue;
    const memberRows = await members(db, holder, l.id);
    coOwners.push({
      id: l.id,
      shareNumber: l.share_number,
      askingPrice: Number(l.asking_price),
      status: l.status,
      rofrClosesAt: l.rofr_closes_at,
      saleStatus: myElection === "won" ? saleStatus : null,
      myElection,
      canElect: !rofrProblem(l) && myElection !== "active" && myElection !== "offered",
      offer: myElection === "offered" && l.offer_holder_key === holder.holderKey && l.offer_closes_at ? { closesAt: l.offer_closes_at } : null,
      consensus: { ...consensusState(memberRows), members: memberRows },
    });
  }
  return { allowed: true, rofrHours, shares, mine, coOwners };
}

export async function createListing(
  db: Db,
  params: { userId: string; propertyId: string; shareNumber: number; askingPrice: number; feeAcknowledged: boolean },
): Promise<{ error?: string; id?: string; rofrClosesAt?: string }> {
  const holder = await holderFor(db, params.userId, params.propertyId);
  if (!holder) return { error: "You don't have ownership in that property." };
  if (!params.feeAcknowledged) return { error: "Please confirm the technology-service fee first." };
  if (!Number.isFinite(params.askingPrice) || params.askingPrice <= 0) return { error: "Set an asking price." };
  try {
    await assertShareListable(db, { userId: params.userId, propertyId: params.propertyId, shareNumber: params.shareNumber });
  } catch (e) {
    return { error: (e as Error).message };
  }

  const liveMessage = "This share is already listed.";
  const { data: live } = await db
    .from("resale_listings")
    .select("id")
    .eq("property_id", params.propertyId)
    .eq("share_number", params.shareNumber)
    .in("status", RESALE_LIVE_STATUSES);
  if ((live ?? []).length > 0) return { error: liveMessage };

  const rofrHours = (await loadGovernanceConfig(db)).rofrWindowHours;
  const opensAt = new Date();
  const closesAt = rofrCloseAt(opensAt, rofrHours);
  const { data, error } = await db
    .from("resale_listings")
    .insert({
      property_id: params.propertyId,
      share_number: params.shareNumber,
      seller_holder_key: holder.holderKey,
      seller_user_id: params.userId,
      asking_price: params.askingPrice,
      status: "rofr_open",
      rofr_opens_at: opensAt.toISOString(),
      rofr_closes_at: closesAt.toISOString(),
    })
    .select("*")
    .maybeSingle();
  if (error?.code === "23505") return { error: liveMessage };
  if (/retention lock/i.test(error?.message ?? "")) return { error: error.message as string };
  if (error || !data) return { error: "Listing isn't available yet. Please try again later." };
  const listing = data as ResaleListingRow;

  await audit(db, { id: params.userId, type: holder.type }, "resale.listing_created", listing, {
    asking_price: params.askingPrice,
    flat_fee: listing.flat_fee,
    fee_disclosed: true,
    rofr_closes_at: listing.rofr_closes_at,
  });
  await tell(
    db,
    listing,
    await otherCoOwners(db, listing),
    "A co-owner's share is for sale",
    `Share #${listing.share_number} is offered at ${resaleMoney(listing.asking_price)}. As a co-owner you have ${hoursAsText(rofrHours)} to exercise your right of first refusal.`,
    `resale_listed:${listing.id}`,
  );
  return { id: listing.id, rofrClosesAt: listing.rofr_closes_at };
}

async function loadForHolder(db: Db, userId: string, propertyId: string, listingId: string) {
  const holder = await holderFor(db, userId, propertyId);
  const { data } = await db.from("resale_listings").select("*").eq("id", listingId).maybeSingle();
  const listing = data as ResaleListingRow | null;
  // Same answer for a listing on another property as for one that doesn't exist.
  if (!holder || !listing || listing.property_id !== propertyId) return null;
  return { holder, listing };
}

/** A member of a multi-member account records where they stand. */
export async function recordRofrPosition(
  db: Db,
  params: { userId: string; propertyId: string; listingId: string; accountMemberId: string; position: RofrPosition; initials: string },
): Promise<{ error?: string }> {
  const found = await loadForHolder(db, params.userId, params.propertyId, params.listingId);
  if (!found || found.listing.seller_holder_key === found.holder.holderKey) return { error: "This listing isn't available." };
  const problem = rofrProblem(found.listing);
  if (problem) return { error: problem };
  const member = (await members(db, found.holder, found.listing.id)).find((m) => m.memberId === params.accountMemberId);
  if (!member) return { error: "That member isn't on your account." };
  if (nameInitials(member.name) !== params.initials.replace(/\s+/g, "").toUpperCase())
    return { error: `Type ${member.name}'s initials to record their position.` };

  const { data: existing } = await db.from("resale_rofr_member_positions").select("id").eq("listing_id", found.listing.id).eq("account_member_id", member.memberId).maybeSingle();
  const now = new Date().toISOString();
  const { error } = existing
    ? await db.from("resale_rofr_member_positions").update({ position: params.position, user_id: params.userId, updated_at: now }).eq("id", existing.id)
    : await db.from("resale_rofr_member_positions").insert({
        listing_id: found.listing.id,
        holder_key: found.holder.holderKey,
        account_member_id: member.memberId,
        user_id: params.userId,
        position: params.position,
        updated_at: now,
      });
  if (error) return { error: /not open/i.test(error.message) ? "The right of first refusal isn't open on this share." : error.message };
  await audit(db, { id: params.userId, type: "buyer" }, "resale.member_position_recorded", found.listing, {
    holder_key: found.holder.holderKey,
    account_member_id: member.memberId,
    position: params.position,
    secondary_verification_method: "typed_initials",
  });
  return {};
}

export async function exerciseRofr(db: Db, params: { userId: string; propertyId: string; listingId: string }): Promise<{ error?: string }> {
  const found = await loadForHolder(db, params.userId, params.propertyId, params.listingId);
  if (!found) return { error: "This listing isn't available." };
  const { holder, listing } = found;
  if (listing.seller_holder_key === holder.holderKey) return { error: "You can't exercise on your own listing." };
  const problem = rofrProblem(listing);
  if (problem) return { error: problem };

  const memberRows = await members(db, holder, listing.id);
  const consensus = consensusState(memberRows);
  if (consensus.state === "disagree") return { error: "Your account members disagree — reach consensus to exercise." };
  if (consensus.state === "pending") return { error: `Waiting for ${memberRows.filter((m) => !m.position).map((m) => m.name).join(", ")} to record a position.` };
  if (consensus.state === "agreed" && consensus.choice !== "exercise") return { error: "Your account agreed to decline this share." };

  const { data: existing } = await db.from("resale_rofr_elections").select("id, status").eq("listing_id", listing.id).eq("holder_key", holder.holderKey).maybeSingle();
  if (existing?.status === "active") return { error: "You've already exercised on this share." };
  const rank = (await rankedHolders(db as never, listing.property_id)).find((h) => h.holderKey === holder.holderKey)?.rank ?? null;
  const row = { user_id: params.userId, elected_at: new Date().toISOString(), priority_rank_at_election: rank, status: "active" };
  const { error } = existing
    ? await db.from("resale_rofr_elections").update(row).eq("id", existing.id)
    : await db.from("resale_rofr_elections").insert({ listing_id: listing.id, holder_key: holder.holderKey, ...row });
  if (error) return { error: /not open/i.test(error.message) ? "The right of first refusal isn't open on this share." : "You've already exercised on this share." };

  await audit(db, { id: params.userId, type: holder.type }, "resale.rofr_exercised", listing, { holder_key: holder.holderKey, priority_rank_at_election: rank, asking_price: listing.asking_price });
  await tell(db, listing, [await userRecipient(db, params.userId)], "Right of first refusal exercised", `You exercised on share #${listing.share_number} at ${resaleMoney(listing.asking_price)}. The outcome is confirmed after the window closes.`);
  await tell(db, listing, [await userRecipient(db, listing.seller_user_id)], "A co-owner exercised on your share", `A co-owner exercised the right of first refusal on share #${listing.share_number}.`);
  await tellAdmins(db, "Right of first refusal exercised", `A co-owner exercised on share #${listing.share_number}.`);
  return {};
}

export async function withdrawElection(db: Db, params: { userId: string; propertyId: string; listingId: string }): Promise<{ error?: string }> {
  const found = await loadForHolder(db, params.userId, params.propertyId, params.listingId);
  if (!found) return { error: "This listing isn't available." };
  const problem = rofrProblem(found.listing);
  if (problem) return { error: problem };
  const { data } = await db
    .from("resale_rofr_elections")
    .update({ status: "withdrawn" })
    .eq("listing_id", found.listing.id)
    .eq("holder_key", found.holder.holderKey)
    .eq("status", "active")
    .select("id")
    .maybeSingle();
  if (!data) return { error: "You don't have an election on this share." };
  await audit(db, { id: params.userId, type: found.holder.type }, "resale.election_withdrawn", found.listing, { holder_key: found.holder.holderKey });
  return {};
}

/** Allowed until a ROFR winner is confirmed. */
export async function withdrawListing(db: Db, params: { userId: string; propertyId: string; listingId: string }): Promise<{ error?: string }> {
  const found = await loadForHolder(db, params.userId, params.propertyId, params.listingId);
  if (!found || found.listing.seller_holder_key !== found.holder.holderKey) return { error: "This listing isn't available." };
  const { data: won } = await db.from("resale_rofr_elections").select("id").eq("listing_id", found.listing.id).eq("status", "won");
  if ((won ?? []).length > 0 || (await liveTransaction(db, found.listing.id))) return { error: "A buyer has been confirmed, so this listing can't be withdrawn." };
  const { data } = await db.from("resale_listings").update({ status: "withdrawn" }).eq("id", found.listing.id).in("status", RESALE_LIVE_STATUSES).select("*").maybeSingle();
  const listing = data as ResaleListingRow | null;
  if (!listing) return { error: "This listing can't be withdrawn any more." };

  const elections = await activeElections(db, listing.id);
  await db.from("resale_rofr_elections").update({ status: "lost" }).eq("listing_id", listing.id).in("status", ["active", "offered"]);
  await db.from("resale_listings").update({ offer_holder_key: null, offer_closes_at: null }).eq("id", listing.id);
  await audit(db, { id: params.userId, type: found.holder.type }, "resale.listing_withdrawn", listing, { elections_closed: elections.length, previous_status: found.listing.status });
  await tell(db, listing, await otherCoOwners(db, listing), "A share is no longer for sale", `Share #${listing.share_number} was withdrawn from sale.`);
  await tellAdmins(db, "Resale listing withdrawn", `Share #${listing.share_number} was withdrawn from sale.`);
  return {};
}

// ---------------------------------------------------------------------------
// Open market
// ---------------------------------------------------------------------------

export interface OpenMarketListing {
  id: string;
  propertyId: string;
  label: string;
  photo: string | null;
  usageTag: string | null;
  shareNumber: number;
  askingPrice: number;
  incompatible: boolean;
  interested: boolean;
}

async function onboardedBuyer(db: Db, userId: string) {
  const { data } = await db.from("buyer_accounts").select("id, email, intent, onboarding_status").eq("auth_user_id", userId).maybeSingle();
  return data?.onboarding_status === "active" ? (data as { id: string; email: string | null; intent: string | null }) : null;
}

/** /resale: open-market shares for onboarded buyers. Nothing about the seller is returned. */
export async function openMarketListings(db: Db, userId: string): Promise<{ allowed: boolean; listings: OpenMarketListing[] }> {
  const buyer = await onboardedBuyer(db, userId);
  if (!buyer) return { allowed: false, listings: [] };
  await settleRofr(db);
  await expireOpenMarketListings(db);
  const { data, error } = await db.from("resale_listings").select("*").eq("status", "open_market").order("created_at", { ascending: false });
  if (error) return { allowed: true, listings: [] };
  const { data: interest } = await db.from("resale_interest_requests").select("listing_id").eq("buyer_account_id", buyer.id);
  const interested = new Set(((interest ?? []) as Array<{ listing_id: string }>).map((i) => i.listing_id));
  const { propertyCard } = await import("@/lib/owner.functions");
  const out: OpenMarketListing[] = [];
  for (const l of ((data ?? []) as ResaleListingRow[]).filter((row) => row.seller_user_id !== userId)) {
    const { data: p } = await db.from("properties").select("usage_tag").eq("id", l.property_id).maybeSingle();
    const { label, photo } = await propertyCard(db, l.property_id);
    const usageTag = (p?.usage_tag as string | null) ?? null;
    out.push({
      id: l.id,
      propertyId: l.property_id,
      label,
      photo,
      usageTag,
      shareNumber: l.share_number,
      askingPrice: Number(l.asking_price),
      incompatible: isIncompatibleIntent(buyer.intent, usageTag),
      interested: interested.has(l.id),
    });
  }
  return { allowed: true, listings: out };
}

export async function expressInterest(db: Db, params: { userId: string; listingId: string }): Promise<{ error?: string }> {
  const buyer = await onboardedBuyer(db, params.userId);
  if (!buyer) return { error: "Finish buyer onboarding to express interest." };
  await settleRofr(db);
  const { data } = await db.from("resale_listings").select("*").eq("id", params.listingId).maybeSingle();
  const listing = data as ResaleListingRow | null;
  if (!listing || listing.status !== "open_market" || listing.seller_user_id === params.userId) return { error: "This listing isn't available." };
  const { error } = await db.from("resale_interest_requests").insert({ listing_id: listing.id, buyer_account_id: buyer.id, user_id: params.userId });
  if (error?.code === "23505") return { error: "You've already expressed interest in this share." };
  if (error) return { error: "This isn't available yet. Please try again later." };
  await audit(db, { id: params.userId, type: "buyer" }, "resale.interest_expressed", listing, { buyer_account_id: buyer.id });
  await tellAdmins(db, "Interest in a resale share", `An onboarded buyer expressed interest in share #${listing.share_number}. Follow up with them directly.`);
  await deliver(db as never, { authUserId: params.userId, email: buyer.email }, {
    subject: "We've received your interest",
    message: `We've told divieight you're interested in share #${listing.share_number}. They will contact you about next steps.`,
    link: "/resale",
    type: "resale",
  });
  return {};
}

// ---------------------------------------------------------------------------
// Admin (divieight as Manager)
// ---------------------------------------------------------------------------

export interface AdminResaleSale {
  id: string;
  buyerHolderKey: string;
  buyerEmail: string | null;
  price: number;
  flatFee: number;
  status: ResaleTransactionStatus;
  completedAt: string | null;
  cancelReason: string | null;
  createdAt: string;
}

export interface AdminResaleListing {
  id: string;
  propertyId: string;
  propertyLabel: string;
  shareNumber: number;
  seller: string;
  askingPrice: number;
  flatFee: number;
  status: ResaleStatus;
  statusLabel: string;
  rofrClosesAt: string;
  elections: Array<{ holderKey: string; rank: number | null; status: string; electedAt: string }>;
  interested: Array<{ buyerAccountId: string; email: string | null; at: string; goldenTicket: boolean }>;
  /** When an open-market listing expires. */
  expiresAt: string | null;
  /** After a cancelled sale: which co-owner holds the offer, and until when. */
  offer: { holderKey: string; closesAt: string } | null;
  sales: AdminResaleSale[];
  /** Section 754 review flags for the CPA. No basis figures exist on the platform. */
  cpaFlags: Array<{ flagType: string; note: string | null; createdAt: string }>;
  createdAt: string;
}

export async function adminResale(db: Db): Promise<{ rows: AdminResaleListing[] }> {
  await settleRofr(db);
  await expireOpenMarketListings(db);
  const { data, error } = await db.from("resale_listings").select("*").order("created_at", { ascending: false });
  if (error) throw new Error("Database is missing resale_listings — run resale-shop.sql in Supabase.");
  const rows: AdminResaleListing[] = [];
  for (const l of (data ?? []) as ResaleListingRow[]) {
    const { data: p } = await db.from("properties").select("address, city, state").eq("id", l.property_id).maybeSingle();
    const { data: buyer } = await db.from("buyer_accounts").select("email").eq("auth_user_id", l.seller_user_id).maybeSingle();
    const { data: elections } = await db.from("resale_rofr_elections").select("*").eq("listing_id", l.id).order("elected_at", { ascending: true });
    const { data: interest } = await db.from("resale_interest_requests").select("buyer_account_id, created_at").eq("listing_id", l.id);
    const interested: AdminResaleListing["interested"] = [];
    for (const i of (interest ?? []) as Array<{ buyer_account_id: string; created_at: string }>) {
      const { data: b } = await db.from("buyer_accounts").select("email, golden_ticket_issued").eq("id", i.buyer_account_id).maybeSingle();
      interested.push({ buyerAccountId: i.buyer_account_id, email: (b?.email as string | null) ?? null, at: i.created_at, goldenTicket: b?.golden_ticket_issued === true });
    }
    const { data: saleRows } = await db.from("resale_transactions").select("*").eq("listing_id", l.id).order("created_at", { ascending: false });
    const sales: AdminResaleSale[] = [];
    const cpaFlags: AdminResaleListing["cpaFlags"] = [];
    for (const s of (saleRows ?? []) as ResaleTransactionRow[]) {
      const { data: b } = await db.from("buyer_accounts").select("email").eq("auth_user_id", s.buyer_user_id).maybeSingle();
      sales.push({
        id: s.id,
        buyerHolderKey: s.buyer_holder_key,
        buyerEmail: (b?.email as string | null) ?? null,
        price: Number(s.price),
        flatFee: Number(s.flat_fee),
        status: s.status,
        completedAt: s.completed_at,
        cancelReason: s.cancel_reason,
        createdAt: s.created_at,
      });
      const { data: flags } = await db.from("cpa_worksheet_flags").select("flag_type, note, created_at").eq("resale_transaction_id", s.id);
      for (const f of (flags ?? []) as Array<{ flag_type: string; note: string | null; created_at: string }>)
        cpaFlags.push({ flagType: f.flag_type, note: f.note, createdAt: f.created_at });
    }
    rows.push({
      id: l.id,
      propertyId: l.property_id,
      propertyLabel: p ? [p.address, p.city, p.state].filter(Boolean).join(", ") : "Property",
      shareNumber: l.share_number,
      seller: (buyer?.email as string | undefined) ?? "Retained seller",
      askingPrice: Number(l.asking_price),
      flatFee: Number(l.flat_fee),
      status: l.status,
      statusLabel: RESALE_STATUS_LABELS[l.status],
      rofrClosesAt: l.rofr_closes_at,
      elections: ((elections ?? []) as ElectionRow[]).map((e) => ({ holderKey: e.holder_key, rank: e.priority_rank_at_election, status: e.status, electedAt: e.elected_at })),
      interested,
      expiresAt: l.status === "open_market" ? (l.expires_at ?? null) : null,
      offer: l.offer_holder_key && l.offer_closes_at ? { holderKey: l.offer_holder_key, closesAt: l.offer_closes_at } : null,
      sales,
      cpaFlags,
      createdAt: l.created_at,
    });
  }
  return { rows };
}

/**
 * Mark a sale complete (title and escrow are simulated; no money moves). The
 * database completes it and syncs the cap table in one transaction, so a sale
 * that can't sync stays pending. Calling again changes nothing.
 */
export async function completeSale(db: Db, adminId: string, transactionId: string): Promise<{ applied: boolean }> {
  const { data: found } = await db.from("resale_transactions").select("*").eq("id", transactionId).maybeSingle();
  if (!found) throw new Error("Sale not found");
  const sale = found as ResaleTransactionRow;
  const { data: result, error } = await (db as any).rpc("complete_resale_transaction", { _transaction: transactionId, _actor: adminId });
  if (error) throw new Error(/complete_resale_transaction/.test(error.message) ? "Database is missing the Final Sync — run resale-completion.sql in Supabase." : error.message);
  if (!result?.applied) return { applied: false };

  const { data: l } = await db.from("resale_listings").select("*").eq("id", sale.listing_id).maybeSingle();
  const listing = l as ResaleListingRow;
  await audit(db, { id: adminId, type: "admin" }, "resale.sale_completed", listing, { transaction_id: sale.id, price: sale.price, flat_fee: sale.flat_fee, buyer_holder_key: sale.buyer_holder_key });
  const buyer = await userRecipient(db, sale.buyer_user_id);
  await tell(db, listing, [buyer], "Your share purchase is complete", `You now hold share #${listing.share_number}. A new 12-month Retention Lock applies to it.`);

  // Already-picked weeks stay with the seller until the year ends unless the admin moves them.
  const { data: weeks } = await db
    .from("use_calendar_weeks")
    .select("start_date")
    .eq("property_id", listing.property_id)
    .eq("holder_key", listing.seller_holder_key)
    .gte("end_date", new Date().toISOString().slice(0, 10))
    .order("start_date", { ascending: true });
  const stays = ((weeks ?? []) as Array<{ start_date: string }>).map((w) => w.start_date);
  const sellerMessage = `The sale of share #${listing.share_number} is complete.${stays.length ? ` You keep the ${stays.length} Use Calendar week${stays.length === 1 ? "" : "s"} you already picked, starting ${stays.join(", ")}.` : ""}`;
  // A seller who sold every share can't open the owner area; their notice links to the read-only page for their weeks.
  const stillHolds = await holderFor(db, listing.seller_user_id, listing.property_id);
  if (stillHolds) {
    await tell(db, listing, [await userRecipient(db, listing.seller_user_id)], "Your share sale is complete", sellerMessage);
  } else {
    await deliver(db as never, await userRecipient(db, listing.seller_user_id), {
      subject: "Your share sale is complete",
      message: sellerMessage,
      link: formerSellerLink(listing.property_id),
      type: "former_seller_weeks",
      propertyId: listing.property_id,
    });
  }
  return { applied: true };
}

/** Cancel with a reason. The cap table isn't touched, and the seller may list the share again. */
export async function cancelSale(db: Db, params: { adminId: string; transactionId: string; reason: string }): Promise<void> {
  const { data } = await db
    .from("resale_transactions")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString(), cancelled_by: params.adminId, cancel_reason: params.reason })
    .eq("id", params.transactionId)
    .eq("status", "pending_closing")
    .select("*")
    .maybeSingle();
  const sale = data as ResaleTransactionRow | null;
  if (!sale) throw new Error("Only a sale waiting to close can be cancelled.");
  // The cancelled buyer has had their turn: marked 'passed' so they are never offered the share again. (Before
  // resale-decisions.sql the status isn't allowed, and it is closed out as 'lost' like before.)
  const { error: passError } = await db.from("resale_rofr_elections").update({ status: "passed" }).eq("listing_id", sale.listing_id).eq("status", "won");
  if (passError) await db.from("resale_rofr_elections").update({ status: "lost" }).eq("listing_id", sale.listing_id).eq("status", "won");
  const { data: current } = await db.from("resale_listings").select("*").eq("id", sale.listing_id).maybeSingle();
  const found = current as ResaleListingRow | null;
  if (!found || !RESALE_LIVE_STATUSES.includes(found.status)) return;

  // The next best-ranked co-owner who elected, with a fresh short window.
  const next = passError ? null : await offerToNextElector(db, found);
  if (next) {
    await audit(db, { id: params.adminId, type: "admin" }, "resale.sale_cancelled", found, { transaction_id: sale.id, reason: params.reason, buyer_holder_key: sale.buyer_holder_key, offered_to: next.election.holder_key, offer_closes_at: next.closesAt });
    const window = hoursAsText(next.hours);
    await tell(db, found, [await userRecipient(db, next.election.user_id!)], "You can buy this share", `The sale of share #${found.share_number} was cancelled and you are next in line, at ${resaleMoney(found.asking_price)}. Confirm within ${window} to buy it.`, `resale_offer:${found.id}:${next.election.id}`);
    await tell(db, found, [await userRecipient(db, sale.buyer_user_id)], "A share sale was cancelled", `The sale of share #${found.share_number} was cancelled. Reason: ${params.reason}`);
    await tell(db, found, [await userRecipient(db, found.seller_user_id)], "Your share was offered to the next co-owner", `The sale of share #${found.share_number} was cancelled. The next co-owner who elected has ${window} to confirm. Reason: ${params.reason}`);
    const others = await involvedIn(db, found);
    await tell(db, found, others.filter((r) => r.authUserId !== next.election.user_id && r.authUserId !== sale.buyer_user_id && r.authUserId !== found.seller_user_id), "A resale offer moved on", `The sale of share #${found.share_number} fell through. The next co-owner in line was offered it.`);
    return;
  }

  // Nobody who elected is left: the listing is withdrawn, as it always was.
  const { data: l } = await db.from("resale_listings").update({ status: "withdrawn", offer_holder_key: null, offer_closes_at: null }).eq("id", sale.listing_id).in("status", RESALE_LIVE_STATUSES).select("*").maybeSingle();
  const listing = l as ResaleListingRow | null;
  if (!listing) return;
  await audit(db, { id: params.adminId, type: "admin" }, "resale.sale_cancelled", listing, { transaction_id: sale.id, reason: params.reason, buyer_holder_key: sale.buyer_holder_key, no_electing_co_owner_left: true });
  const message = `The sale of share #${listing.share_number} was cancelled and no co-owner who elected is left to offer it to, so it is withdrawn. Reason: ${params.reason}`;
  await tell(db, listing, await involvedIn(db, listing, [sale.buyer_user_id]), "A share sale was cancelled", message);
}

/** The offered co-owner confirms: their election is live again and the sale opens for them. */
export async function confirmOffer(db: Db, params: { userId: string; propertyId: string; listingId: string }): Promise<{ error?: string }> {
  const found = await loadForHolder(db, params.userId, params.propertyId, params.listingId);
  if (!found) return { error: "This listing isn't available." };
  const { holder, listing } = found;
  if (listing.offer_holder_key !== holder.holderKey || !listing.offer_closes_at) return { error: "This share isn't offered to you." };
  if (Date.now() >= new Date(listing.offer_closes_at).getTime()) return { error: "Your time to confirm this share has run out." };
  const { data: election, error } = await db
    .from("resale_rofr_elections")
    .update({ status: "active", elected_at: new Date().toISOString() })
    .eq("listing_id", listing.id)
    .eq("holder_key", holder.holderKey)
    .eq("status", "offered")
    .select("*")
    .maybeSingle();
  if (error || !election) return { error: "This share isn't offered to you." };
  await db.from("resale_listings").update({ offer_holder_key: null, offer_closes_at: null }).eq("id", listing.id);
  await audit(db, { id: params.userId, type: holder.type }, "resale.offer_confirmed", listing, { holder_key: holder.holderKey, asking_price: listing.asking_price });
  const { data: fresh } = await db.from("resale_listings").select("*").eq("id", listing.id).maybeSingle();
  await resolveElections(db, (fresh as ResaleListingRow) ?? listing);
  return {};
}

export async function declineOffer(db: Db, params: { userId: string; propertyId: string; listingId: string }): Promise<{ error?: string }> {
  const found = await loadForHolder(db, params.userId, params.propertyId, params.listingId);
  if (!found) return { error: "This listing isn't available." };
  const { holder, listing } = found;
  if (listing.offer_holder_key !== holder.holderKey) return { error: "This share isn't offered to you." };
  const { data } = await db.from("resale_rofr_elections").update({ status: "passed" }).eq("listing_id", listing.id).eq("holder_key", holder.holderKey).eq("status", "offered").select("id").maybeSingle();
  if (!data) return { error: "This share isn't offered to you." };
  await audit(db, { id: params.userId, type: holder.type }, "resale.offer_declined", listing, { holder_key: holder.holderKey });
  await advanceOffer(db, listing, "declined");
  return {};
}

/**
 * Turns an expressed interest on an open-market listing into a sale. Only for a buyer who already holds a Golden Ticket:
 * anyone else has to finish the normal onboarding first. The sale is the same pending-closing record a right of first
 * refusal creates; no money moves.
 */
export async function convertInterestToSale(db: Db, params: { adminId: string; listingId: string; buyerAccountId: string }): Promise<{ transactionId: string }> {
  const { data: l } = await db.from("resale_listings").select("*").eq("id", params.listingId).maybeSingle();
  const listing = l as ResaleListingRow | null;
  if (!listing || listing.status !== "open_market") throw new Error("Only a listing on the open market can be sold this way.");
  const { data: interest } = await db.from("resale_interest_requests").select("id").eq("listing_id", listing.id).eq("buyer_account_id", params.buyerAccountId).maybeSingle();
  if (!interest) throw new Error("That buyer hasn't expressed interest in this share.");
  const { data: buyer } = await db.from("buyer_accounts").select("id, auth_user_id, email, golden_ticket_issued").eq("id", params.buyerAccountId).maybeSingle();
  if (!buyer) throw new Error("Buyer not found.");
  if (buyer.golden_ticket_issued !== true) throw new Error(GOLDEN_TICKET_REQUIRED);
  if (await liveTransaction(db, listing.id)) throw new Error("This share already has a sale.");
  const { data, error } = await db
    .from("resale_transactions")
    .insert({ listing_id: listing.id, buyer_holder_key: buyer.id, buyer_user_id: buyer.auth_user_id, price: listing.asking_price, flat_fee: listing.flat_fee, status: "pending_closing" })
    .select("*")
    .maybeSingle();
  if (error?.code === "23505") throw new Error("This share already has a sale.");
  if (error || !data) throw new Error("Database is missing the resale sales — run resale-completion.sql in Supabase.");
  const sale = data as ResaleTransactionRow;
  await audit(db, { id: params.adminId, type: "admin" }, "resale.interest_converted", listing, { transaction_id: sale.id, buyer_account_id: buyer.id, price: sale.price });
  await tell(db, listing, [{ authUserId: buyer.auth_user_id, email: (buyer.email as string | null) ?? null }], "Your share purchase is set up", `divieight set up your purchase of share #${listing.share_number} at ${resaleMoney(listing.asking_price)}. divieight will contact you about closing.`);
  await tell(db, listing, [await userRecipient(db, listing.seller_user_id)], "A buyer is confirmed for your share", `A buyer is confirmed for share #${listing.share_number} at ${resaleMoney(listing.asking_price)}. divieight will contact you about closing.`);
  return { transactionId: sale.id };
}

export const GOLDEN_TICKET_REQUIRED = "This buyer hasn't been issued a Golden Ticket yet. They must complete the normal onboarding first.";

// ---------------------------------------------------------------------------
// A seller who sold every share: read-only, and only their picked weeks
// ---------------------------------------------------------------------------

export interface FormerSellerWeeks {
  allowed: boolean;
  propertyLabel: string;
  weeks: Array<{ year: number; weekNumber: number; startDate: string; endDate: string; isHoliday: boolean; upcoming: boolean }>;
}

/**
 * /owner/former/:propertyId. For someone who sold shares in this property and holds none now: the Use Calendar
 * weeks they already picked, and nothing else (no votes, no co-owners, no dashboard). A current holder, or someone
 * who never sold here, gets nothing: the same answer as for a property that doesn't exist.
 */
export async function formerSellerWeeks(db: Db, userId: string, propertyId: string): Promise<FormerSellerWeeks> {
  const none: FormerSellerWeeks = { allowed: false, propertyLabel: "", weeks: [] };
  if (await holderFor(db, userId, propertyId)) return none;
  const { data: sold } = await db.from("resale_listings").select("seller_holder_key").eq("property_id", propertyId).eq("seller_user_id", userId).eq("status", "sold");
  const keys = [...new Set(((sold ?? []) as Array<{ seller_holder_key: string }>).map((l) => l.seller_holder_key))];
  if (keys.length === 0) return none;
  const { data: weeks } = await db
    .from("use_calendar_weeks")
    .select("year, week_number, start_date, end_date, is_holiday")
    .eq("property_id", propertyId)
    .in("holder_key", keys)
    .order("start_date", { ascending: true });
  const today = new Date().toISOString().slice(0, 10);
  const { propertyCard } = await import("@/lib/owner.functions");
  const { label } = await propertyCard(db, propertyId);
  return {
    allowed: true,
    propertyLabel: label,
    weeks: ((weeks ?? []) as Array<{ year: number; week_number: number; start_date: string; end_date: string; is_holiday: boolean }>).map((w) => ({
      year: w.year,
      weekNumber: w.week_number,
      startDate: w.start_date,
      endDate: w.end_date,
      isHoliday: w.is_holiday,
      upcoming: w.end_date >= today,
    })),
  };
}
