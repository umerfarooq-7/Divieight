import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabase } from "@/integrations/supabase/client";
import type { PropertyReportRow, ReportAnnotation, ReportType } from "@/lib/reports";

/**
 * Appraisal & Inspection Report Delivery — callable surface.
 *
 * Admins record receipt; Buyer Accounts reserved into the property and their
 * tethered Resident Agents read. Only the Resident Agent may annotate.
 */

type Db = { from: (t: string) => any; storage?: any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function isAdmin(userId: string) {
  const { data } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  return Boolean(data);
}

export type ReportView = PropertyReportRow & {
  signed_url: string | null;
  superseded: boolean;
  propertyLabel: string;
};

const REPORT_COLS =
  "id, property_id, report_type, title, vendor_name, report_date, file_url, content_hash, data_room_document_id, diligence_document_id, contract_price, appraised_value, flags, supersedes_report_id, received_at";

async function loadReports(db: Db, propertyIds: string[]): Promise<ReportView[]> {
  if (propertyIds.length === 0) return [];
  const { data } = await db
    .from("property_reports")
    .select(REPORT_COLS)
    .in("property_id", propertyIds)
    .order("received_at", { ascending: false });
  const rows = (data ?? []) as Array<PropertyReportRow & { supersedes_report_id: string | null }>;
  const supersededIds = new Set(rows.map((r) => r.supersedes_report_id).filter(Boolean));

  const { data: props } = await db
    .from("properties")
    .select("id, address, city, state")
    .in("id", propertyIds);
  const labelById = new Map(
    ((props ?? []) as Array<{ id: string; address: string; city: string; state: string }>).map((p) => [
      p.id,
      `${p.address}, ${p.city}, ${p.state}`,
    ]),
  );

  const signed = new Map<string, string>();
  if (rows.length > 0) {
    try {
      const { data: urls } = await (db as any).storage
        .from("property-documents")
        .createSignedUrls(
          rows.map((r) => r.file_url),
          60 * 60,
        );
      for (const u of (urls ?? []) as Array<{ path: string; signedUrl: string }>)
        if (u.path && u.signedUrl) signed.set(u.path, u.signedUrl);
    } catch {
      // listed without a link rather than failing the page
    }
  }

  return rows.map((r) => ({
    ...r,
    flags: Array.isArray(r.flags) ? r.flags : [],
    signed_url: signed.get(r.file_url) ?? null,
    superseded: supersededIds.has(r.id),
    propertyLabel: labelById.get(r.property_id) ?? "Subject property",
  }));
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export interface DeliverReportPayload {
  propertyId: string;
  reportType: ReportType;
  title: string;
  vendorName?: string | null;
  reportDate?: string | null;
  fileUrl: string;
  contentHash: string;
  contractPrice?: number | null;
  appraisedValue?: number | null;
  reportText?: string | null;
  supersedesReportId?: string | null;
}

export const deliverPropertyReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: DeliverReportPayload) => {
    if (!input?.propertyId) throw new Error("Choose a property");
    if (input.reportType !== "appraisal" && input.reportType !== "inspection")
      throw new Error("Choose appraisal or inspection");
    if (!input.title?.trim()) throw new Error("Give the report a title");
    if (!input.fileUrl || !input.contentHash) throw new Error("Upload the report file");
    const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
    const contractPrice = num(input.contractPrice);
    const appraisedValue = num(input.appraisedValue);
    if (contractPrice !== null && !(contractPrice > 0)) throw new Error("Contract price must be positive");
    if (appraisedValue !== null && !(appraisedValue > 0)) throw new Error("Appraised value must be positive");
    if (input.reportType === "appraisal" && appraisedValue === null)
      throw new Error("Enter the appraised value from the report");
    return {
      ...input,
      title: input.title.trim(),
      contractPrice,
      appraisedValue,
      reportText: input.reportText?.slice(0, 500_000) ?? null,
    };
  })
  .handler(async ({ data, context }) => {
    const userId = context.claims?.sub as string;
    if (!(await isAdmin(userId))) throw new Error("Not authorized");
    const db = await adminDb();
    const { deliverReport } = await import("@/lib/reports.server");
    return deliverReport(db, userId, data);
  });

