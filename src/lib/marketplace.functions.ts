import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export interface MarketplaceProperty {
  id: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  listing_price: number | null;
  property_type: string | null;
  usage_tag: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  square_footage: number | null;
  amenities: string[];
  retained_shares: number | null;
  exit_type: string | null;
  listing_status: string;
  /** Live count of buyer-reserved 1/8th slices (aggregate only, no buyer PII). */
  reserved_shares: number;
  photo: string | null;
}

/**
 * Public "Open Discovery" read for the /properties marketplace.
 * Uses the publishable key, so anon RLS applies: only `status = 'listed'`
 * rows (draft / pending_review never leak). Photos are signed with the
 * service role because the media bucket is private.
 */
export const getMarketplaceProperties = createServerFn({ method: "GET" }).handler(
  async (): Promise<MarketplaceProperty[]> => {
    const url = process.env.SUPABASE_URL!;
    const key = process.env.SUPABASE_PUBLISHABLE_KEY!;

    const supabasePublic = createClient<Database>(url, key, {
      auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (input, init) => {
          const h = new Headers(init?.headers);
          if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`) {
            h.delete("Authorization");
          }
          h.set("apikey", key);
          return fetch(input, { ...init, headers: h });
        },
      },
    });

    const { data, error } = await supabasePublic
      .from("properties")
      .select(
        "id, address, city, state, zip, listing_price, property_type, usage_tag, bedrooms, bathrooms, square_footage, amenities, retained_shares, exit_type, listing_status",
      )
      .eq("status", "listed")
      .order("created_at", { ascending: false })
      .limit(200);

    if (error || !data) return [];

    const rows: MarketplaceProperty[] = data.map((p) => ({
      ...p,
      amenities: Array.isArray(p.amenities) ? (p.amenities as string[]) : [],
      reserved_shares: 0,
      photo: null,
    }));
    if (rows.length === 0) return rows;

    // Aggregate reserved slices so the Eight-Slices Tracker on the marketplace
    // matches the pod shown on the property detail page.
    const { data: reservations } = await supabasePublic
      .from("pod_reservations")
      .select("property_id, shares_reserved")
      .in(
        "property_id",
        rows.map((r) => r.id),
      )
      .eq("status", "reserved");
    const reservedByProp = new Map<string, number>();
    (reservations ?? []).forEach((r) => {
      reservedByProp.set(
        r.property_id,
        (reservedByProp.get(r.property_id) ?? 0) + (r.shares_reserved ?? 0),
      );
    });
    rows.forEach((r) => {
      r.reserved_shares = reservedByProp.get(r.id) ?? 0;
    });

    const { data: media } = await supabasePublic
      .from("property_media")
      .select("property_id, url, display_order")
      .in(
        "property_id",
        rows.map((r) => r.id),
      )
      .eq("media_type", "photo")
      .order("display_order", { ascending: true });

    const firstByProp = new Map<string, string>();
    (media ?? []).forEach((m) => {
      if (m.url && !firstByProp.has(m.property_id)) firstByProp.set(m.property_id, m.url);
    });

    const paths = Array.from(firstByProp.values());
    if (paths.length > 0) {
      const { resolvePropertyMediaUrls } = await import("@/lib/property-media.server");
      const byPath = await resolvePropertyMediaUrls(paths);
      rows.forEach((r) => {
        const path = firstByProp.get(r.id);
        r.photo = path ? (byPath.get(path) ?? null) : null;
      });
    }

    return rows;
  },
);

export interface MarketplacePropertyDetail extends MarketplaceProperty {
  description: string | null;
  photos: { url: string; caption: string | null }[];
}

/**
 * Public detail read for /properties/$id. Anon RLS keeps drafts hidden;
 * the service role only signs media URLs for the private bucket.
 */
export const getMarketplaceProperty = createServerFn({ method: "GET" })
  .inputValidator((data: { id: string }) => ({ id: String(data.id) }))
  .handler(async ({ data }): Promise<MarketplacePropertyDetail | null> => {
    const url = process.env.SUPABASE_URL!;
    const key = process.env.SUPABASE_PUBLISHABLE_KEY!;

    const supabasePublic = createClient<Database>(url, key, {
      auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (input, init) => {
          const h = new Headers(init?.headers);
          if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`) {
            h.delete("Authorization");
          }
          h.set("apikey", key);
          return fetch(input, { ...init, headers: h });
        },
      },
    });

    const { data: row, error } = await supabasePublic
      .from("properties")
      .select(
        "id, address, city, state, zip, listing_price, property_type, usage_tag, bedrooms, bathrooms, square_footage, amenities, retained_shares, exit_type, listing_status, description",
      )
      .eq("id", data.id)
      .eq("status", "listed")
      .maybeSingle();

    if (error || !row) return null;

    const { data: reservations } = await supabasePublic
      .from("pod_reservations")
      .select("shares_reserved")
      .eq("property_id", data.id)
      .eq("status", "reserved");
    const reservedShares = (reservations ?? []).reduce(
      (sum, r) => sum + (r.shares_reserved ?? 0),
      0,
    );

    const { data: media } = await supabasePublic
      .from("property_media")
      .select("url, caption, display_order")
      .eq("property_id", data.id)
      .eq("media_type", "photo")
      .order("display_order", { ascending: true });

    const paths = (media ?? []).map((m) => m.url).filter((u): u is string => !!u);
    const { resolvePropertyMediaUrls } = await import("@/lib/property-media.server");
    const byPath = await resolvePropertyMediaUrls(paths);

    const photos = (media ?? [])
      .map((m) => ({ url: m.url ? (byPath.get(m.url) ?? null) : null, caption: m.caption }))
      .filter((p): p is { url: string; caption: string | null } => !!p.url);

    return {
      ...row,
      amenities: Array.isArray(row.amenities) ? (row.amenities as string[]) : [],
      reserved_shares: reservedShares,
      photo: photos[0]?.url ?? null,
      photos,
    };
  });
