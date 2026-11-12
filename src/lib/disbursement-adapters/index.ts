/** The disbursement registry. Only the simulated rail exists: no real money moves. */
import type { DisbursementAdapter } from "@/lib/disbursement";
import { SimulatedDisbursementAdapter } from "./simulated";

let override: DisbursementAdapter | null = null;
export function setDisbursementAdapterForTesting(adapter: DisbursementAdapter | null) {
  override = adapter;
}

export function getDisbursementAdapter(): DisbursementAdapter {
  return override ?? new SimulatedDisbursementAdapter();
}
