/**
 * Minimal in-memory stand-in for the supabase-js query builder, enough to run
 * the platform's server modules end-to-end in tests without touching a real
 * database. Supports the subset of PostgREST the codebase actually uses.
 */
import { randomUUID } from "node:crypto";

type Row = Record<string, any>;
type Filter = (r: Row) => boolean;

/** Composite unique keys enforced on insert/upsert (mirrors the SQL indexes). */
const UNIQUE: Record<string, string[][]> = {
  authorization_responses: [["request_id", "account_member_id"]],
  authorization_commission_items: [["request_id"]],
  authorization_commission_responses: [["item_id", "account_member_id"]],
  earnest_money_obligations: [["property_id", "buyer_account_id"]],
  earnest_money_terms: [["property_id"]],
  entity_genesis: [["property_id"]],
  cap_table_entries: [["property_id", "share_number"]],
};

/** Column DEFAULTs from the SQL schema files that the code relies on. */
const DEFAULTS: Record<string, Row> = {
  authorization_requests: { status: "pending", market_driven: false, terms: {} },
  authorization_commission_items: { status: "proposed", provision_text: "" },
  earnest_money_obligations: { status: "pending", shares: 1, is_substitute: false },
  pod_reservations: { status: "reserved", shares_reserved: 1 },
  entity_genesis: { stage: "digital_genesis" },
  due_diligence_inventory: { required: true, is_governing_instrument: false, superseded_by: null },
  substitution_invitations: { status: "pending" },
  property_reports: { flags: [] },
  property_documents: { document_type: "other" },
};

/** Timestamp columns that DEFAULT now() in the schema. */
const NOW_DEFAULTS: Record<string, string[]> = {
  due_diligence_inventory: ["placed_at"],
  due_diligence_acknowledgments: ["acknowledged_at"],
  pod_reservations: ["reserved_at"],
  property_reports: ["received_at"],
  property_documents: ["uploaded_at"],
  earnest_money_terms: ["issued_at"],
};

const cmp = (a: any, b: any) => (a < b ? -1 : a > b ? 1 : 0);

class Query implements PromiseLike<{ data: any; error: any; count?: number }> {
  private filters: Filter[] = [];
  private op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private payload: Row[] = [];
  private patch: Row = {};
  private onConflict: string[] | null = null;
  private orders: Array<{ col: string; asc: boolean }> = [];
  private lim: number | null = null;
  private mode: "many" | "maybeSingle" | "single" = "many";
  private returning = false;

  constructor(
    private db: FakeDb,
    private table: string,
  ) {}

