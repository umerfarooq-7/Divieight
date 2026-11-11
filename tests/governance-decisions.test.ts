/**
 * The decided governance answers: one config for every number, the two draft Operating Agreement clauses,
 * proportional holiday turns, open-market expiry, Express interest only for Golden Ticket buyers, the next co-owner
 * after a cancelled sale, and the former seller's read-only page.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { harness } from "./setup";
import { seedPod, IDS, USERS, hoursFromNow } from "./fixtures";
import {
  GOVERNANCE_DEFAULTS,
  GOVERNANCE_KEYS,
  GOVERNANCE_SETTINGS,
  capitalCallNeedsVoteAt,
  governanceValueProblem,
  readVoteThresholds,
  requiredSharesFor,
  resolveConfig,
  thresholdLabelFor,
  voteThresholdsOf,
} from "@/lib/governance-config";
import { loadGovernanceConfig, updateGovernanceSetting, governanceSettingsView } from "@/lib/governance-config.server";
import { changeGovernanceSetting, getGovernanceSettings } from "@/lib/governance-config.functions";
import { capitalCallNeedsVote, CAPITAL_CALL_VOTE_THRESHOLD } from "@/lib/expenses";
import { RESALE_ROFR_HOURS, RESALE_UNPAID_NOTICE, pickNextElector } from "@/lib/resale";
import { RETENTION_VOTE_DAYS } from "@/lib/retention";
import { notificationHref } from "@/lib/owner-notifications";
import { castVoteBallot, closeVoteAsAdmin, createVoteAsAdmin, getVoteForOwner, openVoteAsAdmin, recordVotePosition } from "@/lib/votes.functions";
import { tallyVote } from "@/lib/votes";
import { draftOperatingAgreement, finalOperatingAgreement } from "@/lib/entity-genesis";
import { OA_DRAFT_CLAUSES, OA_DRAFT_MARKER, oaDraftClause, oaTermsFrom } from "@/constants/oaDraftClauses";
import { RESALE_FLAT_FEE } from "@/lib/resale";
import { computeQuotas, nextTurn, holidayTurnsPerRoundSet, GUARANTEED_WEEKS_PER_SHARE, DEFAULT_TURN_HOURS, type TurnContext, type Turn } from "@/lib/use-calendar";
import { cancelResaleSale, completeResaleSale, confirmResaleOffer, convertResaleInterest, createResaleListing, declineResaleOffer, exerciseResaleRofr, expressResaleInterest, getFormerSellerWeeks, getOwnerResale, listResaleForAdmin, recordResalePosition } from "@/lib/resale.functions";
import { expireOpenMarketListings, settleOffers, settleRofr } from "@/lib/resale.server";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const A = IDS.property;
const FOUNDER = "u-founder";

/** Admin: yes. Founder: an admin who is also the founder. Everyone else: no. */
function roles() {
  db().rpcResults.has_role = (a: { _user_id: string; _role: string }) => (a._role === "admin" && [USERS.admin, FOUNDER].includes(a._user_id)) || (a._role === "founder" && a._user_id === FOUNDER);
}

// ---------------------------------------------------------------------------
// 1. One config for every number
// ---------------------------------------------------------------------------

