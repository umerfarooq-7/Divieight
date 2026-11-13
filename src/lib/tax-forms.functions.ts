import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Callable surface for tax forms and tax data. Nothing here ever returns a TIN except the vault file downloads and the audited reveals. */

type Db = Parameters<(typeof import("@/lib/tax-forms.server"))["adminBrokerForms"]>[0];

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}
const server = () => import("@/lib/tax-forms.server");

async function request() {
  try {
    const { getRequest, getRequestIP } = await import("@tanstack/react-start/server");
    return { ip: getRequestIP({ xForwardedFor: true }) ?? null, userAgent: getRequest().headers.get("user-agent") };
  } catch {
    return { ip: null, userAgent: null };
  }
}

const id = (value: unknown, label: string) => {
  const t = String(value ?? "").trim();
  if (!t) throw new Error(`Missing ${label}`);
  return t.slice(0, 64);
};
const year = (value: unknown) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 2000 || n > 2200) throw new Error("Enter a valid year");
  return n;
};
const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);
const tinKind = (v: unknown) => (["ssn", "ein", "itin", "foreign_tin", "none"].includes(String(v)) ? (String(v) as "ssn" | "ein" | "itin" | "foreign_tin" | "none") : null);
const formType = (v: unknown) => (["W-9", "W-8BEN", "W-8BEN-E"].includes(String(v)) ? (String(v) as "W-9" | "W-8BEN" | "W-8BEN-E") : null);

// The broker
export const submitBrokerTaxFormFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { isUsPerson: boolean; entityKind: "individual" | "entity"; legalName: string; address: string; country: string; tinKind?: string | null; tin?: string | null; noForeignTin?: boolean; signedName: string; certified: boolean }) => ({
    isUsPerson: !!input?.isUsPerson,
    entityKind: input?.entityKind === "individual" ? ("individual" as const) : ("entity" as const),
    legalName: text(input?.legalName, 200),
    address: text(input?.address, 500),
    country: text(input?.country, 2),
    tinKind: tinKind(input?.tinKind) === "none" ? null : (tinKind(input?.tinKind) as "ssn" | "ein" | "itin" | "foreign_tin" | null),
    tin: text(input?.tin, 40) || null,
    noForeignTin: !!input?.noForeignTin,
    signedName: text(input?.signedName, 200),
    certified: !!input?.certified,
  }))
  .handler(async ({ data, context }) => (await server()).submitBrokerTaxForm(await adminDb(), { userId: context.userId, ...data, request: await request() }));

export const getBrokerTaxFormStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => (await server()).brokerTaxFormStatus(await adminDb(), { userId: context.userId }));

// The Manager
export const getAdminBrokerForms = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => (await server()).adminBrokerForms(await adminDb(), { userId: context.userId }));

export const viewBrokerFormFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { brokerId: string }) => ({ brokerId: id(input?.brokerId, "broker") }))
  .handler(async ({ data, context }) => (await server()).adminViewBrokerForm(await adminDb(), { userId: context.userId, ...data, request: await request() }));

export const rejectBrokerFormFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { formId: string; reason: string }) => ({ formId: id(input?.formId, "form"), reason: text(input?.reason, 500) }))
  .handler(async ({ data, context }) => {
    await (await server()).rejectBrokerTaxForm(await adminDb(), { userId: context.userId, ...data, request: await request() });
    return { ok: true };
  });

export const revealBrokerTinFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { formId: string; reason: string }) => ({ formId: id(input?.formId, "form"), reason: text(input?.reason, 500) }))
  .handler(async ({ data, context }) => (await server()).revealBrokerTin(await adminDb(), { userId: context.userId, ...data }));

// The vault
export const getVaultStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => (await server()).vaultStatus(await adminDb(), { userId: context.userId }));

export const grantVaultFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { targetUserId: string; reason: string }) => ({ targetUserId: id(input?.targetUserId, "user"), reason: text(input?.reason, 500) }))
  .handler(async ({ data, context }) => {
    await (await server()).grantVaultAccess(await adminDb(), { userId: context.userId, ...data, request: await request() });
    return { ok: true };
  });

export const revokeVaultFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { targetUserId: string }) => ({ targetUserId: id(input?.targetUserId, "user") }))
  .handler(async ({ data, context }) => {
    await (await server()).revokeVaultAccess(await adminDb(), { userId: context.userId, ...data, request: await request() });
    return { ok: true };
  });

// Influencers
export const getInfluencerBoard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { year: number }) => ({ year: year(input?.year) }))
  .handler(async ({ data, context }) => (await server()).influencerBoard(await adminDb(), { userId: context.userId, ...data }));

export const saveInfluencerPayeeFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id?: string | null; name: string; formType?: string | null; address?: string | null; country?: string | null; tinKind?: string | null; tin?: string | null; signedOn?: string | null }) => ({
    id: input?.id ? id(input.id, "payee") : null,
    name: text(input?.name, 200),
    formType: formType(input?.formType),
    address: text(input?.address, 500) || null,
    country: text(input?.country, 2) || null,
    tinKind: tinKind(input?.tinKind),
    tin: text(input?.tin, 40) || null,
    signedOn: text(input?.signedOn, 10) || null,
  }))
  .handler(async ({ data, context }) => (await server()).saveInfluencerPayee(await adminDb(), { userId: context.userId, ...data, request: await request() }));

export const recordInfluencerPaymentFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { payeeId: string; amount: number | string; paidAt: string; memo?: string | null }) => ({ payeeId: id(input?.payeeId, "payee"), amount: Number(input?.amount), paidAt: text(input?.paidAt, 10), memo: text(input?.memo, 300) || null }))
  .handler(async ({ data, context }) => (await server()).recordInfluencerPayment(await adminDb(), { userId: context.userId, ...data, request: await request() }));

export const voidInfluencerPaymentFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { paymentId: string; reason: string }) => ({ paymentId: id(input?.paymentId, "payment"), reason: text(input?.reason, 500) }))
  .handler(async ({ data, context }) => {
    await (await server()).voidInfluencerPayment(await adminDb(), { userId: context.userId, ...data, request: await request() });
    return { ok: true };
  });

export const export1099NecFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { year: number }) => ({ year: year(input?.year) }))
  .handler(async ({ data, context }) => (await server()).export1099Nec(await adminDb(), { userId: context.userId, ...data, request: await request() }));

export const export1099NecWithTinsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { year: number }) => ({ year: year(input?.year) }))
  .handler(async ({ data, context }) => (await server()).export1099NecWithTins(await adminDb(), { userId: context.userId, ...data, request: await request() }));

export const revealInfluencerTinFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { payeeId: string; reason: string }) => ({ payeeId: id(input?.payeeId, "payee"), reason: text(input?.reason, 500) }))
  .handler(async ({ data, context }) => (await server()).revealInfluencerTin(await adminDb(), { userId: context.userId, ...data }));

// The Tax-Ready Folder
export const getTaxReadyFolders = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: id(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).taxReadyFolders(await adminDb(), { userId: context.userId, ...data }));

export const generateTaxReadyFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; year: number }) => ({ propertyId: id(input?.propertyId, "property"), year: year(input?.year) }))
  .handler(async ({ data, context }) => (await server()).generateTaxReadyFolder(await adminDb(), { userId: context.userId, ...data, request: await request() }));

export const downloadTaxReadyFileFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { folderId: string; file: string }) => ({ folderId: id(input?.folderId, "folder"), file: text(input?.file, 120) }))
  .handler(async ({ data, context }) => (await server()).downloadTaxReadyFile(await adminDb(), { userId: context.userId, ...data, request: await request() }));
