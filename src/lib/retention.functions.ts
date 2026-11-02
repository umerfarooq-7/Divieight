import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { RETENTION_EXCEPTION_TYPES, type RetentionExceptionType } from "@/lib/retention";

/** Callable surface for Retention Lock exceptions. */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function server() {
  return import("@/lib/retention.server");
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

export const getOwnerRetention = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: required(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).ownerRetention(await adminDb(), context.userId, data.propertyId));

export const requestRetentionException = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { propertyId: string; shareNumber: number; exceptionType: RetentionExceptionType; reason: string; supportingDocUrl?: string | null }) => {
      const shareNumber = Number(input?.shareNumber);
      if (!Number.isInteger(shareNumber)) throw new Error("Choose a share");
      if (!RETENTION_EXCEPTION_TYPES.includes(input?.exceptionType)) throw new Error("Choose an exception type");
      return {
        propertyId: required(input?.propertyId, "property"),
        shareNumber,
        exceptionType: input.exceptionType,
        reason: required(input?.reason, "reason").slice(0, 5000),
        supportingDocUrl: input?.supportingDocUrl?.trim() || null,
      };
    },
  )
  .handler(async ({ data, context }) => (await server()).requestException(await adminDb(), { userId: context.userId, ...data }));

export const withdrawRetentionException = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { exceptionId: string }) => ({ exceptionId: required(input?.exceptionId, "request") }))
  .handler(async ({ data, context }) => (await server()).withdrawException(await adminDb(), context.userId, data.exceptionId));

export const listRetentionExceptionsForAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context);
    return (await server()).adminRetentionExceptions(await adminDb());
  });

export const decideRetentionException = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { exceptionId: string; decision: "approved" | "rejected"; note: string }) => {
    if (input?.decision !== "approved" && input?.decision !== "rejected") throw new Error("Choose approve or reject");
    return {
      exceptionId: required(input?.exceptionId, "request"),
      decision: input.decision,
      note: required(input?.note, "decision note").slice(0, 5000),
    };
  })
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    await (await server()).decideHardship(await adminDb(), { adminId: context.userId, ...data });
    return { ok: true };
  });
