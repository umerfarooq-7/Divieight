import { centsFromDollars, type BankFeedAdapter, type BankFeedBatch, type BankFeedTransaction, type LinkedBankAccount } from "@/lib/bank-feed";

const BASE = "https://sandbox.plaid.com";

async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: process.env["PLAID_CLIENT_ID"], secret: process.env["PLAID_SECRET"], ...body }),
  });
  const json = (await res.json().catch(() => ({}))) as { error_message?: string } & T;
  if (!res.ok) throw new Error(`Plaid sandbox ${path}: ${json.error_message ?? res.status}`);
  return json;
}

/** Plaid in SANDBOX only: a test institution, no real bank. Needs PLAID_CLIENT_ID and PLAID_SECRET (sandbox). */
export class PlaidSandboxAdapter implements BankFeedAdapter {
  readonly provider = "plaid_sandbox";

  async link(_params: { propertyId: string }): Promise<LinkedBankAccount> {
    const created = await call<{ public_token: string }>("/sandbox/public_token/create", { institution_id: "ins_109508", initial_products: ["transactions"] });
    const exchanged = await call<{ access_token: string }>("/item/public_token/exchange", { public_token: created.public_token });
    const accounts = await call<{ accounts: Array<{ mask: string | null }> }>("/accounts/get", { access_token: exchanged.access_token });
    return { itemRef: exchanged.access_token, institutionName: "Plaid Sandbox (First Platypus Bank)", accountMask: accounts.accounts[0]?.mask ?? "0000" };
  }

  async listTransactions(itemRef: string, since: string | null): Promise<BankFeedBatch> {
    const end = new Date().toISOString().slice(0, 10);
    const start = since ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const out: BankFeedTransaction[] = [];
    let balance: number | null = null;
    for (let offset = 0; offset < 5000; ) {
      const page = await call<{ transactions: Array<Record<string, any>>; accounts: Array<{ balances: { current: number | null } }>; total_transactions: number }>("/transactions/get", { access_token: itemRef, start_date: start, end_date: end, options: { count: 500, offset } });
      if (balance === null && page.accounts[0]?.balances.current != null) balance = Math.round(page.accounts[0].balances.current * 100);
      for (const t of page.transactions) {
        if (!t["amount"] || Number(t["amount"]) === 0) continue;
        out.push({
          plaidTxnId: String(t["transaction_id"]),
          pendingTxnId: (t["pending_transaction_id"] as string | null) ?? null,
          postedDate: String(t["date"]),
          amountCents: centsFromDollars(Number(t["amount"])),
          // Plaid reports money OUT as a positive amount.
          direction: Number(t["amount"]) > 0 ? "out" : "in",
          merchantName: (t["merchant_name"] as string | null) ?? null,
          rawCategory: (t["personal_finance_category"]?.primary as string | undefined) ?? (Array.isArray(t["category"]) ? (t["category"] as string[]).join(" > ") : null),
          description: (t["name"] as string | null) ?? null,
          pending: t["pending"] === true,
        });
      }
      offset += page.transactions.length;
      if (page.transactions.length === 0 || offset >= page.total_transactions) break;
    }
    return { transactions: out, removed: [], balanceCents: balance };
  }
}
