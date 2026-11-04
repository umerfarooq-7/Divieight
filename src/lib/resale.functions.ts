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

export const listOpenMarketResale = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => (await server()).openMarketListings(await adminDb(), context.userId));

export const expressResaleInterest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { listingId: string }) => ({ listingId: required(input?.listingId, "listing") }))
  .handler(async ({ data, context }) => (await server()).expressInterest(await adminDb(), { userId: context.userId, ...data }));

export const listResaleForAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await (context.supabase as any).rpc("has_role", { _user_id: context.userId, _role: "admin" });
    if (!data) throw new Error("Not authorized");
    return (await server()).adminResale(await adminDb());
  });
