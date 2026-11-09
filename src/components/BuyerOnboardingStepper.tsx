import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

const STEPS = ["Members", "Identity", "Lifestyle", "Payment", "Vetting", "Liquidity"] as const;

/** 0 is Members; the others keep their old numbers, so each page still passes the same value. */
export type BuyerOnboardingStep = 0 | 1 | 2 | 3 | 4 | 5;

export function BuyerOnboardingStepper({ current }: { current: BuyerOnboardingStep }) {
  return (
    <>
    <ol className="mx-auto flex w-full max-w-3xl items-center gap-1.5 sm:gap-2">
      {STEPS.map((label, i) => {
        const step = i as BuyerOnboardingStep;
        const isActive = step === current;
        const isDone = step < current;
        return (
          <li key={label} className="flex flex-1 items-center gap-1.5 sm:gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold transition-colors sm:h-8 sm:w-8 sm:text-xs",
                  isActive && "border-accent bg-accent text-accent-foreground",
                  isDone && "border-primary bg-primary text-primary-foreground",
                  !isActive && !isDone && "border-border bg-background text-muted-foreground",
                )}
              >
                {i + 1}
              </span>
              <span
                className={cn(
                  "hidden truncate text-xs font-medium uppercase tracking-wider md:inline",
                  isActive ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {label}
              </span>
            </div>
            {i < STEPS.length - 1 ? (
              <span className={cn("h-px flex-1", isDone ? "bg-primary" : "bg-border")} />
            ) : null}
          </li>
        );
      })}
    </ol>
    <p className="mx-auto mt-2 w-full max-w-3xl text-right text-xs">
      <Link to="/buyer/eligibility-standard" className="font-medium text-muted-foreground hover:text-foreground hover:underline">
        Participant Eligibility Standard
      </Link>
    </p>
    </>
  );
}
