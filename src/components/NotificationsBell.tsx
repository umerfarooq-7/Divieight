import { useEffect, useState } from "react";
import { Bell, Check } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";

type Notification = {
  id: string;
  message: string;
  type: string;
  is_read: boolean;
  created_at: string;
};

export function NotificationsBell() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);

  async function load() {
    if (!user) return;
    setLoading(true);
    const { data } = await supabase
      .from("notifications")
      .select("id, message, type, is_read, created_at")
      .eq("seller_id", user.id)
      .order("created_at", { ascending: false })
      .limit(10);
    setItems((data as Notification[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    if (user) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const unread = items.filter((n) => !n.is_read).length;

  async function markAll() {
    if (!user || unread === 0) return;
    const ids = items.filter((n) => !n.is_read).map((n) => n.id);
    setItems((prev) => prev.map((n) => ({ ...n, is_read: true })));
    await supabase.from("notifications").update({ is_read: true }).in("id", ids);
  }

  async function markOne(id: string) {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, is_read: true } : n)));
    await supabase.from("notifications").update({ is_read: true }).eq("id", id);
  }

  if (!user) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-sm transition-colors hover:bg-secondary"
        aria-label="Notifications"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 ? (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-foreground">
            {unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-40 mt-2 w-80 overflow-hidden rounded-xl border border-border bg-card shadow-lg">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <p className="text-sm font-semibold text-foreground">Notifications</p>
              <button
                type="button"
                onClick={markAll}
                disabled={unread === 0}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
              >
                <Check className="h-3 w-3" /> Mark all read
              </button>
            </div>
            <div className="max-h-96 overflow-y-auto">
              {loading ? (
                <p className="px-4 py-6 text-sm text-muted-foreground">Loading…</p>
              ) : items.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted-foreground">No notifications yet.</p>
              ) : (
                items.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => markOne(n.id)}
                    className={cn(
                      "flex w-full flex-col items-start gap-1 border-b border-border/60 px-4 py-3 text-left transition-colors last:border-0 hover:bg-secondary/60",
                      !n.is_read && "bg-accent/5",
                    )}
                  >
                    <div className="flex w-full items-start gap-2">
                      {!n.is_read ? (
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                      ) : (
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0" />
                      )}
                      <p className="flex-1 text-sm text-foreground">
                        {n.type === "report_flag" ? (
                          <span className="mr-1.5 inline-block rounded bg-amber-100 px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-amber-900">
                            Priority
                          </span>
                        ) : null}
                        {n.message}
                      </p>
                    </div>
                    <p className="pl-3.5 text-[11px] text-muted-foreground">
                      {new Date(n.created_at).toLocaleString()}
                    </p>
                  </button>
                ))
              )}
            </div>
            <Link
              to="/notifications"
              onClick={() => setOpen(false)}
              className="block border-t border-border px-4 py-2.5 text-center text-xs font-medium text-primary hover:bg-secondary/60"
            >
              View all notifications
            </Link>
          </div>
        </>
      ) : null}
    </div>
  );
}
