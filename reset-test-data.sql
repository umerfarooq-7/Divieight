-- divieight — FULL TEST DATA RESET (sirf test/demo database ke liye)
--
-- Kya karta hai:
--   * public schema ke SAB tables ka data delete karta hai (buyers, sellers, agents, brokers, properties, pods, reservations, co-buyer links,
--     votes, ledger, distributions, audit log ... sab), aur identity counters restart karta hai.
--   * auth.users se sab users delete karta hai SIVAE un ke jin ka public.user_roles mein role = 'admin' hai. Admin ke saare roles (founder wagaira) rehte hain.
--   * Ye rehta hai (settings / reference data, koi user data nahi):
--       coa_versions, coa_accounts (chart of accounts), coverage_requirements, governance_settings, governance_rules (sirf default rows
--       jin ki property nahi), standard_versions, tc_versions (Terms), launch_readiness_items, platform_settings, library_clusters, library_videos, user_roles (admin ki).
--   * Schema bilkul change nahi hota: sirf data.
--
-- Ye wapas nahi aata. Pehle Supabase Dashboard -> Database -> Backups se backup le lein.
-- Chalane ka tareeqa: Supabase Dashboard -> SQL Editor -> poora paste -> Run.
-- Storage ki files SQL se delete nahi hoti (Supabase block karta hai): neeche step 3 dekhein.
--
-- Audit log append-only hai (trigger TRUNCATE ko bhi rokta hai) aur bohot si tables ka record-keeping triggers/foreign keys hain. Is script mein
-- `session_replication_role = replica` SIRF is transaction ke liye lagta hai, taake ye reset ho sake. Agar Supabase "permission denied to set parameter" de,
-- to Dashboard -> Database -> Roles mein postgres role se ya support se ye permission lein; script ko kisi aur tareeqe se na chalayein.

BEGIN;

-- 0) Safety: admin hona zaroori hai, warna reset ke baad koi login nahi kar payega -------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles r JOIN auth.users u ON u.id = r.user_id WHERE r.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Koi admin user nahi mila (public.user_roles mein role = admin). Reset rok diya gaya.';
  END IF;
END $$;

-- Ye admin(s) bachenge:
SELECT u.id, u.email, string_agg(r.role::text, ', ') AS roles
FROM auth.users u
JOIN public.user_roles r ON r.user_id = u.id
WHERE u.id IN (SELECT user_id FROM public.user_roles WHERE role = 'admin')
GROUP BY u.id, u.email;

-- Is transaction ke liye triggers aur foreign-key checks band (append-only guards, record-keeping triggers).
SET LOCAL session_replication_role = replica;

-- 1) Jo rehna chahiye uska backup (governance ke default rules: wo rows jin ki koi property nahi) ---------------------------------------------
CREATE TEMP TABLE keep_governance_rules ON COMMIT DROP AS
  SELECT * FROM public.governance_rules WHERE property_id IS NULL;

-- 2) Application data: public ke SAB tables, sirf config tables ke ilawa. Ek hi TRUNCATE (CASCADE ke baghair), taake config tables ghalti se na urein.
DO $$
DECLARE
  keep text[] := ARRAY[
    'coa_versions', 'coa_accounts', 'coverage_requirements', 'governance_settings', 'standard_versions',
    'tc_versions', 'launch_readiness_items', 'platform_settings', 'library_clusters', 'library_videos', 'user_roles'
  ];
  wipe text;
BEGIN
  SELECT string_agg(format('public.%I', tablename), ', ' ORDER BY tablename)
    INTO wipe
    FROM pg_tables
   WHERE schemaname = 'public' AND tablename <> ALL (keep);
  RAISE NOTICE 'Khali hone wale tables: %', wipe;
  EXECUTE 'TRUNCATE TABLE ' || wipe || ' RESTART IDENTITY';
END $$;

-- governance_rules ek property se bhi judi hoti hai, isliye wo upar khali hui; sirf default rows wapas.
INSERT INTO public.governance_rules SELECT * FROM keep_governance_rules;

-- 3) Auth users: admin ke ilawa sab delete (identities / sessions saath chale jaate hain) ---------------------------------------------------
DELETE FROM auth.users u
WHERE NOT EXISTS (
  SELECT 1 FROM public.user_roles r WHERE r.user_id = u.id AND r.role = 'admin'
);

-- Jo role rows ab kisi user ki nahi rahi (aur admin ke ilawa), unhein saaf karein.
DELETE FROM public.user_roles r WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = r.user_id);

COMMIT;

-- 4) Storage files (SQL se nahi hoti) -----------------------------------------------------------------------------------------------------
-- Supabase Dashboard -> Storage -> har bucket kholein -> sab select -> Delete.
-- Buckets: property-media, property-documents, identity-documents, verification-documents, agent-documents, liveness-selfies, private buckets (tax / year-end).

-- 5) Check: sab counts 0 hone chahiye, sirf admin bacha hona chahiye ---------------------------------------------------------------------------
SELECT 'buyer_accounts' AS table_name, count(*) FROM public.buyer_accounts
UNION ALL SELECT 'account_members', count(*) FROM public.account_members
UNION ALL SELECT 'sellers', count(*) FROM public.sellers
UNION ALL SELECT 'properties', count(*) FROM public.properties
UNION ALL SELECT 'pod_reservations', count(*) FROM public.pod_reservations
UNION ALL SELECT 'cap_table_entries', count(*) FROM public.cap_table_entries
UNION ALL SELECT 'signed_documents', count(*) FROM public.signed_documents
UNION ALL SELECT 'notifications', count(*) FROM public.notifications
UNION ALL SELECT 'audit_log', count(*) FROM public.audit_log
UNION ALL SELECT 'storage_objects (khud saaf karein)', count(*) FROM storage.objects
ORDER BY 1;

-- Sirf admin bacha hona chahiye, apne roles ke saath.
SELECT u.id, u.email, string_agg(r.role::text, ', ') AS roles
FROM auth.users u
LEFT JOIN public.user_roles r ON r.user_id = u.id
GROUP BY u.id, u.email
ORDER BY u.created_at;

-- Settings bache hain (0 nahi, ye theek hai):
SELECT 'tc_versions' AS kept, count(*) FROM public.tc_versions
UNION ALL SELECT 'standard_versions', count(*) FROM public.standard_versions
UNION ALL SELECT 'governance_rules (default)', count(*) FROM public.governance_rules
UNION ALL SELECT 'coa_accounts', count(*) FROM public.coa_accounts;
