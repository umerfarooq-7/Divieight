import { useState } from "react";
import { fullExitSellerNotice, hybridSellerNotice } from "@/constants/eligibilityCheckCopy";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { OnboardingStepper, useIdentityDone } from "@/components/OnboardingStepper";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/onboarding/")({
  head: () => ({
    meta: [
      { title: "Seller onboarding — divieight" },
      { name: "description", content: "Choose how you'd like to sell your property on divieight." },
    ],
  }),
  component: IntentScreen,
});

type ExitType = "full_exit" | "hybrid_exit";

function IntentScreen() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const identityVerified = useIdentityDone();
  const [selected, setSelected] = useState<ExitType | null>(null);
  const [retained, setRetained] = useState<number>(1);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    if (!selected) return;
    if (!user) {
      toast.error("You need to be signed in.");
      navigate({ to: "/login" });
      return;
    }
    if (selected === "hybrid_exit" && (retained < 1 || retained > 7)) {
      toast.error("Retained shares must be between 1 and 7.");
      return;
    }

    setSubmitting(true);

    // Check if identity is already verified — if so, skip identity step
    const { data: sellerData } = await supabase
      .from("sellers")
      .select("full_name, address, date_of_birth, onboarding_status")
      .eq("id", user.id)
      .maybeSingle();

    const identityDone =
      !!sellerData?.full_name?.trim() &&
      !!sellerData?.address?.trim() &&
      !!sellerData?.date_of_birth;

    // Hybrid sellers retaining more than one share owe the platform
    // enrollment fee before continuing.
    const feeDue = selected === "hybrid_exit" && retained > 1;

    const nextStatus = feeDue
      ? "enrollment_fee_pending"
      : sellerData?.onboarding_status === "active"
        ? "active"
        : identityDone
          ? "property_verification_pending"
          : "identity_pending";

    const { error } = await supabase
      .from("sellers")
      .update({
        exit_type: selected,
        retained_shares: selected === "hybrid_exit" ? retained : null,
        onboarding_status: nextStatus,
      })
      .eq("id", user.id);
    setSubmitting(false);

    if (error) {
      toast.error(error.message);
      return;
    }
    navigate({
      to: feeDue
        ? "/onboarding/fee"
        : identityDone
          ? "/onboarding/property"
          : "/onboarding/identity",
    });
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
      <OnboardingStepper current={1} />

      <div className="mt-10 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
          Step 1 · Intent
        </p>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          Let's get your property listed
        </h1>
        <p className="mt-3 text-base text-muted-foreground">
          Choose how you'd like to sell. You can adjust details later.
        </p>
      </div>

      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        <IntentCard
          title="Full Exit"
          subtitle="I'm selling all 8/8ths of my property and exiting completely."
          badge="8 / 8"
          active={selected === "full_exit"}
          onClick={() => setSelected("full_exit")}
        />
        <IntentCard
          title="Hybrid Exit"
          subtitle="I want to sell some shares and keep 1–7 shares as a co-owner."
          badge="1–7 / 8"
          active={selected === "hybrid_exit"}
          onClick={() => setSelected("hybrid_exit")}
        />
      </div>

      {selected === "full_exit" ? <p className="mx-auto mt-6 max-w-md text-center text-sm text-muted-foreground">{fullExitSellerNotice}</p> : null}
      {selected === "hybrid_exit" ? <p className="mx-auto mt-6 max-w-md text-center text-sm text-muted-foreground">{hybridSellerNotice}</p> : null}

      {selected === "hybrid_exit" ? (
        <div className="mx-auto mt-8 max-w-md rounded-xl border border-border bg-card p-6 shadow-sm">
          <label htmlFor="retained" className="text-sm font-medium text-foreground">
            How many 1/8th shares do you want to retain?
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            Enter a number between 1 and 7.
          </p>
          <input
            id="retained"
            type="number"
            min={1}
            max={7}
            value={retained}
            onChange={(e) => setRetained(Number(e.target.value))}
            className="mt-3 flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
          />
        </div>
      ) : null}

      <div className="mt-10 flex justify-center">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!selected || submitting || loading}
          className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-8 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting
            ? "Saving..."
            : identityVerified
              ? "Continue to property"
              : "Continue to identity"}
        </button>
      </div>
    </div>
  );
}

function IntentCard({
  title,
  subtitle,
  badge,
  active,
  onClick,
}: {
  title: string;
  subtitle: string;
  badge: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative flex h-full flex-col rounded-xl border bg-card p-6 text-left shadow-sm transition-all hover:shadow-md",
        active
          ? "border-accent ring-2 ring-accent"
          : "border-border hover:border-foreground/20",
      )}
    >
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center rounded-full border border-accent/40 bg-accent/10 px-2.5 py-0.5 text-xs font-semibold text-accent">
          {badge}
        </span>
        <span
          className={cn(
            "flex h-5 w-5 items-center justify-center rounded-full border transition-colors",
            active ? "border-accent bg-accent" : "border-border",
          )}
          aria-hidden="true"
        >
          {active ? (
            <svg viewBox="0 0 12 12" className="h-3 w-3 text-accent-foreground">
              <path
                d="M2.5 6.5l2.5 2.5 4.5-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : null}
        </span>
      </div>
      <h3 className="mt-4 font-display text-xl font-semibold text-foreground">
        {title}
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>
    </button>
  );
}
