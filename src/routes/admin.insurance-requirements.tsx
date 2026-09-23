import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import { listCoverageRequirements, saveCoverageRequirements } from "@/lib/insurance.functions";
import {
  DECLARED_USE_LABELS,
  PLACEHOLDER_WARNING,
  formatDate,
  usd,
  validateRules,
  type CoverageRule,
  type DeclaredUse,
} from "@/lib/insurance";

export const Route = createFileRoute("/admin/insurance-requirements")({
  head: () => ({
    meta: [
      { title: "Coverage requirements — divieight admin" },
      { name: "description", content: "Versioned minimum homeowners coverage by replacement cost and declared use." },
      { property: "og:title", content: "Coverage requirements — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: CoverageRequirementsPage,
});

type Draft = { [K in keyof CoverageRule]: string };
const toDraft = (r: CoverageRule): Draft => ({
  min_replacement_cost: String(r.min_replacement_cost),
  max_replacement_cost: r.max_replacement_cost == null ? "" : String(r.max_replacement_cost),
  declared_use: r.declared_use,
  min_dwelling_coverage: String(r.min_dwelling_coverage),
  min_liability_coverage: String(r.min_liability_coverage),
});
const fromDraft = (d: Draft): CoverageRule => ({
  min_replacement_cost: Number(d.min_replacement_cost),
  max_replacement_cost: d.max_replacement_cost === "" ? null : Number(d.max_replacement_cost),
  declared_use: d.declared_use as DeclaredUse,
  min_dwelling_coverage: Number(d.min_dwelling_coverage),
  min_liability_coverage: Number(d.min_liability_coverage),
});

const cell = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm";

function CoverageRequirementsPage() {
  const qc = useQueryClient();
  const list = useServerFn(listCoverageRequirements);
  const save = useServerFn(saveCoverageRequirements);
  const { data, isLoading } = useQuery({ queryKey: ["coverage-requirements"], queryFn: () => list() });
  const versions = data?.versions ?? [];
  const active = versions.find((v) => v.is_active) ?? null;

  const [rows, setRows] = useState<Draft[]>([]);
  const [notes, setNotes] = useState("");
  const [placeholder, setPlaceholder] = useState(true);

  useEffect(() => {
    if (active) {
      setRows(active.rules.map(toDraft));
      setPlaceholder(active.is_placeholder);
    }
  }, [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const problem = rows.length ? validateRules(rows.map(fromDraft)) : "Add at least one rule.";
  const saveMut = useMutation({
    mutationFn: () => save({ data: { rules: rows.map(fromDraft), notes: notes || null, isPlaceholder: placeholder } }),
    onSuccess: (r) => {
      toast.success(`Saved as version ${r.version} and activated.`);
      setNotes("");
      void qc.invalidateQueries({ queryKey: ["coverage-requirements"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const update = (i: number, k: keyof Draft, v: string) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  return (
    <div>
      <h1 className="font-display text-2xl font-semibold text-foreground">Coverage requirements</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Minimum homeowners/hazard coverage the Manager must procure, by property replacement-cost range and declared
        use. Saving creates a new version; policies record the version they were checked against.
      </p>

      {active?.is_placeholder || placeholder ? (
        <p className="mt-4 flex gap-2 rounded-xl border-2 border-amber-400 bg-amber-50 p-4 text-sm font-semibold text-amber-900">
          <AlertTriangle className="h-5 w-5 shrink-0" /> {PLACEHOLDER_WARNING}
        </p>
      ) : null}

      {isLoading ? (
        <p className="mt-6 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <section className="mt-6 overflow-x-auto rounded-xl border border-border bg-card p-4 shadow-sm">
          <p className="mb-3 text-xs text-muted-foreground">
            Editing from active version {active ? `v${active.version}` : "—"}. Leave "max" blank for no upper bound.
          </p>
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="pb-2 pr-2 font-medium">Declared use</th>
                <th className="pb-2 pr-2 font-medium">Replacement cost from ($)</th>
                <th className="pb-2 pr-2 font-medium">to ($, below)</th>
                <th className="pb-2 pr-2 font-medium">Min dwelling ($)</th>
                <th className="pb-2 pr-2 font-medium">Min liability ($)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="py-1 pr-2">
                    <select value={r.declared_use} onChange={(e) => update(i, "declared_use", e.target.value)} className={cell}>
                      <option value="personal_use">{DECLARED_USE_LABELS.personal_use}</option>
                      <option value="short_term_rental">{DECLARED_USE_LABELS.short_term_rental}</option>
                    </select>
                  </td>
                  {(["min_replacement_cost", "max_replacement_cost", "min_dwelling_coverage", "min_liability_coverage"] as const).map((k) => (
                    <td key={k} className="py-1 pr-2">
                      <input type="number" value={r[k]} onChange={(e) => update(i, k, e.target.value)} className={cell} />
                    </td>
                  ))}
                  <td className="py-1">
                    <button
                      type="button"
                      aria-label="Remove rule"
                      onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                      className="rounded-md p-1.5 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            type="button"
            onClick={() =>
              setRows((rs) => [
                ...rs,
                { declared_use: "personal_use", min_replacement_cost: "", max_replacement_cost: "", min_dwelling_coverage: "", min_liability_coverage: "" },
              ])
            }
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary"
          >
            <Plus className="h-3.5 w-3.5" /> Add rule
          </button>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="block text-xs text-muted-foreground">
              Change note
              <input value={notes} onChange={(e) => setNotes(e.target.value)} className={`${cell} mt-1`} />
            </label>
            <label className="flex items-center gap-2 self-end text-sm text-foreground">
              <input type="checkbox" checked={placeholder} onChange={(e) => setPlaceholder(e.target.checked)} />
              These are still placeholder values
            </label>
          </div>
          {problem ? <p className="mt-2 text-xs text-destructive">{problem}</p> : null}
          <button
            type="button"
            disabled={Boolean(problem) || saveMut.isPending}
            onClick={() => saveMut.mutate()}
            className="mt-3 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Save as new version
          </button>
        </section>
      )}

      <h2 className="mt-8 text-sm font-semibold text-foreground">Version history</h2>
      <ul className="mt-3 space-y-2">
        {versions.map((v) => (
          <li key={v.id} className="rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">v{v.version}</span>
            {v.is_active ? " · active" : ""}
            {v.is_placeholder ? " · placeholder values" : ""} · {formatDate(v.created_at)} · {v.rules.length} rule(s)
            {v.notes ? ` · ${v.notes}` : ""}
            <div className="mt-1">
              {v.rules
                .map(
                  (r) =>
                    `${DECLARED_USE_LABELS[r.declared_use]} ${usd(r.min_replacement_cost)}–${r.max_replacement_cost == null ? "∞" : usd(r.max_replacement_cost)}: ${usd(r.min_dwelling_coverage)} / ${usd(r.min_liability_coverage)}`,
                )
                .join(" · ")}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
