import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isLodgingTaxStatus, type LodgingTaxStatus } from "@/lib/str";

/** Callable surface for short-term rental: an owner keeps their own records; the Manager sees only the lodging-tax flag. */

type Db = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}
const server = () => import("@/lib/str.server");

const id = (value: unknown, label: string) => {
  const t = String(value ?? "").trim();
  if (!t) throw new Error(`Missing ${label}`);
  return t.slice(0, 64);
};
const day = (value: unknown) => String(value ?? "").trim();

export const getOwnerStr = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: id(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).ownerStrView(await adminDb(), { userId: context.userId, ...data }));

export const saveStrRecordFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { propertyId: string; id?: string | null; periodStart: string; periodEnd: string; nights: number; grossCents: number; feesCents: number; lodgingTaxStatus: LodgingTaxStatus; lodgingTaxNote?: string | null }) => {
      if (!isLodgingTaxStatus(input?.lodgingTaxStatus)) throw new Error("Choose a lodging-tax status.");
      return {
        propertyId: id(input?.propertyId, "property"),
        id: input?.id ? id(input.id, "record") : null,
        periodStart: day(input?.periodStart),
        periodEnd: day(input?.periodEnd),
        nights: Number(input?.nights),
        grossCents: Number(input?.grossCents),
        feesCents: Number(input?.feesCents),
        lodgingTaxStatus: input.lodgingTaxStatus,
        lodgingTaxNote: input?.lodgingTaxNote ? String(input.lodgingTaxNote).slice(0, 1000) : null,
      };
    },
  )
  .handler(async ({ data, context }) => (await server()).saveStrRecord(await adminDb(), { userId: context.userId, ...data }));

export const deleteStrRecordFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; id: string }) => ({ propertyId: id(input?.propertyId, "property"), id: id(input?.id, "record") }))
  .handler(async ({ data, context }) => {
    await (await server()).deleteStrRecord(await adminDb(), { userId: context.userId, ...data });
    return { ok: true };
  });

export const getLodgingTaxExposure = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: id(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).lodgingTaxExposure(await adminDb(), { userId: context.userId, ...data }));