export const listPropertyReports = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => {
    if (!input?.propertyId) throw new Error("Missing property");
    return input;
  })
  .handler(async ({ data, context }) => {
    const userId = context.claims?.sub as string;
    if (!(await isAdmin(userId))) throw new Error("Not authorized");
    const db = await adminDb();
    const { data: property } = await db
      .from("properties")
      .select("id, address, city, state, listing_price")
      .eq("id", data.propertyId)
      .maybeSingle();
    return {
      property: property as { id: string; address: string; city: string; state: string; listing_price: number | null } | null,
      reports: await loadReports(db, [data.propertyId]),
    };
  });

// ---------------------------------------------------------------------------
// Buyer
// ---------------------------------------------------------------------------

export interface BuyerReportsPayload {
  reports: Array<ReportView & { annotations: ReportAnnotation[] }>;
}

export const listBuyerReports = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<BuyerReportsPayload> => {
    const db = await adminDb();
    const { data: buyer } = await db
      .from("buyer_accounts")
      .select("id")
      .eq("auth_user_id", context.claims?.sub as string)
      .maybeSingle();
    if (!buyer) return { reports: [] };

    const { data: reservations } = await db
      .from("pod_reservations")
      .select("property_id")
      .eq("buyer_account_id", buyer.id)
      .eq("status", "reserved");
    const propertyIds = [...new Set(((reservations ?? []) as Array<{ property_id: string }>).map((r) => r.property_id))];
    const reports = await loadReports(db, propertyIds);
    const annotations = await loadAnnotations(db, reports.map((r) => r.id), { buyerAccountId: buyer.id });
    return {
      reports: reports.map((r) => ({ ...r, annotations: annotations.filter((a) => a.report_id === r.id) })),
    };
  });

async function loadAnnotations(
  db: Db,
  reportIds: string[],
  scope: { buyerAccountId?: string; agentId?: string },
): Promise<ReportAnnotation[]> {
  if (reportIds.length === 0) return [];
  let q = db
    .from("report_annotations")
    .select("id, report_id, buyer_account_id, agent_id, note, created_at")
    .in("report_id", reportIds);
  if (scope.buyerAccountId) q = q.eq("buyer_account_id", scope.buyerAccountId);
  if (scope.agentId) q = q.eq("agent_id", scope.agentId);
  const { data } = await q.order("created_at", { ascending: true });
  const rows = (data ?? []) as Array<Omit<ReportAnnotation, "agent_name">>;
  const agentIds = [...new Set(rows.map((r) => r.agent_id))];
  const { data: agents } = agentIds.length
    ? await db.from("agents").select("id, full_name").in("id", agentIds)
    : { data: [] };
  const nameById = new Map(((agents ?? []) as Array<{ id: string; full_name: string | null }>).map((a) => [a.id, a.full_name]));
  return rows.map((r) => ({ ...r, agent_name: nameById.get(r.agent_id) ?? null }));
}

// ---------------------------------------------------------------------------
// Resident Agent
// ---------------------------------------------------------------------------

export interface AgentReportRow {
  buyerAccountId: string;
  buyerLabel: string;
  report: ReportView;
  annotations: ReportAnnotation[];
}

