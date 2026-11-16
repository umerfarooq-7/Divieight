# Load test

Scripts: `scripts/load-test.k6.js` (k6: ramps to 50 virtual users and fires 5 probes a second at a scheduled-job endpoint) and `scripts/load-test.mjs` (no dependencies, same targets).
Neither needs a login. **Signed-in flows (ledger, documents, votes, statements) were NOT load-tested**: they need staging test accounts and a Supabase project to take the load. That is a gap.

## Recorded run

2026-11-16, the production build (`NITRO_PRESET=node-server npm run build`, `node .output/server/index.mjs`) on a developer laptop (Windows 11), the load generator on the same machine, against the live Supabase project for server-side data.
Command: `node scripts/load-test.mjs http://localhost:3939 --seconds 30 --concurrency 25`.

| Run | Requests | Errors | Throughput | p50 | p95 | p99 |
|---|---|---|---|---|---|---|
| 25 concurrent, 30 s (`/`, `/properties`, `/login`) | 4,220 | 0 (0.00%) | 140 req/s | 120 ms | ~510 ms | ~1.3 s |
| 100 concurrent, 20 s | 3,899 | 0 (0.00%) | 188 req/s | 421 ms | ~1.17 s | ~1.4 s |
| First 25-concurrent run (`/` and `/login` plus a path that does not exist), for comparison | 8,161 | 0 | 271 req/s | 85 ms | 137 ms | 190 ms |

- Every response carried the security headers.
- A scheduled-job endpoint with no secret: **never 200** in 15 tries. With no secret configured it answered 503; with a secret configured it answered 401, then 429 once the guess limit was reached.
- The `/properties` page reads the database on each request, which is why it and `/` share the heavier latency.

## How to read these numbers

They show the app server does not fall over or leak errors at 100 concurrent visitors on one small machine, and that latency grows smoothly with concurrency. They do **not** predict production: the real host
is serverless (instances scale out), the database round trip is across the internet, and the load generator competed for the same CPU. There is no pass/fail target agreed with the client; the k6 script's thresholds
(error rate under 1%, page p95 under 1.5 s) are placeholders to adjust.
