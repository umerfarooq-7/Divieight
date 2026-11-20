import { TermsNotice } from "@/components/TermsNotice";
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { signInWithGoogle } from "@/lib/google-auth";
import { resolveSignIn } from "@/lib/account-routing";


import { logAudit } from "@/lib/audit";
import { mapSignupError, isExistingUserSignup } from "@/lib/signup-errors";
import { AuthCard, GoogleButton, Divider } from "@/components/AuthCard";
import { Field } from "@/components/Field";

export const Route = createFileRoute("/buyer/register")({
  head: () => ({
    meta: [
      { title: "Create a buyer account — divieight" },
      {
        name: "description",
        content:
          "Register as a divieight buyer to browse vetted homes and reserve a 1/8th ownership share.",
      },
      { property: "og:title", content: "Create a buyer account — divieight" },
      {
        property: "og:description",
        content: "Register as a divieight buyer and reserve your 1/8th share.",
      },
    ],
  }),
  component: BuyerRegisterPage,
});

const phoneRegex = /^[+()\-\s\d]{7,20}$/;

const schema = z.object({
  fullName: z
    .string()
    .trim()
    .min(2, { message: "Enter your full name" })
    .max(100, { message: "Name must be under 100 characters" }),
  email: z.string().trim().email({ message: "Enter a valid email address" }).max(255),
  phone: z
    .string()
    .trim()
    .min(7, { message: "Enter a valid phone number" })
    .regex(phoneRegex, { message: "Enter a valid phone number" }),
  password: z.string().min(8, { message: "Password must be at least 8 characters" }).max(72),
});

function BuyerRegisterPage() {
  const navigate = useNavigate();
  const [values, setValues] = useState({ fullName: "", email: "", phone: "", password: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const set = (k: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setValues((v) => ({ ...v, [k]: e.target.value }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErrors({});
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        fieldErrors[issue.path[0] as string] = issue.message;
      }
      setErrors(fieldErrors);
      return;
    }

    setSubmitting(true);
    const { data, error } = await supabase.auth.signUp({
      email: parsed.data.email,
      password: parsed.data.password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        // `account_type: buyer` routes the signup trigger to buyer_accounts
        // (and skips seller creation) at the database level.
        data: {
          account_type: "buyer",
          phone: parsed.data.phone,
          full_name: parsed.data.fullName,
        },
      },
    });
    setSubmitting(false);

    if (error) {
      console.error("Buyer signUp failed", error);
      const mapped = mapSignupError(error);
      if (mapped.field === "form") {
        toast.error(mapped.message);
      } else {
        setErrors({ [mapped.field]: mapped.message });
        toast.error(mapped.message);
      }
      return;
    }

    // Supabase may return a masked success when the email is already taken.
    if (isExistingUserSignup(data.user)) {
      const msg = "An account with this email already exists. Try logging in instead.";
      setErrors({ email: msg });
      toast.error(msg);
      return;
    }

    if (!data.session) {
      toast.success("Check your email to confirm your buyer account.");
      navigate({ to: "/buyer/login" });
      return;
    }

    if (data.user) {
      await logAudit({
        actorId: data.user.id,
        actionType: "buyer.registered",
        entityType: "buyer_account",
        entityId: data.user.id,
        metadata: { method: "email" },
      });
    }

    const outcome = data.user ? await resolveSignIn(data.user, "buyer") : { to: "/buyer/onboarding" };
    if (outcome.error) {
      toast.error(outcome.error);
      navigate({ to: "/buyer/login" });
      return;
    }
    toast.success("Buyer account created");
    navigate({ to: outcome.to! });

  }

  async function onGoogle() {
    const { error } = await signInWithGoogle("buyer");
    if (error) toast.error(error);
  }


  return (
    <AuthCard
      eyebrow="Buyer Account"
      title="Create your buyer account"
      description="Browse vetted homes and reserve a 1/8th ownership share."
      footer={
        <>
          Already registered?{" "}
          <Link to="/buyer/login" className="font-medium text-foreground hover:text-accent">
            Sign in as a buyer
          </Link>
          <br />
          <span className="text-xs">
            Selling a property instead?{" "}
            <Link to="/register" className="font-medium text-foreground hover:text-accent">
              Create a seller account
            </Link>
          </span>
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
          placeholder="Jordan Ellis"
          value={values.fullName}
          onChange={set("fullName")}
          error={errors.fullName}
          hint="This becomes the primary member on your Buyer Account."
          required
        />
        <Field
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={values.email}
          onChange={set("email")}
          error={errors.email}
          required
        />
        {errors.email?.includes("already exists") ? (
          <p className="-mt-2 text-xs text-muted-foreground">
            <Link to="/buyer/login" className="font-medium text-foreground hover:text-accent">
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
          {submitting ? "Creating account…" : "Create buyer account"}
        </button>

        <p className="text-center text-xs text-muted-foreground">
          A Buyer Account supports up to two people. You can add a second member during
          onboarding.
        </p>
        <TermsNotice />
      </form>
    </AuthCard>
  );
}
