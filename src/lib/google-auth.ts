import { supabase } from "@/integrations/supabase/client";
import { setOAuthRole, type AccountRole } from "@/lib/account-routing";

/**
 * Start Google OAuth against the project's own Supabase Auth.
 * Always a full-page redirect back to /auth/callback, where the session is
 * hydrated and the role routing happens.
 */
export async function signInWithGoogle(role: AccountRole | null): Promise<{ error?: string }> {
  if (role) setOAuthRole(role);
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${window.location.origin}/auth/callback`,
      queryParams: { prompt: "select_account" },
    },
  });
  if (error) return { error: error.message };
  return {};
}
