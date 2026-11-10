import { useState } from "react";
import { block4DeclarationLine, block4Questions, STANDARD_VERSION } from "@/constants/eligibilityCopy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  AUTHORIZATION_QUESTION,
  NAME_MISMATCH_MESSAGE,
  Q5_REQUIRED_MESSAGE,
  QUESTION_KEYS,
  attestationLabel,
  legalNamesMatch,
  type DeclarationAnswer,
  type DeclarationAnswers,
  type QuestionKey,
} from "@/lib/eligibility-declaration";

/**
 * Block 4 — Eligibility Declaration and Authorization. The six questions come one at a time,
 * each answered Yes or No (there is no free text), then the declaration line is confirmed with
 * the personal attestation and the member's typed full legal name.
 */

export interface DeclarationSummary {
  id: string;
  status: "incomplete" | "complete" | "superseded" | "legacy";
  answers: DeclarationAnswers | null;
  declared_at: string;
  signed_name: string | null;
  standard_version: string;
  declaration_hash: string;
}

export interface DeclarationSubmit {
  answers: DeclarationAnswers;
  attestedPersonally: boolean;
  signedName: string;
  supersedesId: string | null;
}

type Partial6 = Partial<Record<QuestionKey, DeclarationAnswer>>;

export function EligibilityDeclaration({
  memberName,
  verifiedName,
  current,
  onSubmit,
}: {
  memberName: string;
  /** The name from this member's verified ID. Null until the identity step is done. */
  verifiedName: string | null;
  current: DeclarationSummary | null;
  onSubmit: (input: DeclarationSubmit) => Promise<void>;
}) {
  const [mode, setMode] = useState<"summary" | "questions" | "confirm">(current ? "summary" : "questions");
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Partial6>({});
  const [correcting, setCorrecting] = useState(false);

  function start(fromStep: number, prefill: Partial6, isCorrection: boolean) {
    setAnswers(prefill);
    setStep(fromStep);
    setCorrecting(isCorrection);
    setMode("questions");
  }

  return (
    <section className="mt-8 rounded-xl border border-border bg-card p-6 shadow-sm" aria-labelledby="block4-heading">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Block 4</p>
      <h2 id="block4-heading" className="mt-1 font-display text-lg font-semibold text-foreground">
        Eligibility Declaration and Authorization
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Made by {memberName} personally · Participant Eligibility Standard {STANDARD_VERSION}
      </p>

      {mode === "summary" && current ? (
        <Summary
          record={current}
          onCorrect={() => start(0, current.answers ?? {}, true)}
          onChangeQ5={() => start(QUESTION_KEYS.indexOf(AUTHORIZATION_QUESTION), current.answers ?? {}, true)}
        />
      ) : null}

      {mode === "questions" ? (
        <QuestionStep
          index={step}
          answer={answers[QUESTION_KEYS[step]]}
          correcting={correcting}
          onAnswer={(value) => setAnswers((a) => ({ ...a, [QUESTION_KEYS[step]]: value }))}
          onBack={step > 0 ? () => setStep(step - 1) : current ? () => setMode("summary") : undefined}
          onNext={() => (step < QUESTION_KEYS.length - 1 ? setStep(step + 1) : setMode("confirm"))}
        />
      ) : null}

      {mode === "confirm" ? (
        <Confirm
          answers={answers as DeclarationAnswers}
          memberName={memberName}
          verifiedName={verifiedName}
          onBack={() => {
            setStep(QUESTION_KEYS.length - 1);
            setMode("questions");
          }}
          onSubmit={async (attested, signedName) => {
            await onSubmit({ answers: answers as DeclarationAnswers, attestedPersonally: attested, signedName, supersedesId: correcting && current ? current.id : null });
          }}
        />
      ) : null}
    </section>
  );
}

function YesNo({ value, onChange, name }: { value: DeclarationAnswer | undefined; onChange: (v: DeclarationAnswer) => void; name: string }) {
  return (
    <div role="radiogroup" aria-label={name} className="mt-5 grid grid-cols-2 gap-3 sm:max-w-sm">
      {(["yes", "no"] as const).map((v) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cn(
            "min-h-11 rounded-md border-2 px-4 text-base font-semibold transition-colors",
            value === v ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-foreground hover:border-primary/60",
          )}
        >
          {v === "yes" ? "Yes" : "No"}
        </button>
      ))}
    </div>
  );
}