/** Reports on properties where this agent's tethered buyers hold reservations. */
export const listAgentReports = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ rows: AgentReportRow[] }> => {
    const db = await adminDb();
    const { data: agent } = await db
      .from("agents")
      .select("id")
      .eq("auth_user_id", context.claims?.sub as string)
      .maybeSingle();
    if (!agent) return { rows: [] };

    const { data: buyers } = await db
      .from("buyer_accounts")
      .select("id, email")
      .eq("tethered_resident_agent_id", agent.id);
    const buyerList = (buyers ?? []) as Array<{ id: string; email: string | null }>;
    if (buyerList.length === 0) return { rows: [] };

    const { data: reservations } = await db
      .from("pod_reservations")
      .select("buyer_account_id, property_id")
      .in("buyer_account_id", buyerList.map((b) => b.id))
      .eq("status", "reserved");
    const pairs = (reservations ?? []) as Array<{ buyer_account_id: string; property_id: string }>;
    const reports = await loadReports(db, [...new Set(pairs.map((p) => p.property_id))]);
    const annotations = await loadAnnotations(db, reports.map((r) => r.id), { agentId: agent.id });
    const emailById = new Map(buyerList.map((b) => [b.id, b.email]));

    const rows: AgentReportRow[] = [];
    for (const pair of pairs) {
      for (const report of reports.filter((r) => r.property_id === pair.property_id)) {
        rows.push({
          buyerAccountId: pair.buyer_account_id,
          buyerLabel: emailById.get(pair.buyer_account_id) ?? "Buyer Account",
          report,
          annotations: annotations.filter(
            (a) => a.report_id === report.id && a.buyer_account_id === pair.buyer_account_id,
          ),
        });
      }
    }
    return { rows };
  });

/** The Resident Agent's own note to their buyer — the only annotation layer. */
export const annotateReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { reportId: string; buyerAccountId: string; note: string }) => {
    if (!input?.reportId || !input?.buyerAccountId) throw new Error("Missing report");
    const note = input.note?.trim() ?? "";
    if (!note) throw new Error("Write a note first");
    if (note.length > 5000) throw new Error("Keep notes under 5,000 characters");
    return { ...input, note };
  })
  .handler(async ({ data, context }) => {
    const userId = context.claims?.sub as string;
    const db = await adminDb();
    const { data: agent } = await db
      .from("agents")
      .select("id, full_name")
      .eq("auth_user_id", userId)
      .maybeSingle();
    if (!agent) throw new Error("Only a Resident Agent can annotate reports");

    const { data: buyer } = await db
      .from("buyer_accounts")
      .select("id, auth_user_id, email, tethered_resident_agent_id")
      .eq("id", data.buyerAccountId)
      .maybeSingle();
    if (!buyer || buyer.tethered_resident_agent_id !== agent.id)
      throw new Error("You can only annotate for your own tethered buyers");

    const { data: report } = await db
      .from("property_reports")
      .select("id, property_id, report_type, title")
      .eq("id", data.reportId)
      .maybeSingle();
    if (!report) throw new Error("Report not found");

    const { data: reservation } = await db
      .from("pod_reservations")
      .select("id")
      .eq("buyer_account_id", buyer.id)
      .eq("property_id", report.property_id)
      .eq("status", "reserved")
      .limit(1);
    if (!((reservation ?? []) as unknown[]).length)
      throw new Error("This buyer does not hold a reservation on this property");

    const { data: created, error } = await db
      .from("report_annotations")
      .insert({ report_id: report.id, buyer_account_id: buyer.id, agent_id: agent.id, note: data.note })
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);

    await db.from("audit_log").insert({
      actor_id: userId,
      actor_type: "agent",
      action_type: "report.annotated",
      entity_type: "property_report",
      entity_id: report.id,
      metadata: { buyer_account_id: buyer.id, agent_id: agent.id, annotation_id: created?.id ?? null },
    });

    const { deliver } = await import("@/lib/authorization.notify.server");
    await deliver(
      db,
      { authUserId: buyer.auth_user_id, email: buyer.email },
      {
        subject: `Your Resident Agent added a note on "${report.title}"`,
        message: `${agent.full_name ?? "Your Resident Agent"} added a note on "${report.title}". Open your reports to read it.`,
        link: "/buyer/reports",
        type: "report",
      },
    );
    return { id: created?.id as string };
  });
