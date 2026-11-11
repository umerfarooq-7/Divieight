/** QR / deep-link attribution: tokens, visits, what the browser keeps, the stamp, and nothing touching tether data. */
import { describe, it, expect } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import { addStoredToken, ATTRIBUTION_DAYS, isAttributionToken, parseStoredTokens, randomAttributionToken } from "@/lib/agent-qr";
import {
  createAgentQrToken,
  getAgentQrPage,
  getMyReferralSuggestion,
  listBuyerAttributionsForAdmin,
  recordAttributionVisit,
  revokeAgentQrToken,
  stampBuyerAttribution,
} from "@/lib/agent-qr.functions";
import { hashUserAgent, recordVisit, stampBuyer } from "@/lib/agent-qr.server";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const DAY = 86_400_000;

function seed() {
  seedPod(db());
  // A buyer still onboarding: seedPod's accounts count as already enrolled only if paid.
  for (const b of db().table("buyer_accounts")) b.priority_rank_timestamp = null;
}

const defaultToken = async (agentUser: string) => {
  as(agentUser);
  return (await getAgentQrPage()).tokens.find((t) => t.isDefault && !t.revokedAt)!;
};
const stamp = (user: string, tokens: string[]) => {
  as(user);
  return stampBuyerAttribution({ data: { tokens } });
};
const visit = (token: string) => recordAttributionVisit({ data: { token } });
const stamps = () => db().table("buyer_attribution");

describe("tokens", () => {
  it("are 12 random characters", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const t = randomAttributionToken();
      expect(isAttributionToken(t)).toBe(true);
      seen.add(t);
    }
    expect(seen.size).toBe(500);
  });

  it("the first visit makes one default; later visits don't make another", async () => {
    seed();
    as(USERS.ra);
    const first = await getAgentQrPage();
    expect(first.isAgent).toBe(true);
    expect(first.tokens).toHaveLength(1);
    expect(first.tokens[0]).toMatchObject({ isDefault: true, visits: 0 });
    await getAgentQrPage();
    expect(db().table("agent_attribution_tokens")).toHaveLength(1);
  });

  it("extra labeled tokens; a default stays first", async () => {
    seed();
    as(USERS.ra);
    await getAgentQrPage();
    await createAgentQrToken({ data: { label: "Open house" } });
    await expect(createAgentQrToken({ data: { label: "  " } })).rejects.toThrow("label");
    const { tokens } = await getAgentQrPage();
    expect(tokens.map((t) => [t.isDefault, t.label])).toEqual([
      [true, null],
      [false, "Open house"],
    ]);
  });

  it("a non-agent gets no page, no token and can't create one", async () => {
    seed();
    as(USERS.b1);
    expect(await getAgentQrPage()).toEqual({ isAgent: false, tokens: [] });
    await expect(createAgentQrToken({ data: { label: "x" } })).rejects.toThrow("Not authorized");
    expect(db().table("agent_attribution_tokens")).toEqual([]);
  });

  it("one agent never sees or revokes another's", async () => {
    seed();
    const mine = await defaultToken(USERS.ra);
    as(USERS.ra2);
    expect((await getAgentQrPage()).tokens.map((t) => t.id)).not.toContain(mine.id);
    await expect(revokeAgentQrToken({ data: { tokenId: mine.id } })).rejects.toThrow("isn't available");
    expect(db().table("agent_attribution_tokens").find((t) => t.id === mine.id)!.revoked_at).toBeFalsy();
  });

  it("revoking a default makes a fresh one next time", async () => {
    seed();
    const first = await defaultToken(USERS.ra);
    as(USERS.ra);
    await revokeAgentQrToken({ data: { tokenId: first.id } });
    await expect(revokeAgentQrToken({ data: { tokenId: first.id } })).rejects.toThrow("isn't available");
    const next = await defaultToken(USERS.ra);
    expect(next.token).not.toBe(first.token);
  });
});

