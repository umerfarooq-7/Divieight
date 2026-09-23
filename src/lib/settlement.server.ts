/**
 * Commission Settlement — Source of Truth + Commission Disbursement
 * Authorization (Prompt 11). Built as the authoritative settlement-instruction
 * generator (Module 6 primary); if Module 11 becomes authoritative instead,
 * only `compileSourceOfTruth` / `renderSourceOfTruth` need revisiting.
 *
 * ⚠️ INSTRUCTION ONLY. Nothing in this module moves money, calls a payment
 * API, or records a payout. It compiles, renders, stores and transmits an
 * instruction to title/escrow, who pays Brokers of Record from sale proceeds.
 */
import { createHash, randomUUID } from "node:crypto";
import { computeShareCascade, formatUsdCents, type CascadeRole } from "@/lib/commission-cascade";
import { renderTextPdf } from "@/lib/simple-pdf";

type Db = { from: (t: string) => any; storage?: any };

const BUCKET = "property-documents";

async function audit(db: Db, actorId: string | null, actionType: string, propertyId: string, metadata: Record<string, unknown>) {
  await db.from("audit_log").insert({
    actor_id: actorId,
    actor_type: actorId ? "admin" : "system",
    action_type: `settlement.${actionType}`,
    entity_type: "settlement",
    entity_id: propertyId,
    metadata,
  });
}

export interface SettlementBlocker {
  code:
    | "closing_hold_active"
    | "agent_transactions_held"
    | "broker_payment_gate"
    | "dual_agency_violation"
    | "insurance_not_bound"
    | "llc_tin_not_verified"
    | "not_closing_ready"
    | "no_title_order"
    | "commission_not_authorized"
    | "agent_without_broker"
    | "buyer_without_resident_agent";
  message: string;
}

interface AgentRow {
  id: string;
  full_name: string | null;
  broker_id: string | null;
  transactions_held: boolean | null;
}

interface Participants {
  propertyId: string;
  property: { address: string; city: string; state: string; zip: string };
  llc: { name: string | null; ein: string | null; capLocked: boolean; tin: string | null };
  shares: Array<{ shareNumber: number; holderType: string; buyerAccountId: string | null }>;
  buyers: Map<string, { residentAgentId: string | null; referringAgentId: string | null; referringRole: string | null }>;
  hlaId: string | null;
  agents: Map<string, AgentRow>;
  brokers: Map<string, { id: string; brokerage_name: string; license_number: string | null }>;
  commissionCentsByBuyer: Map<string, number | null>;
  titleOrder: { provider: string; external_order_id: string } | null;
  closingHold: boolean;
}

/** Latest authorized per-share commission for each Buyer Account (Prompt 4). */
async function perShareCommission(db: Db, propertyId: string, buyerIds: string[]) {
  const out = new Map<string, number | null>();
  for (const buyerId of buyerIds) {
    const { data: reqs } = await db
      .from("authorization_requests")
      .select("id, action_type, status, commission_expected, resolved_at, created_at")
      .eq("property_id", propertyId)
      .eq("buyer_account_id", buyerId)
      .eq("status", "authorized")
      .order("created_at", { ascending: false });
    let cents: number | null = null;
    for (const r of (reqs ?? []) as Array<{ id: string; action_type: string; commission_expected?: boolean }>) {
      const { data: item } = await db
        .from("authorization_commission_items")
        .select("per_share_amount_cents, status")
        .eq("request_id", r.id)
        .maybeSingle();
      if (item?.status === "authorized") {
        cents = Number(item.per_share_amount_cents);
        break;
      }
      // An accepted final instrument explicitly carrying no commission provision.
      if (["final_repa_acceptance", "counter_offer_acceptance"].includes(r.action_type) && r.commission_expected === false) {
        cents = 0;
        break;
      }
    }
    out.set(buyerId, cents);
  }
  return out;
}

