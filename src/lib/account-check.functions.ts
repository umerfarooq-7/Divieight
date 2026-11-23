import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Whether an email already has a divieight account, and as what. An invitation to such an address can never be accepted (one email is one role), so the
 * inviter is told straight away instead of the invitee hitting a sign-up error.
 */
export const checkInviteEmailFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { email: string }) => ({ email: String(input?.email ?? "").trim().toLowerCase().slice(0, 254) }))
  .handler(async ({ data }): Promise<{ kind: "buyer" | "seller" | "agent" | "broker" | null }> => {
    if (!data.email) return { kind: null };
    const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
    const db = supabaseAdmin as unknown as { from: (t: string) => any };
    for (const [table, kind] of [
      ["brokers", "broker"],
      ["agents", "agent"],
      ["buyer_accounts", "buyer"],
      ["sellers", "seller"],
    ] as const) {
      const { data: row } = await db.from(table).select("id").ilike("email", data.email).limit(1).maybeSingle();
      if (row) return { kind };
    }
    return { kind: null };
  });

export const EXISTING_ACCOUNT_MESSAGE = (kind: string) =>
  `That email already has a divieight ${kind} account, so an invitation to it can't be accepted. Use a different email address.`;
