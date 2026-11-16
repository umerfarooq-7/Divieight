#!/usr/bin/env node
/**
 * Secret scan: the working tree and (with --history) every line ever added in git history.
 *
 *   node scripts/secret-scan.mjs            scan tracked files
 *   node scripts/secret-scan.mjs --history  also scan every added line in every commit on every branch
 *
 * Prints the kind of secret, where, and a masked sample, never the value. Exits 1 when it finds one that is not on the reviewed allow-list.
 * Public values (a Supabase URL, an anon or publishable key, a Stripe publishable key) are expected in a browser app and are listed, not failed.
 */
import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATTERNS = [
  { kind: "Stripe secret key", re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}/g, severity: "secret" },
  { kind: "Stripe webhook secret", re: /\bwhsec_[0-9A-Za-z]{16,}/g, severity: "secret" },
  { kind: "Supabase secret key", re: /\bsb_secret_[0-9A-Za-z_-]{16,}/g, severity: "secret" },
  { kind: "Private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g, severity: "secret" },
  { kind: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/g, severity: "secret" },
  { kind: "Resend API key", re: /\bre_[0-9A-Za-z]{24,}\b/g, severity: "secret" },
  { kind: "Slack token", re: /\bxox[abprs]-[0-9A-Za-z-]{20,}/g, severity: "secret" },
  { kind: "GitHub token", re: /\bgh[pousr]_[0-9A-Za-z]{30,}/g, severity: "secret" },
  { kind: "Encryption key assignment", re: /\bW9_TIN_ENCRYPTION_KEY(?:_V\d+)?\s*[=:]\s*["']?[A-Za-z0-9+/=]{40,}/g, severity: "secret" },
  { kind: "Service-role key assignment", re: /\b(?:SERVICE_ROLE_KEY|DB_SERVICE_ROLE_KEY)\s*[=:]\s*["']?[A-Za-z0-9._-]{30,}/g, severity: "secret" },
  { kind: "Hard-coded password or secret", re: /\b(?:password|passwd|secret|api[_-]?key)\s*[:=]\s*["'][^"'\s]{16,}["']/gi, severity: "review" },
  { kind: "JWT", re: /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/g, severity: "jwt" },
  { kind: "Stripe publishable key", re: /\bpk_(?:live|test)_[0-9A-Za-z]{16,}/g, severity: "public" },
];

const SKIP = /(^|\/)(package-lock\.json|bun\.lock|routeTree\.gen\.ts|\.output\/|node_modules\/|docs\/rls-policies\.json|samples\/)/;
const SELF = /^scripts\/secret-scan\.mjs$|^tests\/(secrets|.*test)\.|\.test\.ts$/;

const mask = (s) => `${s.slice(0, 6)}…(${s.length} chars)`;

function jwtRole(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return { role: payload.role ?? payload.aud ?? "unknown", ref: payload.ref ?? null };
  } catch {
    return { role: "undecodable", ref: null };
  }
}

export function scanText(text, where) {
  const out = [];
  for (const { kind, re, severity } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      let sev = severity;
      let detail = "";
      if (severity === "jwt") {
        const { role } = jwtRole(m[0]);
        detail = `role=${role}`;
        sev = role === "anon" || role === "authenticated" ? "public" : "secret"; // an anon key is meant to ship in a browser; any other role is a secret
      }
      if (kind === "Stripe secret key" && /_test_/.test(m[0])) sev = "secret"; // test-mode secret keys are still secret
      out.push({ kind, severity: sev, where, sample: mask(m[0]), detail });
    }
  }
  return out;
}

function scanTree() {
  const files = execFileSync("git", ["ls-files"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean);
  const found = [];
  for (const f of files) {
    if (SKIP.test(f) || SELF.test(f)) continue;
    let text;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue;
    found.push(...scanText(text, f));
  }
  return found;
}

function scanHistory() {
  return new Promise((resolve) => {
    const found = [];
    const seen = new Set();
    const p = spawn("git", ["log", "--all", "-p", "--no-color", "-U0", "--format=@@COMMIT %h", "--", ".", ":(exclude)package-lock.json", ":(exclude)bun.lock", ":(exclude)src/routeTree.gen.ts"], { maxBuffer: Infinity });
    let commit = "";
    let file = "";
    let buf = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("@@COMMIT ")) commit = line.slice(9);
        else if (line.startsWith("+++ b/")) file = line.slice(6);
        else if (line.startsWith("+") && !line.startsWith("+++") && !SKIP.test(file) && !SELF.test(file)) {
          for (const f of scanText(line, `${file} @ ${commit}`)) {
            const key = `${f.kind}|${f.sample}|${file}`;
            if (!seen.has(key)) {
              seen.add(key);
              found.push(f);
            }
          }
        }
      }
    });
    p.on("close", () => resolve(found));
  });
}

/** Findings that are expected and reviewed: public by design. */
export const isPublic = (f) => f.severity === "public";

if (process.argv[1] && process.argv[1].endsWith("secret-scan.mjs")) {
  const history = process.argv.includes("--history");
  const tree = scanTree();
  const hist = history ? await scanHistory() : [];
  const all = [...tree.map((f) => ({ ...f, in: "tree" })), ...hist.map((f) => ({ ...f, in: "history" }))];
  const secrets = all.filter((f) => !isPublic(f));
  const pub = all.filter(isPublic);
  console.log(`Scanned the working tree${history ? " and the full git history" : ""}.`);
  console.log(`Public values (expected in a browser app): ${pub.length}`);
  for (const f of pub) console.log(`  public   ${f.in.padEnd(8)} ${f.kind.padEnd(24)} ${f.where} ${f.detail}`);
  console.log(`Possible secrets: ${secrets.length}`);
  for (const f of secrets) console.log(`  ${f.severity.toUpperCase().padEnd(8)} ${f.in.padEnd(8)} ${f.kind.padEnd(28)} ${f.where} ${f.sample} ${f.detail}`);
  process.exit(secrets.length ? 1 : 0);
}
