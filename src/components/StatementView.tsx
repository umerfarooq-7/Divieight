import { CAPITAL_TYPE_LABELS, STATEMENT_STATUS_LABELS, capitalRows, periodLabel, statementMoney, type StatementAccountLine, type StatementSnapshot, type StatementStatus } from "@/lib/statements";

/** The statement as a page: the same five parts as the PDF, all from the fixed snapshot. Text is never smaller than 14 px. */
const ROW = "flex justify-between gap-4 text-base";

function Accounts({ title, lines, total }: { title: string; lines: StatementAccountLine[]; total: number }) {
  return (
    <div className="mt-3">
      <h4 className="text-base font-semibold text-foreground">{title}</h4>
      {lines.length === 0 ? <p className="text-base text-muted-foreground">None this period.</p> : null}
      {lines.map((a) => (
        <div key={a.code} className="mt-2">
          <div className={`${ROW} font-medium text-foreground`}>
            <span>
              {a.code} {a.name}
            </span>
            <span>{statementMoney(a.total_cents)}</span>
          </div>
          <ul className="mt-1 space-y-1 pl-3">
            {a.items.map((i, n) => (
              <li key={n} className={`${ROW} text-muted-foreground`}>
                <span className="min-w-0 break-words">
                  {i.date} · {i.memo || "(no description)"}
                </span>
                <span className="shrink-0">{statementMoney(i.amount_cents)}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className={`${ROW} mt-2 border-t border-border pt-1 font-semibold text-foreground`}>
        <span>Total {title.toLowerCase()}</span>
        <span>{statementMoney(total)}</span>
      </div>
    </div>
  );
}

export function StatementView({ snapshot: s, holder, version, status, issuedAt }: { snapshot: StatementSnapshot; holder: string; version: number; status: StatementStatus; issuedAt: string | null }) {
  const c = s.capital;
  const ytd: Array<[string, number]> = [
    ["Beginning of year", s.ytd.capital.beginning_cents],
    ["Contributions", s.ytd.capital.contributions_cents],
    ["Distributions", s.ytd.capital.distributions_cents],
    ["Allocable income", s.ytd.capital.income_cents],
    ["Allocable expense", s.ytd.capital.expense_cents],
    ...(s.ytd.capital.depreciation_cents !== 0 ? ([["Allocable depreciation", s.ytd.capital.depreciation_cents]] as Array<[string, number]>) : []),
    ["Closing balance", s.ytd.capital.closing_cents],
  ];
  return (
    <article className="space-y-5 text-base text-foreground">
      <header>
        <h2 className="font-display text-2xl font-semibold">Monthly statement: {periodLabel(s.period)}</h2>
        <p className="mt-1 text-muted-foreground">
          {s.property.llc_name ?? "LLC"} · Prepared for {holder}
        </p>
        <p className="text-muted-foreground">
          Version {version} · {STATEMENT_STATUS_LABELS[status]}
          {issuedAt ? ` · Issued ${issuedAt.slice(0, 10)}` : ""}
        </p>
      </header>

      <section className="rounded-xl border border-border bg-card p-5">
        <h3 className="text-lg font-semibold">Property summary</h3>
        <dl className="mt-2 space-y-1">
          {[
            ["Property", [s.property.address, s.property.city, s.property.state].filter(Boolean).join(", ") || "-"],
            ["LLC", s.property.llc_name ?? "-"],
            ["Shares held at month end", `${s.property.shares} of ${s.property.total_shares}`],
            ["Percentage interest", `${s.property.interest_percent}%`],
          ].map(([k, v]) => (
            <div key={k} className={ROW}>
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="text-right">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <h3 className="text-lg font-semibold">Your capital account, {periodLabel(s.period)}</h3>
        <dl className="mt-2 space-y-1">
          {capitalRows(c).map(([label, cents]) => (
            <div key={label} className={`${ROW} ${label === "Opening balance" || label === "Closing balance" ? "border-t border-border pt-1 font-semibold" : ""}`}>
              <dt>{label}</dt>
              <dd>{statementMoney(cents)}</dd>
            </div>
          ))}
        </dl>
        {(c.lines ?? []).length > 0 ? (
          <ul className="mt-3 space-y-1 text-muted-foreground">
            {c.lines!.map((l, i) => (
              <li key={i} className={ROW}>
                <span className="min-w-0 break-words">
                  {l.date} · {CAPITAL_TYPE_LABELS[l.type] ?? l.type}
                  {l.memo ? `: ${l.memo}` : ""}
                </span>
                <span className="shrink-0">{statementMoney(l.amount_cents)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <h3 className="text-lg font-semibold">The LLC&apos;s income and expense, {periodLabel(s.period)}</h3>
        <p className="text-muted-foreground">Property-level activity of the LLC itself, before it is passed on to the owners.</p>
        <Accounts title="Income" lines={s.llc_month.income} total={s.llc_month.income_cents} />
        <Accounts title="Expense" lines={s.llc_month.expense} total={s.llc_month.expense_cents} />
        <div className={`${ROW} mt-3 font-semibold`}>
          <span>Net income (expense)</span>
          <span>{statementMoney(s.llc_month.net_cents)}</span>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <h3 className="text-lg font-semibold">Year to date, {s.ytd.year}</h3>
        <h4 className="mt-2 font-semibold">Your capital account</h4>
        <dl className="space-y-1">
          {ytd.map(([k, v]) => (
            <div key={k} className={ROW}>
              <dt>{k}</dt>
              <dd>{statementMoney(v)}</dd>
            </div>
          ))}
        </dl>
        <h4 className="mt-3 font-semibold">The LLC&apos;s property-level activity</h4>
        <dl className="space-y-1">
          {(
            [
              ["Income", s.ytd.llc.income_cents],
              ["Expense", s.ytd.llc.expense_cents],
              ["Net income (expense)", s.ytd.llc.net_cents],
            ] as Array<[string, number]>
          ).map(([k, v]) => (
            <div key={k} className={ROW}>
              <dt>{k}</dt>
              <dd>{statementMoney(v)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <h3 className="text-lg font-semibold">Manager&apos;s notes</h3>
        <p className="mt-1 whitespace-pre-wrap break-words">{s.manager_notes?.trim() ? s.manager_notes : "No notes this month."}</p>
      </section>
      <p className="text-muted-foreground">This statement is a record of the LLC&apos;s books for your records and your CPA. It is not a tax return or a K-1.</p>
    </article>
  );
}
