import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { AuthCard, Divider, GoogleButton } from "@/components/AuthCard";
import { Field } from "@/components/Field";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { signInWithGoogle } from "@/lib/google-auth";
import { safeOwnerRedirect } from "@/lib/owner-sections";

export const Route = createFileRoute("/owner/login")({
  head: () => ({
    meta: [
      { title: "Owner sign in — divieight" },
      { name: "description", content: "Sign in to the homes you co-own through divieight." },
      { property: "og:title", content: "Owner sign in — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === "string" ? { redirect: search.redirect } : {},
  component: OwnerLoginPage,
});

const schema = z.object({
  email: z.string().trim().email({ message: "Enter a valid email address" }).max(255),
  password: z.string().min(1, { message: "Enter your password" }).max(72),
});

/**
 * Owners can be buyers or retained sellers, so this page takes either login and
 * doesn't route by role. Someone who owns nothing sees the empty /owner page.
 */
function OwnerLoginPage() {
  const { redirect } = Route.useSearch();
  const { user } = useAuth();
  const router = useRouter();
  const [values, setValues] = useState({ email: "", password: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const signedIn = !!user;
  useEffect(() => {
    if (signedIn) router.history.push(safeOwnerRedirect(redirect));
  }, [signedIn, redirect, router]);

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
    const { error } = await supabase.auth.signInWithPassword({ email: parsed.data.email, password: parsed.data.password });
    setSubmitting(false);
    if (error) toast.error(error.message);
  }

  async function onGoogle() {
    const { error } = await signInWithGoogle(null);
    if (error) toast.error(error);
  }

  return (
    <AuthCard
      eyebrow="Owner"
      title="Owner sign in"
      description="Use the same login you used to buy your share or list your home."
      footer={
        <span className="text-xs">
          Don't own a share yet?{" "}
          <Link to="/properties" className="font-medium text-foreground hover:text-accent">
            Browse properties
          </Link>
        </span>
      }
    >
      <GoogleButton onClick={onGoogle} disabled={submitting} />
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
        <Field
          label="Password"
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder="Your password"
          value={values.password}
          onChange={set("password")}
          error={errors.password}
          required
        />
        <div className="text-right">
          <Link to="/forgot-password" className="text-xs font-medium text-muted-foreground hover:text-foreground">
            Forgot password?
          </Link>
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground shadow-[var(--shadow-elegant)] transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </AuthCard>
  );
}
