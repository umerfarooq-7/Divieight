/**
 * Closing Ping Saga (Prompt 13) — runs on the Prompt 12 orchestrator.
 *
 * Triggered by the title company's 'funded_and_recorded' webhook. Seven steps,
 * each individually idempotent and retried; anything that can't complete lands
 * in saga_failures. A resumed saga skips completed steps, so governance is never
 * double-activated and "Deal Closed" is never re-sent.
 *
 * ⚠️ Instruction/status only: commissions are marked payable BY TITLE/ESCROW
 * from sale proceeds. No step moves money.
 */
import { deliver } from "@/lib/authorization.notify.server";
import { renderTextPdf } from "@/lib/simple-pdf";
import { runSaga, type SagaEvent, type SagaOutcome, type SagaStep, type SagaStepContext } from "@/lib/saga/orchestrator.server";
import type { SourceOfTruth } from "@/lib/settlement.server";

type Db = { from: (t: string) => any; storage?: any };

export const CLOSING_SAGA_TYPE = "closing_ping";
const RETENTION_MONTHS = 12;
const BUCKET = "property-documents";

async function audit(db: Db, propertyId: string, actionType: string, metadata: Record<string, unknown>) {
  await db.from("audit_log").insert({
    actor_id: null,
    actor_type: "system",
    action_type: `closing_saga.${actionType}`,
    entity_type: "property",
    entity_id: propertyId,
    metadata,
  });
}

/** The title company's final numbers and recording, from the funded webhook. */
async function fundedEvent(db: Db, propertyId: string) {
  const { data: order } = await db.from("title_escrow_orders").select("provider").eq("property_id", propertyId).maybeSingle();
  const { data: events } = await db
    .from("title_escrow_events")
    .select("id, raw_payload, received_at")
    .eq("property_id", propertyId)
    .eq("milestone", "funded_and_recorded")
    .order("received_at", { ascending: false })
    .limit(1);
  const ev = ((events ?? []) as Array<{ id: string; raw_payload: unknown }>)[0];
  if (!order || !ev) return null;
  const { getTitleAdapter } = await import("@/lib/title-adapters");
  const parsed = getTitleAdapter(order.provider).parseWebhook(JSON.stringify(ev.raw_payload));
  return parsed ? { eventId: ev.id, ...parsed } : null;
}

async function currentSot(db: Db, propertyId: string) {
  const { latestSourceOfTruth } = await import("@/lib/settlement.server");
  const sot = await latestSourceOfTruth(db, propertyId);
  if (!sot) throw new Error("No transmitted Source of Truth for this property — generate it (Prompt 11) before closing.");
  return sot;
}

function payeeKey(p: { brokerId: string; amountCents: number }) {
  return `${p.brokerId}:${p.amountCents}`;
}

// ---------------------------------------------------------------------------
// The seven steps
// ---------------------------------------------------------------------------

