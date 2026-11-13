/** Owner notifications: each trigger reaches each owner once, on one property only, and mandatory email can't be switched off. */
import { describe, it, expect, vi, afterEach } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import { deliver } from "@/lib/authorization.notify.server";
import { isMandatoryNotification, groupByProperty, OWNER_NOTIFICATION_TYPES } from "@/lib/owner-notifications";
import {
  getNotificationPropertyLabels,
  getOwnerNotificationPreferences,
  listDistributionsForAdmin,
  postDistributionEvent,
  setOwnerNotificationPreference,
} from "@/lib/owner-notifications.functions";
import { notifyOwners, sendOwnerReminders } from "@/lib/owner-notifications.server";
import { openVote } from "@/lib/votes.server";
import { updateRequest } from "@/lib/maintenance.server";
import { settleOverdue } from "@/lib/expenses.server";
import { postOwnerNotice } from "@/lib/owner-llc.functions";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const A = IDS.property;
const B = "prop-2";
const HOUR = 3_600_000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();
const dayOffset = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
const OWNERS_A = [USERS.b1, USERS.b2, IDS.seller];
const FAR = inHours(5000);

/** A: B1 (1 share), B2 (2), the retained seller (1). B: B3 alone. */
function seed() {
  seedPod(db());
  db().seed("properties", [{ id: B, address: "77 Second St", city: "Casper", state: "WY", zip: "82601", seller_id: "seller-2" }]);
  const cap = (property_id: string, share_number: number, holder: Record<string, unknown>) =>
    db().seed("cap_table_entries", [{ property_id, share_number, buyer_account_id: null, seller_id: null, acquisition_date: FAR, retention_lock_expires_at: FAR, ...holder }]);
  cap(A, 1, { holder_type: "buyer_account", buyer_account_id: IDS.b1 });
  cap(A, 2, { holder_type: "buyer_account", buyer_account_id: IDS.b2 });
  cap(A, 3, { holder_type: "buyer_account", buyer_account_id: IDS.b2 });
  cap(A, 4, { holder_type: "retained_seller", seller_id: IDS.seller });
  cap(B, 1, { holder_type: "buyer_account", buyer_account_id: IDS.b3 });
}

const ofType = (user: string, type: string) => db().notificationsFor(user).filter((n) => n.type === type);
/** Exactly one for each owner of A, with its property; none for B's owner. */
function expectOnePerOwnerOfA(type: string, extra?: (n: any) => void) {
  for (const user of OWNERS_A) {
    const rows = ofType(user, type);
    expect(rows, `${user} ${type}`).toHaveLength(1);
    expect(rows[0]!.property_id).toBe(A);
    extra?.(rows[0]);
  }
  expect(ofType(USERS.b3, type)).toEqual([]);
}

