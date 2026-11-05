/** Expense Management: the split, who sees what, payment tracking, capital call votes, overdue and the maintenance link. */
import { describe, it, expect } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import {
  capitalCallNeedsVote,
  CAPITAL_CALL_VOTE_THRESHOLD,
  CAPITAL_CALL_VOTE_TYPE,
  isValidMoney,
  splitProRata,
  toCents,
} from "@/lib/expenses";
import {
  closeCapitalCallFn,
  confirmPaymentReceived,
  createCapitalCallDraft,
  createExpenseDraft,
  getOwnerCapitalCalls,
  getOwnerExpenses,
  getOwnerPaymentNotice,
  issueCapitalCallFn,
  listExpensesForAdmin,
  markPaymentPaid,
  postExpenseDraft,
  rejectPaymentMarkRecord,
  startCapitalCallVoteFn,
  voidExpenseRecord,
} from "@/lib/expenses.functions";
import { confirmPayment, settleOverdue } from "@/lib/expenses.server";
import { attributeMaintenanceToLlc, submitMaintenanceRequest, updateMaintenanceRequest } from "@/lib/maintenance.functions";
import { castVoteBallot, getVoteForOwner, listVotesForOwner } from "@/lib/votes.functions";
import { getOwnerCalendar } from "@/lib/use-calendar.functions";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const A = IDS.property;
const B = "prop-2";
const FAR = new Date(Date.now() + 86_400_000 * 200).toISOString();
const FUTURE_DATE = FAR.slice(0, 10);
const SELLER_KEY = `seller:${IDS.seller}`;
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

type Line = { holder_key: string; share_count: number; amount: number };

const capKey = (c: any) => (c.holder_type === "retained_seller" ? `seller:${c.seller_id}` : String(c.buyer_account_id));

/** Same checks as assert_allocations_match_cap_table in expenses.sql. */
function checkLines(propertyId: string, total: number, lines: Line[]) {
  if (toCents(lines.reduce((s, l) => s + l.amount, 0)) !== toCents(total)) throw new Error("Allocations must add up to the total exactly");
  const cap = new Map<string, number>();
  for (const c of db().table("cap_table_entries").filter((r) => r.property_id === propertyId)) cap.set(capKey(c), (cap.get(capKey(c)) ?? 0) + 1);
  if (cap.size !== lines.length || lines.some((l) => cap.get(l.holder_key) !== l.share_count)) throw new Error("The cap table just changed. Reload and try again.");
}

function credit(propertyId: string, holderKey: string, amount: number) {
  const user = holderKey.startsWith("seller:") ? holderKey.slice(7) : db().table("buyer_accounts").find((b) => b.id === holderKey)!.auth_user_id;
  const rows = db().table("owner_capital_accounts");
  const row = rows.find((r) => r.property_id === propertyId && r.user_id === user);
  if (row) row.contributed_amount = Number(row.contributed_amount) + amount;
  else rows.push({ property_id: propertyId, user_id: user, contributed_amount: amount, distributions_amount: 0 });
}

/** Stand in for the Postgres functions in expenses.sql, which pglite runs for real. */
function mirrorSql() {
  const r = db().rpcResults;
  r.post_expense = (a: { _expense: string; _allocations: Line[]; _actor: string }) => {
    const e = db().table("expenses").find((x) => x.id === a._expense)!;
    if (e.status === "posted") return { applied: false };
    if (e.status !== "draft") throw new Error("A voided expense can't be posted");
    checkLines(e.property_id, e.total_amount, a._allocations);
    for (const l of a._allocations) db().table("expense_allocations").push({ id: `ea-${e.id}-${l.holder_key}`, expense_id: e.id, ...l, status: "due", paid_marked_at: null, confirmed_at: null });
    e.status = "posted";
    return { applied: true };
  };
  r.issue_capital_call = (a: { _call: string; _allocations: Line[]; _due_date: string; _vote_required: boolean }) => {
    const c = db().table("capital_calls").find((x) => x.id === a._call)!;
    if (c.status === "issued") return { applied: false };
    if (c.status !== "draft") throw new Error("A closed capital call can't be issued");
    if (a._vote_required) {
      const v = db().table("votes").find((x) => x.id === c.vote_id);
      if (!v || v.property_id !== c.property_id || v.status !== "closed" || v.result_summary?.passed !== true) throw new Error("This capital call needs a passed vote before it can be issued");
    }
    checkLines(c.property_id, c.total_amount, a._allocations);
    for (const l of a._allocations) db().table("capital_call_allocations").push({ id: `ca-${c.id}-${l.holder_key}`, capital_call_id: c.id, ...l, status: "due", paid_marked_at: null, confirmed_at: null });
    c.status = "issued";
    c.due_date = a._due_date;
    return { applied: true };
  };
  r.void_expense = (a: { _expense: string; _reason: string }) => {
    const e = db().table("expenses").find((x) => x.id === a._expense)!;
    if (e.status === "voided") return { applied: false };
    const rows = db().table("expense_allocations").filter((x) => x.expense_id === e.id);
    if (rows.some((x) => x.status === "paid" || x.paid_marked_at)) throw new Error("An owner has already paid or marked this expense paid, so it can't be voided");
    for (const x of rows) x.status = "waived";
    e.status = "voided";
    e.void_reason = a._reason;
    return { applied: true };
  };
  r.confirm_expense_payment = (a: { _allocation: string }) => {
    const x = db().table("expense_allocations").find((y) => y.id === a._allocation)!;
    if (x.status === "paid") return { applied: false };
    if (x.status !== "due" || !x.paid_marked_at) throw new Error("The owner hasn't marked this as paid");
    x.status = "paid";
    credit(db().table("expenses").find((e) => e.id === x.expense_id)!.property_id, x.holder_key, x.amount);
    return { applied: true };
  };
  r.confirm_capital_call_payment = (a: { _allocation: string }) => {
    const x = db().table("capital_call_allocations").find((y) => y.id === a._allocation)!;
    if (x.status === "confirmed") return { applied: false };
    if (x.status !== "marked_paid") throw new Error("The owner hasn't marked this as paid");
    x.status = "confirmed";
    credit(db().table("capital_calls").find((c) => c.id === x.capital_call_id)!.property_id, x.holder_key, x.amount);
    return { applied: true };
  };
  r.create_expense_from_maintenance = (a: { _request: string; _actor: string }) => {
    const m = db().table("maintenance_requests").find((x) => x.id === a._request)!;
    if (m.expense_id) return { applied: false, expense_id: m.expense_id };
    const id = `exp-m-${m.id}`;
    db().table("expenses").push({ id, property_id: m.property_id, description: `Maintenance: ${m.title}`, category: m.category, total_amount: m.actual_cost, incurred_on: FUTURE_DATE, source: "maintenance", maintenance_request_id: m.id, status: "draft", created_at: new Date().toISOString() });
    m.expense_id = id;
    m.expense_queued_at = new Date().toISOString();
    m.expense_queued_by = a._actor;
    return { applied: true, expense_id: id };
  };
}

