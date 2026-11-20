/**
 * Co-buyers as limited sub-accounts (shared by the screens and the server). A co-buyer is an Account Member of the main buyer's own account who signs in
 * with a login of their own. They do their own steps and sign for the shares the main buyer chose to buy with them; everything else stays with the account.
 */
import { isValidEmail, normalizeEmail } from "@/lib/account-members";

export const CO_BUYER_MESSAGES = {
  self: "Use someone else's email address: your co-buyer signs in with their own.",
  haveOne: "You already have a co-buyer. Remove them first to invite someone else.",
  onlyHolder: "Only the account holder can invite a co-buyer.",
  notFound: "That invitation can't be found, or it has already been used.",
  wrongEmail: "This invitation was sent to a different email address. Sign up with the address it was sent to.",
  hasAccount: "That email already has a buyer account of its own. A co-buyer needs a new email address.",
  notJoined: "Your co-buyer hasn't accepted the invitation yet, so they can't be added to a share.",
  onShares: "Your co-buyer is on a share you are buying together. Take them off those shares first.",
  tooSoon: "An invitation was sent a moment ago. Wait a minute before sending it again.",
  locked: "This share can't be changed any more: its cap table is locked for closing.",
  notYours: "That share isn't yours.",
} as const;

export function checkInviteInput(input: { name: string; email: string }): { name: string; email: string } {
  const name = input.name.trim();
  if (name.length < 2) throw new Error("Enter their full name.");
  if (name.length > 100) throw new Error("Their name must be under 100 characters.");
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) throw new Error("Enter a valid email address.");
  return { name, email };
}

/** The link in an invitation email: it opens a sign-up with the address filled in. */
export const inviteLink = (token: string) => `/buyer/co-buyer/join?token=${encodeURIComponent(token)}`;

export interface CoBuyerView {
  memberId: string;
  name: string;
  email: string | null;
  /** invited: no login yet. joined: signed up. */
  state: "invited" | "joined";
  invitedAt: string | null;
  joinedAt: string | null;
  /** How far they are, in words that reveal nothing private. */
  progress: { done: number; total: number };
  /** The shares they are on. */
  shares: Array<{ reservationId: string; propertyId: string; address: string }>;
}

/** What the reserve screen offers when the account has a co-buyer. */
export interface CoBuyerChoice {
  memberId: string;
  name: string;
  available: boolean;
  unavailableReason: string | null;
}

const TOKEN_KEY = "divieight.co_buyer_token";

/** The invitation token survives the email-confirmation round trip, so the invitation is claimed on first sign-in. */
export function rememberInviteToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage blocked: the join page claims it directly */
  }
}

export function takeInviteToken(): string | null {
  try {
    const t = localStorage.getItem(TOKEN_KEY);
    if (t) localStorage.removeItem(TOKEN_KEY);
    return t;
  } catch {
    return null;
  }
}

/** The co-buyer's own portal: what they need to do, and the shares they are on. */
export interface CoBuyerSelf {
  memberId: string;
  name: string;
  email: string | null;
  holderName: string;
  identityDone: boolean;
  w9Done: boolean;
  feePaid: boolean;
  shares: Array<{ reservationId: string; propertyId: string; address: string }>;
}

/**
 * A co-buyer's own steps, once, in the order they are done. Each opens the screen where it is done (the same screens the account holder used);
 * the consents and the fee are done in the portal itself.
 */
export const COBUYER_STEPS: Array<{
  key: string;
  label: string;
  blurb: string;
  path?: "/buyer/onboarding/identity" | "/buyer/onboarding/liveness" | "/buyer/onboarding/eligibility" | "/buyer/onboarding/payment" | "/buyer/onboarding/vetting" | "/buyer/onboarding/w9";
}> = [
  { key: "identity", label: "Identity", blurb: "Upload your driver's license and confirm your details.", path: "/buyer/onboarding/identity" },
  { key: "liveness", label: "Liveness check", blurb: "A quick selfie to confirm it is really you.", path: "/buyer/onboarding/liveness" },
  { key: "standard", label: "Read the Eligibility Standard", blurb: "Read the Participant Eligibility Standard.", path: "/buyer/onboarding/eligibility" },
  { key: "independent_advice", label: "Independent advice notice", blurb: "Acknowledge the recommendation to take independent professional advice.", path: "/buyer/onboarding/payment" },
  { key: "pra", label: "Priority Reservation Agreement", blurb: "Read and sign the agreement with your own legal name.", path: "/buyer/onboarding/payment" },
  { key: "declaration", label: "Eligibility declaration", blurb: "Answer the eligibility statements yourself.", path: "/buyer/onboarding/vetting" },
  { key: "hold_harmless", label: "Hold harmless", blurb: "Read and sign the hold harmless acknowledgment.", path: "/buyer/onboarding/vetting" },
  { key: "w9", label: "W-9 tax form", blurb: "Your tax details, needed for any distributions you receive.", path: "/buyer/onboarding/w9" },
  { key: "block1", label: "Account linking consent", blurb: "Your consent to link accounts for the liquidity check." },
  { key: "block2", label: "Entity formation authorization", blurb: "Your authorization to form the entity that holds the home." },
  { key: "fee", label: "Platform enrollment fee", blurb: "Your own one-time enrollment fee." },
];
