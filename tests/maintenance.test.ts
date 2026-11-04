/** Maintenance requests: who can see and submit, the status flow, notifications, photos and the expense queue. */
import { describe, it, expect } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import {
  attributeMaintenanceToLlc,
  getOwnerMaintenance,
  listMaintenanceForAdmin,
  submitMaintenanceRequest,
  updateMaintenanceRequest,
} from "@/lib/maintenance.functions";
import { isOwnMaintenancePhotoPath } from "@/lib/maintenance";
import { updateRequest } from "@/lib/maintenance.server";
import { getOwnerProperty } from "@/lib/owner.functions";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const A = IDS.property;
const B = "prop-2";
const LOCK = new Date(Date.now() + 86_400_000 * 200).toISOString();

/** A: B1, B2 and the retained seller. B: B3. Nobody here has a Digital Key. */
function seed() {
  seedPod(db());
  // Stands in for create_expense_from_maintenance in expenses.sql.
  db().rpcResults.create_expense_from_maintenance = (a: { _request: string; _actor: string }) => {
    const r = db().table("maintenance_requests").find((x) => x.id === a._request)!;
    if (r.expense_id) return { applied: false, expense_id: r.expense_id };
    r.expense_id = `expense-${r.id}`;
    r.expense_queued_at = new Date().toISOString();
    r.expense_queued_by = a._actor;
    return { applied: true, expense_id: r.expense_id };
  };
  db().seed("properties", [{ id: B, address: "77 Second St", city: "Casper", state: "WY", zip: "82601", seller_id: "seller-2" }]);
  const cap = (property_id: string, share_number: number, holder: Record<string, unknown>) =>
    db().seed("cap_table_entries", [{ property_id, share_number, buyer_account_id: null, seller_id: null, acquisition_date: LOCK, retention_lock_expires_at: LOCK, ...holder }]);
  cap(A, 1, { holder_type: "buyer_account", buyer_account_id: IDS.b1 });
  cap(A, 2, { holder_type: "buyer_account", buyer_account_id: IDS.b2 });
  cap(A, 3, { holder_type: "retained_seller", seller_id: IDS.seller });
  cap(B, 1, { holder_type: "buyer_account", buyer_account_id: IDS.b3 });
}

const submit = async (user: string, extra: Record<string, unknown> = {}, propertyId = A) => {
  as(user);
  return submitMaintenanceRequest({
    data: { propertyId, title: "Leaking tap", description: "Kitchen tap drips.", category: "Plumbing", urgency: "normal", ...extra } as never,
  });
};
const update = (requestId: string, data: Record<string, unknown>) => {
  as(USERS.admin);
  return updateMaintenanceRequest({ data: { requestId, ...data } as never });
};
const row = (id: string) => db().table("maintenance_requests").find((r) => r.id === id)!;
const told = (user: string) => db().notificationsFor(user).filter((n) => n.type === "maintenance");
const toCompleted = async (id: string, actualCost: number | null = 450) => {
  await update(id, { status: "triaged", estimatedCost: 300 });
  await update(id, { status: "approved", estimatedCost: 300 });
  await update(id, { status: "in_progress", estimatedCost: 300, vendorName: "Ace Plumbing" });
  await update(id, { status: "completed", estimatedCost: 300, actualCost, vendorName: "Ace Plumbing" });
};
const attribute = (requestId: string) => {
  as(USERS.admin);
  return attributeMaintenanceToLlc({ data: { requestId } });
};

