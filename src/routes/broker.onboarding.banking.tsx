import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Banknote, FileText, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { CredentialStepper } from "@/components/credentialing/CredentialStepper";
import { Field } from "@/components/Field";
import { logAudit } from "@/lib/audit";
import {
  completeBrokerOnboarding,
  getBrokerProfile,
  submitBankingDetails,
  uploadTaxForm,
  TAX_FORM_DESCRIPTIONS,
  TAX_FORM_TYPES,
  type BrokerRow,
  type TaxFormType,
} from "@/lib/broker";

export const Route = createFileRoute("/broker/onboarding/banking")({
  head: () => ({
    meta: [
      { title: "Banking & tax forms — divieight Broker of Record" },
      {
        name: "description",
        content:
          "Step 4 of divieight broker credentialing: banking details and W-9/W-8 tax form upload.",
      },
      { property: "og:title", content: "Banking & tax forms — divieight" },
      {
        property: "og:description",
        content: "Provide brokerage banking details and the applicable tax form.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: BrokerBankingPage,
});

function maskDigits(value: string, visible = 4) {
  const digits = value.replace(/\D/g, "");
  if (digits.length <= visible) return digits;
  return "•".repeat(digits.length - visible) + digits.slice(-visible);
}

function BrokerBankingPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [broker, setBroker] = useState<BrokerRow | null>(null);
  const [accountHolder, setAccountHolder] = useState("");
  const [routing, setRouting] = useState("");
  const [account, setAccount] = useState("");
  const [taxType, setTaxType] = useState<TaxFormType>("W-9");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    getBrokerProfile(user.id).then((row) => {
      if (cancelled || !row) return;
      setBroker(row);
      setAccountHolder(row.bank_account_holder ?? row.brokerage_name);
      if (row.w9_or_w8_type) setTaxType(row.w9_or_w8_type);
    });
    return () => {
      cancelled = true;
    };
  }, [user]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!broker) return;
    setError(null);

    if (routing.replace(/\D/g, "").length !== 9) {
      setError("Routing number must be 9 digits.");
      return;
    }
    if (account.replace(/\D/g, "").length < 6) {
      setError("Enter the full account number.");
      return;
    }

    setSubmitting(true);
    let path = broker.w9_or_w8_url;
    if (file) {
      const uploaded = await uploadTaxForm(broker.auth_user_id, file);
      if (uploaded.error) {
        setSubmitting(false);
        setError(uploaded.error);
        return;
      }
      path = uploaded.path ?? null;
    }

    const saved = await submitBankingDetails({
      brokerId: broker.id,
      accountHolder,
      routingNumber: routing,
      accountNumber: account,
      taxFormType: taxType,
      taxFormPath: path,
    });
    if (saved.error) {
      setSubmitting(false);
      setError(saved.error);
      return;
    }

    await logAudit({
      actorId: broker.auth_user_id,
      actorType: "broker",
      actionType: "broker.banking_saved",
      entityType: "broker",
      entityId: broker.id,
      metadata: { tax_form_type: taxType },
    });

    const done = await completeBrokerOnboarding(broker);
    setSubmitting(false);
    if (done.error) {
      setError(done.error);
      return;
    }

    await logAudit({
      actorId: broker.auth_user_id,
      actorType: "broker",
      actionType: "broker.onboarding_completed",
      entityType: "broker",
      entityId: broker.id,
      metadata: { linked_agent_id: broker.invited_by_agent_id },
    });

    toast.success("Broker onboarding complete.");
    navigate({ to: "/broker/dashboard" });
  }

  return (
    <div className="space-y-8">
      <CredentialStepper entityType="broker" current={4} />

      <header className="space-y-2">
        <h1 className="font-display text-3xl font-semibold text-foreground">
          Banking &amp; tax forms
        </h1>
        <p className="text-sm text-muted-foreground">
          Commission is paid to the brokerage at closing by the title/escrow company from sale
          proceeds. divieight never pays brokers directly.
        </p>
      </header>

      <form onSubmit={onSubmit} className="space-y-6">
        <section className="rounded-xl border border-border bg-card p-6">
          <div className="mb-4 flex items-center gap-3">
            <Banknote className="h-5 w-5 text-accent" />
            <h2 className="font-display text-lg font-semibold text-foreground">Banking details</h2>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Account holder"
              name="accountHolder"
              value={accountHolder}
              onChange={(e) => setAccountHolder(e.target.value)}
              required
            />
            <div />
            <Field
              label="Routing number"
              name="routing"
              inputMode="numeric"
              autoComplete="off"
              value={routing}
              onChange={(e) => setRouting(e.target.value)}
              hint={routing ? `Stored as ${maskDigits(routing)}` : "9 digits"}
              required
            />
            <Field
              label="Account number"
              name="account"
              inputMode="numeric"
              autoComplete="off"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              hint={account ? `Stored as ${maskDigits(account)}` : "Masked on save"}
              required
            />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Only the last four digits are retained. Full numbers must be vaulted through a
            PCI-safe secrets provider before production use.
          </p>
        </section>

        <section className="rounded-xl border border-border bg-card p-6">
          <div className="mb-4 flex items-center gap-3">
            <FileText className="h-5 w-5 text-accent" />
            <h2 className="font-display text-lg font-semibold text-foreground">Tax form</h2>
          </div>
          <div className="space-y-3">
            {TAX_FORM_TYPES.map((t) => (
              <label
                key={t}
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-4 text-sm"
              >
                <input
                  type="radio"
                  name="taxType"
                  className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
                  checked={taxType === t}
                  onChange={() => setTaxType(t)}
                />
                <span>
                  <span className="block font-medium text-foreground">{t}</span>
                  <span className="block text-muted-foreground">{TAX_FORM_DESCRIPTIONS[t]}</span>
                </span>
              </label>
            ))}
          </div>

          <label className="mt-4 flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            <Upload className="h-4 w-4 text-accent" />
            <span className="[overflow-wrap:anywhere]">
              {file ? file.name : `Upload completed ${taxType} (PDF or image)`}
            </span>
            <input
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.webp"
              className="sr-only"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
        </section>

        {error ? (
          <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={submitting || !broker}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-60"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Complete broker onboarding
        </button>
      </form>
    </div>
  );
}
