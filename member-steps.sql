-- Member-level onboarding steps: W-9, Block 1 (Plaid consent), Block 2 (LPOA), the account's Plaid
-- links, and per-member signatures. Run once in the Supabase SQL editor, AFTER account-members.sql
-- and the other Month 5 files. Safe to re-run.
--
-- The TIN lives only in member_w9_tin_secrets, encrypted by the server (AES-256-GCM). That table has
-- NO client-facing policies and no client grants: only the service role can read it, so no buyer,
-- agent, broker, seller or admin UI session can ever select the encrypted column.

-- ---------------------------------------------------------------------------
-- W-9 (one per Account Member). Never holds the TIN, only its last four digits.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.member_w9 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_member_id uuid NOT NULL UNIQUE REFERENCES public.account_members(id),
  buyer_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id),
  legal_name text NOT NULL CHECK (length(btrim(legal_name)) > 0),
  tax_classification text NOT NULL CHECK (tax_classification IN ('individual', 'c_corporation', 's_corporation', 'partnership', 'trust_estate', 'llc')),
  address text NOT NULL CHECK (length(btrim(address)) > 0),
  tin_kind text NOT NULL CHECK (tin_kind IN ('ssn', 'ein')),
  tin_last4 text NOT NULL CHECK (tin_last4 ~ '^[0-9]{4}$'),
  signed_name text NOT NULL CHECK (length(btrim(signed_name)) > 0),
  signed_at timestamptz NOT NULL DEFAULT now(),
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS member_w9_account_idx ON public.member_w9 (buyer_account_id);

-- The encrypted TIN: ciphertext, iv and auth tag, with the key version for rotation.
CREATE TABLE IF NOT EXISTS public.member_w9_tin_secrets (
  w9_id uuid PRIMARY KEY,
  account_member_id uuid NOT NULL UNIQUE REFERENCES public.account_members(id),
  ciphertext text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  key_version integer NOT NULL CHECK (key_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Block 1 (Plaid consent) and Block 2 (LPOA): one acceptance per member per text version
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.member_plaid_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_member_id uuid NOT NULL REFERENCES public.account_members(id),
  buyer_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id),
  text_version text NOT NULL,
  text_hash text NOT NULL CHECK (text_hash ~ '^sha256_[0-9a-f]{64}$'),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip text,
  user_agent text,
  UNIQUE (account_member_id, text_version)
);
CREATE TABLE IF NOT EXISTS public.member_block2_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_member_id uuid NOT NULL REFERENCES public.account_members(id),
  buyer_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id),
  text_version text NOT NULL,
  text_hash text NOT NULL CHECK (text_hash ~ '^sha256_[0-9a-f]{64}$'),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip text,
  user_agent text,
  UNIQUE (account_member_id, text_version)
);
CREATE INDEX IF NOT EXISTS member_plaid_consents_account_idx ON public.member_plaid_consents (buyer_account_id);
CREATE INDEX IF NOT EXISTS member_block2_account_idx ON public.member_block2_authorizations (buyer_account_id);

-- ---------------------------------------------------------------------------
-- The account's Plaid links: account-level, either member, assets combined. Balances stay
-- server-side: no client role can read this table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.account_liquidity_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id),
  linked_by_member_id uuid NOT NULL REFERENCES public.account_members(id),
  institution text NOT NULL,
  balances jsonb NOT NULL DEFAULT '[]'::jsonb,
  linked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_liquidity_links_account_idx ON public.account_liquidity_links (buyer_account_id);

-- ---------------------------------------------------------------------------
-- Rules shared by the member tables
-- ---------------------------------------------------------------------------
-- The member is an active member of that account.
CREATE OR REPLACE FUNCTION public.member_step_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE member_id uuid;
BEGIN
  -- Separate statements: plpgsql resolves NEW.<field> per statement, so each table only touches its own column.
  IF TG_TABLE_NAME = 'account_liquidity_links' THEN
    member_id := NEW.linked_by_member_id;
  ELSE
    member_id := NEW.account_member_id;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.account_members m
    WHERE m.id = member_id AND m.buyer_account_id = NEW.buyer_account_id AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'That member isn''t an active member of this account.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Append-only: a W-9, a consent or an authorization is never changed or deleted.
