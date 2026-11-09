/**
 * Owner voting (server side). Weights come only from cap_table_entries. An
 * owner may always vote: nothing here checks a Digital Key or property status
 * (Rev 48 floor). Every create, open, position, cast, change, close and cancel
 * goes to the audit log.
 */

import { deliver } from "@/lib/authorization.notify.server";
import {
  consensusState,
  nameInitials,
  tallyVote,
  VOTE_THRESHOLDS,
  VOTE_THRESHOLDS_ARE_PLACEHOLDER,
  type ConsensusState,
  type MemberPosition,
  type VoteResultSummary,
  type VoteStatus,
  type VoteType,
} from "@/lib/votes";

type Db = { from: (t: string) => any };

export interface VoteRow {
  id: string;
  property_id: string;
  title: string;
  description: string | null;
  vote_type: VoteType;
  options: string[];
  opens_at: string;
  closes_at: string;
  status: VoteStatus;
  result_summary: VoteResultSummary | null;
  created_at: string;
}

interface Holder {
  holderKey: string;
  type: "buyer" | "seller";
  buyerAccountId: string | null;
  shareNumbers: number[];
}

type CapRow = { share_number: number; holder_type: string; buyer_account_id: string | null; seller_id: string | null };

const holderKeyOf = (c: CapRow) => (c.holder_type === "retained_seller" ? `seller:${c.seller_id}` : String(c.buyer_account_id));

async function capRows(db: Db, propertyId: string): Promise<CapRow[]> {
  const { data } = await db
    .from("cap_table_entries")
    .select("share_number, holder_type, buyer_account_id, seller_id")
    .eq("property_id", propertyId);
  return (data ?? []) as CapRow[];
}

/** The user's holder on this property, or null if they aren't an owner of it. */
export async function holderFor(db: Db, userId: string, propertyId: string): Promise<Holder | null> {
  const { data: buyer } = await db.from("buyer_accounts").select("id").eq("auth_user_id", userId).maybeSingle();
  const buyerId = (buyer?.id as string | undefined) ?? null;
  const rows = await capRows(db, propertyId);
  const asBuyer = buyerId ? rows.filter((r) => r.holder_type === "buyer_account" && r.buyer_account_id === buyerId) : [];
  if (asBuyer.length > 0)
    return { holderKey: buyerId!, type: "buyer", buyerAccountId: buyerId, shareNumbers: asBuyer.map((r) => r.share_number).sort((a, b) => a - b) };
  const asSeller = rows.filter((r) => r.holder_type === "retained_seller" && r.seller_id === userId);
  if (asSeller.length > 0)
    return { holderKey: `seller:${userId}`, type: "seller", buyerAccountId: null, shareNumbers: asSeller.map((r) => r.share_number).sort((a, b) => a - b) };
  return null;
}

/** Every holder on this property once, whatever kind of holder they are. */
export async function holderRecipients(db: Db, propertyId: string): Promise<Array<{ authUserId: string; email: string | null }>> {
  const rows = await capRows(db, propertyId);
  const buyerIds = [...new Set(rows.map((r) => r.buyer_account_id).filter(Boolean))] as string[];
  const sellerIds = [...new Set(rows.map((r) => (r.holder_type === "retained_seller" ? r.seller_id : null)).filter(Boolean))] as string[];
  const { data: buyers } = buyerIds.length ? await db.from("buyer_accounts").select("auth_user_id, email").in("id", buyerIds) : { data: [] };
  return [
    ...((buyers ?? []) as Array<{ auth_user_id: string; email: string | null }>).map((b) => ({ authUserId: b.auth_user_id, email: b.email })),
    ...sellerIds.map((id) => ({ authUserId: id, email: null })),
  ];
}