describe("submitting", () => {
  it("any owner can submit, buyer or retained seller, with no Digital Key (Rev 48)", async () => {
    seed();
    const r = await submit(USERS.b1);
    expect(r.error).toBeUndefined();
    expect(row(r.id!)).toMatchObject({ property_id: A, submitted_by_user_id: USERS.b1, status: "submitted", urgency: "normal", category: "Plumbing" });
    expect((await submit(IDS.seller)).error).toBeUndefined();
    as(USERS.b1);
    expect((await getOwnerProperty({ data: { propertyId: A } })).access).toBe("inactive");
    expect((await getOwnerMaintenance({ data: { propertyId: A } })).allowed).toBe(true);
    expect(db().audits("maintenance.submitted")).toHaveLength(2);
  });

  it("a non-owner can't submit", async () => {
    seed();
    expect((await submit(USERS.b3)).error).toMatch(/ownership/);
    expect((await submit("u-nobody")).error).toMatch(/ownership/);
    expect(db().table("maintenance_requests")).toEqual([]);
  });

  it("checks category, urgency, title and description", async () => {
    seed();
    await expect(submit(USERS.b1, { category: "Other stuff" })).rejects.toThrow("category");
    await expect(submit(USERS.b1, { urgency: "panic" })).rejects.toThrow("urgency");
    await expect(submit(USERS.b1, { title: "  " })).rejects.toThrow("Missing title");
    await expect(submit(USERS.b1, { description: "" })).rejects.toThrow("Missing description");
  });
});

describe("visibility", () => {
  it("owners see every request on their property, and none from another", async () => {
    seed();
    const onA = await submit(USERS.b1);
    await submit(USERS.b3, { title: "Casper roof" }, B);
    as(USERS.b2);
    const { requests } = await getOwnerMaintenance({ data: { propertyId: A } });
    expect(requests.map((r) => r.id)).toEqual([onA.id]);
    expect(requests[0]).toMatchObject({ submittedByMe: false });
    expect(JSON.stringify(requests)).not.toContain("Casper roof");
    as(USERS.b1);
    expect((await getOwnerMaintenance({ data: { propertyId: A } })).requests[0]!.submittedByMe).toBe(true);
  });

  it("an owner of A can't open B's list, and an owner of B can't open A's", async () => {
    seed();
    await submit(USERS.b1);
    await submit(USERS.b3, {}, B);
    as(USERS.b1);
    expect(await getOwnerMaintenance({ data: { propertyId: B } })).toEqual({ allowed: false, requests: [] });
    as(USERS.b3);
    expect(await getOwnerMaintenance({ data: { propertyId: A } })).toEqual({ allowed: false, requests: [] });
  });

  it("shows no submitter's identity to other owners", async () => {
    seed();
    await submit(USERS.b1);
    as(USERS.b2);
    const json = JSON.stringify((await getOwnerMaintenance({ data: { propertyId: A } })).requests);
    expect(json).not.toContain(USERS.b1);
    expect(json).not.toContain("b1@test.local");
  });

  it("the admin screens are admin only", async () => {
    seed();
    const { id } = await submit(USERS.b1);
    as(USERS.b1);
    await expect(listMaintenanceForAdmin()).rejects.toThrow("Not authorized");
    await expect(updateMaintenanceRequest({ data: { requestId: id!, status: "triaged" } })).rejects.toThrow("Not authorized");
    await expect(attributeMaintenanceToLlc({ data: { requestId: id! } })).rejects.toThrow("Not authorized");
    expect(row(id!).status).toBe("submitted");
  });
});