function QuestionStep({
  index,
  answer,
  correcting,
  onAnswer,
  onBack,
  onNext,
}: {
  index: number;
  answer: DeclarationAnswer | undefined;
  correcting: boolean;
  onAnswer: (v: DeclarationAnswer) => void;
  onBack?: () => void;
  onNext: () => void;
}) {
  const key = QUESTION_KEYS[index];
  return (
    <div className="mt-5" data-question={key}>
      {correcting && index === 0 ? (
        <p className="mb-4 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          You are correcting a fact in your declaration. This is not an appeal. Your earlier declaration is kept on record, and this one is added as a new version.
        </p>
      ) : null}
      <p className="text-sm font-medium text-muted-foreground">
        Question {index + 1} of {QUESTION_KEYS.length}
      </p>
      <p className="mt-2 text-base leading-relaxed text-foreground">{block4Questions[index]}</p>
      <YesNo value={answer} onChange={onAnswer} name={`Question ${index + 1}`} />
      {key === AUTHORIZATION_QUESTION && answer === "no" ? (
        <p role="status" className="mt-4 rounded-lg border border-border bg-muted/40 p-3 text-sm text-foreground">
          {Q5_REQUIRED_MESSAGE}
        </p>
      ) : null}
      <div className="mt-6 flex flex-wrap gap-3">
        {onBack ? (
          <Button variant="outline" onClick={onBack}>
            Back
          </Button>
        ) : null}
        <Button onClick={onNext} disabled={!answer}>
          {index < QUESTION_KEYS.length - 1 ? "Next question" : "Review and declare"}
        </Button>
      </div>
    </div>
  );
}

function AnswerList({ answers }: { answers: DeclarationAnswers }) {
  return (
    <ol className="mt-4 space-y-3">
      {QUESTION_KEYS.map((k, i) => (
        <li key={k} className="rounded-lg border border-border bg-background p-3 text-sm leading-relaxed text-foreground">
          <span className="font-medium">{i + 1}.</span> {block4Questions[i]}
          <span className="mt-1 block font-semibold">Answer: {answers[k] === "yes" ? "Yes" : "No"}</span>
        </li>
      ))}
    </ol>
  );
}

function Confirm({
  answers,
  memberName,
  verifiedName,
  onBack,
  onSubmit,
}: {
  answers: DeclarationAnswers;
  memberName: string;
  verifiedName: string | null;
  onBack: () => void;
  onSubmit: (attested: boolean, signedName: string) => Promise<void>;
}) {
  const [attested, setAttested] = useState(false);
  const [signedName, setSignedName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const incomplete = answers[AUTHORIZATION_QUESTION] !== "yes";

  async function submit() {
    setError(null);
    if (!attested) return setError("Confirm that you are personally making this declaration.");
    if (!verifiedName) return setError("Finish the identity step first, so your signature can be checked against your ID.");
    if (!legalNamesMatch(signedName, verifiedName)) return setError(NAME_MISMATCH_MESSAGE);
    setBusy(true);
    try {
      await onSubmit(attested, signedName.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the declaration.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5">
      <p className="text-sm font-medium text-muted-foreground">Your answers</p>
      <AnswerList answers={answers} />
      <p className="mt-6 rounded-lg border-2 border-foreground/70 bg-background p-4 text-base font-medium leading-relaxed text-foreground">{block4DeclarationLine}</p>
      {incomplete ? (
        <p role="status" className="mt-4 rounded-lg border border-border bg-muted/40 p-3 text-sm text-foreground">
          {Q5_REQUIRED_MESSAGE}
        </p>
      ) : null}
      <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-background p-4">
        <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} autoComplete="off" className="mt-1 h-5 w-5 shrink-0 accent-[var(--color-primary)]" />
        <span className="text-sm text-foreground">{attestationLabel(memberName)}</span>
      </label>
      <div className="mt-4 space-y-2">
        <Label htmlFor="block4-signature">Type your full legal name as your signature</Label>
        <Input id="block4-signature" value={signedName} onChange={(e) => setSignedName(e.target.value)} autoComplete="off" placeholder="Full legal name, as on your ID" />
        <p className="text-xs text-muted-foreground">We record the name, IP address, browser and time, and keep the exact text above with its fingerprint.</p>
      </div>
      {error ? (
        <p role="alert" className="mt-4 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-foreground">
          {error}
        </p>
      ) : null}
      <div className="mt-6 flex flex-wrap gap-3">
        <Button variant="outline" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button onClick={submit} disabled={busy || !attested || !signedName.trim()}>
          {busy ? "Saving…" : incomplete ? "Save my answers" : "Make this declaration"}
        </Button>
      </div>
    </div>
  );
}

function Summary({ record, onCorrect, onChangeQ5 }: { record: DeclarationSummary; onCorrect: () => void; onChangeQ5: () => void }) {
  const when = new Date(record.declared_at).toLocaleString();
  return (
    <div className="mt-5">
      {record.status === "incomplete" ? (
        <div className="rounded-lg border border-border bg-muted/40 p-4">
          <p className="text-sm text-foreground">{Q5_REQUIRED_MESSAGE}</p>
          <Button className="mt-3" onClick={onChangeQ5}>
            Change my answer
          </Button>
        </div>
      ) : (
        <p className="rounded-lg border border-primary/40 bg-primary/5 p-4 text-sm text-foreground">
          Declaration made {when}, signed “{record.signed_name}”, under Standard {record.standard_version}.
        </p>
      )}
      {record.answers ? <AnswerList answers={record.answers} /> : null}
      <p className="mt-3 break-all text-xs text-muted-foreground">Record fingerprint: {record.declaration_hash}</p>
      <Button variant="outline" className="mt-4" onClick={onCorrect}>
        Correct and resubmit
      </Button>
    </div>
  );
}
