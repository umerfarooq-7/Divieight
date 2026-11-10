  -- Eligibility result engine. Run once in the Supabase SQL editor, AFTER
  -- eligibility-declarations.sql and member-liveness.sql. Safe to re-run.
  --
  -- Every table here is append-only: a recompute, a screening, a disposition or a finding is a new
  -- row, and the latest row per member is current. Nothing is updated in place or deleted.
  
  -- Results: one row per recompute that produced a result (eligible / held / not_eligible).
  CREATE TABLE IF NOT EXISTS public.eligibility_results (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_member_id uuid NOT NULL REFERENCES public.account_members(id),
    buyer_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id),
    standard_version text NOT NULL,
    result text NOT NULL CHECK (result IN ('eligible', 'held', 'not_eligible')),
    reason_codes text[] NOT NULL DEFAULT '{}',
    determined_at timestamptz NOT NULL DEFAULT now(),
    declaration_id uuid NOT NULL REFERENCES public.eligibility_declarations(id),
    screening_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS eligibility_results_member_idx ON public.eligibility_results (account_member_id, determined_at);
  CREATE INDEX IF NOT EXISTS eligibility_results_account_idx ON public.eligibility_results (buyer_account_id);
  
  -- Sanctions / watchlist screening (Standard Part One E), one row per screening or identity resolution.
  CREATE TABLE IF NOT EXISTS public.member_sanctions_screenings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_member_id uuid NOT NULL REFERENCES public.account_members(id),
    buyer_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id),
    provider text NOT NULL DEFAULT 'simulated',
    status text NOT NULL CHECK (status IN ('clear', 'possible_match', 'confirmed_match', 'pending')),
    list_name text,
    matched_name text,
    -- Set on an identity resolution: the possible match it answers, and who answered it.
    resolves_id uuid REFERENCES public.member_sanctions_screenings(id),
    resolved_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (status <> 'confirmed_match' OR resolves_id IS NOT NULL)
  );
  CREATE INDEX IF NOT EXISTS member_sanctions_member_idx ON public.member_sanctions_screenings (account_member_id, created_at);
  
  -- The FACT of how a disclosed charge ended. No result is recorded here: the engine applies the Standard.
  CREATE TABLE IF NOT EXISTS public.charge_dispositions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_member_id uuid NOT NULL REFERENCES public.account_members(id),
    buyer_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id),
    declaration_id uuid NOT NULL REFERENCES public.eligibility_declarations(id),
    outcome text NOT NULL CHECK (outcome IN ('convicted', 'dismissed', 'withdrawn', 'acquitted', 'nolle_prosequi', 'expunged_sealed_or_pardoned', 'juvenile_adjudication')),
    offense_key text CHECK (offense_key IS NULL OR offense_key ~ '^(A[1-4]|B[1-6]|none)$'),
    disposition_date date NOT NULL,
    recorded_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((outcome = 'convicted') = (offense_key IS NOT NULL))
  );
  CREATE INDEX IF NOT EXISTS charge_dispositions_member_idx ON public.charge_dispositions (account_member_id, created_at);
  
  -- Part F: a declaration found untrue.
  CREATE TABLE IF NOT EXISTS public.declaration_untrue_findings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_member_id uuid NOT NULL REFERENCES public.account_members(id),
    buyer_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id),
    declaration_id uuid NOT NULL REFERENCES public.eligibility_declarations(id),
    finding text NOT NULL CHECK (length(btrim(finding)) > 0),
    after_closing boolean NOT NULL DEFAULT false,
    recorded_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  
  -- Legal review flag on the account (a finding after closing). Set once; never cleared by the engine.
  ALTER TABLE public.buyer_accounts ADD COLUMN IF NOT EXISTS legal_review_flagged_at timestamptz;
  ALTER TABLE public.buyer_accounts ADD COLUMN IF NOT EXISTS legal_review_reason text;
  
  -- Append-only, for everyone.
  CREATE OR REPLACE FUNCTION public.eligibility_append_only()
  RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
  BEGIN
    RAISE EXCEPTION '% is append-only: add a new row instead.', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END;
  $$;
  
  -- Each row's member is a member of that account.
  CREATE OR REPLACE FUNCTION public.eligibility_member_guard()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.id = NEW.account_member_id AND m.buyer_account_id = NEW.buyer_account_id) THEN
      RAISE EXCEPTION 'That member isn''t on this account.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END;
  $$;
  
  DO $$
  DECLARE t text;
  BEGIN
    FOREACH t IN ARRAY ARRAY['eligibility_results', 'member_sanctions_screenings', 'charge_dispositions', 'declaration_untrue_findings'] LOOP
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_append_only', t);
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.eligibility_append_only()', t || '_append_only', t);
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_member_guard', t);
      EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.eligibility_member_guard()', t || '_member_guard', t);
      EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
      EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
      EXECUTE format('GRANT SELECT, INSERT ON public.%I TO service_role', t);
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM service_role', t);
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'buyers and admins read ' || t, t);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.has_role(auth.uid(), ''admin'') OR EXISTS (SELECT 1 FROM public.buyer_accounts b WHERE b.id = buyer_account_id AND b.auth_user_id = auth.uid()))',
        'buyers and admins read ' || t, t);
    END LOOP;
  END $$;
  
