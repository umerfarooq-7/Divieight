import { useEffect } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Lock } from "lucide-react";
import { toast } from "sonner";
import { OwnerLoading, OwnerPageShell } from "@/components/owner/useOwnerProperty";
import { useAuth } from "@/hooks/use-auth";
import type { OwnerNotificationType } from "@/lib/owner-notifications";
import { getOwnerNotificationPreferences, setOwnerNotificationPreference } from "@/lib/owner-notifications.functions";

export const Route = createFileRoute("/owner/notifications")({
  head: () => ({
    meta: [
      { title: "Notification settings — divieight" },
      { name: "description", content: "Choose which owner notifications also reach you by email." },
      { property: "og:title", content: "Notification settings — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: OwnerNotificationSettings,
});

function OwnerNotificationSettings() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const load = useServerFn(getOwnerNotificationPreferences);
  const save = useServerFn(setOwnerNotificationPreference);
  const queryKey = ["owner-notification-preferences", user?.id];
  const { data, isLoading, error } = useQuery({ queryKey, enabled: !!user, retry: false, queryFn: () => load() });

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/owner/login", search: { redirect: window.location.pathname } });
  }, [loading, user, navigate]);

  const mut = useMutation({
    mutationFn: (input: { type: OwnerNotificationType; emailEnabled: boolean }) => save({ data: input }),
    onSuccess: () => {
      toast.success("Saved.");
      void qc.invalidateQueries({ queryKey });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <OwnerPageShell>
      <Link to="/owner" className="text-sm text-muted-foreground hover:text-foreground">
        ← My properties
      </Link>
      <h1 className="mt-4 font-display text-2xl font-semibold text-foreground sm:text-3xl">Notification settings</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Every notification always appears in your notification bell. Choose which ones also reach you by email. Required notices can't be switched off.
      </p>
      <div className="mt-6">
        {error ? (
          <p className="text-sm text-destructive">{error.message}</p>
        ) : isLoading || !data ? (
          <OwnerLoading />
        ) : !data.isOwner ? (
          <p className="text-sm text-muted-foreground">These settings are for owners.</p>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border bg-card shadow-sm">
            {data.preferences.map((p) => (
              <li key={p.type} className="flex items-center justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{p.label}</p>
                  {p.mandatory ? (
                    <p className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Lock className="h-3 w-3" aria-hidden /> Required: always emailed
                    </p>
                  ) : null}
                </div>
                <label className="inline-flex shrink-0 items-center gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={p.emailEnabled}
                    disabled={p.mandatory || mut.isPending}
                    onChange={(e) => mut.mutate({ type: p.type, emailEnabled: e.target.checked })}
                  />
                  Email
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </OwnerPageShell>
  );
}