async function audit(
  db: Db,
  params: { actorId: string | null; actorType: string; action: string; vote: Pick<VoteRow, "id" | "property_id">; holderKey?: string; weight?: number; extra?: Record<string, unknown> },
) {
  await db.from("audit_log").insert({
    actor_id: params.actorId,
    actor_type: params.actorType,
    action_type: params.action,
    entity_type: "vote",
    entity_id: params.vote.id,
    metadata: {
      property_id: params.vote.property_id,
      vote_id: params.vote.id,
      holder_key: params.holderKey ?? null,
      weight: params.weight ?? null,
      at: new Date().toISOString(),
      ...params.extra,
    },
  });
}

async function loadVote(db: Db, voteId: string): Promise<VoteRow | null> {
  const { data } = await db.from("votes").select("*").eq("id", voteId).maybeSingle();
  return (data as VoteRow) ?? null;
}

const windowProblem = (vote: VoteRow, now = Date.now()): string | null => {
  if (vote.status !== "open") return "This vote is not open.";
  if (now < new Date(vote.opens_at).getTime()) return "This vote hasn't opened yet.";
  if (now >= new Date(vote.closes_at).getTime()) return "This vote has closed.";
  return null;
};

/**
 * Close a vote and store its result. Ballots stop first (status change), then
 * the tally runs, weighted by the cap table at close. Safe to repeat: a closed
 * vote with a stored result is left alone; one interrupted mid-close finishes.
 */
export async function closeVote(db: Db, voteId: string, actor: { id: string | null; type: string }): Promise<VoteRow | null> {
  const vote = await loadVote(db, voteId);
  if (!vote) return null;
  if (vote.status === "closed" && vote.result_summary) return vote;
  if (vote.status !== "open" && vote.status !== "closed") return vote;

  await db.from("votes").update({ status: "closed" }).eq("id", vote.id).in("status", ["open", "closed"]);
  const { data: ballots } = await db.from("vote_ballots").select("holder_key, choice").eq("vote_id", vote.id);
  const rows = await capRows(db, vote.property_id);
  const weightOf = (key: string) => rows.filter((r) => holderKeyOf(r) === key).length;
  const summary = tallyVote({
    voteType: vote.vote_type,
    options: vote.options,
    issuedShares: rows.length,
    ballots: ((ballots ?? []) as Array<{ holder_key: string; choice: string }>).map((b) => ({ choice: b.choice, weight: weightOf(b.holder_key) })),
  });
  await db.from("votes").update({ result_summary: summary }).eq("id", vote.id);
  await audit(db, {
    actorId: actor.id,
    actorType: actor.type,
    action: "vote.closed",
    vote,
    extra: { passed: summary.passed, voted_shares: summary.votedShares, required_shares: summary.requiredShares, placeholder_thresholds: VOTE_THRESHOLDS_ARE_PLACEHOLDER },
  });
  const closed: VoteRow = { ...vote, status: "closed", result_summary: summary };
  await (await import("@/lib/retention.server")).applyVoteOutcome(db, closed);
  return closed;
}

/** A vote past its closing time closes the first time anyone looks. */
async function closeExpired(db: Db, votes: VoteRow[]): Promise<VoteRow[]> {
  const out: VoteRow[] = [];
  for (const v of votes) {
    const expired = v.status === "open" && Date.now() >= new Date(v.closes_at).getTime();
    out.push(expired ? ((await closeVote(db, v.id, { id: null, type: "system" })) ?? v) : v);
  }
  return out;
}

export interface OwnerVoteSummary {
  id: string;
  title: string;
  voteType: VoteType;
  status: VoteStatus;
  opensAt: string;
  closesAt: string;
  myWeight: number;
  myChoice: string | null;
}

