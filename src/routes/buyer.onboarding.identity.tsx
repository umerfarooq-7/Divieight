import { useEffect, useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { BuyerOnboardingStepper } from "@/components/BuyerOnboardingStepper";
import { Field } from "@/components/Field";
import { BUDGET_BUCKETS, bucketById, bucketForAmount, liquidityBasisFor } from "@/lib/budget-buckets";
import { cn } from "@/lib/utils";
import { logAudit } from "@/lib/audit";
import { useServerFn } from "@tanstack/react-start";
import { ActingMemberGate, actingAuditMeta } from "@/components/ActingMemberGate";
import { saveMemberIdentityFn } from "@/lib/account-members.functions";

export const Route = createFileRoute("/buyer/onboarding/identity")({
  head: () => ({
    meta: [
      { title: "Buyer identity & intent — divieight" },
      {
        name: "description",
        content:
          "Verify your identity, choose your ownership intent, and confirm your budget to begin buyer vetting.",
      },
      { property: "og:title", content: "Buyer identity & intent — divieight" },
      {
        property: "og:description",
        content:
          "Verify your identity, choose your ownership intent, and confirm your budget to begin buyer vetting.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: BuyerIdentityScreen,
});

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

type ExtractedFields = {
  full_name: string;
  address: string;
  date_of_birth: string;
};

// TODO(Persona): Replace this simulated OCR with a real Persona API call.
// Upload the file to Persona (or equivalent), then map the returned inquiry
// fields to { full_name, address, date_of_birth }. Until then, we return
// deterministic placeholder data so the buyer can review/correct fields.
async function simulateOcrExtraction(_file: File): Promise<ExtractedFields> {
  await new Promise((r) => setTimeout(r, 1200));
  return {
    full_name: "Jane A. Sample",
    address: "123 Market Street, Apt 4B, San Francisco, CA 94103",
    date_of_birth: "1988-06-14",
  };
}

const INTENTS = [
  {
    value: "long_term",
    title: "Personal Use (long-term ownership)",
    subtitle: "Personal use",
    body: "You plan to use the home yourself and hold your shares long term.",
  },
  {
    value: "short_term_rental",
    title: "Short-Term Rental",
    subtitle: "Income-focused",
    body: "You plan to place your usage weeks into short-term rental for income.",
  },
] as const;

function BuyerIdentityScreen() {
  return (
    <ActingMemberGate step="Step 2 · Identity">
      {({ member }) => <IdentityForMember key={member.id} actingMemberId={member.id} isPrimary={member.role === "primary"} />}
    </ActingMemberGate>
  );
}

function IdentityForMember({ actingMemberId, isPrimary }: { actingMemberId: string; isPrimary: boolean }) {
  const navigate = useNavigate();
  const saveIdentity = useServerFn(saveMemberIdentityFn);
  const [idNumber, setIdNumber] = useState("");
  const { user, loading } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [accountId, setAccountId] = useState<string | null>(null);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [bootstrapping, setBootstrapping] = useState(true);

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  // Risk Flag (from spec): manual entry fallback is REQUIRED in case OCR/upload fails.
  const [manualMode, setManualMode] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [fields, setFields] = useState<ExtractedFields>({
    full_name: "",
    address: "",
    date_of_birth: "",
  });
  const [intent, setIntent] = useState<string>("");
  /** Bucket id — the budget is never captured as a free-typed amount. */
  const [budgetBucket, setBudgetBucket] = useState("");
  const [reserveConfirmed, setReserveConfirmed] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate({ to: "/buyer/login" });
      return;
    }
    let cancelled = false;
    (async () => {
      const { data: account } = await supabase
        .from("buyer_accounts")
        .select("id, intent, target_budget, target_budget_bucket")
        .eq("auth_user_id", user.id)
        .maybeSingle();
      if (cancelled) return;
      if (!account) {
        navigate({ to: "/buyer/register" });
        return;
      }
      setAccountId(account.id);
      if (account.intent) setIntent(account.intent);
      // Legacy rows hold an exact amount — show it as its nearest bucket.
      const row = account as unknown as { target_budget: number | null; target_budget_bucket: string | null };
      const existing = bucketById(row.target_budget_bucket) ?? bucketForAmount(row.target_budget);
      if (existing) setBudgetBucket(existing.id);

      const { data: member } = await supabase
        .from("account_members")
        .select("id, full_name, address, date_of_birth, id_document_number")
        .eq("buyer_account_id", account.id)
        .eq("id", actingMemberId)
        .eq("status", "active")
        .maybeSingle();
      if (cancelled) return;
      if (member) {
        setMemberId(member.id);
        setIdNumber((member as { id_document_number?: string | null }).id_document_number ?? "");
        if (member.full_name || member.address || member.date_of_birth) {
          setFields({
            full_name: member.full_name ?? "",
            address: member.address ?? "",
            date_of_birth: member.date_of_birth ?? "",
          });
        }
      }
      setBootstrapping(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, loading, navigate, actingMemberId]);

  async function handleFile(f: File) {
    if (!f.type.startsWith("image/")) {
      toast.error("Please upload an image file.");
      return;
    }
    if (f.size > MAX_FILE_SIZE) {
      toast.error("File must be 10MB or smaller.");
      return;
    }
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
    setScanning(true);
    setScanned(false);
    try {
      const extracted = await simulateOcrExtraction(f);
      setFields(extracted);
      setScanned(true);
      toast.success("Details extracted. Please review and correct as needed.");
    } catch {
      toast.error("Couldn't scan the document. Try again or enter details manually.");
    } finally {
      setScanning(false);
    }
  }

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!fields.full_name.trim()) next.full_name = "Full name is required.";
    if (!fields.address.trim()) next.address = "Address is required.";
    if (!fields.date_of_birth.trim()) next.date_of_birth = "Date of birth is required.";
    if (!idNumber.trim()) next.id_number = "ID document number is required.";
    if (isPrimary) {
      if (!intent) next.intent = "Select how you plan to use your shares.";
      if (!bucketById(budgetBucket)) next.budget = "Select your target budget range.";
      if (!reserveConfirmed) next.reserve = "Please confirm your 20% reserve.";
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit() {
    if (!user || !accountId) return;
    if (!validate()) return;

    setSubmitting(true);
    let idDocumentUrl: string | null = null;

    if (file) {
      const ext = file.name.split(".").pop() ?? "jpg";
      const path = `${user.id}/buyer-license-${Date.now()}.${ext}`;
      const { error: uploadErr } = await supabase.storage
        .from("identity-documents")
        .upload(path, file, { upsert: true, contentType: file.type });
      if (uploadErr) {
        setSubmitting(false);
        toast.error(uploadErr.message);
        return;
      }
      idDocumentUrl = path;
    }

    // The member's own record, through the server: it must be an active member of this account.
    let pending: string[];
    try {
      ({ pending } = await saveIdentity({
        data: {
          actingMemberId: memberId ?? actingMemberId,
          fullName: fields.full_name,
          address: fields.address,
          dateOfBirth: fields.date_of_birth,
          idDocumentNumber: idNumber,
          idDocumentPath: idDocumentUrl,
        },
      }));
    } catch (e) {
      setSubmitting(false);
      toast.error((e as Error).message);
      return;
    }

    // The account moves on once every member's identity is in.
    const everyoneIn = pending.length === 0;
    const { error } = await supabase
      .from("buyer_accounts")
      .update({
        ...(isPrimary
          ? {
              intent,
              target_budget_bucket: budgetBucket,
              // Internal Liquidity Gate basis only — never displayed to a human.
              target_budget: liquidityBasisFor(bucketById(budgetBucket)!),
            }
          : {}),
        last_activity_at: new Date().toISOString(),
        stall_warning_sent_at: null,
        ...(everyoneIn ? { onboarding_status: "lifestyle_survey_pending" } : {}),
      })
      .eq("id", accountId);

    setSubmitting(false);
    if (error) {
      toast.error(error.message);
      return;
    }

    await logAudit({
      actorId: user.id,
      actorType: "buyer",
      actionType: "buyer.identity_submitted",
      entityType: "buyer_account",
      entityId: accountId,
      metadata: { has_document: Boolean(idDocumentUrl), manual_mode: manualMode, intent: isPrimary ? intent : undefined, ...actingAuditMeta(memberId ?? actingMemberId) },
    });

    if (!everyoneIn) {
      toast.success(`Saved. Next: ${pending.join(" and ")} completes their identity. Use "Switch person".`);
      return;
    }
    navigate({ to: "/buyer/onboarding/lifestyle" });
  }

  if (loading || bootstrapping) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted-foreground">
        Loading your buyer account…
      </div>
    );
  }

  const showForm = scanned || manualMode || Boolean(fields.full_name);

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
      <BuyerOnboardingStepper current={1} />

      <div className="mt-10 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
          Step 2 · Identity
        </p>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          Verify your identity
        </h1>
        <p className="mt-3 text-base text-muted-foreground">
          Upload a clear photo of your driver's license, tell us how you plan to use your shares,
          and confirm your budget.
        </p>
      </div>

      {/* ID scan */}
      <div className="mt-10 rounded-xl border border-border bg-card p-6 shadow-sm">
        <label className="text-sm font-medium text-foreground">Driver's license photo</label>
        <p className="mt-1 text-xs text-muted-foreground">JPG or PNG, up to 10MB.</p>

        <div
          className={cn(
            "mt-4 flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 text-center transition-colors",
            previewUrl ? "border-accent/50 bg-accent/5" : "border-border hover:border-foreground/30",
          )}
        >
          {previewUrl ? (
            <img
              src={previewUrl}
              alt="Driver's license preview"
              className="max-h-56 rounded-md border border-border object-contain"
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              Drag &amp; drop, or choose a file / take a photo.
            </p>
          )}

          <div className="mt-4 flex flex-wrap justify-center gap-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex h-10 items-center justify-center rounded-md border border-border bg-background px-4 text-sm font-medium text-foreground shadow-sm hover:bg-muted"
            >
              {previewUrl ? "Replace file" : "Choose file"}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
                e.target.value = "";
              }}
            />
          </div>

          {scanning ? <p className="mt-4 text-xs text-muted-foreground">Scanning document…</p> : null}
        </div>

        {!manualMode ? (
          <div className="mt-4 text-center">
            {/* Risk Flag (from spec): manual entry fallback is REQUIRED
                in case OCR fails or the buyer can't upload a clear image. */}
            <button
              type="button"
              onClick={() => {
                setManualMode(true);
                toast.message("Manual entry enabled.");
              }}
              className="text-sm font-medium text-accent underline-offset-4 hover:underline"
            >
              Can't scan? Enter details manually
            </button>
          </div>
        ) : null}
      </div>

      {/* Review / manual entry */}
      {showForm ? (
        <div className="mt-8 rounded-xl border border-border bg-card p-6 shadow-sm">
          <h2 className="font-display text-lg font-semibold text-foreground">
            {scanned ? "Review your details" : "Enter your details"}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            OCR can be inaccurate — please double-check every field before continuing.
          </p>

          <div className="mt-5 grid gap-4">
            <Field
              label="Full name"
              name="full_name"
              value={fields.full_name}
              onChange={(e) => setFields((s) => ({ ...s, full_name: e.target.value }))}
              error={errors.full_name}
              placeholder="As shown on your license"
            />
            <Field
              label="Address"
              name="address"
              value={fields.address}
              onChange={(e) => setFields((s) => ({ ...s, address: e.target.value }))}
              error={errors.address}
              placeholder="Street, city, state, ZIP"
            />
            <Field
              label="Date of birth"
              name="date_of_birth"
              type="date"
              value={fields.date_of_birth}
              onChange={(e) => setFields((s) => ({ ...s, date_of_birth: e.target.value }))}
              error={errors.date_of_birth}
            />
            <Field
              label="ID document number"
              name="id_document_number"
              value={idNumber}
              onChange={(e) => setIdNumber(e.target.value)}
              error={errors.id_number}
              placeholder="As shown on the license"
              autoComplete="off"
            />
          </div>
        </div>
      ) : null}

      {isPrimary ? (
      <>
      {/* Intent check */}
      <div className="mt-8 rounded-xl border border-border bg-card p-6 shadow-sm">
        <h2 className="font-display text-lg font-semibold text-foreground">Intent check</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          How do you plan to use the shares you buy?
        </p>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          {INTENTS.map((option) => {
            const selected = intent === option.value;
            return (
              <label
                key={option.value}
                className={cn(
                  "cursor-pointer rounded-lg border p-5 transition-colors",
                  selected
                    ? "border-accent bg-accent/5 ring-1 ring-accent"
                    : "border-border hover:border-foreground/30",
                )}
              >
                <div className="flex items-start gap-3">
                  <input
                    type="radio"
                    name="intent"
                    value={option.value}
                    checked={selected}
                    onChange={() => setIntent(option.value)}
                    className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
                  />
                  <div>
                    <p className="text-sm font-semibold text-foreground">{option.title}</p>
                    <p className="text-xs font-medium uppercase tracking-wider text-accent">
                      {option.subtitle}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">{option.body}</p>
                  </div>
                </div>
              </label>
            );
          })}
        </div>
        {errors.intent ? <p className="mt-3 text-xs text-destructive">{errors.intent}</p> : null}
      </div>

      {/* Financial snapshot */}
      <div className="mt-8 rounded-xl border border-border bg-card p-6 shadow-sm">
        <h2 className="font-display text-lg font-semibold text-foreground">Financial snapshot</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Ownership comes with ongoing costs — we ask every buyer to plan for them up front.
        </p>

        <div className="mt-5 grid gap-5">
          <fieldset>
            <legend className="text-sm font-semibold text-foreground">
              What is your target budget?
            </legend>
            <p className="mt-1 text-xs text-muted-foreground">
              Choose the range you&apos;re prepared to invest in shares. We keep budgets as broad
              ranges so no individual buyer&apos;s figure can be identified.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {BUDGET_BUCKETS.map((b) => {
                const selected = budgetBucket === b.id;
                return (
                  <label
                    key={b.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-lg border p-4 transition-colors",
                      selected ? "border-accent bg-accent/5" : "border-border hover:bg-secondary",
                    )}
                  >
                    <input
                      type="radio"
                      name="target_budget_bucket"
                      value={b.id}
                      checked={selected}
                      onChange={() => setBudgetBucket(b.id)}
                      className="h-4 w-4 accent-[var(--color-accent)]"
                    />
                    <span className="text-sm font-semibold text-foreground">{b.label}</span>
                  </label>
                );
              })}
            </div>
            {errors.budget ? (
              <p className="mt-2 text-xs text-destructive">{errors.budget}</p>
            ) : null}
          </fieldset>

          <label className="flex items-start gap-3 rounded-lg border border-border p-4">
            <input
              type="checkbox"
              checked={reserveConfirmed}
              onChange={(e) => setReserveConfirmed(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
            />
            <span className="text-sm text-foreground">
              I confirm I have my target budget plus a{" "}
              <span className="font-semibold">20% reserve</span> for property taxes, maintenance,
              and shared operating costs.
            </span>
          </label>
          {errors.reserve ? <p className="text-xs text-destructive">{errors.reserve}</p> : null}
        </div>
      </div>
      </>
      ) : null}

      <div className="mt-8 flex justify-end">
        <button
          type="button"
          disabled={submitting}
          onClick={() => void handleSubmit()}
          className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-6 text-sm font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {submitting ? "Saving…" : "Confirm and continue"}
        </button>
      </div>
    </div>
  );
}