describe("photos", () => {
  const own = `${USERS.b1}/${A}/maintenance-abc.jpg`;

  it("are stored as paths in the owner's folder, and the path includes the property id", async () => {
    seed();
    const { id } = await submit(USERS.b1, { photos: [own] });
    expect(row(id!).photos).toEqual([own]);
    expect(row(id!).photos[0]).toContain(A);
  });

  it("refuse a path outside the submitter's folder for this property", async () => {
    seed();
    for (const bad of [`${USERS.b2}/${A}/maintenance-abc.jpg`, `${USERS.b1}/${B}/maintenance-abc.jpg`, `${USERS.b1}/${A}/oa.pdf`, `${USERS.b1}/${A}/maintenance-x/../../secret.pdf`, "https://evil.test/a.jpg"]) {
      expect((await submit(USERS.b1, { photos: [bad] })).error).toMatch(/couldn't be attached/);
    }
    expect(db().table("maintenance_requests")).toEqual([]);
  });

  it("are limited in number", async () => {
    seed();
    const many = Array.from({ length: 7 }, (_, i) => `${USERS.b1}/${A}/maintenance-${i}.jpg`);
    expect((await submit(USERS.b1, { photos: many })).error).toMatch(/up to 6/);
  });

  it("reach the property's owners and the admin as signed links only", async () => {
    seed();
    await submit(USERS.b1, { photos: [own] });
    as(USERS.b2);
    const signed = `https://signed.test/${own}`;
    expect((await getOwnerMaintenance({ data: { propertyId: A } })).requests[0]!.photoUrls).toEqual([signed]);
    as(USERS.admin);
    expect((await listMaintenanceForAdmin()).rows[0]!.photoUrls).toEqual([signed]);
  });

  it("never reach a non-owner", async () => {
    seed();
    await submit(USERS.b1, { photos: [own] });
    as(USERS.b3);
    const json = JSON.stringify([await getOwnerMaintenance({ data: { propertyId: A } }), await getOwnerMaintenance({ data: { propertyId: B } })]);
    expect(json).not.toContain("maintenance-abc");
  });

  it("the path rule accepts only a direct child of the owner's folder", () => {
    expect(isOwnMaintenancePhotoPath("u/p/maintenance-a.jpg", "u", "p")).toBe(true);
    expect(isOwnMaintenancePhotoPath("u/p/maintenance-", "u", "p")).toBe(false);
    expect(isOwnMaintenancePhotoPath("u/q/maintenance-a.jpg", "u", "p")).toBe(false);
  });
});

describe("the status flow", () => {
  it("moves one step at a time, with a timeline and audit", async () => {
    seed();
    const { id } = await submit(USERS.b1);
    await expect(update(id!, { status: "completed" })).rejects.toThrow("can't move");
    await expect(update(id!, { status: "approved" })).rejects.toThrow("can't move");
    await toCompleted(id!);
    expect(row(id!)).toMatchObject({ status: "completed", estimated_cost: 300, actual_cost: 450, vendor_name: "Ace Plumbing" });
    as(USERS.b2);
    const [request] = (await getOwnerMaintenance({ data: { propertyId: A } })).requests;
    expect(request!.timeline.map((t) => t.statusChange)).toEqual(["submitted", "triaged", "approved", "in_progress", "completed"]);
    expect(request).toMatchObject({ estimatedCost: 300, actualCost: 450, vendorName: "Ace Plumbing" });
    expect(db().audits("maintenance.status_changed")).toHaveLength(4);
  });

  it("final statuses are final; rejecting needs a note the owners can read", async () => {
    seed();
    const { id } = await submit(USERS.b1);
    await expect(update(id!, { status: "rejected" })).rejects.toThrow("note is required");
    await update(id!, { status: "rejected", note: "Covered by the warranty" });
    await expect(update(id!, { status: "triaged" })).rejects.toThrow("can't move");
    as(USERS.b2);
    expect((await getOwnerMaintenance({ data: { propertyId: A } })).requests[0]!.timeline.at(-1)).toMatchObject({ statusChange: "rejected", note: "Covered by the warranty" });
  });

  it("refuses negative costs", async () => {
    seed();
    const { id } = await submit(USERS.b1);
    await expect(update(id!, { estimatedCost: -1 })).rejects.toThrow("zero or more");
    await expect(update(id!, { actualCost: "abc" })).rejects.toThrow("zero or more");
  });

  it("can't skip approval on the way to completed, or leave completed", async () => {
    seed();
    const { id } = await submit(USERS.b1);
    await update(id!, { status: "triaged" });
    await expect(update(id!, { status: "completed" })).rejects.toThrow("can't move");
    await expect(update(id!, { status: "in_progress" })).rejects.toThrow("can't move");
    await update(id!, { status: "approved" });
    await update(id!, { status: "completed" });
    await expect(update(id!, { status: "in_progress" })).rejects.toThrow("can't move");
    await expect(update(id!, { status: "rejected", note: "Late" })).rejects.toThrow("can't move");
    expect(row(id!).status).toBe("completed");
  });

  it("an admin acting on a stale view can't overwrite a move someone else just made", async () => {
    seed();
    const { id } = await submit(USERS.b1);
    const move = (status: "triaged" | "rejected") =>
      updateRequest(db(), { adminId: USERS.admin, requestId: id!, status, estimatedCost: null, actualCost: null, vendorName: null, note: "Both looked at the same version" });
    const results = await Promise.allSettled([move("triaged"), move("rejected")]);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(row(id!).status).toBe("triaged");
    expect(db().table("maintenance_updates").filter((u) => u.request_id === id && u.status_change !== "submitted")).toHaveLength(1);
  });
});

describe("notifications", () => {
  it("a normal submission tells admins only", async () => {
    seed();
    await submit(USERS.b1);
    expect(told(USERS.admin)).toHaveLength(1);
    expect(told(USERS.b2)).toEqual([]);
    expect(told(IDS.seller)).toEqual([]);
  });

  it("an urgent one also tells this property's other owners, and no one else", async () => {
    seed();
    await submit(USERS.b1, { urgency: "urgent" });
    expect(told(USERS.b2)).toHaveLength(1);
    expect(told(IDS.seller)).toHaveLength(1);
    expect(told(USERS.b1)).toEqual([]);
    expect(told(USERS.b3)).toEqual([]);
  });

  it("a status change tells every owner of this property, including the submitter; an edit doesn't", async () => {
    seed();
    const { id } = await submit(USERS.b1);
    await update(id!, { status: "triaged" });
    for (const user of [USERS.b1, USERS.b2, IDS.seller]) expect(told(user)).toHaveLength(1);
    expect(told(USERS.b3)).toEqual([]);
    await update(id!, { estimatedCost: 100, note: "Waiting on a quote" });
    expect(told(USERS.b1)).toHaveLength(1);
    expect(db().audits("maintenance.updated")).toHaveLength(1);
  });
});

describe("attributing to the LLC", () => {
  it("a completed request with a cost becomes one linked expense, once", async () => {
    seed();
    const { id } = await submit(USERS.b1);
    await toCompleted(id!);
    expect(row(id!).expense_queued_at).toBeNull();
    await attribute(id!);
    expect(row(id!).expense_queued_at).toBeTruthy();
    expect(row(id!).expense_queued_by).toBe(USERS.admin);
    expect(row(id!).expense_id).toBeTruthy();
    expect(db().audits("maintenance.expense_queued")[0]!.metadata.actual_cost).toBe(450);
    await expect(attribute(id!)).rejects.toThrow("already queued");
    expect(db().audits("maintenance.expense_queued")).toHaveLength(1);
    as(USERS.admin);
    expect((await listMaintenanceForAdmin()).rows[0]).toMatchObject({ canAttribute: false, expenseLinked: true });
  });

  it("is refused before completion, with no cost, with a zero cost, or after rejection", async () => {
    seed();
    const open = await submit(USERS.b1);
    await update(open.id!, { status: "triaged", actualCost: 100 });
    await expect(attribute(open.id!)).rejects.toThrow("Only a completed request");

    const noCost = await submit(USERS.b1);
    await toCompleted(noCost.id!, null);
    await expect(attribute(noCost.id!)).rejects.toThrow("Only a completed request");

    const zero = await submit(USERS.b1);
    await toCompleted(zero.id!, 0);
    await expect(attribute(zero.id!)).rejects.toThrow("Only a completed request");

    const rejected = await submit(USERS.b1);
    await update(rejected.id!, { status: "rejected", actualCost: 100, note: "No" });
    await expect(attribute(rejected.id!)).rejects.toThrow("Only a completed request");
    expect(db().table("maintenance_requests").every((r) => r.expense_queued_at === null)).toBe(true);
  });

  it("offers the button only when it would work", async () => {
    seed();
    const { id } = await submit(USERS.b1);
    as(USERS.admin);
    expect((await listMaintenanceForAdmin()).rows[0]!.canAttribute).toBe(false);
    await toCompleted(id!);
    as(USERS.admin);
    expect((await listMaintenanceForAdmin()).rows[0]!.canAttribute).toBe(true);
  });

  it("the actual cost is frozen once queued; other details aren't", async () => {
    seed();
    const { id } = await submit(USERS.b1);
    await toCompleted(id!);
    await attribute(id!);
    await expect(update(id!, { estimatedCost: 300, actualCost: 999, vendorName: "Ace Plumbing" })).rejects.toThrow("can't change");
    expect(row(id!).actual_cost).toBe(450);
    await update(id!, { estimatedCost: 300, actualCost: 450, vendorName: "Ace Plumbing Inc" });
    expect(row(id!).vendor_name).toBe("Ace Plumbing Inc");
  });
});
