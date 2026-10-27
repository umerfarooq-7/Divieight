import { withPropertyAgents } from "@/lib/property-agent.server";
/**
 * Due-diligence notifications (server-only).
 *
 * Two entry points, same audience rules:
 *  - a new/amended Required document is placed  -> tell every reserved Buyer
 *    Account in that property and their tethered Resident Agents;
 *  - a Buyer Account reserves a share           -> tell that buyer (and their
 *    agent) about the Required documents already on file, so a buyer who joins
 *    after the documents were placed still sees the acknowledgment prompt.
 */

type Db = { from: (t: string) => any };

async function insertNotification(
  db: Db,
  row: { authUserId: string; message: string },
) {
  const { error } = await db
    .from("notifications")
    .insert({ seller_id: row.authUserId, message: row.message, type: "diligence" });
  if (error) {
    await db.from("audit_log").insert({
      actor_id: null,
      actor_type: "system",
      action_type: "diligence.notification_failed",
      entity_type: "notification",
      metadata: { auth_user_id: row.authUserId, error: error.message },
    });
  }
}

async function agentAuthUserId(db: Db, agentId: string): Promise<string | null> {
  const { data } = await db
    .from("agents")
    .select("id, auth_user_id")
    .eq("id", agentId)
    .maybeSingle();
  return (data?.auth_user_id as string | undefined) ?? null;
}

export async function notifyNewRequiredDocument(
  db: Db,
  doc: { id: string; property_id: string; document_title: string; amended: boolean },
) {
  const { data: reservations } = await db
    .from("pod_reservations")
    .select("buyer_account_id")
    .eq("property_id", doc.property_id)
    .eq("status", "reserved");

  const buyerIds = [
    ...new Set(((reservations ?? []) as any[]).map((r) => r.buyer_account_id as string)),
  ];
  if (buyerIds.length === 0) return;

  const { data: buyerRows } = await db
    .from("buyer_accounts")
    .select("id, auth_user_id, tethered_resident_agent_id")
    .in("id", buyerIds);
  // Each buyer's agent on this document's property.
  const buyers = await withPropertyAgents(db, doc.property_id, (buyerRows ?? []) as any[]);

  const buyerMessage = doc.amended
    ? `An updated version of "${doc.document_title}" is on file — your prior acknowledgment no longer applies, please review and acknowledge the current version.`
    : `A new required due-diligence document is available: "${doc.document_title}". Please review and acknowledge it.`;
  const agentMessage = doc.amended
    ? `An updated version of "${doc.document_title}" requires a fresh acknowledgment for your tethered Buyer Account.`
    : `A new required due-diligence document, "${doc.document_title}", awaits your parallel acknowledgment.`;

  const agentIds = new Set<string>();
  for (const b of (buyers ?? []) as any[]) {
    if (b.auth_user_id) await insertNotification(db, { authUserId: b.auth_user_id, message: buyerMessage });
    if (b.tethered_resident_agent_id) agentIds.add(b.tethered_resident_agent_id as string);
  }

  for (const agentId of agentIds) {
    const authUserId = await agentAuthUserId(db, agentId);
    if (authUserId) await insertNotification(db, { authUserId, message: agentMessage });
  }
}

/** Catch-up notice when a buyer reserves into a property that already has Required documents. */
export async function notifyOutstandingDiligence(
  db: Db,
  input: { propertyId: string; buyerAccountId: string },
) {
  const { data: docs } = await db
    .from("due_diligence_inventory")
    .select("id, document_title, required, superseded_by")
    .eq("property_id", input.propertyId)
    .eq("required", true)
    .is("superseded_by", null);

  const pending = (docs ?? []) as any[];
  if (pending.length === 0) return;

  const { data: buyerRow } = await db
    .from("buyer_accounts")
    .select("id, auth_user_id, tethered_resident_agent_id")
    .eq("id", input.buyerAccountId)
    .maybeSingle();
  if (!buyerRow) return;
  const [buyer] = await withPropertyAgents(db, input.propertyId, [buyerRow as any]);

  const count = pending.length;
  const noun = count === 1 ? "document" : "documents";
  if (buyer.auth_user_id) {
    await insertNotification(db, {
      authUserId: buyer.auth_user_id,
      message: `${count} required due-diligence ${noun} await your acknowledgment for this property. Open "Due diligence" on your dashboard to review and acknowledge.`,
    });
  }
  if (buyer.tethered_resident_agent_id) {
    const authUserId = await agentAuthUserId(db, buyer.tethered_resident_agent_id as string);
    if (authUserId) {
      await insertNotification(db, {
        authUserId,
        message: `${count} required due-diligence ${noun} await your parallel acknowledgment for a tethered Buyer Account.`,
      });
    }
  }
}
