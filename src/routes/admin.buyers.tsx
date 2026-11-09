import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { listBuyerAttributionsForAdmin } from "@/lib/agent-qr.functions";
import { listReadTheStandardForAdmin } from "@/lib/eligibility-standard.functions";
import { StatusToneClass, when } from "@/lib/admin";
import { budgetBucketLabel } from "@/lib/budget-buckets";
import { AdminMemberActions } from "@/components/AdminMemberActions";

export const Route = createFileRoute("/admin/buyers")({
  component: AdminBuyers,
});

type BuyerRow = {
  id: string;
  auth_user_id: string;
  email: string;
  phone: string | null;
  onboarding_status: string;
  intent: string | null;
  target_budget: number | null;
  target_budget_bucket: string | null;
  priority_rank_timestamp: string | null;
  golden_ticket_issued: boolean;
  liquidity_status: string;
  liquidity_verified: boolean;
  last_activity_at: string;
  created_at: string;
};

type MemberRow = {
  id: string;
  buyer_account_id: string;
  full_name: string;
  role: string;
  vetting_status: string;
  status?: string;
  email?: string | null;
};

function AdminBuyers() {
  const [rows, setRows] = useState<BuyerRow[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const loadAttributions = useServerFn(listBuyerAttributionsForAdmin);
  const { data: attributions } = useQuery({ queryKey: ["admin-buyer-attributions"], retry: false, queryFn: () => loadAttributions() });
  const loadReadStandard = useServerFn(listReadTheStandardForAdmin);
  const { data: readStandard } = useQuery({
    queryKey: ["admin-read-the-standard", rows.map((r) => r.id).join(",")],
    enabled: rows.length > 0,
    retry: false,
    queryFn: () => loadReadStandard({ data: { accountIds: rows.map((r) => r.id) } }),
  });

  useEffect(() => {
    (async () => {
      const [b, m] = await Promise.all([
        supabase
          .from("buyer_accounts")
          .select(
            "id,auth_user_id,email,phone,onboarding_status,intent,target_budget,target_budget_bucket,priority_rank_timestamp,golden_ticket_issued,liquidity_status,liquidity_verified,last_activity_at,created_at",
          )
          .order("created_at", { ascending: false }),
        supabase
          .from("account_members")
          .select("id,buyer_account_id,full_name,role,vetting_status,status,email"),
      ]);
      if (b.error) console.error(b.error);
      setRows((b.data as BuyerRow[] | null) ?? []);
      setMembers((m.data as MemberRow[] | null) ?? []);
      setLoading(false);
    })();
  }, []);

  const filtered = rows.filter((r) =>
    `${r.email} ${r.phone ?? ""} ${r.intent ?? ""}`
      .toLowerCase()
      .includes(q.trim().toLowerCase()),
  );

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">
            Buyers
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Vetting, liquidity, priority rank and Golden Ticket status for every buyer account.
          </p>
        </div>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search email, phone, intent…"
          className="h-10 w-72 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Buyer</th>
                <th className="px-4 py-3 text-left font-medium">Onboarding</th>
                <th className="px-4 py-3 text-left font-medium">Budget</th>
                <th className="px-4 py-3 text-left font-medium">Liquidity</th>
                <th className="px-4 py-3 text-left font-medium">Golden Ticket</th>
                <th className="px-4 py-3 text-left font-medium">Priority</th>
                <th className="px-4 py-3 text-left font-medium">Last activity</th>
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
                    No buyer accounts found.
                  </td>
                </tr>
              ) : (
                filtered.map((r) => {
                  const mine = members.filter((m) => m.buyer_account_id === r.id);
                  const attribution = attributions?.[r.auth_user_id];
                  return (
                    <Fragment key={r.id}>
                      <tr
                        key={r.id}
                        onClick={() => setOpen(open === r.id ? null : r.id)}
                        className="cursor-pointer hover:bg-muted/30"
                      >
                        <td className="px-4 py-3">
                          <div className="font-medium text-foreground">{r.email}</div>
                          <div className="text-xs text-muted-foreground">
                            {r.phone || "—"} · {r.intent ?? "no intent"}
                          </div>
                          {attribution ? <div className="text-xs font-medium text-accent">Attributed to {attribution.agentName}</div> : null}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${StatusToneClass(r.onboarding_status)}`}
                          >
                            {r.onboarding_status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-foreground">
                          {budgetBucketLabel(r.target_budget_bucket, r.target_budget)}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${StatusToneClass(r.liquidity_status)}`}
                          >
                            {r.liquidity_verified ? "verified" : r.liquidity_status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs">
                          {r.golden_ticket_issued ? (
                            <span className="inline-flex rounded-full bg-accent/10 px-2 py-0.5 font-medium text-accent">
                              Issued
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {when(r.priority_rank_timestamp)}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {when(r.last_activity_at)}
                        </td>
                      </tr>
                      {open === r.id && (
                        <tr key={`${r.id}-members`} className="bg-muted/20">
                          <td colSpan={7} className="px-4 py-3">
                            {attribution ? (
                              <p className="mb-2 text-xs text-foreground">
                                Attributed to {attribution.agentName}
                                {attribution.agentEmail ? ` (${attribution.agentEmail})` : ""} via a QR code or link, {when(attribution.stampedAt)}. A suggestion only: it doesn't tether the buyer or set a referring agent.
                              </p>
                            ) : null}
                            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                              Account members
                            </p>
                            <ul className="mt-2 space-y-1 text-xs">
                              {mine.length === 0 ? (
                                <li className="text-muted-foreground">No members recorded.</li>
                              ) : (
                                mine.map((m) => (
                                  <li key={m.id} className="flex items-center gap-2">
                                    <span className="font-medium text-foreground">
                                      {m.full_name || "Unnamed"}
                                    </span>
                                    <span className="text-muted-foreground">({m.role}{m.email ? ` · ${m.email}` : ""})</span>
                                    {m.status === "removed" ? <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">removed</span> : null}
                                    <span
                                      className={`inline-flex rounded-full px-2 py-0.5 font-medium ${StatusToneClass(m.vetting_status)}`}
                                    >
                                      {m.vetting_status}
                                    </span>
                                    {/* "Read the Standard" is not the declaration: never shown as one. */}
                                    {(readStandard ?? []).filter((a) => a.account_member_id === m.id).map((a) => (
                                      <span key={a.standard_version + a.page_spec_version} className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                                        Read the Standard v{a.standard_version} · {when(a.acknowledged_at)}
                                      </span>
                                    ))}
                                    {m.status !== "removed" ? <AdminMemberActions member={{ id: m.id, role: m.role, email: m.email ?? null }} onChanged={() => window.location.reload()} /> : null}
                                  </li>
                                ))
                              )}
                            </ul>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Click a row to expand per-member vetting status.
      </p>
    </div>
  );
}
