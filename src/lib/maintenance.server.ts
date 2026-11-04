/**
 * Maintenance requests (server side). Any owner of a property can submit and can
 * see all of that property's requests; nothing here checks a Digital Key or
 * property status (Rev 48 floor). Photos stay in a private bucket and reach only
 * the property's owners and admins, as short-lived signed links. Every step goes
 * to the audit log.
 */

import { adminRecipients, deliver } from "@/lib/authorization.notify.server";
import {
  canAttributeToLlc,
  isOwnMaintenancePhotoPath,
  MAINTENANCE_NEXT,
  MAINTENANCE_STATUS_LABELS,
  MAX_MAINTENANCE_PHOTOS,
  type MaintenanceStatus,
  type MaintenanceUrgency,
} from "@/lib/maintenance";
import { holderFor, holderRecipients } from "@/lib/votes.server";

type Db = { from: (t: string) => any };

const BUCKET = "property-documents";
const SIGNED_URL_SECONDS = 3600;
const MISSING_SCHEMA = "Database is missing maintenance requests — run maintenance.sql in Supabase.";

export interface MaintenanceRow {
  id: string;
  property_id: string;
  submitted_by_user_id: string;
  title: string;
  description: string;
  category: string;
  urgency: MaintenanceUrgency;
  status: MaintenanceStatus;
  estimated_cost: number | null;
  actual_cost: number | null;
  vendor_name: string | null;
  photos: string[] | null;
  expense_id: string | null;
  expense_queued_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MaintenanceTimelineEntry {
  id: string;
  note: string | null;
  statusChange: MaintenanceStatus | null;
  createdAt: string;
}

/** What both the owner and the admin screens show about a request. */
interface MaintenanceDetail {
  id: string;
  title: string;
  description: string;
  category: string;
  urgency: MaintenanceUrgency;
  status: MaintenanceStatus;
  estimatedCost: number | null;
  actualCost: number | null;
  vendorName: string | null;
  photoUrls: string[];
  expenseQueuedAt: string | null;
  expenseLinked: boolean;
  createdAt: string;
  timeline: MaintenanceTimelineEntry[];
}

const numberOrNull = (value: number | null) => (value == null ? null : Number(value));

async function audit(db: Db, actor: { id: string | null; type: string }, action: string, row: Pick<MaintenanceRow, "id" | "property_id">, extra: Record<string, unknown> = {}) {
  await db.from("audit_log").insert({
    actor_id: actor.id,
    actor_type: actor.type,
    action_type: action,
    entity_type: "maintenance_request",
    entity_id: row.id,
    metadata: { property_id: row.property_id, at: new Date().toISOString(), ...extra },
  });
}

async function addUpdate(db: Db, requestId: string, authorId: string | null, note: string | null, statusChange: MaintenanceStatus | null) {
  await db.from("maintenance_updates").insert({ request_id: requestId, author_id: authorId, note, status_change: statusChange });
}

/** Signed links only: the caller has already checked this user may see the request. */
async function signedPhotos(db: Db, paths: string[] | null): Promise<string[]> {
  if (!paths?.length) return [];
  const { data } = await (db as any).storage.from(BUCKET).createSignedUrls(paths, SIGNED_URL_SECONDS);
  return ((data ?? []) as Array<{ signedUrl: string | null }>).map((d) => d.signedUrl).filter(Boolean) as string[];
}

async function detail(db: Db, row: MaintenanceRow): Promise<MaintenanceDetail> {
  const { data: updates } = await db.from("maintenance_updates").select("*").eq("request_id", row.id).order("created_at", { ascending: true });
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    urgency: row.urgency,
    status: row.status,
    estimatedCost: numberOrNull(row.estimated_cost),
    actualCost: numberOrNull(row.actual_cost),
    vendorName: row.vendor_name,
    photoUrls: await signedPhotos(db, row.photos),
    expenseQueuedAt: row.expense_queued_at,
    expenseLinked: Boolean(row.expense_id),
    createdAt: row.created_at,
    timeline: ((updates ?? []) as Array<{ id: string; note: string | null; status_change: MaintenanceStatus | null; created_at: string }>).map((u) => ({
      id: u.id,
      note: u.note,
      statusChange: u.status_change,
      createdAt: u.created_at,
    })),
  };
}

