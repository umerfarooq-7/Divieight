import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Agent Pod View — a pod-scoped, read-only coordination view for any Resident
 * Agent tethered to at least one buyer in the pod.
 *
 * PRIVACY BOUNDARY (same rule as the Agent Pool View): only the viewing
 * agent's OWN tethered buyers are named. No other buyer's identity, contact,
 * vetting, KYO detail, or financial/budget figure ever leaves this module, and
 * the other-agent roster carries professional info only — never a mapping of
 * which agent represents which buyer.
 *
 * The Master Briefcase is NOT duplicated here; when the viewer is the accepted
 * Heavy Lifting Agent the page simply links to it.
 */

export interface AgentPodBuyer {
  buyerAccountId: string;
  name: string;
  email: string;
  onboardingStatus: string;
  reservationStatus: string;
  sharesReserved: number;
  reservedAt: string | null;
}

export interface AgentPodRosterAgent {
  agentId: string;
  fullName: string;
  brokerageName: string | null;
  brokerOfRecord: string | null;
  contactEmail: string | null;
}

export interface AgentPodView {
  propertyId: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  photoUrl: string | null;
  listingPrice: number | null;
  pricePerShare: number | null;
  listingStatus: string;
  retainedShares: number;
  reservedShares: number;
  myBuyers: AgentPodBuyer[];
  myShareTotal: number;
  otherAgents: AgentPodRosterAgent[];
  podId: string | null;
  hlaStatus: string | null;
  heavyLifterName: string | null;
  viewerIsHla: boolean;
  viewerHlaAccepted: boolean;
  listingAgentName: string | null;
  listingAgentBrokerage: string | null;
}

