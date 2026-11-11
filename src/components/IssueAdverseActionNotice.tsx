import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { issueAdverseActionNoticeFn } from "@/lib/adverse-action.functions";

/**
 * Admin action only: there is no trigger. Used when the Question 5 authorization was exercised and
 * divieight then acted on information in the consumer report. It issues the notice (the action, the
 * consumer reporting agency's name and contact details, and the member's rights). The report itself
 * is NOT supplied.
 */
export function IssueAdverseActionNotice({ memberId, onDone }: { memberId: string; onDone: () => void }) {
  const issue = useServerFn(issueAdverseActionNoticeFn);
  const [open, setOpen] = useState(false);
  const [statement, setStatement] = useState("");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [website, setWebsite] = useState("");
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const r = await issue({ data: { memberId, actionStatement: statement, agencyName: name, agencyAddress: address, agencyPhone: phone, agencyWebsite: website || null, reportObtainedAttested: attested } });
      toast.success(r.emailed ? "Notice issued and emailed. The report itself is not supplied." : "Notice issued. The report itself is not supplied.");
      setOpen(false);
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline">
        Issue adverse-action notice
      </button>
    );
  const field = "h-8 w-56 rounded-md border border-border bg-background px-2 text-xs";
  return (
    <span className="mt-2 flex w-full flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
      <span className="text-xs text-muted-foreground">Only when the Question 5 authorization was exercised and divieight acted on information in the report. The report is not supplied.</span>
      <input aria-label="Action taken" className={field + " w-full"} value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="The action taken (required)" />
      <span className="flex flex-wrap gap-2">
        <input aria-label="Agency name" className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Consumer reporting agency (required)" />
        <input aria-label="Agency address" className={field} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Agency address (required)" />
        <input aria-label="Agency phone" className={field} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Agency phone (required)" />
        <input aria-label="Agency website" className={field} value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="Agency website" />
      </span>
      <label className="flex items-start gap-2 text-xs text-foreground">
        <input type="checkbox" className="mt-0.5" checked={attested} onChange={(e) => setAttested(e.target.checked)} />A consumer report was obtained under the Question 5 authorization, and divieight is acting on information in it.
      </label>
      <span className="flex gap-3">
        <button type="button" disabled={busy || !attested || !statement.trim() || !name.trim() || !address.trim() || !phone.trim()} onClick={() => void submit()} className="text-xs font-medium text-primary disabled:opacity-50">
          Issue notice
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-muted-foreground">
          Cancel
        </button>
      </span>
    </span>
  );
}
