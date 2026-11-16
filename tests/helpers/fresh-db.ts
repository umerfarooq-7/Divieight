/**
 * A fresh Postgres (PGlite) built from the repository's own SQL: the checked-in Supabase migrations in order, then every root *.sql script, retried until each one's
 * dependencies exist. It is what "do the migrations apply cleanly on an empty database?" is tested against, and what the RLS and index tests run on.
 *
 * Building it takes about a minute, so the result is cached (keyed by a hash of every SQL file and this stub) in node_modules/.cache.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

export type Db = { exec: (sql: string) => Promise<unknown>; query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, any>> }>; dumpDataDir?: (c?: string) => Promise<Blob | File> };

/** Scripts that cannot run on a plain database: the cron schedule needs pg_cron, and the reset script deletes data on purpose. */
export const NOT_APPLICABLE = new Set(["cron-sweeps.sql", "reset-test-data.sql"]);

/** What Supabase provides before any migration runs: roles, the auth and storage schemas, and their helper functions. */
export const SUPABASE_STUB = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticator') THEN CREATE ROLE authenticator NOLOGIN; END IF;
  END $$;
  GRANT anon, authenticated, service_role TO authenticator;
  CREATE SCHEMA IF NOT EXISTS auth; CREATE SCHEMA IF NOT EXISTS storage; CREATE SCHEMA IF NOT EXISTS extensions;
  GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;
  CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, raw_user_meta_data jsonb DEFAULT '{}'::jsonb);
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.role', true), '') $$;
  CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
  CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
  CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb);
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql AS $$ SELECT string_to_array(name, '/') $$;
  CREATE PUBLICATION supabase_realtime;
`;

export interface Built {
  pg: Db;
  /** Files that applied, in the order they applied. */
  applied: string[];
  /** Files that never applied, with why. */
  failed: Array<{ file: string; error: string }>;
}

/** A schema dump of production (`supabase db dump --schema-only`), when one has been checked in: applied first, so the scripts after it find their base tables. */
export const BASELINE = "schema-baseline.sql";

const LAST = ["performance-indexes.sql", "storage-hardening.sql"];
const sqlFiles = () => {
  const base = existsSync(BASELINE) ? [BASELINE] : [];
  const mig = [...base, ...readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort().map((f) => `supabase/migrations/${f}`)];
  const root = readdirSync(".").filter((f) => f.endsWith(".sql") && !NOT_APPLICABLE.has(f) && f !== BASELINE).sort();
  // These two only act on tables that already exist, so they go last (their headers say to run them after the rest).
  root.sort((a, b) => Number(LAST.includes(a)) - Number(LAST.includes(b)));
  return { mig, root };
};

export function sqlFingerprint(): string {
  const { mig, root } = sqlFiles();
  const h = createHash("sha256");
  h.update(SUPABASE_STUB);
  for (const f of [...mig, ...root]) h.update(f).update(readFileSync(f));
  return h.digest("hex").slice(0, 20);
}

const CACHE_DIR = "node_modules/.cache/divieight";

/** Builds the database (or loads it from the cache). */
export async function buildFreshDb(): Promise<Built> {
  const specifier = "@electric-sql/pglite";
  const { PGlite } = (await import(/* @vite-ignore */ specifier)) as { PGlite: new (o?: Record<string, unknown>) => Db };
  const key = sqlFingerprint();
  const tar = `${CACHE_DIR}/fresh-${key}.tar.gz`;
  const meta = `${CACHE_DIR}/fresh-${key}.json`;
  if (existsSync(tar) && existsSync(meta)) {
    try {
      const pg = new PGlite({ loadDataDir: new Blob([readFileSync(tar)]) });
      await pg.query("SELECT 1");
      return { pg, ...(JSON.parse(readFileSync(meta, "utf8")) as { applied: string[]; failed: Built["failed"] }) };
    } catch {
      /* a bad cache is rebuilt */
    }
  }
  const pg = new PGlite();
  await pg.exec(SUPABASE_STUB);
  const { mig, root } = sqlFiles();
  const applied: string[] = [];
  const errors = new Map<string, string>();
  for (const f of mig) {
    try {
      await pg.exec(readFileSync(f, "utf8"));
      applied.push(f);
    } catch (e) {
      errors.set(f, String((e as Error).message).slice(0, 200));
    }
  }
  // The scripts in LAST act only on tables that exist, so they run once, after the others have settled.
  let pending = root.filter((f) => !LAST.includes(f));
  for (let pass = 0; pass < 12 && pending.length; pass++) {
    const next: string[] = [];
    for (const f of pending) {
      try {
        await pg.exec(readFileSync(f, "utf8"));
        applied.push(f);
        errors.delete(f);
      } catch (e) {
        errors.set(f, String((e as Error).message).slice(0, 200));
        next.push(f);
      }
    }
    if (next.length === pending.length) break;
    pending = next;
  }
  for (const f of root.filter((x) => LAST.includes(x))) {
    try {
      await pg.exec(readFileSync(f, "utf8"));
      applied.push(f);
    } catch (e) {
      errors.set(f, String((e as Error).message).slice(0, 200));
      pending.push(f);
    }
  }
  const failed = [...mig.filter((f) => !applied.includes(f)), ...pending].map((file) => ({ file, error: errors.get(file) ?? "" }));
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const blob = await pg.dumpDataDir!("gzip");
    writeFileSync(tar, Buffer.from(await blob.arrayBuffer()));
    writeFileSync(meta, JSON.stringify({ applied, failed }));
  } catch {
    /* no cache: the next run builds again */
  }
  return { pg, applied, failed };
}

/** The PGlite tests skip when PGlite is not installed (it is a test-only tool, installed with `npm install --no-save @electric-sql/pglite`). */
export const PGLITE_AVAILABLE: boolean = await import(/* @vite-ignore */ "@electric-sql/pglite" as string).then(
  () => true,
  () => false,
);