/** A: B1 1 share, B2 2 shares, the retained seller 1 share. B: B3 alone. No Digital Keys. */
function seed() {
  seedPod(db());
  mirrorSql();
  db().seed("properties", [{ id: B, address: "77 Second St", city: "Casper", state: "WY", zip: "82601", seller_id: "seller-2" }]);
  for (const [id, at] of [
    [IDS.b1, "2026-01-01T00:00:00Z"],
    [IDS.b2, "2026-02-01T00:00:00Z"],
  ] as const) {
    const buyer = db().table("buyer_accounts").find((b) => b.id === id)!;
    buyer.priority_rank = null;
    buyer.priority_rank_timestamp = at;
  }
  const cap = (property_id: string, share_number: number, holder: Record<string, unknown>) =>
    db().seed("cap_table_entries", [{ property_id, share_number, buyer_account_id: null, seller_id: null, acquisition_date: FAR, retention_lock_expires_at: FAR, ...holder }]);
  cap(A, 1, { holder_type: "buyer_account", buyer_account_id: IDS.b1 });
  cap(A, 2, { holder_type: "buyer_account", buyer_account_id: IDS.b2 });
  cap(A, 3, { holder_type: "buyer_account", buyer_account_id: IDS.b2 });
  cap(A, 4, { holder_type: "retained_seller", seller_id: IDS.seller });
  cap(B, 1, { holder_type: "buyer_account", buyer_account_id: IDS.b3 });
}

const newExpense = async (totalAmount: number | string = 100, propertyId = A) => {
  as(USERS.admin);
  return (await createExpenseDraft({ data: { propertyId, description: "Roof repair", category: "Structure & roof", totalAmount, incurredOn: "2026-10-01" } })).id;
};
const post = (expenseId: string) => {
  as(USERS.admin);
  return postExpenseDraft({ data: { expenseId } });
};
const newCall = async (totalAmount: number | string = 4000, dueDate = FUTURE_DATE, propertyId = A) => {
  as(USERS.admin);
  return (await createCapitalCallDraft({ data: { propertyId, title: "New septic", reason: "The old one failed.", totalAmount, dueDate } })).id;
};
const issue = (callId: string, dueDate = FUTURE_DATE) => {
  as(USERS.admin);
  return issueCapitalCallFn({ data: { callId, dueDate } });
};
const expenseAlloc = (expenseId: string, key: string) => db().table("expense_allocations").find((a) => a.expense_id === expenseId && a.holder_key === key)!;
const callAlloc = (callId: string, key: string) => db().table("capital_call_allocations").find((a) => a.capital_call_id === callId && a.holder_key === key)!;
const mark = (user: string, kind: "expense" | "capital_call", allocationId: string) => {
  as(user);
  return markPaymentPaid({ data: { kind, allocationId } });
};
const confirm = (kind: "expense" | "capital_call", allocationId: string) => {
  as(USERS.admin);
  return confirmPaymentReceived({ data: { kind, allocationId } });
};
const contributed = (user: string, propertyId = A) => db().table("owner_capital_accounts").find((r) => r.property_id === propertyId && r.user_id === user)?.contributed_amount;
const makeOverdue = (callId: string) => {
  db().table("capital_calls").find((c) => c.id === callId)!.due_date = YESTERDAY;
};

