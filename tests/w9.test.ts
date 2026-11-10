/** Buyer W-9: one per member, the TIN encrypted with AES-256-GCM, never returned or logged in full. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { harness } from "./setup";
import { seedPod, IDS, USERS, steps } from "./fixtures";
import { getMyW9, submitW9Fn, decryptW9TinForTaxExport } from "@/lib/member-steps.functions";
import { getMyAccountMembers } from "@/lib/account-members.functions";
import { MissingEncryptionKeyError, assertEncryptionKey, decryptPii, encryptPii } from "@/lib/pii-crypto.server";
import { maskedTin, normalizeTin } from "@/lib/w9";
import { evaluateGoldenTicket } from "@/lib/golden-ticket";

const KEY = randomBytes(32).toString("base64");
const TIN = "123-45-6789";
const DIGITS = "123456789";
const db = () => harness.db;
const w9s = () => db().table("member_w9");
const secrets = () => db().table("member_w9_tin_secrets");

beforeEach(() => {
  vi.stubEnv("W9_TIN_ENCRYPTION_KEY", KEY);
  seedPod(db());
  for (const m of db().table("account_members")) Object.assign(m, { status: "active", role: m.role === "secondary" ? "member" : m.role });
});
afterEach(() => vi.unstubAllEnvs());

const file = (memberId: string, o: Partial<{ tin: string; tinKind: string; signedName: string; legalName: string; user: string }> = {}) => {
  harness.userId = o.user ?? USERS.b1;
  const name = db().table("account_members").find((m) => m.id === memberId)!.full_name as string;
  return submitW9Fn({
    data: { actingMemberId: memberId, legalName: o.legalName ?? name, taxClassification: "individual", address: "1 Main St, Lusk, WY 82225", tinKind: o.tinKind ?? "ssn", tin: o.tin ?? TIN, signedName: o.signedName ?? name },
  });
};

describe("encryption (AES-256-GCM)", () => {
  it("round trip", () => {
    const sealed = encryptPii(DIGITS, "row-1");
    expect(sealed.key_version).toBe(1);
    expect(sealed.ciphertext).not.toContain(DIGITS);
    expect(decryptPii(sealed, "row-1")).toBe(DIGITS);
  });

  it("a fresh iv every time: the same TIN never gives the same ciphertext", () => {
    expect(encryptPii(DIGITS, "r").ciphertext).not.toBe(encryptPii(DIGITS, "r").ciphertext);
  });

  it("tampering is detected: ciphertext, tag, iv, or the row it was bound to", () => {
    const sealed = encryptPii(DIGITS, "row-1");
    const flip = (b64: string) => {
      const buf = Buffer.from(b64, "base64");
      buf[0] = buf[0]! ^ 0xff;
      return buf.toString("base64");
    };
    expect(() => decryptPii({ ...sealed, ciphertext: flip(sealed.ciphertext) }, "row-1")).toThrow();
    expect(() => decryptPii({ ...sealed, auth_tag: flip(sealed.auth_tag) }, "row-1")).toThrow();
    expect(() => decryptPii({ ...sealed, iv: flip(sealed.iv) }, "row-1")).toThrow();
    expect(() => decryptPii(sealed, "row-2")).toThrow();
  });

  it("a missing or malformed key refuses; there is no plaintext fallback", () => {
    vi.stubEnv("W9_TIN_ENCRYPTION_KEY", "");
    expect(() => assertEncryptionKey()).toThrow(MissingEncryptionKeyError);
    expect(() => encryptPii(DIGITS, "r")).toThrow(MissingEncryptionKeyError);
    vi.stubEnv("W9_TIN_ENCRYPTION_KEY", Buffer.from("too short").toString("base64"));
    expect(() => encryptPii(DIGITS, "r")).toThrow(MissingEncryptionKeyError);
  });

  it("an old key version still decrypts after a rotation", () => {
    const sealed = encryptPii(DIGITS, "r");
    vi.stubEnv("W9_TIN_ENCRYPTION_KEY_V2", randomBytes(32).toString("base64"));
    expect(decryptPii(sealed, "r")).toBe(DIGITS);
  });
});

describe("TIN format", () => {
  it("9 digits as an SSN or an EIN, dashes and spaces ignored", () => {
    expect(normalizeTin("123-45-6789", "ssn")).toBe(DIGITS);
    expect(normalizeTin(" 12 3456789", "ein")).toBe("123456789");
    for (const bad of ["12345678", "1234567890", "abc-de-fghi", ""]) expect(() => normalizeTin(bad, "ssn")).toThrow();
    for (const bad of ["000-12-3456", "666-12-3456", "900-12-3456", "123-00-4567", "123-45-0000"]) expect(() => normalizeTin(bad, "ssn")).toThrow("valid Social Security");
    expect(() => normalizeTin("00-1234567", "ein")).toThrow("valid Employer");
  });

  it("an error never echoes the TIN", () => {
    for (const bad of ["123-45-678", "000-12-3456"]) {
      try {
        normalizeTin(bad, "ssn");
      } catch (e) {
        expect((e as Error).message).not.toMatch(/\d{3}/);
      }
    }
  });

  it("shows only the last four", () => {
    expect(maskedTin("6789", "ssn")).toBe("•••-••-6789");
    expect(maskedTin("6789", "ein")).toBe("••-•••6789");
  });
});

describe("one W-9 per member, TIN stored encrypted, never returned in full", () => {
  it("stores the TIN as ciphertext and returns only the last four", async () => {
    const r = await file(IDS.b1m1);
    expect(r.w9).toMatchObject({ tin_last4: "6789", tin_kind: "ssn", signed_name: "Alice One" });
    expect(JSON.stringify(r)).not.toContain(DIGITS);
    expect(JSON.stringify(r)).not.toMatch(/ciphertext|auth_tag|iv"/);
    // The W-9 row holds no TIN; the secret row holds only ciphertext.
    expect(JSON.stringify(w9s())).not.toContain(DIGITS);
    expect(secrets()).toHaveLength(1);
    expect(JSON.stringify(secrets())).not.toContain(DIGITS);
    expect(secrets()[0]).toMatchObject({ account_member_id: IDS.b1m1, key_version: 1, w9_id: r.w9.id });
    expect(decryptPii(secrets()[0] as never, `member_w9:${r.w9.id}`)).toBe(DIGITS);
  });

  it("reading it back never returns the TIN either", async () => {
    await file(IDS.b1m1);
    harness.userId = USERS.b1;
    const back = await getMyW9({ data: { actingMemberId: IDS.b1m1 } });
    expect(back.w9).toMatchObject({ tin_last4: "6789" });
    expect(JSON.stringify(back)).not.toContain(DIGITS);
    expect(Object.keys(back.w9!)).not.toContain("tin");
  });

  it("the TIN, even its last four, is never in the audit trail or in logs", async () => {
    const spy = vi.spyOn(console, "log");
    const err = vi.spyOn(console, "error");
    await file(IDS.b1m1);
    const audit = JSON.stringify(db().audits("buyer.w9_submitted"));
    expect(audit).not.toContain(DIGITS);
    expect(audit).not.toContain("6789");
    expect(JSON.stringify([spy.mock.calls, err.mock.calls])).not.toContain(DIGITS);
    spy.mockRestore();
    err.mockRestore();
  });

  it("each member files their own: one row each, nothing of the other's changes", async () => {
    await file(IDS.b1m1);
    const first = { ...w9s()[0]! };
    await file(IDS.b1m2, { tin: "456-78-4321" });
    expect(w9s()).toHaveLength(2);
    expect(w9s().find((w) => w.account_member_id === IDS.b1m1)).toEqual(first);
    expect(w9s().find((w) => w.account_member_id === IDS.b1m2)).toMatchObject({ tin_last4: "4321", signed_name: "Bob One" });
    expect(secrets()).toHaveLength(2);
    await expect(file(IDS.b1m1)).rejects.toThrow("already on file");
    expect(w9s()).toHaveLength(2);
  });

  it("a signature that isn't the member's own name is refused, and nothing is saved", async () => {
    await expect(file(IDS.b1m1, { signedName: "Bob One" })).rejects.toThrow("The signature must be this member's full legal name");
    await expect(file(IDS.b1m1, { signedName: "Alice" })).rejects.toThrow("signature must be");
    expect(w9s()).toEqual([]);
    expect(secrets()).toEqual([]);
    // Case and spacing don't matter.
    await file(IDS.b1m1, { signedName: "  alice   ONE " });
    expect(w9s()).toHaveLength(1);
  });

  it("another account's member, or a removed member, can't be filed for", async () => {
    await expect(file(IDS.b2m1)).rejects.toThrow("isn't on your account");
    db().table("account_members").find((m) => m.id === IDS.b1m2)!.status = "removed";
    await expect(file(IDS.b1m2)).rejects.toThrow("isn't on your account");
    expect(w9s()).toEqual([]);
  });

  it("an invalid TIN is refused without saving or echoing it", async () => {
    await expect(file(IDS.b1m1, { tin: "666-12-3456" })).rejects.toThrow("valid Social Security");
    await expect(file(IDS.b1m1, { tin: "12345" })).rejects.toThrow("9-digit");
    expect(w9s()).toEqual([]);
    expect(secrets()).toEqual([]);
  });

  it("the key is checked before anything else: no key means no W-9, whoever it is for", async () => {
    vi.stubEnv("W9_TIN_ENCRYPTION_KEY", "");
    await expect(file(IDS.b2m1)).rejects.toThrow("encryption key isn't configured");
    await expect(file(IDS.b1m1, { tin: "garbage" })).rejects.toThrow("encryption key isn't configured");
  });

  it("with no key on the server the W-9 is refused and nothing is written", async () => {
    vi.stubEnv("W9_TIN_ENCRYPTION_KEY", "");
    await expect(file(IDS.b1m1)).rejects.toThrow("encryption key isn't configured");
    expect(w9s()).toEqual([]);
    expect(secrets()).toEqual([]);
    expect(db().audits("buyer.w9_submitted")).toEqual([]);
  });
});

describe("the one decryption, for tax exports", () => {
  it("admin only, with a reason, and audited without the TIN", async () => {
    const { w9 } = await file(IDS.b1m1);
    harness.userId = USERS.b1;
    await expect(decryptW9TinForTaxExport({ data: { w9Id: w9.id, reason: "1099" } })).rejects.toThrow("Not authorized");
    harness.userId = USERS.admin;
    await expect(decryptW9TinForTaxExport({ data: { w9Id: w9.id, reason: "  " } })).rejects.toThrow("reason");
    expect(db().audits("admin.w9_tin_decrypted")).toEqual([]);
    expect(await decryptW9TinForTaxExport({ data: { w9Id: w9.id, reason: "2026 1099 export" } })).toEqual({ tin: DIGITS });
    const audit = db().audits("admin.w9_tin_decrypted");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: USERS.admin });
    expect(audit[0]!.metadata).toMatchObject({ w9_id: w9.id, reason: "2026 1099 export" });
    expect(JSON.stringify(audit)).not.toContain(DIGITS);
  });

  it("a modified ciphertext fails to decrypt", async () => {
    const { w9 } = await file(IDS.b1m1);
    secrets()[0]!.ciphertext = Buffer.from("tampered!!!!").toString("base64");
    harness.userId = USERS.admin;
    await expect(decryptW9TinForTaxExport({ data: { w9Id: w9.id, reason: "export" } })).rejects.toThrow();
  });

  it("is used in exactly one place", () => {
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && /decryptPii\(|decryptTinForTaxExport\(/.test(readFileSync(p, "utf8"))) users.push(p);
      }
    };
    walk("src");
    expect(users.sort()).toEqual(["src/lib/member-steps.functions.ts", "src/lib/pii-crypto.server.ts", "src/lib/w9.server.ts"]);
  });
});

describe("no client role can read the encrypted table", () => {
  it("no client code selects it, and the client types don't know it", () => {
    const readers: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && p !== "src/lib/w9.server.ts" && /member_w9_tin_secrets/.test(readFileSync(p, "utf8"))) readers.push(p);
      }
    };
    walk("src");
    expect(readers).toEqual([]);
  });

  it("the SQL gives clients no grant and no policy on it", () => {
    const sql = readFileSync("member-steps.sql", "utf8");
    expect(sql).toMatch(/REVOKE ALL ON public\.%I FROM anon, authenticated/);
    expect(sql).not.toMatch(/GRANT SELECT ON public\.member_w9_tin_secrets TO authenticated/);
    expect(sql).not.toMatch(/CREATE POLICY[^;]*member_w9_tin_secrets/);
  });
});

describe("W-9 completion feeds the checklist and the Golden Ticket", () => {
  it("the member's checklist shows W-9 done only for the member who filed", async () => {
    await file(IDS.b1m1);
    harness.userId = USERS.b1;
    const view = await getMyAccountMembers();
    const w9 = (id: string) => view.members.find((m) => m.id === id)!.checklist.find((c) => c.key === "w9")!.done;
    expect([w9(IDS.b1m1), w9(IDS.b1m2)]).toEqual([true, false]);
  });

  it("the ticket needs a W-9 from every active member", () => {
    const base = { goldenTicketIssued: false, liquidityVerified: true, liquidityStatus: "verified" };
    expect(evaluateGoldenTicket({ ...base, members: [steps({ memberId: "a" }), steps({ memberId: "b" })] }).eligible).toBe(true);
    expect(evaluateGoldenTicket({ ...base, members: [steps({ memberId: "a" }), steps({ memberId: "b", w9: false })] }).missing).toEqual(["Every Account Member must complete their W-9"]);
  });
});