  select(_cols?: string) {
    if (this.op !== "select") this.returning = true;
    return this;
  }
  insert(rows: Row | Row[]) {
    this.op = "insert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  upsert(rows: Row | Row[], opts?: { onConflict?: string }) {
    this.op = "upsert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    this.onConflict = opts?.onConflict?.split(",").map((s) => s.trim()) ?? ["id"];
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.patch = patch;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  eq(col: string, v: any) {
    this.filters.push((r) => r[col] === v);
    return this;
  }
  neq(col: string, v: any) {
    this.filters.push((r) => r[col] !== v);
    return this;
  }
  in(col: string, vs: any[]) {
    this.filters.push((r) => vs.includes(r[col]));
    return this;
  }
  is(col: string, v: any) {
    this.filters.push((r) => (r[col] ?? null) === v);
    return this;
  }
  not(col: string, op: string, v: any) {
    if (op === "is") this.filters.push((r) => (r[col] ?? null) !== v);
    else if (op === "eq") this.filters.push((r) => r[col] !== v);
    return this;
  }
  lte(col: string, v: any) {
    this.filters.push((r) => r[col] != null && cmp(norm(r[col]), norm(v)) <= 0);
    return this;
  }
  lt(col: string, v: any) {
    this.filters.push((r) => r[col] != null && cmp(norm(r[col]), norm(v)) < 0);
    return this;
  }
  gte(col: string, v: any) {
    this.filters.push((r) => r[col] != null && cmp(norm(r[col]), norm(v)) >= 0);
    return this;
  }
  gt(col: string, v: any) {
    this.filters.push((r) => r[col] != null && cmp(norm(r[col]), norm(v)) > 0);
    return this;
  }
  contains(col: string, obj: Row) {
    this.filters.push((r) => Object.entries(obj).every(([k, v]) => r[col]?.[k] === v));
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orders.push({ col, asc: opts?.ascending !== false });
    return this;
  }
  limit(n: number) {
    this.lim = n;
    return this;
  }
  maybeSingle() {
    this.mode = "maybeSingle";
    return this;
  }
  single() {
    this.mode = "single";
    return this;
  }

  then<T1 = any, T2 = never>(
    onful?: ((v: { data: any; error: any }) => T1 | PromiseLike<T1>) | null,
    onrej?: ((e: any) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve()
      .then(() => this.run())
      .then(onful, onrej);
  }

  private shape(rows: Row[]) {
    const out = rows.map((r) => ({ ...r }));
    if (this.mode === "many") return { data: out, error: null };
    if (out.length > 1)
      return { data: null, error: { message: "multiple rows returned", code: "PGRST116" } };
    if (out.length === 0 && this.mode === "single")
      return { data: null, error: { message: "no rows", code: "PGRST116" } };
    return { data: out[0] ?? null, error: null };
  }

  private run() {
    const rows = this.db.table(this.table);
    const match = (r: Row) => this.filters.every((f) => f(r));

    if (this.op === "select") {
      let out = rows.filter(match);
      for (const o of [...this.orders].reverse())
        out = [...out].sort((a, b) => (o.asc ? 1 : -1) * cmp(norm(a[o.col]), norm(b[o.col])));
      if (this.lim != null) out = out.slice(0, this.lim);
      return this.shape(out);
    }

    if (this.op === "insert") {
      const created: Row[] = [];
      for (const p of this.payload) {
        const row = this.db.withDefaults(this.table, p);
        const clash = this.db.uniqueClash(this.table, row);
        if (clash) return { data: null, error: { message: `duplicate key (${clash})`, code: "23505" } };
        rows.push(row);
        created.push(row);
      }
      return this.returning ? this.shape(created) : { data: null, error: null };
    }

    if (this.op === "upsert") {
      const out: Row[] = [];
      for (const p of this.payload) {
        const keys = this.onConflict!;
        const existing = rows.find((r) => keys.every((k) => r[k] === p[k]));
        if (existing) {
          Object.assign(existing, p);
          out.push(existing);
        } else {
          const row = this.db.withDefaults(this.table, p);
          rows.push(row);
          out.push(row);
        }
      }
      return this.returning ? this.shape(out) : { data: null, error: null };
    }

    if (this.op === "update") {
      const hit = rows.filter(match);
      hit.forEach((r) => Object.assign(r, this.patch));
      return this.returning ? this.shape(hit) : { data: null, error: null };
    }

    // delete
    const keep = rows.filter((r) => !match(r));
    const removed = rows.length - keep.length;
    this.db.tables.set(this.table, keep);
    return { data: null, error: null, count: removed };
  }
}

function norm(v: any) {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return Date.parse(v);
  return v;
}

export class FakeDb {
  tables = new Map<string, Row[]>();
  rpcResults: Record<string, any> = {};

  table(name: string): Row[] {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name)!;
  }

  from(name: string) {
    return new Query(this, name);
  }

  async rpc(fn: string, args: Row) {
    const r = this.rpcResults[fn];
    return { data: typeof r === "function" ? r(args) : (r ?? null), error: null };
  }

  storage = {
    from: (_bucket: string) => ({
      upload: async (path: string) => ({ data: { path }, error: null }),
      createSignedUrls: async (paths: string[]) => ({
        data: paths.map((p) => ({ path: p, signedUrl: `https://signed.test/${p}` })),
        error: null,
      }),
      createSignedUrl: async (p: string) => ({ data: { signedUrl: `https://signed.test/${p}` }, error: null }),
    }),
  };

  withDefaults(table: string, p: Row): Row {
    const now = new Date().toISOString();
    const stamps: Row = {};
    for (const col of NOW_DEFAULTS[table] ?? []) stamps[col] = now;
    return { id: randomUUID(), created_at: now, updated_at: now, ...stamps, ...DEFAULTS[table], ...p };
  }

  uniqueClash(table: string, row: Row): string | null {
    for (const keys of UNIQUE[table] ?? []) {
      if (this.table(table).some((r) => keys.every((k) => r[k] === row[k])))
        return keys.join(",");
    }
    return null;
  }

  seed(table: string, rows: Row[]) {
    rows.forEach((r) => this.table(table).push(this.withDefaults(table, r)));
  }

  /** Audit rows whose action_type starts with the prefix. */
  audits(prefix: string) {
    return this.table("audit_log").filter((a) => String(a.action_type).startsWith(prefix));
  }

  notificationsFor(authUserId: string) {
    return this.table("notifications").filter((n) => n.seller_id === authUserId);
  }
}
