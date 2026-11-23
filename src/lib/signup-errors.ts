import type { AuthError } from "@supabase/supabase-js";

export type SignupFieldError = { field: "email" | "password" | "form"; message: string };

/**
 * Map a Supabase Auth signUp failure onto an inline field error so nothing is
 * silently swallowed (duplicate email, weak password, invalid email format).
 */
export function mapSignupError(error: AuthError | { message: string; code?: string; status?: number }): SignupFieldError {
  const message = (error.message ?? "").toLowerCase();
  const code = (("code" in error && error.code) || "").toString().toLowerCase();

  if (
    code === "user_already_exists" ||
    code === "email_exists" ||
    message.includes("already registered") ||
    message.includes("already exists") ||
    message.includes("already been registered") ||
    message.includes("duplicate key")
  ) {
    return {
      field: "email",
      message: "An account with this email already exists. Try logging in instead.",
    };
  }

  if (code === "email_address_invalid" || message.includes("invalid email") || message.includes("valid email")) {
    return { field: "email", message: "Enter a valid email address." };
  }

  if (
    code === "weak_password" ||
    message.includes("password should be") ||
    message.includes("weak password") ||
    message.includes("password is too")
  ) {
    return {
      field: "password",
      message: error.message || "Choose a stronger password (at least 8 characters).",
    };
  }

  if (message.includes("rate limit") || message.includes("too many")) {
    return { field: "form", message: "Too many attempts. Please wait a moment and try again." };
  }

  // The auth server failed without saying why (an empty `{}` body). The usual cause is an address that already has an account, so say that.
  const status = ("status" in error && typeof error.status === "number" ? error.status : 0) || 0;
  const empty = !error.message || error.message.trim() === "{}" || /^\{\s*\}$/.test(error.message.trim());
  if (status >= 500 || empty) {
    return {
      field: "email",
      message: "We couldn't create this account. If this email is already registered, sign in instead; otherwise try again or use a different email.",
    };
  }
  return { field: "form", message: error.message || "Registration failed. Please try again." };
}

/**
 * Supabase can return a "fake" success for an existing confirmed email
 * (identities array empty) to avoid user enumeration — treat that as taken.
 */
export function isExistingUserSignup(user: { identities?: unknown[] | null } | null): boolean {
  return Boolean(user && Array.isArray(user.identities) && user.identities.length === 0);
}
