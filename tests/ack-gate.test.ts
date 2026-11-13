/** Prompt 14 — late-arriving document re-trigger, closing-funds wire gate, Final Acknowledgment Posture Record. */
import { describe, it, expect } from "vitest";
import { harness } from "./setup";
import { IDS, USERS } from "./fixtures";
import { seedClosing } from "./closing-fixture";
import { acknowledgmentGate, accountsOnProperty, recordRetrigger, buildPosture, generatePostureRecord, PostureIncompleteError } from "@/lib/ack-gate.server";
import { generateAndTransmit } from "@/lib/settlement.server";
import { simulateMilestone } from "@/lib/title-escrow.server";

const db = () => harness.db;
const gate = async (b: string) => acknowledgmentGate(db() as never, IDS.property, b);
const buyerId = () => db().table("buyer_accounts")[0]!.id as string;
const T = "2026-10-01T00:00:00.000Z";

function addDoc(id: string, title: string, hash: string, supersedes?: string) {
  if (supersedes) for (const d of db().table("due_diligence_inventory")) if (d.id === supersedes) d.superseded_by = id;
  db().seed("due_diligence_inventory", [
    {
      id,
      property_id: IDS.property,
      document_title: title,
      required: true,
      content_hash: hash,
      placed_at: new Date(Date.parse(T) + db().table("due_diligence_inventory").length * 1000).toISOString(),
      superseded_by: null,
      is_governing_instrument: false,
    },
  ]);
}

/** Everyone who owes the document acknowledges it (typed signature, with IP and device). */
async function everyoneAcknowledges(docId: string, hash: string) {
  for (const acct of await accountsOnProperty(db() as never, IDS.property)) {
    const g = await gate(acct);
    for (const m of g.missing.filter((x) => x.documentId === docId)) {
      db().seed("due_diligence_acknowledgments", [
        {
          document_id: docId,
          buyer_account_id: acct,
          actor_role: m.who === "agent" ? "resident_agent" : "account_member",
          account_member_id: m.memberId ?? null,
          agent_id: m.agentId ?? null,
          content_hash: hash,
          ip_address: "203.0.113.9",
          device_fingerprint: "dev-1",
          user_agent: "UA",
          signed_name: m.name,
          acknowledged_at: T,
        },
      ]);
    }
  }
}

async function ready() {
  await seedClosing();
  addDoc("doc-1", "Title Commitment", "h1");
  await everyoneAcknowledges("doc-1", "h1");
}

describe("Prompt 14 — acknowledgment gate", () => {
  it("is clear once every member and the Resident Agent have acknowledged", async () => {
    await ready();
    const g = await gate(buyerId());
    expect(g.clear).toBe(true);
    expect(g.members.length).toBeGreaterThan(0);
    expect(g.agent).not.toBeNull();
  });

  it("a Required document added late re-closes the gate for everyone who has not acknowledged it; old acks stay", async () => {
    await ready();
    const acksBefore = db().table("due_diligence_acknowledgments").length;
    addDoc("late-doc", "Late Roof Report", "h-late");
    const g = await gate(buyerId());
    expect(g.clear).toBe(false);
    expect(g.missing.every((m) => m.documentId === "late-doc")).toBe(true);
    expect(g.missing.some((m) => m.who === "member")).toBe(true);
    expect(g.missing.some((m) => m.who === "agent")).toBe(true);
    expect(g.message).toMatch(/stay locked until every member/);
    expect(g.message).toMatch(/Late Roof Report/);
    expect(db().table("due_diligence_acknowledgments")).toHaveLength(acksBefore);
    await recordRetrigger(db() as never, { documentId: "late-doc", propertyId: IDS.property, actorId: USERS.admin });
    expect(db().table("diligence_retriggers")[0]).toMatchObject({ document_id: "late-doc", kind: "new_required_document" });
    await everyoneAcknowledges("late-doc", "h-late");
    expect((await gate(buyerId())).clear).toBe(true);
  });

  it("a new version re-closes the gate; the older version acknowledgments stay recorded", async () => {
    await ready();
    addDoc("doc-1b", "Title Commitment", "h1b", "doc-1");
    const g = await gate(buyerId());
    expect(g.clear).toBe(false);
    expect(g.missing[0]).toMatchObject({ documentId: "doc-1b", version: 2 });
    await recordRetrigger(db() as never, { documentId: "doc-1b", propertyId: IDS.property, priorDocumentId: "doc-1", actorId: USERS.admin });
    expect(db().table("diligence_retriggers")[0]).toMatchObject({ kind: "new_version", prior_document_id: "doc-1" });
    expect(db().table("due_diligence_acknowledgments").filter((a) => a.document_id === "doc-1").length).toBeGreaterThan(0);
  });

  it("one member missing keeps the gate closed and names that member", async () => {
    await ready();
    const acks = db().table("due_diligence_acknowledgments");
    acks.splice(
      acks.findIndex((a) => a.actor_role === "account_member"),
      1,
    );
    const g = await gate(buyerId());
    expect(g.clear).toBe(false);
    expect(g.missing).toHaveLength(1);
    expect(g.missing[0]!.who).toBe("member");
  });

  it("an acknowledgment of an older content hash does not count", async () => {
    await ready();
    for (const a of db().table("due_diligence_acknowledgments")) a.content_hash = "stale";
    expect((await gate(buyerId())).clear).toBe(false);
  });
});

