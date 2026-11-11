import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { listBuyerAttributionsForAdmin } from "@/lib/agent-qr.functions";
import { listReadTheStandardForAdmin } from "@/lib/eligibility-standard.functions";
import { listDeclarationsForAdmin } from "@/lib/eligibility-declaration.functions";
import { listLivenessForAdmin } from "@/lib/liveness.functions";
import { latestLiveness } from "@/lib/liveness";
import { LivenessTestSwitch } from "@/components/LivenessTestSwitch";
import { MarkDeclarationUntrue } from "@/components/MarkDeclarationUntrue";
import { IssueAdverseActionNotice } from "@/components/IssueAdverseActionNotice";
import { KyoPanel } from "@/components/KyoPanel";
import { listEligibilityForAdmin } from "@/lib/eligibility-engine.functions";
import { RESULT_LABELS, RESULT_TONES, type EligibilityResult } from "@/lib/eligibility-engine";

type Overall = "eligible" | "pending";
type Tab = "all" | "held" | "eligible" | "not_eligible" | "pending";
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "all", label: "All" },
  { key: "held", label: "Held" },
  { key: "pending", label: "Pending" },
  { key: "eligible", label: "Eligible" },
  { key: "not_eligible", label: "Not eligible" },
];
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

  const loadLiveness = useServerFn(listLivenessForAdmin);
  const { data: liveness } = useQuery({
    queryKey: ["admin-liveness", rows.map((r) => r.id).join(",")],
    enabled: rows.length > 0,
    retry: false,
    queryFn: () => loadLiveness({ data: { accountIds: rows.map((r) => r.id) } }),
  });
  const loadEligibility = useServerFn(listEligibilityForAdmin);
  const { data: eligibility, refetch: refetchEligibility } = useQuery({
    queryKey: ["admin-eligibility", rows.map((r) => r.id).join(",")],
    enabled: rows.length > 0,
    retry: false,
    queryFn: () => loadEligibility({ data: { accountIds: rows.map((r) => r.id) } }),
  });
  const [tab, setTab] = useState<Tab>("all");
  const resultOf = (memberId: string): EligibilityResult | null => eligibility?.[memberId]?.result ?? null;
  const activeOf = (accountId: string) => members.filter((m) => m.buyer_account_id === accountId && m.status !== "removed");
  // The account's overall status: eligible only when every member is; a held member leaves it pending.
  const overallOf = (accountId: string): Overall => {
    const list = activeOf(accountId);
    return list.length > 0 && list.every((m) => resultOf(m.id) === "eligible") ? "eligible" : "pending";
  };
  const inTab = (accountId: string) => {
    const results = activeOf(accountId).map((m) => resultOf(m.id));
    if (tab === "all") return true;
    if (tab === "held") return results.includes("held");
    if (tab === "not_eligible") return results.includes("not_eligible");
    if (tab === "eligible") return overallOf(accountId) === "eligible";
    return overallOf(accountId) === "pending" && !results.includes("held") && !results.includes("not_eligible");
  };
  const loadDeclarations = useServerFn(listDeclarationsForAdmin);
  const { data: declarations } = useQuery({
    queryKey: ["admin-eligibility-declarations", rows.map((r) => r.id).join(",")],
    enabled: rows.length > 0,
    retry: false,
    queryFn: () => loadDeclarations({ data: { accountIds: rows.map((r) => r.id) } }),
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

  const filtered = rows.filter(
    (r) =>
      inTab(r.id) &&
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

      <LivenessTestSwitch />

      {/* Eligibility tabs. Held has its own tab and colour, apart from every other status. */}
      <div role="tablist" aria-label="Eligibility" className="mt-6 flex flex-wrap items-center gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${tab === t.key ? (t.key === "all" ? "border-foreground bg-foreground text-background" : RESULT_TONES[t.key === "pending" ? "pending" : t.key]) : "border-border text-muted-foreground hover:text-foreground"}`}
          >
            {t.label}
          </button>
        ))}
        <Link to="/admin/eligibility/held" className="ml-auto text-xs font-medium text-primary hover:underline">
          Record a disposition →
        </Link>
        <Link to="/admin/eligibility/sanctions" className="text-xs font-medium text-primary hover:underline">
          Possible sanctions matches →
        </Link>
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
                          <span className={`mt-1 inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${RESULT_TONES[overallOf(r.id)]}`}>
                            Eligibility: {overallOf(r.id) === "eligible" ? "Eligible" : "Pending"}
                          </span>
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
                                    {resultOf(m.id) ? (
                                      <span className={`inline-flex rounded-full border px-2 py-0.5 font-medium ${RESULT_TONES[resultOf(m.id)!]}`} title={(eligibility?.[m.id]?.reason_codes ?? []).join(", ")}>
                                        {RESULT_LABELS[resultOf(m.id)!]}
                                      </span>
                                    ) : (
                                      <span className={`inline-flex rounded-full px-2 py-0.5 font-medium ${StatusToneClass(m.vetting_status)}`}>{m.vetting_status}</span>
                                    )}
                                    {/* "Read the Standard" is not the declaration: never shown as one. */}
                                    {(readStandard ?? []).filter((a) => a.account_member_id === m.id).map((a) => (
                                      <span key={a.standard_version + a.page_spec_version} className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                                        Read the Standard v{a.standard_version} · {when(a.acknowledged_at)}
                                      </span>
                                    ))}
                                    {(() => {
                                      const all = liveness ?? [];
                                      const last = latestLiveness(all, m.id);
                                      if (!last) return <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">Liveness: none</span>;
                                      const n = all.filter((x) => x.account_member_id === m.id).length;
                                      return (
                                        <span className={`rounded-full px-2 py-0.5 ${last.status === "failed" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}>
                                          Liveness: {last.status}{last.reason_code ? ` (${last.reason_code})` : ""}{n > 1 ? ` · ${n} attempts` : ""}
                                        </span>
                                      );
                                    })()}
                                    {(() => {
                                      const mineDecl = (declarations ?? []).filter((d) => d.account_member_id === m.id);
                                      const cur = mineDecl.find((d) => d.status === "complete" || d.status === "incomplete");
                                      const legacy = mineDecl.some((d) => d.status === "legacy");
                                      const noes = cur?.answers ? Object.entries(cur.answers as Record<string, string>).filter(([, v]) => v === "no").map(([k]) => k.toUpperCase()) : [];
                                      return (
                                        <>
                                          {cur ? (
                                            <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground" title={cur.declaration_hash}>
                                              Declaration v{cur.standard_version} · {cur.status} · {when(cur.declared_at)}
                                              {mineDecl.filter((d) => d.status === "superseded").length ? ` · ${mineDecl.filter((d) => d.status === "superseded").length} earlier` : ""}
                                              {noes.length ? ` · No: ${noes.join(", ")}` : ""}
                                            </span>
                                          ) : null}
                                          {legacy ? <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">legacy consent</span> : null}
                                        </>
                                      );
                                    })()}
                                    {m.status !== "removed" ? <MarkDeclarationUntrue memberId={m.id} onDone={() => void refetchEligibility()} /> : null}
                                    {m.status !== "removed" ? <IssueAdverseActionNotice memberId={m.id} onDone={() => void refetchEligibility()} /> : null}
                                    {m.status !== "removed" ? <AdminMemberActions member={{ id: m.id, role: m.role, email: m.email ?? null }} onChanged={() => window.location.reload()} /> : null}
                                  </li>
                                ))
                              )}
                            </ul>
                            <KyoPanel accountId={r.id} />
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
