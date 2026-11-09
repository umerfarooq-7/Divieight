import type { SubstitutionCandidate, Vacancy } from "@/lib/substitution";
import { geoOverlap, isIncompatibleIntent } from "@/lib/substitution";

type AdminClient = Awaited<
  typeof import("@/integrations/supabase/admin.server")
>["supabaseAdmin"];

interface PropertyLite {
  id: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  usage_tag: string | null;
  listing_price: number | null;
}

/**
 * Candidate pipeline for a vacated slice: vetted (Golden Ticket) buyers whose
 * target zips or primary market overlap the property location and whose intent
 * doesn't conflict with the property usage tag. Ranked by
 * priority_rank_timestamp (earliest = highest priority).
 */
export async function findCandidates(
  admin: AdminClient,
  property: PropertyLite,
  excludeBuyerIds: string[],
  limit = 5,
): Promise<SubstitutionCandidate[]> {
  const { data: buyers } = await admin
    .from("buyer_accounts")
    .select(
      "id, email, intent, primary_target_market, target_zip_codes, target_budget, priority_rank, priority_rank_timestamp, onboarding_status",
    )
    .eq("golden_ticket_issued", true)
    .limit(500);

  const pool = (buyers ?? []).filter(
    (b) =>
      !excludeBuyerIds.includes(b.id) &&
      b.onboarding_status !== "archived" &&
      b.onboarding_status !== "adverse_action",
  );
  if (pool.length === 0) return [];

  const { data: members } = await admin
    .from("account_members")
    .select("buyer_account_id, full_name, role")
    .in(
      "buyer_account_id",
      pool.map((b) => b.id),
    )
    .eq("status", "active");
  const nameByAccount = new Map<string, string>();
  (members ?? []).forEach((m) => {
    if (m.full_name && (m.role === "primary" || !nameByAccount.has(m.buyer_account_id)))
      nameByAccount.set(m.buyer_account_id, m.full_name);
  });

  const matched: SubstitutionCandidate[] = [];
  for (const b of pool) {
    if (isIncompatibleIntent(b.intent, property.usage_tag)) continue;
    const zips = Array.isArray(b.target_zip_codes) ? (b.target_zip_codes as string[]) : [];
    const geo = geoOverlap(zips, b.primary_target_market, property);
    if (geo.length === 0) continue;
    const matchedOn: SubstitutionCandidate["matchedOn"] = [...geo];
    if (b.intent && property.usage_tag && !isIncompatibleIntent(b.intent, property.usage_tag))
      matchedOn.push("intent");

    matched.push({
      buyerAccountId: b.id,
      email: b.email,
      primaryName: nameByAccount.get(b.id) || b.email,
      priorityRank: b.priority_rank ?? null,
      priorityRankTimestamp: b.priority_rank_timestamp ?? null,
      intent: b.intent ?? null,
      primaryTargetMarket: b.primary_target_market ?? null,
      targetBudget: b.target_budget ?? null,
      matchedOn,
    });
  }

  matched.sort((a, b) => {
    const at = a.priorityRankTimestamp ? Date.parse(a.priorityRankTimestamp) : Infinity;
    const bt = b.priorityRankTimestamp ? Date.parse(b.priorityRankTimestamp) : Infinity;
    if (at !== bt) return at - bt;
    return (a.priorityRank ?? 1e9) - (b.priorityRank ?? 1e9);
  });

  return matched.slice(0, limit);
}

/** Every open vacancy (withdrawn/defaulted slice on a live pod) with ranked candidates. */
export async function buildVacancies(admin: AdminClient): Promise<Vacancy[]> {
  const { data: rows } = await admin
    .from("pod_reservations")
    .select("id, property_id, buyer_account_id, status, updated_at, reserved_at")
    .in("status", ["withdrawn", "defaulted"])
    .order("updated_at", { ascending: false })
    .limit(50);

  if (!rows || rows.length === 0) return [];

  const propertyIds = [...new Set(rows.map((r) => r.property_id))];
  const { data: props } = await admin
    .from("properties")
    .select("id, address, city, state, zip, usage_tag, listing_price, exit_type, retained_shares")
    .in("id", propertyIds);
  const propById = new Map((props ?? []).map((p) => [p.id, p]));

  const { data: active } = await admin
    .from("pod_reservations")
    .select("property_id, buyer_account_id, shares_reserved")
    .in("property_id", propertyIds)
    .eq("status", "reserved");

  const vacancies: Vacancy[] = [];
  for (const r of rows) {
    const p = propById.get(r.property_id);
    if (!p) continue;
    const activeRows = (active ?? []).filter((a) => a.property_id === p.id);
    const retained = p.exit_type === "hybrid_exit" ? (p.retained_shares ?? 0) : 0;
    const reserved = activeRows.reduce((s, a) => s + (a.shares_reserved ?? 0), 0);
    const availableShares = Math.max(0, 8 - retained - reserved);
    if (availableShares === 0) continue;

    const exclude = [r.buyer_account_id, ...activeRows.map((a) => a.buyer_account_id)];
    const candidates = await findCandidates(admin, p, exclude, 5);

    // substitution_invitations lands with the pending migration; generated
    // types don't know it yet.
    const { data: invRows } = await (admin as unknown as { from: (t: string) => any })
      .from("substitution_invitations")
      .select("id, status, sequence, invited_at, expires_at, window_hours, window_shortened, resident_agent_id")
      .eq("property_id", p.id)
      .order("sequence", { ascending: false })
      .limit(1);
    const inv = (invRows ?? [])[0] ?? null;

    vacancies.push({
      reservationId: r.id,
      propertyId: p.id,
      address: p.address,
      city: p.city,
      state: p.state,
      zip: p.zip,
      usageTag: p.usage_tag ?? null,
      listingPrice: p.listing_price ?? null,
      vacatedAt: r.updated_at ?? r.reserved_at,
      availableShares,
      candidates,
      invitation: inv
        ? {
            id: inv.id,
            status:
              inv.status === "pending" && new Date(inv.expires_at).getTime() <= Date.now()
                ? "expired"
                : inv.status,
            sequence: inv.sequence,
            invitedAt: inv.invited_at,
            expiresAt: inv.expires_at,
            windowHours: inv.window_hours,
            windowShortened: Boolean(inv.window_shortened),
            residentAgentNotified: Boolean(inv.resident_agent_id),
          }
        : null,
    });
  }

  return vacancies;
}
