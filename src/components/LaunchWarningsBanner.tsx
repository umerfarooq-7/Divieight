import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle } from "lucide-react";
import { getAdminLaunchWarnings } from "@/lib/launch-readiness.functions";

/** Admins only (the data comes from an admin-only call): what is wrong with this deployment. Nothing for anyone else. */
export function LaunchWarningsBanner({ enabled }: { enabled: boolean }) {
  const load = useServerFn(getAdminLaunchWarnings);
  const { data } = useQuery({ queryKey: ["admin-launch-warnings"], enabled, retry: false, queryFn: () => load() });
  if (!data || data.warnings.length === 0) return null;
  return (
    <div role="alert" className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
      <p className="flex items-center gap-2 font-semibold">
        <AlertTriangle className="h-4 w-4" aria-hidden /> Before launch
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {data.warnings.map((w) => (
          <li key={w.key}>{w.message}</li>
        ))}
      </ul>
    </div>
  );
}
