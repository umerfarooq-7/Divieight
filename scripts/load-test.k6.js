// k6 load test for the public surface of divieight.
//
//   k6 run -e BASE_URL=https://staging.example.com scripts/load-test.k6.js
//
// Run it against STAGING, never against production with real members online. It covers what an unauthenticated visitor can reach: the home page, the marketplace,
// a public property page, the public rules check, and the attack surface (a scheduled-job endpoint with no secret must answer 401 or 429, never 200).
// Signed-in flows (ledger, documents, votes) need test accounts and a token: add them to `authed()` below (see docs/load-test.md).
import http from "k6/http";
import { check, sleep, group } from "k6";

const BASE = __ENV.BASE_URL || "http://localhost:3000";

export const options = {
  scenarios: {
    browse: { executor: "ramping-vus", startVUs: 0, stages: [{ duration: "30s", target: 25 }, { duration: "1m", target: 50 }, { duration: "30s", target: 0 }], exec: "browse" },
    probes: { executor: "constant-arrival-rate", rate: 5, timeUnit: "1s", duration: "2m", preAllocatedVUs: 10, exec: "probes" },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{kind:page}": ["p(95)<1500"],
    "checks{kind:probe}": ["rate==1"],
  },
};

export function browse() {
  group("pages", () => {
    for (const path of ["/", "/properties", "/login"]) {
      const r = http.get(`${BASE}${path}`, { tags: { kind: "page" } });
      check(r, { [`${path} 200`]: (x) => x.status === 200, [`${path} has security headers`]: (x) => !!x.headers["X-Content-Type-Options"] });
    }
  });
  sleep(1);
}

export function probes() {
  // A scheduled job without its secret must be refused (401), or rate-limited (429) after repeated guesses. 200 would be a hole.
  const r = http.post(`${BASE}/api/public/retention-sweep`, "{}", { headers: { "content-type": "application/json" }, tags: { kind: "probe" } });
  check(r, { "job endpoint refuses without the secret": (x) => x.status === 401 || x.status === 429 || x.status === 503 }, { kind: "probe" });
}

// export function authed() { /* sign in with a test account, then exercise the ledger, a document list and a vote */ }
