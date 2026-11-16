/**
 * Production safety: the app must not run for real people on simulated vendors by accident.
 *
 * The real environment is declared with APP_ENV=production (or IS_PRODUCTION=true). When it is declared, every simulated or test-mode adapter is listed, and the server
 * refuses to serve (503) unless ALLOW_SIMULATED_ADAPTERS=true is set on purpose. Without that declaration (dev, staging, preview) nothing is refused: staging is
 * allowed to be simulated. Deliberately NOT keyed on VERCEL_ENV: a Vercel "production" deployment can still be the client's demo.
 */
import { DEFAULT_LIVENESS_PROVIDER } from "@/lib/liveness-adapters";
import { DEFAULT_SANCTIONS_PROVIDER } from "@/lib/sanctions-adapters";

type Env = Record<string, string | undefined>;

export interface SimulatedAdapter {
  key: "liveness" | "sanctions" | "bank_feed" | "ach_disbursement" | "title_escrow" | "stripe";
  message: string;
}

export function isProductionRuntime(env: Env = process.env): boolean {
  return env["APP_ENV"] === "production" || env["IS_PRODUCTION"] === "true";
}

export function simulatedOverrideOn(env: Env = process.env): boolean {
  return env["ALLOW_SIMULATED_ADAPTERS"] === "true";
}

/** Every adapter that is currently simulated, sandboxed or in test mode, from the environment alone. */
export function simulatedAdapters(env: Env = process.env, providers: { liveness: string; sanctions: string } = { liveness: DEFAULT_LIVENESS_PROVIDER, sanctions: DEFAULT_SANCTIONS_PROVIDER }): SimulatedAdapter[] {
  const out: SimulatedAdapter[] = [];
  if (providers.liveness === "simulated") out.push({ key: "liveness", message: "Liveness vendor is simulated." });
  if (providers.sanctions === "simulated") out.push({ key: "sanctions", message: "Sanctions vendor is simulated." });
  if (!(env["PLAID_CLIENT_ID"] && env["PLAID_SECRET"])) out.push({ key: "bank_feed", message: "Bank feed is simulated (no Plaid credentials)." });
  else if (env["PLAID_ENV"] !== "production") out.push({ key: "bank_feed", message: "Bank feed is on Plaid sandbox (PLAID_ENV is not production)." });
  // Only the simulated ACH rail exists (src/lib/disbursement-adapters): nothing leaves any bank account.
  out.push({ key: "ach_disbursement", message: "ACH disbursement is simulated: no money moves." });
  if (!env["QUALIA_API_URL"] || !env["QUALIA_API_TOKEN"]) out.push({ key: "title_escrow", message: "Title and escrow is simulated (no Qualia credentials)." });
  const stripeKey = env["STRIPE_SECRET_KEY"] ?? "";
  if (!stripeKey.startsWith("sk_live_")) out.push({ key: "stripe", message: stripeKey.startsWith("sk_test_") ? "Stripe is in test mode (sk_test_ key)." : "Stripe has no live key." });
  return out;
}

export class ProductionReadinessError extends Error {
  constructor(public readonly adapters: SimulatedAdapter[]) {
    super(`Refusing to run in production with simulated adapters: ${adapters.map((a) => a.key).join(", ")}. Set ALLOW_SIMULATED_ADAPTERS=true to override on purpose.`);
    this.name = "ProductionReadinessError";
  }
}

/** Throws when this is the declared production environment, an adapter is simulated, and the override is not set. Returns the list otherwise (so a caller can log it). */
export function assertProductionReadiness(env: Env = process.env, providers?: { liveness: string; sanctions: string }): SimulatedAdapter[] {
  const sim = simulatedAdapters(env, providers);
  if (!isProductionRuntime(env)) return sim;
  if (sim.length > 0 && !simulatedOverrideOn(env)) throw new ProductionReadinessError(sim);
  return sim;
}
