import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { residencyFor, type Residency } from "@/lib/markets";
import { agentVisibleStage } from "@/lib/agent-visibility";

/**
 * Verified Lead Dashboard data.
 *
 * Read-only view over Month 2 buyer data, scoped so an agent only ever sees
 * the buyers tethered to their own agent row. PII boundary: identity, market,
 * and status flags only — never vetting report contents, liquidity documents,
 * or eligibility-check detail.
 *
 * Runs with the service role because RLS keeps `buyer_accounts` readable only
 * by the buyer; the scoping to `tethered_resident_agent_id` is enforced here.
 */

/** Display-only summary of an active reservation held by a tethered buyer. */
export interface BuyerReservationSummary {
  reservationId: string;
  propertyId: string;
  label: string;
  sharesReserved: number;
  listingStatus: string;
}

export interface TetheredBuyer {
  buyerAccountId: string;
  /** Display identity for the agent — email is the buyer's contact of record. */
  name: string;
  email: string;
  market: string | null;
  goldenTicketIssued: boolean;
  goldenTicketIssuedAt: string | null;
  onboardingStatus: string;
  liquidityVerified: boolean;
  liquidityStatus: string;
  /** Platform Enrollment Fee: 'paid' | 'pending' | 'unpaid'. */
  pefStatus: "paid" | "pending" | "unpaid";
  priorityRank: number | null;
  tetheredAt: string | null;
  /** Derived per transaction from the agent's markets — never a stored role. */
  residency: Residency;
  /** Zero, one, or (rarely) several active reservations. Display only. */
  reservations: BuyerReservationSummary[];
}

export const listMyTetheredBuyers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<TetheredBuyer[]> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
    const db = supabaseAdmin as unknown as { from: (t: string) => any };

    const { data: agent } = await db
      .from("agents")
      .select("id, markets")
      .eq("auth_user_id", context.userId)
      .maybeSingle();
    if (!agent) return [];

    const { data: buyers } = await db
      .from("buyer_accounts")
      .select(
        "id, email, intent, primary_target_market, onboarding_status, golden_ticket_issued, golden_ticket_issued_at, liquidity_verified, liquidity_status, priority_rank, tethered_at",
      )
      .eq("tethered_resident_agent_id", agent.id)
      .order("created_at", { ascending: false });

    const rows = (buyers ?? []) as any[];
    if (rows.length === 0) return [];

    const { data: payments } = await db
      .from("buyer_enrollment_payments")
      .select("buyer_account_id, status")
      .in(
        "buyer_account_id",
        rows.map((r) => r.id),
      );

    const payStatus = new Map<string, "paid" | "pending">();
    for (const p of (payments ?? []) as any[]) {
      const current = payStatus.get(p.buyer_account_id);
      if (p.status === "paid" || p.status === "succeeded" || p.status === "complete") {
        payStatus.set(p.buyer_account_id, "paid");
      } else if (current !== "paid") {
        payStatus.set(p.buyer_account_id, "pending");
      }
    }

    // A held account is never shown as unpaid. The agent isn't told it is held either (that would
    // disclose a pending charge): a fee short of paid reads "pending".
    const { currentResults } = await import("@/lib/eligibility-engine.server");
    const heldAccounts = new Set<string>();
    for (const r of rows) {
      const results = await currentResults(db as never, r.id).catch(() => ({}) as Record<string, null>);
      if (Object.values(results).some((x) => x?.result === "held")) heldAccounts.add(r.id);
    }

    // Display-only: active reservations per buyer. Read-only over Month 2 data.
    const { data: reservations } = await db
      .from("pod_reservations")
      .select(
        "id, buyer_account_id, property_id, shares_reserved, reserved_at, properties ( address, city, state, listing_status )",
      )
      .eq("status", "reserved")
      .in(
        "buyer_account_id",
        rows.map((r) => r.id),
      )
      .order("reserved_at", { ascending: true });

    const byBuyer = new Map<string, BuyerReservationSummary[]>();
    for (const res of (reservations ?? []) as any[]) {
      const p = res.properties ?? {};
      const label =
        [p.address, p.city, p.state].filter(Boolean).join(", ") || "Subject property";
      const list = byBuyer.get(res.buyer_account_id) ?? [];
      list.push({
        reservationId: res.id,
        propertyId: res.property_id,
        label,
        sharesReserved: Number(res.shares_reserved ?? 0),
        listingStatus: (p.listing_status as string) ?? "forming",
      });
      byBuyer.set(res.buyer_account_id, list);
    }

    return rows.map((r) => {
      const pef = payStatus.get(r.id) ?? (heldAccounts.has(r.id) ? "pending" : "unpaid");
      return {
        buyerAccountId: r.id,
        name: (r.email ?? "").split("@")[0] || "Buyer",
        email: r.email ?? "",
        market: r.primary_target_market ?? null,
        goldenTicketIssued: Boolean(r.golden_ticket_issued),
        goldenTicketIssuedAt: r.golden_ticket_issued_at ?? null,
        // Rev 49 counsel items D2(a)/D2(b): the agent sees only what they saw before; a held account reads as Pending.
        onboardingStatus: agentVisibleStage(r.onboarding_status ?? "unknown", heldAccounts.has(r.id), Boolean(r.golden_ticket_issued)),
        liquidityVerified: Boolean(r.liquidity_verified),
        liquidityStatus: r.liquidity_status ?? "pending",
        pefStatus: pef,
        priorityRank: r.priority_rank ?? null,
        tetheredAt: r.tethered_at ?? null,
        residency: residencyFor(agent.markets, (r.primary_target_market ?? "").trim()),
        reservations: byBuyer.get(r.id) ?? [],
      } satisfies TetheredBuyer;
    });
  });
