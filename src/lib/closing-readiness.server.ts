/**
 * Closing Readiness (Prompt 15) — READ-ONLY aggregation of every gate a
 * closing depends on. It never writes: no audit rows, no compliance alerts,
 * no notifications. (That's why dual agency is re-derived here instead of
 * calling verifyPodDualAgency, which logs an alert.)
 */

type Db = { from: (t: string) => any };

export interface ReadinessItem {
  key: string;
  label: string;
  ok: boolean;
  summary: string;
  details: string[];
  /** Admin screen to act on it when blocking. */
  link: string;
}

export interface Readiness {
  propertyId: string;
  label: string;
  listingStatus: string | null;
  pod: { retained: number; reserved: number; total: number };
  ready: boolean;
  blocking: number;
  items: ReadinessItem[];
}

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const short = (id: string) => id.slice(0, 8);

export async function closingReadiness(db: Db, propertyId: string): Promise<Readiness> {
  const { data: p } = await db
    .from("properties")
    .select("id, address, city, state, listing_status, exit_type, retained_shares, listing_agent_id")
    .eq("id", propertyId)
    .maybeSingle();
  if (!p) throw new Error("Property not found");
  const label = `${p.address}, ${p.city}, ${p.state}`;

  const { data: res } = await db
    .from("pod_reservations")
    .select("buyer_account_id, shares_reserved")
    .eq("property_id", propertyId)
    .eq("status", "reserved");
  const reservations = (res ?? []) as Array<{ buyer_account_id: string; shares_reserved: number }>;
  const buyerIds = [...new Set(reservations.map((r) => r.buyer_account_id))];
  const { data: buyerRows } = buyerIds.length
    ? await db.from("buyer_accounts").select("id, email, tethered_resident_agent_id").in("id", buyerIds)
    : { data: [] };
  const buyers = (buyerRows ?? []) as Array<{ id: string; email: string | null; tethered_resident_agent_id: string | null }>;
  const who = (id: string) => buyers.find((b) => b.id === id)?.email ?? `Buyer Account ${short(id)}`;
  const retained = p.exit_type === "hybrid_exit" ? (p.retained_shares ?? 0) : 0;
  const reserved = reservations.reduce((s, r) => s + (r.shares_reserved ?? 0), 0);
  const items: ReadinessItem[] = [];

  // 1. Due Diligence Acknowledgment Gate (Prompt 2)
  {
    const { diligenceGateStatus } = await import("@/lib/authorization.functions");
    const details: string[] = [];
    for (const b of buyers) {
      const g = await diligenceGateStatus(db as never, propertyId, b.id);
      if (!g.clear)
        details.push(
          `${who(b.id)} — ${g.blocker === "both" ? "the buyer and their Resident Agent" : g.blocker === "agent" ? "their Resident Agent" : "the buyer"} still owe acknowledgments`,
        );
    }
    items.push({
      key: "due_diligence",
      label: "Due Diligence Acknowledgment Gate",
      ok: details.length === 0,
      summary: details.length ? `${details.length} Buyer Account(s) outstanding` : "All Required documents acknowledged by members and agents",
      details,
      link: `/admin/properties/${propertyId}/due-diligence`,
    });
  }

  // 2. Buyer-Authorization (Prompts 3 & 4)
  {
    const { data: reqs } = await db
      .from("authorization_requests")
      .select("id, buyer_account_id, action_type, status, headline")
      .eq("property_id", propertyId);
    const list = (reqs ?? []) as Array<{ id: string; buyer_account_id: string; action_type: string; status: string; headline: string }>;
    const details: string[] = [];
    for (const r of list.filter((x) => x.status === "pending" || x.status === "declined"))
      details.push(`${r.status === "pending" ? "Pending" : "Declined"}: ${r.headline} (${r.action_type.replace(/_/g, " ")}) — ${who(r.buyer_account_id)}`);
    if (list.length) {
      const { data: items2 } = await db
        .from("authorization_commission_items")
        .select("request_id, status")
        .in("request_id", list.map((r) => r.id));
      for (const c of (items2 ?? []) as Array<{ request_id: string; status: string }>)
        if (c.status !== "authorized") {
          const r = list.find((x) => x.id === c.request_id)!;
          details.push(`Commission provision ${c.status}: ${r.headline} — ${who(r.buyer_account_id)}`);
        }
    }
    items.push({
      key: "authorizations",
      label: "Buyer-Authorization (incl. commission items)",
      ok: details.length === 0,
      summary: details.length ? `${details.length} pending or declined item(s)` : list.length ? "Every request resolved and authorized" : "No authorization requests yet",
      details,
      link: "/admin/authorizations",
    });
  }

  // 3 & 4. Earnest money (Prompt 5) and closing funds (Prompt 7)
  for (const [key, labelText, terms, table, link] of [
    ["earnest_money", "Earnest money funding", "earnest_money_terms", "earnest_money_obligations", "/admin/earnest-money"],
    ["closing_funds", "Closing-cost funding", "closing_funds_terms", "closing_funds_obligations", "/admin/closing-funds"],
  ] as const) {
    const { data: t } = await db.from(terms).select("total_amount").eq("property_id", propertyId).maybeSingle();
    const { data: obs } = await db.from(table).select("buyer_account_id, amount, status").eq("property_id", propertyId);
    const list = (obs ?? []) as Array<{ buyer_account_id: string; amount: number; status: string }>;
    const open = list.filter((o) => o.status !== "funded");
    items.push({
      key,
      label: labelText,
      ok: Boolean(t) && list.length > 0 && open.length === 0,
      summary: !t ? "Instructions not issued yet" : open.length ? `${open.length} of ${list.length} not funded` : `All ${list.length} funded (${money(Number(t.total_amount))})`,
      details: open.map((o) => `${who(o.buyer_account_id)} — ${money(Number(o.amount))} ${o.status}`),
      link,
    });
  }

  // 5. Insurance (Prompt 8)
  {
    const { insuranceGate } = await import("@/lib/closing-gates.server");
    const g = await insuranceGate(db, propertyId);
    items.push({ key: "insurance", label: "Insurance bound & effective at closing", ok: g.ok, summary: g.message, details: [], link: `/admin/properties/${propertyId}/insurance` });
  }

  // 6. Entity Genesis Stage 2 (Prompt 9)
  {
    const { data: g } = await db
      .from("entity_genesis")
      .select("stage, state_filing_status, ein, ein_status, tin_match_result, final_oa_status, cap_table_locked_at")
      .eq("property_id", propertyId)
      .maybeSingle();
    const einOk = Boolean(g?.ein) && g?.ein_status !== "pending";
    const tinOk = g?.tin_match_result === "match";
    items.push({
      key: "entity_stage2",
      label: "Entity Genesis Stage 2 — EIN issued & TIN matched",
      ok: einOk && tinOk,
      summary: !g ? "Stage 1 not opened" : `EIN ${einOk ? "issued" : "pending"} · TIN match ${g.tin_match_result ?? "not recorded"}`,
      details: g
        ? [
            `Closing-Ready: ${g.cap_table_locked_at ? "yes (cap table locked)" : "no"}`,
            `Delaware filing: ${g.state_filing_status}`,
            `Operating Agreement: ${String(g.final_oa_status).replace(/_/g, " ")}`,
          ]
        : [],
      link: `/admin/entity-genesis/${propertyId}`,
    });
  }

  // 7. Broker Closing Hold (Prompt 14)
  {
    const { closingHoldStatus, closingHoldMessage } = await import("@/lib/closing-hold-gate.server");
    const h = await closingHoldStatus(db, propertyId);
    items.push({
      key: "closing_hold",
      label: "Broker Closing Hold",
      ok: !h.active,
      summary: h.active ? `Hold active — "${h.reason ?? "no reason given"}"` : "No hold on this pod",
      details: h.active ? [closingHoldMessage(h)] : [],
      link: "/admin/closing",
    });
  }

  // 8. Per-agent hold flags (NAR / E&O lapse, broker relationship lapse)
  {
    const agentIds = new Set<string>(buyers.map((b) => b.tethered_resident_agent_id).filter(Boolean) as string[]);
    if (buyerIds.length) {
      const { data: refs } = await db
        .from("pending_referral_agreements")
        .select("non_resident_agent_id")
        .in("buyer_account_id", buyerIds)
        .eq("status", "executed");
      for (const r of (refs ?? []) as Array<{ non_resident_agent_id: string }>) agentIds.add(r.non_resident_agent_id);
    }
    const { data: pod } = await db.from("pods").select("heavy_lifting_agent_id, hla_status").eq("property_id", propertyId).maybeSingle();
    if (pod?.hla_status === "accepted" && pod.heavy_lifting_agent_id) agentIds.add(pod.heavy_lifting_agent_id);
    if (p.listing_agent_id) agentIds.add(p.listing_agent_id);
    const { data: agents } = agentIds.size
      ? await db
          .from("agents")
          .select("id, full_name, transactions_held, nar_cert_lapsed, eo_lapsed, relationship_status")
          .in("id", [...agentIds])
      : { data: [] };
    const details: string[] = [];
    for (const a of (agents ?? []) as Array<{ id: string; full_name: string | null; transactions_held: boolean | null; nar_cert_lapsed: boolean | null; eo_lapsed: boolean | null; relationship_status: string | null }>) {
      const why = [
        a.nar_cert_lapsed ? "NAR certification lapsed" : null,
        a.eo_lapsed ? "E&O coverage lapsed" : null,
        a.relationship_status && a.relationship_status !== "active" ? `broker relationship ${a.relationship_status}` : null,
      ].filter(Boolean);
      if (a.transactions_held || why.length)
        details.push(`${a.full_name ?? `Agent ${short(a.id)}`} — transactions held${why.length ? `: ${why.join(", ")}` : ""}`);
    }
    items.push({
      key: "agent_holds",
      label: "Agent hold flags (NAR / E&O / broker relationship)",
      ok: details.length === 0,
      summary: details.length ? `${details.length} agent(s) held` : `${agentIds.size} involved agent(s) clear`,
      details,
      link: "/admin/agents",
    });
  }

  // Also blocks the Source of Truth (read-only re-derivation of the dual-agency rule).
  if (p.listing_agent_id) {
    const tethered = buyers.filter((b) => b.tethered_resident_agent_id === p.listing_agent_id);
    items.push({
      key: "dual_agency",
      label: "Dual agency",
      ok: tethered.length === 0,
      summary: tethered.length ? `Listing Agent tethered to ${tethered.length} Buyer Account(s)` : "Listing Agent represents no buyer in this pod",
      details: tethered.map((b) => who(b.id)),
      link: "/admin/agents",
    });
  }

  const blocking = items.filter((i) => !i.ok).length;
  return {
    propertyId,
    label,
    listingStatus: p.listing_status ?? null,
    pod: { retained, reserved, total: retained + reserved },
    ready: blocking === 0,
    blocking,
    items,
  };
}

/** Properties with a live pod — the ones approaching Closing-Ready. */
export async function readinessOverview(db: Db): Promise<Readiness[]> {
  const { data: res } = await db.from("pod_reservations").select("property_id").eq("status", "reserved");
  const ids = [...new Set(((res ?? []) as Array<{ property_id: string }>).map((r) => r.property_id))];
  const out: Readiness[] = [];
  for (const id of ids) out.push(await closingReadiness(db, id));
  return out.sort((a, b) => b.pod.total - a.pod.total || a.blocking - b.blocking);
}