describe("every type carries its property and goes once", () => {
  it("a vote opened", async () => {
    seed();
    db().seed("votes", [{ id: "v1", property_id: A, title: "Paint", vote_type: "ordinary", options: ["Yes", "No"], opens_at: inHours(-1), closes_at: inHours(200), status: "draft", result_summary: null }]);
    await openVote(db() as never, USERS.admin, "v1");
    expectOnePerOwnerOfA("governance_vote_window");
    db().table("votes").find((v) => v.id === "v1")!.status = "draft";
    await openVote(db() as never, USERS.admin, "v1");
    expectOnePerOwnerOfA("governance_vote_window");
  });

  it("a vote closing in 48h: only in the window, once however often the sweep runs", async () => {
    seed();
    db().seed("votes", [
      { id: "soon", property_id: A, title: "Soon", status: "open", closes_at: inHours(47) },
      { id: "later", property_id: A, title: "Later", status: "open", closes_at: inHours(49) },
      { id: "past", property_id: A, title: "Past", status: "open", closes_at: inHours(-1) },
      { id: "shut", property_id: A, title: "Shut", status: "closed", closes_at: inHours(10) },
    ]);
    await sendOwnerReminders(db() as never);
    await sendOwnerReminders(db() as never);
    expectOnePerOwnerOfA("governance_vote_window", (n) => expect(n.message).toContain("Soon"));
  });

  it("a capital call due in 7 days: only those who still owe, with their own amount", async () => {
    seed();
    db().seed("capital_calls", [
      { id: "c1", property_id: A, title: "Septic", status: "issued", due_date: dayOffset(7), total_amount: 4000 },
      { id: "c2", property_id: A, title: "Far off", status: "issued", due_date: dayOffset(9), total_amount: 4000 },
      { id: "c3", property_id: A, title: "Draft", status: "draft", due_date: dayOffset(2), total_amount: 4000 },
      { id: "c4", property_id: A, title: "Closed", status: "closed", due_date: dayOffset(2), total_amount: 4000 },
    ]);
    db().seed("capital_call_allocations", [
      { id: "a1", capital_call_id: "c1", holder_key: IDS.b1, share_count: 1, amount: 1000, status: "due" },
      { id: "a2", capital_call_id: "c1", holder_key: IDS.b2, share_count: 2, amount: 2000, status: "marked_paid" },
      { id: "a3", capital_call_id: "c1", holder_key: `seller:${IDS.seller}`, share_count: 1, amount: 1000, status: "due" },
      { id: "a4", capital_call_id: "c2", holder_key: IDS.b1, share_count: 1, amount: 1000, status: "due" },
      { id: "a5", capital_call_id: "c4", holder_key: IDS.b1, share_count: 1, amount: 1000, status: "due" },
    ]);
    await sendOwnerReminders(db() as never);
    await sendOwnerReminders(db() as never);
    expect(ofType(USERS.b1, "capital_call_alert")).toHaveLength(1);
    expect(ofType(USERS.b1, "capital_call_alert")[0]).toMatchObject({ property_id: A });
    expect(ofType(USERS.b1, "capital_call_alert")[0]!.message).toContain("$1,000.00");
    expect(ofType(IDS.seller, "capital_call_alert")).toHaveLength(1);
    expect(ofType(USERS.b2, "capital_call_alert")).toEqual([]);
  });

  it("a capital call overdue goes once", async () => {
    seed();
    db().seed("capital_calls", [{ id: "c1", property_id: A, title: "Septic", status: "issued", due_date: dayOffset(-1), total_amount: 1000 }]);
    db().seed("capital_call_allocations", [{ id: "a1", capital_call_id: "c1", holder_key: IDS.b1, share_count: 1, amount: 1000, status: "due" }]);
    await settleOverdue(db() as never);
    db().table("capital_call_allocations")[0]!.status = "due";
    await settleOverdue(db() as never);
    expect(ofType(USERS.b1, "capital_call_alert")).toHaveLength(1);
    expect(ofType(USERS.b1, "capital_call_alert")[0]).toMatchObject({ property_id: A });
  });

  it("a Use Calendar turn ending in 12h: the holder whose turn it is, once per turn", async () => {
    seed();
    db().seed("use_calendar_years", [{ id: "y1", property_id: A, year: 2027, status: "selection_open", turn_holder_key: IDS.b1, turn_seq: 3, turn_deadline_at: inHours(11) }]);
    await sendOwnerReminders(db() as never);
    await sendOwnerReminders(db() as never);
    expect(ofType(USERS.b1, "calendar_turn")).toHaveLength(1);
    expect(ofType(USERS.b1, "calendar_turn")[0]).toMatchObject({ property_id: A });
    expect(ofType(USERS.b2, "calendar_turn")).toEqual([]);
    const y = db().table("use_calendar_years")[0]!;
    y.turn_seq = 4;
    await sendOwnerReminders(db() as never);
    expect(ofType(USERS.b1, "calendar_turn")).toHaveLength(2);
    y.turn_deadline_at = inHours(13);
    y.turn_seq = 5;
    await sendOwnerReminders(db() as never);
    expect(ofType(USERS.b1, "calendar_turn")).toHaveLength(2);
  });

  it("a right of first refusal closing in 24h: co-owners, not the seller", async () => {
    seed();
    db().seed("resale_listings", [
      { id: "l1", property_id: A, share_number: 3, status: "rofr_open", seller_user_id: USERS.b2, rofr_closes_at: inHours(23) },
      { id: "l2", property_id: A, share_number: 2, status: "rofr_open", seller_user_id: USERS.b2, rofr_closes_at: inHours(25) },
    ]);
    await sendOwnerReminders(db() as never);
    await sendOwnerReminders(db() as never);
    for (const user of [USERS.b1, IDS.seller]) expect(ofType(user, "resale_activity")).toHaveLength(1);
    expect(ofType(USERS.b2, "resale_activity")).toEqual([]);
    expect(ofType(USERS.b3, "resale_activity")).toEqual([]);
  });

  it("a maintenance status change", async () => {
    seed();
    db().seed("maintenance_requests", [{ id: "m1", property_id: A, submitted_by_user_id: USERS.b1, title: "Leak", status: "submitted" }]);
    await updateRequest(db() as never, { adminId: USERS.admin, requestId: "m1", status: "triaged", estimatedCost: null, actualCost: null, vendorName: null, note: null });
    expectOnePerOwnerOfA("maintenance_update", (n) => expect(n.dedupe_key).toBe("maintenance:m1:triaged"));
    await updateRequest(db() as never, { adminId: USERS.admin, requestId: "m1", status: "approved", estimatedCost: null, actualCost: null, vendorName: null, note: null });
    expect(ofType(USERS.b1, "maintenance_update")).toHaveLength(2);
  });

  it("a new notice", async () => {
    seed();
    as(USERS.admin);
    await postOwnerNotice({ data: { propertyId: A, title: "Annual meeting", body: "Details" } });
    expectOnePerOwnerOfA("notice_posted", (n) => expect(n.message).toContain("Annual meeting"));
  });

  it("the same event sent twice stays one notification, with no second email", async () => {
    seed();
    process.env.RESEND_API_KEY = "test";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const send = () => notifyOwners(db() as never, A, { type: "notice_posted", subject: "S", message: "M", link: "/x", dedupeKey: "k1" });
    expect(await send()).toBe(3);
    const emails = fetchSpy.mock.calls.length;
    expect(await send()).toBe(0);
    expect(fetchSpy.mock.calls.length).toBe(emails);
    expectOnePerOwnerOfA("notice_posted");
  });

  it("two sweeps at once still send one", async () => {
    seed();
    db().seed("votes", [{ id: "soon", property_id: A, title: "Soon", status: "open", closes_at: inHours(47) }]);
    await Promise.all([sendOwnerReminders(db() as never), sendOwnerReminders(db() as never)]);
    expectOnePerOwnerOfA("governance_vote_window");
  });
});

