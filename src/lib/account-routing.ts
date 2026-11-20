import { supabase } from "@/integrations/supabase/client";
import { buyerRedirect, ensureBuyerAccount, getBuyerAccount } from "@/lib/buyer";
import { ensureSellerAccount, getSellerAccount } from "@/lib/seller";
import { getPostLoginRedirect } from "@/lib/post-login";
import { agentRedirect, consumeAgentDraft, createAgentProfile, getAgentProfile } from "@/lib/agent";
import { brokerRedirect, createBrokerProfile, getBrokerProfile } from "@/lib/broker";
import { applyReferralTag } from "@/lib/attribution";
import { stampStoredAttribution } from "@/lib/agent-qr";
import { parseMarkets } from "@/lib/markets";

export type AccountRole = "buyer" | "seller" | "agent" | "broker";

const ROLE_KEY = "divieight.oauth_role";

/** Remember which side of the marketplace started an OAuth flow (survives redirect). */
export function setOAuthRole(role: AccountRole) {
  try {
    sessionStorage.setItem(ROLE_KEY, role);
  } catch {
    /* storage unavailable — callback falls back to existing account lookup */
  }
}

export function consumeOAuthRole(): AccountRole | null {
  try {
    const value = sessionStorage.getItem(ROLE_KEY);
    sessionStorage.removeItem(ROLE_KEY);
    return value === "buyer" || value === "seller" || value === "agent" || value === "broker"
      ? value
      : null;
  } catch {
    return null;
  }
}

export interface ResolveResult {
  to?: string;
  error?: string;
}

/**
 * Decide where an authenticated user goes for the side of the marketplace they
 * signed in from, provisioning the missing profile for first-time OAuth users
 * and refusing cross-role signups (one email = one role).
 */
export async function resolveSignIn(
  user: { id: string; email?: string | null; user_metadata?: Record<string, unknown> },
  role: AccountRole | null,
): Promise<ResolveResult> {
  const email = user.email ?? "";
  const fullName = (user.user_metadata?.full_name as string) ?? "";
  const phone = (user.user_metadata?.phone as string) ?? null;

  // The sessionStorage hint is lost when the user confirms via an email link in
  // a new tab, so fall back to the account_type captured at signup.
  const metaRole = user.user_metadata?.account_type;
  // A designated CPA signs in from the invitation: their portal is read-only and has no marketplace profile.
  if (metaRole === "cpa") return { to: "/cpa" };
  const effectiveRole: AccountRole | null =
    role ??
    (metaRole === "buyer" ||
    metaRole === "seller" ||
    metaRole === "agent" ||
    metaRole === "broker"
      ? metaRole
      : null);

  const [buyer, seller, agent, broker] = await Promise.all([
    getBuyerAccount(user.id),
    getSellerAccount(user.id),
    getAgentProfile(user.id),
    getBrokerProfile(user.id),
  ]);

  if (effectiveRole === "broker") {
    if (!broker && (buyer || seller || agent)) {
      await supabase.auth.signOut();
      return {
        error:
          "This email is already registered on another divieight portal. Please use a different email for your Broker of Record account.",
      };
    }
    if (broker) return { to: brokerRedirect(broker.onboarding_status) };

    const meta = user.user_metadata ?? {};
    if (!meta.brokerage_name) return { to: "/broker/register" };
    const created = await createBrokerProfile({
      userId: user.id,
      brokerageName: String(meta.brokerage_name),
      contactName: fullName || String(meta.contact_name ?? ""),
      email,
      phone,
      licenseNumber: String(meta.license_number ?? ""),
      licenseState: String(meta.license_state ?? ""),
      invitedByAgentId: (meta.invited_by_agent_id as string) ?? null,
    });
    if (created.error) return { error: created.error };
    return { to: brokerRedirect(created.broker?.onboarding_status ?? "arello_pending") };
  }

  if (effectiveRole === "agent") {
    if (!agent && (buyer || seller)) {
      await supabase.auth.signOut();
      return {
        error: `This email is already registered as a ${buyer ? "buyer" : "seller"} account. Please use a different email for your professional account.`,
      };
    }
    if (agent) return { to: agentRedirect(agent.onboarding_status) };

    // sessionStorage is empty when the confirmation link opens in another
    // tab/browser, so fall back to the profile captured in user metadata.
    const meta = user.user_metadata ?? {};
    const draft =
      consumeAgentDraft() ??
      (meta.license_number
        ? {
            fullName: fullName,
            phone: phone ?? "",
            markets: parseMarkets(meta.markets ?? meta.service_area),
            licenseNumber: String(meta.license_number ?? ""),
            licenseState: String(meta.license_state ?? ""),
          }
        : null);
    if (!draft) {
      return { to: "/agent/register" };
    }
    const created = await createAgentProfile({
      userId: user.id,
      fullName: draft.fullName || fullName,
      email,
      phone: draft.phone || phone,
      markets: parseMarkets(draft.markets),
      licenseNumber: draft.licenseNumber,
      licenseState: draft.licenseState,
    });
    if (created.error) return { error: created.error };
    return { to: agentRedirect(created.agent?.onboarding_status ?? "arello_pending") };
  }

  if (effectiveRole === "buyer") {
    if (!buyer && (seller || agent)) {
      await supabase.auth.signOut();
      return {
        error: `This email is already registered as ${seller ? "a seller" : "an agent"} account. Please sign in from that portal instead.`,
      };
    }
    const account = buyer ?? (await ensureBuyerAccount({ userId: user.id, email, phone, fullName }));
    // Lead Attribution Tag: stamp the referring agent (or 'direct') once.
    if (account) await applyReferralTag(account.id, user.id);
    // QR / deep-link stamp: a suggestion for the admin, kept apart from the tag above.
    if (account) await stampStoredAttribution();
    return { to: account ? buyerRedirect(account.onboarding_status) : "/buyer/onboarding" };
  }

  if (effectiveRole === "seller") {
    if (!seller && (buyer || agent)) {
      await supabase.auth.signOut();
      return {
        error: `This email is already registered as ${buyer ? "a buyer" : "an agent"} account. Please sign in from that portal instead.`,
      };
    }
    if (!seller) {
      await ensureSellerAccount({ userId: user.id, email, phone, fullName });
    }
    return { to: await getPostLoginRedirect(user.id) };
  }

  // No role hint at all — route by whichever profile exists.
  if (broker) return { to: brokerRedirect(broker.onboarding_status) };
  if (agent) return { to: agentRedirect(agent.onboarding_status) };
  if (buyer) return { to: buyerRedirect(buyer.onboarding_status) };
  if (seller) return { to: await getPostLoginRedirect(user.id) };
  return { to: "/" };
}

