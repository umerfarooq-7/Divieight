import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/Field";
import { MAX_ACTIVE_MEMBERS, type AccountMemberView } from "@/lib/account-members";
import { addAccountMember, removeAccountMember, updateAccountMember } from "@/lib/account-members.functions";

/** Add, edit or remove the second member. The account holder only, before the lock. */
export function SecondMemberManager({ actingMemberId, members, locked, onDone }: { actingMemberId: string; members: AccountMemberView[]; locked: boolean; onDone?: () => void }) {
  const qc = useQueryClient();
  const add = useServerFn(addAccountMember);
  const update = useServerFn(updateAccountMember);
  const remove = useServerFn(removeAccountMember);
  const second = members.find((m) => m.role === "member");
  const [editing, setEditing] = useState(false);
  const [fullName, setFullName] = useState(second?.fullName ?? "");
  const [email, setEmail] = useState(second?.email ?? "");
  const [phone, setPhone] = useState(second?.phone ?? "");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["my-account-members"] });

  const save = useMutation({
    mutationFn: async () => {
      if (second) await update({ data: { actingMemberId, memberId: second.id, fullName, email, phone: phone || null } });
      else await add({ data: { actingMemberId, fullName, email, phone: phone || null } });
    },
    onSuccess: () => {
      toast.success(second ? "Second member updated." : "Second member added.");
      setEditing(false);
      refresh();
      onDone?.();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const removeMut = useMutation({
    mutationFn: () => remove({ data: { actingMemberId, memberId: second!.id } }),
    onSuccess: () => {
      toast.success("Second member removed. Their history is kept.");
      setConfirmRemove(false);
      setFullName("");
      setEmail("");
      setPhone("");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  if (locked) {
    return <p className="text-sm text-muted-foreground">Members can't be changed after the Golden Ticket is issued. Contact divieight support for any change.</p>;
  }

  const atLimit = members.length >= MAX_ACTIVE_MEMBERS;
  if (second && !editing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => setEditing(true)}>
          Edit second member
        </Button>
        {confirmRemove ? (
          <>
            <Button variant="destructive" disabled={removeMut.isPending} onClick={() => removeMut.mutate()}>
              {removeMut.isPending ? "Removing…" : `Yes, remove ${second.fullName || "them"}`}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={() => setConfirmRemove(true)}>
            Remove second member
          </Button>
        )}
      </div>
    );
  }
  if (!second && atLimit) return null;

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Their full legal name" name="second_full_name" value={fullName} maxLength={200} onChange={(e) => setFullName(e.target.value)} required />
      <Field label="Their email" name="second_email" type="email" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} required hint="Their own email, not yours. No invite or login is sent." />
      <Field label="Their phone (optional)" name="second_phone" type="tel" value={phone} maxLength={40} onChange={(e) => setPhone(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={save.isPending || !fullName.trim() || !email.trim()}>
          {save.isPending ? "Saving…" : second ? "Save changes" : "Add second member"}
        </Button>
        {second ? (
          <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
