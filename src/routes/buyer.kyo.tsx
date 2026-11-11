import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ActingMemberGate } from "@/components/ActingMemberGate";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { HELD_BUYER_TEXT, RESULT_LABELS, RESULT_TONES } from "@/lib/eligibility-engine";
import { CORRECTION_FIELDS, DECLARATION_CORRECTION_NOTE, KYO_MOST_SENSITIVE_PII, type CorrectionField } from "@/lib/kyo";
import { getMyKyo, requestKyoCorrectionFn } from "@/lib/kyo.functions";

export const Route = createFileRoute("/buyer/kyo")({
  head: () => ({ meta: [{ title: "My data — divieight" }, { name: "description", content: "See the data divieight holds about you as an Account Member, and ask for a correction." }] }),
  component: KyoScreen,
});

function KyoScreen() {
  return (
    <ActingMemberGate step="My data">
      {({ member, switchPerson }) => <KyoForMember key={member.id} actingMemberId={member.id} onSwitch={switchPerson} />}
    </ActingMemberGate>
  );
}

type View = Awaited<ReturnType<typeof getMyKyo>>;

function KyoForMember({ actingMemberId, onSwitch }: { actingMemberId: string; onSwitch: () => void }) {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const load = useServerFn(getMyKyo);
  const request = useServerFn(requestKyoCorrectionFn);
  const [view, setView] = useState<View | null>(null);
  const [field, setField] = useState<CorrectionField>("full_name");
  const [change, setChange] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setView(await load({ data: { actingMemberId } }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load your data.");
    }
  }, [load, actingMemberId]);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate({ to: "/buyer/login", replace: true });
      return;
    }
    void refresh();
  }, [user, loading, navigate, refresh]);

  async function submit() {
    setBusy(true);
    try {
      await request({ data: { actingMemberId, field, requestedChange: change } });
      toast.success("Your correction request was sent.");
      setChange("");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't send the request.");
    } finally {
      setBusy(false);
    }
  }

  const row = (label: string, value: string | null | undefined) => (
    <div className="flex justify-between gap-4 border-b border-border/60 py-2 text-sm last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right text-foreground">{value ?? "—"}</dd>
    </div>
  );

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Know Your Owner</p>
      <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-foreground">My data</h1>
      <p className="mt-3 text-sm text-muted-foreground">What divieight holds about you as an Account Member. You see only your own: the other member sees theirs when they switch to themselves.</p>

      {!view ? (
        <p className="mt-8 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <section className="mt-8 rounded-xl border border-border bg-card p-6">
            <h2 className="font-display text-lg font-semibold text-foreground">{view.name}</h2>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {view.eligibility ? (
                <span className={`rounded-full border px-3 py-1 text-xs font-medium ${RESULT_TONES[view.eligibility.result]}`}>{RESULT_LABELS[view.eligibility.result]}</span>
              ) : (
                <span className="rounded-full border border-border bg-muted px-3 py-1 text-xs text-muted-foreground">No result yet</span>
              )}
              {view.eligibility ? <span className="text-xs text-muted-foreground">Participant Eligibility Standard version {view.eligibility.standardVersion}</span> : null}
            </div>
            {view.held ? <p className="mt-3 text-sm text-foreground">{HELD_BUYER_TEXT}</p> : null}
            <dl className="mt-4">
              {row("Eligibility declaration", view.declaration ? `${view.declaration.status}, Standard ${view.declaration.standardVersion}, ${new Date(view.declaration.declaredAt).toLocaleDateString()}` : "not made yet")}
              {row("Declaration fingerprint", view.declaration?.declarationHash ?? null)}
              {row("Full name", view.onFile.fullName)}
              {row("Date of birth", view.onFile.dateOfBirth)}
              {row("Address", view.onFile.address)}
              {row("ID document number", view.onFile.idDocumentNumber)}
              {row("ID image", view.onFile.idImage)}
              {row("Liveness check", view.onFile.liveness)}
              {row("W-9", view.onFile.w9 ? `${view.onFile.w9.kind === "ein" ? "EIN" : "SSN"} ending ${view.onFile.w9.last4}` : null)}
              {row("Email", view.onFile.email)}
              {row("Phone", view.onFile.phone)}
            </dl>
            <p className="mt-4 text-xs text-muted-foreground">Held with extra care, with access limited and logged: {KYO_MOST_SENSITIVE_PII.join("; ")}.</p>
          </section>

          <section className="mt-6 space-y-3 rounded-xl border border-border bg-card p-6">
            <h2 className="font-display text-lg font-semibold text-foreground">Ask for a correction</h2>
            <p className="text-xs text-muted-foreground">{DECLARATION_CORRECTION_NOTE}</p>
            <select aria-label="What to correct" value={field} onChange={(e) => setField(e.target.value as CorrectionField)} className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm">
              {CORRECTION_FIELDS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <textarea aria-label="What should it say" value={change} onChange={(e) => setChange(e.target.value)} rows={3} maxLength={2000} className="w-full rounded-md border border-border bg-background p-3 text-sm" placeholder="What is wrong, and what it should say" />
            <Button onClick={() => void submit()} disabled={busy || !change.trim()}>
              {busy ? "Sending…" : "Send the request"}
            </Button>
            {view.corrections.length ? (
              <ul className="space-y-2 pt-2 text-xs text-muted-foreground">
                {view.corrections.map((c) => (
                  <li key={c.id}>
                    {CORRECTION_FIELDS.find((f) => f.value === c.field)?.label ?? c.field} · {c.status === "open" ? "open" : `handled ${c.resolved_at ? new Date(c.resolved_at).toLocaleDateString() : ""}`}
                    {c.resolution_note ? ` · ${c.resolution_note}` : ""}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        </>
      )}

      <div className="mt-8 flex flex-wrap gap-3">
        <Button variant="outline" onClick={onSwitch}>
          Switch person
        </Button>
        <Button asChild variant="outline">
          <Link to="/buyer/dashboard">Back to dashboard</Link>
        </Button>
      </div>
    </div>
  );
}
