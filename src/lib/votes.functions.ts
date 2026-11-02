import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { DEFAULT_VOTE_OPTIONS, VOTE_TYPES, type VoteType } from "@/lib/votes";

/** Callable surface for owner voting. */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function server() {
  return import("@/lib/votes.server");
}

async function requireAdmin(context: { supabase: any; userId: string }) {
  const { data } = await context.supabase.rpc("has_role", { _user_id: context.userId, _role: "admin" });
  if (!data) throw new Error("Not authorized");
}

const required = (value: unknown, label: string) => {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`Missing ${label}`);
  return text;
};

export const listVotesForOwner = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: required(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).listOwnerVotes(await adminDb(), context.userId, data.propertyId));

export const getVoteForOwner = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; voteId: string }) => ({
    propertyId: required(input?.propertyId, "property"),
    voteId: required(input?.voteId, "vote"),
  }))
  .handler(async ({ data, context }) => (await server()).ownerVoteDetail(await adminDb(), context.userId, data.propertyId, data.voteId));

export const recordVotePosition = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; voteId: string; accountMemberId: string; position: string; initials: string }) => ({
    propertyId: required(input?.propertyId, "property"),
    voteId: required(input?.voteId, "vote"),
    accountMemberId: required(input?.accountMemberId, "member"),
    position: required(input?.position, "position"),
    initials: String(input?.initials ?? ""),
  }))
  .handler(async ({ data, context }) => (await server()).recordMemberPosition(await adminDb(), { userId: context.userId, ...data }));

export const castVoteBallot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; voteId: string; choice: string }) => ({
    propertyId: required(input?.propertyId, "property"),
    voteId: required(input?.voteId, "vote"),
    choice: required(input?.choice, "choice"),
  }))
  .handler(async ({ data, context }) => (await server()).castBallot(await adminDb(), { userId: context.userId, ...data }));

export const listVotesForAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: required(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const db = await adminDb();
    const { data: p } = await db.from("properties").select("address, city, state").eq("id", data.propertyId).maybeSingle();
    if (!p) throw new Error("Property not found");
    return {
      label: [p.address, p.city, p.state].filter(Boolean).join(", "),
      votes: await (await server()).listPropertyVotes(db, data.propertyId),
    };
  });

export const createVoteAsAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { propertyId: string; title: string; description?: string | null; voteType: VoteType; options?: string[]; opensAt: string; closesAt: string }) => {
      const opens = new Date(input?.opensAt);
      const closes = new Date(input?.closesAt);
      if (Number.isNaN(opens.getTime()) || Number.isNaN(closes.getTime())) throw new Error("Set when the vote opens and closes");
      if (closes <= opens) throw new Error("The vote must close after it opens");
      if (!VOTE_TYPES.includes(input.voteType)) throw new Error("Choose a vote type");
      const options = [...new Set((input.options?.length ? input.options : DEFAULT_VOTE_OPTIONS).map((o) => String(o).trim()).filter(Boolean))];
      if (options.length < 2 || options.length > 10) throw new Error("A vote needs 2 to 10 options");
      return {
        propertyId: required(input.propertyId, "property"),
        title: required(input.title, "title").slice(0, 200),
        description: input.description?.trim() ? input.description.trim().slice(0, 5000) : null,
        voteType: input.voteType,
        options,
        opensAt: opens.toISOString(),
        closesAt: closes.toISOString(),
      };
    },
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const vote = await (await server()).createVote(await adminDb(), { actorId: context.userId, ...data });
    return { id: vote.id };
  });

export const openVoteAsAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { voteId: string }) => ({ voteId: required(input?.voteId, "vote") }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    await (await server()).openVote(await adminDb(), context.userId, data.voteId);
    return { ok: true };
  });

export const closeVoteAsAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { voteId: string }) => ({ voteId: required(input?.voteId, "vote") }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    await (await server()).closeVote(await adminDb(), data.voteId, { id: context.userId, type: "admin" });
    return { ok: true };
  });

export const cancelVoteAsAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { voteId: string }) => ({ voteId: required(input?.voteId, "vote") }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    await (await server()).cancelVote(await adminDb(), context.userId, data.voteId);
    return { ok: true };
  });
