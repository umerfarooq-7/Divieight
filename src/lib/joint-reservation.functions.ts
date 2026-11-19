import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Callable surface for joint reservations. */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function server() {
  return import("@/lib/joint-reservation.server");
}

const id = (value: unknown) => {
  const t = String(value ?? "").trim();
  if (!t) throw new Error("Enter a request");
  return t.slice(0, 64);
};

export const getIncomingJointRequests = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => (await server()).incomingJointRequests(await adminDb(), { userId: context.userId }));

export const respondToJointRequestFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { requestId: string; accept: boolean }) => ({ requestId: id(input?.requestId), accept: input?.accept === true }))
  .handler(async ({ data, context }) => (await server()).respondToJointRequest(await adminDb(), { userId: context.userId, ...data }));

export const cancelJointRequestFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { requestId: string }) => ({ requestId: id(input?.requestId) }))
  .handler(async ({ data, context }) => {
    await (await server()).cancelJointRequest(await adminDb(), { userId: context.userId, ...data });
    return { ok: true };
  });
