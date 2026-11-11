import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { ActingMemberGate } from "@/components/ActingMemberGate";
import { ADVERSE_ACTION_TITLE } from "@/lib/adverse-action";
import { getMyAdverseActionNotices } from "@/lib/adverse-action.functions";
import { RESULT_LABELS, RESULT_TONES } from "@/lib/eligibility-engine";

// No consumer report is obtained in the ordinary course. This page shows one of two things:
//  - an adverse-action notice, only when an admin has issued one (the Question 5 authorization was
//    exercised and divieight then acted on information in the report). The notice names the action
//    and the consumer reporting agency and states the member's rights. The report is NOT supplied.
//  - otherwise, the plain "not eligible" result under the Participant Eligibility Standard.
// Counsel should review the notice template (src/lib/adverse-action.ts) before it is ever used.

export const Route = createFileRoute("/buyer/adverse-action")({
  head: () => ({
    meta: [
      { title: "Your eligibility result — divieight" },
      { name: "description", content: "Your Eligibility Check result, and any notice of adverse action issued to you." },
      { property: "og:title", content: "Your eligibility result — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdverseActionPage,
});

/** The notice is the affected member's own: shown to them, through the picker. */
function AdverseActionPage() {
  return (
    <ActingMemberGate step="Your result">
      {({ member, switchPerson }) => <AdverseActionForMember key={member.id} actingMemberId={member.id} onSwitch={switchPerson} />}
    </ActingMemberGate>
  );
}

/** A member is affected when the engine found them not eligible (or their earlier simulated check failed). */
export const isAdverselyAffected = (m: { background_check_result: string | null; vetting_status: string | null }) =>
  m.background_check_result === "failed" || m.vetting_status === "not_eligible";

interface Notice {
  id: string;
  rendered_text: string;
  document_hash: string;
  issued_at: string;
}

function AdverseActionForMember({ actingMemberId, onSwitch }: { actingMemberId: string; onSwitch: () => void }) {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const loadNotices = useServerFn(getMyAdverseActionNotices);
  const [ready, setReady] = useState(false);
  const [notForMe, setNotForMe] = useState<string | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate({ to: "/buyer/login", replace: true });
      return;
    }
    let cancelled = false;
    (async () => {
      const { data: b } = await supabase.from("buyer_accounts").select("id").eq("auth_user_id", user.id).maybeSingle();
      if (cancelled || !b) {
        if (!cancelled) navigate({ to: "/buyer/dashboard", replace: true });
        return;
      }
      const { data: all } = await supabase
        .from("account_members")
        .select("id, full_name, background_check_result, vetting_status")
        .eq("buyer_account_id", b.id)
        .eq("status", "active");
      if (cancelled) return;
      const everyone = (all ?? []) as Array<{ id: string; full_name: string; background_check_result: string | null; vetting_status: string | null }>;
      const affected = everyone.filter(isAdverselyAffected);
      const me = everyone.find((x) => x.id === actingMemberId) ?? null;
      const mine = await loadNotices({ data: { actingMemberId } }).catch(() => [] as Notice[]);
      if (cancelled) return;
      if (affected.length === 0 && mine.length === 0) {
        navigate({ to: "/buyer/dashboard", replace: true });
        return;
      }
      if (mine.length === 0 && (!me || !isAdverselyAffected(me))) {
        // The result belongs to the affected member; nobody else sees it.
        setNotForMe(affected.map((a) => a.full_name || "the other member").join(" and "));
        setReady(true);
        return;
      }
      setNotices(mine as Notice[]);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, loading, navigate, actingMemberId, loadNotices]);

  if (loading || !ready) {
    return <div className="mx-auto max-w-3xl px-4 py-16 text-center text-sm text-muted-foreground">Loading…</div>;
  }

  if (notForMe) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center sm:px-6">
        <h1 className="font-display text-2xl font-semibold text-foreground">This is for {notForMe}</h1>
        <p className="mt-2 text-sm text-muted-foreground">A result and any notice are addressed to the member they concern. Switch to that member to read it.</p>
        <div className="mt-6 flex justify-center gap-3">
          <Button onClick={onSwitch}>Switch person</Button>
          <Button asChild variant="outline">
            <Link to="/buyer/dashboard">Back to dashboard</Link>
          </Button>
        </div>
      </div>
    );
  }

  const latest = notices[0] ?? null;
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:px-8">
      {latest ? (
        <>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">{ADVERSE_ACTION_TITLE}</p>
          <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">{ADVERSE_ACTION_TITLE}</h1>
          <p className="mt-2 text-sm text-muted-foreground">Issued {new Date(latest.issued_at).toLocaleString()}</p>
          <section className="mt-8 rounded-xl border border-border bg-card p-6">
            <p className="whitespace-pre-line text-sm leading-relaxed text-foreground">{latest.rendered_text}</p>
            <p className="mt-4 break-all font-mono text-[11px] text-muted-foreground">{latest.document_hash}</p>
          </section>
        </>
      ) : (
        <>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">The Eligibility Check</p>
          <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">Your eligibility result</h1>
          <section className={`mt-8 rounded-xl border p-6 ${RESULT_TONES.not_eligible}`}>
            <p className="font-display text-xl font-semibold">{RESULT_LABELS.not_eligible}</p>
            <div className="mt-3 space-y-3 text-sm leading-relaxed">
              <p>Under the Participant Eligibility Standard, your answers don't qualify you to take part. The same answers always receive the same result, and no person at divieight weighed them.</p>
              <p>divieight did not obtain a consumer report about you and did not conduct a criminal history search.</p>
              <p>If you think you answered a question wrongly, you can correct it and resubmit it. That is a correction of fact, not an appeal.</p>
            </div>
          </section>
          <Button asChild className="mt-6">
            <Link to="/buyer/onboarding/vetting">Correct an answer</Link>
          </Button>
        </>
      )}

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