async function loadParticipants(db: Db, propertyId: string): Promise<Participants> {
  const { data: p } = await db.from("properties").select("id, address, city, state, zip").eq("id", propertyId).maybeSingle();
  if (!p) throw new Error("Property not found");
  const { data: g } = await db
    .from("entity_genesis")
    .select("llc_name, ein, cap_table_locked_at, tin_match_result")
    .eq("property_id", propertyId)
    .maybeSingle();
  const { data: cap } = await db
    .from("cap_table_entries")
    .select("share_number, holder_type, buyer_account_id")
    .eq("property_id", propertyId)
    .order("share_number", { ascending: true });
  const shares = ((cap ?? []) as Array<{ share_number: number; holder_type: string; buyer_account_id: string | null }>).map((c) => ({
    shareNumber: c.share_number,
    holderType: c.holder_type,
    buyerAccountId: c.buyer_account_id,
  }));
  const buyerIds = [...new Set(shares.map((s) => s.buyerAccountId).filter(Boolean))] as string[];

  const buyers = new Map<string, { residentAgentId: string | null; referringAgentId: string | null; referringRole: string | null }>();
  if (buyerIds.length) {
    const { data: rows } = await db.from("buyer_accounts").select("id, tethered_resident_agent_id").in("id", buyerIds);
    for (const b of (rows ?? []) as Array<{ id: string; tethered_resident_agent_id: string | null }>)
      buyers.set(b.id, { residentAgentId: b.tethered_resident_agent_id, referringAgentId: null, referringRole: null });
    const { data: refs } = await db
      .from("pending_referral_agreements")
      .select("buyer_account_id, non_resident_agent_id, referring_agent_role, status")
      .in("buyer_account_id", buyerIds)
      .eq("status", "executed");
    for (const r of (refs ?? []) as Array<{ buyer_account_id: string; non_resident_agent_id: string; referring_agent_role: string | null }>) {
      const b = buyers.get(r.buyer_account_id);
      if (b) {
        b.referringAgentId = r.non_resident_agent_id;
        b.referringRole = r.referring_agent_role ?? "non_resident";
      }
    }
  }

  const { data: pod } = await db
    .from("pods")
    .select("heavy_lifting_agent_id, hla_status, closing_hold_active")
    .eq("property_id", propertyId)
    .maybeSingle();
  const hlaId = pod?.hla_status === "accepted" ? (pod.heavy_lifting_agent_id ?? null) : null;

  const agentIds = new Set<string>();
  for (const b of buyers.values()) {
    if (b.residentAgentId) agentIds.add(b.residentAgentId);
    if (b.referringAgentId) agentIds.add(b.referringAgentId);
  }
  if (hlaId) agentIds.add(hlaId);
  const agents = new Map<string, AgentRow>();
  if (agentIds.size) {
    const { data: rows } = await db
      .from("agents")
      .select("id, full_name, broker_id, transactions_held")
      .in("id", [...agentIds]);
    for (const a of (rows ?? []) as AgentRow[]) agents.set(a.id, a);
  }
  const brokerIds = [...new Set([...agents.values()].map((a) => a.broker_id).filter(Boolean))] as string[];
  const brokers = new Map<string, { id: string; brokerage_name: string; license_number: string | null }>();
  if (brokerIds.length) {
    const { data: rows } = await db.from("brokers").select("id, brokerage_name, license_number").in("id", brokerIds);
    for (const b of (rows ?? []) as Array<{ id: string; brokerage_name: string; license_number: string | null }>) brokers.set(b.id, b);
  }
  const { data: order } = await db
    .from("title_escrow_orders")
    .select("provider, external_order_id")
    .eq("property_id", propertyId)
    .maybeSingle();

  return {
    propertyId,
    property: { address: p.address, city: p.city, state: p.state, zip: p.zip },
    llc: { name: g?.llc_name ?? null, ein: g?.ein ?? null, capLocked: Boolean(g?.cap_table_locked_at), tin: g?.tin_match_result ?? null },
    shares,
    buyers,
    hlaId,
    agents,
    brokers,
    commissionCentsByBuyer: await perShareCommission(db, propertyId, buyerIds),
    titleOrder: order ?? null,
    closingHold: Boolean(pod?.closing_hold_active),
  };
}

