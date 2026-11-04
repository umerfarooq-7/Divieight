/**
 * Resale Shop (server side). Owner access rests only on holding a share, never
 * on a Digital Key or property status (Rev 48 floor); the only limit is that a
 * locked share can't be listed. Elections made during the window are decided by
 * conflict resolution, not here. Every step goes to the audit log.
 */

import { adminRecipients, deliver } from "@/lib/authorization.notify.server";
import { RESALE_LIVE_STATUSES, RESALE_STATUS_LABELS, resaleMoney, rofrCloseAt, type ResaleStatus, type RofrPosition } from "@/lib/resale";
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

async function tell(db: Db, listing: ResaleListingRow, recipients: Array<{ authUserId: string; email: string | null }>, subject: string, message: string) {
  for (const r of recipients) {
    await deliver(db as never, r, { subject, message, link: ownerLink(listing.property_id), type: "resale" });
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

/**
 * Listings past their window move on: no election means the open market, any
 * election goes to conflict resolution. Safe to repeat; each moves only once.
 */
export async function settleRofr(db: Db, propertyId?: string): Promise<{ openMarket: number; exercised: number }> {
  let query = db.from("resale_listings").select("*").eq("status", "rofr_open").lte("rofr_closes_at", new Date().toISOString());
  if (propertyId) query = query.eq("property_id", propertyId);
  const { data, error } = await query;
  const moved = { openMarket: 0, exercised: 0 };
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
      await tell(db, listing, [seller], "Your share is on the open market", `No co-owner exercised the right of first refusal on share #${listing.share_number}, so it is now on the open market.`);
    } else {
      moved.exercised += 1;
      const electors = await Promise.all(elections.filter((e) => e.user_id).map((e) => userRecipient(db, e.user_id!)));
      await tell(db, listing, [seller, ...electors], "Right of first refusal closed", `The right of first refusal on share #${listing.share_number} has closed with ${elections.length} election${elections.length === 1 ? "" : "s"}. divieight will confirm the outcome.`);
      await tellAdmins(db, "Resale election needs resolving", `Share #${listing.share_number} closed its right of first refusal with ${elections.length} election${elections.length === 1 ? "" : "s"}.`);
    }
  }
  return moved;
}

async function members(db: Db, holder: { type: string; buyerAccountId: string | null; holderKey: string }, listingId: string): Promise<MemberPosition[]> {
  if (holder.type !== "buyer" || !holder.buyerAccountId) return [];
  const { data: rows } = await db.from("account_members").select("id, full_name").eq("buyer_account_id", holder.buyerAccountId);
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
}

export interface CoOwnerResaleListing {
  id: string;
  shareNumber: number;
  askingPrice: number;
  status: ResaleStatus;
  rofrClosesAt: string;
  myElection: "active" | "won" | "lost" | "withdrawn" | null;
  canElect: boolean;
  consensus: { state: ConsensusState; choice: string | null; members: MemberPosition[] };
}

/** /owner/properties/:id/resale. Never gated on anything but holding a share. */
export async function ownerResale(db: Db, userId: string, propertyId: string): Promise<{ allowed: boolean; shares: OwnerResaleShare[]; mine: OwnerResaleListing[]; coOwners: CoOwnerResaleListing[] }> {
  const holder = await holderFor(db, userId, propertyId);
  if (!holder) return { allowed: false, shares: [], mine: [], coOwners: [] };
  await settleRofr(db, propertyId);
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
        canWithdraw: RESALE_LIVE_STATUSES.includes(l.status) && !elections.some((e) => e.status === "won"),
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
      myElection,
      canElect: !rofrProblem(l) && myElection !== "active",
      consensus: { ...consensusState(memberRows), members: memberRows },
    });
  }
  return { allowed: true, shares, mine, coOwners };
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

  const opensAt = new Date();
  const closesAt = rofrCloseAt(opensAt);
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
    `Share #${listing.share_number} is offered at ${resaleMoney(listing.asking_price)}. As a co-owner you have 10 days to exercise your right of first refusal.`,
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
  if ((won ?? []).length > 0) return { error: "A co-owner has been confirmed as the buyer, so this listing can't be withdrawn." };
  const { data } = await db.from("resale_listings").update({ status: "withdrawn" }).eq("id", found.listing.id).in("status", RESALE_LIVE_STATUSES).select("*").maybeSingle();
  const listing = data as ResaleListingRow | null;
  if (!listing) return { error: "This listing can't be withdrawn any more." };

  const elections = await activeElections(db, listing.id);
  await db.from("resale_rofr_elections").update({ status: "lost" }).eq("listing_id", listing.id).eq("status", "active");
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
  interested: Array<{ email: string | null; at: string }>;
  createdAt: string;
}

export async function adminResale(db: Db): Promise<{ rows: AdminResaleListing[] }> {
  await settleRofr(db);
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
      const { data: b } = await db.from("buyer_accounts").select("email").eq("id", i.buyer_account_id).maybeSingle();
      interested.push({ email: (b?.email as string | null) ?? null, at: i.created_at });
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
      createdAt: l.created_at,
    });
  }
  return { rows };
}
