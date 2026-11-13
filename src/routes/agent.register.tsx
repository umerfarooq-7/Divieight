import { TermsNotice } from "@/components/TermsNotice";
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { mapSignupError, isExistingUserSignup } from "@/lib/signup-errors";
import { signInWithGoogle } from "@/lib/google-auth";
import { AuthCard, GoogleButton, Divider } from "@/components/AuthCard";
import { Field } from "@/components/Field";
import { agentRedirect, createAgentProfile, saveAgentDraft } from "@/lib/agent";

export const Route = createFileRoute("/agent/register")({
  head: () => ({
    meta: [
      { title: "Agent registration — divieight Professional Portal" },
      {
        name: "description",
        content:
          "Register as a licensed agent on divieight and join the Professional Portal for 1/8th share transactions.",
      },
      { property: "og:title", content: "Agent registration — divieight" },
      {
        property: "og:description",
        content: "Licensed agents and brokers can register for the divieight Professional Portal.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AgentRegisterPage,
});

const phoneRegex = /^[+()\-\s\d]{7,20}$/;

const schema = z.object({
  fullName: z.string().trim().min(2, { message: "Enter your full name" }).max(120),
  email: z.string().trim().email({ message: "Enter a valid email address" }).max(255),
  phone: z.string().trim().regex(phoneRegex, { message: "Enter a valid phone number" }),
  licenseNumber: z.string().trim().min(3, { message: "Enter your license number" }).max(60),
  licenseState: z.string().trim().min(2, { message: "Enter your license state" }).max(60),
  markets: z
    .array(z.string().trim().min(2).max(120))
    .min(1, { message: "Add at least one market you're licensed and active in" }),
  password: z.string().min(8, { message: "Password must be at least 8 characters" }).max(72),
});

function AgentRegisterPage() {
  const navigate = useNavigate();
  const [values, setValues] = useState({
    fullName: "",
    email: "",
    phone: "",
    licenseNumber: "",
    licenseState: "",
    markets: [] as string[],
    password: "",
  });
  const [marketDraft, setMarketDraft] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const set = (k: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setValues((v) => ({ ...v, [k]: e.target.value }));

  function addMarket() {
    const entry = marketDraft.trim();
    if (!entry) return;
    setValues((v) =>
      v.markets.some((m) => m.toLowerCase() === entry.toLowerCase())
        ? v
        : { ...v, markets: [...v.markets, entry] },
    );
    setMarketDraft("");
  }

  function removeMarket(market: string) {
    setValues((v) => ({ ...v, markets: v.markets.filter((m) => m !== market) }));
  }

  function validate() {
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        fieldErrors[issue.path[0] as string] = issue.message;
      }
      setErrors(fieldErrors);
      return null;
    }
    setErrors({});
    return parsed.data;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const data = validate();
    if (!data) return;

    setSubmitting(true);
    const { data: signUp, error } = await supabase.auth.signUp({
      email: data.email,
      password: data.password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        data: {
          account_type: "agent",
          full_name: data.fullName,
          phone: data.phone,
          // Email confirmation often opens in a new tab/browser where the
          // sessionStorage draft is gone, so carry the profile in metadata.
          agent_profile: true,
          license_number: data.licenseNumber,
          license_state: data.licenseState,
          markets: data.markets,
        },
      },
    });
    setSubmitting(false);

    if (error) {
      const mapped = mapSignupError(error);
      if (mapped.field === "form") toast.error(mapped.message);
      else {
        setErrors({ [mapped.field]: mapped.message });
        toast.error(mapped.message);
      }
      return;
    }

    if (isExistingUserSignup(signUp.user)) {
      const msg = "An account with this email already exists. Try logging in instead.";
      setErrors({ email: msg });
      toast.error(msg);
      return;
    }

    saveAgentDraft({
      fullName: data.fullName,
      phone: data.phone,
      licenseNumber: data.licenseNumber,
      licenseState: data.licenseState,
      markets: data.markets,
    });

    if (!signUp.session || !signUp.user) {
      toast.success("Check your email to confirm your account.");
      navigate({ to: "/agent/login" });
      return;
    }

    const created = await createAgentProfile({
      userId: signUp.user.id,
      fullName: data.fullName,
      email: data.email,
      phone: data.phone,
      licenseNumber: data.licenseNumber,
      licenseState: data.licenseState,
      markets: data.markets,
    });

    if (created.error) {
      toast.error(created.error);
      return;
    }

    toast.success("Professional account created");
    navigate({ to: agentRedirect(created.agent?.onboarding_status ?? "arello_pending") });
  }

  async function onGoogle() {
    const data = validate();
    if (!data) {
      toast.error("Complete your license details before continuing with Google.");
      return;
    }
    saveAgentDraft({
      fullName: data.fullName,
      phone: data.phone,
      licenseNumber: data.licenseNumber,
      licenseState: data.licenseState,
      markets: data.markets,
    });
    const { error } = await signInWithGoogle("agent");
    if (error) toast.error(error);
  }

  return (
    <AuthCard
      eyebrow="Professional Portal"
      title="Agent registration"
      description="For licensed real estate professionals representing buyers or sellers in 1/8th share transactions."
      footer={
        <>
          Already registered?{" "}
          <Link to="/agent/login" className="font-medium text-foreground hover:text-accent">
            Sign in
          </Link>
        </>
      }
    >
      <GoogleButton onClick={onGoogle} disabled={submitting} label="Sign up with Google" />
      <Divider />

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field
          label="Full name"
          name="fullName"
          autoComplete="name"
          placeholder="Jordan Reyes"
          value={values.fullName}
          onChange={set("fullName")}
          error={errors.fullName}
          required
        />
        <Field
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          placeholder="you@brokerage.com"
          value={values.email}
          onChange={set("email")}
          error={errors.email}
          required
        />
        {errors.email?.includes("already exists") ? (
          <p className="-mt-2 text-xs text-muted-foreground">
            <Link to="/agent/login" className="font-medium text-foreground hover:text-accent">
              Go to sign in
            </Link>
          </p>
        ) : null}
        <Field
          label="Phone number"
          type="tel"
          name="phone"
          autoComplete="tel"
          placeholder="+1 555 123 4567"
          value={values.phone}
          onChange={set("phone")}
          error={errors.phone}
          required
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="License number"
            name="licenseNumber"
            placeholder="0123456"
            value={values.licenseNumber}
            onChange={set("licenseNumber")}
            error={errors.licenseNumber}
            required
          />
          <Field
            label="License state"
            name="licenseState"
            placeholder="Florida"
            value={values.licenseState}
            onChange={set("licenseState")}
            error={errors.licenseState}
            required
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="marketDraft" className="text-sm font-medium text-foreground">
            Markets you're licensed and active in
          </label>
          <div className="flex gap-2">
            <input
              id="marketDraft"
              name="marketDraft"
              value={marketDraft}
              onChange={(e) => setMarketDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addMarket();
                }
              }}
              placeholder="Naples, FL"
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              type="button"
              onClick={addMarket}
              className="h-11 shrink-0 rounded-md border border-border px-4 text-sm font-medium text-foreground hover:bg-secondary"
            >
              Add
            </button>
          </div>
          {values.markets.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {values.markets.map((m) => (
                <span
                  key={m}
                  className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary/50 px-3 py-1 text-xs text-foreground"
                >
                  {m}
                  <button
                    type="button"
                    onClick={() => removeMarket(m)}
                    aria-label={`Remove ${m}`}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Add every market you cover. Whether you're Resident or Non-Resident is worked out per
            transaction from these markets — it isn't a fixed label on your profile.
          </p>
          {errors.markets ? <p className="text-xs text-destructive">{errors.markets}</p> : null}
        </div>

        <Field
          label="Password"
          type="password"
          name="password"
          autoComplete="new-password"
          placeholder="At least 8 characters"
          value={values.password}
          onChange={set("password")}
          error={errors.password}
          required
        />

        <button
          type="submit"
          disabled={submitting}
          className="inline-flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground shadow-[var(--shadow-elegant)] transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {submitting ? "Creating account…" : "Create professional account"}
        </button>

        <p className="text-center text-xs text-muted-foreground">
          Agents are compensated only through buyer-side commission paid at closing by their Broker
          of Record. divieight never pays agents directly.
        </p>
        <TermsNotice />
      </form>
    </AuthCard>
  );
}
