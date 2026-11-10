import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ActingMemberGate } from "@/components/ActingMemberGate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { getMyW9, submitW9Fn } from "@/lib/member-steps.functions";
import { TAX_CLASSIFICATIONS, maskedTin, type TinKind } from "@/lib/w9";
import type { W9View } from "@/lib/w9.server";

export const Route = createFileRoute("/buyer/onboarding/w9")({
  head: () => ({ meta: [{ title: "W-9 — divieight" }, { name: "description", content: "Each Account Member completes their own W-9." }] }),
  component: W9Screen,
});

function W9Screen() {
  return (
    <ActingMemberGate step="W-9">
      {({ member, switchPerson }) => <W9ForMember key={member.id} actingMemberId={member.id} onSwitch={switchPerson} />}
    </ActingMemberGate>
  );
}

function W9ForMember({ actingMemberId, onSwitch }: { actingMemberId: string; onSwitch: () => void }) {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const load = useServerFn(getMyW9);
  const submit = useServerFn(submitW9Fn);
  const [state, setState] = useState<{ w9: W9View | null; memberName: string } | null>(null);
  const [legalName, setLegalName] = useState("");
  const [classification, setClassification] = useState("individual");
  const [address, setAddress] = useState("");
  const [tinKind, setTinKind] = useState<TinKind>("ssn");
  const [tin, setTin] = useState("");
  const [signedName, setSignedName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate({ to: "/buyer/login", replace: true });
      return;
    }
    void load({ data: { actingMemberId } })
      .then((s) => {
        setState(s);
        setLegalName(s.memberName);
      })
      .catch((e: Error) => toast.error(e.message));
  }, [user, loading, navigate, load, actingMemberId]);

  async function onSubmit() {
    setError(null);
    setBusy(true);
    try {
      const r = await submit({ data: { actingMemberId, legalName, taxClassification: classification, address, tinKind, tin, signedName } });
      // The full TIN is cleared from the page as soon as it is saved; only the last four come back.
      setTin("");
      setState((s) => (s ? { ...s, w9: r.w9 } : s));
      toast.success("W-9 saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The W-9 couldn't be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">W-9</p>
      <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-foreground">Request for Taxpayer Identification Number</h1>
      <p className="mt-3 text-sm text-muted-foreground">Each Account Member completes their own W-9. Your TIN is encrypted; after you enter it, only its last four digits are ever shown.</p>

      {!state ? (
        <p className="mt-8 text-sm text-muted-foreground">Loading…</p>
      ) : state.w9 ? (
        <section className="mt-8 rounded-xl border border-border bg-card p-6">
          <p className="font-medium text-foreground">W-9 on file for {state.w9.legal_name}</p>
          <dl className="mt-3 grid gap-1 text-sm text-muted-foreground">
            <div>Tax classification: {TAX_CLASSIFICATIONS.find((c) => c.value === state.w9!.tax_classification)?.label}</div>
            <div>
              {state.w9.tin_kind === "ein" ? "EIN" : "SSN"}: {maskedTin(state.w9.tin_last4, state.w9.tin_kind)}
            </div>
            <div>
              Signed “{state.w9.signed_name}” on {new Date(state.w9.signed_at).toLocaleString()}
            </div>
          </dl>
          <div className="mt-5 flex flex-wrap gap-3">
            <Button variant="outline" onClick={onSwitch}>
              Switch person
            </Button>
            <Button asChild>
              <Link to="/buyer/dashboard">Back to dashboard</Link>
            </Button>
          </div>
        </section>
      ) : (
        <section className="mt-8 space-y-4 rounded-xl border border-border bg-card p-6">
          <div className="space-y-1.5">
            <Label htmlFor="w9-name">Name (as shown on your income tax return)</Label>
            <Input id="w9-name" value={legalName} onChange={(e) => setLegalName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="w9-class">Federal tax classification</Label>
            <select id="w9-class" value={classification} onChange={(e) => setClassification(e.target.value)} className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm">
              {TAX_CLASSIFICATIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="w9-address">Address</Label>
            <Input id="w9-address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street, city, state, ZIP" />
          </div>
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium text-foreground">Taxpayer Identification Number</legend>
            <div className="flex gap-4 text-sm">
              {(["ssn", "ein"] as const).map((k) => (
                <label key={k} className="flex items-center gap-2">
                  <input type="radio" name="tin-kind" checked={tinKind === k} onChange={() => setTinKind(k)} />
                  {k === "ssn" ? "Social Security number" : "Employer Identification Number"}
                </label>
              ))}
            </div>
            <Input aria-label="TIN" value={tin} onChange={(e) => setTin(e.target.value)} inputMode="numeric" autoComplete="off" placeholder={tinKind === "ssn" ? "123-45-6789" : "12-3456789"} />
          </fieldset>
          <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            Under penalties of perjury, I certify that the number shown on this form is my correct taxpayer identification number, and that I am a U.S. citizen or other U.S. person.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="w9-sign">Type your full legal name as your signature</Label>
            <Input id="w9-sign" value={signedName} onChange={(e) => setSignedName(e.target.value)} autoComplete="off" placeholder={state.memberName} />
          </div>
          {error ? (
            <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-foreground">
              {error}
            </p>
          ) : null}
          <Button onClick={() => void onSubmit()} disabled={busy || !tin || !signedName.trim() || !legalName.trim() || !address.trim()}>
            {busy ? "Saving…" : "Sign and save W-9"}
          </Button>
        </section>
      )}
    </div>
  );
}
