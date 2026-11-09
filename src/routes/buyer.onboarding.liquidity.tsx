import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { BuyerOnboardingStepper } from "@/components/BuyerOnboardingStepper";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { logAudit } from "@/lib/audit";
import { budgetBucketLabel } from "@/lib/budget-buckets";
import {
  LIQUIDITY_MULTIPLIER,
  PLAID_SANDBOX,
  meetsLiquidityThreshold,
  sandboxBalanceFor,
} from "@/lib/liquidity";

export const Route = createFileRoute("/buyer/onboarding/liquidity")({
  head: () => ({
    meta: [
      { title: "Liquidity verification — divieight" },
      {
        name: "description",
        content:
          "Securely link your financial accounts to verify liquidity before your Golden Ticket is issued.",
      },
      { property: "og:title", content: "Liquidity verification — divieight" },
      {
        property: "og:description",
        content: "Link your accounts via Plaid or upload proof of funds to verify liquidity.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: LiquidityGatePage,
});

const MAX_BYTES = 10 * 1024 * 1024;

interface DocEntry {
  path: string;
  name: string;
  uploaded_at: string;
}

interface BuyerRow {
  id: string;
  target_budget: number | null;
  target_budget_bucket: string | null;
  plaid_consent_at: string | null;
  liquidity_verified: boolean;
  liquidity_status: string;
  liquidity_institution: string | null;
  liquidity_documents: unknown;
}


function LiquidityGatePage() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);

  const [buyer, setBuyer] = useState<BuyerRow | null>(null);
  const [ready, setReady] = useState(false);

  const [consent, setConsent] = useState(false);
  const [savingConsent, setSavingConsent] = useState(false);

  const [linkOpen, setLinkOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [linking, setLinking] = useState(false);
  // Binary only: whether a link attempt has produced a result this session.
  // Balances are never held in state, stored, or rendered.
  const [linkResolved, setLinkResolved] = useState(false);
  const [linkFailed, setLinkFailed] = useState(false);
  const [showFallback, setShowFallback] = useState(false);

  const [docs, setDocs] = useState<DocEntry[]>([]);
  const [uploading, setUploading] = useState(false);

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
        .select(
          "id, target_budget, target_budget_bucket, plaid_consent_at, liquidity_verified, liquidity_status, liquidity_institution, liquidity_documents, priority_rank_timestamp",
        )
        .eq("auth_user_id", user.id)
        .maybeSingle();
      if (cancelled) return;
      if (!b) {
        navigate({ to: "/buyer/onboarding/identity", replace: true });
        return;
      }
      // Gate: liquidity only unlocks after the enrollment payment cleared.
      if (!b.priority_rank_timestamp) {
        navigate({ to: "/buyer/onboarding/payment", replace: true });
        return;
      }
      setBuyer(b as unknown as BuyerRow);
      setConsent(!!b.plaid_consent_at);
      setDocs(((b.liquidity_documents as unknown as DocEntry[]) ?? []).slice());
      if (b.liquidity_status === "manual_review_pending") setShowFallback(true);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, loading, navigate]);

  // Internal Liquidity Gate basis only — never rendered as a figure.
  const budget = buyer?.target_budget ?? 0;
  const budgetLabel = buyer ? budgetBucketLabel(buyer.target_budget_bucket, buyer.target_budget) : "";
  

  async function saveConsent(next: boolean) {
    setConsent(next);
    if (!next || !buyer || !user || buyer.plaid_consent_at) return;
    setSavingConsent(true);
    const at = new Date().toISOString();
    const { error } = await supabase
      .from("buyer_accounts")
      .update({ plaid_consent_at: at })
      .eq("id", buyer.id);
    setSavingConsent(false);
    if (error) {
      toast.error(error.message);
      setConsent(false);
      return;
    }
    setBuyer({ ...buyer, plaid_consent_at: at });
    await logAudit({
      actorId: user.id,
      actionType: "buyer.plaid_consent_given",
      entityType: "buyer_account",
      entityId: buyer.id,
    });
  }

  // TODO: replace this simulated Link handshake with the real Plaid Link SDK
  // (link_token created server-side, public_token exchanged for an access_token,
  // then /accounts/balance/get). Production Plaid client_id/secret must live in
  // backend secrets — never in the client bundle.
  async function runPlaidLink() {
    if (!buyer || !user) return;
    setLinking(true);
    await new Promise((r) => setTimeout(r, 1800));

    const ok =
      username.trim() === PLAID_SANDBOX.username && password.trim() === PLAID_SANDBOX.password;
    if (!ok) {
      setLinking(false);
      setLinkFailed(true);
      setLinkOpen(false);
      setShowFallback(true);
      await supabase
        .from("buyer_accounts")
        .update({ liquidity_status: "link_failed" })
        .eq("id", buyer.id);
      await logAudit({
        actorId: user.id,
        actionType: "buyer.liquidity_link_failed",
        entityType: "buyer_account",
        entityId: buyer.id,
        metadata: { institution: PLAID_SANDBOX.institution },
      });
      toast.error("We couldn't connect that account.");
      return;
    }

    // Balances exist only inside this comparison and are discarded immediately.
    const passed = meetsLiquidityThreshold(sandboxBalanceFor(budget), budget);
    const now = new Date().toISOString();

    const { error } = await supabase
      .from("buyer_accounts")
      .update({
        liquidity_verified: passed,
        liquidity_verified_at: passed ? now : null,
        liquidity_status: passed ? "verified" : "insufficient",
        liquidity_institution: PLAID_SANDBOX.institution,
        last_activity_at: new Date().toISOString(),
        stall_warning_sent_at: null,
        onboarding_status: passed ? "golden_ticket_pending" : "liquidity_pending",
      })
      .eq("id", buyer.id);

    setLinking(false);
    setLinkOpen(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setLinkResolved(true);
    setBuyer({
      ...buyer,
      liquidity_verified: passed,
      liquidity_status: passed ? "verified" : "insufficient",
      liquidity_institution: PLAID_SANDBOX.institution,
    });
    if (!passed) setShowFallback(true);
    await logAudit({
      actorId: user.id,
      actionType: passed ? "buyer.liquidity_verified" : "buyer.liquidity_insufficient",
      entityType: "buyer_account",
      entityId: buyer.id,
      // Binary outcome only — no balance, threshold, or margin figure is logged.
      metadata: {
        institution: PLAID_SANDBOX.institution,
        result: passed ? "verified" : "insufficient",
        simulated: true,
      },
    });
    toast[passed ? "success" : "error"](
      passed ? "Liquidity verified." : "Connected accounts don't meet the liquidity threshold.",
    );
  }

  async function handleFiles(files: FileList | null) {
    if (!files?.length || !user || !buyer) return;
    setUploading(true);
    const added: DocEntry[] = [];
    for (const file of Array.from(files)) {
      if (file.size > MAX_BYTES) {
        toast.error(`${file.name} is larger than 10MB.`);
        continue;
      }
      const path = `${user.id}/liquidity-${Date.now()}-${file.name.replace(/[^\w.-]/g, "_")}`;
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
      // NOTE: manual proof-of-funds requires Broker of Record review. The broker
      // review UI ships with the Month 3 Agent/Broker Module — for now the
      // submission simply parks the account in manual_review_pending.
      const { error } = await supabase
        .from("buyer_accounts")
        .update({
          liquidity_documents: next as never,
          liquidity_status: "manual_review_pending",
          last_activity_at: new Date().toISOString(),
          stall_warning_sent_at: null,
          onboarding_status: "liquidity_pending",
        })
        .eq("id", buyer.id);
      if (error) {
        toast.error(error.message);
      } else {
        setDocs(next);
        setBuyer({ ...buyer, liquidity_status: "manual_review_pending" });
        await logAudit({
          actorId: user.id,
          actionType: "buyer.liquidity_documents_submitted",
          entityType: "buyer_account",
          entityId: buyer.id,
          metadata: { files: added.map((d) => d.name) },
        });
        toast.success("Submitted for Broker of Record review.");
      }
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  if (loading || !ready || !buyer) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-16 text-center text-sm text-muted-foreground sm:px-6 lg:px-8">
        Loading your liquidity status…
      </div>
    );
  }

  const verified = buyer.liquidity_verified;
  const manualPending = buyer.liquidity_status === "manual_review_pending";

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
      <BuyerOnboardingStepper current={5} />

      <div className="mt-10">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
          Step 6 · Liquidity
        </p>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          Liquidity verification
        </h1>
        <p className="mt-3 text-base text-muted-foreground">
          Before your Golden Ticket is issued we confirm you hold at least{" "}
          {LIQUIDITY_MULTIPLIER}× your target budget
          {budgetLabel ? ` range (${budgetLabel})` : ""}. The check runs internally — we never
          display a calculated figure.
        </p>
      </div>

      {/* Block 1 — Plaid consent */}
      <section className="mt-8 rounded-xl border border-border bg-card p-6 shadow-sm">
        <h2 className="font-display text-lg font-semibold text-foreground">
          Financial account linking consent
        </h2>
        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-background p-4">
          <Checkbox
            checked={consent}
            onCheckedChange={(v) => saveConsent(v === true)}
            disabled={savingConsent || verified || !!buyer.plaid_consent_at}
            className="mt-0.5"
          />
          <span className="text-sm text-foreground">
            I authorize divieight to securely link my financial accounts via Plaid to verify my
            liquidity. divieight uses secure, tokenized access and does not store my bank login
            credentials.
          </span>
        </label>
        {buyer.plaid_consent_at ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Consent recorded {new Date(buyer.plaid_consent_at).toLocaleString()}.
          </p>
        ) : null}
      </section>

      {/* Plaid Link */}
      {!verified ? (
        <section className="mt-6 rounded-xl border border-border bg-card p-6 shadow-sm">
          <h2 className="font-display text-lg font-semibold text-foreground">
            Connect your bank
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Sandbox mode — use institution <strong>{PLAID_SANDBOX.institution}</strong> with{" "}
            <code className="rounded bg-muted px-1">{PLAID_SANDBOX.username}</code> /{" "}
            <code className="rounded bg-muted px-1">{PLAID_SANDBOX.password}</code>.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Button onClick={() => setLinkOpen(true)} disabled={!consent}>
              Link account with Plaid
            </Button>
            <Button variant="outline" onClick={() => setShowFallback(true)}>
              Bank not found?
            </Button>
          </div>
          {linkFailed ? (
            <p className="mt-3 text-sm text-destructive">
              Link attempt failed. Use the manual upload below instead.
            </p>
          ) : null}
        </section>
      ) : null}

      {linkResolved || verified ? (
        <div
          className={
            verified
              ? "mt-6 rounded-xl border border-primary/40 bg-primary/5 p-5"
              : "mt-6 rounded-xl border border-destructive/40 bg-destructive/5 p-5"
          }
        >
          <p className="font-display text-base font-semibold text-foreground">
            {verified ? "Liquidity verified" : "Insufficient verified liquidity"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {verified
              ? `Verified via ${buyer.liquidity_institution ?? "your linked institution"}. We record only that the requirement was met — never an amount.`
              : `The accounts you linked at ${buyer.liquidity_institution ?? "your institution"} did not meet the requirement. No amount is recorded.`}
          </p>
        </div>
      ) : null}

      {/* Fallback — manual proof of funds */}
      {showFallback && !verified ? (
        <section className="mt-6 rounded-xl border border-border bg-card p-6 shadow-sm">
          <h2 className="font-display text-lg font-semibold text-foreground">
            Upload your last 3 months of bank statements or a Proof of Funds letter
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            PDF, JPG, or PNG. Max 10MB per file. Stored privately. Manual submissions are
            reviewed by our Broker of Record before your Golden Ticket is issued.
          </p>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".pdf,image/*"
            className="mt-4 block w-full text-sm text-muted-foreground file:mr-4 file:rounded-md file:border-0 file:bg-primary file:px-4 file:py-2 file:text-sm file:font-medium file:text-primary-foreground"
            onChange={(e) => handleFiles(e.target.files)}
            disabled={uploading}
          />
          {uploading ? <p className="mt-3 text-sm text-muted-foreground">Uploading…</p> : null}
          {docs.length > 0 ? (
            <ul className="mt-5 space-y-2">
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
          ) : null}
        </section>
      ) : null}

      {/* Gate status */}
      <section className="mt-6 rounded-xl border border-border bg-muted/30 p-5">
        {verified ? (
          <>
            <p className="text-sm text-foreground">
              You're cleared for Golden Ticket issuance.
            </p>
            <Button asChild className="mt-4">
              <Link to="/buyer/golden-ticket">Claim my Golden Ticket</Link>
            </Button>
          </>
        ) : manualPending ? (
          <>
            <p className="font-display text-base font-semibold text-foreground">
              Verification pending
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Your documents are queued for Broker of Record review. Golden Ticket issuance is
              on hold until liquidity is confirmed. You can sign back in any time to add more
              documents.
            </p>
            <Button asChild variant="outline" className="mt-4">
              <Link to="/buyer/dashboard">Go to dashboard</Link>
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Golden Ticket issuance is blocked until liquidity is either auto-verified through
            Plaid or submitted for manual review.
          </p>
        )}
      </section>

      <Dialog open={linkOpen} onOpenChange={(o) => (linking ? null : setLinkOpen(o))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{PLAID_SANDBOX.institution}</DialogTitle>
            <DialogDescription>
              Plaid sandbox sign-in. Credentials are tokenized and never stored by divieight.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="plaid-user">Username</Label>
              <Input
                id="plaid-user"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={PLAID_SANDBOX.username}
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="plaid-pass">Password</Label>
              <Input
                id="plaid-pass"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={PLAID_SANDBOX.password}
                autoComplete="off"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLinkOpen(false)} disabled={linking}>
              Cancel
            </Button>
            <Button onClick={runPlaidLink} disabled={linking}>
              {linking ? "Connecting…" : "Connect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
