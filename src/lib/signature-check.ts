/**
 * Server-side signature checks, shared by every signing path. The signature mechanisms are the
 * existing ones (typed initials, typed full name, checkbox); nothing new is verified, but what
 * the browser used to check alone is now checked on the server against the acting member's
 * own account_members.full_name.
 */
import { legalNamesMatch } from "@/lib/eligibility-declaration";
import { nameInitials } from "@/lib/votes";

export const FULL_NAME_MISMATCH = "The signature must be this member's full legal name, exactly as it is on their account.";

const cleanInitials = (s: string) => s.replace(/\s+/g, "").toUpperCase();

/** True when the typed value is the member's initials, by the same rule as the Secondary Verification box. */
export const initialsMatch = (typed: string, fullName: string) => {
  const expected = nameInitials(fullName);
  return expected.length > 0 && cleanInitials(typed) === expected;
};

/**
 * The typed value must be the acting member's own name. For a typed-initials verification the
 * initials themselves (nameInitials of the member's full name) are accepted too; a full name must
 * equal full_name with case, accents, punctuation and spacing normalised.
 * When the caller also has the separately typed initials, they must match as well.
 */
export function assertTypedSignature(params: { typed: string; fullName: string | null; method?: string; typedInitials?: string | null }): void {
  const fullName = (params.fullName ?? "").trim();
  const typed = (params.typed ?? "").trim();
  if (!fullName || !typed) throw new Error(FULL_NAME_MISMATCH);
  const asInitials = params.method === "typed_initials" && initialsMatch(typed, fullName);
  if (!asInitials && !legalNamesMatch(typed, fullName)) {
    throw new Error(params.method === "typed_initials" ? `Type ${fullName}'s initials, or their full legal name, to sign.` : FULL_NAME_MISMATCH);
  }
  if (params.typedInitials != null && !initialsMatch(params.typedInitials, fullName)) throw new Error(`Type ${fullName}'s initials to sign.`);
}
