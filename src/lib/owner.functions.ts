import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { formatUsd } from "@/lib/stripe";

/**
 * Post-closing Owner Dashboard. An owner is a user with a cap table row for the
 * property — through their Buyer Account or as a retained seller (the same rule
 * as is_property_owner in owner-dashboard.sql). Owner features open once the
 * Operating Agreement is executed and the Closing Ping Saga has issued the
 * user's Digital Key. Every read here is for one user and one property.
 */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

interface CapRow {
  property_id: string;
  share_number: number;
  holder_type: string;
  buyer_account_id: string | null;
  seller_id: string | null;
  acquisition_date: string;
  retention_lock_expires_at: string;
}

export interface OwnerPropertySummary {
  propertyId: string;
  label: string;
  photo: string | null;
  llcName: string | null;
  shareCount: number;
  active: boolean;
}

export interface OwnerPropertyDetail extends OwnerPropertySummary {
  market: string;
  einStatus: string | null;
  shareNumbers: number[];
  /** Which kind of retained share each one is; buyer shares have no label. */
  shareLabels: Array<{ shareNumber: number; label: string }>;
  acquisitionDate: string | null;
  /** The latest Retention Lock across this owner's shares. */
  retentionLockExpiresAt: string | null;
  capital: { contributed: number; distributions: number; net: number } | null;
  /** This holder's next Use Calendar weeks. */
  upcomingStays: Array<{ weekNumber: number; startDate: string; endDate: string }>;
}

export type OwnerPropertyResult =
  | { access: "none" }
  | { access: "inactive"; property: Pick<OwnerPropertySummary, "propertyId" | "label" | "photo" | "shareCount"> }
  | { access: "active"; property: OwnerPropertyDetail };

/** The user's own cap table rows, optionally for one property. */
async function myCapRows(db: Db, userId: string, propertyId?: string): Promise<{ rows: CapRow[]; buyerAccountId: string | null }> {
  const { data: buyer } = await db.from("buyer_accounts").select("id").eq("auth_user_id", userId).maybeSingle();
  const buyerAccountId = (buyer?.id as string | undefined) ?? null;
  const cols = "property_id, share_number, holder_type, buyer_account_id, seller_id, acquisition_date, retention_lock_expires_at";
  const query = (column: string, value: string, holderType: string) => {
    let q = db.from("cap_table_entries").select(cols).eq(column, value).eq("holder_type", holderType);
    if (propertyId) q = q.eq("property_id", propertyId);
    return q;
  };
  const [asBuyer, asSeller] = await Promise.all([
    buyerAccountId ? query("buyer_account_id", buyerAccountId, "buyer_account") : Promise.resolve({ data: [] }),
    query("seller_id", userId, "retained_seller"),
  ]);
  return { rows: [...((asBuyer.data ?? []) as CapRow[]), ...((asSeller.data ?? []) as CapRow[])], buyerAccountId };
}

/** Executed Operating Agreement + this user's active Digital Key on the property. */
async function ownerFeaturesActive(db: Db, propertyId: string, userId: string, buyerAccountId: string | null): Promise<boolean> {
  const { data: genesis } = await db.from("entity_genesis").select("oa_executed_at").eq("property_id", propertyId).maybeSingle();
  if (!genesis?.oa_executed_at) return false;
  const { data: keys } = await db
    .from("co_owner_digital_keys")
    .select("holder_type, buyer_account_id, seller_id")
    .eq("property_id", propertyId)
    .eq("status", "active");
  return ((keys ?? []) as Array<{ holder_type: string; buyer_account_id: string | null; seller_id: string | null }>).some((k) =>
    k.holder_type === "retained_seller" ? k.seller_id === userId : Boolean(buyerAccountId) && k.buyer_account_id === buyerAccountId,
  );
}