describe("visits", () => {
  it("counts per token and stores only a hash", async () => {
    seed();
    const t = await defaultToken(USERS.ra);
    harness.userId = "";
    expect(await visit(t.token)).toEqual({ active: true });
    await visit(t.token);
    expect((await defaultToken(USERS.ra)).visits).toBe(2);
    const rows = db().table("attribution_visits");
    expect(Object.keys(rows[0]!).sort()).toEqual(expect.arrayContaining(["token_id", "user_agent_hash"]));
    expect(JSON.stringify(rows)).not.toMatch(/203\.0\.113|Mozilla/);
  });

  it("the browser string itself is never stored, only its hash", async () => {
    seed();
    const t = await defaultToken(USERS.ra);
    await recordVisit(db() as never, { token: t.token, userAgent: "Mozilla/5.0 (Private Device)" });
    const row = db().table("attribution_visits")[0]!;
    expect(JSON.stringify(row)).not.toContain("Mozilla");
    expect(row.user_agent_hash).toBe(await hashUserAgent("Mozilla/5.0 (Private Device)"));
  });

  it("the hash is one-way and stable; no user agent is fine", async () => {
    const hash = await hashUserAgent("Mozilla/5.0");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashUserAgent("Mozilla/5.0")).toBe(hash);
    expect(await hashUserAgent(null)).toBeNull();
  });

  it("an unknown or malformed token logs nothing and doesn't fail", async () => {
    seed();
    expect(await visit("nope")).toEqual({ active: false });
    expect(await visit("zzzzzzzzzzzz")).toEqual({ active: false });
    expect(await visit("<script>alert")).toEqual({ active: false });
    expect(db().table("attribution_visits")).toEqual([]);
  });

  it("a revoked token isn't kept or counted", async () => {
    seed();
    const t = await defaultToken(USERS.ra);
    as(USERS.ra);
    await revokeAgentQrToken({ data: { tokenId: t.id } });
    expect(await visit(t.token)).toEqual({ active: false });
    expect(db().table("attribution_visits")).toEqual([]);
  });
});

describe("what the browser keeps", () => {
  const A = "aaaaaaaaaaaa", B = "bbbbbbbbbbbb";
  it("the first token stays first; repeats don't move it", () => {
    let list = addStoredToken([], A, 1000);
    list = addStoredToken(list, B, 2000);
    list = addStoredToken(list, A, 3000);
    expect(list).toEqual([{ t: A, at: 1000 }, { t: B, at: 2000 }]);
  });

  it("expires at 90 days", () => {
    const now = Date.now();
    const raw = JSON.stringify([{ t: A, at: now - (ATTRIBUTION_DAYS - 1) * DAY }, { t: B, at: now - ATTRIBUTION_DAYS * DAY }]);
    expect(parseStoredTokens(raw, now).map((e) => e.t)).toEqual([A]);
  });

  it("ignores anything malformed", () => {
    expect(parseStoredTokens("not json")).toEqual([]);
    expect(parseStoredTokens('{"t":"x"}')).toEqual([]);
    expect(parseStoredTokens(JSON.stringify([{ t: "<bad>", at: Date.now() }, null, 5]))).toEqual([]);
    expect(parseStoredTokens(null)).toEqual([]);
  });
});

