import { supabase } from "@/integrations/supabase/client";

export interface BuyerAccountRow {
  id: string;
  onboarding_status: string;
}

/** Returns the buyer account for an auth user, or null if they aren't a buyer. */
export async function getBuyerAccount(userId: string): Promise<BuyerAccountRow | null> {
  const { data, error } = await supabase
    .from("buyer_accounts")
    .select("id, onboarding_status")
    .eq("auth_user_id", userId)
    .maybeSingle();
  if (error) return null;
  return data ?? null;
}

/**
 * Google OAuth signups can't carry `account_type` metadata, so the database
 * trigger never fires for them. Create the buyer account + primary member
 * client-side when a buyer signs in through OAuth for the first time.
 */
export async function ensureBuyerAccount(params: {
  userId: string;
  email: string;
  phone?: string | null;
  fullName?: string | null;
}): Promise<BuyerAccountRow | null> {
  const existing = await getBuyerAccount(params.userId);
  if (existing) return existing;

  const { data, error } = await supabase
    .from("buyer_accounts")
    .insert({
      auth_user_id: params.userId,
      email: params.email,
      phone: params.phone ?? null,
    })
    .select("id, onboarding_status")
    .maybeSingle();

  if (error || !data) return null;

  await supabase.from("account_members").insert({
    buyer_account_id: data.id,
    full_name: params.fullName ?? "",
    role: "primary",
    email: params.email,
  });

  return data;
}

/** Where a buyer should land after signing in. */
export function buyerRedirect(onboardingStatus: string): string {
  switch (onboardingStatus) {
    case "not_started":
      return "/buyer/onboarding/members";
    case "lifestyle_survey_pending":
      return "/buyer/onboarding/lifestyle";
    case "payment_pending":
      return "/buyer/onboarding/eligibility";
    case "vetting_pending":
      return "/buyer/onboarding/vetting";
    case "liquidity_pending":
      return "/buyer/onboarding/liquidity";
    case "golden_ticket_pending":
      return "/buyer/golden-ticket";
    case "verification_pending":
      return "/buyer/verification";
    case "adverse_action":
      return "/buyer/adverse-action";
    default:
      return "/buyer/dashboard";
  }
}
