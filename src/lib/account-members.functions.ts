import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { rejectAuthorityAttempt } from "@/lib/member-authority";

/** Callable surface for Account Members. */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function server() {
  return import("@/lib/account-members.server");
}

async function request() {
  try {
    const { getRequest, getRequestIP } = await import("@tanstack/react-start/server");
    return { ip: getRequestIP({ xForwardedFor: true }) ?? null, userAgent: getRequest().headers.get("user-agent") };
  } catch {
    return { ip: null, userAgent: null };
  }
}

const text = (value: unknown, label: string, max: number) => {
  const t = String(value ?? "").trim();
  if (!t) throw new Error(`Enter ${label}`);
  return t.slice(0, max);
};
const optional = (value: unknown, max: number) => {
  const t = String(value ?? "").trim();
  return t ? t.slice(0, max) : null;
};
const id = (value: unknown, label: string) => text(value, label, 64);

export const getMyAccountMembers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => (await server()).myAccountMembers(await adminDb(), context.userId));

export const confirmActingMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { memberId: string; step: string }) => ({ memberId: id(input?.memberId, "a member"), step: text(input?.step, "a step", 60) }))
  .handler(async ({ data, context }) => {
    await (await server()).recordActingMember(await adminDb(), { userId: context.userId, ...data, request: await request() });
    return { ok: true };
  });

const memberFields = (input: { fullName?: unknown; email?: unknown; phone?: unknown }) => ({
  fullName: text(input?.fullName, "their full name", 200),
  email: text(input?.email, "their email", 254),
  phone: optional(input?.phone, 40),
});

export const addAccountMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { actingMemberId: string; fullName: string; email: string; phone?: string | null }) => ({ actingMemberId: id(input?.actingMemberId, "who is acting"), ...memberFields(input) }))
  .handler(async ({ data, context }) => (await server()).addSecondMember(await adminDb(), { userId: context.userId, ...data, request: await request() }));

export const updateAccountMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { actingMemberId: string; memberId: string; fullName: string; email: string; phone?: string | null }) => ({
    actingMemberId: id(input?.actingMemberId, "who is acting"),
    memberId: id(input?.memberId, "a member"),
    ...memberFields(input),
  }))
  .handler(async ({ data, context }) => {
    await (await server()).updateSecondMember(await adminDb(), { userId: context.userId, ...data, request: await request() });
    return { ok: true };
  });

export const removeAccountMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { actingMemberId: string; memberId: string }) => ({ actingMemberId: id(input?.actingMemberId, "who is acting"), memberId: id(input?.memberId, "a member") }))
  .handler(async ({ data, context }) => {
    await (await server()).removeSecondMember(await adminDb(), { userId: context.userId, ...data, request: await request() });
    return { ok: true };
  });

export const remindAccountMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { actingMemberId: string; memberId: string }) => ({ actingMemberId: id(input?.actingMemberId, "who is acting"), memberId: id(input?.memberId, "a member") }))
  .handler(async ({ data, context }) => (await server()).remindSecondMember(await adminDb(), { userId: context.userId, ...data, request: await request() }));

export const saveMemberIdentityFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { actingMemberId: string; fullName: string; address: string; dateOfBirth: string; idDocumentNumber: string; idDocumentPath?: string | null }) => {
    // The ID scan is always the member's own: authority can never cover it.
    rejectAuthorityAttempt(input, "id_scan");
    const dateOfBirth = String(input?.dateOfBirth ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) throw new Error("Enter a valid date of birth");
    return {
      actingMemberId: id(input?.actingMemberId, "who is acting"),
      fullName: text(input?.fullName, "the full name", 200),
      address: text(input?.address, "the address", 500),
      dateOfBirth,
      idDocumentNumber: text(input?.idDocumentNumber, "the ID number", 64).replace(/\s+/g, ""),
      idDocumentPath: optional(input?.idDocumentPath, 500),
    };
  })
  .handler(async ({ data, context }) => (await server()).saveMemberIdentity(await adminDb(), { userId: context.userId, ...data, request: await request() }));

export const adminChangeAccountMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { memberId: string; fullName?: string; email?: string; phone?: string | null; remove?: boolean; reason: string }) => ({
    memberId: id(input?.memberId, "a member"),
    fullName: input?.fullName === undefined ? undefined : text(input.fullName, "the full name", 200),
    email: input?.email === undefined ? undefined : text(input.email, "the email", 254),
    phone: input?.phone === undefined ? undefined : optional(input.phone, 40),
    remove: input?.remove === true,
    reason: text(input?.reason, "a reason", 1000),
  }))
  .handler(async ({ data, context }) => {
    const { data: isAdmin } = await (context.supabase as any).rpc("has_role", { _user_id: context.userId, _role: "admin" });
    if (!isAdmin) throw new Error("Not authorized");
    await (await server()).adminChangeMember(await adminDb(), { adminId: context.userId, ...data, request: await request() });
    return { ok: true };
  });
