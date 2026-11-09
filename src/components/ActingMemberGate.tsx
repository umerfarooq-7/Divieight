import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { UserRound } from "lucide-react";
import { toast } from "sonner";
import { SecondaryVerification } from "@/components/SecondaryVerification";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { ACTING_MEMBER_IDLE_MS, memberDisplayName, type AccountMemberView } from "@/lib/account-members";
import { confirmActingMember, getMyAccountMembers } from "@/lib/account-members.functions";

/**
 * "Who is completing this step?" for member-level steps. One login can hold two
 * people, so each step says which of them is at the keyboard. The choice lasts for
 * this browser tab and clears after 15 minutes without activity.
 */

interface ActingContext {
  accountId: string;
  member: AccountMemberView;
  members: AccountMemberView[];
  switchPerson: () => void;
}

const Ctx = createContext<ActingContext | null>(null);
export const useActingMember = () => useContext(Ctx);

const storageKey = (accountId: string) => `divieight.acting-member.${accountId}`;

function readChoice(accountId: string): string | null {
  try {
    const raw = sessionStorage.getItem(storageKey(accountId));
    if (!raw) return null;
    const { memberId, at } = JSON.parse(raw) as { memberId: string; at: number };
    return Date.now() - at < ACTING_MEMBER_IDLE_MS ? memberId : null;
  } catch {
    return null;
  }
}

function writeChoice(accountId: string, memberId: string | null) {
  try {
    if (memberId) sessionStorage.setItem(storageKey(accountId), JSON.stringify({ memberId, at: Date.now() }));
    else sessionStorage.removeItem(storageKey(accountId));
  } catch {
    /* storage blocked: the choice lasts until the page reloads */
  }
}

/** For audit rows written from the browser while a member is acting. */
export function actingAuditMeta(memberId: string, ip: string | null = null) {
  return { acted_by_member_id: memberId, ip_address: ip, user_agent: typeof navigator === "undefined" ? null : navigator.userAgent };
}

export function ActingMemberGate({
  step,
  only,
  children,
}: {
  step: string;
  /** Limit who may act on this step, e.g. only the account holder. */
  only?: "primary";
  children: (ctx: ActingContext) => ReactNode;
}) {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const load = useServerFn(getMyAccountMembers);
  const confirm = useServerFn(confirmActingMember);
  const { data, isLoading, error } = useQuery({ queryKey: ["my-account-members", user?.id], enabled: !!user, retry: false, queryFn: () => load() });
  const [memberId, setMemberId] = useState<string | null>(null);
  const [picked, setPicked] = useState<string>("");
  const [verified, setVerified] = useState(false);
  const [method, setMethod] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/buyer/login", replace: true });
  }, [loading, user, navigate]);

  const allowed = useMemo(() => (data?.members ?? []).filter((m) => !only || m.role === only), [data, only]);
  const single = data?.members.length === 1;

  // A single-member account is always that member; otherwise remember the tab's choice.
  useEffect(() => {
    if (!data) return;
    const remembered = readChoice(data.accountId);
    const valid = remembered && allowed.some((m) => m.id === remembered) ? remembered : null;
    const next = single && allowed[0] ? allowed[0].id : valid;
    setMemberId(next);
    if (next) writeChoice(data.accountId, next);
    setPicked((p) => p || allowed[0]?.id || "");
  }, [data, allowed, single]);

  // Activity keeps the choice; 15 quiet minutes clear it.
  useEffect(() => {
    if (!data || !memberId || single) return;
    let last = Date.now();
    const touch = () => {
      if (Date.now() - last > 30_000) {
        last = Date.now();
        writeChoice(data.accountId, memberId);
      }
    };
    const events = ["pointerdown", "keydown", "scroll"] as const;
    events.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    const timer = window.setInterval(() => {
      if (!readChoice(data.accountId)) {
        setMemberId(null);
        toast.message("You were away for a while. Choose who is completing this step.");
      }
    }, 30_000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, touch));
      window.clearInterval(timer);
    };
  }, [data, memberId, single]);

  const switchPerson = useCallback(() => {
    if (!data) return;
    writeChoice(data.accountId, null);
    setMemberId(null);
    setVerified(false);
  }, [data]);

  if (loading || isLoading || !user) return <p className="py-16 text-center text-sm text-muted-foreground">Loading your buyer account…</p>;
  if (error) return <p className="py-16 text-center text-sm text-destructive">{(error as Error).message}</p>;
  if (!data) return null;

  const member = data.members.find((m) => m.id === memberId);
  if (member) {
    return (
      <Ctx.Provider value={{ accountId: data.accountId, member, members: data.members, switchPerson }}>
        <div className="mx-auto mt-4 flex max-w-4xl flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-secondary/40 px-4 py-2 text-sm">
          <span className="inline-flex items-center gap-2 text-foreground">
            <UserRound className="h-4 w-4 text-accent" aria-hidden />
            Acting as <span className="font-semibold">{memberDisplayName(member)}</span>
          </span>
          {!single ? (
            <button type="button" onClick={switchPerson} className="text-sm font-medium text-primary hover:underline">
              Switch person
            </button>
          ) : null}
        </div>
        {children({ accountId: data.accountId, member, members: data.members, switchPerson })}
      </Ctx.Provider>
    );
  }

  const choice = allowed.find((m) => m.id === picked) ?? allowed[0];
  const name = choice ? memberDisplayName(choice) : "";
  const needsInitials = Boolean(choice?.fullName.trim());
  const choose = async () => {
    if (!choice) return;
    setSaving(true);
    try {
      await confirm({ data: { memberId: choice.id, step } });
      writeChoice(data.accountId, choice.id);
      setMemberId(choice.id);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl px-4 py-12">
      <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">{step}</p>
        <h1 className="mt-2 font-display text-2xl font-semibold text-foreground">Who is completing this step?</h1>
        {allowed.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Only the account holder can complete this step.</p>
        ) : (
          <div className="mt-4 space-y-4">
            {allowed.length > 1 ? (
              <label className="block text-xs font-medium text-muted-foreground">
                Account Member
                <select
                  value={choice?.id ?? ""}
                  onChange={(e) => {
                    setPicked(e.target.value);
                    setVerified(false);
                  }}
                  className="mt-1 block h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground"
                >
                  {allowed.map((m) => (
                    <option key={m.id} value={m.id}>
                      {memberDisplayName(m)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {needsInitials ? <SecondaryVerification signerName={choice!.fullName} value={method} onChange={setMethod} onVerifiedChange={setVerified} disabled={saving} /> : null}
            <Button onClick={() => void choose()} disabled={saving || (needsInitials && !verified)}>
              {saving ? "Saving…" : `I am ${name}`}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