export async function listOwnerVotes(db: Db, userId: string, propertyId: string): Promise<{ allowed: boolean; votes: OwnerVoteSummary[] }> {
  const holder = await holderFor(db, userId, propertyId);
  if (!holder) return { allowed: false, votes: [] };
  const { data, error } = await db
    .from("votes")
    .select("*")
    .eq("property_id", propertyId)
    .neq("status", "draft")
    .order("created_at", { ascending: false });
  if (error) return { allowed: true, votes: [] }; // before votes.sql is run
  const votes = await closeExpired(db, (data ?? []) as VoteRow[]);
  const ids = votes.map((v) => v.id);
  const { data: ballots } = ids.length
    ? await db.from("vote_ballots").select("vote_id, choice").eq("holder_key", holder.holderKey).in("vote_id", ids)
    : { data: [] };
  const mine = new Map(((ballots ?? []) as Array<{ vote_id: string; choice: string }>).map((b) => [b.vote_id, b.choice]));
  return {
    allowed: true,
    votes: votes.map((v) => ({
      id: v.id,
      title: v.title,
      voteType: v.vote_type,
      status: v.status,
      opensAt: v.opens_at,
      closesAt: v.closes_at,
      myWeight: holder.shareNumbers.length,
      myChoice: mine.get(v.id) ?? null,
    })),
  };
}

export interface OwnerVoteDetail {
  vote: Pick<VoteRow, "id" | "title" | "description" | "options" | "opens_at" | "closes_at" | "status"> & { voteType: VoteType };
  thresholdLabel: string;
  thresholdsArePlaceholder: boolean;
  myWeight: number;
  myShareNumbers: number[];
  myChoice: string | null;
  consensus: { state: ConsensusState; choice: string | null; members: MemberPosition[] };
  canCast: boolean;
  result: VoteResultSummary | null;
}

async function membersWithPositions(db: Db, holder: Holder, voteId: string): Promise<MemberPosition[]> {
  if (holder.type !== "buyer" || !holder.buyerAccountId) return [];
  const { data: members } = await db.from("account_members").select("id, full_name").eq("buyer_account_id", holder.buyerAccountId).eq("status", "active");
  const { data: positions } = await db
    .from("vote_member_positions")
    .select("account_member_id, position")
    .eq("vote_id", voteId)
    .eq("holder_key", holder.holderKey);
  const byMember = new Map(((positions ?? []) as Array<{ account_member_id: string; position: string }>).map((p) => [p.account_member_id, p.position]));
  return ((members ?? []) as Array<{ id: string; full_name: string | null }>).map((m) => ({
    memberId: m.id,
    name: m.full_name || "Account Member",
    position: byMember.get(m.id) ?? null,
  }));
}

export async function ownerVoteDetail(db: Db, userId: string, propertyId: string, voteId: string): Promise<OwnerVoteDetail | null> {
  const holder = await holderFor(db, userId, propertyId);
  if (!holder) return null;
  const found = await loadVote(db, voteId);
  if (!found || found.property_id !== propertyId || found.status === "draft") return null;
  const [vote] = await closeExpired(db, [found]);
  const { data: ballot } = await db
    .from("vote_ballots")
    .select("choice")
    .eq("vote_id", vote!.id)
    .eq("holder_key", holder.holderKey)
    .maybeSingle();
  const members = await membersWithPositions(db, holder, vote!.id);
  const consensus = consensusState(members);
  return {
    vote: {
      id: vote!.id,
      title: vote!.title,
      description: vote!.description,
      options: vote!.options,
      opens_at: vote!.opens_at,
      closes_at: vote!.closes_at,
      status: vote!.status,
      voteType: vote!.vote_type,
    },
    thresholdLabel: VOTE_THRESHOLDS[vote!.vote_type].label,
    thresholdsArePlaceholder: VOTE_THRESHOLDS_ARE_PLACEHOLDER,
    myWeight: holder.shareNumbers.length,
    myShareNumbers: holder.shareNumbers,
    myChoice: (ballot?.choice as string | undefined) ?? null,
    consensus: { ...consensus, members },
    canCast: !windowProblem(vote!),
    result: vote!.status === "closed" ? vote!.result_summary : null,
  };
}

