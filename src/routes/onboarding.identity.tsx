import { useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { OnboardingStepper } from "@/components/OnboardingStepper";
import { Field } from "@/components/Field";
import { cn } from "@/lib/utils";
import { notifySeller } from "@/lib/notify";
import { logAudit } from "@/lib/audit";

export const Route = createFileRoute("/onboarding/identity")({
  head: () => ({
    meta: [
      { title: "Identity verification — divieight" },
      { name: "description", content: "Verify your identity to continue onboarding." },
    ],
  }),
  component: IdentityScreen,
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
// deterministic placeholder data so the seller can review/correct fields.
async function simulateOcrExtraction(_file: File): Promise<ExtractedFields> {
  await new Promise((r) => setTimeout(r, 1200));
  return {
    full_name: "Jane A. Sample",
    address: "123 Market Street, Apt 4B, San Francisco, CA 94103",
    date_of_birth: "1988-06-14",
  };
}

function IdentityScreen() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

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
  const [errors, setErrors] = useState<Partial<Record<keyof ExtractedFields, string>>>({});

  function readAsDataUrl(f: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(f);
    });
  }

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
    // A data URL survives navigation/CSP rules that can break blob: previews.
    try {
      setPreviewUrl(await readAsDataUrl(f));
    } catch {
      setPreviewUrl(null);
    }
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
    const next: Partial<Record<keyof ExtractedFields, string>> = {};
    if (!fields.full_name.trim()) next.full_name = "Full name is required.";
    if (!fields.address.trim()) next.address = "Address is required.";
    if (!fields.date_of_birth.trim()) next.date_of_birth = "Date of birth is required.";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleConfirm() {
    if (!user) {
      toast.error("You need to be signed in.");
      navigate({ to: "/login" });
      return;
    }
    if (!validate()) return;

    setSubmitting(true);
    let idDocumentUrl: string | null = null;

    if (file) {
      const ext = file.name.split(".").pop() ?? "jpg";
      const path = `${user.id}/license-${Date.now()}.${ext}`;
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

    const { error } = await supabase
      .from("sellers")
      .update({
        full_name: fields.full_name,
        address: fields.address,
        date_of_birth: fields.date_of_birth,
        ...(idDocumentUrl ? { id_document_url: idDocumentUrl } : {}),
        onboarding_status: "property_verification_pending",
      })
      .eq("id", user.id);

    setSubmitting(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    await notifySeller(user.id, "identity_submitted");
    await logAudit({
      actorId: user.id,
      actionType: "seller.identity_submitted",
      entityType: "seller",
      entityId: user.id,
      metadata: { has_document: Boolean(idDocumentUrl), manual_mode: manualMode },
    });
    // A seller who retains shares goes through the eligibility check (Block 4); Full Exit sellers have none.
    const { data: exit } = await supabase.from("sellers").select("exit_type").eq("id", user.id).maybeSingle();
    navigate({ to: exit?.exit_type === "hybrid_exit" ? "/onboarding/eligibility" : "/onboarding/property" });
  }

  const showForm = scanned || manualMode;

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
      <OnboardingStepper current={2} />

      <div className="mt-10 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
          Step 2 · Identity
        </p>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          Verify your identity
        </h1>
        <p className="mt-3 text-base text-muted-foreground">
          Upload a clear photo of your driver's license. We'll pre-fill your details for you to review.
        </p>
      </div>

      {/* Upload / capture */}
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
              alt="License preview"
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

          {scanning ? (
            <p className="mt-4 text-xs text-muted-foreground">Scanning document…</p>
          ) : null}
        </div>

        {!manualMode ? (
          <div className="mt-4 text-center">
            {/* Risk Flag (from spec): manual entry fallback is REQUIRED
                in case OCR fails or the seller can't upload a clear image. */}
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

      {/* Review / manual form */}
      {showForm ? (
        <div className="mt-8 rounded-xl border border-border bg-card p-6 shadow-sm">
          <h2 className="font-display text-lg font-semibold text-foreground">
            {scanned ? "Review your details" : "Enter your details"}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            OCR can be inaccurate — please double-check every field before confirming.
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
          </div>
        </div>
      ) : null}

      <div className="mt-10 flex justify-center">
        <button
          type="button"
          onClick={handleConfirm}
          disabled={!showForm || submitting || loading || scanning}
          className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-8 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "Saving..." : "Confirm and continue"}
        </button>
      </div>
    </div>
  );
}
