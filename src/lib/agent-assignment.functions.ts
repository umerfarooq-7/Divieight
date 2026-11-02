import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { AdminAssignmentRow } from "@/lib/agent-assignment.server";

/** Callable surface for "Let divieight choose an agent for me". */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function server() {
  return import("@/lib/agent-assignment.server");
}

async function buyerIdFor(db: Db, userId: string): Promise<string | null> {
  const { data } = await db.from("buyer_accounts").select("id").eq("auth_user_id", userId).maybeSingle();
  return (data?.id as string | null) ?? null;
}

async function agentIdFor(db: Db, userId: string): Promise<string | null> {
  const { data } = await db.from("agents").select("id").eq("auth_user_id", userId).maybeSingle();
  return (data?.id as string | null) ?? null;
}

/** Buyer: ask divieight to choose the account's agent. */
export const requestAgentAssignment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ error?: string }> => {
    const db = await adminDb();
    const buyerId = await buyerIdFor(db, context.userId);
    if (!buyerId) return { error: "Buyer account not found." };
    const { data: buyer } = await db.from("buyer_accounts").select("tether_status").eq("id", buyerId).maybeSingle();
    if (buyer?.tether_status === "tethered") return { error: "You already have an agent." };
    try {
      await (await server()).requestPlatformAssignment(db, { actorId: context.userId, buyerAccountId: buyerId });
      return {};
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Could not send your request." };
    }
  });

/** Buyer: go back to choosing their own agent (account or one property). */
export const cancelAgentAssignment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { requestId: string }) => {
    if (!input?.requestId) throw new Error("Missing request");
    return input;
  })
  .handler(async ({ data, context }): Promise<{ error?: string }> => {
    const db = await adminDb();
    const buyerId = await buyerIdFor(db, context.userId);
    if (!buyerId) return { error: "Buyer account not found." };
    try {
      await (await server()).cancelPlatformAssignment(db, {
        actorId: context.userId,
        buyerAccountId: buyerId,
        requestId: data.requestId,
      });
      return {};
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Could not cancel the request." };
    }
  });

/** Admin: the queue at /admin/agent-assignments. */
export const listAgentAssignments = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ rows: AdminAssignmentRow[] }> => {
    const { data: isAdmin } = await context.supabase.rpc("has_role", { _user_id: context.userId, _role: "admin" });
    if (!isAdmin) throw new Error("Not authorized");
    return { rows: await (await server()).listAssignmentQueue(await adminDb()) };
  });

/** Admin: assign an eligible agent to a pending request. */
export const assignAgentToRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { requestId: string; agentId: string }) => {
    if (!input?.requestId || !input?.agentId) throw new Error("Choose an agent");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { data: isAdmin } = await context.supabase.rpc("has_role", { _user_id: context.userId, _role: "admin" });
    if (!isAdmin) throw new Error("Not authorized");
    await (await server()).assignAgent(await adminDb(), {
      actorId: context.userId,
      requestId: data.requestId,
      agentId: data.agentId,
    });
    return { ok: true };
  });

/** Agent: property-scoped offers (account-level ones are designation requests). */
export const listPropertyAssignmentOffers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = await adminDb();
    const agentId = await agentIdFor(db, context.userId);
    if (!agentId) return [] as Array<{ requestId: string; propertyLabel: string }>;
    return (await server()).listPropertyOffers(db, agentId);
  });

/** Agent: accept or decline a property-scoped offer. */
export const respondToPropertyAssignment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { requestId: string; accept: boolean }) => {
    if (!input?.requestId) throw new Error("Missing request");
    return input;
  })
  .handler(async ({ data, context }): Promise<{ error?: string }> => {
    const db = await adminDb();
    const agentId = await agentIdFor(db, context.userId);
    if (!agentId) return { error: "Agent profile not found." };
    return (await server()).respondToPropertyOffer(db, {
      actorId: context.userId,
      agentId,
      requestId: data.requestId,
      accept: data.accept,
    });
  });