/** A member of a multi-member account records where they stand. */
export async function recordMemberPosition(
  db: Db,
  params: { userId: string; propertyId: string; voteId: string; accountMemberId: string; position: string; initials: string },
): Promise<{ error?: string }> {
  const holder = await holderFor(db, params.userId, params.propertyId);
  const vote = await loadVote(db, params.voteId);
  if (!holder || !vote || vote.property_id !== params.propertyId) return { error: "This vote isn't available." };
  const problem = windowProblem(vote);
  if (problem) return { error: problem };
  if (!vote.options.includes(params.position)) return { error: "Choose one of the options." };

  const members = await membersWithPositions(db, holder, vote.id);
  const member = members.find((m) => m.memberId === params.accountMemberId);
  if (!member) return { error: "That member isn't on your account." };
  if (nameInitials(member.name) !== params.initials.replace(/\s+/g, "").toUpperCase())
    return { error: `Type ${member.name}'s initials to record their position.` };

  const { data: existing } = await db
    .from("vote_member_positions")
    .select("id")
    .eq("vote_id", vote.id)
    .eq("account_member_id", member.memberId)
    .maybeSingle();
  const now = new Date().toISOString();
  const { error } = existing
    ? await db.from("vote_member_positions").update({ position: params.position, user_id: params.userId, updated_at: now }).eq("id", existing.id)
    : await db.from("vote_member_positions").insert({
        vote_id: vote.id,
        holder_key: holder.holderKey,
        account_member_id: member.memberId,
        user_id: params.userId,
        position: params.position,
        updated_at: now,
      });
  if (error) return { error: error.message };
  await audit(db, {
    actorId: params.userId,
    actorType: "buyer",
    action: "vote.member_position_recorded",
    vote,
    holderKey: holder.holderKey,
    weight: holder.shareNumbers.length,
    extra: { account_member_id: member.memberId, position: params.position, secondary_verification_method: "typed_initials" },
  });
  return {};
}

/** cast_ballot: one ballot per holder, changeable until the vote closes. */
export async function castBallot(
  db: Db,
  params: { userId: string; propertyId: string; voteId: string; choice: string },
): Promise<{ error?: string; changed?: boolean }> {
  const holder = await holderFor(db, params.userId, params.propertyId);
  const vote = await loadVote(db, params.voteId);
  if (!holder || !vote || vote.property_id !== params.propertyId || vote.status === "draft") return { error: "This vote isn't available." };
  const problem = windowProblem(vote);
  if (problem) return { error: problem };
  if (!vote.options.includes(params.choice)) return { error: "Choose one of the options." };

  const members = await membersWithPositions(db, holder, vote.id);
  const consensus = consensusState(members);
  if (consensus.state === "disagree") return { error: "Your account members disagree — reach consensus to cast." };
  if (consensus.state === "pending") {
    const pending = members.filter((m) => !m.position).map((m) => m.name);
    return { error: `Waiting for ${pending.join(", ")} to record a position.` };
  }
  if (consensus.state === "agreed" && consensus.choice !== params.choice)
    return { error: "Your ballot must match your account's agreed position." };

  const { data: existing } = await db
    .from("vote_ballots")
    .select("id, choice")
    .eq("vote_id", vote.id)
    .eq("holder_key", holder.holderKey)
    .maybeSingle();
  const row = { share_numbers: holder.shareNumbers, cast_by_user_id: params.userId, choice: params.choice, cast_at: new Date().toISOString() };
  const { error } = existing
    ? await db.from("vote_ballots").update(row).eq("id", existing.id)
    : await db.from("vote_ballots").insert({ vote_id: vote.id, holder_key: holder.holderKey, ...row });
  if (error) return { error: /not open/i.test(error.message) ? "This vote is not open." : error.message };
  await audit(db, {
    actorId: params.userId,
    actorType: holder.type,
    action: existing ? "vote.ballot_changed" : "vote.ballot_cast",
    vote,
    holderKey: holder.holderKey,
    weight: holder.shareNumbers.length,
    extra: { choice: params.choice, previous_choice: existing?.choice ?? null, share_numbers: holder.shareNumbers },
  });
  return { changed: Boolean(existing) };
}

