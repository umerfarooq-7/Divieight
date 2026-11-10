import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { getLivenessTestSwitch, setLivenessTestSwitchFn } from "@/lib/liveness.functions";

/**
 * QA only: forces the simulated liveness vendor's outcome for every check. A selfie file named
 * with "liveness-fail" / "liveness-inconclusive" / "liveness-pass" overrides it for that one check.
 * A real vendor ignores this switch.
 */
export function LivenessTestSwitch() {
  const qc = useQueryClient();
  const load = useServerFn(getLivenessTestSwitch);
  const save = useServerFn(setLivenessTestSwitchFn);
  const { data } = useQuery({ queryKey: ["liveness-test-switch"], retry: false, queryFn: () => load() });

  async function change(value: string) {
    try {
      await save({ data: { forced: value === "" ? null : value } });
      await qc.invalidateQueries({ queryKey: ["liveness-test-switch"] });
      toast.success(value ? `Simulated liveness now returns "${value}".` : "Simulated liveness back to normal (passes).");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change the switch.");
    }
  }

  return (
    <div className="mt-6 flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-border bg-muted/30 px-4 py-3 text-sm">
      <span className="font-medium text-foreground">Liveness simulator (QA)</span>
      <select
        aria-label="Simulated liveness outcome"
        value={data?.forced ?? ""}
        onChange={(e) => void change(e.target.value)}
        className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
      >
        <option value="">Normal (passes)</option>
        <option value="failed">Force failed</option>
        <option value="inconclusive">Force inconclusive</option>
        <option value="passed">Force passed</option>
      </select>
      <span className="text-xs text-muted-foreground">Or name the selfie file liveness-fail / liveness-inconclusive.</span>
    </div>
  );
}
