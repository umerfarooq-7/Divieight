import { useState } from "react";
import { Ban, CircleCheck, Clock3 } from "lucide-react";
import { decisionPageCopy as copy } from "@/constants/eligibilityCopy";
import { cn } from "@/lib/utils";

/**
 * The Eligibility Decision Page. Every word comes from decisionPageCopy, in its order;
 * nothing is folded away, and the box starts unticked on every load.
 */

type ListTone = "always" | "tenYears" | "doesNotCount";

const LIST_STYLE: Record<ListTone, { box: string; icon: string; Icon: typeof Ban }> = {
  always: { box: "border-destructive/40 bg-destructive/5", icon: "text-destructive", Icon: Ban },
  tenYears: { box: "border-amber-500/50 bg-amber-500/5", icon: "text-amber-600 dark:text-amber-400", Icon: Clock3 },
  doesNotCount: { box: "border-primary/40 bg-primary/5", icon: "text-primary", Icon: CircleCheck },
};

function ListSection({ title, lead, items, tail, tone }: { title: string; lead: string; items: readonly string[]; tail?: string; tone: ListTone }) {
  const style = LIST_STYLE[tone];
  return (
    <section className={cn("rounded-xl border-2 p-5 sm:p-6", style.box)}>
      <h3 className="font-display text-lg font-semibold text-foreground">{title}</h3>
      <p className="mt-2 text-base leading-relaxed text-foreground">{lead}</p>
      <ul className="mt-4 space-y-2.5">
        {items.map((item) => (
          <li key={item} className="flex gap-3 text-base leading-relaxed text-foreground">
            <style.Icon className={cn("mt-1 h-4 w-4 shrink-0", style.icon)} aria-hidden />
            <span>{item}</span>
          </li>
        ))}
      </ul>
      {tail ? <p className="mt-4 text-base leading-relaxed text-foreground">{tail}</p> : null}
    </section>
  );
}

function TextSection({ title, body }: { title: string; body: string }) {
  return (
    <section>
      <h3 className="font-display text-lg font-semibold text-foreground">{title}</h3>
      <p className="mt-2 text-base leading-relaxed text-foreground">{body}</p>
    </section>
  );
}

export function EligibilityStandardContent({ onContinue, busy = false }: { onContinue: () => void; busy?: boolean }) {
  // Never pre-selected, remembered or inferred: a fresh, unticked box on every load.
  const [acknowledged, setAcknowledged] = useState(false);
  const p1 = copy.partOne;

  return (
    <div className="mx-auto max-w-3xl px-4 pb-12 sm:px-6">
      <header className="border-b border-border py-6">
        <p className="font-display text-2xl font-semibold tracking-tight text-foreground">{copy.wordmark}</p>
      </header>

      <main className="pt-10">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">{copy.eyebrow}</p>
        <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">{copy.heading}</h1>
        <p className="mt-4 text-lg leading-relaxed text-foreground">{copy.definition}</p>

        <section className="mt-10">
          <h2 className="font-display text-xl font-semibold text-foreground">{copy.doesAndDoesNot.heading}</h2>
          <p className="mt-3 text-base leading-relaxed text-foreground">{copy.doesAndDoesNot.p1}</p>
          <p className="mt-3 text-base leading-relaxed text-foreground">{copy.doesAndDoesNot.p2}</p>
        </section>

        <section className="mt-12">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">{p1.label}</p>
          <h2 className="mt-1 font-display text-2xl font-semibold text-foreground">{p1.heading}</h2>
          <p className="mt-3 text-base leading-relaxed text-foreground">{p1.intro}</p>
          <div className="mt-6 space-y-5">
            <ListSection tone="always" title={p1.A.title} lead={p1.A.lead} items={p1.A.items} />
            <ListSection tone="tenYears" title={p1.B.title} lead={p1.B.lead} items={p1.B.items} tail={p1.B.tail} />
            <ListSection tone="doesNotCount" title={p1.C.title} lead={p1.C.lead} items={p1.C.items} />
          </div>
          <div className="mt-8 space-y-6">
            <TextSection title={p1.D.title} body={p1.D.body} />
            <TextSection title={p1.E.title} body={p1.E.body} />
            <TextSection title={p1.F.title} body={p1.F.body} />
            <TextSection title={p1.G.title} body={p1.G.body} />
          </div>
        </section>

        <section className="mt-12">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">{copy.partTwo.label}</p>
          <h2 className="mt-1 font-display text-2xl font-semibold text-foreground">{copy.partTwo.heading}</h2>
          <p className="mt-3 text-base leading-relaxed text-foreground">{copy.partTwo.body}</p>
        </section>

        <aside className="mt-10 rounded-xl border-2 border-foreground/70 bg-card p-5 sm:p-6" aria-labelledby="important-note">
          <h2 id="important-note" className="font-display text-xl font-semibold text-foreground">
            {copy.importantNote.heading}
          </h2>
          <p className="mt-3 text-base leading-relaxed text-foreground">{copy.importantNote.p1}</p>
          <p className="mt-3 text-base leading-relaxed text-foreground">{copy.importantNote.p2}</p>
        </aside>

        <label className="mt-10 flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-card p-5">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            autoComplete="off"
            className="mt-1 h-5 w-5 shrink-0 accent-[var(--color-primary)]"
          />
          <span className="text-base leading-relaxed text-foreground">{copy.acknowledgement}</span>
        </label>

        <button
          type="button"
          disabled={!acknowledged || busy}
          onClick={onContinue}
          className="mt-6 inline-flex min-h-11 w-full items-center justify-center rounded-md bg-primary px-6 text-base font-semibold text-primary-foreground transition-opacity disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
        >
          {copy.continueLabel}
        </button>
      </main>

      <footer className="mt-14 border-t border-border pt-6 text-sm text-muted-foreground">
        <p>{copy.footer[0]}</p>
        <p className="mt-1">{copy.footer[1]}</p>
      </footer>
    </div>
  );
}