describe("the pro-rata split", () => {
  const holders = [
    { holderKey: "last", shares: 1, rank: 9 },
    { holderKey: "first", shares: 1, rank: 1 },
    { holderKey: "mid", shares: 1, rank: 2 },
  ];
  const sum = (lines: Line[]) => lines.reduce((s, l) => s + toCents(l.amount), 0);

  it("three odd-cent totals add up exactly", () => {
    for (const total of [100.01, 1000.03, 33333.37]) {
      expect(sum(splitProRata(total, holders))).toBe(toCents(total));
    }
    const eight = Array.from({ length: 8 }, (_, i) => ({ holderKey: `h${i}`, shares: 1, rank: i + 1 }));
    expect(sum(splitProRata(100.07, eight))).toBe(10007);
    const mixed = [{ holderKey: "a", shares: 3, rank: 1 }, { holderKey: "b", shares: 4, rank: 2 }, { holderKey: "c", shares: 1, rank: 9 }];
    for (const total of [0.17, 19.99, 1234.57, 99999.99]) expect(sum(splitProRata(total, mixed))).toBe(toCents(total));
  });

  it("every leftover cent goes to the lowest rank number, whatever order the holders come in", () => {
    const lines = splitProRata(100.01, holders);
    expect(lines).toEqual([
      { holder_key: "first", share_count: 1, amount: 33.35 },
      { holder_key: "mid", share_count: 1, amount: 33.33 },
      { holder_key: "last", share_count: 1, amount: 33.33 },
    ]);
    expect(splitProRata(100.01, [...holders].reverse())).toEqual(lines);
    const eight = Array.from({ length: 8 }, (_, i) => ({ holderKey: `h${i}`, shares: 1, rank: 8 - i }));
    const split = splitProRata(100.07, eight);
    expect(split[0]).toEqual({ holder_key: "h7", share_count: 1, amount: 12.57 });
    expect(split.slice(1).every((l) => l.amount === 12.5)).toBe(true);
  });

  it("weights by shares", () => {
    const lines = splitProRata(800, [{ holderKey: "a", shares: 3, rank: 1 }, { holderKey: "b", shares: 5, rank: 2 }]);
    expect(lines.map((l) => l.amount)).toEqual([300, 500]);
  });

  it("refuses no shares, and an amount too small to reach everyone", () => {
    expect(() => splitProRata(100, [])).toThrow("no issued shares");
    expect(() => splitProRata(0.02, holders)).toThrow("too small");
    expect(splitProRata(0.03, holders).map((l) => l.amount)).toEqual([0.01, 0.01, 0.01]);
  });

  it("money must be above zero with at most two decimals", () => {
    expect(isValidMoney(19.99)).toBe(true);
    expect(isValidMoney(1234.57)).toBe(true);
    expect(isValidMoney(0)).toBe(false);
    expect(isValidMoney(-1)).toBe(false);
    expect(isValidMoney(1.005)).toBe(false);
    expect(isValidMoney(Number.NaN)).toBe(false);
  });
});

describe("posting expenses", () => {
  it("only an admin creates and posts, and nothing reaches owners while it's a draft", async () => {
    seed();
    as(USERS.b1);
    await expect(createExpenseDraft({ data: { propertyId: A, description: "x", category: "Other", totalAmount: 10, incurredOn: "2026-10-01" } })).rejects.toThrow("Not authorized");
    const id = await newExpense();
    as(USERS.b1);
    await expect(postExpenseDraft({ data: { expenseId: id } })).rejects.toThrow("Not authorized");
    await expect(listExpensesForAdmin()).rejects.toThrow("Not authorized");
    expect((await getOwnerExpenses({ data: { propertyId: A } })).rows).toEqual([]);
    expect(db().notificationsFor(USERS.b1).filter((n) => n.type === "expense")).toEqual([]);
  });

  it("splits on the cap table at posting time, not when the draft was made", async () => {
    seed();
    const id = await newExpense(100.01);
    db().table("cap_table_entries").find((c) => c.property_id === A && c.share_number === 4)!.seller_id = null;
    const seat = db().table("cap_table_entries").find((c) => c.property_id === A && c.share_number === 4)!;
    seat.holder_type = "buyer_account";
    seat.buyer_account_id = IDS.b2;
    await post(id);
    const rows = db().table("expense_allocations").filter((a) => a.expense_id === id);
    expect(rows.map((a) => [a.holder_key, a.share_count, a.amount])).toEqual([
      [IDS.b1, 1, 25.01],
      [IDS.b2, 3, 75],
    ]);
  });

  it("a real split: 1, 2 and 1 shares of an odd total", async () => {
    seed();
    const id = await newExpense(100.03);
    await post(id);
    expect(expenseAlloc(id, IDS.b1).amount).toBe(25.02); // the earliest holder takes the 2 leftover cents
    expect(expenseAlloc(id, IDS.b2).amount).toBe(50.01);
    expect(expenseAlloc(id, SELLER_KEY).amount).toBe(25);
    expect(toCents(expenseAlloc(id, IDS.b1).amount) + toCents(expenseAlloc(id, IDS.b2).amount) + toCents(expenseAlloc(id, SELLER_KEY).amount)).toBe(10003);
  });

  it("each owner is told their own share and nobody else's", async () => {
    seed();
    const id = await newExpense(100);
    await post(id);
    const msg = (user: string) => db().notificationsFor(user).filter((n) => n.type === "expense").map((n) => n.message).join(" ");
    expect(msg(USERS.b1)).toContain("$25.00");
    expect(msg(USERS.b1)).not.toContain("$50.00");
    expect(msg(USERS.b2)).toContain("$50.00");
    expect(msg(IDS.seller)).toContain("$25.00");
    expect(db().notificationsFor(USERS.b3).filter((n) => n.type === "expense")).toEqual([]);
  });

  it("a second post of the same expense is refused and changes nothing", async () => {
    seed();
    const id = await newExpense();
    await post(id);
    await expect(post(id)).rejects.toThrow("Only a draft");
    expect(db().table("expense_allocations").filter((a) => a.expense_id === id)).toHaveLength(3);
  });

  it("two admins posting at once: the owners are told once", async () => {
    seed();
    const id = await newExpense();
    const { postExpense } = await import("@/lib/expenses.server");
    await Promise.allSettled([postExpense(db() as never, { adminId: USERS.admin, expenseId: id }), postExpense(db() as never, { adminId: USERS.admin, expenseId: id })]);
    expect(db().table("expense_allocations").filter((a) => a.expense_id === id)).toHaveLength(3);
    expect(db().notificationsFor(USERS.b1).filter((n) => n.type === "expense")).toHaveLength(1);
  });

  it("a property with no cap table can't post", async () => {
    seed();
    db().seed("properties", [{ id: "prop-empty", address: "1 Empty", city: "X", state: "WY", zip: "1" }]);
    const id = await newExpense(100, "prop-empty");
    await expect(post(id)).rejects.toThrow("no issued shares");
    expect(db().table("expenses").find((e) => e.id === id)!.status).toBe("draft");
  });

  it("checks the amount, category and date", async () => {
    seed();
    as(USERS.admin);
    const base = { propertyId: A, description: "x", category: "Other", totalAmount: 10, incurredOn: "2026-10-01" };
    await expect(createExpenseDraft({ data: { ...base, totalAmount: 0 } })).rejects.toThrow("above zero");
    await expect(createExpenseDraft({ data: { ...base, totalAmount: 1.005 } })).rejects.toThrow("two decimal");
    await expect(createExpenseDraft({ data: { ...base, totalAmount: "abc" } })).rejects.toThrow("above zero");
    await expect(createExpenseDraft({ data: { ...base, category: "Nope" } })).rejects.toThrow("category");
    await expect(createExpenseDraft({ data: { ...base, incurredOn: "soon" } })).rejects.toThrow("valid date");
    await expect(createExpenseDraft({ data: { ...base, propertyId: "nope" } })).rejects.toThrow("Property not found");
  });
});

