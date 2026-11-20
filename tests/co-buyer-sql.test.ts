/**
 * The co-buyer SQL on a real Postgres (PGlite, built from the repository's own SQL): co-buyer-links.sql, joint-reservations.sql and joint-holders.sql.
 * The limits hold whoever writes, the browser can only read its own rows, and a co-holder can see the property's records.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { PGLITE_AVAILABLE, buildFreshDb, type Built, type Db } from "./helpers/fresh-db";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DAN = U(1); // reserved the share
const CAROL = U(2); // co-holder
const EVE = U(3); // a stranger with a buyer account
const SEL = U(4);
const ADM = U(5);
const A_DAN = U(11);
const A_CAROL = U(12);
const A_EVE = U(13);
const A_FRED = U(14); // a fourth account, for the one-link-per-account rules
const HOME = U(101);
const OTHER = U(102);
const RES = U(201);
const RES2 = U(202);

let pg: Db;
let built: Built;
let scopeApplied = false;
const ok = async (sql: string, params?: unknown[]) => (await pg.query(sql, params)).rows;
const fails = async (sql: string, params?: unknown[]) => {
  try {
    await pg.query(sql, params);
    return "";
  } catch (e) {
    return (e as { message?: string }).message ?? "failed";
  }
};
const count = (sql: string, params?: unknown[]) => ok(`SELECT count(*)::int AS n FROM (${sql}) q`, params).then((r) => r[0]!.n as number);
async function asUser<T>(uid: string | null, fn: () => Promise<T>, role: "authenticated" | "anon" = "authenticated"): Promise<T> {
  await pg.exec(`SET SESSION AUTHORIZATION authenticator; SET ROLE ${role}; SELECT set_config('request.jwt.claim.sub', '${uid ?? ""}', false); SELECT set_config('request.jwt.claim.role', '${role}', false);`);
  try {
    return await fn();
  } finally {
    await pg.exec("RESET ROLE; SET SESSION AUTHORIZATION postgres; SELECT set_config('request.jwt.claim.sub', '', false); SELECT set_config('request.jwt.claim.role', '', false);");
  }
}
const link = (id: string, inviter: string, invitee: string | null, status: string, email = "x@test.invalid") =>
  pg.query("INSERT INTO public.co_buyer_links (id, inviter_account_id, invitee_account_id, invitee_name, invitee_email, token_hash, status) VALUES ($1, $2, $3, 'Someone', $4, 'hash', $5)", [id, inviter, invitee, email, status]);
const reset = async () => {
  await pg.exec("DELETE FROM public.joint_reservations; DELETE FROM public.joint_reservation_requests; DELETE FROM public.co_buyer_links; DELETE FROM public.cap_table_entries WHERE property_id IN ('" + HOME + "', '" + OTHER + "');");
};

beforeAll(async () => {
  if (!PGLITE_AVAILABLE) return;
  built = await buildFreshDb();
  pg = built.pg;
  // joint-holders.sql redefines user_has_property_access, which reads agents and pods: base tables that are not in the repository (see migrations-fresh-db.test.ts).
  // They exist in production. Here they are stood in for, so the script itself runs as written.
  if (!built.applied.includes("joint-holders.sql")) {
    await pg.exec("CREATE TABLE IF NOT EXISTS public.agents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), auth_user_id uuid); CREATE TABLE IF NOT EXISTS public.pods (property_id uuid, heavy_lifting_agent_id uuid, hla_status text); ALTER TABLE public.buyer_accounts ADD COLUMN IF NOT EXISTS tethered_resident_agent_id uuid; ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS listing_agent_id uuid;");
    // property-scope.sql is what puts the access rule on the records tables; with the stand-ins it can run too.
    try {
      await pg.exec(readFileSync("property-scope.sql", "utf8"));
      scopeApplied = true;
    } catch {
      scopeApplied = false;
    }
    await pg.exec(readFileSync("joint-holders.sql", "utf8"));
  }
  await pg.exec("SET session_replication_role = replica");
  for (const id of [DAN, CAROL, EVE, SEL, ADM]) await pg.query("INSERT INTO auth.users (id, email) VALUES ($1, $2)", [id, `${id.slice(-2)}@test.invalid`]);
  await pg.query("INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')", [ADM]);
  await pg.query("INSERT INTO public.sellers (id, email, full_name) VALUES ($1, 'sel@test.invalid', 'Seller')", [SEL]);
  await pg.query("INSERT INTO public.properties (id, seller_id, address, city, state, zip, status) VALUES ($1, $3, '1 Joint St', 'Lusk', 'WY', '82225', 'pending'), ($2, $3, '2 Other St', 'Bend', 'OR', '97701', 'pending')", [HOME, OTHER, SEL]);
  await pg.query("INSERT INTO public.buyer_accounts (id, auth_user_id, email, golden_ticket_issued) VALUES ($1, $5, 'dan@test.invalid', true), ($2, $6, 'carol@test.invalid', true), ($3, $7, 'eve@test.invalid', false), ($4, $8, 'fred@test.invalid', false)", [A_DAN, A_CAROL, A_EVE, A_FRED, DAN, CAROL, EVE, U(6)]).catch(async () => {
    await pg.query("INSERT INTO auth.users (id, email) VALUES ($1, 'fred@test.invalid')", [U(6)]);
    await pg.query("INSERT INTO public.buyer_accounts (id, auth_user_id, email, golden_ticket_issued) VALUES ($1, $5, 'dan@test.invalid', true), ($2, $6, 'carol@test.invalid', true), ($3, $7, 'eve@test.invalid', false), ($4, $8, 'fred@test.invalid', false)", [A_DAN, A_CAROL, A_EVE, A_FRED, DAN, CAROL, EVE, U(6)]);
  });
  await pg.query("INSERT INTO public.pod_reservations (id, property_id, buyer_account_id, shares_reserved, status) VALUES ($1, $3, $5, 1, 'reserved'), ($2, $4, $5, 1, 'reserved')", [RES, RES2, HOME, OTHER, A_DAN]);
  await pg.exec("RESET session_replication_role");
}, 600_000);

describe.skipIf(!PGLITE_AVAILABLE)("the three scripts apply", () => {
  it("co-buyer-links.sql and joint-reservations.sql apply on the schema, and joint-holders.sql applies once the production base tables exist", () => {
    for (const f of ["co-buyer-links.sql", "joint-reservations.sql"]) expect(built.applied, f).toContain(f);
    const why = built.failed.find((x) => x.file === "joint-holders.sql");
    // The only reason it may not apply on the bare schema is the production base table the repository lacks.
    if (why) expect(why.error).toMatch(/public.agents/);
  });
  it("cap_table_entries has the co-holder column", async () => {
    expect((await ok("SELECT 1 FROM information_schema.columns WHERE table_name = 'cap_table_entries' AND column_name = 'co_holder_account_id'"))).toHaveLength(1);
  });
});

describe.skipIf(!PGLITE_AVAILABLE)("co_buyer_links: the limits hold whoever writes", () => {
  it("refuses a link from an account to itself, an unknown status, and an active link with no invitee account", async () => {
    await reset();
    expect(await fails(`INSERT INTO public.co_buyer_links (inviter_account_id, invitee_account_id, invitee_name, invitee_email, token_hash, status) VALUES ('${A_DAN}', '${A_DAN}', 'x', 'x@t', 'h', 'active')`)).toMatch(/co_buyer_links_two_accounts_check/);
    expect(await fails(`INSERT INTO public.co_buyer_links (inviter_account_id, invitee_name, invitee_email, token_hash, status) VALUES ('${A_DAN}', 'x', 'x@t', 'h', 'pending')`)).toMatch(/co_buyer_links_status_check/);
    expect(await fails(`INSERT INTO public.co_buyer_links (inviter_account_id, invitee_name, invitee_email, token_hash, status) VALUES ('${A_DAN}', 'x', 'x@t', 'h', 'active')`)).toMatch(/co_buyer_links_active_has_invitee/);
  });

  it("one open link per inviting account; a finished one does not count", async () => {
    await reset();
    await link(U(701), A_DAN, null, "invited");
    expect(await fails(`INSERT INTO public.co_buyer_links (inviter_account_id, invitee_name, invitee_email, token_hash) VALUES ('${A_DAN}', 'y', 'y@t', 'h2')`)).toMatch(/co_buyer_links_one_open_per_inviter/);
    await pg.query("UPDATE public.co_buyer_links SET status = 'declined', ended_at = now() WHERE id = $1", [U(701)]);
    expect(await fails(`INSERT INTO public.co_buyer_links (inviter_account_id, invitee_name, invitee_email, token_hash) VALUES ('${A_DAN}', 'y', 'y@t', 'h2')`)).toBe("");
  });

  it("an account is the other side of at most one active link", async () => {
    await reset();
    await link(U(702), A_DAN, A_CAROL, "active");
    expect(await fails(`INSERT INTO public.co_buyer_links (inviter_account_id, invitee_account_id, invitee_name, invitee_email, token_hash, status) VALUES ('${A_EVE}', '${A_CAROL}', 'c', 'c@t', 'h', 'active')`)).toMatch(/co_buyer_links_one_active_per_invitee/);
  });

  it("the token is required", async () => {
    await reset();
    expect(await fails(`INSERT INTO public.co_buyer_links (inviter_account_id, invitee_name, invitee_email) VALUES ('${A_DAN}', 'x', 'x@t')`)).toMatch(/token_hash/);
  });
});

describe.skipIf(!PGLITE_AVAILABLE)("co_buyer_links: who reads and writes what", () => {
  it("both sides read their link; a stranger and a visitor read nothing", async () => {
    await reset();
    await link(U(703), A_DAN, A_CAROL, "active");
    expect(await asUser(DAN, () => count("SELECT 1 FROM public.co_buyer_links"))).toBe(1);
    expect(await asUser(CAROL, () => count("SELECT 1 FROM public.co_buyer_links"))).toBe(1);
    expect(await asUser(EVE, () => count("SELECT 1 FROM public.co_buyer_links"))).toBe(0);
    expect(await asUser(ADM, () => count("SELECT 1 FROM public.co_buyer_links"))).toBe(1);
    expect(await asUser(null, () => fails("SELECT 1 FROM public.co_buyer_links"), "anon")).toMatch(/permission denied/);
  });

  it("nobody can write a link from the browser: not even the person it is about", async () => {
    await reset();
    await link(U(704), A_DAN, A_CAROL, "active");
    expect(await asUser(DAN, () => fails(`INSERT INTO public.co_buyer_links (inviter_account_id, invitee_name, invitee_email, token_hash) VALUES ('${A_DAN}', 'x', 'x@t', 'h')`))).toMatch(/permission denied/);
    expect(await asUser(CAROL, () => fails(`UPDATE public.co_buyer_links SET status = 'revoked'`))).toMatch(/permission denied/);
    expect(await asUser(DAN, () => fails(`DELETE FROM public.co_buyer_links`))).toMatch(/permission denied/);
    expect(await count("SELECT 1 FROM public.co_buyer_links WHERE status = 'active'")).toBe(1);
  });
});

describe.skipIf(!PGLITE_AVAILABLE)("joint reservations: the limits hold whoever writes", () => {
  const request = (id: string, res: string, prop: string, initiator: string, partner: string, status = "pending") =>
    pg.query("INSERT INTO public.joint_reservation_requests (id, reservation_id, property_id, initiator_account_id, partner_account_id, status) VALUES ($1, $2, $3, $4, $5, $6)", [id, res, prop, initiator, partner, status]);
  const joint = (id: string, res: string, prop: string, primary: string, partner: string, status = "active") =>
    pg.query("INSERT INTO public.joint_reservations (id, reservation_id, property_id, primary_account_id, partner_account_id, status) VALUES ($1, $2, $3, $4, $5, $6)", [id, res, prop, primary, partner, status]);

  it("one request per reservation, between two different accounts, with a known status", async () => {
    await reset();
    await request(U(801), RES, HOME, A_DAN, A_CAROL);
    expect(await fails(`INSERT INTO public.joint_reservation_requests (reservation_id, property_id, initiator_account_id, partner_account_id) VALUES ('${RES}', '${HOME}', '${A_DAN}', '${A_EVE}')`)).toMatch(/joint_requests_one_per_reservation/);
    expect(await fails(`INSERT INTO public.joint_reservation_requests (reservation_id, property_id, initiator_account_id, partner_account_id) VALUES ('${RES2}', '${OTHER}', '${A_DAN}', '${A_DAN}')`)).toMatch(/joint_requests_two_accounts_check/);
    expect(await fails(`INSERT INTO public.joint_reservation_requests (reservation_id, property_id, initiator_account_id, partner_account_id, status) VALUES ('${RES2}', '${OTHER}', '${A_DAN}', '${A_CAROL}', 'maybe')`)).toMatch(/joint_requests_status_check/);
  });

  it("a share has at most one joint holder, never the buyer who reserved it, and a buyer co-holds one share per home", async () => {
    await reset();
    await joint(U(802), RES, HOME, A_DAN, A_CAROL);
    expect(await fails(`INSERT INTO public.joint_reservations (reservation_id, property_id, primary_account_id, partner_account_id) VALUES ('${RES}', '${HOME}', '${A_DAN}', '${A_EVE}')`)).toMatch(/joint_reservations_one_per_reservation/);
    expect(await fails(`INSERT INTO public.joint_reservations (reservation_id, property_id, primary_account_id, partner_account_id) VALUES ('${RES2}', '${OTHER}', '${A_DAN}', '${A_DAN}')`)).toMatch(/joint_reservations_two_accounts_check/);
    // Same partner, same home, another active share: refused. Another home: fine. After the first ended: fine.
    await pg.query("INSERT INTO public.pod_reservations (id, property_id, buyer_account_id, shares_reserved, status) VALUES ($1, $2, $3, 1, 'reserved')", [U(203), HOME, A_FRED]);
    expect(await fails(`INSERT INTO public.joint_reservations (reservation_id, property_id, primary_account_id, partner_account_id) VALUES ('${U(203)}', '${HOME}', '${A_FRED}', '${A_CAROL}')`)).toMatch(/joint_reservations_one_per_partner_property/);
    expect(await fails(`INSERT INTO public.joint_reservations (reservation_id, property_id, primary_account_id, partner_account_id) VALUES ('${RES2}', '${OTHER}', '${A_DAN}', '${A_CAROL}')`)).toBe("");
    await pg.query("UPDATE public.joint_reservations SET status = 'ended' WHERE reservation_id = $1", [RES]);
    expect(await fails(`INSERT INTO public.joint_reservations (reservation_id, property_id, primary_account_id, partner_account_id) VALUES ('${U(203)}', '${HOME}', '${A_FRED}', '${A_CAROL}')`)).toBe("");
  });

  it("deleting the reservation removes its request and joint row", async () => {
    await reset();
    await pg.query("INSERT INTO public.pod_reservations (id, property_id, buyer_account_id, shares_reserved, status) VALUES ($1, $2, $3, 1, 'reserved')", [U(204), HOME, A_FRED]);
    await request(U(803), U(204), HOME, A_FRED, A_CAROL);
    await joint(U(804), U(204), HOME, A_FRED, A_CAROL);
    await pg.query("DELETE FROM public.pod_reservations WHERE id = $1", [U(204)]);
    expect(await count("SELECT 1 FROM public.joint_reservation_requests WHERE id = '" + U(803) + "'")).toBe(0);
    expect(await count("SELECT 1 FROM public.joint_reservations WHERE id = '" + U(804) + "'")).toBe(0);
  });

  it("both buyers read their request and joint row; a stranger and a visitor read nothing; nobody writes from the browser", async () => {
    await reset();
    await request(U(805), RES, HOME, A_DAN, A_CAROL, "accepted");
    await joint(U(806), RES, HOME, A_DAN, A_CAROL);
    for (const who of [DAN, CAROL, ADM]) {
      expect(await asUser(who, () => count("SELECT 1 FROM public.joint_reservation_requests")), who).toBe(1);
      expect(await asUser(who, () => count("SELECT 1 FROM public.joint_reservations")), who).toBe(1);
    }
    expect(await asUser(EVE, () => count("SELECT 1 FROM public.joint_reservations"))).toBe(0);
    expect(await asUser(EVE, () => count("SELECT 1 FROM public.joint_reservation_requests"))).toBe(0);
    expect(await asUser(null, () => fails("SELECT 1 FROM public.joint_reservations"), "anon")).toMatch(/permission denied/);
    expect(await asUser(CAROL, () => fails("UPDATE public.joint_reservations SET status = 'ended'"))).toMatch(/permission denied/);
    expect(await asUser(DAN, () => fails("INSERT INTO public.joint_reservations (reservation_id, property_id, primary_account_id, partner_account_id) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid())"))).toMatch(/permission denied/);
    expect(await asUser(CAROL, () => fails("DELETE FROM public.joint_reservation_requests"))).toMatch(/permission denied/);
  });
});

describe.skipIf(!PGLITE_AVAILABLE)("a co-holder can see the property's records", () => {
  const access = (uid: string, property: string) => ok("SELECT public.user_has_property_access($1, $2) AS a", [uid, property]).then((r) => r[0]!.a as boolean);

  it("the buyer who reserved it has access; the co-holder from the moment they accept; a stranger never; and, as with a withdrawn reservation, a record of having held it keeps read access to that home's records", async () => {
        await reset();
    expect(await access(DAN, HOME)).toBe(true);
    expect(await access(CAROL, HOME)).toBe(false);
    await pg.query("INSERT INTO public.joint_reservations (reservation_id, property_id, primary_account_id, partner_account_id) VALUES ($1, $2, $3, $4)", [RES, HOME, A_DAN, A_CAROL]);
    expect(await access(CAROL, HOME)).toBe(true);
    expect(await access(CAROL, OTHER)).toBe(false);
    expect(await access(EVE, HOME)).toBe(false);
    await pg.query("UPDATE public.joint_reservations SET status = 'ended' WHERE reservation_id = $1", [RES]);
    expect(await access(CAROL, HOME)).toBe(true);
    expect(await access(CAROL, OTHER)).toBe(false);
  });

  it("a co-holder named on the cap table keeps access after closing", async () => {
        await reset();
    await pg.query("INSERT INTO public.cap_table_entries (property_id, share_number, holder_type, buyer_account_id, co_holder_account_id, retention_lock_expires_at) VALUES ($1, 1, 'buyer_account', $2, $3, now())", [HOME, A_DAN, A_CAROL]);
    expect(await access(CAROL, HOME)).toBe(true);
    expect(await access(EVE, HOME)).toBe(false);
  });

  it("the co-holder reads the property's documents through the same rule", async (ctx) => {
    if (!scopeApplied) return ctx.skip();
        await reset();
    await pg.query("DELETE FROM public.property_documents WHERE property_id = $1", [HOME]);
    await pg.query("INSERT INTO public.property_documents (property_id, document_name, document_type, file_url) VALUES ($1, 'Deed', 'deed', 'd.pdf')", [HOME]);
    const read = () => asUser(CAROL, () => count("SELECT 1 FROM public.property_documents WHERE property_id = '" + HOME + "'"));
    expect(await read()).toBe(0);
    await pg.query("INSERT INTO public.joint_reservations (reservation_id, property_id, primary_account_id, partner_account_id) VALUES ($1, $2, $3, $4)", [RES, HOME, A_DAN, A_CAROL]);
    expect(await read()).toBe(1);
  });
});
