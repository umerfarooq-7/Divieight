#!/usr/bin/env node
/**
 * A dependency-free load test (for machines without k6). Same targets as load-test.k6.js.
 *
 *   node scripts/load-test.mjs [BASE_URL] [--seconds 30] [--concurrency 25]
 *
 * Prints requests, errors, requests per second and latency percentiles per path, and checks that a scheduled job without its secret is refused.
 * The numbers describe the machine and server it was pointed at, nothing else: see docs/load-test.md for how to read them.
 */
const args = process.argv.slice(2);
const flag = (name, d) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const base = (args.find((a) => /^https?:/.test(a)) ?? "http://localhost:3000").replace(/\/$/, "");
const seconds = flag("--seconds", 30);
const concurrency = flag("--concurrency", 25);
const PATHS = ["/", "/properties", "/login"];

const stats = new Map();
const rec = (path, ms, status, headersOk) => {
  const s = stats.get(path) ?? { n: 0, bad: 0, ms: [], noHeaders: 0 };
  s.n++;
  if (status >= 500 || status === 0) s.bad++;
  if (!headersOk) s.noHeaders++;
  s.ms.push(ms);
  stats.set(path, s);
};
const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : 0);

const deadline = Date.now() + seconds * 1000;
async function worker(id) {
  let i = id;
  while (Date.now() < deadline) {
    const path = PATHS[i++ % PATHS.length];
    const t = performance.now();
    try {
      const r = await fetch(base + path, { redirect: "manual" });
      await r.arrayBuffer();
      rec(path, performance.now() - t, r.status, !!r.headers.get("x-content-type-options"));
    } catch {
      rec(path, performance.now() - t, 0, false);
    }
  }
}

const started = Date.now();
await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
const elapsed = (Date.now() - started) / 1000;

console.log(`Target ${base}  ${seconds}s  ${concurrency} concurrent  (${new Date().toISOString()})`);
let total = 0;
let bad = 0;
for (const [path, s] of stats) {
  total += s.n;
  bad += s.bad;
  console.log(`${path.padEnd(14)} n=${String(s.n).padEnd(6)} errors=${s.bad}  p50=${pct(s.ms, 50).toFixed(0)}ms p95=${pct(s.ms, 95).toFixed(0)}ms p99=${pct(s.ms, 99).toFixed(0)}ms  missing-security-headers=${s.noHeaders}`);
}
console.log(`TOTAL requests=${total} errors=${bad} (${((bad / Math.max(1, total)) * 100).toFixed(2)}%) rate=${(total / elapsed).toFixed(1)} req/s`);

// The attack surface: a scheduled job with no secret must not run.
const codes = [];
for (let i = 0; i < 15; i++) {
  const r = await fetch(`${base}/api/public/retention-sweep`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  codes.push(r.status);
}
const leaked = codes.filter((c) => c === 200).length;
console.log(`Job endpoint without secret, 15 tries: ${[...new Set(codes)].join(",")}  ${leaked ? "FAIL: a job ran without its secret" : "OK: never 200"}${codes.includes(429) ? " (rate limit reached)" : ""}`);
process.exit(bad / Math.max(1, total) > 0.01 || leaked ? 1 : 0);