export interface OwnerMaintenanceRequest extends MaintenanceDetail {
  submittedByMe: boolean;
}

/** /owner/properties/:id/maintenance: every request on this property, and only this property. */
export async function ownerMaintenance(db: Db, userId: string, propertyId: string): Promise<{ allowed: boolean; requests: OwnerMaintenanceRequest[] }> {
  const holder = await holderFor(db, userId, propertyId);
  if (!holder) return { allowed: false, requests: [] };
  const { data, error } = await db.from("maintenance_requests").select("*").eq("property_id", propertyId).order("created_at", { ascending: false });
  if (error) return { allowed: true, requests: [] }; // before maintenance.sql is run
  const requests: OwnerMaintenanceRequest[] = [];
  for (const row of (data ?? []) as MaintenanceRow[]) {
    requests.push({ ...(await detail(db, row)), submittedByMe: row.submitted_by_user_id === userId });
  }
  return { allowed: true, requests };
}

export async function submitRequest(
  db: Db,
  params: { userId: string; propertyId: string; title: string; description: string; category: string; urgency: MaintenanceUrgency; photos: string[] },
): Promise<{ error?: string; id?: string }> {
  const holder = await holderFor(db, params.userId, params.propertyId);
  if (!holder) return { error: "You don't have ownership in that property." };
  if (params.photos.length > MAX_MAINTENANCE_PHOTOS) return { error: `Attach up to ${MAX_MAINTENANCE_PHOTOS} photos.` };
  if (params.photos.some((p) => !isOwnMaintenancePhotoPath(p, params.userId, params.propertyId)))
    return { error: "A photo couldn't be attached. Upload it again." };

  const { data, error } = await db
    .from("maintenance_requests")
    .insert({
      property_id: params.propertyId,
      submitted_by_user_id: params.userId,
      title: params.title,
      description: params.description,
      category: params.category,
      urgency: params.urgency,
      status: "submitted",
      photos: params.photos,
    })
    .select("*")
    .maybeSingle();
  if (error || !data) return { error: "Maintenance requests aren't available yet. Please try again later." };
  const row = data as MaintenanceRow;
  await addUpdate(db, row.id, params.userId, null, "submitted");
  await audit(db, { id: params.userId, type: holder.type }, "maintenance.submitted", row, { urgency: row.urgency, category: row.category, photo_count: params.photos.length });

  for (const admin of await adminRecipients(db as never)) {
    await deliver(db as never, admin, {
      subject: row.urgency === "urgent" ? "Urgent maintenance request" : "New maintenance request",
      message: `New maintenance request: "${row.title}" (${row.urgency}).`,
      link: "/admin/maintenance",
      type: "maintenance",
    });
  }
  if (row.urgency === "urgent") {
    const others = (await holderRecipients(db, row.property_id)).filter((r) => r.authUserId !== params.userId);
    await tellOwners(db, row, others, "Urgent maintenance request", `A co-owner reported an urgent issue: "${row.title}".`);
  }
  return { id: row.id };
}

async function tellOwners(db: Db, row: MaintenanceRow, recipients: Array<{ authUserId: string; email: string | null }>, subject: string, message: string) {
  for (const recipient of recipients) {
    await deliver(db as never, recipient, { subject, message, link: `/owner/properties/${row.property_id}/maintenance`, type: "maintenance" });
  }
}

// ---------------------------------------------------------------------------
// Admin (divieight as Manager)
// ---------------------------------------------------------------------------

export interface AdminMaintenanceRequest extends MaintenanceDetail {
  propertyId: string;
  propertyLabel: string;
  submittedBy: string;
  nextStatuses: MaintenanceStatus[];
  canAttribute: boolean;
}

