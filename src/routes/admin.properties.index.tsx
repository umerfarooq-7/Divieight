import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { StatusToneClass, money, when } from "@/lib/admin";

export const Route = createFileRoute("/admin/properties/")({
  component: AdminProperties,
});

type PropertyRow = {
  id: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  status: string;
  listing_status: string;
  property_type: string | null;
  listing_price: number | null;
  exit_type: string | null;
  retained_shares: number | null;
  created_at: string;
};

function AdminProperties() {
  const [rows, setRows] = useState<PropertyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("properties")
        .select(
          "id,address,city,state,zip,status,listing_status,property_type,listing_price,exit_type,retained_shares,created_at",
        )
        .order("created_at", { ascending: false });
      if (error) console.error(error);
      setRows((data as PropertyRow[] | null) ?? []);
      setLoading(false);
    })();
  }, []);

  const filtered = rows.filter((r) => {
    if (status !== "all" && r.status !== status) return false;
    return `${r.address} ${r.city} ${r.state} ${r.zip}`
      .toLowerCase()
      .includes(q.trim().toLowerCase());
  });

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">
            Properties
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Every property in the pipeline, from draft to live listing.
          </p>
        </div>
        <div className="flex gap-2">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search address, city, ZIP…"
            className="h-10 w-64 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="h-10 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="all">All statuses</option>
            {Array.from(new Set(rows.map((r) => r.status))).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Property</th>
                <th className="px-4 py-3 text-left font-medium">Type</th>
                <th className="px-4 py-3 text-left font-medium">Price</th>
                <th className="px-4 py-3 text-left font-medium">Per 1/8 share</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-left font-medium">Listing stage</th>
                <th className="px-4 py-3 text-left font-medium">Created</th>
                <th className="px-4 py-3 text-left font-medium">Due diligence</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                    No properties found.
                  </td>
                </tr>
              ) : (
                filtered.map((r) => (
                  <tr key={r.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground">{r.address}</div>
                      <div className="text-xs text-muted-foreground">
                        {r.city}, {r.state} {r.zip}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-foreground">{r.property_type ?? "—"}</td>
                    <td className="px-4 py-3 text-xs text-foreground">{money(r.listing_price)}</td>
                    <td className="px-4 py-3 text-xs text-foreground">
                      {r.listing_price != null ? money(r.listing_price / 8) : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${StatusToneClass(r.status)}`}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {r.listing_status}
                      {r.retained_shares != null ? ` · ${r.retained_shares}/8 retained` : ""}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{when(r.created_at)}</td>
                    <td className="px-4 py-3 text-xs">
                      <Link
                        to="/admin/properties/$id/due-diligence"
                        params={{ id: r.id }}
                        className="font-medium text-accent underline-offset-4 hover:underline"
                      >
                        Documents →
                      </Link>
                      <Link
                        to="/admin/properties/$id/reports"
                        params={{ id: r.id }}
                        className="ml-3 font-medium text-accent underline-offset-4 hover:underline"
                      >
                        Reports →
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