// ---------------------------------------------------------------------------
// Pre-closing gates — ANY failure blocks generation
// ---------------------------------------------------------------------------

export async function settlementPreconditions(db: Db, propertyId: string, parts?: Participants): Promise<SettlementBlocker[]> {
  const x = parts ?? (await loadParticipants(db, propertyId));
  const blockers: SettlementBlocker[] = [];
  const name = (id: string) => x.agents.get(id)?.full_name ?? `agent ${id.slice(0, 8)}`;

  // 1. Broker Closing Hold (Month 3, Prompt 15)
  if (x.closingHold) blockers.push({ code: "closing_hold_active", message: "A Broker Closing Hold is active on this pod." });

  // 2. transactions_held (lapsed NAR cert, E&O, or broker relationship)
  for (const a of x.agents.values())
    if (a.transactions_held)
      blockers.push({ code: "agent_transactions_held", message: `${name(a.id)} has transactions held (lapsed NAR certification, E&O, or broker relationship).` });

  // 3. Every Broker of Record passes canReceivePayment() (W-9/W-8)
  const { checkCommissionPaymentGate } = await import("@/lib/payment-gate");
  const checked = new Set<string>();
  for (const a of x.agents.values()) {
    if (!a.broker_id) {
      blockers.push({ code: "agent_without_broker", message: `${name(a.id)} has no Broker of Record — commission can't flow broker-to-broker.` });
      continue;
    }
    if (checked.has(a.broker_id)) continue;
    checked.add(a.broker_id);
    const gate = await checkCommissionPaymentGate(a.broker_id, db);
    if (!gate.allowed)
      blockers.push({
        code: "broker_payment_gate",
        message: `${x.brokers.get(a.broker_id)?.brokerage_name ?? "Broker of Record"}: ${gate.reason ?? "cannot receive payment"}`,
      });
  }

  // 4. Dual agency — final safety check (logs a compliance alert if it fires)
  const { verifyPodDualAgency } = await import("@/lib/dual-agency");
  const dual = await verifyPodDualAgency(db as never, { propertyId, actorId: null });
  if (dual.violations.length)
    blockers.push({ code: "dual_agency_violation", message: `The Listing Agent is tethered to ${dual.violations.length} Buyer Account(s) in this pod.` });

  // 5. Insurance bound (Prompt 8) and 6. LLC TIN match (Prompt 9)
  const { insuranceGate } = await import("@/lib/closing-gates.server");
  const ins = await insuranceGate(db, propertyId);
  if (!ins.ok) blockers.push({ code: "insurance_not_bound", message: ins.message });
  const { llcTinGate } = await import("@/lib/entity-genesis-stage2.server");
  const tin = await llcTinGate(db, propertyId);
  if (!tin.ok) blockers.push({ code: "llc_tin_not_verified", message: tin.message });

  // Data the instruction itself depends on.
  if (!x.llc.capLocked) blockers.push({ code: "not_closing_ready", message: "The pod isn't Closing-Ready — the cap table isn't locked." });
  if (!x.titleOrder) blockers.push({ code: "no_title_order", message: "No title/escrow order is open to transmit the CDA to." });
  for (const [buyerId, b] of x.buyers) {
    if (!b.residentAgentId)
      blockers.push({ code: "buyer_without_resident_agent", message: `Buyer Account ${buyerId.slice(0, 8)} has no tethered Resident Agent.` });
    if (x.commissionCentsByBuyer.get(buyerId) == null)
      blockers.push({
        code: "commission_not_authorized",
        message: `Buyer Account ${buyerId.slice(0, 8)} has no authorized buyer-side commission provision.`,
      });
  }
  return blockers;
}

