import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { CheckCircle2, PenLine } from "lucide-react";
import {
  listMyOperatingAgreements,
  signMyOperatingAgreement,
  type BuyerOaView,
} from "@/lib/entity-genesis-stage2.functions";
import { deviceFingerprint } from "@/lib/due-diligence";
import { SecondaryVerification } from "@/components/SecondaryVerification";

export const Route = createFileRoute("/buyer/operating-agreement")({
  head: () => ({
    meta: [
      { title: "LLC Operating Agreement — divieight" },
      { name: "description", content: "Review and sign your property LLC's final Operating Agreement." },
      { property: "og:title", content: "LLC Operating Agreement — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: BuyerOperatingAgreement,
});

function BuyerOperatingAgreement() {
  const load = useServerFn(listMyOperatingAgreements);
  const { data, isLoading } = useQuery({ queryKey: ["buyer-oa"], queryFn: () => load() });
  const agreements = data?.agreements ?? [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="font-display text-2xl font-semibold text-foreground">LLC Operating Agreement</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Each property is held by its own Delaware LLC managed by divieight, LLC. Every Account Member signs; all Buyer
        Accounts sign in parallel, in no particular order.
      </p>
      <div className="mt-6 space-y-6">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : agreements.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            Your Operating Agreement opens for signature once your pod is Closing-Ready and the LLC is filed.
          </p>
        ) : (
          agreements.map((a) => <Agreement key={a.propertyId} a={a} />)
        )}
      </div>
    </div>
  );
}

function Agreement({ a }: { a: BuyerOaView }) {
  const qc = useQueryClient();
  const sign = useServerFn(signMyOperatingAgreement);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrolledEnd, setScrolledEnd] = useState(false);
  const pending = a.members.filter((m) => !m.signedAt);
  const [memberId, setMemberId] = useState(pending[0]?.id ?? "");
  const member = a.members.find((m) => m.id === memberId) ?? null;
  const [typed, setTyped] = useState("");
  const [method, setMethod] = useState("");
  const [verified, setVerified] = useState(false);

  // After a member signs, move on to the next unsigned member.
  useEffect(() => {
    if (!pending.some((m) => m.id === memberId) && pending[0]) setMemberId(pending[0].id);
  }, [pending, memberId]);

  // Short documents can fit without scrolling — treat them as read to the end.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollHeight - el.clientHeight <= 8) setScrolledEnd(true);
  }, [a.text]);

  const signMut = useMutation({
    mutationFn: () =>
      sign({
        data: {
          propertyId: a.propertyId,
          accountMemberId: memberId,
          signedName: typed,
          documentHash: a.documentHash!,
          secondaryVerificationMethod: method,
          deviceFingerprint: deviceFingerprint(),
        },
      }),
    onSuccess: (r) => {
      toast.success(r.executed ? "Signed — the agreement is now fully executed." : `Signed. ${r.outstanding} signature(s) still outstanding across the pod.`);
      setTyped("");
      void qc.invalidateQueries({ queryKey: ["buyer-oa"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="font-display text-lg font-semibold text-foreground">{a.llcName}</h2>
        <span className="rounded-full bg-secondary px-3 py-1 text-xs font-medium">
          {a.status === "executed" ? "Executed" : "Awaiting signatures"}
        </span>
      </div>

      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8) setScrolledEnd(true);
        }}
        className="mt-4 max-h-96 overflow-y-auto rounded-lg border border-border bg-background p-4"
      >
        <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground">{a.text}</pre>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">Document version {a.documentHash?.slice(0, 19)}…</p>

      <ul className="mt-4 space-y-1 text-sm">
        {a.members.map((m) => (
          <li key={m.id} className="flex items-center gap-2">
            {m.signedAt ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <PenLine className="h-4 w-4 text-muted-foreground" />}
            {m.name}
            <span className="text-xs text-muted-foreground">{m.signedAt ? `signed ${new Date(m.signedAt).toLocaleString()}` : "not signed yet"}</span>
          </li>
        ))}
      </ul>

      {a.status === "awaiting_signatures" && pending.length > 0 ? (
        <div className="mt-4 space-y-3 border-t border-border pt-4">
          {!scrolledEnd ? <p className="text-xs text-muted-foreground">Scroll to the end of the agreement to sign.</p> : null}
          {pending.length > 1 ? (
            <select value={memberId} onChange={(e) => setMemberId(e.target.value)} className="rounded-lg border border-border bg-background px-3 py-2 text-sm">
              {pending.map((m) => (
                <option key={m.id} value={m.id}>
                  Signing as {m.name}
                </option>
              ))}
            </select>
          ) : null}
          <label className="block text-xs text-muted-foreground">
            Type {member?.name ?? "your"} full legal name to sign
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={!scrolledEnd}
              className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </label>
          <SecondaryVerification
            signerName={member?.name ?? ""}
            value={method}
            onChange={setMethod}
            onVerifiedChange={setVerified}
            disabled={!scrolledEnd || signMut.isPending}
          />
          <p className="text-xs text-muted-foreground">
            Your typed name, the time, your IP address and this document's version hash form your electronic signature under
            the E-SIGN Act and applicable UETA statutes.
          </p>
          <button
            type="button"
            disabled={!scrolledEnd || !verified || !typed.trim() || signMut.isPending}
            onClick={() => signMut.mutate()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Sign Operating Agreement
          </button>
        </div>
      ) : null}
    </section>
  );
}
