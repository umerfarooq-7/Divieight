import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { RofrPosition } from "@/lib/resale";

/** Callable surface for the Resale Shop. */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function server() {
  return import("@/lib/resale.server");
}

const required = (value: unknown, label: string) => {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`Missing ${label}`);
  return text;
};

const listingInput = (input: { propertyId: string; listingId: string }) => ({
  propertyId: required(input?.propertyId, "property"),
  listingId: required(input?.listingId, "listing"),
});

export const getOwnerResale = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: required(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).ownerResale(await adminDb(), context.userId, data.propertyId));

export const createResaleListing = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; shareNumber: number; askingPrice: number; feeAcknowledged: boolean }) => {
    const shareNumber = Number(input?.shareNumber);
    if (!Number.isInteger(shareNumber)) throw new Error("Choose a share");
    return {
      propertyId: required(input?.propertyId, "property"),
      shareNumber,
      askingPrice: Number(input?.askingPrice),
      feeAcknowledged: input?.feeAcknowledged === true,
    };
  })
  .handler(async ({ data, context }) => (await server()).createListing(await adminDb(), { userId: context.userId, ...data }));

export const withdrawResaleListing = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listingInput)
  .handler(async ({ data, context }) => (await server()).withdrawListing(await adminDb(), { userId: context.userId, ...data }));

export const recordResalePosition = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; listingId: string; accountMemberId: string; position: RofrPosition; initials: string }) => {
    if (input?.position !== "exercise" && input?.position !== "decline") throw new Error("Choose exercise or decline");
    return {
      ...listingInput(input),
      accountMemberId: required(input?.accountMemberId, "member"),
      position: input.position,
      initials: String(input?.initials ?? ""),
    };
  })
  .handler(async ({ data, context }) => (await server()).recordRofrPosition(await adminDb(), { userId: context.userId, ...data }));

export const exerciseResaleRofr = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listingInput)
  .handler(async ({ data, context }) => (await server()).exerciseRofr(await adminDb(), { userId: context.userId, ...data }));

export const withdrawResaleElection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listingInput)
  .handler(async ({ data, context }) => (await server()).withdrawElection(await adminDb(), { userId: context.userId, ...data }));

export const confirmResaleOffer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listingInput)
  .handler(async ({ data, context }) => (await server()).confirmOffer(await adminDb(), { userId: context.userId, ...data }));

export const declineResaleOffer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listingInput)
  .handler(async ({ data, context }) => (await server()).declineOffer(await adminDb(), { userId: context.userId, ...data }));

export const getFormerSellerWeeks = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: required(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).formerSellerWeeks(await adminDb(), context.userId, data.propertyId));

export const listOpenMarketResale = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => (await server()).openMarketListings(await adminDb(), context.userId));

export const expressResaleInterest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { listingId: string }) => ({ listingId: required(input?.listingId, "listing") }))
  .handler(async ({ data, context }) => (await server()).expressInterest(await adminDb(), { userId: context.userId, ...data }));

async function requireAdmin(context: { supabase: any; userId: string }) {
  const { data } = await context.supabase.rpc("has_role", { _user_id: context.userId, _role: "admin" });
  if (!data) throw new Error("Not authorized");
}

export const listResaleForAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context);
    return (await server()).adminResale(await adminDb());
  });

export const completeResaleSale = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { transactionId: string }) => ({ transactionId: required(input?.transactionId, "sale") }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    return (await server()).completeSale(await adminDb(), context.userId, data.transactionId);
  });

export const convertResaleInterest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { listingId: string; buyerAccountId: string }) => ({ listingId: required(input?.listingId, "listing"), buyerAccountId: required(input?.buyerAccountId, "buyer") }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    return (await server()).convertInterestToSale(await adminDb(), { adminId: context.userId, ...data });
  });

export const cancelResaleSale = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { transactionId: string; reason: string }) => ({
    transactionId: required(input?.transactionId, "sale"),
    reason: required(input?.reason, "reason").slice(0, 2000),
  }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    await (await server()).cancelSale(await adminDb(), { adminId: context.userId, ...data });
    return { ok: true };
  });
