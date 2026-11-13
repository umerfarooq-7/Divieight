import { TermsNotice } from "@/components/TermsNotice";
import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { signInWithGoogle } from "@/lib/google-auth";
import { AuthCard, GoogleButton, Divider } from "@/components/AuthCard";
import { Field } from "@/components/Field";
import { isExistingUserSignup, mapSignupError } from "@/lib/signup-errors";
import { brokerRedirect, createBrokerProfile, getInvitation } from "@/lib/broker";

export const Route = createFileRoute("/broker/register")({
  validateSearch: (search: Record<string, unknown>) => ({
    invite: typeof search.invite === "string" ? search.invite : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Broker of Record registration — divieight" },
      {
        name: "description",
        content:
          "Register your brokerage as a divieight Broker of Record and complete credentialing.",
      },
      { property: "og:title", content: "Broker of Record registration — divieight" },
      {
        property: "og:description",
        content: "Onboard your brokerage to supervise divieight co-ownership transactions.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: BrokerRegisterPage,
});

const schema = z.object({
  brokerageName: z.string().trim().min(2, { message: "Enter your brokerage name" }).max(160),
  contactName: z.string().trim().min(2, { message: "Enter the contact name" }).max(120),
  email: z.string().trim().email({ message: "Enter a valid email address" }).max(255),
  phone: z.string().trim().min(7, { message: "Enter a valid phone number" }).max(32),
  password: z.string().min(8, { message: "Password must be at least 8 characters" }).max(72),
  licenseNumber: z.string().trim().min(3, { message: "Enter the broker license number" }).max(64),
  licenseState: z
    .string()
    .trim()
    .min(2, { message: "Enter the two-letter state" })
    .max(2, { message: "Use the two-letter state code" }),
});

function BrokerRegisterPage() {
  const navigate = useNavigate();
  const { invite } = useSearch({ from: "/broker/register" });
  const [invitedByAgentId, setInvitedByAgentId] = useState<string | null>(null);
  const [values, setValues] = useState({
    brokerageName: "",
    contactName: "",
    email: "",
    phone: "",
    password: "",
    licenseNumber: "",
    licenseState: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!invite) return;
    getInvitation(invite).then((row) => {
      if (!row || row.status !== "pending") return;
      setInvitedByAgentId(row.invited_by_agent_id);
      setValues((v) => ({
        ...v,
        email: v.email || row.invited_email,
        brokerageName: v.brokerageName || (row.invited_brokerage_name ?? ""),
        contactName: v.contactName || (row.invited_contact_name ?? ""),
      }));
    });
  }, [invite]);

  const set = (k: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setValues((v) => ({ ...v, [k]: e.target.value }));

  function validate() {
    const parsed = schema.safeParse({ ...values, licenseState: values.licenseState.toUpperCase() });
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) fieldErrors[issue.path[0] as string] = issue.message;
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
          account_type: "broker",
          full_name: data.contactName,
          contact_name: data.contactName,
          phone: data.phone,
          brokerage_name: data.brokerageName,
          license_number: data.licenseNumber,
          license_state: data.licenseState,
          invited_by_agent_id: invitedByAgentId,
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

    if (!signUp.session || !signUp.user) {
      toast.success("Check your email to confirm your brokerage account.");
      navigate({ to: "/broker/login" });
      return;
    }

    const created = await createBrokerProfile({
      userId: signUp.user.id,
      brokerageName: data.brokerageName,
      contactName: data.contactName,
      email: data.email,
      phone: data.phone,
      licenseNumber: data.licenseNumber,
      licenseState: data.licenseState,
      invitedByAgentId,
    });
    if (created.error) {
      toast.error(created.error);
      return;
    }

    toast.success("Broker of Record account created");
    navigate({ to: brokerRedirect(created.broker?.onboarding_status ?? "arello_pending") });
  }

  async function onGoogle() {
    const data = validate();
    if (!data) {
      toast.error("Complete your brokerage details before continuing with Google.");
      return;
    }
    const { error } = await signInWithGoogle("broker");
    if (error) toast.error(error);
  }

  return (
    <AuthCard
      eyebrow="Broker of Record"
      title="Register your brokerage"
      description="Brokers of Record supervise licensed agents and receive buyer-side commission at closing from sale proceeds. divieight never pays brokers directly."
      footer={
        <>
          Already registered?{" "}
          <Link to="/broker/login" className="font-medium text-foreground hover:text-accent">
            Sign in
          </Link>
        </>
      }
    >
      <GoogleButton onClick={onGoogle} disabled={submitting} label="Sign up with Google" />
      <Divider />

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field
          label="Brokerage name"
          name="brokerageName"
          value={values.brokerageName}
          onChange={set("brokerageName")}
          error={errors.brokerageName}
          required
        />
        <Field
          label="Contact name"
          name="contactName"
          value={values.contactName}
          onChange={set("contactName")}
          error={errors.contactName}
          required
        />
        <Field
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          value={values.email}
          onChange={set("email")}
          error={errors.email}
          required
        />
        <Field
          label="Phone"
          name="phone"
          autoComplete="tel"
          value={values.phone}
          onChange={set("phone")}
          error={errors.phone}
          required
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Broker license number"
            name="licenseNumber"
            value={values.licenseNumber}
            onChange={set("licenseNumber")}
            error={errors.licenseNumber}
            required
          />
          <Field
            label="License state"
            name="licenseState"
            placeholder="CA"
            maxLength={2}
            value={values.licenseState}
            onChange={set("licenseState")}
            error={errors.licenseState}
            required
          />
        </div>
        <Field
          label="Password"
          type="password"
          name="password"
          autoComplete="new-password"
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
          {submitting ? "Creating account…" : "Create broker account"}
        </button>
        <TermsNotice />
      </form>
    </AuthCard>
  );
}