// ---------------------------------------------------------------------------
// Source of Truth
// ---------------------------------------------------------------------------

export interface SotLine {
  agentId: string;
  agentName: string;
  role: CascadeRole;
  brokerId: string;
  brokerageName: string;
  grossCents: number;
  premiumToHlaCents: number;
  premiumReceivedCents: number;
  netCents: number;
}

export interface SourceOfTruth {
  documentId: string;
  version: number;
  generatedAt: string;
  propertyId: string;
  property: Participants["property"];
  llc: { name: string | null; ein: string | null };
  retainedSellerShares: number;
  shares: Array<{
    shareNumber: number;
    buyerAccountId: string;
    residentAgentId: string;
    referral: { agentId: string; role: string } | null;
    heavyLiftingAgentId: string | null;
    commissionCents: number;
    lines: SotLine[];
  }>;
  payees: Array<{ brokerId: string; brokerageName: string; licenseNumber: string | null; amountCents: number; creditedAgents: string[] }>;
  totals: { commissionCents: number; referralCents: number; heavyLifterPremiumCents: number };
  instruction: string;
}

export const INSTRUCTION_TEXT =
  "This Commission Disbursement Authorization instructs the title/escrow company to pay the buyer-side commission amounts below from sale proceeds at closing, to each Broker of Record listed. Payment is broker-to-broker only; no amount is payable to an individual agent. divieight, LLC does not hold, receive, or disburse commission funds.";

export function compileSourceOfTruth(x: Participants, documentId: string, version: number): SourceOfTruth {
  const shares: SourceOfTruth["shares"] = [];
  for (const s of x.shares) {
    if (s.holderType !== "buyer_account" || !s.buyerAccountId) continue;
    const b = x.buyers.get(s.buyerAccountId)!;
    const cascade = computeShareCascade({
      commissionCents: x.commissionCentsByBuyer.get(s.buyerAccountId) ?? 0,
      residentAgentId: b.residentAgentId!,
      referringAgentId: b.referringAgentId,
      heavyLiftingAgentId: x.hlaId,
    });
    shares.push({
      shareNumber: s.shareNumber,
      buyerAccountId: s.buyerAccountId,
      residentAgentId: b.residentAgentId!,
      referral: cascade.referralApplies ? { agentId: b.referringAgentId!, role: b.referringRole ?? "non_resident" } : null,
      heavyLiftingAgentId: x.hlaId,
      commissionCents: cascade.commissionCents,
      lines: cascade.lines.map((l) => {
        const agent = x.agents.get(l.agentId)!;
        return {
          ...l,
          agentName: agent.full_name ?? "Agent",
          brokerId: agent.broker_id!,
          brokerageName: x.brokers.get(agent.broker_id!)?.brokerage_name ?? "Broker of Record",
        };
      }),
    });
  }

  const byBroker = new Map<string, SourceOfTruth["payees"][number]>();
  for (const s of shares)
    for (const l of s.lines) {
      const p = byBroker.get(l.brokerId) ?? {
        brokerId: l.brokerId,
        brokerageName: l.brokerageName,
        licenseNumber: x.brokers.get(l.brokerId)?.license_number ?? null,
        amountCents: 0,
        creditedAgents: [],
      };
      p.amountCents += l.netCents;
      if (!p.creditedAgents.includes(l.agentName)) p.creditedAgents.push(l.agentName);
      byBroker.set(l.brokerId, p);
    }

  const commissionCents = shares.reduce((s, x) => s + x.commissionCents, 0);
  return {
    documentId,
    version,
    generatedAt: new Date().toISOString(),
    propertyId: x.propertyId,
    property: x.property,
    llc: { name: x.llc.name, ein: x.llc.ein },
    retainedSellerShares: x.shares.filter((s) => s.holderType === "retained_seller").length,
    shares,
    payees: [...byBroker.values()].filter((p) => p.amountCents > 0),
    totals: {
      commissionCents,
      referralCents: shares.flatMap((s) => s.lines).filter((l) => l.role === "referring_agent").reduce((a, l) => a + l.grossCents, 0),
      heavyLifterPremiumCents: shares.flatMap((s) => s.lines).reduce((a, l) => a + l.premiumToHlaCents, 0),
    },
    instruction: INSTRUCTION_TEXT,
  };
}

