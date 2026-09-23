/**
 * Appraisal & Inspection Report Delivery — server side.
 *
 * One upload lands in the two EXISTING stores — the Virtual Data Room
 * (property_documents) and the Due Diligence Inventory as a Required document
 * — and `property_reports` records the delivery that links them. Every step
 * (receipt, storage, flagging, delivery, notification) is audited.
 */
import { deliver } from "@/lib/authorization.notify.server";
import {
  DEFAULT_APPRAISAL_SHORTFALL_PERCENT,
  DELIVERY_NOTICE,
  FLAG_NOTICE,
  REPORT_TYPE_LABELS,
  detectReportFlags,
  type ReportFlag,
  type ReportType,
} from "@/lib/reports";

type Db = { from: (t: string) => any };

async function audit(
  db: Db,
  row: { actorId: string | null; actorType?: string; actionType: string; entityId?: string | null; metadata?: Record<string, unknown> },
) {
  await db.from("audit_log").insert({
    actor_id: row.actorId,
    actor_type: row.actorType ?? "admin",
    action_type: row.actionType,
    entity_type: "property_report",
    entity_id: row.entityId ?? null,
    metadata: row.metadata ?? {},
  });
}

async function shortfallThreshold(db: Db): Promise<number> {
  const { data } = await db
    .from("platform_settings")
    .select("value")
    .eq("key", "report_flags")
    .maybeSingle();
  const v = Number((data?.value as Record<string, unknown> | undefined)?.["appraisal_shortfall_percent"]);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_APPRAISAL_SHORTFALL_PERCENT;
}

export interface DeliverReportInput {
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
  /** A revised report replaces this one (and its Required document). */
  supersedesReportId?: string | null;
}