// ---------------------------------------------------------------------------
// Admin (divieight as Manager)
// ---------------------------------------------------------------------------

export async function listPropertyVotes(db: Db, propertyId: string) {
  const { data, error } = await db.from("votes").select("*").eq("property_id", propertyId).order("created_at", { ascending: false });
  if (error) throw new Error("Database is missing votes — run votes.sql in Supabase.");
  const votes = await closeExpired(db, (data ?? []) as VoteRow[]);
  const rows = await capRows(db, propertyId);
  const out = [];
  for (const v of votes) {
    const { data: ballots } = await db.from("vote_ballots").select("holder_key").eq("vote_id", v.id);
    const castShares = ((ballots ?? []) as Array<{ holder_key: string }>).reduce(
      (sum, b) => sum + rows.filter((r) => holderKeyOf(r) === b.holder_key).length,
      0,
    );
    out.push({ ...v, castShares, issuedShares: rows.length });
  }
  return out;
}

export async function createVote(
  db: Db,
  params: { actorId: string; actorType?: string; propertyId: string; title: string; description: string | null; voteType: VoteType; options: string[]; opensAt: string; closesAt: string },
): Promise<VoteRow> {
  const { data: property } = await db.from("properties").select("id").eq("id", params.propertyId).maybeSingle();
  if (!property) throw new Error("Property not found");
  const { data, error } = await db
    .from("votes")
    .insert({
      property_id: params.propertyId,
      title: params.title,
      description: params.description,
      vote_type: params.voteType,
      options: params.options,
      opens_at: params.opensAt,
      closes_at: params.closesAt,
      status: "draft",
      created_by: params.actorId,
    })
    .select("*")
    .maybeSingle();
  if (error || !data) throw new Error("Database is missing votes — run votes.sql in Supabase.");
  await audit(db, { actorId: params.actorId, actorType: params.actorType ?? "admin", action: "vote.created", vote: data as VoteRow, extra: { vote_type: params.voteType } });
  return data as VoteRow;
}

export async function openVote(db: Db, actorId: string, voteId: string, actorType = "admin") {
  const vote = await loadVote(db, voteId);
  if (!vote) throw new Error("Vote not found");
  if (vote.status !== "draft") throw new Error("Only a draft can be opened.");
  if (Date.now() >= new Date(vote.closes_at).getTime()) throw new Error("This vote's closing time has already passed.");
  await db.from("votes").update({ status: "open" }).eq("id", vote.id).eq("status", "draft");
  await audit(db, { actorId, actorType, action: "vote.opened", vote });

  for (const recipient of await holderRecipients(db, vote.property_id)) {
    await deliver(db as never, recipient, {
      subject: "A vote is open on your property",
      message: `A vote is open: "${vote.title}". Cast your ballot from your owner dashboard.`,
      link: `/owner/properties/${vote.property_id}/votes/${vote.id}`,
      type: "governance_vote_window",
      propertyId: vote.property_id,
      dedupeKey: `vote_opened:${vote.id}`,
    });
  }
}

export async function cancelVote(db: Db, actorId: string, voteId: string, actorType = "admin") {
  const vote = await loadVote(db, voteId);
  if (!vote) throw new Error("Vote not found");
  if (vote.status !== "draft" && vote.status !== "open") throw new Error("Only a draft or open vote can be cancelled.");
  await db.from("votes").update({ status: "cancelled" }).eq("id", vote.id);
  await audit(db, { actorId, actorType, action: "vote.cancelled", vote });
  await (await import("@/lib/retention.server")).applyVoteOutcome(db, { ...vote, status: "cancelled" });
}
