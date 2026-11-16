import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { DataRoomDocument } from "@/lib/data-room";

export interface DataRoomPayload {
  /** false when the buyer has no Golden Ticket — the route must bounce them back. */
  allowed: boolean;
  reason: "ok" | "no_buyer_account" | "no_golden_ticket" | "not_found";
  property: { id: string; address: string; city: string; state: string; zip: string } | null;
  documents: (DataRoomDocument & { signed_url: string | null })[];
}

/**
 * Golden-Ticket-gated read of a property's Virtual Data Room.
 * The gate is enforced server-side: without `golden_ticket_issued` the
 * handler never signs a single document URL.
 */
export const getDataRoom = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { propertyId: string }) => ({
    propertyId: String(data.propertyId),
  }))
  .handler(async ({ data, context }): Promise<DataRoomPayload> => {
    const { supabase, userId } = context;
    const empty = { property: null, documents: [] };

    const { data: buyer } = await supabase
      .from("buyer_accounts")
      .select("id, golden_ticket_issued")
      .eq("auth_user_id", userId)
      .maybeSingle();

    if (!buyer) return { allowed: false, reason: "no_buyer_account", ...empty };
    if (!buyer.golden_ticket_issued)
      return { allowed: false, reason: "no_golden_ticket", ...empty };

    const { data: property } = await supabase
      .from("properties")
      .select("id, address, city, state, zip")
      .eq("id", data.propertyId)
      .eq("status", "listed")
      .maybeSingle();

    if (!property) return { allowed: false, reason: "not_found", ...empty };

    const { data: docs } = await supabase
      .from("property_documents")
      .select("id, property_id, document_name, document_type, file_url, uploaded_at")
      .eq("property_id", data.propertyId)
      .order("uploaded_at", { ascending: false });

    const rows = (docs ?? []) as DataRoomDocument[];
    const byPath = new Map<string, string>();

    if (rows.length > 0) {
      try {
        const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
        const { data: signed } = await supabaseAdmin.storage
          .from("property-documents")
          .createSignedUrls(
            rows.map((r) => r.file_url),
            600,
          );
        (signed ?? []).forEach((s) => {
          if (s.path && s.signedUrl) byPath.set(s.path, s.signedUrl);
        });
      } catch {
        // documents still list, they just won't open
      }
    }

    return {
      allowed: true,
      reason: "ok",
      property,
      documents: rows.map((r) => ({ ...r, signed_url: byPath.get(r.file_url) ?? null })),
    };
  });