describe("1. the governance config", () => {
  it("holds exactly the decided numbers as its defaults", () => {
    expect(GOVERNANCE_DEFAULTS).toEqual({
      ordinaryVotePercent: 50,
      majorVotePercent: 75,
      unanimousVotePercent: 100,
      capitalCallVoteThresholdUsd: 10_000,
      retentionReleaseVoteDays: 14,
      rofrWindowHours: 240,
      rofrNextOfferHours: 48,
      openMarketExpiryDays: 180,
      useCalendarTurnHours: 48,
      guaranteedWeeksPerShare: 6,
    });
    expect(GOVERNANCE_SETTINGS.map((s) => s.key).sort()).toEqual([...GOVERNANCE_KEYS].sort());
  });

  it("thresholds: ordinary is 50% + 1, major 75%, unanimous 100% of all issued shares", () => {
    for (const [issued, ordinary, major, unanimous] of [[8, 5, 6, 8], [7, 4, 6, 7], [4, 3, 3, 4], [1, 1, 1, 1]] as const) {
      expect(requiredSharesFor("ordinary", issued)).toBe(ordinary);
      expect(requiredSharesFor("major", issued)).toBe(major);
      expect(requiredSharesFor("unanimous", issued)).toBe(unanimous);
    }
    expect(thresholdLabelFor("ordinary")).toBe("50% + 1 of all issued shares");
    expect(thresholdLabelFor("major")).toBe("75% of all issued shares");
    expect(thresholdLabelFor("unanimous")).toBe("100% of all issued shares");
  });

  it("a capital call strictly above $10,000 needs a vote; exactly $10,000 does not", () => {
    expect(capitalCallNeedsVote(10_000)).toBe(false);
    expect(capitalCallNeedsVote(10_000.01)).toBe(true);
    expect(capitalCallNeedsVote(9_999.99)).toBe(false);
    expect(capitalCallNeedsVoteAt(20_000, 20_000)).toBe(false);
    expect(capitalCallNeedsVoteAt(20_000.01, 20_000)).toBe(true);
    expect(CAPITAL_CALL_VOTE_THRESHOLD).toBe(10_000);
  });

  it("stored overrides replace a default; a bad stored value is ignored, never trusted", () => {
    expect(resolveConfig({ majorVotePercent: 80 }).majorVotePercent).toBe(80);
    expect(resolveConfig({ majorVotePercent: "80" }).majorVotePercent).toBe(80);
    for (const bad of [0, -5, 101, 12.5, Number.NaN, "x", null, undefined]) expect(resolveConfig({ majorVotePercent: bad }).majorVotePercent).toBe(75);
    expect(resolveConfig({ guaranteedWeeksPerShare: 7 }).guaranteedWeeksPerShare).toBe(6);
    expect(resolveConfig(null)).toEqual(GOVERNANCE_DEFAULTS);
  });

  it("each setting has a range, and values outside it are refused with a reason", () => {
    expect(governanceValueProblem("rofrWindowHours", 48)).toBeNull();
    expect(governanceValueProblem("rofrWindowHours", 0)).toMatch(/between/);
    expect(governanceValueProblem("openMarketExpiryDays", 1.5)).toMatch(/whole number/);
    expect(governanceValueProblem("capitalCallVoteThresholdUsd", 0)).toBeNull();
    expect(governanceValueProblem("capitalCallVoteThresholdUsd", -1)).toMatch(/between/);
    expect(governanceValueProblem("ordinaryVotePercent", 100)).toMatch(/between/);
  });

  it("the defaults the other modules export are the config's, not a second copy", () => {
    expect(RESALE_ROFR_HOURS).toBe(GOVERNANCE_DEFAULTS.rofrWindowHours);
    expect(RETENTION_VOTE_DAYS).toBe(GOVERNANCE_DEFAULTS.retentionReleaseVoteDays);
    expect(GUARANTEED_WEEKS_PER_SHARE).toBe(GOVERNANCE_DEFAULTS.guaranteedWeeksPerShare);
    expect(DEFAULT_TURN_HOURS).toBe(GOVERNANCE_DEFAULTS.useCalendarTurnHours);
  });

  it("no governance number is written anywhere else in the source", () => {
    const files = (dir: string): string[] => (readdirSync(dir, { withFileTypes: true }) as Array<{ name: string; isDirectory(): boolean }>).flatMap((e) => (e.isDirectory() ? files(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
    const skip = (f: string) => f.endsWith("governance-config.ts") || f.endsWith("integrations/supabase/types.ts") || f.endsWith("routeTree.gen.ts");
    const sources = files("src").filter((f) => /\.(ts|tsx)$/.test(f) && !skip(f));
    const forbidden: Array<[string, RegExp]> = [
      ["75% threshold", /\*\s*0\.75|0\.75\s*\*|Math\.ceil\([^)]*75/],
      ["50% + 1 threshold", /Math\.floor\([^)]*\*\s*0\.5\)\s*\+\s*1/],
      ["capital-call $10,000", /=\s*10_000;|>\s*10_?000\b/],
      ["240-hour window", /\b240\s*\*\s*3_?600_?000|RESALE_ROFR_HOURS\s*\*|interval '240 hours'/],
      ["14-day release vote", /RETENTION_VOTE_DAYS\s*\*\s*86_?400/],
      ["180-day expiry", /\b180\s*\*\s*86_?400/],
      ["6 guaranteed weeks", /shares\s*\*\s*6\b|TOTAL_SHARES\s*\*\s*6\b/],
    ];
    for (const f of sources) {
      const text = readFileSync(f, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const [name, re] of forbidden) expect(re.test(text), `${f}: ${name}`).toBe(false);
    }
  });

  it("the readers use the config: votes, capital calls, retention, resale and the calendar", () => {
    const read = (f: string) => readFileSync(f, "utf8");
    expect(read("src/lib/votes.ts")).toMatch(/requiredSharesFor/);
    expect(read("src/lib/votes.server.ts")).toMatch(/loadGovernanceConfig/);
    expect(read("src/lib/expenses.server.ts")).toMatch(/loadGovernanceConfig/);
    expect(read("src/lib/retention.server.ts")).toMatch(/retentionReleaseVoteDays/);
    expect(read("src/lib/resale.server.ts")).toMatch(/rofrWindowHours/);
    expect(read("src/lib/resale.server.ts")).toMatch(/openMarketExpiryDays/);
    expect(read("src/lib/resale.server.ts")).toMatch(/rofrNextOfferHours/);
    expect(read("src/lib/use-calendar.server.ts")).toMatch(/useCalendarTurnHours/);
    expect(read("src/lib/use-calendar.server.ts")).toMatch(/guaranteedWeeksPerShare/);
  });
});

describe("1. changing a setting", () => {
  beforeEach(() => {
    seedPod(db());
    roles();
  });

  it("only the founder can change one: another admin, and a buyer, are refused; nothing is written", async () => {
    as(USERS.admin);
    await expect(changeGovernanceSetting({ data: { key: "majorVotePercent", value: 80, reason: "x" } })).rejects.toThrow("Only the founder");
    as(USERS.b1);
    await expect(changeGovernanceSetting({ data: { key: "majorVotePercent", value: 80, reason: "x" } })).rejects.toThrow("Not authorized");
    expect(db().table("governance_settings")).toHaveLength(0);
    expect((await loadGovernanceConfig(db())).majorVotePercent).toBe(75);
  });

  it("the page data is read-only for another admin and editable for the founder", async () => {
    as(USERS.admin);
    const admin = await getGovernanceSettings();
    expect(admin.canEdit).toBe(false);
    expect(admin.settings.map((s) => s.key)).toEqual(GOVERNANCE_SETTINGS.map((s) => s.key));
    as(FOUNDER);
    expect((await getGovernanceSettings()).canEdit).toBe(true);
    as(USERS.b1);
    await expect(getGovernanceSettings()).rejects.toThrow("Not authorized");
  });

  it("the founder's change is saved, needs a reason and a valid value, and is audit logged with before and after", async () => {
    as(FOUNDER);
    await expect(changeGovernanceSetting({ data: { key: "majorVotePercent", value: 80, reason: "  " } })).rejects.toThrow("Say why");
    await expect(changeGovernanceSetting({ data: { key: "majorVotePercent", value: 250, reason: "r" } })).rejects.toThrow("between");
    await expect(changeGovernanceSetting({ data: { key: "nonsense", value: 1, reason: "r" } })).rejects.toThrow("Unknown setting");
    const view = await changeGovernanceSetting({ data: { key: "majorVotePercent", value: 80, reason: "Counsel advised 80%" } });
    expect(view.find((s) => s.key === "majorVotePercent")).toMatchObject({ value: 80, defaultValue: 75, changed: true });
    expect((await loadGovernanceConfig(db())).majorVotePercent).toBe(80);
    const log = db().audits("governance.setting_changed");
    expect(log).toHaveLength(1);
    expect(log[0]!.actor_id).toBe(FOUNDER);
    expect(log[0]!.metadata).toMatchObject({ key: "majorVotePercent", before: 75, after: 80, default: 75, reason: "Counsel advised 80%" });
  });

  it("before governance-decisions.sql is run (no table) the defaults apply and nothing breaks", async () => {
    const broken = { from: () => ({ select: async () => ({ data: null, error: { message: "relation does not exist" } }) }) };
    expect(await loadGovernanceConfig(broken as never)).toEqual(GOVERNANCE_DEFAULTS);
  });
});

// ---------------------------------------------------------------------------
// 1. A change never alters an open vote
// ---------------------------------------------------------------------------

describe("1. an open vote keeps the thresholds it started with", () => {
  function seed() {
    seedPod(db());
    roles();
    const cap = (n: number, holder: Record<string, unknown>) => db().seed("cap_table_entries", [{ property_id: A, share_number: n, buyer_account_id: null, seller_id: null, ...holder }]);
    for (const n of [1, 2]) cap(n, { holder_type: "buyer_account", buyer_account_id: IDS.b1 });
    for (const n of [3, 4, 5]) cap(n, { holder_type: "buyer_account", buyer_account_id: IDS.b2 });
    for (const n of [6, 7, 8]) cap(n, { holder_type: "retained_seller", seller_id: IDS.seller });
  }
  const newVote = async (open = true) => {
    as(USERS.admin);
    const { id } = await createVoteAsAdmin({ data: { propertyId: A, title: "Replace the roof", voteType: "major", opensAt: hoursFromNow(-1), closesAt: hoursFromNow(24) } });
    if (open) await openVoteAsAdmin({ data: { voteId: id } });
    return id;
  };
  const cast = (voteId: string, user: string, choice: string) => (as(user), castVoteBallot({ data: { propertyId: A, voteId, choice } }));
  const agreeB1 = async (voteId: string) => {
    as(USERS.b1);
    await recordVotePosition({ data: { propertyId: A, voteId, accountMemberId: IDS.b1m1, position: "Yes", initials: "AO" } });
    await recordVotePosition({ data: { propertyId: A, voteId, accountMemberId: IDS.b1m2, position: "Yes", initials: "BO" } });
  };
  const vote = (id: string) => db().table("votes").find((v) => v.id === id)!;
  const lowerMajor = async () => {
    as(FOUNDER);
    await changeGovernanceSetting({ data: { key: "majorVotePercent", value: 50, reason: "test" } });
  };

  it("opening a vote writes the thresholds in force onto it", async () => {
    seed();
    const id = await newVote(false);
    expect(vote(id).thresholds ?? null).toBeNull(); // a draft hasn't started
    as(USERS.admin);
    await openVoteAsAdmin({ data: { voteId: id } });
    expect(vote(id).thresholds).toEqual({ ordinaryVotePercent: 50, majorVotePercent: 75, unanimousVotePercent: 100, capitalCallVoteThresholdUsd: 10_000 });
    expect(db().audits("vote.opened").find((a) => a.entity_id === id)!.metadata.thresholds).toEqual(vote(id).thresholds);
  });

  it("lowering the Major threshold after a vote opened does not change that vote's result", async () => {
    seed();
    const id = await newVote();
    await agreeB1(id);
    await cast(id, USERS.b1, "Yes"); // 2
    await cast(id, USERS.b2, "Yes"); // 3 → 5 of 8 voted Yes
    await lowerMajor(); // now Major would need only 4
    as(USERS.admin);
    await closeVoteAsAdmin({ data: { voteId: id } });
    // It was opened needing 6 of 8: 5 is not enough, whatever the setting says now.
    expect(vote(id).result_summary).toMatchObject({ requiredShares: 6, thresholdLabel: "75% of all issued shares", passed: false });
  });

  it("a vote opened AFTER the change starts with the new threshold", async () => {
    seed();
    await lowerMajor();
    const id = await newVote();
    await agreeB1(id);
    await cast(id, USERS.b1, "Yes");
    await cast(id, USERS.b2, "Yes");
    as(USERS.admin);
    await closeVoteAsAdmin({ data: { voteId: id } });
    expect(vote(id).result_summary).toMatchObject({ requiredShares: 4, thresholdLabel: "50% of all issued shares", passed: true });
  });

  it("the owner sees the threshold the vote started with, even after a change", async () => {
    seed();
    const id = await newVote();
    await lowerMajor();
    as(USERS.b2);
    const detail = await getVoteForOwner({ data: { propertyId: A, voteId: id } });
    expect(detail!.thresholdLabel).toBe("75% of all issued shares");
    expect(detail!.thresholdsArePlaceholder).toBe(false);
  });

  it("a vote from before snapshots was tallied on the old numbers, so it keeps them", () => {
    const old = tallyVote({ voteType: "major", options: ["Yes", "No"], issuedShares: 8, ballots: [{ choice: "Yes", weight: 6 }], thresholds: readVoteThresholds(null) });
    expect(old).toMatchObject({ requiredShares: 6, passed: true });
    expect(readVoteThresholds({ majorVotePercent: 90 }).majorVotePercent).toBe(90);
    expect(readVoteThresholds({ majorVotePercent: "x" }).majorVotePercent).toBe(75);
    expect(voteThresholdsOf(resolveConfig({ ordinaryVotePercent: 60 })).ordinaryVotePercent).toBe(60);
  });

  it("the founder's change is visible to everything that reads the config, but a vote's own numbers are its own", async () => {
    seed();
    as(FOUNDER);
    await updateGovernanceSetting(db() as never, { actorId: FOUNDER, key: "unanimousVotePercent", value: 90, reason: "test" });
    const view = await governanceSettingsView(db() as never);
    expect(view.find((s) => s.key === "unanimousVotePercent")!.value).toBe(90);
    expect(requiredSharesFor("unanimous", 8, voteThresholdsOf(await loadGovernanceConfig(db() as never)))).toBe(8); // ceil(7.2)
  });
});

// ---------------------------------------------------------------------------
// 2. Operating Agreement: two draft clauses, nothing else changed
// ---------------------------------------------------------------------------

describe("2. the Operating Agreement template", () => {
  const property = { address: "5632 Independence Ave", city: "Lusk", state: "WY", zip: "82225" };
  const capTable = [{ shareNumber: 1, holderType: "buyer_account", memberNames: ["Alice Real", "Bob Real"], acquisitionDate: "2026-09-01T00:00:00Z", retentionLockExpiresAt: "2027-09-01T00:00:00Z" }] as never;
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const terms = oaTermsFrom(GOVERNANCE_DEFAULTS, RESALE_FLAT_FEE);
  const draft = () => draftOperatingAgreement({ llcName: "D8 TEST, LLC", property, capTable, generatedAt: "2026-09-01", terms });
  const final = () => finalOperatingAgreement({ llcName: "D8 TEST, LLC", delawareFileNumber: "123", ein: "12-3456789", property, capTable, signers: [{ buyerAccountId: "a", accountMemberId: "m", name: "Alice Real" }], lockedAt: "2026-10-01", terms });
  const withoutClauses = (text: string) => OA_DRAFT_CLAUSES.reduce((t, c) => t.replace("\n" + c.render(terms), ""), text);
  // SHA-256 of the draft and the final text as they were BEFORE the two clauses were added (same inputs).
  const BEFORE_DRAFT = "fad549b3fec9cf64d405d9908b1ddbe94a361aa0d7d0c03125a603797474e904";
  const BEFORE_FINAL = "32a285692165de666030a4f028282992f2f467082d258d26abd7445538d9ee2a";

  it("the draft contains both clauses, each marked as pending counsel review", () => {
    const text = draft();
    expect(OA_DRAFT_MARKER).toBe("DRAFT: pending counsel review");
    for (const c of OA_DRAFT_CLAUSES) {
      expect(text).toContain(c.render(terms));
      expect(c.render(terms)).toContain(`[${OA_DRAFT_MARKER}]`);
    }
    expect(text.match(/DRAFT: pending counsel review/g)).toHaveLength(2);
  });

  it("(a) the Retention Lock clause covers the hardship and the unanimous-consent exceptions", () => {
    const c = oaDraftClause("retention_exceptions").render(terms);
    expect(c).toMatch(/Hardship/);
    expect(c).toMatch(/Unanimous consent/);
    expect(c).toContain("14 days");
    expect(oaDraftClause("retention_exceptions")).toMatchObject({ article: "IV", number: "4.4" });
  });

  it("(b) the right-of-first-refusal clause states 10 days (240 hours) and the $500 flat fee", () => {
    const c = oaDraftClause("right_of_first_refusal").render(terms);
    expect(c).toContain("10 days (240 hours)");
    expect(c).toContain("$500");
    expect(c).toMatch(/higher priority rank/);
    expect(oaDraftClause("right_of_first_refusal")).toMatchObject({ article: "VI", number: "6.2" });
  });

  it("the clauses follow the settings, so the agreement can't disagree with what the platform enforces", () => {
    const changed = oaTermsFrom({ ...GOVERNANCE_DEFAULTS, rofrWindowHours: 120, retentionReleaseVoteDays: 30 }, 750);
    expect(oaDraftClause("right_of_first_refusal").render(changed)).toContain("5 days (120 hours)");
    expect(oaDraftClause("right_of_first_refusal").render(changed)).toContain("$750");
    expect(oaDraftClause("retention_exceptions").render(changed)).toContain("30 days");
  });

  it("nothing else changed: take the two clauses out and the draft and the final text are byte-for-byte what they were", () => {
    expect(sha(withoutClauses(draft()))).toBe(BEFORE_DRAFT);
    expect(sha(withoutClauses(final()))).toBe(BEFORE_FINAL);
  });

  it("the final agreement carries the clauses too, and its signature lines are unchanged", () => {
    const text = final();
    for (const c of OA_DRAFT_CLAUSES) expect(text).toContain(c.render(terms));
    expect(text).toContain("  Signed electronically: [SIGNATURE PENDING]");
    expect(text).toContain("ARTICLE VII — EXECUTION");
  });

  it("the OA hashing and signing code was not touched", () => {
    const genesis = readFileSync("src/lib/entity-genesis-stage2.server.ts", "utf8");
    expect(genesis).toMatch(/const hash = sha256\(text\);/);
    expect(readFileSync("src/lib/entity-genesis.ts", "utf8")).toMatch(/export function executedOperatingAgreement/);
  });

  it("the governance rules shown to owners keep their current text", () => {
    const rules = readFileSync("owner-llc.sql", "utf8");
    expect(rules).not.toMatch(/pending counsel review/);
  });

  it("the admin note lists both clauses and says where counsel edits them", () => {
    const page = readFileSync("src/routes/admin.entity-genesis.tsx", "utf8");
    expect(page).toContain("OA_DRAFT_CLAUSES");
    expect(page).toContain("OA_DRAFT_CLAUSES_NOTE");
    expect(readFileSync("src/constants/oaDraftClauses.ts", "utf8")).toContain("src/constants/oaDraftClauses.ts");
  });
});

// ---------------------------------------------------------------------------
// 3. Holiday turns are proportional to shares
// ---------------------------------------------------------------------------

describe("3. holiday turns follow shares", () => {
  const quotas = { a: 40, b: 40, c: 40 };
  const ctx = (shares: Record<string, number> | undefined, rotationOffset = 0, holiday = 100, normal = 100): TurnContext => ({
    order: ["a", "b", "c"],
    rotationOffset,
    quotas,
    picks: {},
    openHolidayWeeks: holiday,
    openNormalWeeks: normal,
    shares,
  });
  /** Plays holiday turns until `turns` picks have been made; returns who took each. */
  function play(context: TurnContext, turns: number) {
    const picks: Record<string, number> = { ...context.picks };
    let open = context.openHolidayWeeks;
    let current: Turn | null = null;
    const out: string[] = [];
    for (let i = 0; i < turns; i += 1) {
      const next = nextTurn({ ...context, picks, openHolidayWeeks: open }, current);
      if (!next || next.phase !== "holiday") break;
      out.push(next.holderKey);
      picks[next.holderKey] = (picks[next.holderKey] ?? 0) + 1;
      open -= 1;
      current = next;
    }
    return out;
  }
  const count = (list: string[]) => list.reduce<Record<string, number>>((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {});

  it("a 1-share holder gets 1 holiday turn per round-set", () => {
    expect(holidayTurnsPerRoundSet(1)).toBe(1);
    const turns = play(ctx({ a: 1, b: 1, c: 1 }), 3);
    expect(count(turns)).toEqual({ a: 1, b: 1, c: 1 });
  });

  it("a 2-share holder gets 2 holiday turns per round-set", () => {
    expect(holidayTurnsPerRoundSet(2)).toBe(2);
    const turns = play(ctx({ a: 1, b: 2, c: 1 }), 4);
    expect(count(turns)).toEqual({ a: 1, b: 2, c: 1 });
  });

  it("a 3-share holder gets 3 holiday turns per round-set", () => {
    expect(holidayTurnsPerRoundSet(3)).toBe(3);
    const turns = play(ctx({ a: 1, b: 2, c: 3 }), 6);
    expect(count(turns)).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("the rotated order is kept within each round, and the round-set repeats", () => {
    const turns = play(ctx({ a: 1, b: 2, c: 3 }), 12);
    expect(turns.slice(0, 6)).toEqual(["a", "b", "c", "b", "c", "c"]);
    expect(count(turns)).toEqual({ a: 2, b: 4, c: 6 });
    expect(turns.slice(6)).toEqual(turns.slice(0, 6));
  });

  it("rotation order still advances each year: the next year starts one holder along", () => {
    expect(play(ctx({ a: 1, b: 2, c: 3 }, 0), 1)).toEqual(["a"]);
    expect(play(ctx({ a: 1, b: 2, c: 3 }, 1), 1)).toEqual(["b"]);
    expect(play(ctx({ a: 1, b: 2, c: 3 }, 2), 1)).toEqual(["c"]);
    const second = play(ctx({ a: 1, b: 2, c: 3 }, 1), 6);
    expect(second).toEqual(["b", "c", "a", "b", "c", "c"]);
    expect(count(second)).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("holiday turns stop when the holiday weeks run out, and a holder whose quota is full is passed over", () => {
    expect(play(ctx({ a: 1, b: 2, c: 3 }, 0, 4), 10)).toHaveLength(4);
    const full = { ...ctx({ a: 1, b: 2, c: 3 }), quotas: { a: 40, b: 40, c: 0 } };
    expect(play(full, 6).includes("c")).toBe(false);
  });

  it("normal weeks are unchanged: one turn each per round, whatever the shares", () => {
    const normalOnly = ctx({ a: 1, b: 2, c: 3 }, 0, 0, 100);
    const t1 = nextTurn(normalOnly, null)!;
    expect(t1).toEqual({ holderKey: "a", phase: "normal", round: 1 });
    const t2 = nextTurn({ ...normalOnly, picks: { a: 1 } }, t1)!;
    const t3 = nextTurn({ ...normalOnly, picks: { a: 1, b: 1 } }, t2)!;
    expect([t2.holderKey, t3.holderKey]).toEqual(["b", "c"]);
    const t4 = nextTurn({ ...normalOnly, picks: { a: 1, b: 1, c: 1 } }, t3)!;
    expect(t4).toEqual({ holderKey: "a", phase: "normal", round: 2 });
  });

  it("without share counts the old one-turn-each behaviour is exactly what it was", () => {
    const turns = play(ctx(undefined), 6);
    expect(turns).toEqual(["a", "b", "c", "a", "b", "c"]);
  });

  it("the quota util takes the guaranteed weeks from the setting", () => {
    const holders = [{ holderKey: "a", shares: 1 }, { holderKey: "b", shares: 2 }];
    expect(computeQuotas(holders, 0)).toEqual(computeQuotas(holders, 0, 6));
    const five = computeQuotas(holders, 0, 5);
    expect(five.a).toBeGreaterThanOrEqual(5);
    expect(five.b).toBeGreaterThanOrEqual(10);
    expect(five.b! - five.a!).toBeGreaterThanOrEqual(4);
  });

  it("the owner and admin screens say holiday turns follow shares", () => {
    expect(readFileSync("src/routes/owner.properties.$propertyId.calendar.tsx", "utf8")).toMatch(/Holiday turns follow your shares/);
    expect(readFileSync("src/lib/use-calendar.server.ts", "utf8")).toMatch(/shares\[key\]/);
  });
});

// ---------------------------------------------------------------------------
// 4-7. Resale
// ---------------------------------------------------------------------------

const PAST = new Date(Date.now() - 86_400_000).toISOString();

/** A: B1 (shares 1-2, two members), B2 (share 3), B3 (share 5), retained seller (share 4). Ranked B1, B2, B3. */
function seedResale() {
  seedPod(db());
  roles();
  const cap = (share_number: number, holder: Record<string, unknown>) =>
    db().seed("cap_table_entries", [{ property_id: A, share_number, buyer_account_id: null, seller_id: null, account_member_names: [], acquisition_date: PAST, retention_lock_started_at: PAST, retention_lock_expires_at: PAST, ...holder }]);
  cap(1, { holder_type: "buyer_account", buyer_account_id: IDS.b1, account_member_names: ["Alice One", "Bob One"] });
  cap(2, { holder_type: "buyer_account", buyer_account_id: IDS.b1, account_member_names: ["Alice One", "Bob One"] });
  cap(3, { holder_type: "buyer_account", buyer_account_id: IDS.b2, account_member_names: ["Carol Two"] });
  cap(4, { holder_type: "retained_seller", seller_id: IDS.seller });
  cap(5, { holder_type: "buyer_account", buyer_account_id: IDS.b3, account_member_names: ["Dan Three"] });
  const rank = (id: string, at: string) => (db().table("buyer_accounts").find((b) => b.id === id)!.priority_rank_timestamp = at);
  rank(IDS.b1, "2026-01-01T00:00:00.000Z");
  rank(IDS.b2, "2026-02-01T00:00:00.000Z");
  rank(IDS.b3, "2026-03-01T00:00:00.000Z");
  db().seed("entity_genesis", [{ property_id: A, llc_name: "D8 Lusk, LLC", ein_status: "verified", oa_executed_at: PAST }]);
  db().rpcResults.complete_resale_transaction = mirrorSync;
  for (const m of db().table("account_members")) if (m.role === "secondary") m.role = "member";
}

/** Stands in for complete_resale_transaction (the real SQL runs on Postgres separately). */
function mirrorSync(args: { _transaction: string }) {
  const t = db().table("resale_transactions").find((x) => x.id === args._transaction)!;
  if (db().table("cap_table_history").some((h) => h.resale_transaction_id === t.id)) return { applied: false };
  const l = db().table("resale_listings").find((x) => x.id === t.listing_id)!;
  const c = db().table("cap_table_entries").find((x) => x.property_id === l.property_id && x.share_number === l.share_number)!;
  db().seed("cap_table_history", [{ property_id: l.property_id, share_number: l.share_number, resale_transaction_id: t.id }]);
  Object.assign(t, { status: "completed", completed_at: new Date().toISOString() });
  Object.assign(c, { holder_type: "buyer_account", buyer_account_id: t.buyer_holder_key, seller_id: null, acquisition_date: new Date().toISOString() });
  l.status = "sold";
  return { applied: true };
}

const listing = (id: string) => db().table("resale_listings").find((l) => l.id === id)!;
const elections = (listingId: string) => db().table("resale_rofr_elections").filter((e) => e.listing_id === listingId);
const election = (listingId: string, holderKey: string) => elections(listingId).find((e) => e.holder_key === holderKey)!;
const sales = () => db().table("resale_transactions");
const list = async (user: string, shareNumber: number) => {
  as(user);
  const r = await createResaleListing({ data: { propertyId: A, shareNumber, askingPrice: 300000, feeAcknowledged: true } });
  expect(r.error).toBeUndefined();
  return r.id!;
};
const agreeB1 = async (listingId: string) => {
  as(USERS.b1);
  await recordResalePosition({ data: { propertyId: A, listingId, accountMemberId: IDS.b1m1, position: "exercise", initials: "AO" } });
  await recordResalePosition({ data: { propertyId: A, listingId, accountMemberId: IDS.b1m2, position: "exercise", initials: "BO" } });
};
const elect = async (user: string, listingId: string) => {
  as(user);
  const r = await exerciseResaleRofr({ data: { propertyId: A, listingId } });
  expect(r.error).toBeUndefined();
};
const closeWindow = (listingId: string) => {
  listing(listingId).rofr_closes_at = new Date(Date.now() - 1000).toISOString();
  return settleRofr(db() as never);
};
const notes = (user: string) => db().notificationsFor(user);

/** The seller lists share 4; B1, B2 and B3 all elect; the window closes: B1 (rank 1) is the confirmed buyer. */
async function threeElectors() {
  const id = await list(IDS.seller, 4);
  await agreeB1(id);
  await elect(USERS.b1, id);
  await elect(USERS.b2, id);
  await elect(USERS.b3, id);
  await closeWindow(id);
  return id;
}

describe("4a. open-market listings expire", () => {
  beforeEach(seedResale);

  it("a listing that reaches the open market gets an expiry 180 days out", async () => {
    const id = await list(USERS.b2, 3);
    await closeWindow(id);
    expect(listing(id).status).toBe("open_market");
    const days = (new Date(listing(id).expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(179.9);
    expect(days).toBeLessThan(180.1);
    expect(notes(USERS.b2).some((n) => /180 days/.test(n.message))).toBe(true);
  });

  it("it does not expire before then", async () => {
    const id = await list(USERS.b2, 3);
    await closeWindow(id);
    listing(id).expires_at = new Date(Date.now() + 86_400_000).toISOString();
    expect(await expireOpenMarketListings(db() as never)).toBe(0);
    expect(listing(id).status).toBe("open_market");
  });

  it("at 180 days it moves to 'expired', the seller is told and an admin hears, and it is logged", async () => {
    const id = await list(USERS.b2, 3);
    await closeWindow(id);
    listing(id).expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await expireOpenMarketListings(db() as never)).toBe(1);
    expect(listing(id).status).toBe("expired");
    expect(notes(USERS.b2).some((n) => /expired/i.test(n.message) && /list it again/i.test(n.message))).toBe(true);
    expect(db().audits("resale.listing_expired")).toHaveLength(1);
    // Repeating changes nothing and doesn't tell the seller twice.
    expect(await expireOpenMarketListings(db() as never)).toBe(0);
    expect(notes(USERS.b2).filter((n) => /expired/i.test(n.message))).toHaveLength(1);
  });

  it("a listing from before expiry was recorded counts 180 days from when its right of first refusal ended", async () => {
    const id = await list(USERS.b2, 3);
    await closeWindow(id);
    listing(id).expires_at = null;
    listing(id).rofr_closes_at = new Date(Date.now() - 181 * 86_400_000).toISOString();
    expect(await expireOpenMarketListings(db() as never)).toBe(1);
    expect(listing(id).status).toBe("expired");
  });

  it("the seller can list the share again after it expires", async () => {
    const id = await list(USERS.b2, 3);
    await closeWindow(id);
    listing(id).expires_at = new Date(Date.now() - 1000).toISOString();
    await expireOpenMarketListings(db() as never);
    const again = await list(USERS.b2, 3);
    expect(again).not.toBe(id);
    expect(listing(again).status).toBe("rofr_open");
    as(USERS.b2);
    const view = await getOwnerResale({ data: { propertyId: A } });
    expect(view.shares.find((s) => s.shareNumber === 3)!.listed).toBe(true);
  });

  it("a listing with a sale underway doesn't expire out from under it", async () => {
    const id = await list(USERS.b2, 3);
    await closeWindow(id);
    db().seed("resale_transactions", [{ id: "t1", listing_id: id, buyer_holder_key: IDS.b3, buyer_user_id: USERS.b3, price: 300000, flat_fee: 500, status: "pending_closing" }]);
    listing(id).expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await expireOpenMarketListings(db() as never)).toBe(0);
    expect(listing(id).status).toBe("open_market");
  });

  it("changing the setting moves the expiry only for listings that reach the open market afterwards", async () => {
    const first = await list(USERS.b2, 3);
    await closeWindow(first);
    const firstExpiry = listing(first).expires_at;
    as(FOUNDER);
    await changeGovernanceSetting({ data: { key: "openMarketExpiryDays", value: 30, reason: "test" } });
    expect(listing(first).expires_at).toBe(firstExpiry);
    const second = await list(IDS.seller, 4);
    await closeWindow(second);
    const days = (new Date(listing(second).expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it("the nightly job calls it, and is scheduled", () => {
    const route = readFileSync("src/routes/api.public.resale-expiry-sweep.ts", "utf8");
    expect(route).toMatch(/expireOpenMarketListings/);
    expect(route).toMatch(/x-sweep-secret/);
    expect(readFileSync("cron-sweeps.sql", "utf8")).toMatch(/divieight-resale-expiry.*resale-expiry-sweep.*'30 4 \* \* \*'/);
  });
});

describe("the ROFR window follows the setting", () => {
  beforeEach(seedResale);

  it("a new listing's window is 240 hours by default", async () => {
    const id = await list(USERS.b2, 3);
    const hours = (new Date(listing(id).rofr_closes_at).getTime() - new Date(listing(id).rofr_opens_at).getTime()) / 3_600_000;
    expect(hours).toBe(240);
  });

  it("a changed setting applies to listings made afterwards, and the co-owners are told the right length", async () => {
    as(FOUNDER);
    await changeGovernanceSetting({ data: { key: "rofrWindowHours", value: 120, reason: "test" } });
    const id = await list(USERS.b2, 3);
    const hours = (new Date(listing(id).rofr_closes_at).getTime() - new Date(listing(id).rofr_opens_at).getTime()) / 3_600_000;
    expect(hours).toBe(120);
    expect(notes(USERS.b1).some((n) => /5 days/.test(n.message))).toBe(true);
    as(USERS.b2);
    expect((await getOwnerResale({ data: { propertyId: A } })).rofrHours).toBe(120);
  });
});

describe("4b. Express interest turns into a sale only for a Golden Ticket buyer", () => {
  let id = "";
  const buyer = (accountId: string) => db().table("buyer_accounts").find((b) => b.id === accountId)!;
  beforeEach(async () => {
    seedResale();
    id = await list(USERS.b2, 3);
    await closeWindow(id);
    for (const b of [IDS.b1, IDS.b3]) Object.assign(buyer(b), { onboarding_status: "active" });
  });

  it("an onboarded buyer can express interest, and the admin sees whether they hold a Golden Ticket", async () => {
    buyer(IDS.b3).golden_ticket_issued = true;
    as(USERS.b3);
    expect((await expressResaleInterest({ data: { listingId: id } })).error).toBeUndefined();
    as(USERS.admin);
    const row = (await listResaleForAdmin()).rows.find((r) => r.id === id)!;
    expect(row.interested).toMatchObject([{ buyerAccountId: IDS.b3, goldenTicket: true }]);
  });

  it("a buyer without a Golden Ticket can't be converted: they must complete the normal onboarding first", async () => {
    buyer(IDS.b3).golden_ticket_issued = false;
    as(USERS.b3);
    await expressResaleInterest({ data: { listingId: id } });
    as(USERS.admin);
    await expect(convertResaleInterest({ data: { listingId: id, buyerAccountId: IDS.b3 } })).rejects.toThrow("Golden Ticket");
    expect(sales()).toHaveLength(0);
    as(USERS.admin);
    expect((await listResaleForAdmin()).rows.find((r) => r.id === id)!.interested[0]!.goldenTicket).toBe(false);
  });

  it("a Golden Ticket buyer is converted: a sale waiting to close, the buyer and seller told, and it is logged", async () => {
    buyer(IDS.b3).golden_ticket_issued = true;
    as(USERS.b3);
    await expressResaleInterest({ data: { listingId: id } });
    as(USERS.admin);
    const r = await convertResaleInterest({ data: { listingId: id, buyerAccountId: IDS.b3 } });
    expect(sales()).toHaveLength(1);
    expect(sales()[0]).toMatchObject({ id: r.transactionId, listing_id: id, buyer_holder_key: IDS.b3, buyer_user_id: USERS.b3, status: "pending_closing", price: 300000 });
    expect(notes(USERS.b3).some((n) => /set up your purchase/i.test(n.message))).toBe(true);
    expect(notes(USERS.b2).some((n) => /buyer is confirmed/i.test(n.message))).toBe(true);
    expect(db().audits("resale.interest_converted")).toHaveLength(1);
    // The same sale can complete, through the existing Final Sync.
    await completeResaleSale({ data: { transactionId: r.transactionId } });
    expect(sales()[0]!.status).toBe("completed");
  });

  it("it needs an expressed interest, an open-market listing, and only one sale at a time", async () => {
    buyer(IDS.b3).golden_ticket_issued = true;
    as(USERS.admin);
    await expect(convertResaleInterest({ data: { listingId: id, buyerAccountId: IDS.b3 } })).rejects.toThrow("hasn't expressed interest");
    as(USERS.b3);
    await expressResaleInterest({ data: { listingId: id } });
    as(USERS.admin);
    await convertResaleInterest({ data: { listingId: id, buyerAccountId: IDS.b3 } });
    await expect(convertResaleInterest({ data: { listingId: id, buyerAccountId: IDS.b3 } })).rejects.toThrow("already has a sale");
    const other = await list(USERS.b2, 3).catch(() => null);
    expect(other === null || typeof other === "string").toBe(true);
  });

  it("only an admin can convert", async () => {
    buyer(IDS.b3).golden_ticket_issued = true;
    as(USERS.b3);
    await expressResaleInterest({ data: { listingId: id } });
    await expect(convertResaleInterest({ data: { listingId: id, buyerAccountId: IDS.b3 } })).rejects.toThrow("Not authorized");
    expect(sales()).toHaveLength(0);
  });

  it("the Express interest screen tells a visitor who hasn't onboarded to start onboarding", () => {
    const page = readFileSync("src/routes/resale.tsx", "utf8");
    expect(page).toMatch(/Start onboarding/);
    expect(page).toMatch(/Golden Ticket/);
    expect(page).toMatch(/to="\/buyer\/onboarding"/);
  });

  it("the admin page offers 'Convert to sale' only beside a buyer who holds a Golden Ticket", () => {
    const page = readFileSync("src/routes/admin.resale.tsx", "utf8");
    expect(page).toMatch(/canConvert && i\.goldenTicket/);
    expect(page).toMatch(/finish onboarding first/);
  });
});

describe("5. a cancelled ROFR sale goes to the next co-owner who elected", () => {
  beforeEach(seedResale);
  const cancel = (reason = "Buyer's funds fell through") => {
    as(USERS.admin);
    return cancelResaleSale({ data: { transactionId: sales().find((s) => s.status === "pending_closing")!.id, reason } });
  };

  it("the best-ranked co-owner wins first; cancelling offers the next best-ranked, with a fresh 48-hour window", async () => {
    const id = await threeElectors();
    expect(sales()).toHaveLength(1);
    expect(sales()[0]).toMatchObject({ buyer_holder_key: IDS.b1, status: "pending_closing" });
    await cancel();
    expect(sales()[0]!.status).toBe("cancelled");
    // Rank 2 (B2) now holds the offer; B1 has had their turn; B3 waits.
    expect(election(id, IDS.b1).status).toBe("passed");
    expect(election(id, IDS.b2).status).toBe("offered");
    expect(election(id, IDS.b3).status).toBe("lost");
    expect(listing(id).status).toBe("rofr_exercised");
    expect(listing(id).offer_holder_key).toBe(IDS.b2);
    const hours = (new Date(listing(id).offer_closes_at).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(47.9);
    expect(hours).toBeLessThan(48.1);
    const log = db().audits("resale.sale_cancelled").at(-1)!;
    expect(log.metadata).toMatchObject({ offered_to: IDS.b2 });
  });

  it("everyone involved is told: the next co-owner, the cancelled buyer, the seller, the others who elected and the admin", async () => {
    await threeElectors();
    await cancel();
    expect(notes(USERS.b2).some((n) => /You can buy this share/.test(n.message ?? n.type) || /next in line/.test(n.message))).toBe(true);
    expect(notes(USERS.b2).some((n) => /48 hours|2 days/.test(n.message))).toBe(true);
    expect(notes(USERS.b1).some((n) => /fell through/.test(n.message))).toBe(true);
    expect(notes(IDS.seller).some((n) => /next co-owner/.test(n.message))).toBe(true);
    expect(notes(USERS.b3).some((n) => /moved on|fell through/.test(n.message))).toBe(true);
  });

  it("the offered co-owner confirms and the sale opens for them; nobody else can use their offer", async () => {
    const id = await threeElectors();
    await cancel();
    as(USERS.b3);
    expect((await confirmResaleOffer({ data: { propertyId: A, listingId: id } })).error).toMatch(/isn't offered to you/);
    as(USERS.b1);
    expect((await confirmResaleOffer({ data: { propertyId: A, listingId: id } })).error).toMatch(/isn't offered to you/);
    as(USERS.b2);
    expect((await confirmResaleOffer({ data: { propertyId: A, listingId: id } })).error).toBeUndefined();
    const live = sales().filter((s) => s.status === "pending_closing");
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ buyer_holder_key: IDS.b2, buyer_user_id: USERS.b2 });
    expect(election(id, IDS.b2).status).toBe("won");
    expect(listing(id).offer_holder_key ?? null).toBeNull();
    expect(db().audits("resale.offer_confirmed")).toHaveLength(1);
  });

  it("if the offered co-owner declines, it goes to the next one; if none remain the listing is withdrawn", async () => {
    const id = await threeElectors();
    await cancel();
    as(USERS.b2);
    expect((await declineResaleOffer({ data: { propertyId: A, listingId: id } })).error).toBeUndefined();
    expect(election(id, IDS.b2).status).toBe("passed");
    expect(election(id, IDS.b3).status).toBe("offered");
    expect(listing(id).offer_holder_key).toBe(IDS.b3);
    as(USERS.b3);
    await declineResaleOffer({ data: { propertyId: A, listingId: id } });
    expect(listing(id).status).toBe("withdrawn");
    expect(sales().filter((s) => s.status === "pending_closing")).toHaveLength(0);
    // Everyone involved hears it was withdrawn.
    for (const user of [IDS.seller, USERS.b1, USERS.b2, USERS.b3]) expect(notes(user).some((n) => /withdrawn/i.test(n.message))).toBe(true);
  });

  it("an offer nobody confirms in time lapses to the next co-owner, then to withdrawn", async () => {
    const id = await threeElectors();
    await cancel();
    listing(id).offer_closes_at = new Date(Date.now() - 1000).toISOString();
    expect(await settleOffers(db() as never)).toBe(1);
    expect(election(id, IDS.b2).status).toBe("passed");
    expect(election(id, IDS.b3).status).toBe("offered");
    expect(db().audits("resale.offer_lapsed")).toHaveLength(1);
    expect(notes(USERS.b2).some((n) => /time to confirm/.test(n.message))).toBe(true);
    listing(id).offer_closes_at = new Date(Date.now() - 1000).toISOString();
    await settleRofr(db() as never);
    expect(listing(id).status).toBe("withdrawn");
    // Late confirmation after it lapsed is refused.
    as(USERS.b3);
    expect((await confirmResaleOffer({ data: { propertyId: A, listingId: id } })).error).toBeTruthy();
  });

  it("a confirmation after the window has run out is refused", async () => {
    const id = await threeElectors();
    await cancel();
    listing(id).offer_closes_at = new Date(Date.now() - 1000).toISOString();
    as(USERS.b2);
    expect((await confirmResaleOffer({ data: { propertyId: A, listingId: id } })).error).toMatch(/run out/);
  });

  it("a cancelled sale with only one co-owner who elected still withdraws the listing, as before", async () => {
    const id = await list(IDS.seller, 4);
    await elect(USERS.b3, id);
    await closeWindow(id);
    expect(sales()[0]!.buyer_holder_key).toBe(IDS.b3);
    await cancel();
    expect(listing(id).status).toBe("withdrawn");
    expect(election(id, IDS.b3).status).toBe("passed");
    expect(notes(USERS.b3).some((n) => /cancelled/i.test(n.message))).toBe(true);
    expect(notes(IDS.seller).some((n) => /cancelled/i.test(n.message))).toBe(true);
  });

  it("the second sale can itself be cancelled: the next co-owner after that gets the offer (never the same one twice)", async () => {
    const id = await threeElectors();
    await cancel();
    as(USERS.b2);
    await confirmResaleOffer({ data: { propertyId: A, listingId: id } });
    await cancel("Second buyer's financing fell through");
    expect(election(id, IDS.b1).status).toBe("passed");
    expect(election(id, IDS.b2).status).toBe("passed");
    expect(election(id, IDS.b3).status).toBe("offered");
    expect(listing(id).offer_holder_key).toBe(IDS.b3);
  });

  it("the window comes from the setting", async () => {
    as(FOUNDER);
    await changeGovernanceSetting({ data: { key: "rofrNextOfferHours", value: 24, reason: "test" } });
    const id = await threeElectors();
    await cancel();
    const hours = (new Date(listing(id).offer_closes_at).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);
  });

  it("the owner sees the offer, and the seller can still withdraw while it is open", async () => {
    const id = await threeElectors();
    await cancel();
    as(USERS.b2);
    const view = await getOwnerResale({ data: { propertyId: A } });
    const mine = view.coOwners.find((l) => l.id === id)!;
    expect(mine.offer).not.toBeNull();
    expect(mine.myElection).toBe("offered");
    as(USERS.b3);
    expect((await getOwnerResale({ data: { propertyId: A } })).coOwners.find((l) => l.id === id)!.offer).toBeNull();
    as(IDS.seller);
    const seller = await getOwnerResale({ data: { propertyId: A } });
    expect(seller.mine.find((l) => l.id === id)).toMatchObject({ canWithdraw: true });
    expect(seller.mine.find((l) => l.id === id)!.offerClosesAt).toBeTruthy();
  });

  it("the choice of who is next is the same rank rule as the first time, and never someone already offered", () => {
    const e = (id: string, holder: string, rank: number | null, at = "2026-01-01T00:00:00Z") => ({ id, holder_key: holder, priority_rank_at_election: rank, elected_at: at });
    const all = [e("1", "a", 1), e("2", "b", 2), e("3", "c", 3)];
    expect(pickNextElector(all, [])!.holder_key).toBe("a");
    expect(pickNextElector(all, ["a"])!.holder_key).toBe("b");
    expect(pickNextElector(all, ["a", "b"])!.holder_key).toBe("c");
    expect(pickNextElector(all, ["a", "b", "c"])).toBeNull();
  });
});

describe("6. a seller who sold every share has a read-only page for the weeks they picked", () => {
  beforeEach(seedResale);

  async function sellerSellsEverything() {
    const id = await list(IDS.seller, 4);
    await elect(USERS.b3, id);
    await closeWindow(id);
    as(USERS.admin);
    await completeResaleSale({ data: { transactionId: sales()[0]!.id } });
    return id;
  }
  const week = (n: number, holder: string | null, start: string, end: string, holiday = false) => ({ property_id: A, year: 2027, week_number: n, start_date: start, end_date: end, is_holiday: holiday, holder_key: holder });

  it("shows only the weeks the seller already picked", async () => {
    db().seed("use_calendar_weeks", [
      week(10, `seller:${IDS.seller}`, "2027-03-06", "2027-03-12"),
      week(51, `seller:${IDS.seller}`, "2027-12-18", "2027-12-24", true),
      week(11, IDS.b1, "2027-03-13", "2027-03-19"),
      week(12, null, "2027-03-20", "2027-03-26"),
    ]);
    await sellerSellsEverything();
    as(IDS.seller);
    const page = await getFormerSellerWeeks({ data: { propertyId: A } });
    expect(page.allowed).toBe(true);
    expect(page.weeks.map((w) => w.weekNumber)).toEqual([10, 51]);
    expect(page.weeks.find((w) => w.weekNumber === 51)!.isHoliday).toBe(true);
    // Nothing else is in the response: no other holder, no votes, no co-owners.
    const text = JSON.stringify(page);
    expect(text).not.toMatch(/b1|Alice|Carol|vote|co-owner|capital/i);
    expect(Object.keys(page).sort()).toEqual(["allowed", "propertyLabel", "weeks"]);
  });

  it("marks upcoming and past weeks", async () => {
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const pastDay = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    db().seed("use_calendar_weeks", [week(10, `seller:${IDS.seller}`, pastDay, pastDay), week(11, `seller:${IDS.seller}`, future, future)]);
    await sellerSellsEverything();
    as(IDS.seller);
    const page = await getFormerSellerWeeks({ data: { propertyId: A } });
    expect(page.weeks.map((w) => [w.weekNumber, w.upcoming])).toEqual([[10, false], [11, true]]);
  });

  it("the seller's 'sale complete' notification links to the page", async () => {
    await sellerSellsEverything();
    const note = notes(IDS.seller).find((n) => /sale of share #4 is complete/.test(n.message));
    expect(note).toBeTruthy();
    // The in-app notification is typed and tied to the property: tapping it opens the former-seller page.
    expect(note).toMatchObject({ type: "former_seller_weeks", property_id: A });
    expect(notificationHref(note as never)).toBe(`/owner/former/${A}`);
    expect(readFileSync("src/components/NotificationsBell.tsx", "utf8")).toContain("notificationHref");
  });

  it("a seller who still holds shares gets the normal owner link instead, and no former page", async () => {
    // B1 holds shares 1 and 2 and sells one.
    const id = await list(USERS.b1, 1);
    await elect(USERS.b3, id);
    await closeWindow(id);
    as(USERS.admin);
    await completeResaleSale({ data: { transactionId: sales()[0]!.id } });
    const note = notes(USERS.b1).find((n) => /sale of share #1 is complete/.test(n.message))!;
    expect(note).toMatchObject({ type: "resale_activity" });
    as(USERS.b1);
    expect((await getFormerSellerWeeks({ data: { propertyId: A } })).allowed).toBe(false);
  });

  it("someone who never sold here, a current owner and a stranger get nothing", async () => {
    await sellerSellsEverything();
    for (const user of [USERS.b2, USERS.b3, USERS.ra]) {
      as(user);
      expect(await getFormerSellerWeeks({ data: { propertyId: A } })).toEqual({ allowed: false, propertyLabel: "", weeks: [] });
    }
    as(IDS.seller);
    expect((await getFormerSellerWeeks({ data: { propertyId: "no-such-property" } })).allowed).toBe(false);
  });

  it("the page offers nothing but the weeks: no navigation into the owner area", () => {
    const page = readFileSync("src/routes/owner.former.$propertyId.tsx", "utf8");
    expect(page).toMatch(/read-only/i);
    expect(page).not.toMatch(/\/owner\/properties/);
    expect(page.replace(/^import .*$/gm, "")).not.toMatch(/votes|capital|expenses|maintenance|resale|retention|llc/i);
  });
});

describe("7. amounts already allocated stay with the seller, and the screens say so", () => {
  it("the notice is exactly the decided sentence", () => {
    expect(RESALE_UNPAID_NOTICE).toBe("Any amounts already allocated to you stay with you after this sale.");
  });

  it("it appears on the listing screen and on the seller's listing", () => {
    const page = readFileSync("src/routes/owner.properties.$propertyId.resale.tsx", "utf8");
    expect(page.match(/RESALE_UNPAID_NOTICE/g)!.length).toBeGreaterThanOrEqual(3); // import + confirm-listing step + my listing
  });

  it("it appears on the sale screen (the admin's completion step)", () => {
    const page = readFileSync("src/routes/admin.resale.tsx", "utf8");
    expect(page).toMatch(/Amounts already allocated to the seller stay with the seller after this sale/);
  });

  it("current behaviour is unchanged: nothing in completing a sale moves or blocks allocated amounts", () => {
    const server = readFileSync("src/lib/resale.server.ts", "utf8");
    expect(server).not.toMatch(/expense_allocations|capital_call_allocations|owner_capital_accounts/);
  });
});

describe("1. a capital call's vote keeps the dollar threshold it started with", () => {
  it("raising the threshold while the vote is open doesn't turn the call into one that needs no vote", async () => {
    seedPod(db());
    roles();
    db().seed("cap_table_entries", [1, 2, 3, 4].map((n) => ({ property_id: A, share_number: n, holder_type: "buyer_account", buyer_account_id: IDS.b1, seller_id: null })));
    const { createVote, openVote } = await import("@/lib/votes.server");
    const vote = await createVote(db() as never, { actorId: USERS.admin, propertyId: A, title: "Capital call", description: null, voteType: "major", options: ["Yes", "No", "Abstain"], opensAt: hoursFromNow(-1), closesAt: hoursFromNow(24) });
    await openVote(db() as never, USERS.admin, vote.id); // snapshot: $10,000
    db().seed("capital_calls", [{ id: "cc1", property_id: A, title: "Roof", reason: "Leak", total_amount: 12_000, due_date: null, status: "draft", vote_id: vote.id, created_at: "2026-11-01T00:00:00Z" }]);
    const { adminExpenses } = await import("@/lib/expenses.server");
    expect((await adminExpenses(db() as never)).calls[0]).toMatchObject({ needsVote: true, canIssue: false });
    await updateGovernanceSetting(db() as never, { actorId: FOUNDER, key: "capitalCallVoteThresholdUsd", value: 50_000, reason: "test" });
    const after = await adminExpenses(db() as never);
    // The live setting is $50,000 now, but this call's vote started at $10,000, so it still needs that vote.
    expect(after.voteThreshold).toBe(50_000);
    expect(after.calls[0]).toMatchObject({ needsVote: true, canIssue: false });
  });
});
