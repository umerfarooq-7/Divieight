import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { logAudit } from "@/lib/audit";
import { ActingMemberGate, actingAuditMeta } from "@/components/ActingMemberGate";
import { latestLiveness } from "@/lib/liveness";
import { verificationRequestCopy } from "@/constants/eligibilityCheckCopy";

// A Verification Request asks one thing at a time. A possible sanctions match asks only whether the
// member is the person the list names: a question of identity, not merit. No consumer report is
// obtained in the ordinary course, so nothing here asks about, or supplies, one.

export const Route = createFileRoute("/buyer/verification")({
  head: () => ({
    meta: [
      { title: "Additional verification needed — divieight" },
      {
        name: "description",
        content:
          "Upload clarifying documents so we can complete the review of your Buyer Account.",
      },
      { property: "og:title", content: "Additional verification needed — divieight" },
      {
        property: "og:description",
        content: "Upload clarifying documents to complete your Buyer Account review.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: VerificationRequestPage,
});

const REVIEW_BUSINESS_DAYS = 5;
const MAX_BYTES = 10 * 1024 * 1024;

interface DocEntry {
  path: string;
  name: string;
  uploaded_at: string;
}

function VerificationRequestPage() {
  return (
    <ActingMemberGate step="Verification">
      {({ member }) => <VerificationForMember key={member.id} actingMemberId={member.id} />}
    </ActingMemberGate>
  );
}

function VerificationForMember({ actingMemberId }: { actingMemberId: string }) {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);

  const [accountId, setAccountId] = useState<string | null>(null);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [docs, setDocs] = useState<DocEntry[]>([]);
  const [ready, setReady] = useState(false);
  const [uploading, setUploading] = useState(false);
  // A Verification Request opened by an inconclusive liveness check reads as such.
  const [livenessInconclusive, setLivenessInconclusive] = useState(false);
  // A possible sanctions match: the only question is whether this member is the person the list names.
  const [sanctionsMatch, setSanctionsMatch] = useState(false);

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
        if (!cancelled) navigate({ to: "/buyer/onboarding/identity", replace: true });
        return;
      }
      const { data: m } = await supabase
        .from("account_members")
        .select("id, verification_documents")
        .eq("buyer_account_id", b.id)
        .eq("id", actingMemberId)
        .eq("status", "active")
        .maybeSingle();
      const { data: checks } = m?.id
        ? await supabase.from("member_liveness_checks").select("account_member_id, status, created_at").eq("account_member_id", m.id)
        : { data: [] };
      if (cancelled) return;
      const { data: screens } = m?.id
        ? await supabase.from("member_sanctions_screenings").select("account_member_id, status, created_at").eq("account_member_id", m.id)
        : { data: [] };
      setSanctionsMatch(latestLiveness((screens ?? []) as Array<{ account_member_id: string; status: string; created_at: string }>, m?.id ?? "")?.status === "possible_match");
      setLivenessInconclusive(latestLiveness((checks ?? []) as Array<{ account_member_id: string; status: string; created_at: string }>, m?.id ?? "")?.status === "inconclusive");
      setAccountId(b.id);
      setMemberId(m?.id ?? null);
      setDocs(((m?.verification_documents as unknown as DocEntry[]) ?? []).slice());

      // Park the account in review so the buyer can log back out and return.
      await supabase
        .from("buyer_accounts")
        .update({ last_activity_at: new Date().toISOString(), stall_warning_sent_at: null, onboarding_status: "verification_pending" })
        .eq("id", b.id);
      if (m?.id) {
        await supabase
          .from("account_members")
          .update({ vetting_status: "verification_pending" })
          .eq("id", m.id);
      }
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, loading, navigate]);

  async function handleFiles(files: FileList | null) {
    if (!files?.length || !user || !memberId || !accountId) return;
    setUploading(true);
    const added: DocEntry[] = [];

    for (const file of Array.from(files)) {
      if (file.size > MAX_BYTES) {
        toast.error(`${file.name} is larger than 10MB.`);
        continue;
      }
      const path = `${user.id}/verification-${Date.now()}-${file.name.replace(/[^\w.-]/g, "_")}`;
      const { error } = await supabase.storage
        .from("verification-documents")
        .upload(path, file, { upsert: true, contentType: file.type });
      if (error) {
        toast.error(error.message);
        continue;
      }
      added.push({ path, name: file.name, uploaded_at: new Date().toISOString() });
    }

    if (added.length) {
      const next = [...docs, ...added];
      const { error } = await supabase
        .from("account_members")
        .update({
          verification_documents: next as never,
          vetting_status: "verification_pending",
        })
        .eq("id", memberId);
      if (error) {
        toast.error(error.message);
      } else {
        setDocs(next);
        await logAudit({
          actorId: user.id,
          actionType: "buyer.verification_documents_submitted",
          entityType: "buyer_account",
          entityId: accountId,
          metadata: { member_id: memberId, files: added.map((d) => d.name), ...actingAuditMeta(memberId) },
        });
        toast.success(`${added.length} document(s) submitted for review.`);
      }
    }

    setUploading(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  if (loading || !ready) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center text-sm text-muted-foreground">
        Loading your review status…
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:px-8">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
        Verification request
      </p>
      <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
        {livenessInconclusive ? "We couldn't complete your liveness check" : sanctionsMatch ? verificationRequestCopy.sanctionsHeading : verificationRequestCopy.generalHeading}
      </h1>
      {livenessInconclusive ? (
        <p className="mt-4 text-base leading-relaxed text-muted-foreground">
          The selfie check was inconclusive, so we couldn't confirm that the ID document is yours. This is not a decision on your
          account. You can{" "}
          <Link to="/buyer/onboarding/liveness" className="font-medium text-accent underline-offset-4 hover:underline">
            try another selfie
          </Link>
          , and you can upload a second government-issued ID below.
        </p>
      ) : null}
      {!livenessInconclusive ? (
        <p className="mt-4 text-base leading-relaxed text-muted-foreground">
          {sanctionsMatch ? verificationRequestCopy.sanctionsBody : verificationRequestCopy.generalBody}
        </p>
      ) : null}

      <div className="mt-8 rounded-xl border border-accent/50 bg-accent/10 p-5">
        <p className="font-display text-base font-semibold text-foreground">
          {verificationRequestCopy.reviewHeading}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          We'll notify you within {REVIEW_BUSINESS_DAYS} business days. You can sign back in
          at any time to check your status or add more documents.
        </p>
      </div>

      <section className="mt-8 rounded-xl border border-border bg-card p-6 shadow-sm">
        <h2 className="font-display text-lg font-semibold text-foreground">
          Upload clarifying documents
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          PDF, JPG, or PNG. Max 10MB per file. Files are stored privately and visible only to
          you and our compliance reviewers.
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,image/*"
          className="mt-4 block w-full text-sm text-muted-foreground file:mr-4 file:rounded-md file:border-0 file:bg-primary file:px-4 file:py-2 file:text-sm file:font-medium file:text-primary-foreground"
          onChange={(e) => handleFiles(e.target.files)}
          disabled={uploading}
        />
        {uploading ? (
          <p className="mt-3 text-sm text-muted-foreground">Uploading…</p>
        ) : null}

        <div className="mt-6">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Submitted documents
          </p>
          {docs.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">Nothing submitted yet.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {docs.map((d) => (
                <li
                  key={d.path}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-4 py-2 text-sm"
                >
                  <span className="truncate text-foreground">{d.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {new Date(d.uploaded_at).toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <div className="mt-8 flex flex-wrap gap-3">
        <Button asChild>
          <Link to="/buyer/dashboard">Go to dashboard</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/contact">Contact support</Link>
        </Button>
      </div>
    </div>
  );
}
