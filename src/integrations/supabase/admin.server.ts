// Server-side Supabase client with service-role privileges (bypasses RLS).
// This project uses an external Supabase project, so the service-role key is
// stored as DB_SERVICE_ROLE_KEY (the SUPABASE_ prefix is reserved by Lovable).
import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';
import { withAuditContext } from '@/lib/audit-context.server';

function isNewSupabaseApiKey(value: string): boolean {
  return value.startsWith('sb_publishable_') || value.startsWith('sb_secret_');
}

function createSupabaseFetch(supabaseKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined,
    );

    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }

    if (isNewSupabaseApiKey(supabaseKey) && headers.get('Authorization') === `Bearer ${supabaseKey}`) {
      headers.delete('Authorization');
    }

    headers.set('apikey', supabaseKey);
    return fetch(input, { ...init, headers });
  };
}

function createSupabaseAdminClient() {
  const SUPABASE_URL = process.env['SUPABASE_URL'] ?? process.env['VITE_SUPABASE_URL'];
  const SERVICE_ROLE_KEY =
    process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? process.env['DB_SERVICE_ROLE_KEY'];

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    const missing = [
      ...(!SUPABASE_URL ? ['SUPABASE_URL'] : []),
      ...(!SERVICE_ROLE_KEY ? ['DB_SERVICE_ROLE_KEY'] : []),
    ];
    throw new Error(`Missing server environment variable(s): ${missing.join(', ')}.`);
  }

  return createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { fetch: createSupabaseFetch(SERVICE_ROLE_KEY) },
    auth: {
      storage: undefined,
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

let _supabaseAdmin: ReturnType<typeof createSupabaseAdminClient> | undefined;

export const supabaseAdmin = new Proxy({} as ReturnType<typeof createSupabaseAdminClient>, {
  get(_, prop, receiver) {
    if (!_supabaseAdmin) _supabaseAdmin = createSupabaseAdminClient();
    // Every insert into the audit log carries where it came from (address, browser, route) unless the writer said.
    if (prop === 'from') {
      const client = _supabaseAdmin;
      return (table: string) => withAuditContext(table, client.from(table as never));
    }
    return Reflect.get(_supabaseAdmin, prop, receiver);
  },
});
