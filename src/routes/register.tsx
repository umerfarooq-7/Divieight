import { TermsNotice } from "@/components/TermsNotice";
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { resolveSignIn } from "@/lib/account-routing";
import { signInWithGoogle } from "@/lib/google-auth";

import { logAudit } from "@/lib/audit";
import { mapSignupError, isExistingUserSignup } from "@/lib/signup-errors";
import { AuthCard, GoogleButton, Divider } from "@/components/AuthCard";
import { Field } from "@/components/Field";


export const Route = createFileRoute("/register")({
  head: () => ({
    meta: [
      { title: "Create an account — divieight" },
      { name: "description", content: "Create your divieight seller account." },
    ],
  }),
  component: RegisterPage,
});

const phoneRegex = /^[+()\-\s\d]{7,20}$/;

const schema = z.object({
  email: z.string().trim().email({ message: "Enter a valid email address" }).max(255),
  phone: z
    .string()
    .trim()
    .min(7, { message: "Enter a valid phone number" })
    .regex(phoneRegex, { message: "Enter a valid phone number" }),
  password: z.string().min(8, { message: "Password must be at least 8 characters" }).max(72),
});

function RegisterPage() {
  const navigate = useNavigate();
  const [values, setValues] = useState({ email: "", phone: "", password: "" });
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
        emailRedirectTo: `${window.location.origin}/dashboard`,
        data: { account_type: "seller", phone: parsed.data.phone },
      },
    });
    setSubmitting(false);

    if (error) {
      console.error("Seller signUp failed", error);
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

    // If email confirmation is required, session will be null.
    if (!data.session) {
      toast.success("Check your email to confirm your account.");
      navigate({ to: "/login" });
      return;
    }

    // Signed in immediately — new sellers start with onboarding.
    if (data.user) {
      await logAudit({
        actorId: data.user.id,
        actionType: "seller.registered",
        entityType: "seller",
        entityId: data.user.id,
        metadata: { method: "email" },
      });
    }
    const outcome = data.user
      ? await resolveSignIn(data.user, "seller")
      : { to: "/onboarding" as string, error: undefined };
    if (outcome.error) {
      toast.error(outcome.error);
      return;
    }
    toast.success("Account created");
    navigate({ to: outcome.to! });
  }

  async function onGoogle() {
    const { error } = await signInWithGoogle("seller");
    if (error) toast.error(error);
  }


  return (
    <AuthCard
      eyebrow="Seller Account"
      title="Create your account"
      description="Start listing your property in 1/8th shares."
      footer={
        <>
          Already have an account?{" "}
          <Link to="/login" className="font-medium text-foreground hover:text-accent">
            Sign in
          </Link>
        </>
      }
    >
      <GoogleButton onClick={onGoogle} disabled={submitting} label="Sign up with Google" />
      <Divider />

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
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
            <Link to="/login" className="font-medium text-foreground hover:text-accent">
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
          hint="We'll use this later to reach you about your listings."
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
          {submitting ? "Creating account…" : "Create seller account"}
        </button>

        <p className="text-center text-xs text-muted-foreground">
          By creating an account you agree to our terms and privacy policy.
        </p>
        <TermsNotice />
      </form>
    </AuthCard>
  );
}
