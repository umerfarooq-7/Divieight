/**
 * Agent QR / deep-link attribution: the token format and what the browser keeps
 * between the first visit and registration. This is a separate cookie from the
 * older /r referral cookie on purpose: nothing here sets a referring agent.
 */

export const ATTRIBUTION_STORAGE_KEY = "divieight_agent_attribution";
export const ATTRIBUTION_DAYS = 90;
const MAX_STORED = 5;
const DAY_MS = 86_400_000;

const TOKEN_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const TOKEN_LENGTH = 12;

export const isAttributionToken = (token: string) => /^[a-z2-9]{12}$/.test(token);
/** The older /r links' tokens (eight characters). They are kept as suggestions in the same stamp, never as a referring agent. */
export const isLegacyReferralToken = (token: string) => /^[a-z2-9]{8}$/.test(token);
export const isAnyAttributionToken = (token: string) => isAttributionToken(token) || isLegacyReferralToken(token);

/** Unbiased: bytes that would favour early letters are thrown away. */
export function randomAttributionToken(): string {
  const limit = 256 - (256 % TOKEN_ALPHABET.length);
  let out = "";
  while (out.length < TOKEN_LENGTH) {
    const bytes = new Uint8Array(TOKEN_LENGTH * 2);
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < limit && out.length < TOKEN_LENGTH) out += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
    }
  }
  return out;
}

export interface StoredToken {
  t: string;
  at: number;
}

/** Well-formed tokens under 90 days old, oldest first. Anything else in storage is ignored. */
export function parseStoredTokens(raw: string | null | undefined, now = Date.now()): StoredToken[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is StoredToken =>
        e && typeof e.t === "string" && isAnyAttributionToken(e.t) && typeof e.at === "number" && now - e.at < ATTRIBUTION_DAYS * DAY_MS,
    );
  } catch {
    return [];
  }
}

/**
 * First token wins, so a later one only ever goes behind it. It is kept as the
 * runner-up in case the first has been revoked by the time the buyer registers.
 */
export function addStoredToken(existing: StoredToken[], token: string, now = Date.now()): StoredToken[] {
  if (existing.some((e) => e.t === token)) return existing;
  return [...existing, { t: token, at: now }].slice(0, MAX_STORED);
}

function readCookie(): string | null {
  const match = document.cookie.split("; ").find((c) => c.startsWith(`${ATTRIBUTION_STORAGE_KEY}=`));
  if (!match) return null;
  try {
    return decodeURIComponent(match.slice(ATTRIBUTION_STORAGE_KEY.length + 1));
  } catch {
    return null;
  }
}

function readLocal(): string | null {
  try {
    return window.localStorage.getItem(ATTRIBUTION_STORAGE_KEY);
  } catch {
    return null; // blocked storage: the cookie still carries it
  }
}

/** From whichever survived: a cleared cookie or cleared storage alone doesn't lose the stamp. */
export function readStoredTokens(): string[] {
  if (typeof document === "undefined") return [];
  const fromCookie = parseStoredTokens(readCookie());
  const fromLocal = parseStoredTokens(readLocal());
  const merged = [...fromCookie, ...fromLocal.filter((l) => !fromCookie.some((c) => c.t === l.t))].sort((a, b) => a.at - b.at);
  return merged.map((e) => e.t);
}

export function rememberToken(token: string) {
  if (typeof document === "undefined") return;
  const current = parseStoredTokens(readCookie());
  const local = parseStoredTokens(readLocal());
  const merged = [...current, ...local.filter((l) => !current.some((c) => c.t === l.t))].sort((a, b) => a.at - b.at);
  const value = JSON.stringify(addStoredToken(merged, token));
  document.cookie = `${ATTRIBUTION_STORAGE_KEY}=${encodeURIComponent(value)}; path=/; max-age=${ATTRIBUTION_DAYS * 86_400}; samesite=lax`;
  try {
    window.localStorage.setItem(ATTRIBUTION_STORAGE_KEY, value);
  } catch {
    /* the cookie still carries it */
  }
}

export function clearStoredTokens() {
  if (typeof document === "undefined") return;
  document.cookie = `${ATTRIBUTION_STORAGE_KEY}=; path=/; max-age=0; samesite=lax`;
  try {
    window.localStorage.removeItem(ATTRIBUTION_STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** Sends what the browser holds; never gets in the way of signing in. */
export async function stampStoredAttribution(): Promise<void> {
  const tokens = readStoredTokens();
  if (tokens.length === 0) return;
  try {
    const { stampBuyerAttribution } = await import("@/lib/agent-qr.functions");
    const result = await stampBuyerAttribution({ data: { tokens } });
    if (!result.keep) clearStoredTokens();
  } catch {
    /* best-effort: it stays stored and is tried at the next sign-in */
  }
}
