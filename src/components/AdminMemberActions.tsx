import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { adminChangeAccountMember } from "@/lib/account-members.functions";

/** After the lock, member changes go through divieight, with a reason, and are audited. */
export function AdminMemberActions({ member, onChanged }: { member: { id: string; role: string; email: string | null }; onChanged: () => void }) {
  const change = useServerFn(adminChangeAccountMember);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(member.email ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (input: { email?: string; remove?: boolean }) => {
    setBusy(true);
    try {
      await change({ data: { memberId: member.id, reason, ...input } });
      toast.success(input.remove ? "Member removed. Their history is kept." : "Member updated.");
      setOpen(false);
      setReason("");
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs font-medium text-primary hover:underline">
        Change
      </button>
    );
  return (
    <span className="flex flex-wrap items-center gap-2">
      <input aria-label="Member email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" className="h-8 rounded-md border border-border bg-background px-2 text-xs" />
      <input aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" className="h-8 rounded-md border border-border bg-background px-2 text-xs" />
      <button type="button" disabled={busy || !reason.trim() || !email.trim()} onClick={() => void run({ email })} className="text-xs font-medium text-primary disabled:opacity-50">
        Save email
      </button>
      {member.role === "member" ? (
        <button type="button" disabled={busy || !reason.trim()} onClick={() => void run({ remove: true })} className="text-xs font-medium text-destructive disabled:opacity-50">
          Remove
        </button>
      ) : null}
      <button type="button" onClick={() => setOpen(false)} className="text-xs text-muted-foreground">
        Cancel
      </button>
    </span>
  );
}
