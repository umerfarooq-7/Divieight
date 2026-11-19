import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, Clock, MailPlus, UsersRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/Field";
import { useAuth } from "@/hooks/use-auth";
import {
  acceptCoBuyerInviteFn,
  cancelCoBuyerInviteFn,
  declineCoBuyerInviteFn,
  getMyCoBuyer,
  inviteCoBuyerFn,
  removeCoBuyerFn,
  resendCoBuyerInviteFn,
} from "@/lib/co-buyer.functions";

const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/**
 * Buying with someone: invite them by email. They sign up with their own account, complete their own onboarding and payment, and get
 * their own Golden Ticket. This card shows the invitation, who the co-buyer is, and how far they are. Nothing private about them is shown.
 */
export function CoBuyerCard() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const load = useServerFn(getMyCoBuyer);
  const invite = useServerFn(inviteCoBuyerFn);
  const resend = useServerFn(resendCoBuyerInviteFn);
  const cancel = useServerFn(cancelCoBuyerInviteFn);
  const accept = useServerFn(acceptCoBuyerInviteFn);
  const decline = useServerFn(declineCoBuyerInviteFn);
  const remove = useServerFn(removeCoBuyerFn);
  const { data, isLoading, error } = useQuery({ queryKey: ["my-co-buyer", user?.id], enabled: !!user, retry: false, queryFn: () => load() });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: ["my-co-buyer"] });
  const fail = (e: Error) => toast.error(e.message);

  const sendInvite = useMutation({
    mutationFn: () => invite({ data: { name, email } }),
    onSuccess: (r) => {
      toast.success(r.emailed ? "Invitation sent." : "Invitation saved. Email isn't set up on this site, so tell them to sign up with that address.");
      setName("");
      setEmail("");
      void refresh();
    },
    onError: fail,
  });
  const resendInvite = useMutation({
    mutationFn: () => resend(),
    onSuccess: (r) => {
      toast.success(r.emailed ? "Invitation sent again." : "Invitation refreshed.");
      void refresh();
    },
    onError: fail,
  });
  const cancelInvite = useMutation({ mutationFn: () => cancel(), onSuccess: () => { toast.success("Invitation withdrawn."); void refresh(); }, onError: fail });
  const acceptInvite = useMutation({
    mutationFn: (linkId: string) => accept({ data: { linkId } }),
    onSuccess: (r) => {
      toast.success(`You are now ${r.inviterName}'s co-buyer.`);
      void refresh();
    },
    onError: fail,
  });
  const declineInvite = useMutation({ mutationFn: (linkId: string) => decline({ data: { linkId } }), onSuccess: () => { toast.success("Invitation declined."); void refresh(); }, onError: fail });
  const removeLink = useMutation({ mutationFn: () => remove(), onSuccess: () => { setConfirmRemove(false); toast.success("Co-buyer link ended."); void refresh(); }, onError: fail });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    sendInvite.mutate();
  };

  const link = data?.link ?? null;
  const incoming = data?.incoming ?? [];
  const busy = sendInvite.isPending || resendInvite.isPending || cancelInvite.isPending || acceptInvite.isPending || declineInvite.isPending || removeLink.isPending;

  return (
    <section>
      <h2 className="font-display text-lg font-semibold text-foreground">Co-buyer</h2>
      <div className="mt-4 space-y-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error || !data ? (
          <p className="text-sm text-muted-foreground">Your co-buyer details couldn't be loaded.</p>
        ) : (
          <>
            {incoming.map((i) => (
              <div key={i.id} role="status" className="rounded-xl border border-accent/40 bg-accent/10 p-4">
                <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <MailPlus className="h-4 w-4 text-accent" aria-hidden />
                  {i.inviterName} invited you to buy together
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Sent {when(i.invitedAt)}. You each keep your own account, onboarding, payment and Golden Ticket. When either of you reserves a share, you can choose to take it together.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" disabled={busy} onClick={() => acceptInvite.mutate(i.id)}>
                    Accept
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => declineInvite.mutate(i.id)}>
                    Decline
                  </Button>
                </div>
              </div>
            ))}

            {link?.status === "active" ? (
              <div className="rounded-xl border border-border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 truncate text-sm font-medium text-foreground">
                      <UsersRound className="h-4 w-4 text-accent" aria-hidden />
                      {link.partnerName}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {link.partnerEmail ? `${link.partnerEmail} · ` : ""}
                      Co-buyer since {link.acceptedAt ? when(link.acceptedAt) : when(link.invitedAt)}
                    </p>
                  </div>
                  <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-foreground">
                    {link.partnerProgress === "ready" ? (
                      <>
                        <CheckCircle2 className="h-3.5 w-3.5 text-primary" aria-hidden /> Ready to reserve
                      </>
                    ) : (
                      <>
                        <Clock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden /> Still onboarding
                      </>
                    )}
                  </span>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  When either of you reserves a share you will be asked whether you are taking it alone or with {link.partnerName}.
                </p>
                {confirmRemove ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    End the co-buyer link? Your own account is not affected.
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => removeLink.mutate()}>
                      Yes, end it
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
                      Keep
                    </Button>
                  </div>
                ) : (
                  <button type="button" onClick={() => setConfirmRemove(true)} className="mt-3 text-xs font-medium text-accent hover:underline">
                    End the co-buyer link
                  </button>
                )}
              </div>
            ) : link?.status === "invited" ? (
              <div className="rounded-xl border border-border bg-card p-4">
                <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Clock className="h-4 w-4 text-muted-foreground" aria-hidden />
                  Invitation sent to {link.partnerName}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {link.partnerEmail} · sent {when(link.invitedAt)}. They sign up with that address, complete their own onboarding and payment, and you are linked automatically.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => resendInvite.mutate()}>
                    Send again
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => cancelInvite.mutate()}>
                    Withdraw invitation
                  </Button>
                </div>
              </div>
            ) : incoming.length === 0 ? (
              <form onSubmit={onSubmit} className="rounded-xl border border-border bg-card p-4" noValidate>
                <p className="text-sm text-foreground">Buying with someone? Invite them as your co-buyer.</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  They create their own account with the email you enter, complete their own onboarding and pay their own fee. You each get your own Golden Ticket. When either of you reserves a share, you can choose to take it together.
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <Field label="Their full name" name="coBuyerName" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} required />
                  <Field label="Their email" type="email" name="coBuyerEmail" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </div>
                <Button type="submit" className="mt-4" disabled={busy || name.trim().length < 2 || !email.includes("@")}>
                  {sendInvite.isPending ? "Sending…" : "Send invitation"}
                </Button>
              </form>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
