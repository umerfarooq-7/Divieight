import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabase } from "@/integrations/supabase/client";
import type { ClosingObligation, ClosingTerms } from "@/lib/closing-funds";

/**
 * Closing-Cost Funding Coordination — callable surface. Setup and status
 * changes are admin-only; buyers, their Resident Agents and the pod's Heavy
 * Lifting Agent read. The money itself never touches the platform.
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

type PropertyRow = { id: string; address: string; city: string; state: string };
const labelOf = (p: PropertyRow | null | undefined) =>
  p ? `${p.address}, ${p.city}, ${p.state}` : "Subject property";

async function propertiesById(db: Db, ids: string[]) {
  if (ids.length === 0) return new Map<string, PropertyRow>();
  const { data } = await db.from("properties").select("id, address, city, state").in("id", ids);
  return new Map(((data ?? []) as PropertyRow[]).map((p) => [p.id, p]));
}

async function termsById(db: Db, ids: string[]) {
  if (ids.length === 0) return new Map<string, ClosingTerms>();
  const { data } = await db.from("closing_funds_terms").select("*").in("property_id", ids);
  return new Map(((data ?? []) as ClosingTerms[]).map((t) => [t.property_id, t]));
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export interface AdminClosingProperty {
  propertyId: string;
  propertyLabel: string;
  shares: number;
  terms: ClosingTerms | null;
  obligations: Array<ClosingObligation & { buyerEmail: string | null }>;
}

export const listAdminClosingFunds = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const userId = context.claims?.sub as string;
    if (!(await isAdmin(userId))) throw new Error("Not authorized");
    const db = await adminDb();

    const { data: reservations } = await db
      .from("pod_reservations")
      .select("property_id, shares_reserved")
      .eq("status", "reserved");
    const shares = new Map<string, number>();
    for (const r of (reservations ?? []) as Array<{ property_id: string; shares_reserved: number | null }>)
      shares.set(r.property_id, (shares.get(r.property_id) ?? 0) + (r.shares_reserved ?? 1));
    const ids = [...shares.keys()];
    if (ids.length === 0) return { properties: [] as AdminClosingProperty[] };

    const props = await propertiesById(db, ids);
    const terms = await termsById(db, ids);
    const { data: obligationRows } = await db.from("closing_funds_obligations").select("*").in("property_id", ids);
    const obligations = (obligationRows ?? []) as ClosingObligation[];
    const buyerIds = [...new Set(obligations.map((o) => o.buyer_account_id))];
    const { data: buyers } = buyerIds.length
      ? await db.from("buyer_accounts").select("id, email").in("id", buyerIds)
      : { data: [] };
    const email = new Map(((buyers ?? []) as Array<{ id: string; email: string | null }>).map((b) => [b.id, b.email]));

    return {
      properties: ids.map((id) => ({
        propertyId: id,
        propertyLabel: labelOf(props.get(id)),
        shares: shares.get(id) ?? 0,
        terms: terms.get(id) ?? null,
        obligations: obligations
          .filter((o) => o.property_id === id)
          .map((o) => ({ ...o, buyerEmail: email.get(o.buyer_account_id) ?? null })),
      })) as AdminClosingProperty[],
    };
  });

export interface IssueClosingPayload {
  propertyId: string;
  totalAmount: number;
  fundingDeadline: string;
  escrowCompany: string;
  escrowAccountDetails: string;
  escrowReference?: string | null;
  escrowContactEmail?: string | null;
  fundingMethods?: string[];
}

export const issueClosingFunds = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: IssueClosingPayload) => {
    if (!input?.propertyId) throw new Error("Choose a property");
    const total = Number(input.totalAmount);
    if (!Number.isFinite(total) || total <= 0) throw new Error("Enter the total closing-table amount");
    if (!input.fundingDeadline) throw new Error("Enter the wire deadline");
    if (!input.escrowCompany?.trim()) throw new Error("Name the title/escrow company");
    if (!input.escrowAccountDetails?.trim()) throw new Error("Enter the escrow account details");
    return input;
  })
  .handler(async ({ data, context }) => {
    const userId = context.claims?.sub as string;
    if (!(await isAdmin(userId))) throw new Error("Not authorized");
    const db = await adminDb();
    const { issueClosingObligations } = await import("@/lib/closing-funds.server");
    const result = await issueClosingObligations(db, userId, {
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
        `Not issued: ${result.conflicts.length} Buyer Account(s) already wired closing funds and this total would change their share (${detail}). Keep the original total, or settle the difference with the title/escrow company first.`,
      );
    }
    if (result.reason === "no_active_reservations") throw new Error("No active reservations on this property.");
    return result;
  });

export const markClosingFundsFunded = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { obligationId: string; reference?: string | null }) => {
    if (!input?.obligationId) throw new Error("Missing obligation");
    return input;
  })
  .handler(async ({ data, context }) => {
    const userId = context.claims?.sub as string;
    if (!(await isAdmin(userId))) throw new Error("Not authorized");
    const db = await adminDb();
    const { markClosingFunded } = await import("@/lib/closing-funds.server");
    const result = await markClosingFunded(db, userId, {
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

export const runClosingFundsDeadlineSweep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const userId = context.claims?.sub as string;
    if (!(await isAdmin(userId))) throw new Error("Not authorized");
    const db = await adminDb();
    const { runClosingFundsSweep } = await import("@/lib/closing-funds.server");
    return runClosingFundsSweep(db, userId);
  });

// ---------------------------------------------------------------------------
// Buyer
// ---------------------------------------------------------------------------

export interface ClosingRow {
  obligation: ClosingObligation;
  terms: ClosingTerms | null;
  propertyLabel: string;
}

export const listBuyerClosingFunds = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = await adminDb();
    const { data: account } = await db
      .from("buyer_accounts")
      .select("id")
      .eq("auth_user_id", context.claims?.sub as string)
      .maybeSingle();
    if (!account) return { rows: [] as ClosingRow[] };

    const { data } = await db
      .from("closing_funds_obligations")
      .select("*")
      .eq("buyer_account_id", account.id)
      .order("funding_deadline", { ascending: true });
    const rows = (data ?? []) as ClosingObligation[];
    const ids = [...new Set(rows.map((o) => o.property_id))];
    const props = await propertiesById(db, ids);
    const terms = await termsById(db, ids);
    return {
      rows: rows.map((o) => ({
        obligation: o,
        terms: terms.get(o.property_id) ?? null,
        propertyLabel: labelOf(props.get(o.property_id)),
      })),
    };
  });

// ---------------------------------------------------------------------------
// Resident Agent dashboard — the agent's own tethered buyers
// ---------------------------------------------------------------------------

export const listAgentClosingFunds = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = await adminDb();
    const { data: agent } = await db
      .from("agents")
      .select("id")
      .eq("auth_user_id", context.claims?.sub as string)
      .maybeSingle();
    if (!agent) return { rows: [] as Array<ClosingRow & { buyerEmail: string | null }> };

    const { data: buyers } = await db
      .from("buyer_accounts")
      .select("id, email")
      .eq("tethered_resident_agent_id", agent.id);
    const buyerList = (buyers ?? []) as Array<{ id: string; email: string | null }>;
    if (buyerList.length === 0) return { rows: [] as Array<ClosingRow & { buyerEmail: string | null }> };

    const { data } = await db
      .from("closing_funds_obligations")
      .select("*")
      .in("buyer_account_id", buyerList.map((b) => b.id))
      .order("funding_deadline", { ascending: true });
    const rows = (data ?? []) as ClosingObligation[];
    const ids = [...new Set(rows.map((o) => o.property_id))];
    const props = await propertiesById(db, ids);
    const terms = await termsById(db, ids);
    const email = new Map(buyerList.map((b) => [b.id, b.email]));
    return {
      rows: rows.map((o) => ({
        obligation: o,
        terms: terms.get(o.property_id) ?? null,
        propertyLabel: labelOf(props.get(o.property_id)),
        buyerEmail: email.get(o.buyer_account_id) ?? null,
      })),
    };
  });

// ---------------------------------------------------------------------------
// Heavy Lifting Agent — Master Briefcase coordination view (de-identified)
// ---------------------------------------------------------------------------

export interface PodClosingFunds {
  terms: ClosingTerms | null;
  rows: Array<{
    memberLabel: string;
    shares: number;
    amount: number;
    status: ClosingObligation["status"];
    funding_deadline: string;
    funded_at: string | null;
    is_substitute: boolean;
  }>;
}

export const getPodClosingFunds = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { podId: string }) => {
    if (!input?.podId) throw new Error("Missing pod");
    return input;
  })
  .handler(async ({ data, context }): Promise<PodClosingFunds | { error: string }> => {
    const userId = context.claims?.sub as string;
    const db = await adminDb();
    const { data: pod } = await db
      .from("pods")
      .select("property_id, heavy_lifting_agent_id, hla_status")
      .eq("id", data.podId)
      .maybeSingle();
    if (!pod) return { error: "Pod not found." };

    if (!(await isAdmin(userId))) {
      const { data: agent } = await db.from("agents").select("id").eq("auth_user_id", userId).maybeSingle();
      if (!agent || pod.hla_status !== "accepted" || pod.heavy_lifting_agent_id !== agent.id)
        return { error: "Only the pod's Heavy Lifting Agent can view closing-funds coordination." };
    }

    const terms = (await termsById(db, [pod.property_id])).get(pod.property_id) ?? null;
    const { data: rows } = await db
      .from("closing_funds_obligations")
      .select("*")
      .eq("property_id", pod.property_id)
      .order("created_at", { ascending: true });
    return {
      terms,
      // Coordination needs status and amounts, not identities.
      rows: ((rows ?? []) as ClosingObligation[]).map((o, i) => ({
        memberLabel: `Buyer Account ${i + 1}`,
        shares: o.shares,
        amount: o.amount,
        status: o.status,
        funding_deadline: o.funding_deadline,
        funded_at: o.funded_at,
        is_substitute: o.is_substitute,
      })),
    };
  });
