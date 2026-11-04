import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { EXPENSE_CATEGORIES, isValidMoney, type PaymentKind } from "@/lib/expenses";

/** Callable surface for Expense Management and capital calls. */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function server() {
  return import("@/lib/expenses.server");
}

async function requireAdmin(context: { supabase: any; userId: string }) {
  const { data } = await context.supabase.rpc("has_role", { _user_id: context.userId, _role: "admin" });
  if (!data) throw new Error("Not authorized");
}

const required = (value: unknown, label: string, max = 500) => {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`Missing ${label}`);
  return text.slice(0, max);
};

const money = (value: unknown, label: string) => {
  const n = Number(value);
  if (!isValidMoney(n)) throw new Error(`${label} must be above zero, with at most two decimal places`);
  return Math.round(n * 100) / 100;
};

const isoDate = (value: unknown, label: string) => {
  const text = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(new Date(`${text}T00:00:00Z`).getTime())) throw new Error(`Enter a valid ${label}`);
  return text;
};

const paymentKind = (value: unknown): PaymentKind => {
  if (value !== "expense" && value !== "capital_call") throw new Error("Choose a payment");
  return value;
};

export const getOwnerExpenses = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: required(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).ownerExpenses(await adminDb(), context.userId, data.propertyId));

export const getOwnerCapitalCalls = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: required(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).ownerCapitalCalls(await adminDb(), context.userId, data.propertyId));

export const getOwnerPaymentNotice = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => ({ propertyId: required(input?.propertyId, "property") }))
  .handler(async ({ data, context }) => (await server()).ownerPaymentNotice(await adminDb(), context.userId, data.propertyId));

export const markPaymentPaid = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { kind: PaymentKind; allocationId: string }) => ({ kind: paymentKind(input?.kind), allocationId: required(input?.allocationId, "payment") }))
  .handler(async ({ data, context }) => (await server()).markPaid(await adminDb(), { userId: context.userId, ...data }));

export const listExpensesForAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context);
    return (await server()).adminExpenses(await adminDb());
  });

export const createExpenseDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; description: string; category: string; totalAmount: number | string; incurredOn: string }) => {
    if (!EXPENSE_CATEGORIES.includes(input?.category)) throw new Error("Choose a category");
    return {
      propertyId: required(input?.propertyId, "property"),
      description: required(input?.description, "description"),
      category: input.category,
      totalAmount: money(input?.totalAmount, "Total"),
      incurredOn: isoDate(input?.incurredOn, "date"),
    };
  })
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    return (await server()).createExpense(await adminDb(), { adminId: context.userId, ...data });
  });

export const postExpenseDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { expenseId: string }) => ({ expenseId: required(input?.expenseId, "expense") }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    await (await server()).postExpense(await adminDb(), { adminId: context.userId, ...data });
    return { ok: true };
  });

export const voidExpenseRecord = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { expenseId: string; reason: string }) => ({ expenseId: required(input?.expenseId, "expense"), reason: required(input?.reason, "reason", 2000) }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    await (await server()).voidExpense(await adminDb(), { adminId: context.userId, ...data });
    return { ok: true };
  });

export const confirmPaymentReceived = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { kind: PaymentKind; allocationId: string }) => ({ kind: paymentKind(input?.kind), allocationId: required(input?.allocationId, "payment") }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    await (await server()).confirmPayment(await adminDb(), { adminId: context.userId, ...data });
    return { ok: true };
  });

export const rejectPaymentMarkRecord = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { kind: PaymentKind; allocationId: string; note: string }) => ({
    kind: paymentKind(input?.kind),
    allocationId: required(input?.allocationId, "payment"),
    note: required(input?.note, "note", 2000),
  }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    await (await server()).rejectPaymentMark(await adminDb(), { adminId: context.userId, ...data });
    return { ok: true };
  });

export const createCapitalCallDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; title: string; reason: string; totalAmount: number | string; dueDate: string }) => ({
    propertyId: required(input?.propertyId, "property"),
    title: required(input?.title, "title", 200),
    reason: required(input?.reason, "reason", 2000),
    totalAmount: money(input?.totalAmount, "Total"),
    dueDate: isoDate(input?.dueDate, "due date"),
  }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    return (await server()).createCapitalCall(await adminDb(), { adminId: context.userId, ...data });
  });

export const startCapitalCallVoteFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { callId: string; closesAt: string }) => {
    const closes = new Date(String(input?.closesAt ?? ""));
    if (Number.isNaN(closes.getTime())) throw new Error("Choose when the vote closes");
    return { callId: required(input?.callId, "capital call"), closesAt: closes.toISOString() };
  })
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    await (await server()).startCapitalCallVote(await adminDb(), { adminId: context.userId, ...data });
    return { ok: true };
  });

export const issueCapitalCallFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { callId: string; dueDate: string }) => ({ callId: required(input?.callId, "capital call"), dueDate: isoDate(input?.dueDate, "due date") }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    await (await server()).issueCapitalCall(await adminDb(), { adminId: context.userId, ...data });
    return { ok: true };
  });

export const closeCapitalCallFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { callId: string }) => ({ callId: required(input?.callId, "capital call") }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    await (await server()).closeCapitalCall(await adminDb(), { adminId: context.userId, ...data });
    return { ok: true };
  });
