/**
 * The business rules around decrypting a TIN, enforced where the decryption happens.
 *
 * A TIN may be decrypted only inside a declared rule: a person (or the system, for a scheduled export) and a stated reason, set up by one of the three audited
 * paths (the tax export, the tax vault, the CPA view). Each of those writes its audit row first. Any other decryption of a TIN is outside the rules, and
 * raises a Suspicious Activity Alert to the Compliance Officer.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface PiiRule {
  actorId: string | null;
  actorType: "admin" | "cpa" | "system";
  reason: string;
}

const store = new AsyncLocalStorage<PiiRule>();

/** Runs a decryption inside a declared rule. */
export function runWithPiiRule<T>(rule: PiiRule, fn: () => T): T {
  return store.run(rule, fn);
}
export const currentPiiRule = () => store.getStore() ?? null;

/** What a ciphertext is bound to names what it is: only these are TINs (the bank-feed item reference is not). */
const TIN_AAD = /^(member_w9|broker_tax_form|influencer_payee):/;
export const isTinAad = (aad: string) => TIN_AAD.test(aad);

type Handler = (event: { aad: string }) => void | Promise<void>;
const pending = new Set<Promise<unknown>>();

async function defaultHandler(event: { aad: string }) {
  const [{ supabaseAdmin }, vault] = await Promise.all([import("@/integrations/supabase/admin.server"), import("@/lib/audit-vault.server")]);
  await vault.reportDecryptOutsideRules(supabaseAdmin as never, { aad: event.aad });
}
let handler: Handler = defaultHandler;
/** For tests. */
export function setOutOfRuleHandler(h: Handler | null) {
  handler = h ?? defaultHandler;
}
/** Waits for any alert still being written. */
export async function flushPiiAlerts() {
  await Promise.allSettled([...pending]);
}

/** Called by every decryption. Inside a declared rule with a reason: fine. Anything else that decrypts a TIN: an alert (the decryption itself still happens: it is never blocked here). */
export function noteDecrypt(aad: string): void {
  if (!isTinAad(aad)) return;
  const rule = currentPiiRule();
  if (rule && rule.reason.trim()) return;
  const p = Promise.resolve()
    .then(() => handler({ aad }))
    .catch(() => undefined)
    .finally(() => pending.delete(p));
  pending.add(p);
}