describe("scoping", () => {
  it("an owner of A gets nothing for B, and the reverse", async () => {
    seed();
    await notifyOwners(db() as never, B, { type: "notice_posted", subject: "S", message: "for B", link: "/x", dedupeKey: "b" });
    expect(ofType(USERS.b3, "notice_posted")).toHaveLength(1);
    for (const user of OWNERS_A) expect(db().notificationsFor(user)).toEqual([]);
    await notifyOwners(db() as never, A, { type: "notice_posted", subject: "S", message: "for A", link: "/x", dedupeKey: "a" });
    expect(ofType(USERS.b3, "notice_posted")).toHaveLength(1);
  });

  it("the bell groups by property, general ones first and order kept", () => {
    const groups = groupByProperty([{ id: 1, property_id: "p1" }, { id: 2, property_id: null }, { id: 3, property_id: "p2" }, { id: 4, property_id: "p1" }], { p1: "One", p2: "Two" });
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([[null, [2]], ["One", [1, 4]], ["Two", [3]]]);
  });

  it("no property on anything: no headings, as before for other roles", () => {
    const groups = groupByProperty([{ id: 1 }, { id: 2 }], {});
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBeNull();
  });

  it("property names only for properties this person was told about", async () => {
    seed();
    await notifyOwners(db() as never, A, { type: "notice_posted", subject: "S", message: "M", link: "/x", dedupeKey: "a" });
    as(USERS.b1);
    const labels = await getNotificationPropertyLabels({ data: { propertyIds: [A, B] } });
    expect(Object.keys(labels)).toEqual([A]);
    as(USERS.b3);
    expect(await getNotificationPropertyLabels({ data: { propertyIds: [A] } })).toEqual({});
  });
});