describe("the stamp", () => {
  it("visiting then registering stamps the buyer", async () => {
    seed();
    const t = await defaultToken(USERS.ra);
    expect(await stamp(USERS.b1, [t.token])).toEqual({ stamped: true, keep: false });
    expect(stamps()).toHaveLength(1);
    expect(stamps()[0]).toMatchObject({ buyer_user_id: USERS.b1, token_id: t.id, agent_id: IDS.ra });
    expect(db().audits("buyer.attribution_stamped")).toHaveLength(1);
  });

  it("a second token doesn't overwrite, even for a different agent, even later", async () => {
    seed();
    const first = await defaultToken(USERS.ra);
    const second = await defaultToken(USERS.ra2);
    await stamp(USERS.b1, [first.token]);
    expect(await stamp(USERS.b1, [second.token])).toEqual({ stamped: false, keep: false });
    expect(stamps()).toHaveLength(1);
    expect(stamps()[0]!.agent_id).toBe(IDS.ra);
    await stamp(USERS.b2, [second.token, first.token]);
    expect(stamps().find((s) => s.buyer_user_id === USERS.b2)!.agent_id).toBe(IDS.ra2);
  });

  it("a revoked token doesn't stamp; existing stamps stay", async () => {
    seed();
    const t = await defaultToken(USERS.ra);
    await stamp(USERS.b1, [t.token]);
    as(USERS.ra);
    await revokeAgentQrToken({ data: { tokenId: t.id } });
    expect(await stamp(USERS.b2, [t.token])).toEqual({ stamped: false, keep: false });
    expect(stamps()).toHaveLength(1);
    expect(stamps()[0]!.buyer_user_id).toBe(USERS.b1);
  });

  it("if the first was revoked since, the next live one counts", async () => {
    seed();
    const first = await defaultToken(USERS.ra);
    const second = await defaultToken(USERS.ra2);
    as(USERS.ra);
    await revokeAgentQrToken({ data: { tokenId: first.id } });
    await stamp(USERS.b1, [first.token, second.token]);
    expect(stamps()[0]!.agent_id).toBe(IDS.ra2);
  });

  it("no buyer account yet: nothing stamped, and the browser holds on to the token", async () => {
    seed();
    const t = await defaultToken(USERS.ra);
    expect(await stamp("u-new", [t.token])).toEqual({ stamped: false, keep: true });
    db().seed("buyer_accounts", [{ id: "buyer-new", auth_user_id: "u-new", email: "new@test.local" }]);
    expect(await stamp("u-new", [t.token])).toEqual({ stamped: true, keep: false });
  });

  it("a buyer who already paid the fee isn't claimed by a link opened afterwards", async () => {
    seed();
    const t = await defaultToken(USERS.ra);
    db().table("buyer_accounts").find((b) => b.id === IDS.b1)!.priority_rank_timestamp = new Date().toISOString();
    expect(await stamp(USERS.b1, [t.token])).toEqual({ stamped: false, keep: false });
    expect(stamps()).toEqual([]);
  });

  it("nobody refers themselves; garbage and unknown tokens do nothing", async () => {
    seed();
    const t = await defaultToken(USERS.ra);
    db().seed("buyer_accounts", [{ id: "buyer-agent", auth_user_id: USERS.ra, email: "x@test.local" }]);
    expect(await stamp(USERS.ra, [t.token])).toEqual({ stamped: false, keep: false });
    expect(await stamp(USERS.b1, ["<bad>", "zzzzzzzzzzzz"])).toEqual({ stamped: false, keep: false });
    expect(stamps()).toEqual([]);
  });

  it("two tabs at once stamp once", async () => {
    seed();
    const t = await defaultToken(USERS.ra);
    const results = await Promise.all([stampBuyer(db() as never, { userId: USERS.b1, tokens: [t.token] }), stampBuyer(db() as never, { userId: USERS.b1, tokens: [t.token] })]);
    expect(stamps()).toHaveLength(1);
    expect(results.filter((r) => r.stamped)).toHaveLength(1);
    expect(results.every((r) => r.keep === false)).toBe(true);
  });

  it("changes no tether or referral data on the buyer account", async () => {
    seed();
    const t = await defaultToken(USERS.ra);
    const buyer = db().table("buyer_accounts").find((b) => b.id === IDS.b1)!;
    const before = JSON.stringify(buyer);
    const tethers = JSON.stringify(db().table("pending_referral_agreements"));
    await stamp(USERS.b1, [t.token]);
    expect(JSON.stringify(buyer)).toBe(before);
    expect(buyer.referring_agent_id ?? null).toBeNull();
    expect(JSON.stringify(db().table("pending_referral_agreements"))).toBe(tethers);
  });

  it("before the SQL is run, signing in still works and the token is kept", async () => {
    seed();
    const failing = { from: (t: string) => (t === "buyer_attribution" ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "missing" } }) }) }) } : db().from(t)) };
    expect(await stampBuyer(failing as never, { userId: USERS.b1, tokens: ["aaaaaaaaaaaa"] })).toEqual({ stamped: false, keep: true });
  });
});

describe("who sees the suggestion", () => {
  it("the buyer sees a neutral note; the admin sees the agent; others see nothing", async () => {
    seed();
    const t = await defaultToken(USERS.ra);
    await stamp(USERS.b1, [t.token]);
    as(USERS.b1);
    expect(await getMyReferralSuggestion()).toEqual({ agentName: "Rita Resident", status: "pending" });
    await expect(listBuyerAttributionsForAdmin()).rejects.toThrow("Not authorized");
    as(USERS.b2);
    expect(await getMyReferralSuggestion()).toBeNull();
    as(USERS.ra);
    await expect(listBuyerAttributionsForAdmin()).rejects.toThrow("Not authorized");
    as(USERS.admin);
    const map = await listBuyerAttributionsForAdmin();
    expect(map[USERS.b1]).toMatchObject({ agentName: "Rita Resident", agentEmail: "ra@test.local" });
    expect(map[USERS.b2]).toBeUndefined();
  });
});
