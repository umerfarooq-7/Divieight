import { useEffect, useState, type FormEvent } from "react";
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { z } from "zod";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { resolveSignIn } from "@/lib/account-routing";
import { mapSignupError, isExistingUserSignup } from "@/lib/signup-errors";
import { rememberInviteToken } from "@/lib/co-buyer-members";
import { previewCoBuyerInviteFn } from "@/lib/co-buyer-members.functions";
import { AuthCard } from "@/components/AuthCard";
import { Field } from "@/components/Field";

export const Route = createFileRoute("/buyer/co-buyer/join")({
  validateSearch: (search: Record<string, unknown>): { token?: string } => ({
    token: typeof search.token === "string" ? search.token : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Join as a co-buyer — divieight" },
      { name: "description", content: "Create your own login to buy a share together with the person who invited you." },
    ],
  }),
  component: CoBuyerJoinPage,
});

const schema = z.object({
  fullName: z.string().trim().min(2, { message: "Enter your full name" }).max(100),
  phone: z.string().trim().min(7, { message: "Enter a valid phone number" }).regex(/^[+()\-\s\d]{7,20}$/, { message: "Enter a valid phone number" }),
  password: z.string().min(8, { message: "Password must be at least 8 characters" }).max(72),
});

function CoBuyerJoinPage() {
  const navigate = useNavigate();
  const { token } = Route.useSearch();
  const [invite, setInvite] = useState<{ holderName: string; name: string; email: string } | null | undefined>(undefined);
  const [values, setValues] = useState({ fullName: "", phone: "", password: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) {
      setInvite(null);
      return;
    }
    let cancelled = false;
    previewCoBuyerInviteFn({ data: { token } })
      .then((r) => {
        if (cancelled) return;
        setInvite(r);
        if (r) setValues((v) => ({ ...v, fullName: r.name }));
      })
      .catch(() => !cancelled && setInvite(null));
    return () => {
      cancelled = true;
    };
  }, [token]);

  const set = (k: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [k]: e.target.value }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token || !invite) return;
    setErrors({});
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) fieldErrors[issue.path[0] as string] = issue.message;
      setErrors(fieldErrors);
      return;
    }
    setSubmitting(true);
    // Remembered before sign-up: the email-confirmation link may open in another tab, and the invitation is claimed on first sign-in.
    rememberInviteToken(token);
    const { data, error } = await supabase.auth.signUp({
      email: invite.email,
      password: parsed.data.password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        // Not a buyer: no buyer account is created for this login. It becomes a limited member of the inviter's account.
        data: { account_type: "co_buyer", phone: parsed.data.phone, full_name: parsed.data.fullName },
      },
    });
    setSubmitting(false);
    if (error) {
      const mapped = mapSignupError(error);
      toast.error(mapped.message);
      return;
    }
    if (isExistingUserSignup(data.user)) {
      toast.error("An account with this email already exists. Sign in instead.");
      return;
    }
    if (!data.session) {
      toast.success("Check your email to confirm, then sign in.");
      navigate({ to: "/buyer/login" });
      return;
    }
    const outcome = data.user ? await resolveSignIn(data.user, null) : { to: "/buyer/co/dashboard" };
    if (outcome.error) {
      toast.error(outcome.error);
      navigate({ to: "/buyer/login" });
      return;
    }
    toast.success("Your co-buyer login is ready");
    navigate({ to: outcome.to ?? "/buyer/co/dashboard" });
  }

  if (invite === undefined) {
    return <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted-foreground">Checking your invitation…</div>;
  }
  if (!invite) {
    return (
      <AuthCard eyebrow="Co-buyer" title="This invitation isn't valid" description="The link may have expired, been replaced by a newer one, or already been used.">
        <p className="text-sm text-muted-foreground">
          Ask the person who invited you to send a new invitation, or{" "}
          <Link to="/buyer/login" className="font-medium text-foreground hover:text-accent">
            sign in
          </Link>{" "}
          if you already created your login.
        </p>
      </AuthCard>
    );
  }
  return (
    <AuthCard
      eyebrow="Co-buyer"
      title="Create your co-buyer login"
      description={`${invite.holderName} invited you to buy a share together. You complete your own identity, W-9 and signatures; they keep the account.`}
      footer={
        <>
          Already created your login?{" "}
          <Link to="/buyer/login" className="font-medium text-foreground hover:text-accent">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Email" type="email" name="email" value={invite.email} readOnly hint="The invitation was sent to this address." />
        <Field label="Full name" name="fullName" autoComplete="name" value={values.fullName} onChange={set("fullName")} error={errors.fullName} required />
        <Field label="Phone number" type="tel" name="phone" autoComplete="tel" placeholder="+1 555 123 4567" value={values.phone} onChange={set("phone")} error={errors.phone} required />
        <Field label="Password" type="password" name="password" autoComplete="new-password" placeholder="At least 8 characters" value={values.password} onChange={set("password")} error={errors.password} required />
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground shadow-[var(--shadow-elegant)] disabled:cursor-not-allowed disabled:opacity-70"
        >
          {submitting ? "Creating login…" : "Create co-buyer login"}
        </button>
      </form>
    </AuthCard>
  );
}