describe("preferences", () => {
  afterEach(() => vi.restoreAllMocks());
  const emailsTo = (spy: any, to: string) => spy.mock.calls.filter((c: any[]) => JSON.parse(c[1].body).to.includes(to)).length;
  const mailer = () => {
    process.env.RESEND_API_KEY = "test";
    return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
  };
  const buyerEmail = (id: string) => db().table("buyer_accounts").find((b) => b.id === id)!.email as string;

  it("governance, capital call and voting window can't be switched off", async () => {
    seed();
    as(USERS.b1);
    for (const type of ["governance_vote_window", "capital_call_alert", "notice_posted", "monthly_statement"] as const) {
      expect(isMandatoryNotification(type)).toBe(true);
      await expect(setOwnerNotificationPreference({ data: { type, emailEnabled: false } })).rejects.toThrow("required");
    }
    expect(db().table("owner_notification_preferences")).toEqual([]);
    const { preferences } = await getOwnerNotificationPreferences();
    expect(preferences.filter((p) => p.mandatory).map((p) => [p.type, p.emailEnabled])).toEqual([
      ["capital_call_alert", true],
      ["governance_vote_window", true],
      ["notice_posted", true],
      ["monthly_statement", true],
    ]);
  });

  it("even a row forced off in the database doesn't stop a mandatory email", async () => {
    seed();
    db().seed("owner_notification_preferences", [{ user_id: USERS.b1, type: "capital_call_alert", email_enabled: false }]);
    const spy = mailer();
    await deliver(db() as never, { authUserId: USERS.b1, email: "b1@test.local" }, { subject: "S", message: "M", type: "capital_call_alert", propertyId: A });
    expect(emailsTo(spy, "b1@test.local")).toBe(1);
    as(USERS.b1);
    expect((await getOwnerNotificationPreferences()).preferences.find((p) => p.type === "capital_call_alert")!.emailEnabled).toBe(true);
  });

  it("an optional type switched off stops the email, never the in-app one", async () => {
    seed();
    as(USERS.b1);
    await setOwnerNotificationPreference({ data: { type: "maintenance_update", emailEnabled: false } });
    expect((await getOwnerNotificationPreferences()).preferences.find((p) => p.type === "maintenance_update")!.emailEnabled).toBe(false);
    const spy = mailer();
    await notifyOwners(db() as never, A, { type: "maintenance_update", subject: "S", message: "M", link: "/x", dedupeKey: "m" });
    expect(ofType(USERS.b1, "maintenance_update")).toHaveLength(1);
    expect(emailsTo(spy, buyerEmail(IDS.b1))).toBe(0);
    expect(emailsTo(spy, buyerEmail(IDS.b2))).toBe(1);
  });

  it("back on sends again; one person's setting doesn't touch another's", async () => {
    seed();
    as(USERS.b1);
    await setOwnerNotificationPreference({ data: { type: "resale_activity", emailEnabled: false } });
    await setOwnerNotificationPreference({ data: { type: "resale_activity", emailEnabled: true } });
    as(USERS.b2);
    expect((await getOwnerNotificationPreferences()).preferences.find((p) => p.type === "resale_activity")!.emailEnabled).toBe(true);
    const spy = mailer();
    await notifyOwners(db() as never, A, { type: "resale_activity", subject: "S", message: "M", link: "/x", dedupeKey: "r" });
    expect(emailsTo(spy, buyerEmail(IDS.b1))).toBe(1);
  });

  it("a non-owner has no settings and can't save one; a bad type is refused", async () => {
    seed();
    as(USERS.ra);
    expect(await getOwnerNotificationPreferences()).toEqual({ isOwner: false, preferences: [] });
    await expect(setOwnerNotificationPreference({ data: { type: "resale_activity", emailEnabled: false } })).rejects.toThrow("Not authorized");
    as(USERS.b1);
    await expect(setOwnerNotificationPreference({ data: { type: "vote" as never, emailEnabled: false } })).rejects.toThrow("type");
  });

  it("lists all eleven types", async () => {
    seed();
    as(USERS.b1);
    const { preferences } = await getOwnerNotificationPreferences();
    expect(preferences.map((p) => p.type).sort()).toEqual(Object.keys(OWNER_NOTIFICATION_TYPES).sort());
    expect(preferences).toHaveLength(11);
    expect(preferences.find((p) => p.type === "expense_posted")).toMatchObject({ mandatory: false, emailEnabled: true });
  });

  it("a retained seller's email comes from their seller row", async () => {
    seed();
    db().table("sellers").find((s) => s.id === IDS.seller) ?? db().seed("sellers", [{ id: IDS.seller, email: "seller@test.local" }]);
    db().table("sellers").find((s) => s.id === IDS.seller)!.email = "seller@test.local";
    const spy = mailer();
    await notifyOwners(db() as never, A, { type: "notice_posted", subject: "S", message: "M", link: "/x", dedupeKey: "s" });
    expect(emailsTo(spy, "seller@test.local")).toBe(1);
  });

  it("the email has a full link, says the right thing, and text people typed can't become HTML", async () => {
    seed();
    const spy = mailer();
    await deliver(db() as never, { authUserId: USERS.b1, email: "b1@test.local" }, { subject: "A <b>subject</b>", message: 'Leak: <img src=x onerror="alert(1)">', link: `/owner/properties/${A}/maintenance`, type: "maintenance_update", propertyId: A });
    const html = JSON.parse((spy.mock.calls[0]![1] as any).body).html as string;
    expect(html).toContain("&lt;img src=x");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;b&gt;subject");
    expect(html).toMatch(/href="https:\/\/[^"]+\/owner\/properties\//);
    expect(html).toContain("Open in divieight");
    expect(html).not.toContain("authorization request");
  });

  it("other roles' emails keep their wording", async () => {
    seed();
    const spy = mailer();
    await deliver(db() as never, { authUserId: USERS.ra, email: "ra@test.local" }, { subject: "S", message: "M", link: "/agent/authorizations" });
    expect(JSON.parse((spy.mock.calls[0]![1] as any).body).html).toContain("Open the authorization request");
    expect(db().notificationsFor(USERS.ra)[0]!.type).toBe("authorization");
  });

  it("before the SQL is run, people are still reached", async () => {
    seed();
    const real = db();
    const inserted: any[] = [];
    const legacy = {
      from: (t: string) => {
        if (t !== "notifications") return real.from(t);
        return { insert: async (row: any) => ("property_id" in row ? { error: { message: 'column "property_id" does not exist' } } : (inserted.push(row), { error: null })) };
      },
    };
    const r = await deliver(legacy as never, { authUserId: USERS.b1, email: null }, { subject: "S", message: "M", type: "notice_posted", propertyId: A, dedupeKey: "x" });
    expect(r.portal).toBe(true);
    expect(inserted).toEqual([{ seller_id: USERS.b1, message: "M", type: "notice_posted" }]);
  });
});

