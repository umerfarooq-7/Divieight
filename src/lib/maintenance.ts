/** Maintenance requests: statuses, the allowed moves and small shared rules. */

export const MAINTENANCE_URGENCIES = ["low", "normal", "urgent"] as const;
export type MaintenanceUrgency = (typeof MAINTENANCE_URGENCIES)[number];

export type MaintenanceStatus = "submitted" | "triaged" | "approved" | "in_progress" | "completed" | "rejected";

export const MAINTENANCE_CATEGORIES = ["Plumbing", "Electrical", "HVAC", "Appliance", "Structure & roof", "Exterior & landscaping", "Pest", "Other"];

export const MAINTENANCE_STATUS_LABELS: Record<MaintenanceStatus, string> = {
  submitted: "Submitted",
  triaged: "Triaged",
  approved: "Approved",
  in_progress: "In progress",
  completed: "Completed",
  rejected: "Rejected",
};

/** A request is approved before it completes, so a completed request was always approved. */
export const MAINTENANCE_NEXT: Record<MaintenanceStatus, MaintenanceStatus[]> = {
  submitted: ["triaged", "rejected"],
  triaged: ["approved", "rejected"],
  approved: ["in_progress", "completed", "rejected"],
  in_progress: ["completed", "rejected"],
  completed: [],
  rejected: [],
};

export const MAX_MAINTENANCE_PHOTOS = 6;
export const MAX_MAINTENANCE_PHOTO_BYTES = 10 * 1024 * 1024;

/** A photo must sit in the submitter's own folder for this property. */
export function isOwnMaintenancePhotoPath(path: string, userId: string, propertyId: string): boolean {
  const prefix = `${userId}/${propertyId}/maintenance-`;
  return path.startsWith(prefix) && path.length > prefix.length && !path.slice(prefix.length).includes("/");
}

export const canAttributeToLlc = (r: { status: string; actual_cost: number | null; expense_queued_at: string | null }) =>
  r.status === "completed" && Number(r.actual_cost ?? 0) > 0 && !r.expense_queued_at;

export const maintenanceMoney = (amount: number) =>
  Number(amount).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
