import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { logAudit } from "@/lib/audit";

// ⚠️ COMPLIANCE-SENSITIVE FLOW — FLAGGED FOR LEGAL REVIEW BEFORE PRODUCTION.
// This screen is the FCRA adverse-action notice. Before launch, counsel must
// confirm: (a) pre-adverse action notice was delivered with a copy of the
// consumer report and the CFPB "Summary of Your Rights" before this final
// notice, (b) the statutory waiting period elapsed, (c) the consumer reporting
// agency's name/address/toll-free number is disclosed, and (d) the notice is
// also delivered in writing/email, not only in-app. Placeholder text below.

export const Route = createFileRoute("/buyer/adverse-action")({
  head: () => ({
    meta: [
      { title: "Adverse action notice — divieight" },
      {
        name: "description",
        content:
          "Notice of adverse action taken on a Buyer Account based on a consumer report, and your rights under the FCRA.",
      },
      { property: "og:title", content: "Adverse action notice — divieight" },
      {
        property: "og:description",
        content: "Your FCRA adverse action notice and consumer rights summary.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdverseActionPage,
});

const AGENCY = {
  name: "[Consumer Reporting Agency Name]",
  address: "[Agency Address]",
  phone: "[Agency Toll-Free Number]",
};

function AdverseActionPage() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [ready, setReady] = useState(false);
  const [issuedAt, setIssuedAt] = useState<string | null>(null);
  const logged = useRef(false);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate({ to: "/buyer/login", replace: true });
      return;
    }
    let cancelled = false;
    (async () => {
      const { data: b } = await supabase
        .from("buyer_accounts")
        .select("id")
        .eq("auth_user_id", user.id)
        .maybeSingle();
      if (cancelled || !b) {
        if (!cancelled) navigate({ to: "/buyer/dashboard", replace: true });
        return;
      }
      const { data: m } = await supabase
        .from("account_members")
        .select("id, background_check_result, adverse_action_issued_at")
        .eq("buyer_account_id", b.id)
        .eq("status", "active")
        .eq("background_check_result", "failed")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;

      if (!m || m.background_check_result !== "failed") {
        navigate({ to: "/buyer/dashboard", replace: true });
        return;
      }

      const stamp = m.adverse_action_issued_at ?? new Date().toISOString();
      if (!m.adverse_action_issued_at) {
        await supabase
          .from("account_members")
          .update({ adverse_action_issued_at: stamp })
          .eq("id", m.id);
        await supabase
          .from("buyer_accounts")
          .update({ last_activity_at: new Date().toISOString(), stall_warning_sent_at: null, onboarding_status: "adverse_action" })
          .eq("id", b.id);
      }
      if (!logged.current) {
        logged.current = true;
        await logAudit({
          actorId: user.id,
          actionType: "buyer.fcra_adverse_action_issued",
          entityType: "buyer_account",
          entityId: b.id,
          metadata: {
            member_id: m.id,
            background_check_result: m.background_check_result,
            issued_at: stamp,
          },
        });
      }
      setIssuedAt(stamp);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, loading, navigate]);

  function downloadPlaceholderReport() {
    // TODO: replace with a signed URL to the consumer report PDF returned by
    // the screening provider once the real integration lands.
    const text = [
      "CONSUMER REPORT — PLACEHOLDER COPY",
      "",
      "This is a placeholder document. In production this download returns the",
      "consumer report obtained from the consumer reporting agency that was used",
      "in the eligibility decision for your divieight Buyer Account.",
      "",
      `Issued: ${issuedAt ?? new Date().toISOString()}`,
    ].join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "divieight-consumer-report-placeholder.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading || !ready) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center text-sm text-muted-foreground">
        Loading notice…
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:px-8">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-destructive">
        Adverse action notice
      </p>
      <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
        Notice of adverse action based on a consumer report
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Issued {issuedAt ? new Date(issuedAt).toLocaleString() : "—"}
      </p>

      <section className="mt-8 space-y-4 rounded-xl border border-destructive/40 bg-destructive/5 p-6 text-sm leading-relaxed text-muted-foreground">
        <p>
          divieight LLC has taken adverse action on your Buyer Account: your account cannot
          proceed to share reservations. This decision was based in whole or in part on
          information contained in a consumer report obtained about you.
        </p>
        <p>
          The consumer reporting agency that provided the report is{" "}
          <strong>{AGENCY.name}</strong>, {AGENCY.address}, {AGENCY.phone}. The agency did
          not make this decision and cannot explain why it was made.
        </p>
        <p>
          You have the right to obtain a free copy of your consumer report from that agency
          if you request it within 60 days of receiving this notice, and the right to dispute
          with the agency the accuracy or completeness of any information in the report.
        </p>
      </section>

      <section className="mt-6 rounded-xl border border-border bg-card p-6">
        <h2 className="font-display text-lg font-semibold text-foreground">
          Copy of your report
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          You may download the report used in this decision.
        </p>
        <Button className="mt-4" onClick={downloadPlaceholderReport}>
          Download report
        </Button>
      </section>

      <section className="mt-6 rounded-xl border border-border bg-card p-6">
        <h2 className="font-display text-lg font-semibold text-foreground">
          A summary of your rights under the Fair Credit Reporting Act
        </h2>
        <p className="mt-1 text-xs uppercase tracking-wide text-accent">
          Placeholder text — pending legal review
        </p>
        <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-foreground">
          <p>
            The federal Fair Credit Reporting Act (FCRA) promotes the accuracy, fairness, and
            privacy of information in the files of consumer reporting agencies.
          </p>
          <p>
            You must be told if information in your file has been used against you. You have
            the right to know what is in your file, and to ask for your credit score. You
            have the right to dispute incomplete or inaccurate information, and consumer
            reporting agencies must correct or delete inaccurate, incomplete, or unverifiable
            information. Outdated negative information may not be reported, and access to
            your file is limited to those with a valid need.
          </p>
          <p>
            You may seek damages from violators, and you may have additional rights under
            state law. For more information, contact the Consumer Financial Protection
            Bureau.
          </p>
        </div>
      </section>

      <div className="mt-8 flex flex-wrap gap-3">
        <Button asChild variant="outline">
          <Link to="/contact">Contact support</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/">Back to home</Link>
        </Button>
      </div>
    </div>
  );
}