export async function propertyCard(db: Db, propertyId: string) {
  const { data: p } = await db.from("properties").select("id, address, city, state").eq("id", propertyId).maybeSingle();
  const { data: media } = await db
    .from("property_media")
    .select("url, display_order")
    .eq("property_id", propertyId)
    .eq("media_type", "photo")
    .order("display_order", { ascending: true })
    .limit(1);
  const path = ((media ?? [])[0] as { url: string } | undefined)?.url ?? null;
  let photo: string | null = null;
  if (path) {
    const { resolvePropertyMediaUrls } = await import("@/lib/property-media.server");
    photo = (await resolvePropertyMediaUrls([path])).get(path) ?? null;
  }
  return {
    label: p ? [p.address, p.city, p.state].filter(Boolean).join(", ") : "Your property",
    market: p ? [p.city, p.state].filter(Boolean).join(", ") : "",
    photo,
  };
}

/**
 * What a retained seller's shares are: the first is the free Legacy Seat, each
 * other is an extra share with its enrollment fee. The fee is read from the
 * seller's payment, never worked out here. Payments carry no property today, so
 * one belongs to the listing the seller created most recently before paying.
 */
async function retainedShareLabels(db: Db, propertyId: string, userId: string, rows: CapRow[]): Promise<Array<{ shareNumber: number; label: string }>> {
  const held = rows
    .filter((r) => r.holder_type === "retained_seller")
    .map((r) => r.share_number)
    .sort((a, b) => a - b);
  if (held.length === 0) return [];
  // Retained shares are numbered first, so a sale or a later purchase can't relabel them.
  const { data: property } = await db.from("properties").select("retained_shares").eq("id", propertyId).maybeSingle();
  const originallyRetained = (property?.retained_shares as number | null) ?? held.length;
  const retained = held.filter((n) => n <= originallyRetained);
  if (retained.length === 0) return [];
  const extras = originallyRetained - 1;

  const { data: payments } = await db
    .from("enrollment_payments")
    .select("property_id, retained_shares, amount_cents, created_at")
    .eq("seller_id", userId)
    .eq("status", "paid");
  const { data: listings } = await db.from("properties").select("id, created_at").eq("seller_id", userId);
  const created = ((listings ?? []) as Array<{ id: string; created_at: string }>).map((l) => ({ id: l.id, at: new Date(l.created_at).getTime() }));
  const listingOf = (paidAt: string) =>
    created.filter((l) => l.at <= new Date(paidAt).getTime()).sort((a, b) => b.at - a.at)[0]?.id ?? null;
  const payment = ((payments ?? []) as Array<{ property_id: string | null; retained_shares: number; amount_cents: number; created_at: string }>).find(
    (p) => p.retained_shares === originallyRetained && (p.property_id ?? listingOf(p.created_at)) === propertyId,
  );

  return retained.map((shareNumber) => ({
    shareNumber,
    label:
      shareNumber === 1
        ? "Legacy Seat (free)"
        : payment
          ? `Extra retained share (paid ${formatUsd(payment.amount_cents / extras)})`
          : "Extra retained share (payment not on record)",
  }));
}

export interface CoOwnerBanner {
  propertyId: string;
  llcName: string;
  shareCount: number;
}

/**
 * The "you are now a co-owner" banners due to this retained seller: properties
 * that are active and haven't shown one. Claiming the row is what makes it
 * one-time, even across two tabs; if it can't be claimed nothing is shown.
 */
export async function claimBanners(db: Db, userId: string): Promise<CoOwnerBanner[]> {
  const { rows, buyerAccountId } = await myCapRows(db, userId);
  const retained = rows.filter((r) => r.holder_type === "retained_seller");
  const banners: CoOwnerBanner[] = [];
  for (const propertyId of [...new Set(retained.map((r) => r.property_id))]) {
    if (!(await ownerFeaturesActive(db, propertyId, userId, buyerAccountId))) continue;
    const { error } = await db.from("owner_activation_notices").insert({ user_id: userId, property_id: propertyId });
    if (error) continue;
    const { data: genesis } = await db.from("entity_genesis").select("llc_name").eq("property_id", propertyId).maybeSingle();
    banners.push({
      propertyId,
      llcName: (genesis?.llc_name as string | null) ?? (await propertyCard(db, propertyId)).label,
      shareCount: retained.filter((r) => r.property_id === propertyId).length,
    });
  }
  return banners;
}

