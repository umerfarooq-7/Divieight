import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, Circle, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { DocumentReader } from "@/components/DocumentReader";
import {
  getAgentReferralDocument,
  signReferralAgreement,
  type ReferralDocument,
} from "@/lib/nar-referral.functions";

export const Route = createFileRoute("/agent/documents/$id")({
  head: () => ({
    meta: [
      { title: "Sign referral agreement — divieight Professional Portal" },
      {
        name: "description",
        content:
          "Review and electronically sign your Standard NAR Referral Agreement on divieight.",
      },
      { property: "og:title", content: "Sign referral agreement — divieight" },
      {
        property: "og:description",
        content: "Platform-native signing for the Standard NAR Referral Agreement.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SignReferralAgreementPage,
});

const VERIFICATION_OPTIONS = [
  { value: "typed_initials", label: "Typed initials" },
  { value: "license_number", label: "License number on file" },
  { value: "email_on_file", label: "Email address on file" },
] as const;

function SignReferralAgreementPage() {
  const { id } = Route.useParams();
  const load = useServerFn(getAgentReferralDocument);
  const sign = useServerFn(signReferralAgreement);

  const [doc, setDoc] = useState<ReferralDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [scrolled, setScrolled] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [verification, setVerification] = useState<string>(VERIFICATION_OPTIONS[0].value);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    const d = await load({ data: { documentId: id } });
    setDoc(d);
    setLoading(false);
  }, [id, load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleSign() {
    if (saving) return;
    setSaving(true);
    let ip: string | null = null;
    try {
      const res = await fetch("https://api.ipify.org?format=json");
      if (res.ok) ip = (await res.json()).ip ?? null;
    } catch {
      ip = null;
    }
    const r = await sign({
      data: { documentId: id, typedName, verificationMethod: verification, ipAddress: ip },
    });
    setSaving(false);
    if (r.error) {
      toast.error(r.error);
      return;
    }
    setDoc(r.document ?? null);
    toast.success(
      r.document?.status === "executed"
        ? "Agreement fully executed."
        : "Signature recorded — awaiting the other party.",
    );
  }

  if (loading) {
    return <p className="px-6 py-16 text-center text-sm text-muted-foreground">Loading…</p>;
  }
  if (!doc) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <p className="text-sm text-muted-foreground">
          This agreement isn't available to your account.
        </p>
        <Link
          to="/agent/documents"
          className="mt-4 inline-block rounded-md border border-border bg-card px-4 py-2 text-sm font-medium"
        >
          Back to referral agreements
        </Link>
      </div>
    );
  }

  const outstanding = doc.parties.filter((p) => !p.signed);
  const executed = doc.status === "executed";

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
        Standard NAR Referral Agreement
      </p>
      <h1 className="font-display text-2xl font-semibold text-foreground sm:text-3xl">
        {executed ? "Fully executed" : "Signature required"}
      </h1>
      {!executed && outstanding.length > 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">
          Awaiting {outstanding.map((p) => p.name).join(" and ")}
          {outstanding.length === 1 ? "'s" : "'"} signature.
        </p>
      ) : null}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_18rem]">
        <div>
          <p className="mb-2 text-sm text-muted-foreground">
            You can read this agreement on its own first, search it and download a draft on the{" "}
            <Link to="/agent/document-review/$id" params={{ id }} className="font-medium text-primary underline">
              Pre-Signing Review
            </Link>{" "}
            screen. This is the signing screen: below is the exact text being signed.
          </p>
          <DocumentReader
            title="Standard NAR Referral Agreement"
            version={doc.version}
            text={doc.body}
            hash={doc.hash}
            hashLabel="Document hash (the hash stored with each signature)"
            crossRefs={{ terms: true, pra: false }}
            onReachedEnd={(v) => v && setScrolled(true)}
            heightClass="h-[28rem]"
          />
        </div>

        <aside className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
              Required parties
            </p>
            <ul className="mt-3 space-y-3">
              {doc.parties.map((p) => (
                <li key={p.agentId} className="flex items-start gap-2">
                  {p.signed ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  ) : (
                    <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium text-foreground">{p.name}</p>
                    <p className="break-words text-xs text-muted-foreground">
                      {p.role === "referring" ? "Referring agent (25%)" : "Receiving agent (75%)"} ·{" "}
                      {p.brokerage}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {p.signed
                        ? `Signed ${p.signedAt ? new Date(p.signedAt).toLocaleString() : ""}`
                        : "Awaiting signature"}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {doc.hash ? (
            <p className="break-all font-mono text-[11px] text-muted-foreground">{doc.hash}</p>
          ) : null}
        </aside>
      </div>

      {!executed && !doc.viewerSigned ? (
        <div className="mt-6 rounded-xl border border-border bg-card p-5">
          <p className="text-sm font-medium text-foreground">Type your name to sign</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Scroll the agreement to the end to enable signing. Your typed name must match your
            name on file.
          </p>
          <input
            value={typedName}
            onChange={(e) => setTypedName(e.target.value)}
            placeholder="Full legal name"
            className="mt-3 h-10 w-full max-w-sm rounded-md border border-border bg-background px-3 text-sm"
          />
          <label className="mt-3 block text-xs font-medium text-muted-foreground">
            Secondary verification
            <select
              value={verification}
              onChange={(e) => setVerification(e.target.value)}
              className="mt-1 block h-10 w-full max-w-sm rounded-md border border-border bg-background px-3 text-sm text-foreground"
            >
              {VERIFICATION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!scrolled || typedName.trim().length < 2 || saving}
            onClick={handleSign}
            className="mt-4 inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            <ShieldCheck className="h-4 w-4" />
            {saving ? "Signing…" : "Sign agreement"}
          </button>
        </div>
      ) : null}

      <Link
        to="/agent/documents"
        className="mt-6 inline-block rounded-md border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary"
      >
        Back to referral agreements
      </Link>
    </div>
  );
}
