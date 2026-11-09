/** Eligibility Decision Page: the words exactly as the copy file has them, nothing hidden, the box, and one row per member. */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import { decisionPageCopy as copy, DECISION_PAGE_SPEC_VERSION, STANDARD_VERSION } from "@/constants/eligibilityCopy";
import { EligibilityStandardContent } from "@/components/EligibilityStandard";
import { acknowledgeEligibilityStandard, listReadTheStandardForAdmin } from "@/lib/eligibility-standard.functions";
import { buyerRedirect } from "@/lib/buyer";

const html = () => renderToStaticMarkup(createElement(EligibilityStandardContent, { onContinue: () => undefined }));

const decode = (s: string) =>
  s
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** Every text node on the page, in document order. */
const renderedText = () =>
  html()
    .split(/<[^>]+>/)
    .map(decode)
    .filter((t) => t.length > 0);

/** The copy file, flattened in the order the 11 blocks must appear. */
const p1 = copy.partOne;
const expected = [
  copy.wordmark,
  copy.eyebrow,
  copy.heading,
  copy.definition,
  copy.doesAndDoesNot.heading,
  copy.doesAndDoesNot.p1,
  copy.doesAndDoesNot.p2,
  p1.label,
  p1.heading,
  p1.intro,
  p1.A.title,
  p1.A.lead,
  ...p1.A.items,
  p1.B.title,
  p1.B.lead,
  ...p1.B.items,
  p1.B.tail,
  p1.C.title,
  p1.C.lead,
  ...p1.C.items,
  p1.D.title,
  p1.D.body,
  p1.E.title,
  p1.E.body,
  p1.F.title,
  p1.F.body,
  p1.G.title,
  p1.G.body,
  copy.partTwo.label,
  copy.partTwo.heading,
  copy.partTwo.body,
  copy.importantNote.heading,
  copy.importantNote.p1,
  copy.importantNote.p2,
  copy.acknowledgement,
  copy.continueLabel,
  copy.footer[0],
  copy.footer[1],
];

describe("the words", () => {
  it("the copy file is the client's document, byte for byte", () => {
    // Changing a word in eligibilityCopy.ts is changing the client's document: this fails until it is agreed.
    const hash = createHash("sha256").update(readFileSync("src/constants/eligibilityCopy.ts")).digest("hex");
    expect(hash).toBe("beb54afa9f4d9c5aae052bd329b2b6d841321ace32fe7bfa9cb7925e91144b8c");
  });

  it("the rendered text is the copy file, string for string, in order", () => {
    expect(renderedText()).toEqual(expected);
  });

  it("character by character, with nothing added between", () => {
    const got = renderedText().join("\u0000");
    const want = expected.join("\u0000");
    expect(got.length).toBe(want.length);
    for (let i = 0; i < want.length; i += 1) {
      if (got[i] !== want[i]) throw new Error(`First difference at character ${i}: ${JSON.stringify(got.slice(i, i + 40))} vs ${JSON.stringify(want.slice(i, i + 40))}`);
    }
  });

  it("every string in the copy file appears; none is left out", () => {
    const strings: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === "string") strings.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(copy);
    expect([...strings].sort()).toEqual([...expected].sort());
  });

  it("the only version number is the Standard's, in the eyebrow", () => {
    const text = renderedText().join(" ");
    expect(copy.eyebrow).toContain(STANDARD_VERSION);
    expect(text.match(/\d+\.\d+/g)).toEqual([STANDARD_VERSION]);
  });

  it("one h1, and it is the heading", () => {
    const h1s = html().match(/<h1[^>]*>([^<]*)<\/h1>/g) ?? [];
    expect(h1s).toHaveLength(1);
    expect(decode(h1s[0]!.replace(/<[^>]+>/g, ""))).toBe(copy.heading);
  });
});

