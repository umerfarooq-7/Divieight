/**
 * Global test wiring: server functions run their real handler code against the
 * in-memory FakeDb, as whichever user `harness.userId` names.
 */
import { vi, beforeEach } from "vitest";
import { FakeDb } from "./fake-db";

export const harness = {
  db: new FakeDb(),
  userId: "",
  ip: "203.0.113.7",
};

beforeEach(() => {
  harness.db = new FakeDb();
  harness.userId = "";
  delete process.env.RESEND_API_KEY; // never send real email from tests
});

vi.mock("@tanstack/react-start", () => {
  const build = () => {
    let validator: (d: any) => any = (d) => d;
    const b: any = {
      middleware: () => b,
      inputValidator: (fn: (d: any) => any) => ((validator = fn), b),
      handler: (h: (a: any) => any) => async (arg?: { data?: any }) =>
        h({
          data: validator(arg?.data),
          context: {
            userId: harness.userId,
            claims: { sub: harness.userId },
            supabase: harness.db,
          },
        }),
    };
    return b;
  };
  return {
    createServerFn: () => build(),
    createMiddleware: () => ({ server: () => ({}) }),
  };
});

vi.mock("@tanstack/react-start/server", () => ({
  getRequestIP: () => harness.ip,
  getRequest: () => new Request("http://test.local"),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

vi.mock("@/integrations/supabase/admin.server", () => ({
  get supabaseAdmin() {
    return harness.db;
  },
}));

vi.mock("@/integrations/supabase/client", () => ({
  get supabase() {
    return harness.db;
  },
}));
