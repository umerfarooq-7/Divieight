/**
 * Key rotation: values sealed by the server under key version 1 are re-sealed by scripts/rotate-pii-keys.mjs under version 2, and the server then opens them with
 * version 2 and no longer needs version 1. The script and the server module must agree on the format, or a rotation would destroy tax data.
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptPii, encryptPii, currentKeyVersion } from "@/lib/pii-crypto.server";
// @ts-expect-error: a plain .mjs script
import { reseal, open, seal } from "../scripts/rotate-pii-keys.mjs";

const k = () => randomBytes(32).toString("base64");
const saved = { ...process.env };
afterEach(() => {
  for (const key of ["W9_TIN_ENCRYPTION_KEY", "W9_TIN_ENCRYPTION_KEY_V2", "PII_KEY_VERSION"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("key rotation", () => {
  it("a value sealed at version 1 is re-sealed at version 2, opens with the server module, and 1 can then be retired", () => {
    process.env.W9_TIN_ENCRYPTION_KEY = k();
    delete process.env.PII_KEY_VERSION;
    expect(currentKeyVersion()).toBe(1);
    const aad = "member_w9:abc";
    const v1 = encryptPii("123-45-6789", aad);
    expect(v1.key_version ?? (v1 as unknown as { keyVersion: number }).keyVersion).toBe(1);

    process.env.W9_TIN_ENCRYPTION_KEY_V2 = k();
    process.env.PII_KEY_VERSION = "2";
    expect(currentKeyVersion()).toBe(2);
    expect(decryptPii(v1, aad)).toBe("123-45-6789"); // still readable until re-sealed

    const v2 = reseal(v1, aad, 2);
    delete process.env.W9_TIN_ENCRYPTION_KEY; // the old key is retired
    expect(decryptPii(v2, aad)).toBe("123-45-6789");
    expect(() => decryptPii(v1, aad)).toThrow();
  });
  it("new values are sealed at the current version, and the script opens what the server sealed (and the reverse)", () => {
    process.env.W9_TIN_ENCRYPTION_KEY = k();
    process.env.W9_TIN_ENCRYPTION_KEY_V2 = k();
    process.env.PII_KEY_VERSION = "2";
    const fromServer = encryptPii("secret", "a:1");
    expect(open(fromServer, "a:1")).toBe("secret");
    expect(decryptPii(seal("other", "a:2", 2), "a:2")).toBe("other");
  });
  it("a value moved to another row does not open", () => {
    process.env.W9_TIN_ENCRYPTION_KEY = k();
    const v = encryptPii("x", "member_w9:1");
    expect(() => decryptPii(v, "member_w9:2")).toThrow();
  });
});
