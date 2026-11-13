import { createFileRoute } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Field } from "@/components/Field";
import { getBrokerTaxFormStatus, submitBrokerTaxFormFn } from "@/lib/tax-forms.functions";
import { TAX_FORM_LABELS, requiredFormType, tinProblem, type EntityKind } from "@/lib/tax-forms";

export const Route = createFileRoute("/broker/tax-form")({
  head: () => ({
    meta: [
      { title: "Tax form — divieight Broker of Record" },
      { name: "description", content: "Submit your W-9 or W-8 so payouts to your brokerage can be released." },
      { property: "og:title", content: "Tax form — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: BrokerTaxFormPage,
});

const STATE_TEXT: Record<string, string> = {
  valid: "Valid. Payouts to your brokerage can be released.",
  missing: "Tax form missing. No payout is released to your brokerage until you submit one.",
  expired: "Your tax form has expired. No payout is released until you submit a new one.",
  rejected: "Your tax form was rejected. Submit a corrected one.",
};

function BrokerTaxFormPage() {
  const load = useServerFn(getBrokerTaxFormStatus);
  const submit = useServerFn(submitBrokerTaxFormFn);
  const q = useQuery({ queryKey: ["broker-tax-form"], queryFn: () => load(), retry: false });
  const [us, setUs] = useState(true);
  const [kind, setKind] = useState<EntityKind>("entity");
  const [legalName, setLegalName] = useState("");
  const [address, setAddress] = useState("");
  const [country, setCountry] = useState("US");
  const [tinKind, setTinKind] = useState<"ssn" | "ein" | "itin">("ein");
  const [tin, setTin] = useState("");
  const [noTin, setNoTin] = useState(false);
  const [signedName, setSignedName] = useState("");
  const [certified, setCertified] = useState(false);
  const formType = requiredFormType(us, kind);
  const tinMsg = tin ? tinProblem(us ? tinKind : "foreign_tin", tin) : null;
  const m = useMutation({
    mutationFn: () => submit({ data: { isUsPerson: us, entityKind: kind, legalName, address, country: us ? "US" : country, tinKind: us ? tinKind : tin ? "foreign_tin" : null, tin: tin || null, noForeignTin: !us && noTin, signedName, certified } }),
    onSuccess: (r) => {
      // The number is cleared at once: only a sealed copy and the last four are kept.
      setTin("");
      toast.success(`${r.formType} saved${r.expiry ? ` (valid until ${r.expiry})` : ""}.`);
      void q.refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-8 text-foreground">
      <header className="space-y-2">
        <h1 className="font-display text-3xl font-semibold">Tax form</h1>
        <p className="text-sm text-muted-foreground">
          No payout of any kind is released to a Broker of Record until a valid tax form is on file: a W-9 for a US person or entity, a W-8BEN for a non-US individual, a W-8BEN-E for a non-US entity. Your tax ID is encrypted when you save it. divieight keeps only the last four characters in the clear.
        </p>
      </header>
      {q.data ? (
        <section className={`rounded-xl border p-4 text-sm ${q.data.allowed ? "border-border bg-card" : "border-destructive/40 bg-destructive/10"}`}>
          <p className="font-medium">{STATE_TEXT[q.data.state]}</p>
          {q.data.formType ? (
            <p className="mt-1 text-muted-foreground">
              {q.data.formType}
              {q.data.legalName ? ` · ${q.data.legalName}` : ""}
              {q.data.last4 ? ` · ID ending ${q.data.last4}` : ""}
              {q.data.expiry ? ` · expires ${q.data.expiry}` : ""}
            </p>
          ) : null}
        </section>
      ) : null}
      <form onSubmit={onSubmit} className="space-y-5 rounded-xl border border-border bg-card p-6" autoComplete="off">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Who is the brokerage?</legend>
          <label className="mr-4 text-sm">
            <input type="radio" checked={us} onChange={() => { setUs(true); setCountry("US"); }} /> A US person or US-registered entity
          </label>
          <label className="text-sm">
            <input type="radio" checked={!us} onChange={() => { setUs(false); setCountry(""); }} /> Non-US
          </label>
          {!us ? (
            <div className="space-x-4 pt-1 text-sm">
              <label>
                <input type="radio" checked={kind === "individual"} onChange={() => setKind("individual")} /> An individual
              </label>
              <label>
                <input type="radio" checked={kind === "entity"} onChange={() => setKind("entity")} /> An entity
              </label>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">The form for you: {TAX_FORM_LABELS[formType]}.</p>
        </fieldset>
        <Field label="Legal name (as on your tax records)" name="legalName" value={legalName} onChange={(e) => setLegalName(e.target.value)} required />
        <Field label="Mailing address" name="address" value={address} onChange={(e) => setAddress(e.target.value)} required />
        {!us ? <Field label="Country (two letters, for example GB)" name="country" value={country} maxLength={2} onChange={(e) => setCountry(e.target.value.toUpperCase())} required /> : null}
        {us ? (
          <div className="space-y-2">
            <label className="block text-sm font-medium">
              Tax ID type
              <select className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" value={tinKind} onChange={(e) => setTinKind(e.target.value as "ssn" | "ein" | "itin")}>
                <option value="ein">EIN</option>
                <option value="ssn">SSN</option>
                <option value="itin">ITIN</option>
              </select>
            </label>
            <Field label="Tax ID" name="tin" inputMode="numeric" autoComplete="off" value={tin} onChange={(e) => setTin(e.target.value)} error={tinMsg ?? undefined} required />
          </div>
        ) : (
          <div className="space-y-2">
            <Field label="Foreign tax ID" name="tin" autoComplete="off" value={tin} onChange={(e) => setTin(e.target.value)} error={tinMsg ?? undefined} disabled={noTin} />
            <label className="text-sm">
              <input type="checkbox" checked={noTin} onChange={(e) => { setNoTin(e.target.checked); if (e.target.checked) setTin(""); }} /> My country issues no tax ID
            </label>
            <p className="text-xs text-muted-foreground">A W-8 is valid until the end of the third calendar year after you sign it. You will be asked for a new one then.</p>
          </div>
        )}
        <Field label="Signature: type your full name" name="signedName" value={signedName} onChange={(e) => setSignedName(e.target.value)} required />
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={certified} onChange={(e) => setCertified(e.target.checked)} />
          <span>I certify, under penalties of perjury, that the information above is correct.</span>
        </label>
        <button type="submit" disabled={m.isPending || !certified || !!tinMsg} className="inline-flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-60">
          {m.isPending ? "Saving…" : `Submit my ${formType}`}
        </button>
      </form>
    </div>
  );
}
