import { AGENT_ACK_DEADLINE_DAYS, agentDeadline } from "@/lib/due-diligence";

/**
 * Parallel Resident Agent acknowledgment escalation.
 *
 * When a Required document has been sitting for more than 7 calendar days
 * without the tethered Resident Agent's acknowledgment, alert the agent, their
 * Broker of Record, and the buyer. The buyer keeps the existing Module 7
 * re-tethering option — nothing about tethering is rebuilt here.
 *
 * Idempotent: each (document, buyer account) escalates once, detected by an
 * existing `diligence.agent_ack_overdue` audit row.
 */

type Db = { from: (t: string) => any };

export interface DiligenceEscalationRow {
  documentId: string;
  documentTitle: string;
  buyerAccountId: string;
  agentId: string | null;
  daysWaiting: number;
}

export interface DiligenceEscalationResult {
  scanned: number;
  escalated: number;
  rows: DiligenceEscalationRow[];
}

async function notify(db: Db, authUserId: string | null, message: string, type: string) {
  if (!authUserId) return;
  await db.from("notifications").insert({ seller_id: authUserId, message, type });
}

export async function runDiligenceEscalationSweep(): Promise<DiligenceEscalationResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  const db = supabaseAdmin as unknown as Db;
  const now = Date.now();
  const cutoff = new Date(now - AGENT_ACK_DEADLINE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: docs } = await db
    .from("due_diligence_inventory")
    .select("id, property_id, document_title, content_hash, placed_at")
    .eq("required", true)
    .is("superseded_by", null)
    .lte("placed_at", cutoff);

  const documents = (docs ?? []) as any[];
  const rows: DiligenceEscalationRow[] = [];
  let scanned = 0;

  for (const doc of documents) {
    const { data: reservations } = await db
      .from("pod_reservations")
      .select("buyer_account_id")
      .eq("property_id", doc.property_id)
      .eq("status", "reserved");

    const buyerIds = [
      ...new Set(((reservations ?? []) as any[]).map((r) => r.buyer_account_id as string)),
    ];

    for (const buyerAccountId of buyerIds) {
      scanned += 1;

      const { data: agentAcks } = await db
        .from("due_diligence_acknowledgments")
        .select("agent_id")
        .eq("document_id", doc.id)
        .eq("buyer_account_id", buyerAccountId)
        .eq("actor_role", "resident_agent")
        .eq("content_hash", doc.content_hash);

      const { data: already } = await db
        .from("audit_log")
        .select("id")
        .eq("action_type", "diligence.agent_ack_overdue")
        .eq("entity_id", doc.id)
        .contains("metadata", { buyer_account_id: buyerAccountId, content_hash: doc.content_hash })
        .maybeSingle();
      if (already) continue;

      const { data: buyer } = await db
        .from("buyer_accounts")
        .select("id, auth_user_id, tethered_resident_agent_id")
        .eq("id", buyerAccountId)
        .maybeSingle();
      if (!buyer) continue;
      // Only the currently tethered agent's acknowledgment satisfies the gate.
      if (
        ((agentAcks ?? []) as any[]).some(
          (a) => a.agent_id === buyer.tethered_resident_agent_id,
        )
      )
        continue;

      let agentUser: string | null = null;
      let brokerUser: string | null = null;
      let agentName = "your Resident Agent";
      if (buyer.tethered_resident_agent_id) {
        const { data: agent } = await db
          .from("agents")
          .select("id, auth_user_id, full_name, broker_id")
          .eq("id", buyer.tethered_resident_agent_id)
          .maybeSingle();
        if (agent) {
          agentUser = agent.auth_user_id ?? null;
          agentName = agent.full_name ?? agentName;
          if (agent.broker_id) {
            const { data: broker } = await db
              .from("brokers")
              .select("id, auth_user_id")
              .eq("id", agent.broker_id)
              .maybeSingle();
            brokerUser = broker?.auth_user_id ?? null;
          }
        }
      }

      const days = Math.floor(
        (now - agentDeadline(doc.placed_at).getTime()) / (24 * 60 * 60 * 1000) +
          AGENT_ACK_DEADLINE_DAYS,
      );

      await notify(
        db,
        agentUser,
        `Overdue: acknowledge "${doc.document_title}" for your tethered Buyer Account — the ${AGENT_ACK_DEADLINE_DAYS}-day window has passed.`,
        "diligence",
      );
      await notify(
        db,
        brokerUser,
        `Your sponsored agent ${agentName} has not acknowledged the due-diligence document "${doc.document_title}" within ${AGENT_ACK_DEADLINE_DAYS} calendar days.`,
        "diligence",
      );
      await notify(
        db,
        buyer.auth_user_id ?? null,
        `Your Resident Agent has not yet acknowledged "${doc.document_title}". If this becomes material to you, you may request re-tethering to a different Resident Agent from your dashboard.`,
        "diligence",
      );

      await db.from("audit_log").insert({
        actor_id: agentUser,
        actor_type: "system",
        action_type: "diligence.agent_ack_overdue",
        entity_type: "diligence_document",
        entity_id: doc.id,
        metadata: {
          buyer_account_id: buyerAccountId,
          content_hash: doc.content_hash,
          property_id: doc.property_id,
          agent_id: buyer.tethered_resident_agent_id,
          days_waiting: days,
          escalated_to: ["agent", "broker_of_record", "buyer"],
        },
      });

      rows.push({
        documentId: doc.id,
        documentTitle: doc.document_title,
        buyerAccountId,
        agentId: buyer.tethered_resident_agent_id ?? null,
        daysWaiting: days,
      });
    }
  }

  return { scanned, escalated: rows.length, rows };
}