function steps(db: Db, propertyId: string): SagaStep[] {
  /** 1. Source of Truth exists, is current, and every pre-closing gate passes NOW. */
  const verify: SagaStep = {
    name: "1_verify_source_of_truth",
    maxAttempts: 2,
    run: async () => {
      const sot = await currentSot(db, propertyId);
      const { settlementPreconditions, loadParticipants, compileSourceOfTruth } = await import("@/lib/settlement.server");
      const parts = await loadParticipants(db, propertyId);
      const blockers = await settlementPreconditions(db, propertyId, parts);
      if (blockers.length) throw new Error(`Pre-closing gates no longer pass: ${blockers.map((b) => `${b.code} (${b.message})`).join("; ")}`);
      const fresh = compileSourceOfTruth(parts, sot.id, sot.version);
      const stored = (sot.structured as SourceOfTruth).payees.map(payeeKey).sort().join("|");
      if (fresh.payees.map(payeeKey).sort().join("|") !== stored)
        throw new Error("Source of Truth is stale — commission inputs changed since it was generated. Regenerate and retransmit it.");
      return { settlementDocumentId: sot.id, version: sot.version, contentHash: sot.content_hash };
    },
  };

  /** 2. Mark every commission line "Closed — Payable by Title/Escrow" (status only). */
  const unlock: SagaStep = {
    name: "2_unlock_commissions",
    run: async () => {
      const sot = await currentSot(db, propertyId);
      const s = sot.structured as SourceOfTruth;
      const rows = s.shares.flatMap((share) =>
        share.lines.map((l) => ({
          property_id: propertyId,
          settlement_document_id: sot.id,
          share_number: share.shareNumber,
          buyer_account_id: share.buyerAccountId,
          agent_id: l.agentId,
          broker_id: l.brokerId,
          role: l.role,
          gross_cents: l.grossCents,
          premium_to_hla_cents: l.premiumToHlaCents,
          premium_received_cents: l.premiumReceivedCents,
          net_cents: l.netCents,
          status: "closed_payable_by_title",
          unlocked_at: new Date().toISOString(),
        })),
      );
      const { error } = await db
        .from("commission_ledger")
        .upsert(rows, { onConflict: "settlement_document_id,share_number,agent_id,role" });
      if (error) throw new Error(error.message);
      return { lines: rows.length, instruction_only: true };
    },
  };

  /** 3. Disbursement Check: platform vs. title's final numbers, to the cent. HALTS on any difference. */
  const disbursementCheck: SagaStep = {
    name: "3_disbursement_check",
    maxAttempts: 1,
    run: async () => {
      const sot = await currentSot(db, propertyId);
      const s = sot.structured as SourceOfTruth;
      const ev = await fundedEvent(db, propertyId);
      const title = (ev?.commissionDisbursements ?? []).map((d) => ({ brokerId: d.payeeReference, cents: Math.round(d.amount * 100) }));
      const differences: Array<Record<string, unknown>> = [];
      if (!ev || title.length === 0) differences.push({ kind: "no_title_figures", detail: "Title reported no final commission disbursements." });
      for (const p of s.payees) {
        const t = title.find((x) => x.brokerId === p.brokerId);
        if (!t) differences.push({ kind: "missing_in_title", brokerId: p.brokerId, brokerage: p.brokerageName, platformCents: p.amountCents });
        else if (t.cents !== p.amountCents)
          differences.push({ kind: "amount_mismatch", brokerId: p.brokerId, brokerage: p.brokerageName, platformCents: p.amountCents, titleCents: t.cents, deltaCents: t.cents - p.amountCents });
      }
      for (const t of title)
        if (!s.payees.some((p) => p.brokerId === t.brokerId)) differences.push({ kind: "unexpected_in_title", brokerId: t.brokerId, titleCents: t.cents });
      const titleTotal = title.reduce((a, t) => a + t.cents, 0);
      if (title.length && titleTotal !== s.totals.commissionCents)
        differences.push({ kind: "total_mismatch", platformCents: s.totals.commissionCents, titleCents: titleTotal });

      const status = differences.length ? "fail" : "pass";
      await db.from("disbursement_checks").insert({
        property_id: propertyId,
        settlement_document_id: sot.id,
        status,
        platform_total_cents: s.totals.commissionCents,
        title_total_cents: title.length ? titleTotal : null,
        differences,
      });
      await audit(db, propertyId, "disbursement_check", { status, differences, settlement_document_id: sot.id });
      if (status === "fail")
        throw new Error(`Disbursement Check failed — ${differences.length} difference(s) between the Source of Truth and title's final numbers.`);
      return { status, totalCents: s.totals.commissionCents };
    },
  };

  /** 4. Property goes 'active'; pod governance on; Digital Keys for every co-owner. */
  const activate: SagaStep = {
    name: "4_activate_governance",
    run: async () => {
      const now = new Date().toISOString();
      await db.from("properties").update({ listing_status: "active" }).eq("id", propertyId);
      await db
        .from("pods")
        .update({ governance_status: "active", governance_activated_at: now })
        .eq("property_id", propertyId)
        .eq("governance_status", "inactive");
      const { data: cap } = await db.from("cap_table_entries").select("holder_type, buyer_account_id, seller_id").eq("property_id", propertyId);
      const holders = new Map<string, { holder_type: string; buyer_account_id: string | null; seller_id: string | null; shares: number }>();
      for (const c of (cap ?? []) as Array<{ holder_type: string; buyer_account_id: string | null; seller_id: string | null }>) {
        const k = `${c.holder_type}:${c.buyer_account_id ?? c.seller_id}`;
        const h = holders.get(k) ?? { ...c, shares: 0 };
        h.shares += 1;
        holders.set(k, h);
      }
      const { data: existing } = await db.from("co_owner_digital_keys").select("holder_type, buyer_account_id, seller_id").eq("property_id", propertyId);
      const have = new Set(((existing ?? []) as Array<{ holder_type: string; buyer_account_id: string | null; seller_id: string | null }>).map((e) => `${e.holder_type}:${e.buyer_account_id ?? e.seller_id}`));
      let issued = 0;
      for (const [k, h] of holders) {
        if (have.has(k)) continue;
        const { error } = await db.from("co_owner_digital_keys").insert({ property_id: propertyId, ...h, status: "active", issued_at: now });
        if (error && !/duplicate|unique/i.test(error.message)) throw new Error(error.message);
        issued++;
      }
      return { listing_status: "active", governance: "active", keysIssued: issued, keyHolders: holders.size };
    },
  };

  /** 5. Recordation Ping: deed recorded; 12-month Retention Lock starts for every share today. */
  const recordation: SagaStep = {
    name: "5_recordation_ping",
    run: async () => {
      const ev = await fundedEvent(db, propertyId);
      const recordedAt = ev?.recording?.recordedAt ?? new Date().toISOString();
      const reference = ev?.recording?.instrumentNumber ?? null;
      const { data: p } = await db.from("properties").select("deed_recorded_at").eq("id", propertyId).maybeSingle();
      const effective = p?.deed_recorded_at ?? recordedAt; // first recording wins on retries
      if (!p?.deed_recorded_at)
        await db.from("properties").update({ deed_recorded_at: effective, deed_recording_reference: reference }).eq("id", propertyId);
      const lockEnds = new Date(effective);
      lockEnds.setMonth(lockEnds.getMonth() + RETENTION_MONTHS);
      await db
        .from("cap_table_entries")
        .update({ retention_lock_started_at: effective, retention_lock_expires_at: lockEnds.toISOString() })
        .eq("property_id", propertyId);
      return { recordedAt: effective, instrumentNumber: reference, retentionLockExpiresAt: lockEnds.toISOString() };
    },
  };

  /** 6. "Deal Closed" to every stakeholder — each recipient at most once, even across retries. */
  const dealClosed: SagaStep = {
    name: "6_deal_closed_notifications",
    run: async (ctx: SagaStepContext) => {
      const { data: p } = await db.from("properties").select("address, city, state, seller_id, listing_agent_id").eq("id", propertyId).maybeSingle();
      const where = p ? `${p.address}, ${p.city}, ${p.state}` : "the property";
      const recipients = new Map<string, { authUserId: string | null; email: string | null; message: string }>();

      const { data: cap } = await db.from("cap_table_entries").select("buyer_account_id").eq("property_id", propertyId);
      const buyerIds = [...new Set(((cap ?? []) as Array<{ buyer_account_id: string | null }>).map((c) => c.buyer_account_id).filter(Boolean))] as string[];
      if (buyerIds.length) {
        const { data: buyers } = await db.from("buyer_accounts").select("id, auth_user_id, email").in("id", buyerIds);
        for (const b of (buyers ?? []) as Array<{ id: string; auth_user_id: string; email: string | null }>)
          recipients.set(`buyer:${b.id}`, {
            authUserId: b.auth_user_id,
            email: b.email,
            message: `Deal closed: ${where} is funded and recorded. You are now a co-owner — your Digital Keys to the management and governance tools are active.`,
          });
      }
      if (p?.seller_id) {
        const { data: seller } = await db.from("sellers").select("id, email").eq("id", p.seller_id).maybeSingle();
        recipients.set(`seller:${p.seller_id}`, {
          authUserId: p.seller_id,
          email: seller?.email ?? null,
          message: `Deal closed: the sale of ${where} is funded and recorded. Proceeds are disbursed by the title/escrow company.`,
        });
      }
      const sot = (await currentSot(db, propertyId)).structured as SourceOfTruth;
      const agentIds = new Set(sot.shares.flatMap((s) => s.lines.map((l) => l.agentId)));
      if (p?.listing_agent_id) agentIds.add(p.listing_agent_id);
      if (agentIds.size) {
        const { data: agents } = await db.from("agents").select("id, auth_user_id, email, broker_id").in("id", [...agentIds]);
        const brokerIds = new Set<string>();
        for (const a of (agents ?? []) as Array<{ id: string; auth_user_id: string; email: string | null; broker_id: string | null }>) {
          recipients.set(`agent:${a.id}`, {
            authUserId: a.auth_user_id,
            email: a.email,
            message: `Deal closed: ${where} is funded and recorded. Your commission shows as "Closed — Payable by Title/Escrow" on your Commission Dashboard; it is paid through your Broker of Record.`,
          });
          if (a.broker_id) brokerIds.add(a.broker_id);
        }
        if (brokerIds.size) {
          const { data: brokers } = await db.from("brokers").select("id, auth_user_id, email").in("id", [...brokerIds]);
          for (const b of (brokers ?? []) as Array<{ id: string; auth_user_id: string | null; email: string | null }>)
            recipients.set(`broker:${b.id}`, {
              authUserId: b.auth_user_id,
              email: b.email,
              message: `Deal closed: ${where} is funded and recorded. Commission for your agents is disbursed to your brokerage by the title/escrow company per the Commission Disbursement Authorization.`,
            });
        }
      }

      let sent = 0;
      let skipped = 0;
      for (const [who, r] of recipients) {
        // Claim → send → confirm. A retry skips confirmed recipients and re-sends only
        // claims that never confirmed (the send itself failed), so nobody is dropped
        // and nobody gets a second notice.
        const key = `${ctx.idempotencyKey}:${who}`;
        const { data: claim } = await db.from("saga_notifications_sent").select("status").eq("idempotency_key", key).maybeSingle();
        if (claim?.status === "sent") {
          skipped++;
          continue;
        }
        if (!claim) {
          const { error } = await db.from("saga_notifications_sent").insert({ idempotency_key: key, recipient: who, status: "pending" });
          if (error && !/duplicate|unique/i.test(error.message)) throw new Error(error.message);
        }
        await deliver(db, { authUserId: r.authUserId, email: r.email }, { subject: `Deal closed — ${where}`, message: r.message, type: "deal_closed" });
        await db.from("saga_notifications_sent").update({ status: "sent", sent_at: new Date().toISOString() }).eq("idempotency_key", key);
        sent++;
      }
      return { recipients: recipients.size, sent, alreadySent: skipped };
    },
  };

  /** 7. Recorded Deed + Closing Statement into the Property Records Vault. */
  const vault: SagaStep = {
    name: "7_records_vault",
    run: async () => {
      const ev = await fundedEvent(db, propertyId);
      const { data: p } = await db.from("properties").select("address, city, state, zip, deed_recorded_at, deed_recording_reference").eq("id", propertyId).maybeSingle();
      const { data: g } = await db.from("entity_genesis").select("id, llc_name").eq("property_id", propertyId).maybeSingle();
      const sot = (await currentSot(db, propertyId)).structured as SourceOfTruth;
      const docs = [
        {
          type: "recorded_deed",
          title: "Recorded Deed",
          body: [
            "RECORDED DEED — PLACEHOLDER",
            "Replace with the recorded deed from the title/escrow company when its document feed is live.",
            "",
            `Property: ${p?.address}, ${p?.city}, ${p?.state} ${p?.zip}`,
            `Grantee: ${g?.llc_name ?? "the property LLC"}`,
            `Recorded: ${p?.deed_recorded_at ?? ev?.recording?.recordedAt ?? "—"}`,
            `Instrument number: ${p?.deed_recording_reference ?? ev?.recording?.instrumentNumber ?? "—"}`,
          ].join("\n"),
        },
        {
          type: "closing_statement",
          title: "Closing Statement",
          body: [
            "CLOSING STATEMENT — PLACEHOLDER",
            "Replace with the final settlement statement from the title/escrow company.",
            "",
            `Property: ${p?.address}, ${p?.city}, ${p?.state} ${p?.zip}`,
            `Buyer-side commission per Source of Truth v${sot.version}: $${(sot.totals.commissionCents / 100).toFixed(2)}`,
            ...sot.payees.map((x) => `  ${x.brokerageName}: $${(x.amountCents / 100).toFixed(2)}`),
          ].join("\n"),
        },
      ];
      const { data: existing } = await db
        .from("property_records_vault")
        .select("document_type")
        .eq("property_id", propertyId)
        .in("document_type", docs.map((d) => d.type));
      const have = new Set(((existing ?? []) as Array<{ document_type: string }>).map((e) => e.document_type));
      const stored: string[] = [];
      for (const d of docs) {
        if (have.has(d.type)) continue;
        const path = `closing/${propertyId}/${d.type}.pdf`;
        await db.storage?.from(BUCKET).upload(path, new Blob([renderTextPdf(d.body, d.title)], { type: "application/pdf" }), {
          upsert: true,
          contentType: "application/pdf",
        });
        const { error } = await db.from("property_records_vault").insert({
          property_id: propertyId,
          entity_genesis_id: g?.id ?? null,
          document_type: d.type,
          title: `${d.title} (placeholder)`,
          file_url: path,
          content_hash: null,
          stored_by: null,
        });
        if (error) throw new Error(error.message);
        stored.push(d.type);
      }
      return { stored, placeholders: true };
    },
  };

  return [verify, unlock, disbursementCheck, activate, recordation, dealClosed, vault];
}

