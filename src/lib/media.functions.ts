import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * Resolves storage paths in the `property-media` bucket so browser
 * surfaces (wishlist cards, etc.) can render photos.
 */
export const signPropertyPhotos = createServerFn({ method: "POST" })
  .inputValidator((data) => z.object({ paths: z.array(z.string()).max(100) }).parse(data))
  .handler(async ({ data }): Promise<Record<string, string>> => {
    if (data.paths.length === 0) return {};
    const { resolvePropertyMediaUrls } = await import("@/lib/property-media.server");
    return Object.fromEntries(await resolvePropertyMediaUrls(data.paths));
  });

export const getPropertyCoverPhotos = createServerFn({ method: "POST" })
  .inputValidator((data) =>
    z.object({ propertyIds: z.array(z.string().uuid()).max(100) }).parse(data),
  )
  .handler(async ({ data }): Promise<Record<string, string>> => {
    if (data.propertyIds.length === 0) return {};
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
      const { data: media, error } = await supabaseAdmin
        .from("property_media")
        .select("property_id, url, display_order")
        .in("property_id", data.propertyIds)
        .eq("media_type", "photo")
        .not("url", "is", null)
        .order("display_order", { ascending: true });
      if (error || !media) return {};

      const pathByProperty = new Map<string, string>();
      media.forEach((item) => {
        if (item.url && !pathByProperty.has(item.property_id)) {
          pathByProperty.set(item.property_id, item.url);
        }
      });
      if (pathByProperty.size === 0) return {};

      const { resolvePropertyMediaUrls } = await import("@/lib/property-media.server");
      const urlByPath = await resolvePropertyMediaUrls(Array.from(pathByProperty.values()));

      return Object.fromEntries(
        Array.from(pathByProperty.entries()).flatMap(([propertyId, path]) => {
          const signedUrl = urlByPath.get(path);
          return signedUrl ? [[propertyId, signedUrl]] : [];
        }),
      );
    } catch {
      return {};
    }
  });
