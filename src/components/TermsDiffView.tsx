import { useMemo, useState } from "react";
import { buildDiff, type DiffRow, type Seg } from "@/lib/tc";

function Segs({ segs }: { segs: Seg[] }) {
  return (
    <>
      {segs.map((s, i) =>
        s.mark === "add" ? (
          <ins key={i} className="rounded bg-emerald-200 px-0.5 text-black no-underline decoration-emerald-800 underline-offset-2 [text-decoration:underline]">
            {s.text}
          </ins>
        ) : s.mark === "del" ? (
          <del key={i} className="rounded bg-red-200 px-0.5 text-black">
            {s.text}
          </del>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

const changedKinds = new Set<DiffRow["kind"]>(["added", "removed", "changed"]);

/**
 * Two versions of the Terms, marked: removed text struck through in red, added text underlined in green (never colour alone), side by side on a wide screen and
 * stacked on a phone. Unchanged text collapses to a line of context around each change, with a switch to show everything.
 */
export function TermsDiffView({ fromVersion, toVersion, previous, next }: { fromVersion: string; toVersion: string; previous: string; next: string }) {
  const diff = useMemo(() => buildDiff(previous, next), [previous, next]);
  const [showAll, setShowAll] = useState(false);
  const rows = diff.rows;
  const visible = rows.map((r, i) => showAll || changedKinds.has(r.kind) || rows.slice(Math.max(0, i - 1), i + 2).some((x) => changedKinds.has(x.kind)));

  const items: Array<{ row: DiffRow } | { gap: number }> = [];
  let gap = 0;
  rows.forEach((row, i) => {
    if (visible[i]) {
      if (gap) items.push({ gap });
      gap = 0;
      items.push({ row });
    } else gap++;
  });
  if (gap) items.push({ gap });

  const { stats } = diff;
  return (
    <section aria-label={`Changes from version ${fromVersion} to version ${toVersion}`}>
      <p className="text-base text-foreground" role="status">
        {stats.changed + stats.added + stats.removed === 0
          ? "No text changed."
          : `${stats.changed} line${stats.changed === 1 ? "" : "s"} changed, ${stats.added} added, ${stats.removed} removed.`}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        <del className="rounded bg-red-200 px-1 text-black">Struck through</del> is text removed from version {fromVersion}; <ins className="rounded bg-emerald-200 px-1 text-black underline">underlined</ins> is text added in version {toVersion}.
      </p>
      <label className="mt-3 inline-flex items-center gap-2 text-sm text-foreground">
        <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="h-4 w-4" />
        Show the unchanged text too
      </label>

      <div className="mt-4 hidden grid-cols-2 gap-px rounded-t-lg bg-border text-sm font-semibold text-foreground md:grid">
        <div className="bg-muted px-3 py-2">Version {fromVersion}</div>
        <div className="bg-muted px-3 py-2">Version {toVersion}</div>
      </div>
      <div className="divide-y divide-border rounded-lg border border-border bg-card text-[15px] leading-relaxed md:rounded-t-none">
        {items.map((it, i) =>
          "gap" in it ? (
            <p key={i} className="bg-muted/50 px-3 py-1.5 text-center text-sm text-muted-foreground">
              … {it.gap} unchanged line{it.gap === 1 ? "" : "s"}
            </p>
          ) : (
            <div key={i} className="grid md:grid-cols-2 md:divide-x md:divide-border">
              <div className="px-3 py-1.5">
                <p className="text-xs font-medium text-muted-foreground md:hidden">Version {fromVersion}</p>
                {it.row.left ? (
                  <p className="whitespace-pre-wrap">
                    <Segs segs={it.row.left} />
                  </p>
                ) : (
                  <p aria-hidden className="text-muted-foreground md:min-h-[1.5em]">
                    <span className="md:hidden">(nothing)</span>
                  </p>
                )}
              </div>
              <div className="border-t border-border/60 px-3 py-1.5 md:border-t-0">
                <p className="text-xs font-medium text-muted-foreground md:hidden">Version {toVersion}</p>
                {it.row.right ? (
                  <p className="whitespace-pre-wrap">
                    <Segs segs={it.row.right} />
                  </p>
                ) : (
                  <p aria-hidden className="text-muted-foreground md:min-h-[1.5em]">
                    <span className="md:hidden">(removed)</span>
                  </p>
                )}
              </div>
            </div>
          ),
        )}
      </div>
    </section>
  );
}