export function renderSourceOfTruth(sot: SourceOfTruth): string {
  const $ = formatUsdCents;
  const out: string[] = [
    "SOURCE OF TRUTH — COMMISSION DISBURSEMENT AUTHORIZATION (CDA)",
    `Document ${sot.documentId} · version ${sot.version} · generated ${sot.generatedAt}`,
    "",
    `Property: ${sot.property.address}, ${sot.property.city}, ${sot.property.state} ${sot.property.zip}`,
    `Owner entity: ${sot.llc.name ?? "—"}${sot.llc.ein ? ` (EIN ${sot.llc.ein})` : ""}`,
    `Retained seller shares (no buyer-side commission): ${sot.retainedSellerShares}`,
    "",
    "INSTRUCTION",
    sot.instruction,
    "",
    "PER-SHARE BREAKDOWN",
  ];
  for (const s of sot.shares) {
    out.push(
      `Share ${s.shareNumber}/8 · Buyer Account ${s.buyerAccountId} · buyer-side commission ${$(s.commissionCents)}` +
        (s.referral ? ` · referral split (${s.referral.role})` : " · no referral split"),
    );
    for (const l of s.lines)
      out.push(
        `    ${l.role.replace(/_/g, " ")}: ${l.agentName} via ${l.brokerageName} — gross ${$(l.grossCents)}` +
          (l.premiumToHlaCents ? `, less HLA premium ${$(l.premiumToHlaCents)}` : "") +
          (l.premiumReceivedCents ? `, plus HLA premium ${$(l.premiumReceivedCents)}` : "") +
          ` = net ${$(l.netCents)}`,
      );
  }
  out.push("", "PAYEES — BROKER-TO-BROKER");
  for (const p of sot.payees)
    out.push(`  ${p.brokerageName}${p.licenseNumber ? ` (lic. ${p.licenseNumber})` : ""}: ${$(p.amountCents)} — credited agents: ${p.creditedAgents.join(", ")}`);
  out.push(
    "",
    "TOTALS",
    `  Buyer-side commission: ${$(sot.totals.commissionCents)}`,
    `  of which referral splits: ${$(sot.totals.referralCents)}`,
    `  of which Heavy Lifter Premium: ${$(sot.totals.heavyLifterPremiumCents)}`,
  );
  return out.join("\n");
}