export const getAgentPodView = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string }) => ({ propertyId: String(data.propertyId) }))
  .handler(async ({ data, context }): Promise<AgentPodView | { error: string }> => {
    const { supabaseAdmin: rawAdmin } = await import("@/integrations/supabase/admin.server");
    const db = rawAdmin as unknown as {
      from: (t: string) => any;
      storage: (typeof rawAdmin)["storage"];
    };

    const { data: agent } = await db
      .from("agents")
      .select("id, full_name")
      .eq("auth_user_id", context.userId)
      .maybeSingle();
    if (!agent) return { error: "Agent profile not found." };

    const { data: reservations } = await db
      .from("pod_reservations")
      .select("id, buyer_account_id, shares_reserved, status, reserved_at")
      .eq("property_id", data.propertyId)
      .eq("status", "reserved")
      .order("reserved_at", { ascending: true });

    const rows = (reservations ?? []) as any[];
    const buyerIds = [...new Set(rows.map((r) => r.buyer_account_id).filter(Boolean))];
    if (buyerIds.length === 0) {
      return { error: "You don't represent a buyer in this pod." };
    }

    const { data: buyers } = await db
      .from("buyer_accounts")
      .select("id, email, onboarding_status, tethered_resident_agent_id")
      .in("id", buyerIds);
    // Each buyer's agent on this property (per-property agent where one applies).
    const { withPropertyAgents } = await import("@/lib/property-agent.server");
    const buyerRows = (await withPropertyAgents(db, data.propertyId, (buyers ?? []) as any[])) as any[];

    const mineIds = new Set(
      buyerRows.filter((b) => b.tethered_resident_agent_id === agent.id).map((b) => b.id),
    );
    // Access gate: only agents tethered to a buyer inside THIS pod may read it.
    if (mineIds.size === 0) return { error: "You don't represent a buyer in this pod." };

    const byBuyer = new Map(buyerRows.map((b) => [b.id, b]));
    const myBuyers: AgentPodBuyer[] = rows
      .filter((r) => mineIds.has(r.buyer_account_id))
      .map((r) => {
        const b = byBuyer.get(r.buyer_account_id) ?? {};
        return {
          buyerAccountId: r.buyer_account_id,
          name: (b.email ?? "").split("@")[0] || "Buyer",
          email: b.email ?? "",
          onboardingStatus: b.onboarding_status ?? "unknown",
          reservationStatus: r.status,
          sharesReserved: Number(r.shares_reserved ?? 0),
          reservedAt: r.reserved_at ?? null,
        } satisfies AgentPodBuyer;
      });

    // Roster of the other tethered Resident Agents — professional info only,
    // with no linkage back to individual buyers.
    const otherAgentIds = [
      ...new Set(
        buyerRows
          .map((b) => b.tethered_resident_agent_id)
          .filter((id: string | null) => id && id !== agent.id),
      ),
    ] as string[];

    let otherAgents: AgentPodRosterAgent[] = [];
    if (otherAgentIds.length) {
      const { data: agents } = await db
        .from("agents")
        .select("id, full_name, email, broker_id")
        .in("id", otherAgentIds);
      const brokerIds = (agents ?? []).map((a: any) => a.broker_id).filter(Boolean);
      const brokers = new Map<string, { brokerage: string | null; contact: string | null }>();
      if (brokerIds.length) {
        const { data: brows } = await db
          .from("brokers")
          .select("id, brokerage_name, contact_name")
          .in("id", brokerIds);
        for (const r of (brows ?? []) as any[])
          brokers.set(r.id, {
            brokerage: r.brokerage_name ?? null,
            contact: r.contact_name ?? null,
          });
      }
      otherAgents = ((agents ?? []) as any[])
        .map((a) => ({
          agentId: a.id,
          fullName: a.full_name ?? "Resident Agent",
          brokerageName: a.broker_id ? (brokers.get(a.broker_id)?.brokerage ?? null) : null,
          brokerOfRecord: a.broker_id ? (brokers.get(a.broker_id)?.contact ?? null) : null,
          contactEmail: a.email ?? null,
        }))
        .sort((x, y) => x.fullName.localeCompare(y.fullName));
    }

    const { data: property } = await db
      .from("properties")
      .select(
        "id, address, city, state, zip, listing_price, listing_status, exit_type, retained_shares, listing_agent_id",
      )
      .eq("id", data.propertyId)
      .maybeSingle();
    if (!property) return { error: "Property not found." };

    let photoUrl: string | null = null;
    const { data: media } = await db
      .from("property_media")
      .select("url")
      .eq("property_id", data.propertyId)
      .eq("media_type", "photo")
      .order("display_order", { ascending: true })
      .limit(1);
    const path = media?.[0]?.url ?? null;
    if (path) {
      const { data: signed } = await db.storage
        .from("property-media")
        .createSignedUrl(path, 60 * 60);
      photoUrl = signed?.signedUrl ?? null;
    }

    const { data: pod } = await db
      .from("pods")
      .select("*")
      .eq("property_id", data.propertyId)
      .maybeSingle();

    let heavyLifterName: string | null = null;
    if (pod?.heavy_lifting_agent_id) {
      const { data: hla } = await db
        .from("agents")
        .select("full_name")
        .eq("id", pod.heavy_lifting_agent_id)
        .maybeSingle();
      heavyLifterName = (hla as any)?.full_name ?? null;
    }

    let listingAgentName: string | null = null;
    let listingAgentBrokerage: string | null = null;
    if (property.listing_agent_id) {
      const { data: la } = await db
        .from("agents")
        .select("full_name, broker_id")
        .eq("id", property.listing_agent_id)
        .maybeSingle();
      listingAgentName = (la as any)?.full_name ?? null;
      if ((la as any)?.broker_id) {
        const { data: b } = await db
          .from("brokers")
          .select("brokerage_name")
          .eq("id", (la as any).broker_id)
          .maybeSingle();
        listingAgentBrokerage = (b as any)?.brokerage_name ?? null;
      }
    }

    const retained = property.exit_type === "hybrid_exit" ? (property.retained_shares ?? 0) : 0;
    const reserved = rows.reduce((s, r) => s + Number(r.shares_reserved ?? 0), 0);
    const price = property.listing_price ?? null;

    return {
      propertyId: property.id,
      address: property.address ?? "—",
      city: property.city ?? "",
      state: property.state ?? "",
      zip: property.zip ?? "",
      photoUrl,
      listingPrice: price,
      pricePerShare: price != null ? price / 8 : null,
      listingStatus: property.listing_status ?? "forming",
      retainedShares: Math.max(0, Math.min(8, retained)),
      reservedShares: reserved,
      myBuyers,
      myShareTotal: myBuyers.reduce((s, b) => s + b.sharesReserved, 0),
      otherAgents,
      podId: pod?.id ?? null,
      hlaStatus: pod?.hla_status ?? null,
      heavyLifterName,
      viewerIsHla: Boolean(pod?.heavy_lifting_agent_id === agent.id),
      viewerHlaAccepted: Boolean(
        pod?.heavy_lifting_agent_id === agent.id && pod?.hla_status === "accepted",
      ),
      listingAgentName,
      listingAgentBrokerage,
    };
  });