describe("what an owner can see", () => {
  it("the full list, their own allocation, and no other holder's amount or status", async () => {
    seed();
    const id = await newExpense(100);
    await post(id);
    await mark(USERS.b2, "expense", expenseAlloc(id, IDS.b2).id);
    as(USERS.b1);
    const { rows, allowed } = await getOwnerExpenses({ data: { propertyId: A } });
    expect(allowed).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ description: "Roof repair", totalAmount: 100, mine: { amount: 25, shareCount: 1, status: "due", paidMarkedAt: null } });
    const text = JSON.stringify(rows);
    expect(text).not.toContain(IDS.b2);
    expect(text).not.toContain(SELLER_KEY);
    expect(text).not.toContain("50");
    expect(text).not.toContain("allocations");
  });

  it("the same for capital calls", async () => {
    seed();
    const id = await newCall(4000);
    await issue(id);
    await mark(USERS.b2, "capital_call", callAlloc(id, IDS.b2).id);
    as(USERS.b1);
    const { rows } = await getOwnerCapitalCalls({ data: { propertyId: A } });
    expect(rows[0]).toMatchObject({ title: "New septic", mine: { amount: 1000, status: "due" } });
    const text = JSON.stringify(rows);
    expect(text).not.toContain(IDS.b2);
    expect(text).not.toContain("marked_paid");
  });

  it("another property's owner and a stranger get nothing", async () => {
    seed();
    const id = await newExpense();
    await post(id);
    const call = await newCall();
    await issue(call);
    for (const user of [USERS.b3, "u-nobody"]) {
      as(user);
      expect(await getOwnerExpenses({ data: { propertyId: A } })).toEqual({ allowed: false, rows: [] });
      expect(await getOwnerCapitalCalls({ data: { propertyId: A } })).toEqual({ allowed: false, rows: [] });
    }
  });

  it("only needs a cap table row: no Digital Key (Rev 48), and the retained seller counts", async () => {
    seed();
    const id = await newExpense(100);
    await post(id);
    as(IDS.seller);
    const { rows } = await getOwnerExpenses({ data: { propertyId: A } });
    expect(rows[0]!.mine).toMatchObject({ amount: 25, shareCount: 1 });
  });

  it("someone who sold after posting still sees and can settle their allocation, and only that", async () => {
    seed();
    const before = await newExpense(100);
    await post(before);
    for (const c of db().table("cap_table_entries").filter((x) => x.property_id === A && x.buyer_account_id === IDS.b1)) c.buyer_account_id = IDS.b2;
    const after = await newExpense(40);
    await post(after);
    as(USERS.b1);
    const { rows, allowed } = await getOwnerExpenses({ data: { propertyId: A } });
    expect(allowed).toBe(true);
    expect(rows.map((r) => r.id)).toEqual([before]);
    expect((await mark(USERS.b1, "expense", expenseAlloc(before, IDS.b1).id)).error).toBeUndefined();
  });

  it("a new owner sees earlier expenses with no share of them", async () => {
    seed();
    const id = await newExpense(100);
    await post(id);
    const seat = db().table("cap_table_entries").find((c) => c.property_id === A && c.share_number === 1)!;
    seat.buyer_account_id = IDS.b3;
    as(USERS.b3);
    const { rows } = await getOwnerExpenses({ data: { propertyId: A } });
    expect(rows[0]).toMatchObject({ id, mine: null });
  });
});

