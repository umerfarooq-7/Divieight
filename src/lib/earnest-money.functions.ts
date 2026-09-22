import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabase } from "@/integrations/supabase/client";
import type { EarnestObligation, EarnestTerms } from "@/lib/earnest-money";

/**
 * Earnest Money Coordination — callable surface.
 *
 * Setup is admin-only (the Manager presents the escrow instruction). The money
 * itself never touches the platform.
 */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function isAdmin(userId: string) {
  const { data } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  return Boolean(data);
}

function propertyLabel(p: { address: string; city: string; state: string } | null) {
  return p ? `${p.address}, ${p.city}, ${p.state}` : "Subject property";
}

export interface AdminEarnestProperty {
  propertyId: string;
  propertyLabel: string;
  shares: number;
  acceptanceAuthorized: boolean;
  terms: EarnestTerms | null;
  obligations: Array<EarnestObligation & { buyerEmail: string | null }>;
}

/** Properties with a live pod: acceptance-triggered first, then manual setup. */
export const listAdminEarnestMoney = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const userId = context.claims?.sub as string;
    if (!(await isAdmin(userId))) throw new Error("Not authorized");
    const db = await adminDb();

    const { data: reservations } = await db
      .from("pod_reservations")
      .select("property_id, buyer_account_id, shares_reserved")
      .eq("status", "reserved");

    const byProperty = new Map<string, number>();
    for (const r of (reservations ?? []) as Array<{
      property_id: string;
      shares_reserved: number | null;
    }>) {
      byProperty.set(r.property_id, (byProperty.get(r.property_id) ?? 0) + (r.shares_reserved ?? 1));
    }
    const propertyIds = [...byProperty.keys()];
    if (propertyIds.length === 0) return { properties: [] as AdminEarnestProperty[] };

    const { data: props } = await db
      .from("properties")
      .select("id, address, city, state")
      .in("id", propertyIds);
    const propById = new Map(
      ((props ?? []) as Array<{ id: string; address: string; city: string; state: string }>).map(
        (p) => [p.id, p],
      ),
    );

    // Seller acceptance is detected through the authorization flow's final
    // acceptance actions; anything else is set up manually.
    const { data: accepted } = await db
      .from("authorization_requests")
      .select("property_id, action_type, status")
      .in("property_id", propertyIds)
      .eq("status", "authorized")
      .in("action_type", ["counter_offer_acceptance", "final_repa_acceptance"]);
    const acceptedSet = new Set(
      ((accepted ?? []) as Array<{ property_id: string }>).map((a) => a.property_id),
    );

    const { data: termRows } = await db
      .from("earnest_money_terms")
      .select("*")
      .in("property_id", propertyIds);
    const termsById = new Map(
      ((termRows ?? []) as EarnestTerms[]).map((t) => [t.property_id, t]),
    );

    const { data: obligationRows } = await db
      .from("earnest_money_obligations")
      .select("*")
      .in("property_id", propertyIds);
    const obligations = (obligationRows ?? []) as EarnestObligation[];

    const buyerIds = [...new Set(obligations.map((o) => o.buyer_account_id))];
    const emailById = new Map<string, string | null>();
    if (buyerIds.length > 0) {
      const { data: buyers } = await db
        .from("buyer_accounts")
        .select("id, email")
        .in("id", buyerIds);
      for (const b of (buyers ?? []) as Array<{ id: string; email: string | null }>)
        emailById.set(b.id, b.email);
    }

    const properties: AdminEarnestProperty[] = propertyIds.map((id) => ({
      propertyId: id,
      propertyLabel: propertyLabel(propById.get(id) ?? null),
      shares: byProperty.get(id) ?? 0,
      acceptanceAuthorized: acceptedSet.has(id),
      terms: termsById.get(id) ?? null,
      obligations: obligations
        .filter((o) => o.property_id === id)
        .map((o) => ({ ...o, buyerEmail: emailById.get(o.buyer_account_id) ?? null })),
    }));

    properties.sort(
      (a, b) => Number(b.acceptanceAuthorized) - Number(a.acceptanceAuthorized),
    );
    return { properties };
  });

export interface IssueEarnestPayload {
  propertyId: string;
  totalAmount: number;
  fundingDeadline: string;
  escrowCompany: string;
  escrowAccountDetails: string;
  escrowReference?: string | null;
  escrowContactEmail?: string | null;
  fundingMethods?: string[];
}

