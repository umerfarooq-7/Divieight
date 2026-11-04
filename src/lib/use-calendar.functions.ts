import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Callable surface for the Use Calendar. */

async function adminDb() {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as never;
}

async function server() {
  return import("@/lib/use-calendar.server");
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
const wholeNumber = (value: unknown, label: string) => {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`${label} must be a whole number`);
  return n;
};

export const getOwnerCalendar = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; year?: number | null }) => ({
    propertyId: required(input?.propertyId, "property"),
    year: input?.year != null ? wholeNumber(input.year, "Year") : null,
  }))
  .handler(async ({ data, context }) => (await server()).ownerCalendar(await adminDb(), context.userId, data.propertyId, data.year));

export const selectCalendarWeek = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; year: number; weekNumber: number }) => ({
    propertyId: required(input?.propertyId, "property"),
    year: wholeNumber(input?.year, "Year"),
    weekNumber: wholeNumber(input?.weekNumber, "Week"),
  }))
  .handler(async ({ data, context }) => (await server()).selectWeek(await adminDb(), { userId: context.userId, ...data }));

export const getAdminCalendar = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: required(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    return (await server()).adminCalendar(await adminDb(), data.propertyId);
  });

export const createCalendarYearAsAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; year: number; turnHours?: number | null }) => {
    const year = wholeNumber(input?.year, "Year");
    if (year < 2020 || year > 2100) throw new Error("Enter a year between 2020 and 2100");
    const turnHours = input?.turnHours != null ? wholeNumber(input.turnHours, "Hours per turn") : null;
    if (turnHours != null && (turnHours < 1 || turnHours > 720)) throw new Error("Hours per turn must be between 1 and 720");
    return { propertyId: required(input?.propertyId, "property"), year, turnHours };
  })
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const created = await (await server()).createCalendarYear(await adminDb(), context.userId, data.propertyId, data.year, data.turnHours);
    return { id: created.id };
  });

export const setCalendarHolidays = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { yearId: string; holidayWeeks: number[] }) => ({
    yearId: required(input?.yearId, "year"),
    holidayWeeks: (input?.holidayWeeks ?? []).map((w) => wholeNumber(w, "Week")),
  }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    await (await server()).setHolidayWeeks(await adminDb(), context.userId, data.yearId, data.holidayWeeks);
    return { ok: true };
  });

export const setCalendarTurnHours = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { yearId: string; hours: number }) => ({
    yearId: required(input?.yearId, "year"),
    hours: wholeNumber(input?.hours, "Hours per turn"),
  }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    await (await server()).setTurnHours(await adminDb(), context.userId, data.yearId, data.hours);
    return { ok: true };
  });

export const openCalendarSelection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { yearId: string }) => ({ yearId: required(input?.yearId, "year") }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    await (await server()).openSelection(await adminDb(), context.userId, data.yearId);
    return { ok: true };
  });

export const overrideCalendarWeek = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { yearId: string; weekNumber: number; holderKey: string | null; reason: string }) => ({
    yearId: required(input?.yearId, "year"),
    weekNumber: wholeNumber(input?.weekNumber, "Week"),
    holderKey: input?.holderKey ? String(input.holderKey) : null,
    reason: required(input?.reason, "reason"),
  }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    await (await server()).overrideWeek(await adminDb(), { actorId: context.userId, ...data });
    return { ok: true };
  });

export const transferCalendarWeeks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { yearId: string; fromHolderKey: string; toHolderKey: string; reason: string }) => ({
    yearId: required(input?.yearId, "year"),
    fromHolderKey: required(input?.fromHolderKey, "holder to move from"),
    toHolderKey: required(input?.toHolderKey, "holder to move to"),
    reason: required(input?.reason, "reason"),
  }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    return (await server()).transferUpcomingWeeks(await adminDb(), { actorId: context.userId, ...data });
  });

export const lockCalendarYear = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { yearId: string }) => ({ yearId: required(input?.yearId, "year") }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    await (await server()).lockYear(await adminDb(), context.userId, data.yearId);
    return { ok: true };
  });