export function closingSagaAuditor(db: Db, propertyId: string) {
  return async (e: SagaEvent) => {
    const { type, ...rest } = e;
    await audit(db, propertyId, type, rest as Record<string, unknown>);
  };
}

export function startClosingSaga(db: Db, propertyId: string, opts: { resume?: boolean; retryDelayMs?: number } = {}): Promise<SagaOutcome> {
  return runSaga(db, {
    sagaType: CLOSING_SAGA_TYPE,
    sagaKey: propertyId,
    steps: steps(db, propertyId),
    payload: { propertyId },
    retryDelayMs: opts.retryDelayMs ?? 500,
    resumeFailed: opts.resume,
    onEvent: closingSagaAuditor(db, propertyId),
  });
}

export const CLOSING_STEP_LABELS: Record<string, string> = {
  "1_verify_source_of_truth": "Verify Source of Truth & re-check gates",
  "2_unlock_commissions": "Unlock commissions (Payable by Title/Escrow)",
  "3_disbursement_check": "Disbursement Check (to the cent)",
  "4_activate_governance": "Activate property, governance & Digital Keys",
  "5_recordation_ping": "Recordation Ping & Retention Lock start",
  "6_deal_closed_notifications": "Deal Closed notifications",
  "7_records_vault": "Deed & Closing Statement to Records Vault",
};
