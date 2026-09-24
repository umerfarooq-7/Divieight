/**
 * Broker Closing Hold → closing flow checkpoints (Prompt 14).
 *
 * Reads the existing `pods.closing_hold_active` flag (Month 3, Prompt 15) —
 * it never places or lifts holds. Used before a Source of Truth is generated
 * and at the start of every Closing Ping Saga step, so a hold placed while the
 * saga is running halts it at the next step with a clear reason.
 */
import { deliver } from "@/lib/authorization.notify.server";
import { NonRetryableError } from "@/lib/saga/orchestrator.server";

type Db = { from: (t: string) => any };

export interface ClosingHoldStatus {
  active: boolean;
  podId: string | null;
  reason: string | null;
  placedAt: string | null;
  placedByBrokerName: string | null;
  /** Only the Broker of Record of the pod's accepted HLA can lift a hold. */
  liftBrokerId: string | null;
  liftBrokerName: string | null;
  liftBrokerUserId: string | null;
}

export async function closingHoldStatus(db: Db, propertyId: string): Promise<ClosingHoldStatus> {
  const { data: pod } = await db
    .from("pods")
    .select("id, heavy_lifting_agent_id, hla_status, closing_hold_active, closing_hold_reason, closing_hold_placed_at, closing_hold_placed_by")
    .eq("property_id", propertyId)
    .maybeSingle();
  const status: ClosingHoldStatus = {
    active: Boolean(pod?.closing_hold_active),
    podId: pod?.id ?? null,
    reason: pod?.closing_hold_reason ?? null,
    placedAt: pod?.closing_hold_placed_at ?? null,
    placedByBrokerName: null,
    liftBrokerId: null,
    liftBrokerName: null,
    liftBrokerUserId: null,
  };
  if (!pod) return status;
  if (pod.closing_hold_placed_by) {
    const { data: b } = await db.from("brokers").select("brokerage_name").eq("id", pod.closing_hold_placed_by).maybeSingle();
    status.placedByBrokerName = b?.brokerage_name ?? null;
  }
  if (pod.hla_status === "accepted" && pod.heavy_lifting_agent_id) {
    const { data: hla } = await db.from("agents").select("broker_id").eq("id", pod.heavy_lifting_agent_id).maybeSingle();
    if (hla?.broker_id) {
      const { data: b } = await db.from("brokers").select("id, brokerage_name, auth_user_id").eq("id", hla.broker_id).maybeSingle();
      status.liftBrokerId = b?.id ?? null;
      status.liftBrokerName = b?.brokerage_name ?? null;
      status.liftBrokerUserId = b?.auth_user_id ?? null;
    }
  }
  return status;
}

export function closingHoldMessage(s: ClosingHoldStatus) {
  const placed = s.placedAt ? ` on ${new Date(s.placedAt).toISOString().slice(0, 10)}` : "";
  return (
    `Closing hold active — reason: "${s.reason ?? "no reason given"}" (placed by ${s.placedByBrokerName ?? "the Broker of Record"}${placed}). ` +
    `Only ${s.liftBrokerName ?? "the Heavy Lifting Agent's Broker of Record"} can lift it, from /broker/closing-holds.`
  );
}

/** Tell the lifting broker (and admins) once per hold per checkpoint. */
async function notifyBlocked(db: Db, propertyId: string, s: ClosingHoldStatus, checkpoint: string) {
  const { data: p } = await db.from("properties").select("address, city, state").eq("id", propertyId).maybeSingle();
  const where = p ? `${p.address}, ${p.city}, ${p.state}` : "a property";
  const { data: admins } = await db.from("user_roles").select("user_id").eq("role", "admin");
  const targets: Array<{ who: string; authUserId: string; link: string }> = [];
  if (s.liftBrokerUserId) targets.push({ who: `broker:${s.liftBrokerId}`, authUserId: s.liftBrokerUserId, link: "/broker/closing-holds" });
  for (const a of (admins ?? []) as Array<{ user_id: string }>) targets.push({ who: `admin:${a.user_id}`, authUserId: a.user_id, link: "/admin/closing-readiness" });
  for (const t of targets) {
    const key = `closing-hold-block:${s.podId}:${s.placedAt ?? "?"}:${checkpoint}:${t.who}`;
    const { error } = await db.from("saga_notifications_sent").insert({ idempotency_key: key, recipient: t.who, status: "sent", sent_at: new Date().toISOString() });
    if (error) continue; // already told about this hold at this checkpoint
    await deliver(
      db,
      { authUserId: t.authUserId, email: null },
      {
        subject: "Closing blocked by a Broker Closing Hold",
        message: `The closing for ${where} is stopped at ${checkpoint.replace(/_/g, " ")}. ${closingHoldMessage(s)}`,
        link: t.link,
        type: "closing_hold",
      },
    );
  }
}

/** Checkpoint: throws a NonRetryableError with the hold's reason if a hold is active. */
export async function assertNoClosingHold(db: Db, propertyId: string, checkpoint: string) {
  const s = await closingHoldStatus(db, propertyId);
  if (!s.active) return s;
  await db.from("audit_log").insert({
    actor_id: null,
    actor_type: "system",
    action_type: "closing_hold.blocked",
    entity_type: "property",
    entity_id: propertyId,
    metadata: { checkpoint, reason: s.reason, placed_at: s.placedAt, lift_broker_id: s.liftBrokerId },
  });
  await notifyBlocked(db, propertyId, s, checkpoint);
  throw new NonRetryableError(closingHoldMessage(s));
}
