import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { MAINTENANCE_CATEGORIES, MAINTENANCE_NEXT, MAINTENANCE_URGENCIES, type MaintenanceStatus, type MaintenanceUrgency } from "@/lib/maintenance";

/** Callable surface for maintenance requests. */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function server() {
  return import("@/lib/maintenance.server");
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

const optionalText = (value: unknown, max: number) => {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
};

const cost = (value: unknown, label: string) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be zero or more`);
  return n;
};

export const getOwnerMaintenance = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: required(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).ownerMaintenance(await adminDb(), context.userId, data.propertyId));

export const submitMaintenanceRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; title: string; description: string; category: string; urgency: MaintenanceUrgency; photos?: string[] }) => {
    if (!MAINTENANCE_URGENCIES.includes(input?.urgency)) throw new Error("Choose an urgency");
    if (!MAINTENANCE_CATEGORIES.includes(input?.category)) throw new Error("Choose a category");
    return {
      propertyId: required(input?.propertyId, "property"),
      title: required(input?.title, "title").slice(0, 200),
      description: required(input?.description, "description").slice(0, 5000),
      category: input.category,
      urgency: input.urgency,
      photos: (input?.photos ?? []).map(String),
    };
  })
  .handler(async ({ data, context }) => (await server()).submitRequest(await adminDb(), { userId: context.userId, ...data }));

export const listMaintenanceForAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context);
    return (await server()).adminMaintenance(await adminDb());
  });

export const updateMaintenanceRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { requestId: string; status?: MaintenanceStatus | null; estimatedCost?: number | string | null; actualCost?: number | string | null; vendorName?: string | null; note?: string | null }) => {
      if (input?.status && !(input.status in MAINTENANCE_NEXT)) throw new Error("Choose a status");
      return {
        requestId: required(input?.requestId, "request"),
        status: input?.status ?? null,
        estimatedCost: cost(input?.estimatedCost, "Estimated cost"),
        actualCost: cost(input?.actualCost, "Actual cost"),
        vendorName: optionalText(input?.vendorName, 200),
        note: optionalText(input?.note, 5000),
      };
    },
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    await (await server()).updateRequest(await adminDb(), { adminId: context.userId, ...data });
    return { ok: true };
  });

export const attributeMaintenanceToLlc = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { requestId: string }) => ({ requestId: required(input?.requestId, "request") }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    await (await server()).attributeToLlc(await adminDb(), { adminId: context.userId, requestId: data.requestId });
    return { ok: true };
  });
