import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { rejectAuthorityAttempt } from "@/lib/member-authority";

/** Callable surface for the member-level steps: W-9, Blocks 1 and 2, the Plaid link, and signatures. */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function request() {
  try {
    const { getRequest, getRequestIP } = await import("@tanstack/react-start/server");
    return { ip: getRequestIP({ xForwardedFor: true }) ?? null, userAgent: getRequest().headers.get("user-agent") };
  } catch {
    return { ip: null, userAgent: null };
  }
}

const text = (v: unknown, label: string, max: number) => {
  const t = String(v ?? "").trim();
  if (!t) throw new Error(`Missing ${label}`);
  return t.slice(0, max);
};
const memberId = (v: unknown) => text(v, "member", 64);

// ---- W-9 -------------------------------------------------------------------

export const getMyW9 = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { actingMemberId: string }) => ({ actingMemberId: memberId(input?.actingMemberId) }))
  .handler(async ({ data, context }) => (await import("@/lib/w9.server")).myW9(await adminDb(), { userId: context.userId, actingMemberId: data.actingMemberId }));

export const submitW9Fn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { actingMemberId: string; legalName: string; taxClassification: string; address: string; tinKind: string; tin: string; signedName: string }) => (rejectAuthorityAttempt(input, "w9"), {
    actingMemberId: memberId(input?.actingMemberId),
    legalName: String(input?.legalName ?? "").slice(0, 200),
    taxClassification: String(input?.taxClassification ?? "").slice(0, 40),
    address: String(input?.address ?? "").slice(0, 500),
    tinKind: (input?.tinKind === "ein" ? "ein" : "ssn") as "ssn" | "ein",
    // Normalised and validated on the server; never echoed back.
    tin: String(input?.tin ?? "").slice(0, 20),
    signedName: String(input?.signedName ?? "").slice(0, 200),
  }))
  .handler(async ({ data, context }) => (await import("@/lib/w9.server")).submitW9(await adminDb(), { userId: context.userId, ...data, request: await request() }));

// ---- Blocks 1 and 2 ----------------------------------------------------------

export const getAuthorizationState = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { actingMemberId: string }) => ({ actingMemberId: memberId(input?.actingMemberId) }))
  .handler(async ({ data, context }) => (await import("@/lib/member-steps.server")).authorizationState(await adminDb(), { userId: context.userId, actingMemberId: data.actingMemberId }));

export const acceptAuthorizationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { actingMemberId: string; block: string }) => {
    if (input?.block !== "block1" && input?.block !== "block2") throw new Error("Unknown authorization");
    rejectAuthorityAttempt(input, input.block);
    return { actingMemberId: memberId(input.actingMemberId), block: input.block as "block1" | "block2" };
  })
  .handler(async ({ data, context }) => (await import("@/lib/member-steps.server")).acceptAuthorization(await adminDb(), { userId: context.userId, ...data, request: await request() }));

export const recordPlaidLinkFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { actingMemberId: string }) => ({ actingMemberId: memberId(input?.actingMemberId) }))
  .handler(async ({ data, context }) => (await import("@/lib/member-steps.server")).recordPlaidLink(await adminDb(), { userId: context.userId, actingMemberId: data.actingMemberId, request: await request() }));

// ---- Signatures (PRA, Hold Harmless) ------------------------------------------

export const getSignatureState = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { actingMemberId: string; documentType: string }) => {
    if (input?.documentType !== "PRA" && input?.documentType !== "HOLD_HARMLESS") throw new Error("Unknown document");
    return { actingMemberId: memberId(input.actingMemberId), documentType: input.documentType as "PRA" | "HOLD_HARMLESS" };
  })
  .handler(async ({ data, context }) => (await import("@/lib/member-steps.server")).signatureState(await adminDb(), { userId: context.userId, ...data }));

export const signMemberDocumentFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { actingMemberId: string; documentType: string; documentVersion: string; documentHash: string; typedName: string; onBehalfOfMemberId?: string | null }) => {
    if (input?.documentType !== "PRA" && input?.documentType !== "HOLD_HARMLESS") throw new Error("Unknown document");
    // Authority can cover the PRA (with a live grant) but never the Hold Harmless.
    if (input.documentType === "HOLD_HARMLESS") rejectAuthorityAttempt(input, "hold_harmless");
    return {
      onBehalfOfMemberId: input.onBehalfOfMemberId ? memberId(input.onBehalfOfMemberId) : null,
      actingMemberId: memberId(input.actingMemberId),
      documentType: input.documentType as "PRA" | "HOLD_HARMLESS",
      documentVersion: text(input.documentVersion, "document version", 40),
      documentHash: text(input.documentHash, "document hash", 200),
      typedName: String(input.typedName ?? "").slice(0, 200),
    };
  })
  .handler(async ({ data, context }) => (await import("@/lib/member-steps.server")).signMemberDocument(await adminDb(), { userId: context.userId, ...data, request: await request() }));

// ---- Tax export (Month 6): the only TIN decryption ----------------------------

export const decryptW9TinForTaxExport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { w9Id: string; reason: string }) => ({ w9Id: text(input?.w9Id, "W-9", 64), reason: String(input?.reason ?? "").slice(0, 500) }))
  .handler(async ({ data, context }) => {
    const { data: isAdmin } = await (context.supabase as any).rpc("has_role", { _user_id: context.userId, _role: "admin" });
    if (!isAdmin) throw new Error("Not authorized");
    const tin = await (await import("@/lib/w9.server")).decryptTinForTaxExport(await adminDb(), { actorId: context.userId, ...data });
    return { tin };
  });
