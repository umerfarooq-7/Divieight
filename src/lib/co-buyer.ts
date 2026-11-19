/**
 * Co-buyers. Two buyers, each with their own account, login, onboarding, payment and Golden Ticket, can link to each other and
 * then choose to reserve a share together. Shared by the screens and the server.
 */
import { isValidEmail, normalizeEmail } from "@/lib/account-members";

export type CoBuyerStatus = "invited" | "active" | "declined" | "revoked";

/** A link that still counts: one open link per inviting account. */
export const isOpenLink = (status: CoBuyerStatus) => status === "invited" || status === "active";

export const CO_BUYER_MESSAGES = {
  self: "Use someone else's email address: your co-buyer needs their own account.",
  alreadyLinked: "You already have a co-buyer, or an invitation that hasn't been answered yet.",
  youAreLinked: "You are already linked to another buyer as their co-buyer.",
  theyAreLinked: "That person is already linked to another buyer.",
  notYours: "That invitation isn't yours.",
  wrongEmail: "This invitation was sent to a different email address. Sign in with the address it was sent to.",
  notFound: "That invitation can't be found, or it has already been answered.",
  tooSoon: "An invitation was sent a moment ago. Wait a minute before sending it again.",
} as const;

export interface CoBuyerLinkView {
  id: string;
  /** Whether you invited them, or they invited you. */
  role: "inviter" | "invitee";
  status: "invited" | "active";
  partnerName: string;
  partnerEmail: string | null;
  invitedAt: string;
  acceptedAt: string | null;
  /** Only once active: how far your co-buyer is, in words that reveal nothing private. */
  partnerProgress: "onboarding" | "ready" | null;
}

export interface IncomingCoBuyerInvite {
  id: string;
  inviterName: string;
  invitedAt: string;
}

export interface MyCoBuyer {
  accountId: string;
  link: CoBuyerLinkView | null;
  incoming: IncomingCoBuyerInvite[];
}

export function checkInviteInput(input: { name: string; email: string }): { name: string; email: string } {
  const name = input.name.trim();
  if (name.length < 2) throw new Error("Enter their full name.");
  if (name.length > 100) throw new Error("Their name must be under 100 characters.");
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) throw new Error("Enter a valid email address.");
  return { name, email };
}

/** The link in an invitation email: it opens sign-up with the address filled in. */
export const inviteLink = (token: string) => `/buyer/register?co_buyer=${encodeURIComponent(token)}`;

const TOKEN_KEY = "divieight.co_buyer_token";

/** The invitation token survives the email-confirmation round trip, so the invitation is accepted on first sign-in. */
export function rememberInviteToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage blocked: the invitation is still accepted from the dashboard */
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