export const claimCoOwnerBanners = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ banners: CoOwnerBanner[] }> => ({
    banners: await claimBanners(await adminDb(), context.userId),
  }));

/** Whether to show the Owner entry in the header. */
export const getOwnerNavState = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ isOwner: boolean }> => {
    const { rows } = await myCapRows(await adminDb(), context.userId);
    return { isOwner: rows.length > 0 };
  });

/** /owner — one card per property the user holds shares in. */
export const listOwnerProperties = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ properties: OwnerPropertySummary[] }> => {
    const db = await adminDb();
    const { rows, buyerAccountId } = await myCapRows(db, context.userId);
    const out: OwnerPropertySummary[] = [];
    for (const propertyId of [...new Set(rows.map((r) => r.property_id))]) {
      const { label, photo } = await propertyCard(db, propertyId);
      const { data: genesis } = await db.from("entity_genesis").select("llc_name").eq("property_id", propertyId).maybeSingle();
      out.push({
        propertyId,
        label,
        photo,
        llcName: (genesis?.llc_name as string | null) ?? null,
        shareCount: rows.filter((r) => r.property_id === propertyId).length,
        active: await ownerFeaturesActive(db, propertyId, context.userId, buyerAccountId),
      });
    }
    return { properties: out };
  });

/** One owned property for one user: nothing about a property they don't own. */
export async function loadOwnerProperty(db: Db, userId: string, propertyId: string): Promise<OwnerPropertyResult> {
  const { rows, buyerAccountId } = await myCapRows(db, userId, propertyId);
  if (rows.length === 0) return { access: "none" };

  const { label, market, photo } = await propertyCard(db, propertyId);
  const base = { propertyId: propertyId, label, photo, shareCount: rows.length };
  if (!(await ownerFeaturesActive(db, propertyId, userId, buyerAccountId)))
    return { access: "inactive", property: base };

  const { data: genesis } = await db
    .from("entity_genesis")
    .select("llc_name, ein_status")
    .eq("property_id", propertyId)
    .maybeSingle();
  // Empty state (not an error) when there's no row, or before the SQL is run.
  const { data: capitalRow } = await db
    .from("owner_capital_accounts")
    .select("contributed_amount, distributions_amount")
    .eq("property_id", propertyId)
    .eq("user_id", userId)
    .maybeSingle();
  const contributed = Number(capitalRow?.contributed_amount ?? 0);
  const distributions = Number(capitalRow?.distributions_amount ?? 0);
  const latest = (values: string[]) => (values.length ? values.reduce((a, b) => (new Date(a) >= new Date(b) ? a : b)) : null);
  const earliest = (values: string[]) => (values.length ? values.reduce((a, b) => (new Date(a) <= new Date(b) ? a : b)) : null);

  return {
    access: "active",
    property: {
      ...base,
      market,
      active: true,
      llcName: (genesis?.llc_name as string | null) ?? null,
      einStatus: (genesis?.ein_status as string | null) ?? null,
      shareNumbers: rows.map((r) => r.share_number).sort((a, b) => a - b),
      shareLabels: await retainedShareLabels(db, propertyId, userId, rows),
      acquisitionDate: earliest(rows.map((r) => r.acquisition_date)),
      retentionLockExpiresAt: latest(rows.map((r) => r.retention_lock_expires_at)),
      capital: capitalRow ? { contributed, distributions, net: contributed - distributions } : null,
      upcomingStays: await (await import("@/lib/use-calendar.server")).nextStays(
        db,
        propertyId,
        rows[0]!.holder_type === "retained_seller" ? `seller:${userId}` : (buyerAccountId as string),
      ),
    },
  };
}

/** /owner/properties/:id */
export const getOwnerProperty = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => {
    if (!input?.propertyId) throw new Error("Missing property");
    return { propertyId: String(input.propertyId) };
  })
  .handler(async ({ data, context }): Promise<OwnerPropertyResult> =>
    loadOwnerProperty(await adminDb(), context.userId, data.propertyId),
  );