describe("Prompt 14 — Final Acknowledgment Posture Record", () => {
  it("lists every member and agent with versions, time, IP/device, method, and a hash; reused when nothing changed", async () => {
    await ready();
    addDoc("doc-1b", "Title Commitment", "h1b", "doc-1");
    await everyoneAcknowledges("doc-1b", "h1b");
    await recordRetrigger(db() as never, { documentId: "doc-1b", propertyId: IDS.property, priorDocumentId: "doc-1", actorId: USERS.admin });
    const { data } = await buildPosture(db() as never, IDS.property);
    const acct = data.buyer_accounts[0]!;
    expect(acct.members.length).toBeGreaterThan(0);
    for (const m of acct.members) {
      expect(m.acknowledgments.map((a) => a.version)).toEqual([1, 2]);
      expect(m.acknowledgments[0]).toMatchObject({ ip_address: "203.0.113.9", device_fingerprint: "dev-1", method: "typed_signature" });
      expect(m.missing).toEqual([]);
    }
    expect(acct.agent!.acknowledgments).toHaveLength(2);
    expect(data.retriggers).toHaveLength(1);
    expect(data.summary.complete).toBe(true);
    const rec = await generatePostureRecord(db() as never, { propertyId: IDS.property, sagaKey: IDS.property });
    expect(rec.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.version).toBe(1);
    const again = await generatePostureRecord(db() as never, { propertyId: IDS.property, sagaKey: IDS.property });
    expect(again.id).toBe(rec.id);
    expect(db().table("acknowledgment_posture_records")).toHaveLength(1);
    expect(db().table("audit_log").some((a) => a.action_type === "diligence.posture_record_generated")).toBe(true);
  });

  it("is refused if one acknowledgment is missing", async () => {
    await ready();
    db().table("due_diligence_acknowledgments").splice(0, 1);
    await expect(generatePostureRecord(db() as never, { propertyId: IDS.property })).rejects.toBeInstanceOf(PostureIncompleteError);
    expect(db().table("acknowledgment_posture_records")).toHaveLength(0);
  });

  it("the Closing Ping Saga fails to the dead-letter queue if an acknowledgment goes missing", async () => {
    await ready();
    const r = await generateAndTransmit(db() as never, USERS.admin, IDS.property);
    expect(r.status).toBe("transmitted");
    db().table("due_diligence_acknowledgments").splice(0, 1);
    const failed = await simulateMilestone(db() as never, USERS.admin, IDS.property, "funded_and_recorded", {});
    expect((failed as { closingSaga?: string }).closingSaga).toBe("failed");
    expect(db().table("saga_failures").some((f) => f.failed_step === "1_verify_source_of_truth" && /acknowledg/i.test(String(f.error_detail)))).toBe(true);
    expect(db().table("property_records_vault").some((v) => v.document_type === "acknowledgment_posture")).toBe(false);
  });

  it("generateAndTransmit is blocked while the gate is open", async () => {
    await ready();
    addDoc("late-doc", "Late Roof Report", "h-late");
    const r = await generateAndTransmit(db() as never, USERS.admin, IDS.property);
    expect(r.status).not.toBe("transmitted");
  });
});
