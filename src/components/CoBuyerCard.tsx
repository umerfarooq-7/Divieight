import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { UsersRound } from "lucide-react";
import { toast } from "sonner";
import { getCoBuyerSelf, getMyCoBuyer, inviteCoBuyerFn, removeCoBuyerFn, resendCoBuyerInviteFn } from "@/lib/co-buyer-members.functions";

/**
 * The account holder's co-buyer: invite by name and email, see whether they joined and how far they are, resend or remove.
 * The co-buyer has a login of their own with a limited portal; the account, the money and the agent stay here.
 */
export function CoBuyerCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["my-co-buyer"], queryFn: () => getMyCoBuyer(), retry: false });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  // A co-buyer's own login has no business on the account holder's dashboard: it goes to their portal.
  const navigate = useNavigate();
  const self = useQuery({ queryKey: ["co-buyer-self-check"], queryFn: () => getCoBuyerSelf(), retry: false });
  useEffect(() => {
    if (self.data) navigate({ to: "/buyer/co/dashboard", replace: true });
  }, [self.data, navigate]);

  // A co-buyer's own login (or a loading/failed lookup) shows nothing here.
  if (q.isLoading || q.isError || self.isLoading || self.data) return null;
  const cb = q.data ?? null;

  async function run(action: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await action();
      toast.success(ok);
      await qc.invalidateQueries({ queryKey: ["my-co-buyer"] });
      await qc.invalidateQueries({ queryKey: ["reservation-eligibility"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="co-buyer-heading" className="mt-8 rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 id="co-buyer-heading" className="flex items-center gap-2 font-display text-lg font-semibold text-foreground">
        <UsersRound className="h-5 w-5 text-accent" aria-hidden /> Co-buyer
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Buy a share together with someone. They get their own login and see only their own steps and the shares you choose to buy with them. You keep the account, the money and the agent.
      </p>

      {!cb ? (
        <form
          className="mt-4 grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await inviteCoBuyerFn({ data: { name, email } });
              if (!r.emailed) toast.message("Invitation saved", { description: "The email couldn't be sent yet. Use Resend invitation to try again." });
              setName("");
              setEmail("");
            }, "Invitation sent");
          }}
        >
          <label className="text-sm">
            Their full name
            <input className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="text-sm">
            Their email
            <input type="email" className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <div className="sm:col-span-2">
            <button type="submit" disabled={busy} className="inline-flex h-10 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground disabled:opacity-60">
              {busy ? "Sending…" : "Invite co-buyer"}
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-4 space-y-3 text-sm">
          <p>
            <span className="font-medium text-foreground">{cb.name}</span>
            {cb.email ? <span className="text-muted-foreground"> · {cb.email}</span> : null}
          </p>
          <p className="text-muted-foreground">
            {cb.state === "invited"
              ? "Invited. Waiting for them to create their login."
              : `Joined. ${cb.progress.done} of ${cb.progress.total} steps done.`}
          </p>
          {cb.shares.length > 0 ? (
            <ul className="list-disc pl-5 text-muted-foreground">
              {cb.shares.map((s) => (
                <li key={s.reservationId}>Bought together: {s.address}</li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap gap-3">
            {cb.state === "invited" ? (
              <button type="button" disabled={busy} className="rounded-md border border-border px-4 py-2 font-medium hover:bg-secondary disabled:opacity-60" onClick={() => void run(() => resendCoBuyerInviteFn(), "Invitation sent again")}>
                Resend invitation
              </button>
            ) : null}
            <button
              type="button"
              disabled={busy}
              className="rounded-md border border-border px-4 py-2 font-medium text-destructive hover:bg-secondary disabled:opacity-60"
              onClick={() => {
                if (window.confirm(`Remove ${cb.name} as your co-buyer?`)) void run(() => removeCoBuyerFn(), "Co-buyer removed");
              }}
            >
              Remove co-buyer
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
