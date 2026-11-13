import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { AuthCard } from "@/components/AuthCard";
import { Field } from "@/components/Field";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/cpa/login")({
  head: () => ({
    meta: [
      { title: "CPA sign in — divieight" },
      { name: "description", content: "Sign in as the designated CPA of an LLC." },
      { property: "og:title", content: "CPA sign in — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: CpaLoginPage,
});

const schema = z.object({
  email: z.string().trim().email({ message: "Enter a valid email address" }).max(255),
  password: z.string().min(1, { message: "Enter your password" }).max(72),
});

/** The invite link signs the CPA in; they set a password here, and sign in with it afterwards. */
function CpaLoginPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [values, setValues] = useState({ email: "", password: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [newPassword, setNewPassword] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErrors({});
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) fieldErrors[issue.path[0] as string] = issue.message;
      setErrors(fieldErrors);
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.auth.signInWithPassword({ email: parsed.data.email, password: parsed.data.password });
    setSubmitting(false);
    if (error) toast.error(error.message);
    else router.history.push("/cpa");
  }

  async function setPassword(e: FormEvent) {
    e.preventDefault();
    if (newPassword.length < 8) {
      toast.error("Use at least 8 characters");
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword, data: { password_set: true } });
    setSubmitting(false);
    if (error) toast.error(error.message);
    else {
      toast.success("Password saved");
      router.history.push("/cpa");
    }
  }

  if (user) {
    return (
      <AuthCard eyebrow="CPA" title="Welcome" description="You are signed in. Set a password so you can sign in again later, or go straight to the books.">
        <form onSubmit={setPassword} className="space-y-4" noValidate>
          <Field label="New password" type="password" name="new-password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          <button type="submit" disabled={submitting} className="inline-flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-70">
            Save password and continue
          </button>
        </form>
        <button type="button" onClick={() => router.history.push("/cpa")} className="mt-3 w-full text-sm font-medium text-muted-foreground hover:text-foreground">
          Continue without changing it
        </button>
      </AuthCard>
    );
  }

  return (
    <AuthCard eyebrow="CPA" title="CPA sign in" description="For the CPA designated by an LLC's Manager. Open the invitation email first if this is your first visit.">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Email" type="email" name="email" autoComplete="email" value={values.email} onChange={(e) => setValues((v) => ({ ...v, email: e.target.value }))} error={errors.email} required />
        <Field label="Password" type="password" name="password" autoComplete="current-password" value={values.password} onChange={(e) => setValues((v) => ({ ...v, password: e.target.value }))} error={errors.password} required />
        <button type="submit" disabled={submitting} className="inline-flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-70">
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </AuthCard>
  );
}
