/**
 * The simulated ACH rail. Nothing leaves any account. Behaviour is chosen by the bank details, so every outcome can be seen live:
 *   an account number ending 0002 fails, one ending 0003 is delayed (processing until it is checked), anything else succeeds.
 * Tests can also script outcomes per token with fail(), delay() and settle(). It keeps no state between calls except what a
 * test sets, so a delayed transfer settles the first time it is checked.
 */
import { createHash, randomBytes } from "node:crypto";
import type { AchResult, DisbursementAdapter } from "@/lib/disbursement";

export class SimulatedDisbursementAdapter implements DisbursementAdapter {
  readonly provider = "simulated";
  /** Every send, in order: what a test inspects. */
  readonly sent: Array<{ memberBankRef: string; amountCents: number; idempotencyKey: string }> = [];
  private failing = new Map<string, string>();
  private delayed = new Set<string>();
  private settled = new Map<string, AchResult>();
  private results = new Map<string, AchResult>();
  /** Make every send to this token fail. */
  fail(token: string, reason = "The bank returned the transfer (simulated).") {
    this.failing.set(token, reason);
    return this;
  }
  /** Make every send to this token stay 'processing' until settle() (or the first check). */
  delay(token: string) {
    this.delayed.add(token);
    return this;
  }
  /** Decide how a delayed transfer ends. */
  settle(idempotencyKey: string, state: "sent" | "failed", reason?: string) {
    this.settled.set(idempotencyKey, { state, ref: `sim_${idempotencyKey.slice(0, 8)}`, reason });
  }

  async tokenizeBank(details: { routing: string; account: string }) {
    const account = details.account.replace(/\s/g, "");
    const last4 = account.slice(-4);
    const kind = last4 === "0002" ? "fail" : last4 === "0003" ? "slow" : "ok";
    const salt = randomBytes(6).toString("hex");
    const digest = createHash("sha256").update(`${details.routing}:${account}:${salt}`).digest("hex").slice(0, 16);
    return { token: `tok_sim_${kind}_${digest}${salt}`, last4 };
  }

  async sendAch(memberBankRef: string, amountCents: number, idempotencyKey: string): Promise<AchResult> {
    const earlier = this.results.get(idempotencyKey);
    if (earlier) return earlier;
    this.sent.push({ memberBankRef, amountCents, idempotencyKey });
    const ref = `sim_${idempotencyKey.slice(0, 8)}`;
    let result: AchResult;
    if (this.failing.has(memberBankRef)) result = { state: "failed", ref, reason: this.failing.get(memberBankRef) };
    else if (memberBankRef.startsWith("tok_sim_fail_")) result = { state: "failed", ref, reason: "The bank returned the transfer: account closed (simulated)." };
    else if (this.delayed.has(memberBankRef) || memberBankRef.startsWith("tok_sim_slow_")) result = { state: "processing", ref };
    else result = { state: "sent", ref };
    this.results.set(idempotencyKey, result);
    return result;
  }

  async checkAch(memberBankRef: string, idempotencyKey: string): Promise<AchResult> {
    const decided = this.settled.get(idempotencyKey);
    if (decided) return decided;
    const earlier = this.results.get(idempotencyKey);
    if (earlier && earlier.state !== "processing") return earlier;
    // A delayed transfer from an earlier request: it clears the first time it is checked, unless a test decided otherwise.
    return { state: "sent", ref: `sim_${idempotencyKey.slice(0, 8)}` };
  }
}