export function hashStructured(sot: SourceOfTruth) {
  return `sha256_${createHash("sha256").update(JSON.stringify(sot), "utf8").digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Generate → store → transmit
// ---------------------------------------------------------------------------

export type GenerateResult =
  | { status: "blocked"; blockers: SettlementBlocker[] }
  | { status: "transmitted"; documentId: string; version: number; contentHash: string; externalReference: string; simulated: boolean };

export async function generateAndTransmit(db: Db, actorId: string, propertyId: string): Promise<GenerateResult> {
  const parts = await loadParticipants(db, propertyId);
  const blockers = await settlementPreconditions(db, propertyId, parts);
  if (blockers.length) {
    await audit(db, actorId, "generation_blocked", propertyId, { blockers });
    return { status: "blocked", blockers };
  }

  const { data: last } = await db
    .from("settlement_documents")
    .select("version")
    .eq("property_id", propertyId)
    .order("version", { ascending: false })
    .limit(1);
  const version = (((last ?? []) as Array<{ version: number }>)[0]?.version ?? 0) + 1;
  const documentId = randomUUID();
  const sot = compileSourceOfTruth(parts, documentId, version);

  const payeeSum = sot.payees.reduce((s, p) => s + p.amountCents, 0);
  if (payeeSum !== sot.totals.commissionCents)
    throw new Error(`Internal check failed: payees ${payeeSum} ≠ commission ${sot.totals.commissionCents} (cents).`);

  const contentHash = hashStructured(sot);
  const text = renderSourceOfTruth(sot);
  const pdfPath = `settlement/${propertyId}/source-of-truth-v${version}-${contentHash.slice(7, 15)}.pdf`;
  try {
    await db.storage?.from(BUCKET).upload(pdfPath, new Blob([renderTextPdf(text, `Source of Truth v${version}`)], { type: "application/pdf" }), {
      upsert: false,
      contentType: "application/pdf",
    });
  } catch {
    // The structured record below is authoritative; the PDF can be re-rendered from it.
  }

  await db.from("settlement_documents").update({ status: "superseded" }).eq("property_id", propertyId).neq("status", "superseded");
  const { error } = await db.from("settlement_documents").insert({
    id: documentId,
    property_id: propertyId,
    version,
    status: "generated",
    structured: sot,
    content_hash: contentHash,
    total_commission_cents: sot.totals.commissionCents,
    pdf_url: pdfPath,
    generated_by: actorId,
    generated_at: sot.generatedAt,
  });
  if (error) throw new Error(error.message);

  const { data: g } = await db.from("entity_genesis").select("id").eq("property_id", propertyId).maybeSingle();
  await db.from("property_records_vault").insert({
    property_id: propertyId,
    entity_genesis_id: g?.id ?? null,
    document_type: "source_of_truth_cda",
    title: `Source of Truth / CDA v${version}`,
    file_url: pdfPath,
    content_hash: contentHash,
    stored_by: actorId,
  });

  // The reference point for the Disbursement Check (Prompt 16): every figure.
  await audit(db, actorId, "source_of_truth_generated", propertyId, {
    document_id: documentId,
    version,
    content_hash: contentHash,
    pdf_url: pdfPath,
    snapshot: sot,
  });

  const { getTitleAdapter } = await import("@/lib/title-adapters");
  const adapter = getTitleAdapter(parts.titleOrder!.provider);
  const sent = await adapter.transmitDisbursementInstruction(parts.titleOrder!.external_order_id, {
    documentId,
    version,
    contentHash,
    totalCommissionCents: sot.totals.commissionCents,
    payees: sot.payees,
  });
  const now = new Date().toISOString();
  await db
    .from("settlement_documents")
    .update({ status: "transmitted", provider: adapter.provider, external_reference: sent.externalReference, simulated: sent.simulated, transmitted_at: now })
    .eq("id", documentId);
  await audit(db, actorId, "cda_transmitted", propertyId, {
    document_id: documentId,
    version,
    provider: adapter.provider,
    external_order_id: parts.titleOrder!.external_order_id,
    external_reference: sent.externalReference,
    simulated: sent.simulated,
    request: sent.request,
    money_moved: false,
  });

  return { status: "transmitted", documentId, version, contentHash, externalReference: sent.externalReference, simulated: sent.simulated };
}

/** The transmitted instruction the Disbursement Check (Prompt 16) compares against. */
export async function latestSourceOfTruth(db: Db, propertyId: string) {
  const { data } = await db
    .from("settlement_documents")
    .select("id, version, status, structured, content_hash, total_commission_cents, transmitted_at")
    .eq("property_id", propertyId)
    .eq("status", "transmitted")
    .order("version", { ascending: false })
    .limit(1);
  return ((data ?? []) as Array<{ id: string; version: number; structured: SourceOfTruth; content_hash: string; total_commission_cents: number }>)[0] ?? null;
}

export { loadParticipants };