export async function deliverReport(db: Db, actorId: string, input: DeliverReportInput) {
  const typeLabel = REPORT_TYPE_LABELS[input.reportType];

  // Fail before writing anything if the schema isn't in place yet.
  const { error: schemaError } = await db.from("property_reports").select("id").limit(1);
  if (schemaError)
    throw new Error("Database is missing property_reports — run report-delivery.sql in Supabase.");

  const { data: property } = await db
    .from("properties")
    .select("id, address, city, state")
    .eq("id", input.propertyId)
    .maybeSingle();
  if (!property) throw new Error("Property not found");
  const where = `${property.address}, ${property.city}, ${property.state}`;

  await audit(db, {
    actorId,
    actionType: "report.received",
    entityId: null,
    metadata: {
      property_id: input.propertyId,
      report_type: input.reportType,
      vendor_name: input.vendorName ?? null,
      report_date: input.reportDate ?? null,
      content_hash: input.contentHash,
    },
  });

  // 1. Virtual Data Room — the general storage/browsing library.
  const { data: vdr, error: vdrError } = await db
    .from("property_documents")
    .insert({
      property_id: input.propertyId,
      document_name: input.title,
      document_type: input.reportType,
      file_url: input.fileUrl,
      uploaded_by: actorId,
    })
    .select("id")
    .maybeSingle();
  if (vdrError || !vdr) throw new Error(vdrError?.message ?? "Could not store the report in the Data Room");

  // A revision supersedes the previous report's Required document, so prior
  // acknowledgments stay in the Audit Vault but stop being current.
  let priorDiligenceId: string | null = null;
  if (input.supersedesReportId) {
    const { data: prior } = await db
      .from("property_reports")
      .select("id, diligence_document_id, property_id")
      .eq("id", input.supersedesReportId)
      .maybeSingle();
    if (prior?.property_id === input.propertyId) priorDiligenceId = prior.diligence_document_id ?? null;
  }

  // 2. Due Diligence Inventory — Required, not a governing instrument.
  const { data: dd, error: ddError } = await db
    .from("due_diligence_inventory")
    .insert({
      property_id: input.propertyId,
      document_title: input.title,
      category: input.reportType,
      file_url: input.fileUrl,
      content_hash: input.contentHash,
      required: true,
      is_governing_instrument: false,
    })
    .select("id")
    .maybeSingle();
  if (ddError || !dd) throw new Error(ddError?.message ?? "Could not add the report to the Due Diligence Inventory");

  if (priorDiligenceId) {
    await db.from("due_diligence_inventory").update({ superseded_by: dd.id }).eq("id", priorDiligenceId);
    await db.from("audit_log").insert({
      actor_id: actorId,
      actor_type: "system",
      action_type: "diligence.reacknowledgment_required",
      entity_type: "diligence_document",
      entity_id: dd.id,
      metadata: { property_id: input.propertyId, reason: "revised_report", prior_document_id: priorDiligenceId },
    });
  }
  await db.from("audit_log").insert({
    actor_id: actorId,
    actor_type: "admin",
    action_type: "diligence.document_placed",
    entity_type: "diligence_document",
    entity_id: dd.id,
    metadata: {
      property_id: input.propertyId,
      category: input.reportType,
      required: true,
      is_governing_instrument: false,
      content_hash: input.contentHash,
      source: "report_delivery",
    },
  });

  // 3. Material-Adverse-Finding filter (non-substantive).
  const flags: ReportFlag[] = detectReportFlags({
    reportType: input.reportType,
    contractPrice: input.contractPrice ?? null,
    appraisedValue: input.appraisedValue ?? null,
    reportText: input.reportText ?? null,
    shortfallThresholdPercent: await shortfallThreshold(db),
  });

  const { data: report, error: reportError } = await db
    .from("property_reports")
    .insert({
      property_id: input.propertyId,
      report_type: input.reportType,
      title: input.title,
      vendor_name: input.vendorName ?? null,
      report_date: input.reportDate ?? null,
      file_url: input.fileUrl,
      content_hash: input.contentHash,
      data_room_document_id: vdr.id,
      diligence_document_id: dd.id,
      contract_price: input.contractPrice ?? null,
      appraised_value: input.appraisedValue ?? null,
      report_text: input.reportText ?? null,
      flags,
      supersedes_report_id: input.supersedesReportId ?? null,
      received_by: actorId,
    })
    .select("id")
    .maybeSingle();
  if (reportError || !report)
    throw new Error(reportError?.message ?? "Could not record the report delivery");

  await audit(db, {
    actorId,
    actionType: "report.stored",
    entityId: report.id,
    metadata: {
      property_id: input.propertyId,
      data_room_document_id: vdr.id,
      diligence_document_id: dd.id,
      supersedes_report_id: input.supersedesReportId ?? null,
    },
  });

  if (flags.length > 0) {
    await audit(db, {
      actorId,
      actorType: "system",
      actionType: "report.flagged",
      entityId: report.id,
      metadata: { property_id: input.propertyId, flags },
    });
  }

  // 4. Delivery to every reserved Buyer Account and its tethered Resident Agent.
  const { data: reservations } = await db
    .from("pod_reservations")
    .select("buyer_account_id")
    .eq("property_id", input.propertyId)
    .eq("status", "reserved");
  const buyerIds = [...new Set(((reservations ?? []) as Array<{ buyer_account_id: string }>).map((r) => r.buyer_account_id))];

  const { data: buyers } = buyerIds.length
    ? await db
        .from("buyer_accounts")
        .select("id, auth_user_id, email, tethered_resident_agent_id")
        .in("id", buyerIds)
    : { data: [] };

  const agentIds = [
    ...new Set(((buyers ?? []) as any[]).map((b) => b.tethered_resident_agent_id).filter(Boolean)),
  ] as string[];
  const { data: agents } = agentIds.length
    ? await db.from("agents").select("id, auth_user_id, email").in("id", agentIds)
    : { data: [] };
  const agentById = new Map(((agents ?? []) as any[]).map((a) => [a.id, a]));

  const revised = input.supersedesReportId ? "A revised " : "A ";
  const buyerMessage = `${revised}${typeLabel.toLowerCase()} for ${where} has been received and is available in your portal. It is a Required due-diligence document, so please review and acknowledge it. ${DELIVERY_NOTICE}`;
  const agentMessage = `${revised}${typeLabel.toLowerCase()} for ${where} has been delivered to your buyer and is available on your agent dashboard. It is a Required due-diligence document awaiting your parallel acknowledgment. You may add your own notes for your buyer.`;
  const flagLines = flags.map((f) => f.message).join(" ");
  const flagMessage = `PRIORITY — ${typeLabel} for ${where}: ${flagLines} ${FLAG_NOTICE}`;

  let buyerNotices = 0;
  let agentNotices = 0;
  const notifiedAgents = new Set<string>();
  for (const b of (buyers ?? []) as any[]) {
    const recipient = { authUserId: b.auth_user_id, email: b.email };
    await deliver(db, recipient, {
      subject: `${typeLabel} available — ${property.address}`,
      message: buyerMessage,
      link: "/buyer/reports",
      type: "report",
    });
    if (flags.length > 0) {
      await deliver(db, recipient, {
        subject: `Priority: flagged finding in ${typeLabel.toLowerCase()} — ${property.address}`,
        message: flagMessage,
        link: "/buyer/reports",
        type: "report_flag",
      });
    }
    buyerNotices++;

    const agent = b.tethered_resident_agent_id ? agentById.get(b.tethered_resident_agent_id) : null;
    if (agent && !notifiedAgents.has(agent.id)) {
      notifiedAgents.add(agent.id);
      const ra = { authUserId: agent.auth_user_id, email: agent.email };
      await deliver(db, ra, {
        subject: `${typeLabel} delivered — ${property.address}`,
        message: agentMessage,
        link: "/agent/reports",
        type: "report",
      });
      if (flags.length > 0) {
        await deliver(db, ra, {
          subject: `Priority: flagged finding in ${typeLabel.toLowerCase()} — ${property.address}`,
          message: flagMessage,
          link: "/agent/reports",
          type: "report_flag",
        });
      }
      agentNotices++;
    }
  }

  await audit(db, {
    actorId,
    actorType: "system",
    actionType: "report.delivered",
    entityId: report.id,
    metadata: {
      property_id: input.propertyId,
      buyer_accounts: buyerIds,
      resident_agents: [...notifiedAgents],
    },
  });
  await audit(db, {
    actorId,
    actorType: "system",
    actionType: "report.notifications_sent",
    entityId: report.id,
    metadata: {
      buyer_notices: buyerNotices,
      agent_notices: agentNotices,
      priority: flags.length > 0,
      channels: ["in_app", "email"],
    },
  });

  return { id: report.id as string, flags, buyerNotices, agentNotices };
}