export async function adminMaintenance(db: Db): Promise<{ rows: AdminMaintenanceRequest[] }> {
  const { data, error } = await db.from("maintenance_requests").select("*").order("created_at", { ascending: false });
  if (error) throw new Error(MISSING_SCHEMA);
  const rows: AdminMaintenanceRequest[] = [];
  for (const row of (data ?? []) as MaintenanceRow[]) {
    const { data: p } = await db.from("properties").select("address, city, state").eq("id", row.property_id).maybeSingle();
    const { data: buyer } = await db.from("buyer_accounts").select("email").eq("auth_user_id", row.submitted_by_user_id).maybeSingle();
    rows.push({
      ...(await detail(db, row)),
      propertyId: row.property_id,
      propertyLabel: p ? [p.address, p.city, p.state].filter(Boolean).join(", ") : "Property",
      submittedBy: (buyer?.email as string | undefined) ?? "Retained seller",
      nextStatuses: MAINTENANCE_NEXT[row.status],
      canAttribute: canAttributeToLlc(row),
    });
  }
  return { rows };
}

async function loadRequest(db: Db, requestId: string): Promise<MaintenanceRow> {
  const { data } = await db.from("maintenance_requests").select("*").eq("id", requestId).maybeSingle();
  if (!data) throw new Error("Request not found");
  return data as MaintenanceRow;
}

/**
 * Triage, estimate, approve and update. Costs and the vendor change until the
 * request has been queued as an expense; only a status change reaches the owners.
 */
export async function updateRequest(
  db: Db,
  params: {
    adminId: string;
    requestId: string;
    status: MaintenanceStatus | null;
    estimatedCost: number | null;
    actualCost: number | null;
    vendorName: string | null;
    note: string | null;
  },
) {
  const row = await loadRequest(db, params.requestId);
  const moving = params.status && params.status !== row.status ? params.status : null;
  if (moving && !MAINTENANCE_NEXT[row.status].includes(moving))
    throw new Error(`A ${MAINTENANCE_STATUS_LABELS[row.status].toLowerCase()} request can't move to ${MAINTENANCE_STATUS_LABELS[moving].toLowerCase()}.`);
  if (moving === "rejected" && !params.note) throw new Error("A note is required to reject a request.");

  const costChanged = numberOrNull(row.actual_cost) !== params.actualCost;
  if (row.expense_queued_at && costChanged) throw new Error("This request is already queued as an expense, so its actual cost can't change.");

  const { data, error } = await db
    .from("maintenance_requests")
    .update({
      status: moving ?? row.status,
      estimated_cost: params.estimatedCost,
      actual_cost: params.actualCost,
      vendor_name: params.vendorName,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .eq("status", row.status) // someone else may have just moved it
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("This request just changed. Reload and try again.");
  const updated = data as MaintenanceRow;

  if (moving || params.note) await addUpdate(db, row.id, params.adminId, params.note, moving);
  await audit(db, { id: params.adminId, type: "admin" }, moving ? "maintenance.status_changed" : "maintenance.updated", updated, {
    from_status: row.status,
    to_status: updated.status,
    estimated_cost: updated.estimated_cost,
    actual_cost: updated.actual_cost,
    vendor_name: updated.vendor_name,
    note: params.note,
  });
  if (moving) {
    await tellOwners(
      db,
      updated,
      await holderRecipients(db, updated.property_id),
      "Maintenance update",
      `"${updated.title}" is now ${MAINTENANCE_STATUS_LABELS[moving].toLowerCase()}.${params.note ? ` Note: ${params.note}` : ""}`,
    );
  }
}

/**
 * "Attributed to LLC operating account": a draft expense for the admin to review
 * and post, linked to this request in one transaction.
 */
export async function attributeToLlc(db: Db, params: { adminId: string; requestId: string }) {
  const row = await loadRequest(db, params.requestId);
  if (row.expense_queued_at) throw new Error("This request is already queued as an expense.");
  if (!canAttributeToLlc(row)) throw new Error("Only a completed request with an actual cost above zero can be attributed.");
  const { data, error } = await (db as any).rpc("create_expense_from_maintenance", { _request: row.id, _actor: params.adminId });
  if (error) throw new Error(/does not exist|schema cache/i.test(error.message) ? "Database is missing expenses — run expenses.sql in Supabase." : error.message);
  if (!data?.applied) throw new Error("This request is already queued as an expense.");
  await addUpdate(db, row.id, params.adminId, "Attributed to the LLC operating account.", null);
  await audit(db, { id: params.adminId, type: "admin" }, "maintenance.expense_queued", row, { actual_cost: row.actual_cost, expense_id: data.expense_id });
}