export const issueEarnestMoney = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: IssueEarnestPayload) => {
    if (!input?.propertyId) throw new Error("Choose a property");
    const total = Number(input.totalAmount);
    if (!Number.isFinite(total) || total <= 0) throw new Error("Enter the total earnest money");
    if (!input.fundingDeadline) throw new Error("Enter the funding deadline");
    if (!input.escrowCompany?.trim()) throw new Error("Name the title/escrow company");
    if (!input.escrowAccountDetails?.trim()) throw new Error("Enter the escrow account details");
    return input;
  })
  .handler(async ({ data, context }) => {
    const userId = context.claims?.sub as string;
    if (!(await isAdmin(userId))) throw new Error("Not authorized");
    const db = await adminDb();
    const { issueEarnestObligations } = await import("@/lib/earnest-money.server");
    const result = await issueEarnestObligations(db, userId, {
      ...data,
      totalAmount: Number(data.totalAmount),
      fundingDeadline: new Date(data.fundingDeadline).toISOString(),
    });
    if (result.reason === "funded_amount_conflict") {
      const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
      const detail = result.conflicts
        .map((c) => `${money(c.fundedAmount)} funded vs ${money(c.newAmount)} under the new total`)
        .join("; ");
      throw new Error(
        `Not issued: ${result.conflicts.length} Buyer Account(s) already funded escrow and this total would change their share (${detail}). Keep the original total, or settle the difference with the title/escrow company first.`,
      );
    }
    if (result.reason === "no_active_reservations")
      throw new Error("No active reservations on this property.");
    return result;
  });

export const markEarnestFunded = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { obligationId: string; reference?: string | null }) => {
    if (!input?.obligationId) throw new Error("Missing obligation");
    return input;
  })
  .handler(async ({ data, context }) => {
    const userId = context.claims?.sub as string;
    if (!(await isAdmin(userId))) throw new Error("Not authorized");
    const db = await adminDb();
    const { markObligationFunded } = await import("@/lib/earnest-money.server");
    const result = await markObligationFunded(db, userId, {
      obligationId: data.obligationId,
      reference: data.reference ?? null,
    });
    if (!result.ok)
      throw new Error(
        result.reason === "already_defaulted"
          ? "This obligation was already declared a Default and its share released to substitution."
          : "Obligation not found",
      );
    return result;
  });

export const runEarnestMoneyDeadlineSweep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const userId = context.claims?.sub as string;
    if (!(await isAdmin(userId))) throw new Error("Not authorized");
    const db = await adminDb();
    const { runEarnestMoneySweep } = await import("@/lib/earnest-money.server");
    return runEarnestMoneySweep(db, userId);
  });

export interface BuyerEarnestRow {
  obligation: EarnestObligation;
  terms: EarnestTerms | null;
  propertyLabel: string;
}

/** The signed-in buyer's own earnest-money obligations. */
export const listBuyerEarnestMoney = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const userId = context.claims?.sub as string;
    const db = await adminDb();

    const { data: account } = await db
      .from("buyer_accounts")
      .select("id")
      .eq("auth_user_id", userId)
      .maybeSingle();
    if (!account) return { rows: [] as BuyerEarnestRow[] };

    const { data: obligations } = await db
      .from("earnest_money_obligations")
      .select("*")
      .eq("buyer_account_id", (account as { id: string }).id)
      .order("funding_deadline", { ascending: true });

    const rows = (obligations ?? []) as EarnestObligation[];
    if (rows.length === 0) return { rows: [] as BuyerEarnestRow[] };

    const propertyIds = [...new Set(rows.map((o) => o.property_id))];
    const { data: props } = await db
      .from("properties")
      .select("id, address, city, state")
      .in("id", propertyIds);
    const propById = new Map(
      ((props ?? []) as Array<{ id: string; address: string; city: string; state: string }>).map(
        (p) => [p.id, p],
      ),
    );
    const { data: termRows } = await db
      .from("earnest_money_terms")
      .select("*")
      .in("property_id", propertyIds);
    const termsById = new Map(((termRows ?? []) as EarnestTerms[]).map((t) => [t.property_id, t]));

    return {
      rows: rows.map((o) => ({
        obligation: o,
        terms: termsById.get(o.property_id) ?? null,
        propertyLabel: propertyLabel(propById.get(o.property_id) ?? null),
      })) as BuyerEarnestRow[],
    };
  });
