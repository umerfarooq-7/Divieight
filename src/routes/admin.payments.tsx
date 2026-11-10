import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { StatusToneClass, currency, when } from "@/lib/admin";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listHeldMembers } from "@/lib/eligibility-engine.functions";
import { RESULT_LABELS, RESULT_TONES, moneyStatusFor } from "@/lib/eligibility-engine";

export const Route = createFileRoute("/admin/payments")({
  component: AdminPayments,
});

type PayRow = {
  id: string;
  who: string;
  side: "Seller" | "Buyer";
  amount_cents: number;
  currency: string;
  status: string;
  environment: string;
  stripe_session_id: string | null;
  created_at: string;
};

function AdminPayments() {
  const [rows, setRows] = useState<PayRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [side, setSide] = useState("all");
  // Held accounts (by their buyer login) get their own Held label here, whatever the payment says.
  const loadHeld = useServerFn(listHeldMembers);
  const { data: held } = useQuery({ queryKey: ["admin-held"], retry: false, queryFn: () => loadHeld() });
  const [heldLogins, setHeldLogins] = useState<Set<string>>(new Set());
  useEffect(() => {
    const ids = [...new Set((held ?? []).map((h) => h.accountId))];
    if (!ids.length) return setHeldLogins(new Set());
    void supabase.from("buyer_accounts").select("id, auth_user_id").in("id", ids).then(({ data }) => setHeldLogins(new Set(((data ?? []) as Array<{ auth_user_id: string }>).map((a) => a.auth_user_id))));
  }, [held]);

  useEffect(() => {
    (async () => {
      const [s, b] = await Promise.all([
        supabase
          .from("enrollment_payments")
          .select("id,seller_id,amount_cents,currency,status,environment,stripe_session_id,created_at")
          .order("created_at", { ascending: false }),
        supabase
          .from("buyer_enrollment_payments")
          .select("id,auth_user_id,amount_cents,currency,status,environment,stripe_session_id,created_at")
          .order("created_at", { ascending: false }),
      ]);

      const sellerRows: PayRow[] = ((s.data as Record<string, never>[] | null) ?? []).map((r) => ({
        id: r.id as unknown as string,
        who: r.seller_id as unknown as string,
        side: "Seller",
        amount_cents: r.amount_cents as unknown as number,
        currency: r.currency as unknown as string,
        status: r.status as unknown as string,
        environment: r.environment as unknown as string,
        stripe_session_id: (r.stripe_session_id as unknown as string) ?? null,
        created_at: r.created_at as unknown as string,
      }));
      const buyerRows: PayRow[] = ((b.data as Record<string, never>[] | null) ?? []).map((r) => ({
        id: r.id as unknown as string,
        who: r.auth_user_id as unknown as string,
        side: "Buyer",
        amount_cents: r.amount_cents as unknown as number,
        currency: r.currency as unknown as string,
        status: r.status as unknown as string,
        environment: r.environment as unknown as string,
        stripe_session_id: (r.stripe_session_id as unknown as string) ?? null,
        created_at: r.created_at as unknown as string,
      }));

      setRows(
        [...sellerRows, ...buyerRows].sort((a, z) => z.created_at.localeCompare(a.created_at)),
      );
      setLoading(false);
    })();
  }, []);

  const filtered = rows.filter((r) => side === "all" || r.side === side);
  const paid = filtered
    .filter((r) => r.status === "paid")
    .reduce((t, r) => t + r.amount_cents, 0);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">
            Payments
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Platform enrollment fees from both sides of the marketplace.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-accent/10 px-3 py-1.5 text-sm font-medium text-accent">
            {currency(paid)} collected
          </span>
          <select
            value={side}
            onChange={(e) => setSide(e.target.value)}
            className="h-10 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="all">All</option>
            <option value="Seller">Sellers</option>
            <option value="Buyer">Buyers</option>
          </select>
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Date</th>
                <th className="px-4 py-3 text-left font-medium">Side</th>
                <th className="px-4 py-3 text-left font-medium">Account</th>
                <th className="px-4 py-3 text-left font-medium">Amount</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-left font-medium">Environment</th>
                <th className="px-4 py-3 text-left font-medium">Session</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    No payments recorded.
                  </td>
                </tr>
              ) : (
                filtered.map((r) => (
                  <tr key={`${r.side}-${r.id}`} className="hover:bg-muted/30">
                    <td className="px-4 py-3 text-xs text-muted-foreground">{when(r.created_at)}</td>
                    <td className="px-4 py-3 text-xs font-medium text-foreground">{r.side}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {r.who.slice(0, 8)}…
                    </td>
                    <td className="px-4 py-3 text-xs font-medium text-foreground">
                      {currency(r.amount_cents)} {r.currency.toUpperCase()}
                    </td>
                    <td className="px-4 py-3">
                      {(() => {
                        const shown = moneyStatusFor(r.status, r.side === "Buyer" && heldLogins.has(r.who));
                        return (
                          <span className="inline-flex flex-wrap gap-1">
                            {shown.label === "held" ? null : (
                              <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${StatusToneClass(shown.label)}`}>{shown.label}</span>
                            )}
                            {shown.held ? <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${RESULT_TONES.held}`}>{RESULT_LABELS.held}</span> : null}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{r.environment}</td>
                    <td className="px-4 py-3 font-mono text-[11px] text-muted-foreground">
                      {r.stripe_session_id ? `${r.stripe_session_id.slice(0, 14)}…` : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