CREATE OR REPLACE FUNCTION public.member_step_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION '% is append-only.', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['member_w9', 'member_plaid_consents', 'member_block2_authorizations', 'account_liquidity_links'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_guard', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.member_step_guard()', t || '_guard', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['member_w9', 'member_w9_tin_secrets', 'member_plaid_consents', 'member_block2_authorizations'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.member_step_append_only()', t || '_append_only', t);
  END LOOP;
END $$;

-- Access. Everything is written by the server. A buyer may READ their own account's W-9 summary,
-- consents and authorizations (none holds a TIN). The TIN table and the Plaid links have no client access.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['member_w9', 'member_w9_tin_secrets', 'member_plaid_consents', 'member_block2_authorizations', 'account_liquidity_links'] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO service_role', t);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['member_w9', 'member_plaid_consents', 'member_block2_authorizations'] LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'buyers and admins read ' || t, t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.has_role(auth.uid(), ''admin'') OR EXISTS (SELECT 1 FROM public.buyer_accounts b WHERE b.id = buyer_account_id AND b.auth_user_id = auth.uid()))',
      'buyers and admins read ' || t, t);
  END LOOP;
END $$;
-- member_w9_tin_secrets and account_liquidity_links: RLS on, and deliberately NO policy and no grant for any client role.

-- ---------------------------------------------------------------------------
-- Signatures: the PRA, like the Hold Harmless and Block 5, names the member who signed.
-- ---------------------------------------------------------------------------
-- Existing PRA / Hold Harmless / Block 5 rows are backfilled to the account's primary member.
-- (A row whose typed name is the second member's own name goes to that member instead.)
UPDATE public.signed_documents d
SET account_member_id = COALESCE(
  (SELECT m.id FROM public.account_members m
    WHERE m.buyer_account_id = d.buyer_account_id AND m.status = 'active' AND lower(btrim(m.full_name)) = lower(btrim(d.signed_name))
    ORDER BY (m.role = 'primary') DESC LIMIT 1),
  (SELECT m.id FROM public.account_members m WHERE m.buyer_account_id = d.buyer_account_id AND m.role = 'primary' AND m.status = 'active' LIMIT 1)
)
WHERE d.account_member_id IS NULL
  AND d.buyer_account_id IS NOT NULL
  AND d.document_type IN ('PRA', 'HOLD_HARMLESS', 'block_5_independent_advice');

CREATE OR REPLACE FUNCTION public.signed_documents_member_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.document_type IN ('PRA', 'HOLD_HARMLESS', 'block_5_independent_advice') AND NEW.buyer_account_id IS NOT NULL AND NEW.account_member_id IS NULL THEN
    RAISE EXCEPTION 'This signature must name the Account Member who signed.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.account_member_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.account_members m
    WHERE m.id = NEW.account_member_id AND m.buyer_account_id = NEW.buyer_account_id AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'That member isn''t an active member of this account.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Block 1: an account whose holder already consented before members each consent keeps that consent
-- for the account holder (the sentence is unchanged). Other members consent for themselves.
INSERT INTO public.member_plaid_consents (account_member_id, buyer_account_id, text_version, text_hash, accepted_at)
SELECT m.id, b.id, 'block1-v1',
       'sha256_' || encode(sha256(convert_to('I authorize divieight to securely link my financial accounts via Plaid to verify my liquidity. divieight uses secure, tokenized access and does not store my bank login credentials.', 'UTF8')), 'hex'),
       b.plaid_consent_at
FROM public.buyer_accounts b
JOIN public.account_members m ON m.buyer_account_id = b.id AND m.role = 'primary' AND m.status = 'active'
WHERE b.plaid_consent_at IS NOT NULL
ON CONFLICT (account_member_id, text_version) DO NOTHING;