describe("marking paid and confirming", () => {
  it("expense: due → marked → paid, and the capital account goes up", async () => {
    seed();
    const id = await newExpense(100);
    await post(id);
    const a = expenseAlloc(id, IDS.b2);
    expect((await mark(USERS.b2, "expense", a.id)).error).toBeUndefined();
    expect(a.status).toBe("due");
    expect(a.paid_marked_at).toBeTruthy();
    expect(contributed(USERS.b2)).toBeUndefined();
    await confirm("expense", a.id);
    expect(a.status).toBe("paid");
    expect(contributed(USERS.b2)).toBe(50);
  });

  it("capital call: due → marked_paid → confirmed, and the capital account goes up", async () => {
    seed();
    const id = await newCall(4000);
    await issue(id);
    const a = callAlloc(id, SELLER_KEY);
    expect((await mark(IDS.seller, "capital_call", a.id)).error).toBeUndefined();
    expect(a.status).toBe("marked_paid");
    await confirm("capital_call", a.id);
    expect(a.status).toBe("confirmed");
    expect(contributed(IDS.seller)).toBe(1000);
  });

  it("confirming twice credits once; both kinds add to the same account", async () => {
    seed();
    const e = await newExpense(100);
    await post(e);
    const c = await newCall(4000);
    await issue(c);
    await mark(USERS.b1, "expense", expenseAlloc(e, IDS.b1).id);
    await mark(USERS.b1, "capital_call", callAlloc(c, IDS.b1).id);
    await confirm("expense", expenseAlloc(e, IDS.b1).id);
    await confirm("expense", expenseAlloc(e, IDS.b1).id);
    await confirmPayment(db() as never, { adminId: USERS.admin, kind: "expense", allocationId: expenseAlloc(e, IDS.b1).id });
    await confirm("capital_call", callAlloc(c, IDS.b1).id);
    await confirm("capital_call", callAlloc(c, IDS.b1).id);
    expect(contributed(USERS.b1)).toBe(1025);
    expect(db().notificationsFor(USERS.b1).filter((n) => /was confirmed/.test(n.message))).toHaveLength(2);
  });

  it("an admin can't confirm what the owner hasn't marked", async () => {
    seed();
    const id = await newExpense();
    await post(id);
    await expect(confirm("expense", expenseAlloc(id, IDS.b1).id)).rejects.toThrow("hasn't marked");
    expect(contributed(USERS.b1)).toBeUndefined();
  });

  it("nobody can mark another holder's allocation, even a co-owner of the same property", async () => {
    seed();
    const id = await newExpense();
    await post(id);
    const c = await newCall();
    await issue(c);
    for (const user of [USERS.b2, USERS.b3, IDS.seller, "u-nobody"]) {
      expect((await mark(user, "expense", expenseAlloc(id, IDS.b1).id)).error).toMatch(/isn't available/);
      expect((await mark(user, "capital_call", callAlloc(c, IDS.b1).id)).error).toMatch(/isn't available/);
    }
    expect(expenseAlloc(id, IDS.b1).paid_marked_at).toBeNull();
    expect(callAlloc(c, IDS.b1).status).toBe("due");
  });

  it("only an admin can confirm or reject", async () => {
    seed();
    const id = await newExpense();
    await post(id);
    const a = expenseAlloc(id, IDS.b1);
    await mark(USERS.b1, "expense", a.id);
    as(USERS.b1);
    await expect(confirmPaymentReceived({ data: { kind: "expense", allocationId: a.id } })).rejects.toThrow("Not authorized");
    await expect(rejectPaymentMarkRecord({ data: { kind: "expense", allocationId: a.id, note: "x" } })).rejects.toThrow("Not authorized");
    expect(contributed(USERS.b1)).toBeUndefined();
  });

  it("marking twice is refused; a paid one can't be marked again", async () => {
    seed();
    const id = await newExpense();
    await post(id);
    const a = expenseAlloc(id, IDS.b1);
    as(USERS.b1);
    expect((await getOwnerExpenses({ data: { propertyId: A } })).rows[0]!.mine!.canMarkPaid).toBe(true);
    await mark(USERS.b1, "expense", a.id);
    as(USERS.b1);
    expect((await getOwnerExpenses({ data: { propertyId: A } })).rows[0]!.mine!.canMarkPaid).toBe(false);
    expect((await mark(USERS.b1, "expense", a.id)).error).toMatch(/already/);
    await confirm("expense", a.id);
    expect((await mark(USERS.b1, "expense", a.id)).error).toMatch(/already/);
    expect(contributed(USERS.b1)).toBe(25);
  });

  it("'not received' sends it back with a note, and the owner can mark again", async () => {
    seed();
    const id = await newCall(4000);
    await issue(id);
    const a = callAlloc(id, IDS.b1);
    await mark(USERS.b1, "capital_call", a.id);
    as(USERS.admin);
    await expect(rejectPaymentMarkRecord({ data: { kind: "capital_call", allocationId: a.id, note: " " } })).rejects.toThrow("Missing note");
    await rejectPaymentMarkRecord({ data: { kind: "capital_call", allocationId: a.id, note: "No wire yet" } });
    expect(a.status).toBe("due");
    expect(a.paid_marked_at).toBeNull();
    expect(db().notificationsFor(USERS.b1).some((n) => /No wire yet/.test(n.message))).toBe(true);
    await expect(rejectPaymentMarkRecord({ data: { kind: "capital_call", allocationId: a.id, note: "Again" } })).rejects.toThrow("isn't waiting");
    expect((await mark(USERS.b1, "capital_call", a.id)).error).toBeUndefined();
  });

  it("'not received' on an expense clears the mark; past the due date a call goes back to overdue", async () => {
    seed();
    const e = await newExpense();
    await post(e);
    const ea = expenseAlloc(e, IDS.b1);
    await mark(USERS.b1, "expense", ea.id);
    as(USERS.admin);
    await rejectPaymentMarkRecord({ data: { kind: "expense", allocationId: ea.id, note: "Nope" } });
    expect(ea.paid_marked_at).toBeNull();
    expect(ea.status).toBe("due");

    const c = await newCall();
    await issue(c);
    const ca = callAlloc(c, IDS.b1);
    await mark(USERS.b1, "capital_call", ca.id);
    makeOverdue(c);
    as(USERS.admin);
    await rejectPaymentMarkRecord({ data: { kind: "capital_call", allocationId: ca.id, note: "Nope" } });
    expect(ca.status).toBe("overdue");
  });

  it("every step reaches the audit log", async () => {
    seed();
    const id = await newExpense();
    await post(id);
    await mark(USERS.b1, "expense", expenseAlloc(id, IDS.b1).id);
    expect(db().audits("expense.created")).toHaveLength(1);
    expect(db().audits("expense.marked_paid")).toHaveLength(1);
  });
});

describe("voiding", () => {
  it("waives what's due and tells the owners", async () => {
    seed();
    const id = await newExpense(100);
    await post(id);
    as(USERS.admin);
    await expect(voidExpenseRecord({ data: { expenseId: id, reason: " " } })).rejects.toThrow("Missing reason");
    await voidExpenseRecord({ data: { expenseId: id, reason: "Billed twice" } });
    expect(expenseAlloc(id, IDS.b1).status).toBe("waived");
    expect(db().notificationsFor(USERS.b1).some((n) => /Billed twice/.test(n.message))).toBe(true);
    expect((await mark(USERS.b1, "expense", expenseAlloc(id, IDS.b1).id)).error).toMatch(/already/);
    as(USERS.admin);
    await expect(post(id)).rejects.toThrow("Only a draft");
    await expect(voidExpenseRecord({ data: { expenseId: id, reason: "Again" } })).rejects.toThrow("already voided");
  });

  it("can't void once someone has paid or marked it", async () => {
    seed();
    const id = await newExpense(100);
    await post(id);
    await mark(USERS.b1, "expense", expenseAlloc(id, IDS.b1).id);
    as(USERS.admin);
    await expect(voidExpenseRecord({ data: { expenseId: id, reason: "Oops" } })).rejects.toThrow("already paid or marked");
    expect(db().table("expenses").find((e) => e.id === id)!.status).toBe("posted");
  });

  it("a draft voids quietly: no owner hears about it", async () => {
    seed();
    const id = await newExpense(100);
    as(USERS.admin);
    await voidExpenseRecord({ data: { expenseId: id, reason: "Typed wrong" } });
    expect(db().notificationsFor(USERS.b1).filter((n) => n.type === "expense")).toEqual([]);
  });
});

describe("capital call votes", () => {
  const above = CAPITAL_CALL_VOTE_THRESHOLD + 0.01;
  const openVote = async (callId: string) => {
    as(USERS.admin);
    await startCapitalCallVoteFn({ data: { callId, closesAt: FAR } });
    return db().table("capital_calls").find((c) => c.id === callId)!.vote_id as string;
  };
  const closeWith = (voteId: string, passed: boolean) => {
    const v = db().table("votes").find((x) => x.id === voteId)!;
    v.status = "closed";
    v.result_summary = { passed };
  };

  it("the threshold is strictly above, in whole cents", () => {
    expect(capitalCallNeedsVote(CAPITAL_CALL_VOTE_THRESHOLD)).toBe(false);
    expect(capitalCallNeedsVote(above)).toBe(true);
  });

  it("at the threshold issues with no vote", async () => {
    seed();
    const id = await newCall(CAPITAL_CALL_VOTE_THRESHOLD);
    await issue(id);
    expect(db().table("capital_calls").find((c) => c.id === id)!.status).toBe("issued");
  });

  it("above the threshold can't be issued without a vote, or with a vote still open, failed or cancelled", async () => {
    seed();
    const id = await newCall(above);
    await expect(issue(id)).rejects.toThrow("passed vote");
    const vote = await openVote(id);
    await expect(issue(id)).rejects.toThrow("passed vote");
    closeWith(vote, false);
    await expect(issue(id)).rejects.toThrow("passed vote");
    db().table("votes").find((x) => x.id === vote)!.status = "cancelled";
    await expect(issue(id)).rejects.toThrow("passed vote");
    expect(db().table("capital_calls").find((c) => c.id === id)!.status).toBe("draft");
    expect(db().table("capital_call_allocations")).toEqual([]);
  });

  it("a passed vote lets it through, and each owner hears their own share", async () => {
    seed();
    const id = await newCall(above);
    closeWith(await openVote(id), true);
    await issue(id);
    expect(db().table("capital_calls").find((c) => c.id === id)!.status).toBe("issued");
    expect(toCents(db().table("capital_call_allocations").filter((a) => a.capital_call_id === id).reduce((s, a) => s + a.amount, 0))).toBe(toCents(above));
    expect(db().notificationsFor(USERS.b2).some((n) => n.type === "capital_call_alert" && /Your share/.test(n.message))).toBe(true);
    for (const user of [USERS.b1, USERS.b2, IDS.seller]) {
      const issued = db().notificationsFor(user).filter((n) => n.type === "capital_call_alert");
      expect(issued).toHaveLength(1);
      expect(issued[0]!.property_id).toBe(A);
    }
    expect(db().notificationsFor(USERS.b3).filter((n) => n.type === "capital_call_alert")).toEqual([]);
  });

  it("a real vote, cast by the owners, passes and closes on its own past its time", async () => {
    seed();
    const id = await newCall(above);
    const voteId = await openVote(id);
    const vote = db().table("votes").find((v) => v.id === voteId)!;
    expect(vote).toMatchObject({ property_id: A, vote_type: CAPITAL_CALL_VOTE_TYPE, status: "open" });
    expect(vote.title).toContain("$10,000.01");
    for (const user of [USERS.b1, USERS.b2, IDS.seller]) {
      as(user);
      await castVoteBallot({ data: { propertyId: A, voteId, choice: "Yes" } });
    }
    // B1 has two members who must agree first; B2 + seller is 3 of 4, which is 75%.
    vote.closes_at = new Date(Date.now() - 1000).toISOString();
    await issue(id);
    expect(db().table("votes").find((v) => v.id === voteId)!.status).toBe("closed");
    expect(db().table("capital_calls").find((c) => c.id === id)!.status).toBe("issued");
  });

  it("a vote that's going nowhere closes, fails, and a new one can be opened", async () => {
    seed();
    const id = await newCall(above);
    const first = await openVote(id);
    as(USERS.admin);
    await expect(startCapitalCallVoteFn({ data: { callId: id, closesAt: FAR } })).rejects.toThrow("already running");
    db().table("votes").find((v) => v.id === first)!.closes_at = new Date(Date.now() - 1000).toISOString();
    await expect(issue(id)).rejects.toThrow("passed vote");
    const second = await openVote(id);
    expect(second).not.toBe(first);
    closeWith(second, true);
    as(USERS.admin);
    await expect(startCapitalCallVoteFn({ data: { callId: id, closesAt: FAR } })).rejects.toThrow("already approved");
    await issue(id);
  });

  it("a vote isn't offered under the threshold, or for a call already issued, or with a past close", async () => {
    seed();
    const small = await newCall(100);
    as(USERS.admin);
    await expect(startCapitalCallVoteFn({ data: { callId: small, closesAt: FAR } })).rejects.toThrow("doesn't need");
    const big = await newCall(above);
    await expect(startCapitalCallVoteFn({ data: { callId: big, closesAt: new Date(Date.now() - 1000).toISOString() } })).rejects.toThrow("future");
    expect(db().table("votes")).toEqual([]);
    await issue(small);
    as(USERS.admin);
    await expect(startCapitalCallVoteFn({ data: { callId: small, closesAt: FAR } })).rejects.toThrow("Only a draft");
  });

  it("the admin page says what's allowed next", async () => {
    seed();
    const id = await newCall(above);
    as(USERS.admin);
    const row = async () => (await listExpensesForAdmin()).calls.find((c) => c.id === id)!;
    expect(await row()).toMatchObject({ needsVote: true, canStartVote: true, canIssue: false, vote: null });
    const vote = await openVote(id);
    expect(await row()).toMatchObject({ canStartVote: false, canIssue: false, vote: { status: "open" } });
    closeWith(vote, false);
    expect(await row()).toMatchObject({ canStartVote: true, canIssue: false, vote: { passed: false } });
    const next = await openVote(id);
    closeWith(next, true);
    expect(await row()).toMatchObject({ canStartVote: false, canIssue: true, vote: { passed: true } });
  });

  it("only an admin issues or opens the vote; a past due date is refused; drafts stay hidden", async () => {
    seed();
    const id = await newCall(100);
    as(USERS.b1);
    await expect(issueCapitalCallFn({ data: { callId: id, dueDate: FUTURE_DATE } })).rejects.toThrow("Not authorized");
    await expect(startCapitalCallVoteFn({ data: { callId: id, closesAt: FAR } })).rejects.toThrow("Not authorized");
    expect((await getOwnerCapitalCalls({ data: { propertyId: A } })).rows).toEqual([]);
    await expect(issue(id, YESTERDAY)).rejects.toThrow("past");
    await expect(newCall(100, YESTERDAY)).rejects.toThrow("past");
  });

  it("today is a fine due date: only a day already gone is refused", async () => {
    seed();
    const today = new Date().toISOString().slice(0, 10);
    const id = await newCall(100, today);
    await issue(id, today);
    expect(db().table("capital_calls").find((c) => c.id === id)!.status).toBe("issued");
  });

  it("a due date can be moved at issue, for a vote that ran long", async () => {
    seed();
    const id = await newCall(100);
    await issue(id, "2099-01-31");
    expect(db().table("capital_calls").find((c) => c.id === id)!.due_date).toBe("2099-01-31");
  });

  it("closing: a draft is discarded; an issued call stops chasing; late payments still count", async () => {
    seed();
    const draft = await newCall(100);
    as(USERS.admin);
    await closeCapitalCallFn({ data: { callId: draft } });
    await expect(issue(draft)).rejects.toThrow("Only a draft");
    const id = await newCall(4000);
    await issue(id);
    await closeCapitalCallFn({ data: { callId: id } });
    await expect(closeCapitalCallFn({ data: { callId: id } })).rejects.toThrow("already closed");
    makeOverdue(id);
    await settleOverdue(db() as never);
    expect(callAlloc(id, IDS.b1).status).toBe("due");
    await mark(USERS.b1, "capital_call", callAlloc(id, IDS.b1).id);
    await confirm("capital_call", callAlloc(id, IDS.b1).id);
    expect(contributed(USERS.b1)).toBe(1000);
  });
});

describe("overdue", () => {
  it("the sweep flips due to overdue once, and notifies once", async () => {
    seed();
    const id = await newCall(4000);
    await issue(id);
    makeOverdue(id);
    expect(await settleOverdue(db() as never)).toEqual({ overdue: 3 });
    expect(await settleOverdue(db() as never)).toEqual({ overdue: 0 });
    expect(callAlloc(id, IDS.b1).status).toBe("overdue");
    expect(db().notificationsFor(USERS.b1).filter((n) => /overdue/.test(n.message))).toHaveLength(1);
  });

  it("two sweeps at once tell the owner once", async () => {
    seed();
    const id = await newCall(4000);
    await issue(id);
    makeOverdue(id);
    await Promise.all([settleOverdue(db() as never), settleOverdue(db() as never)]);
    expect(db().notificationsFor(USERS.b1).filter((n) => /overdue/.test(n.message))).toHaveLength(1);
    expect(db().audits("capital_call.overdue")).toHaveLength(3);
  });

  it("isn't overdue on the due date itself, or after being marked or confirmed", async () => {
    seed();
    const id = await newCall(4000);
    await issue(id);
    db().table("capital_calls").find((c) => c.id === id)!.due_date = new Date().toISOString().slice(0, 10);
    expect(await settleOverdue(db() as never)).toEqual({ overdue: 0 });
    await mark(USERS.b1, "capital_call", callAlloc(id, IDS.b1).id);
    await mark(USERS.b2, "capital_call", callAlloc(id, IDS.b2).id);
    await confirm("capital_call", callAlloc(id, IDS.b2).id);
    makeOverdue(id);
    await settleOverdue(db() as never);
    expect(callAlloc(id, IDS.b1).status).toBe("marked_paid");
    expect(callAlloc(id, IDS.b2).status).toBe("confirmed");
    expect(callAlloc(id, SELLER_KEY).status).toBe("overdue");
  });

  it("looking at the page catches it even if the sweep hasn't run; the notice shows only your own", async () => {
    seed();
    const id = await newCall(4000);
    await issue(id);
    makeOverdue(id);
    await mark(USERS.b2, "capital_call", callAlloc(id, IDS.b2).id);
    as(USERS.b1);
    expect(await getOwnerPaymentNotice({ data: { propertyId: A } })).toEqual({ overdueCount: 1, overdueAmount: 1000 });
    expect((await getOwnerCapitalCalls({ data: { propertyId: A } })).rows[0]!.mine).toMatchObject({ status: "overdue", canMarkPaid: true });
    as(USERS.b2);
    expect(await getOwnerPaymentNotice({ data: { propertyId: A } })).toEqual({ overdueCount: 0, overdueAmount: 0 });
  });

  it("an overdue owner can still mark paid", async () => {
    seed();
    const id = await newCall(4000);
    await issue(id);
    makeOverdue(id);
    await settleOverdue(db() as never);
    expect((await mark(USERS.b1, "capital_call", callAlloc(id, IDS.b1).id)).error).toBeUndefined();
    expect(callAlloc(id, IDS.b1).status).toBe("marked_paid");
  });

  it("overdue hides nothing: votes and the calendar stay open and ballots still count (Rev 48)", async () => {
    seed();
    const id = await newCall(4000);
    await issue(id);
    makeOverdue(id);
    await settleOverdue(db() as never);
    expect(callAlloc(id, SELLER_KEY).status).toBe("overdue");

    db().seed("votes", [{ id: "vote-o", property_id: A, title: "Paint", description: null, vote_type: "ordinary", options: ["Yes", "No", "Abstain"], opens_at: new Date(Date.now() - 1000).toISOString(), closes_at: FAR, status: "open", result_summary: null }]);
    for (const user of [IDS.seller, USERS.b2]) {
      as(user);
      expect((await listVotesForOwner({ data: { propertyId: A } })).allowed).toBe(true);
      expect((await getVoteForOwner({ data: { propertyId: A, voteId: "vote-o" } }))?.canCast).toBe(true);
      expect((await castVoteBallot({ data: { propertyId: A, voteId: "vote-o", choice: "Yes" } })).error).toBeUndefined();
      expect((await getOwnerCalendar({ data: { propertyId: A } })).allowed).toBe(true);
      expect((await getOwnerExpenses({ data: { propertyId: A } })).allowed).toBe(true);
    }
    expect(db().table("vote_ballots").filter((b) => b.vote_id === "vote-o")).toHaveLength(2);
  });
});

describe("the maintenance link", () => {
  const completed = async (actualCost: number) => {
    as(USERS.b1);
    const { id } = await submitMaintenanceRequest({ data: { propertyId: A, title: "Leak", description: "Drip", category: "Plumbing", urgency: "normal" } as never });
    as(USERS.admin);
    for (const status of ["triaged", "approved", "completed"]) await updateMaintenanceRequest({ data: { requestId: id!, status, actualCost: status === "completed" ? actualCost : null } as never });
    return id!;
  };

  it("Attribute to LLC makes one linked draft; the admin posts it and it splits like any expense", async () => {
    seed();
    const id = await completed(450.03);
    as(USERS.admin);
    await attributeMaintenanceToLlc({ data: { requestId: id } });
    const request = db().table("maintenance_requests").find((r) => r.id === id)!;
    const expense = db().table("expenses").find((e) => e.id === request.expense_id)!;
    expect(expense).toMatchObject({ source: "maintenance", maintenance_request_id: id, status: "draft", total_amount: 450.03, property_id: A });
    await expect(attributeMaintenanceToLlc({ data: { requestId: id } })).rejects.toThrow("already queued");
    expect(db().table("expenses")).toHaveLength(1);

    as(USERS.b1);
    expect((await getOwnerExpenses({ data: { propertyId: A } })).rows).toEqual([]);
    await post(expense.id);
    as(USERS.b1);
    expect((await getOwnerExpenses({ data: { propertyId: A } })).rows[0]).toMatchObject({ fromMaintenance: true, totalAmount: 450.03, mine: { amount: 112.52 } });
  });
});
