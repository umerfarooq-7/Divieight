import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { markDeclarationUntrueFn } from "@/lib/eligibility-engine.functions";

/** Part F: record that a member's declaration was found untrue. The engine sets the result; nothing is deleted. */
export function MarkDeclarationUntrue({ memberId, onDone }: { memberId: string; onDone: () => void }) {
  const mark = useServerFn(markDeclarationUntrueFn);
  const [open, setOpen] = useState(false);
  const [finding, setFinding] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!window.confirm("Record this declaration as untrue? Under the Standard this makes the member not eligible. It is audited and can't be undone here.")) return;
    setBusy(true);
    try {
      const r = await mark({ data: { memberId, finding } });
      toast.success(r.legalReviewFlagged ? "Recorded. The account has closed, so it is flagged for legal review." : "Recorded. The member is not eligible.");
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
        Mark declaration untrue
      </button>
    );
  return (
    <span className="flex flex-wrap items-center gap-2">
      <input aria-label="What was found untrue" value={finding} onChange={(e) => setFinding(e.target.value)} placeholder="What was found untrue (required)" className="h-8 w-64 rounded-md border border-border bg-background px-2 text-xs" />
      <button type="button" disabled={busy || !finding.trim()} onClick={() => void submit()} className="text-xs font-medium text-primary disabled:opacity-50">
        Record
      </button>
      <button type="button" onClick={() => setOpen(false)} className="text-xs text-muted-foreground">
        Cancel
      </button>
    </span>
  );
}