describe("nothing hidden, nothing pre-ticked", () => {
  it("no collapsed, hidden or disclosure element anywhere", () => {
    const markup = html();
    expect(markup).not.toMatch(/<details|<summary|<dialog|aria-expanded|aria-hidden="true"[^>]*>[^<]+<|\shidden(\s|>|=)|role="tab|role="dialog|data-state="closed"/);
    expect(markup).not.toMatch(/display:\s*none|visibility:\s*hidden|line-clamp|max-h-|overflow-hidden|sr-only|collapse/);
  });

  it("the important note is set apart and not in smaller type", () => {
    const note = html().match(/<aside[^>]*>[\s\S]*?<\/aside>/)?.[0] ?? "";
    expect(note).toContain(copy.importantNote.heading);
    expect(note).not.toMatch(/text-(xs|sm)\b/);
  });

  it("the box starts unticked and Continue starts blocked, on every render", () => {
    for (let i = 0; i < 3; i += 1) {
      const markup = html();
      const box = markup.match(/<input[^>]*type="checkbox"[^>]*>/)![0];
      expect(box).not.toMatch(/checked/);
      const button = markup.match(/<button[^>]*>[^<]*<\/button>/)![0];
      expect(button).toMatch(/ disabled(=""|s|>)/);
      expect(button).toContain(copy.continueLabel);
    }
  });

  it("no navigation, progress indicator or step count", () => {
    const markup = html();
    expect(markup).not.toMatch(/<nav|<ol|role="progressbar"|Step \d/);
  });
});

describe("the acknowledgement record", () => {
  const db = () => harness.db;
  const ack = (user: string, memberId: string) => {
    harness.userId = user;
    return acknowledgeEligibilityStandard({ data: { actingMemberId: memberId } });
  };
  const rows = () => db().table("eligibility_page_acknowledgements");

  it("one row per member, each with both versions, the IP and the browser; the second member is still to go", async () => {
    seedPod(db());
    expect(await ack(USERS.b1, IDS.b1m1)).toEqual({ remaining: 1 });
    expect(await ack(USERS.b1, IDS.b1m2)).toEqual({ remaining: 0 });
    expect(rows()).toHaveLength(2);
    for (const r of rows()) {
      expect(r).toMatchObject({ buyer_account_id: IDS.b1, standard_version: STANDARD_VERSION, page_spec_version: DECISION_PAGE_SPEC_VERSION, ip: "203.0.113.7" });
      expect(r.acknowledged_at).toBeTruthy();
    }
    expect(rows().map((r) => r.account_member_id).sort()).toEqual([IDS.b1m1, IDS.b1m2].sort());
  });

  it("reading it again keeps one row per member, the first one", async () => {
    seedPod(db());
    await ack(USERS.b1, IDS.b1m1);
    const first = rows()[0]!.acknowledged_at;
    await ack(USERS.b1, IDS.b1m1);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.acknowledged_at).toBe(first);
  });

  it("another account's member, or a removed member, is refused", async () => {
    seedPod(db());
    await expect(ack(USERS.b1, IDS.b2m1)).rejects.toThrow("isn't on your account");
    db().table("account_members").find((m) => m.id === IDS.b1m2)!.status = "removed";
    await expect(ack(USERS.b1, IDS.b1m2)).rejects.toThrow("isn't on your account");
    expect(rows()).toEqual([]);
  });

  it("it is recorded as reading the Standard, never as a declaration", async () => {
    seedPod(db());
    await ack(USERS.b1, IDS.b1m1);
    const audit = db().audits("buyer.eligibility_standard_read")[0]!;
    expect(audit.metadata).toMatchObject({ record: "read_the_standard", acted_by_member_id: IDS.b1m1 });
    expect(JSON.stringify([rows(), audit])).not.toMatch(/declar/i);
    harness.userId = USERS.b1;
    await expect(listReadTheStandardForAdmin({ data: { accountIds: [IDS.b1] } })).rejects.toThrow("Not authorized");
    harness.userId = USERS.admin;
    expect(await listReadTheStandardForAdmin({ data: { accountIds: [IDS.b1] } })).toHaveLength(1);
  });

  it("sits after the persona survey and before the agreement", () => {
    expect(buyerRedirect("payment_pending")).toBe("/buyer/onboarding/eligibility");
    expect(buyerRedirect("lifestyle_survey_pending")).toBe("/buyer/onboarding/lifestyle");
  });
});