describe("distributions", () => {
  const post = (o: Record<string, unknown> = {}) => {
    as(USERS.admin);
    return postDistributionEvent({ data: { propertyId: A, totalAmount: 1000.03, recordDate: "2026-12-31", note: "Rent", ...o } as never });
  };

  it("tells each owner their own pro-rata amount, once, and the amounts add up", async () => {
    seed();
    await post();
    expectOnePerOwnerOfA("distribution_event");
    const text = (u: string) => ofType(u, "distribution_event")[0]!.message as string;
    expect(text(USERS.b2)).toContain("$500.01");
    expect(text(IDS.seller)).toContain("$250.00");
    expect(text(USERS.b1)).toContain("$250.02");
    expect(text(USERS.b1)).not.toContain("$500.01");
    expect(25002 + 50001 + 25000).toBe(100003);
    expect(text(USERS.b1)).toContain("no payment is made");
    expect(db().table("distribution_events")).toHaveLength(1);
  });

  it("moves no money and changes no balance", async () => {
    seed();
    const before = JSON.stringify(db().table("owner_capital_accounts"));
    await post();
    expect(JSON.stringify(db().table("owner_capital_accounts"))).toBe(before);
  });

  it("admin only; checks amount, date and that the property has owners", async () => {
    seed();
    as(USERS.b1);
    await expect(postDistributionEvent({ data: { propertyId: A, totalAmount: 10, recordDate: "2026-12-31" } })).rejects.toThrow("Not authorized");
    await expect(listDistributionsForAdmin()).rejects.toThrow("Not authorized");
    await expect(post({ totalAmount: 0 })).rejects.toThrow("above zero");
    await expect(post({ totalAmount: 1.005 })).rejects.toThrow("two decimal");
    await expect(post({ recordDate: "soon" })).rejects.toThrow("record date");
    await expect(post({ propertyId: "nope" })).rejects.toThrow("no issued shares");
    expect(db().table("distribution_events")).toEqual([]);
  });

  it("shows in the admin list and the audit log", async () => {
    seed();
    await post();
    as(USERS.admin);
    const { rows, properties } = await listDistributionsForAdmin();
    expect(rows[0]).toMatchObject({ totalAmount: 1000.03, recordDate: "2026-12-31", note: "Rent" });
    expect(properties.map((p) => p.id)).toEqual(expect.arrayContaining([A, B]));
    expect(db().audits("distribution.posted")).toHaveLength(1);
  });
});
