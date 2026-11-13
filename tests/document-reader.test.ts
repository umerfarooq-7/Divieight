/** Document access stages: the reader rules (contents, search, cross-references, text size), the documents themselves, and where the links and screens are. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  MIN_FONT_PX,
  clampScale,
  countMatches,
  fontPx,
  highlight,
  linkReferences,
  parseBlocks,
  reachedEnd,
  stepScale,
  tableOfContents,
  downloadFileName,
} from "@/lib/document-reader";
import { TERMS_EFFECTIVE, TERMS_TEXT, TERMS_VERSION } from "@/lib/terms";
import { buildListingAgreement, buildPRA, hashDocument, LISTING_VERSION, PRA_VERSION } from "@/lib/legal-documents";
import { renderTextPdf } from "@/lib/simple-pdf";

const src = (f: string) => readFileSync(f, "utf8");

describe("the table of contents", () => {
  it("every numbered section of the Terms is a heading with an anchor, including section 11", () => {
    const toc = tableOfContents(parseBlocks(TERMS_TEXT));
    const ids = toc.map((t) => t.id);
    expect(ids).toContain("section-11");
    expect(ids).toContain("section-1");
    expect(toc.find((t) => t.id === "section-11")!.label).toMatch(/ELECTRONIC SIGNATURES/);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("the PRA and the Listing Agreement have their sections too", () => {
    const pra = tableOfContents(parseBlocks(buildPRA("Alice One", { intent: "personal_use", primary_target_market: "Lusk, WY" })));
    expect(pra.filter((t) => /^section-\d+$/.test(t.id))).toHaveLength(12);
    const listing = tableOfContents(parseBlocks(buildListingAgreement({ full_name: "Sam Seller", exit_type: "full_exit", retained_shares: 0 }, null)));
    expect(listing.filter((t) => /^section-\d+$/.test(t.id))).toHaveLength(12);
  });
  it("a sentence that merely starts with a number is not a heading", () => {
    const toc = tableOfContents(parseBlocks("1. PURPOSE\n2 apples are the Buyer's right to keep until the end of the term."));
    expect(toc.map((t) => t.id)).toEqual(["section-1"]);
  });
});

describe("search", () => {
  it("counts and highlights every match, case-insensitively; one character matches nothing", () => {
    expect(countMatches(TERMS_TEXT, "electronic")).toBeGreaterThanOrEqual(3);
    expect(countMatches(TERMS_TEXT, "e")).toBe(0);
    const segs = highlight("The Platform and the platform", "platform");
    expect(segs.filter((s) => s.hit)).toHaveLength(2);
    expect(segs.map((s) => s.text).join("")).toBe("The Platform and the platform");
  });
  it("special characters in the query are plain text", () => {
    expect(() => highlight("a (b) [c] $5.00", "(b)")).not.toThrow();
    expect(countMatches("price $5.00 (USD)", "$5.00")).toBe(1);
  });
});

describe("live cross-references between documents", () => {
  const all = { terms: true, pra: true, operatingAgreement: "/buyer/operating-agreement-review" };
  const link = (line: string, t = all) => linkReferences([{ text: line }], t).filter((s) => s.href);
  it("PRA to T&C section 11, and back", () => {
    expect(link("see Section 11 of the divieight Terms and Conditions.")[0]).toMatchObject({ href: "/terms#section-11" });
    expect(link("Terms and Conditions, Section 4")[0]).toMatchObject({ href: "/terms#section-4" });
    expect(link("this is the same as Section 11 of the Priority Reservation Agreement.")[0]).toMatchObject({ href: "/buyer/onboarding/pra-review#section-11" });
  });
  it("the PRA text really carries the pointer to T&C section 11, and the Terms really carry section 11", () => {
    const pra = buildPRA("Alice One", null);
    expect(link(pra.split("\n").find((l) => /Terms and Conditions/.test(l))!)[0]).toMatchObject({ href: "/terms#section-11" });
    expect(TERMS_TEXT).toMatch(/\n11\. ELECTRONIC SIGNATURES AND RECORDS/);
  });
  it("a reference to a document that does not exist for the reader stays plain text", () => {
    expect(link("Section 11 of the Terms and Conditions", { terms: false, pra: false })).toEqual([]);
    expect(link("the Operating Agreement", { terms: true, pra: false })).toEqual([]);
    expect(link("the Operating Agreement")[0]).toMatchObject({ href: "/buyer/operating-agreement-review" });
  });
  it("text around the link is kept exactly", () => {
    const segs = linkReferences([{ text: "As in Section 11 of the Terms and Conditions, you agree." }], all);
    expect(segs.map((s) => s.text).join("")).toBe("As in Section 11 of the Terms and Conditions, you agree.");
  });
});

describe("accessibility: text size", () => {
  it("never goes below 14px, and scales up to double", () => {
    expect(MIN_FONT_PX).toBe(14);
    expect(fontPx(100)).toBe(14);
    expect(fontPx(50)).toBe(14);
    expect(fontPx(200)).toBe(28);
  });
  it("steps through the scales and stays inside them", () => {
    expect(stepScale(100, -1)).toBe(100);
    expect(stepScale(100, 1)).toBe(115);
    expect(stepScale(200, 1)).toBe(200);
    expect(clampScale("garbage")).toBe(100);
    expect(clampScale(137)).toBe(130);
  });
  it("the reader sets a 14px floor, a focusable keyboard-scrollable region, labelled controls and live regions", () => {
    const s = src("src/components/DocumentReader.tsx");
    expect(s).toContain("fontPx(scale)");
    expect(s).toContain("tabIndex={0}");
    expect(s).toContain('role="region"');
    expect(s).toContain('aria-label="Smaller text"');
    expect(s).toContain('aria-label="Larger text"');
    expect(s).toContain('aria-label="Table of contents"');
    expect(s).toContain('aria-live="polite"');
    expect(s).toContain("focus-visible:outline");
    expect(s).not.toMatch(/text-\[(?:[0-9]|1[0-3])px\]/);
  });
});

describe("reaching the bottom", () => {
  it("counts within a few pixels of the end, and a document that fits counts as read", () => {
    expect(reachedEnd({ scrollTop: 0, clientHeight: 400, scrollHeight: 1200 })).toBe(false);
    expect(reachedEnd({ scrollTop: 795, clientHeight: 400, scrollHeight: 1200 })).toBe(true);
    expect(reachedEnd({ scrollTop: 0, clientHeight: 400, scrollHeight: 404 })).toBe(true);
  });
});

describe("the documents themselves", () => {
  it("the same inputs always give the same text and the same hash (the Effective Date is the template's, not today's)", () => {
    const buyer = { intent: "personal_use", primary_target_market: "Lusk, WY" };
    expect(buildPRA("Alice One", buyer)).toBe(buildPRA("Alice One", buyer));
    expect(hashDocument(buildPRA("Alice One", buyer))).toBe(hashDocument(buildPRA("Alice One", buyer)));
    expect(hashDocument(buildPRA("Bob One", buyer))).not.toBe(hashDocument(buildPRA("Alice One", buyer)));
    expect(buildPRA("Alice One", buyer)).toContain(`Document Version: ${PRA_VERSION}`);
    expect(buildListingAgreement(null, null)).toContain(`Document Version: ${LISTING_VERSION}`);
  });
  it("the Terms carry a version and an effective date", () => {
    expect(TERMS_TEXT).toContain(`Document Version: ${TERMS_VERSION}`);
    expect(TERMS_TEXT).toContain(`Effective Date: ${TERMS_EFFECTIVE}`);
  });
  it("a draft PDF of any document can be made in the browser, and has a sensible name", () => {
    const bytes = renderTextPdf(TERMS_TEXT, "Terms");
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe("%PDF-");
    expect(downloadFileName("Terms and Conditions", "1.0")).toBe("terms-and-conditions-1.0.pdf");
  });
});

describe("where the screens and links are", () => {
  it("/terms is public: no sign-in guard, no redirect", () => {
    const s = src("src/routes/terms.tsx");
    expect(s).toContain('createFileRoute("/terms")');
    expect(s).not.toMatch(/useAuth|beforeLoad|supabase|navigate\(/);
    expect(s).toContain("DocumentReader");
  });
  it("the Terms are linked from the footer, every registration screen, the portals and the menu", () => {
    expect(src("src/components/SiteFooter.tsx")).toContain('to="/terms"');
    expect(src("src/components/NavBar.tsx")).toContain('to="/terms"');
    expect(src("src/routes/agent.tsx")).toContain('to="/terms"');
    expect(src("src/routes/broker.tsx")).toContain('to="/terms"');
    for (const f of ["buyer.register", "register", "agent.register", "broker.register"]) expect(src(`src/routes/${f}.tsx`), f).toContain("<TermsNotice />");
    expect(src("src/components/TermsNotice.tsx")).toContain('href="/terms"');
  });
  it("the Pre-Payment Review sits after the Eligibility Decision page and before payment", () => {
    expect(src("src/routes/buyer.onboarding.eligibility.tsx")).toContain('next="/buyer/onboarding/pra-review"');
    expect(src("src/routes/buyer.onboarding.pra-review.tsx")).toContain("/buyer/onboarding/payment");
  });
  it("payment is disabled until the Pre-Payment Review is acknowledged, on the screen and on the server", () => {
    expect(src("src/routes/buyer.onboarding.payment.tsx")).toContain("const canPay = reviewed && scrolledEnd && acknowledged && nonRefundable;");
    expect(src("src/utils/payments.functions.ts")).toContain("assertPrePaymentReview");
  });
  it("the Pre-Payment screen cannot be acknowledged before the bottom is reached, and the checkbox is disabled until then", () => {
    const s = src("src/routes/buyer.onboarding.pra-review.tsx");
    expect(s).toContain("disabled={!reachedEnd}");
    expect(s).toContain("disabled={!reachedEnd || !ticked || saving}");
  });
  it("each platform document has its own Pre-Signing Review screen, separate from its signing screen", () => {
    for (const [route, path] of [
      ["buyer.operating-agreement-review", "/buyer/operating-agreement-review"],
      ["onboarding.agreement-review", "/onboarding/agreement-review"],
      ["agent.document-review.$id", "/agent/document-review/$id"],
      ["buyer.commission-review.$id", "/buyer/commission-review/$id"],
    ] as const) {
      const s = src(`src/routes/${route}.tsx`);
      expect(s, route).toContain(`createFileRoute("${path}")`);
      expect(s, route).toContain("PreSigningReview");
    }
    expect(src("src/components/PreSigningReview.tsx")).toContain("Nothing is signed on this screen");
  });
  it("each signing screen shows the exact text in the reader with the full stored hash, and links back to the review", () => {
    expect(src("src/routes/buyer.onboarding.payment.tsx")).toMatch(/<DocumentReader[\s\S]*hash=\{documentHash\}/);
    expect(src("src/routes/onboarding.agreement.tsx")).toMatch(/<DocumentReader[\s\S]*hash=\{documentHash\}/);
    expect(src("src/routes/buyer.operating-agreement.tsx")).toMatch(/<DocumentReader[\s\S]*hash=\{a\.documentHash\}/);
    expect(src("src/routes/agent.documents.$id.tsx")).toMatch(/<DocumentReader[\s\S]*hash=\{doc\.hash\}/);
    expect(src("src/routes/buyer.authorizations.$id.tsx")).toMatch(/<DocumentReader[\s\S]*hash=\{item\.instrument_hash\}/);
    for (const f of ["onboarding.agreement", "buyer.operating-agreement", "agent.documents.$id", "buyer.authorizations.$id"]) expect(src(`src/routes/${f}.tsx`), f).toContain("Pre-Signing Review");
  });
  it("the signature mechanisms were not touched: signing still goes through the same functions", () => {
    expect(src("src/routes/buyer.onboarding.payment.tsx")).toContain("signMemberDocumentFn");
    expect(src("src/routes/buyer.operating-agreement.tsx")).toContain("signMyOperatingAgreement");
    expect(src("src/routes/agent.documents.$id.tsx")).toContain("signReferralAgreement");
  });
  it("Member Documents exists for buyers, sellers and professionals", () => {
    expect(src("src/routes/buyer.documents.tsx")).toContain('<MemberDocuments role="buyer" />');
    expect(src("src/routes/seller.documents.tsx")).toContain('<MemberDocuments role="seller" />');
    expect(src("src/routes/agent.executed-documents.tsx")).toContain('<MemberDocuments role="professional" />');
    const m = src("src/components/MemberDocuments.tsx");
    for (const l of ["Version executed", "Signed by", "Audit Vault reference", "Download executed PDF"]) expect(m, l).toContain(l);
  });
});
