import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabase } from "@/integrations/supabase/client";
import {
  checkCoverage,
  declaredUseFor,
  tallyVotes,
  type AlternativeProposal,
  type CoverageCheck,
  type CoverageRequirementVersion,
  type CoverageRule,
  type DeclaredUse,
  type InsurancePolicy,
  type VoteTally,
} from "@/lib/insurance";

/**
 * Insurance Procurement by the Manager — callable surface. Procurement and
 * review are admin (Manager) actions; Buyer Accounts reserved into a property
 * can see its coverage, propose an alternative carrier, and vote.
 */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function requireAdmin(userId: string) {
  const { data } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (!data) throw new Error("Not authorized");
}

async function server() {
  return import("@/lib/insurance.server");
}

const num = (v: unknown, label: string, { optional = false } = {}) => {
  if (optional && (v === null || v === undefined || v === "")) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be a positive number`);
  return n;
};

// ---------------------------------------------------------------------------
// Coverage requirements
// ---------------------------------------------------------------------------

export const listCoverageRequirements = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context.claims?.sub as string);
    const db = await adminDb();
    const { data } = await db.from("coverage_requirements").select("*").order("version", { ascending: false });
    return { versions: (data ?? []) as CoverageRequirementVersion[] };
  });

export const saveCoverageRequirements = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { rules: CoverageRule[]; notes?: string | null; isPlaceholder: boolean }) => ({
    rules: (input?.rules ?? []).map((r) => ({
      min_replacement_cost: Number(r.min_replacement_cost),
      max_replacement_cost:
        r.max_replacement_cost === null || (r.max_replacement_cost as unknown) === "" ? null : Number(r.max_replacement_cost),
      declared_use: r.declared_use,
      min_dwelling_coverage: Number(r.min_dwelling_coverage),
      min_liability_coverage: Number(r.min_liability_coverage),
    })),
    notes: input?.notes ?? null,
    isPlaceholder: Boolean(input?.isPlaceholder),
  }))
  .handler(async ({ data, context }) => {
    const userId = context.claims?.sub as string;
    await requireAdmin(userId);
    return (await server()).saveRequirementVersion(await adminDb(), userId, data);
  });

// ---------------------------------------------------------------------------
// Admin — per-property procurement view
// ---------------------------------------------------------------------------

export interface AdminInsuranceView {
  property: { id: string; address: string; city: string; state: string; usage_tag: string | null; listing_price: number | null; anticipated_closing_date: string | null } | null;
  declaredUse: DeclaredUse;
  requirements: CoverageRequirementVersion | null;
  policies: InsurancePolicy[];
  proposals: Array<AlternativeProposal & { buyerEmail: string | null; votes: number }>;
  tally: VoteTally | null;
  gate: { ok: boolean; message: string };
}

export const getAdminInsurance = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => {
    if (!input?.propertyId) throw new Error("Missing property");
    return input;
  })
  .handler(async ({ data, context }): Promise<AdminInsuranceView> => {
    await requireAdmin(context.claims?.sub as string);
    const db = await adminDb();
    const { data: property } = await db
      .from("properties")
      .select("id, address, city, state, usage_tag, listing_price, anticipated_closing_date")
      .eq("id", data.propertyId)
      .maybeSingle();
    const requirements = await (await server()).activeRequirements(db);
    const { data: policies } = await db
      .from("insurance_policies")
      .select("*")
      .eq("property_id", data.propertyId)
      .order("created_at", { ascending: false });
    const { data: proposals } = await db
      .from("insurance_alternative_proposals")
      .select("*")
      .eq("property_id", data.propertyId)
      .order("created_at", { ascending: true });
    const { data: votes } = await db.from("insurance_votes").select("proposal_id").eq("property_id", data.propertyId);
    const list = (proposals ?? []) as AlternativeProposal[];
    const buyerIds = [...new Set(list.map((p) => p.buyer_account_id))];
    const { data: buyers } = buyerIds.length
      ? await db.from("buyer_accounts").select("id, email").in("id", buyerIds)
      : { data: [] };
    const email = new Map(((buyers ?? []) as Array<{ id: string; email: string | null }>).map((b) => [b.id, b.email]));
    const approved = list.filter((p) => p.status === "approved");
    const tally = approved.length > 1 ? tallyVotes(approved.map((p) => p.id), (votes ?? []) as Array<{ proposal_id: string }>) : null;
    const { insuranceGate } = await import("@/lib/closing-gates.server");
    const gate = await insuranceGate(db, data.propertyId);

    return {
      property: property ?? null,
      declaredUse: declaredUseFor(property?.usage_tag),
      requirements,
      policies: (policies ?? []) as InsurancePolicy[],
      proposals: list.map((p) => ({
        ...p,
        buyerEmail: email.get(p.buyer_account_id) ?? null,
        votes: ((votes ?? []) as Array<{ proposal_id: string }>).filter((v) => v.proposal_id === p.id).length,
      })),
      tally,
      gate: { ok: gate.ok, message: gate.message },
    };
  });

export interface RecordPolicyPayload {
  propertyId: string;
  carrierName: string;
  policyNumber: string;
  coverageAmount: number;
  liabilityCoverage: number | null;
  premium: number;
  effectiveDate: string;
  renewsAt?: string | null;
  replacementCost: number;
  method: "default" | "buyer_alternative";
  alternativeProposalId?: string | null;
}

export const recordInsurancePolicy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: RecordPolicyPayload) => {
    if (!input?.propertyId) throw new Error("Missing property");
    if (!input.carrierName?.trim()) throw new Error("Enter the carrier");
    if (!input.policyNumber?.trim()) throw new Error("Enter the policy number");
    if (!input.effectiveDate) throw new Error("Enter the effective date");
    if (input.method !== "default" && input.method !== "buyer_alternative") throw new Error("Choose the procurement method");
    return {
      ...input,
      carrierName: input.carrierName.trim(),
      policyNumber: input.policyNumber.trim(),
      coverageAmount: num(input.coverageAmount, "Dwelling coverage")!,
      liabilityCoverage: num(input.liabilityCoverage, "Liability coverage", { optional: true }),
      premium: num(input.premium, "Premium")!,
      replacementCost: num(input.replacementCost, "Replacement cost")!,
      renewsAt: input.renewsAt || null,
    };
  })
  .handler(async ({ data, context }) => {
    const userId = context.claims?.sub as string;
    await requireAdmin(userId);
    return (await server()).recordPolicy(await adminDb(), userId, data);
  });

export const renewInsurancePolicy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { policyId: string; policyNumber: string; coverageAmount: number; liabilityCoverage: number | null; premium: number; effectiveDate: string; renewsAt?: string | null }) => {
      if (!input?.policyId) throw new Error("Missing policy");
      if (!input.policyNumber?.trim()) throw new Error("Enter the renewal policy number");
      if (!input.effectiveDate) throw new Error("Enter the renewal effective date");
      return {
        ...input,
        coverageAmount: num(input.coverageAmount, "Dwelling coverage")!,
        liabilityCoverage: num(input.liabilityCoverage, "Liability coverage", { optional: true }),
        premium: num(input.premium, "Premium")!,
        renewsAt: input.renewsAt || null,
      };
    },
  )
  .handler(async ({ data, context }) => {
    const userId = context.claims?.sub as string;
    await requireAdmin(userId);
    const { policyId, ...terms } = data;
    return (await server()).renewPolicy(await adminDb(), userId, policyId, terms);
  });

const policyAction = (fn: "bind" | "premium" | "lapse") =>
  createServerFn({ method: "POST" })
    .middleware([requireSupabaseAuth])
    .inputValidator((input: { policyId: string }) => {
      if (!input?.policyId) throw new Error("Missing policy");
      return input;
    })
    .handler(async ({ data, context }) => {
      const userId = context.claims?.sub as string;
      await requireAdmin(userId);
      const db = await adminDb();
      const s = await server();
      if (fn === "bind") await s.bindPolicy(db, userId, data.policyId);
      else if (fn === "premium") await s.markPremiumPaid(db, userId, data.policyId);
      else await s.lapsePolicy(db, userId, data.policyId, "marked_lapsed_by_manager");
      return { ok: true };
    });

export const bindInsurancePolicy = policyAction("bind");
export const markInsurancePremiumPaid = policyAction("premium");
export const lapseInsurancePolicy = policyAction("lapse");

export const reviewInsuranceProposal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { proposalId: string; approve: boolean; replacementCost: number; notes?: string | null }) => {
    if (!input?.proposalId) throw new Error("Missing proposal");
    return { ...input, approve: Boolean(input.approve), replacementCost: num(input.replacementCost, "Replacement cost")! };
  })
  .handler(async ({ data, context }) => {
    const userId = context.claims?.sub as string;
    await requireAdmin(userId);
    return (await server()).reviewProposal(await adminDb(), userId, data);
  });

export const resolveInsuranceAlternatives = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => {
    if (!input?.propertyId) throw new Error("Missing property");
    return input;
  })
  .handler(async ({ data, context }) => {
    const userId = context.claims?.sub as string;
    await requireAdmin(userId);
    return (await server()).resolveAlternatives(await adminDb(), userId, data.propertyId);
  });

// ---------------------------------------------------------------------------
// Buyer — coverage, Right to Shop, vote
// ---------------------------------------------------------------------------

export interface BuyerInsuranceProperty {
  propertyId: string;
  propertyLabel: string;
  declaredUse: DeclaredUse;
  minimums: { dwelling: number; liability: number } | null;
  requirementsPlaceholder: boolean;
  policy: Pick<InsurancePolicy, "carrier_name" | "policy_number" | "coverage_amount" | "liability_coverage" | "premium" | "effective_date" | "renews_at" | "status" | "procurement_method"> | null;
  proposals: Array<Pick<AlternativeProposal, "id" | "carrier_name" | "coverage_amount" | "liability_coverage" | "premium" | "status" | "review_notes"> & { mine: boolean; votes: number }>;
  myVote: string | null;
  voteOpen: boolean;
}

async function buyerAccount(db: Db, userId: string) {
  const { data } = await db.from("buyer_accounts").select("id").eq("auth_user_id", userId).maybeSingle();
  return (data as { id: string } | null) ?? null;
}

export const getBuyerInsurance = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ properties: BuyerInsuranceProperty[] }> => {
    const db = await adminDb();
    const buyer = await buyerAccount(db, context.claims?.sub as string);
    if (!buyer) return { properties: [] };
    const { data: res } = await db
      .from("pod_reservations")
      .select("property_id")
      .eq("buyer_account_id", buyer.id)
      .eq("status", "reserved");
    const ids = [...new Set(((res ?? []) as Array<{ property_id: string }>).map((r) => r.property_id))];
    if (ids.length === 0) return { properties: [] };

    const requirements = await (await server()).activeRequirements(db);
    const out: BuyerInsuranceProperty[] = [];
    for (const id of ids) {
      const { data: p } = await db
        .from("properties")
        .select("id, address, city, state, usage_tag, listing_price")
        .eq("id", id)
        .maybeSingle();
      const use = declaredUseFor(p?.usage_tag);
      const { data: pols } = await db
        .from("insurance_policies")
        .select("*")
        .eq("property_id", id)
        .order("created_at", { ascending: false });
      const policies = (pols ?? []) as InsurancePolicy[];
      const policy = policies.find((x) => x.status === "bound") ?? policies.find((x) => x.status === "pending") ?? null;
      const replacementCost = policy?.replacement_cost ?? p?.listing_price ?? null;
      let minimums: BuyerInsuranceProperty["minimums"] = null;
      if (requirements && replacementCost) {
        const check: CoverageCheck = checkCoverage(requirements.rules, { replacementCost, use, coverage: 0, liability: 0 });
        if (check.rule) minimums = { dwelling: check.rule.min_dwelling_coverage, liability: check.rule.min_liability_coverage };
      }
      const { data: props } = await db
        .from("insurance_alternative_proposals")
        .select("*")
        .eq("property_id", id)
        .order("created_at", { ascending: true });
      const { data: votes } = await db.from("insurance_votes").select("proposal_id, buyer_account_id").eq("property_id", id);
      const voteRows = (votes ?? []) as Array<{ proposal_id: string; buyer_account_id: string }>;
      const list = (props ?? []) as AlternativeProposal[];
      out.push({
        propertyId: id,
        propertyLabel: p ? `${p.address}, ${p.city}, ${p.state}` : "Property",
        declaredUse: use,
        minimums,
        requirementsPlaceholder: requirements?.is_placeholder ?? true,
        policy: policy
          ? {
              carrier_name: policy.carrier_name,
              policy_number: policy.policy_number,
              coverage_amount: policy.coverage_amount,
              liability_coverage: policy.liability_coverage,
              premium: policy.premium,
              effective_date: policy.effective_date,
              renews_at: policy.renews_at,
              status: policy.status,
              procurement_method: policy.procurement_method,
            }
          : null,
        // Other members' proposals are shown by carrier and status only.
        proposals: list
          .filter((x) => x.buyer_account_id === buyer.id || x.status !== "submitted")
          .map((x) => ({
            id: x.id,
            carrier_name: x.carrier_name,
            coverage_amount: x.coverage_amount,
            liability_coverage: x.liability_coverage,
            premium: x.premium,
            status: x.status,
            review_notes: x.buyer_account_id === buyer.id ? x.review_notes : null,
            mine: x.buyer_account_id === buyer.id,
            votes: voteRows.filter((v) => v.proposal_id === x.id).length,
          })),
        myVote: voteRows.find((v) => v.buyer_account_id === buyer.id)?.proposal_id ?? null,
        voteOpen: list.filter((x) => x.status === "approved").length > 1,
      });
    }
    return { properties: out };
  });

export const proposeInsuranceAlternative = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { propertyId: string; carrierName: string; policySummary?: string | null; coverageAmount: number; liabilityCoverage: number; premium: number }) => {
      if (!input?.propertyId) throw new Error("Missing property");
      if (!input.carrierName?.trim()) throw new Error("Enter the carrier");
      return {
        ...input,
        carrierName: input.carrierName.trim(),
        policySummary: input.policySummary?.trim() || null,
        coverageAmount: num(input.coverageAmount, "Dwelling coverage")!,
        liabilityCoverage: num(input.liabilityCoverage, "Liability coverage")!,
        premium: num(input.premium, "Annual premium")!,
      };
    },
  )
  .handler(async ({ data, context }) => {
    const userId = context.claims?.sub as string;
    const db = await adminDb();
    const buyer = await buyerAccount(db, userId);
    if (!buyer) throw new Error("No buyer account");
    return (await server()).proposeAlternative(db, userId, buyer.id, data);
  });

export const castInsuranceVote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; proposalId: string }) => {
    if (!input?.propertyId || !input?.proposalId) throw new Error("Missing vote");
    return input;
  })
  .handler(async ({ data, context }) => {
    const userId = context.claims?.sub as string;
    const db = await adminDb();
    const buyer = await buyerAccount(db, userId);
    if (!buyer) throw new Error("No buyer account");
    await (await server()).castVote(db, userId, buyer.id, data);
    return { ok: true };
  });
