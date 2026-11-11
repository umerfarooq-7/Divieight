import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { groupByProperty, isOwnerNotificationType, notificationHref, OWNER_NOTIFICATION_TYPES } from "@/lib/owner-notifications";
import { getNotificationPropertyLabels } from "@/lib/owner-notifications.functions";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { Bell, Check } from "lucide-react";

type Notification = {
  id: string;
  message: string;
  type: string;
  is_read: boolean;
  created_at: string;
  property_id?: string | null;
};

export const Route = createFileRoute("/notifications")({
  head: () => ({
    meta: [
      { title: "Notifications — divieight" },
      { name: "description", content: "Your notification history on divieight." },
      { property: "og:title", content: "Notifications — divieight" },
      { property: "og:description", content: "Your notification history on divieight." },
    ],
  }),
  component: NotificationsPage,
});

function NotificationsPage() {
  const { user, loading } = useAuth();
  const [items, setItems] = useState<Notification[]>([]);
  const [busy, setBusy] = useState(true);
  const [labels, setLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!user) return;
    (async () => {
      setBusy(true);
      const read = (columns: string) =>
        (supabase as any).from("notifications").select(columns).eq("seller_id", user.id).order("created_at", { ascending: false });
      let { data, error } = await read("id, message, type, is_read, created_at, property_id");
      if (error) ({ data } = await read("id, message, type, is_read, created_at")); // before owner-notifications.sql is run
      const rows = (data as Notification[]) ?? [];
      setItems(rows);
      setBusy(false);
      const propertyIds = [...new Set(rows.map((n) => n.property_id).filter(Boolean))] as string[];
      if (propertyIds.length) setLabels(await getNotificationPropertyLabels({ data: { propertyIds } }).catch(() => ({})));
    })();
  }, [user]);

  async function markAll() {
    if (!user) return;
    const ids = items.filter((n) => !n.is_read).map((n) => n.id);
    if (ids.length === 0) return;
    setItems((prev) => prev.map((n) => ({ ...n, is_read: true })));
    await supabase.from("notifications").update({ is_read: true }).in("id", ids);
  }

  async function markOne(id: string) {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, is_read: true } : n)));
    await supabase.from("notifications").update({ is_read: true }).eq("id", id);
  }

  if (!loading && !user) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <h1 className="font-display text-2xl font-semibold text-foreground">Sign in required</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Please <Link to="/login" className="text-primary underline">sign in</Link> to view your notifications.
        </p>
      </div>
    );
  }

  const unread = items.filter((n) => !n.is_read).length;

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Bell className="h-5 w-5" />
          </span>
          <div>
            <h1 className="font-display text-2xl font-semibold text-foreground">Notifications</h1>
            <p className="text-sm text-muted-foreground">
              {unread > 0 ? `${unread} unread` : "You're all caught up."}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={markAll}
          disabled={unread === 0}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground hover:bg-secondary disabled:opacity-40"
        >
          <Check className="h-3.5 w-3.5" /> Mark all read
        </button>
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        {busy ? (
          <p className="px-6 py-10 text-center text-sm text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <p className="px-6 py-10 text-center text-sm text-muted-foreground">
            No notifications yet. We'll let you know when something happens.
          </p>
        ) : (
          groupByProperty(items, labels).flatMap((group) => [
            ...(group.label
              ? [
                  <p key={`group-${group.key}`} className="border-b border-border/60 bg-muted/40 px-5 py-2 text-xs font-semibold text-muted-foreground">
                    {group.label}
                  </p>,
                ]
              : []),
            ...group.items.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => {
                void markOne(n.id);
                const href = notificationHref(n);
                if (href) window.location.assign(href);
              }}
              className={cn(
                "flex w-full items-start gap-3 border-b border-border/60 px-5 py-4 text-left transition-colors last:border-0 hover:bg-secondary/60",
                !n.is_read && "bg-accent/5",
              )}
            >
              <span
                className={cn(
                  "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                  !n.is_read ? "bg-accent" : "bg-transparent",
                )}
              />
              <div className="flex-1">
                <p className="text-sm text-foreground">{n.message}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {new Date(n.created_at).toLocaleString()} · {isOwnerNotificationType(n.type) ? OWNER_NOTIFICATION_TYPES[n.type].label : n.type}
                </p>
              </div>
            </button>
            )),
          ])
        )}
      </div>
    </div>
  );
}
