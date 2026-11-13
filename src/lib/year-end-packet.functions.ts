import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Callable surface for the Year-End CPA Export Packet: the Manager generates, annotates the worksheet and downloads; the CPA downloads the general files. */

type Db = Parameters<(typeof import("@/lib/year-end-packet.server"))["packetBoard"]>[0];

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}
const server = () => import("@/lib/year-end-packet.server");

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

export const getPacketBoard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: id(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).packetBoard(await adminDb(), { userId: context.userId, ...data }));

export const generatePacketFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; year: number }) => ({ propertyId: id(input?.propertyId, "property"), year: year(input?.year) }))
  .handler(async ({ data, context }) => (await server()).generatePacket(await adminDb(), { userId: context.userId, ...data, trigger: "manual", request: await request() }));

export const refreshWorksheetFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; year: number }) => ({ propertyId: id(input?.propertyId, "property"), year: year(input?.year) }))
  .handler(async ({ data, context }) => (await server()).refreshWorksheet(await adminDb(), { userId: context.userId, ...data }));

export const annotateWorksheetFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { itemId: string; note: string; status: "open" | "reviewed" }) => ({
    itemId: id(input?.itemId, "item"),
    note: String(input?.note ?? "").slice(0, 4000),
    status: input?.status === "reviewed" ? ("reviewed" as const) : ("open" as const),
  }))
  .handler(async ({ data, context }) => {
    await (await server()).annotateWorksheet(await adminDb(), { userId: context.userId, ...data });
    return { ok: true };
  });

export const downloadPacketFileFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { packetId: string; file: string }) => ({ packetId: id(input?.packetId, "packet"), file: String(input?.file ?? "").slice(0, 120) }))
  .handler(async ({ data, context }) => (await server()).downloadPacketFile(await adminDb(), { userId: context.userId, ...data, request: await request() }));

export const cpaDownloadPacketFileFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { packetId: string; file: string }) => ({ packetId: id(input?.packetId, "packet"), file: String(input?.file ?? "").slice(0, 120) }))
  .handler(async ({ data, context }) => (await import("@/lib/cpa.server")).cpaDownloadPacketFile(await adminDb() as never, { userId: context.userId, ...data }));
