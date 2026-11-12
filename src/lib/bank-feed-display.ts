/** Display helpers for the bank feed page (safe for the browser: no server imports). */
export { reviewReasonLabel } from "@/lib/bank-feed";

export const formatCents = (cents: number) => (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" });
