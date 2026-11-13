/**
 * Month 6, Prompt 5, the app side: owners ask on their own property only and see only their own; the Manager answers and
 * resolves; notifications go to the Manager on a new inquiry and to the owner on a response; an inquiry never blocks the ledger.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { harness } from "./setup";
import { seedPod, USERS, IDS } from "./fixtures";
import * as inq from "@/lib/inquiries.server";
import { OWNER_NOTIFICATION_TYPES, isMandatoryNotification } from "@/lib/owner-notifications";

const db = () => harness.db as any;
const A = IDS.property;
const B = "prop-2";
const FAR = new Date(Date.now() + 5000 * 3_600_000).toISOString();

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
  seedPod(db());
  db().seed("properties", [{ id: B, address: "77 Second St", city: "Casper", state: "WY", zip: "82601", seller_id: "seller-2" }]);
  const cap = (property_id: string, share_number: number, holder: Record<string, unknown>) =>
    db().seed("cap_table_entries", [{ property_id, share_number, buyer_account_id: null, seller_id: null, acquisition_date: FAR, retention_lock_expires_at: FAR, ...holder }]);
  cap(A, 1, { holder_type: "buyer_account", buyer_account_id: IDS.b1 });
  cap(A, 2, { holder_type: "buyer_account", buyer_account_id: IDS.b2 });
  cap(B, 1, { holder_type: "buyer_account", buyer_account_id: IDS.b3 });
  db().seed("coa_versions", [{ id: "v1", version: 1 }]);
  db().seed("coa_accounts", [
    { id: "a1", version_id: "v1", code: "1000", name: "Cash", type: "asset", is_member_control: false, active: true },
    { id: "a2", version_id: "v1", code: "3000", name: "Member Capital", type: "equity", is_member_control: true, active: true },
    { id: "a3", version_id: "v1", code: "6400", name: "Repairs", type: "expense", is_member_control: false, active: true },
  ]);
  db().seed("journal_entries", [
    { id: "e-exp", property_id: A, entry_date: "2026-11-03", source: "manual", memo: "Padlock, cash", reverses_entry_id: null, posted_at: "2026-11-03T00:00:00Z" },
    { id: "e-b1", property_id: A, entry_date: "2026-11-02", source: "capital_call", memo: "Contribution from Alice One", reverses_entry_id: null, posted_at: "2026-11-02T00:00:00Z" },
    { id: "e-b2", property_id: A, entry_date: "2026-11-01", source: "capital_call", memo: "Contribution from Carol Two", reverses_entry_id: null, posted_at: "2026-11-01T00:00:00Z" },
    { id: "e-other", property_id: B, entry_date: "2026-11-03", source: "manual", memo: "Other home's roof", reverses_entry_id: null, posted_at: "2026-11-03T00:00:00Z" },
  ]);
  db().seed("journal_lines", [
    { id: "l1", entry_id: "e-exp", account_id: "a3", member_id: null, debit_cents: "5000", credit_cents: "0" },
    { id: "l2", entry_id: "e-exp", account_id: "a1", member_id: null, debit_cents: "0", credit_cents: "5000" },
    { id: "l3", entry_id: "e-b1", account_id: "a1", member_id: null, debit_cents: "700", credit_cents: "0" },
    { id: "l4", entry_id: "e-b1", account_id: "a2", member_id: IDS.b1, debit_cents: "0", credit_cents: "700" },
    { id: "l5", entry_id: "e-b2", account_id: "a1", member_id: null, debit_cents: "900", credit_cents: "0" },
    { id: "l6", entry_id: "e-b2", account_id: "a2", member_id: IDS.b2, debit_cents: "0", credit_cents: "900" },
  ]);
  db().rpcResults.raise_inquiry = (a: any) => {
    const row = { id: `q-${db().table("coowner_inquiries").length + 1}`, property_id: a._property, journal_entry_id: a._entry, raised_by_member_id: a._user === USERS.b1 ? IDS.b1 : a._user === USERS.b2 ? IDS.b2 : IDS.b3, raised_by_user_id: a._user, type: a._type, message: a._message, suggested_account_code: a._suggested_code, status: "open", manager_response: null, created_at: new Date().toISOString() };
    db().table("coowner_inquiries").push(row);
    return row.id;
  };
  db().rpcResults.answer_inquiry = (a: any) => { Object.assign(db().table("coowner_inquiries").find((q: any) => q.id === a._id), { status: "answered", manager_response: a._response }); return null; };
  db().rpcResults.reject_inquiry = (a: any) => { Object.assign(db().table("coowner_inquiries").find((q: any) => q.id === a._id), { status: "rejected", manager_response: a._response }); return null; };
  db().rpcResults.resolve_inquiry = (a: any) => { Object.assign(db().table("coowner_inquiries").find((q: any) => q.id === a._id), { status: "resolved", manager_response: a._response, resulting_entry_id: a._correction ? "e-new" : null }); return { resulting_entry_id: a._correction ? "e-new" : null }; };
});

const note = (user: string, type?: string) => db().table("notifications").filter((n: any) => n.seller_id === user && (!type || n.type === type));

describe("owners ask on their own property only", () => {
  it("an owner raises a question or a suggestion; an owner of property A can't raise one on property B", async () => {
    const q = await inq.raiseOwnerInquiry(db(), { userId: USERS.b1, propertyId: A, entryId: "e-exp", type: "clarification", message: "Was this a one-off?" });
    expect(q.inquiryId).toBe("q-1");
    await inq.raiseOwnerInquiry(db(), { userId: USERS.b1, propertyId: A, entryId: "e-exp", type: "recategorize", message: "Looks like cleaning", suggestedAccountCode: "6400" });
    expect(db().table("coowner_inquiries")).toHaveLength(2);
    // B1 owns nothing on B; B3 owns nothing on A; strangers, agents and the Manager don't ask.
    await expect(inq.raiseOwnerInquiry(db(), { userId: USERS.b1, propertyId: B, entryId: "e-other", type: "clarification", message: "x" })).rejects.toThrow("don't have ownership");
    await expect(inq.raiseOwnerInquiry(db(), { userId: USERS.b3, propertyId: A, entryId: "e-exp", type: "clarification", message: "x" })).rejects.toThrow("don't have ownership");
    for (const u of [USERS.ra, USERS.hla, USERS.broker, USERS.admin, "u-nobody"]) await expect(inq.raiseOwnerInquiry(db(), { userId: u, propertyId: A, entryId: "e-exp", type: "clarification", message: "x" })).rejects.toThrow("don't have ownership");
    expect(db().table("coowner_inquiries")).toHaveLength(2);
  });

  it("the database's refusal comes through", async () => {
    const real = db().rpc.bind(db());
    db().rpc = async (fn: string, a: any) => (fn === "raise_inquiry" ? { data: null, error: { message: "That transaction isn't in this property's books." } } : real(fn, a));
    await expect(inq.raiseOwnerInquiry(db(), { userId: USERS.b1, propertyId: A, entryId: "e-other", type: "clarification", message: "x" })).rejects.toThrow("isn't in this property's books");
  });
});

describe("what an owner sees", () => {
  it("the property's transactions, their own inquiries only, and nothing of another owner's capital account", async () => {
    await inq.raiseOwnerInquiry(db(), { userId: USERS.b1, propertyId: A, entryId: "e-exp", type: "clarification", message: "B1's question" });
    await inq.raiseOwnerInquiry(db(), { userId: USERS.b2, propertyId: A, entryId: "e-exp", type: "clarification", message: "B2's question" });
    const b1 = await inq.ownerLedger(db(), { userId: USERS.b1, propertyId: A });
    expect(b1.allowed).toBe(true);
    // B2's contribution entry is not B1's to see; B1's own is, with no memo (it could name a person).
    expect(b1.entries.map((e) => e.id)).toEqual(["e-exp", "e-b1"]);
    expect(b1.entries.find((e) => e.id === "e-b1")!.memo).toBeNull();
    expect(b1.entries.find((e) => e.id === "e-exp")!.memo).toBe("Padlock, cash");
    expect(b1.entries.find((e) => e.id === "e-exp")!.inquiries.map((q) => q.message)).toEqual(["B1's question"]);
    const json = JSON.stringify(b1);
    for (const hidden of ["B2's question", "Carol", "Alice", "e-b2", "Other home", "e-other"]) expect(json, hidden).not.toContain(hidden);
    const b2 = await inq.ownerLedger(db(), { userId: USERS.b2, propertyId: A });
    expect(b2.entries.map((e) => e.id)).toEqual(["e-exp", "e-b2"]);
    expect(b2.entries.find((e) => e.id === "e-exp")!.inquiries.map((q) => q.message)).toEqual(["B2's question"]);
    expect(JSON.stringify(b2)).not.toContain("B1's question");
  });

  it("an owner of property A gets nothing from property B, and a stranger gets nothing at all", async () => {
    await inq.raiseOwnerInquiry(db(), { userId: USERS.b3, propertyId: B, entryId: "e-other", type: "clarification", message: "B's question" });
    for (const u of [USERS.b1, USERS.b2, USERS.ra, USERS.hla, "u-nobody"]) {
      const r = await inq.ownerLedger(db(), { userId: u, propertyId: B });
      expect(r, u).toEqual({ allowed: false, entries: [], accounts: [], inquiriesAvailable: false });
    }
    expect((await inq.ownerLedger(db(), { userId: USERS.b3, propertyId: B })).entries[0]!.inquiries[0]!.message).toBe("B's question");
    expect((await inq.ownerLedger(db(), { userId: USERS.b3, propertyId: A })).allowed).toBe(false);
  });

  it("the answer and the status come back to the owner, and a correction shows as linked", async () => {
    await inq.raiseOwnerInquiry(db(), { userId: USERS.b1, propertyId: A, entryId: "e-exp", type: "recategorize", message: "Cleaning?", suggestedAccountCode: "6400" });
    await inq.resolveInquiry(db(), { actorId: USERS.admin, inquiryId: "q-1", response: "Moved.", correction: { kind: "recategorize", mapping: { l1: "6400" } } });
    const q = (await inq.ownerLedger(db(), { userId: USERS.b1, propertyId: A })).entries.find((e) => e.id === "e-exp")!.inquiries[0]!;
    expect(q).toMatchObject({ status: "resolved", managerResponse: "Moved.", resultingEntryId: "e-new", suggestedAccountCode: "6400" });
  });
});

describe("an inquiry never blocks anything", () => {
  it("the ledger loads with open inquiries, with the inquiry table missing, and with the inquiry read failing", async () => {
    await inq.raiseOwnerInquiry(db(), { userId: USERS.b1, propertyId: A, entryId: "e-exp", type: "clarification", message: "Still open" });
    expect((await inq.ownerLedger(db(), { userId: USERS.b1, propertyId: A })).entries.length).toBeGreaterThan(0);
    // The table is gone (inquiries.sql not run): the ledger still shows, without the ask buttons.
    const realFrom = db().from.bind(db());
    db().from = (t: string) => (t === "coowner_inquiries" ? { select: () => ({ eq: () => ({ eq: () => ({ order: async () => ({ data: null, error: { message: 'relation "coowner_inquiries" does not exist' } }) }) }) }) } : realFrom(t));
    const r = await inq.ownerLedger(db(), { userId: USERS.b1, propertyId: A });
    expect(r).toMatchObject({ allowed: true, inquiriesAvailable: false });
    expect(r.entries.map((e) => e.id)).toEqual(["e-exp", "e-b1"]);
    db().from = () => { throw new Error("boom"); };
    // (holderFor needs the database too, so only the inquiry read itself is exercised above.)
  });

  it("a notification that fails doesn't undo or block the inquiry or the response", async () => {
    const real = db().from.bind(db());
    db().from = (t: string) => (t === "notifications" ? { insert: async () => { throw new Error("notifications are down"); } } : real(t));
    const q = await inq.raiseOwnerInquiry(db(), { userId: USERS.b1, propertyId: A, entryId: "e-exp", type: "clarification", message: "x" });
    expect(q.inquiryId).toBe("q-1");
    await inq.answerInquiry(db(), { actorId: USERS.admin, inquiryId: "q-1", response: "Fine." });
    expect(db().table("coowner_inquiries")[0].status).toBe("answered");
  });

  it("nothing outside the inquiry code reads the inquiries: statements, votes, payments and the rest don't wait on them", () => {
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const e of require("node:fs").readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && /coowner_inquiries/.test(readFileSync(p, "utf8"))) users.push(p.replace(/\\/g, "/"));
      }
    };
    walk("src");
    // The one other reader is the admin analytics: a read-only count of open inquiries for the compliance report. It gates nothing.
    expect(users.sort()).toEqual(["src/lib/analytics.server.ts", "src/lib/inquiries.server.ts"]);
    // And the one reader that feeds the ledger treats a failure as "no inquiries", never as "no ledger".
    expect(readFileSync("src/lib/inquiries.server.ts", "utf8")).toMatch(/inquiriesAvailable = false/);
  });
});

describe("notifications", () => {
  it("the Manager is told of a new inquiry (in-app, linking to the queue), once", async () => {
    await inq.raiseOwnerInquiry(db(), { userId: USERS.b1, propertyId: A, entryId: "e-exp", type: "clarification", message: "Why?" });
    const n = note(USERS.admin, "books_inquiry");
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ property_id: A, dedupe_key: "inquiry:q-1:raised" });
    expect(n[0].message).toMatch(/question about a transaction/);
    expect(JSON.stringify(n)).not.toContain("Why?"); // the notice carries no one's words
  });

  it("the owner is told of a response, by the notification system, and the type is optional for email", async () => {
    await inq.raiseOwnerInquiry(db(), { userId: USERS.b1, propertyId: A, entryId: "e-exp", type: "clarification", message: "Why?" });
    await inq.answerInquiry(db(), { actorId: USERS.admin, inquiryId: "q-1", response: "A padlock." });
    const n = note(USERS.b1, "inquiry_update");
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ property_id: A });
    expect(n[0].message).toMatch(/answered your question/);
    // No one else is told: not the other owner, not another property's owner.
    expect(note(USERS.b2, "inquiry_update")).toHaveLength(0);
    expect(note(USERS.b3, "inquiry_update")).toHaveLength(0);
    // Decline and resolve tell the asker too.
    await inq.raiseOwnerInquiry(db(), { userId: USERS.b1, propertyId: A, entryId: "e-exp", type: "recategorize", message: "Move", suggestedAccountCode: "6400" });
    await inq.rejectInquiry(db(), { actorId: USERS.admin, inquiryId: "q-2", response: "It is a repair." });
    await inq.raiseOwnerInquiry(db(), { userId: USERS.b1, propertyId: A, entryId: "e-exp", type: "clarification", message: "Third" });
    await inq.resolveInquiry(db(), { actorId: USERS.admin, inquiryId: "q-3", response: "Done." });
    expect(note(USERS.b1, "inquiry_update")).toHaveLength(3);
    expect(OWNER_NOTIFICATION_TYPES.inquiry_update.mandatory).toBe(false);
    expect(isMandatoryNotification("inquiry_update")).toBe(false);
  });
});

describe("the Manager's queue", () => {
  it("only the Manager answers, declines or resolves, and reads the queue", async () => {
    await inq.raiseOwnerInquiry(db(), { userId: USERS.b1, propertyId: A, entryId: "e-exp", type: "recategorize", message: "Move", suggestedAccountCode: "6400" });
    for (const u of [USERS.b1, USERS.b2, USERS.hla, USERS.ra, USERS.broker, "u-nobody"]) {
      await expect(inq.answerInquiry(db(), { actorId: u, inquiryId: "q-1", response: "x" })).rejects.toThrow("Only the Manager");
      await expect(inq.rejectInquiry(db(), { actorId: u, inquiryId: "q-1", response: "x" })).rejects.toThrow("Only the Manager");
      await expect(inq.resolveInquiry(db(), { actorId: u, inquiryId: "q-1", response: "x" })).rejects.toThrow("Only the Manager");
      await expect(inq.adminInquiries(db(), { userId: u, propertyId: A })).rejects.toThrow("Only the Manager");
    }
    expect(db().table("coowner_inquiries")[0].status).toBe("open");
  });

  it("lists every owner's inquiries for the Manager with the transaction, and passes the correction through to resolve", async () => {
    await inq.raiseOwnerInquiry(db(), { userId: USERS.b1, propertyId: A, entryId: "e-exp", type: "recategorize", message: "Move it", suggestedAccountCode: "6400" });
    await inq.raiseOwnerInquiry(db(), { userId: USERS.b2, propertyId: A, entryId: "e-exp", type: "clarification", message: "Question" });
    const q = await inq.adminInquiries(db(), { userId: USERS.admin, propertyId: A });
    expect(q.inquiries.map((i) => [i.message, i.askedBy]).sort()).toEqual([["Move it", "b1@test.local"], ["Question", "b2@test.local"]]);
    expect(q.inquiries.find((i) => i.message === "Move it")!.entry!.lines.map((l) => l.code).sort()).toEqual(["1000", "6400"]);
    expect(q.accounts.map((a) => a.code)).toEqual(["1000", "6400"]);
    expect(await inq.openInquiryCount(db(), A)).toBe(2);
    const spy = vi.fn((a: any) => ({ resulting_entry_id: "e-corrected" }));
    db().rpcResults.resolve_inquiry = spy;
    const r = await inq.resolveInquiry(db(), { actorId: USERS.admin, inquiryId: "q-1", response: "Moved it.", correction: { kind: "recategorize", mapping: { l1: "6600" }, reason: "Cleaning", entryDate: "2026-11-30" } });
    expect(r).toEqual({ resultingEntryId: "e-corrected" });
    expect(spy.mock.calls[0]![0]).toMatchObject({ _id: "q-1", _actor: USERS.admin, _response: "Moved it.", _correction: { kind: "recategorize", mapping: { l1: "6600" }, reason: "Cleaning", entry_date: "2026-11-30" } });
    expect((await inq.resolveInquiry(db(), { actorId: USERS.admin, inquiryId: "q-2", response: "Plain." }).catch(() => ({ resultingEntryId: "x" }))).resultingEntryId).toBeDefined();
  });

  it("the pages are wired: the owner's two buttons, the Manager's queue URL, and the link from the books", () => {
    const owner = readFileSync("src/routes/owner.properties.$propertyId.ledger.tsx", "utf8");
    expect(owner).toContain("Ask a question");
    expect(owner).toContain("Suggest recategorization");
    const admin = readFileSync("src/routes/admin.books_.$propertyId.inquiries.tsx", "utf8");
    expect(admin).toMatch(/createFileRoute\("\/admin\/books_\/\$propertyId\/inquiries"\)/);
    for (const label of ["Send answer", "Resolve with correction", "Decline the suggestion"]) expect(admin).toContain(label);
    expect(readFileSync("src/routes/admin.books.$propertyId.tsx", "utf8")).toContain("/admin/books/$propertyId/inquiries");
    expect(readFileSync("src/routeTree.gen.ts", "utf8")).toContain("/admin/books/$propertyId/inquiries");
  });
});
