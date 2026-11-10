import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ActingMemberGate } from "@/components/ActingMemberGate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { AUTHORITY_SCOPES, AUTHORITY_SCOPE_LABELS, NEVER_DELEGATED, authorityGrantText, type AuthorityScope } from "@/lib/member-authority";
import { getMyAuthority, grantAuthorityFn, revokeAuthorityFn } from "@/lib/member-authority.functions";

export const Route = createFileRoute("/buyer/authority")({
  head: () => ({ meta: [{ title: "Delegate authority — divieight" }, { name: "description", content: "Let another Account Member act for you on a short list of documents." }] }),
  component: AuthorityScreen,
});

function AuthorityScreen() {
  return (
    <ActingMemberGate step="Delegate authority">
      {({ member }) => <AuthorityForMember key={member.id} actingMemberId={member.id} memberName={member.fullName ?? ""} />}
    </ActingMemberGate>
  );
}

type View = Awaited<ReturnType<typeof getMyAuthority>>;

function AuthorityForMember({ actingMemberId, memberName }: { actingMemberId: string; memberName: string }) {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const load = useServerFn(getMyAuthority);
  const grant = useServerFn(grantAuthorityFn);
  const revoke = useServerFn(revokeAuthorityFn);
  const [view, setView] = useState<View | null>(null);
  const [grantee, setGrantee] = useState("");
  const [scope, setScope] = useState<AuthorityScope[]>([]);
  const [typedName, setTypedName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const v = await load({ data: { actingMemberId } });
      setView(v);
      setGrantee((g) => g || v.otherMembers[0]?.id || "");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load authority.");
    }
  }, [load, actingMemberId]);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate({ to: "/buyer/login", replace: true });
      return;
    }
    void refresh();
  }, [user, loading, navigate, refresh]);

  async function onGrant() {
    setError(null);
    setBusy(true);
    try {
      const r = await grant({ data: { actingMemberId, granteeMemberId: grantee, scope, typedName } });
      toast.success(r.granteeEmailed ? "Authority signed. They have been emailed." : "Authority signed.");
      setScope([]);
      setTypedName("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't sign the authority.");
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(grantId: string) {
    if (!window.confirm("Revoke this authority? Nothing new can be signed under it. What was signed before stays on record.")) return;
    try {
      await revoke({ data: { actingMemberId, grantId } });
      toast.success("Authority revoked.");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't revoke.");
    }
  }

  const granteeName = view?.otherMembers.find((o) => o.id === grantee)?.name ?? "";
  const live = (view?.grants ?? []).filter((g) => !g.revoked_at);
  const ended = (view?.grants ?? []).filter((g) => g.revoked_at);

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Documented authority</p>
      <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-foreground">Delegate authority</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        Let the other Account Member act for you on a short list of documents. You sign it as yourself, they are emailed, and you are emailed every time they use it. You can revoke it at any time.
      </p>

      <aside className="mt-5 rounded-xl border border-border bg-muted/40 p-4 text-sm text-foreground">
        Authority never covers: {NEVER_DELEGATED.map((n) => n.label).join("; ")}. Each of these has to be done by the member themselves.
      </aside>

      {!view ? (
        <p className="mt-8 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          {live.length > 0 ? (
            <section className="mt-8">
              <h2 className="font-display text-lg font-semibold text-foreground">Live authority</h2>
              <ul className="mt-3 space-y-3">
                {live.map((g) => (
                  <li key={g.id} className="rounded-xl border border-border bg-card p-4 text-sm">
                    <p className="font-medium text-foreground">{g.gaveIt ? `You → ${g.granteeName}` : `${g.grantorName} → you`}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {g.scope.map((s) => AUTHORITY_SCOPE_LABELS[s]).join("; ")} · signed {new Date(g.granted_at).toLocaleString()}
                    </p>
                    {g.gaveIt ? (
                      <Button variant="outline" size="sm" className="mt-3" onClick={() => void onRevoke(g.id)}>
                        Revoke
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {view.otherMembers.length === 0 ? (
            <p className="mt-8 rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">There is no other Account Member on this account to give authority to.</p>
          ) : live.some((g) => g.gaveIt && g.grantee_member_id === grantee) ? (
            <p className="mt-8 rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">You already have live authority with {granteeName}. Revoke it first to change what it covers.</p>
          ) : (
            <section className="mt-8 space-y-4 rounded-xl border border-border bg-card p-6">
              <h2 className="font-display text-lg font-semibold text-foreground">Give authority</h2>
              <div className="space-y-1.5">
                <Label htmlFor="grantee">To</Label>
                <select id="grantee" value={grantee} onChange={(e) => setGrantee(e.target.value)} className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm">
                  {view.otherMembers.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-foreground">What it covers</legend>
                {AUTHORITY_SCOPES.map((s) => (
                  <label key={s} className="flex items-start gap-2 text-sm text-foreground">
                    <input type="checkbox" className="mt-1" checked={scope.includes(s)} onChange={(e) => setScope((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))} />
                    {AUTHORITY_SCOPE_LABELS[s]}
                  </label>
                ))}
              </fieldset>
              {scope.length > 0 && granteeName ? (
                <pre className="whitespace-pre-wrap rounded-lg border border-border bg-background p-3 text-xs text-foreground">{authorityGrantText(memberName, granteeName, scope)}</pre>
              ) : null}
              <div className="space-y-1.5">
                <Label htmlFor="grantor-sign">Type your full legal name to sign</Label>
                <Input id="grantor-sign" value={typedName} onChange={(e) => setTypedName(e.target.value)} autoComplete="off" placeholder={memberName} />
              </div>
              {error ? (
                <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-foreground">
                  {error}
                </p>
              ) : null}
              <Button onClick={() => void onGrant()} disabled={busy || !grantee || scope.length === 0 || !typedName.trim()}>
                {busy ? "Signing…" : "Sign and give authority"}
              </Button>
            </section>
          )}

          {ended.length > 0 ? (
            <section className="mt-8">
              <h2 className="font-display text-lg font-semibold text-foreground">Revoked</h2>
              <ul className="mt-3 space-y-2 text-xs text-muted-foreground">
                {ended.map((g) => (
                  <li key={g.id}>
                    {g.gaveIt ? `You → ${g.granteeName}` : `${g.grantorName} → you`} · {g.scope.map((s) => AUTHORITY_SCOPE_LABELS[s]).join("; ")} · revoked {new Date(g.revoked_at!).toLocaleString()}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}

      <Button asChild variant="outline" className="mt-8">
        <Link to="/buyer/dashboard">Back to dashboard</Link>
      </Button>
    </div>
  );
}
