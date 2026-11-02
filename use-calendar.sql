-- Annual Use Calendar. Run once in the Supabase SQL editor, AFTER owner-dashboard.sql.
-- Safe to re-run. Only adds tables and functions; existing tables are untouched.

CREATE TABLE IF NOT EXISTS public.use_calendar_years (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  year integer NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'selection_open', 'locked')),
  holiday_weeks jsonb NOT NULL DEFAULT '[]'::jsonb,
  rotation_offset integer NOT NULL DEFAULT 0,
  -- Weeks each holder may pick, fixed when selection opens: { holder_key: count }.
  quotas jsonb NOT NULL DEFAULT '{}'::jsonb,
  turn_hours integer NOT NULL DEFAULT 48 CHECK (turn_hours BETWEEN 1 AND 720),
  turn_holder_key text,
  turn_phase text CHECK (turn_phase IN ('holiday', 'normal')),
  turn_round integer,
  turn_deadline_at timestamptz,
  -- Moves on every pick or skip, so a stale request can't act on an old turn.
  turn_seq integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, year)
);

CREATE TABLE IF NOT EXISTS public.use_calendar_weeks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  year integer NOT NULL,
  week_number integer NOT NULL CHECK (week_number BETWEEN 1 AND 52),
  start_date date NOT NULL,
  end_date date NOT NULL,
  is_holiday boolean NOT NULL DEFAULT false,
  holder_key text,
  selected_by_user_id uuid,
  selected_at timestamptz,
  selection_round integer,
  UNIQUE (property_id, year, week_number)
);
CREATE INDEX IF NOT EXISTS use_calendar_weeks_holder_idx
  ON public.use_calendar_weeks (property_id, holder_key, end_date);

CREATE TABLE IF NOT EXISTS public.use_calendar_priority (
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  holder_key text NOT NULL,
  priority_rank integer NOT NULL,
  PRIMARY KEY (property_id, holder_key)
);

-- Owners read their property's calendar. They don't get who clicked or when;
-- every write goes through the server.
GRANT SELECT ON public.use_calendar_years, public.use_calendar_priority TO authenticated;
GRANT SELECT (id, property_id, year, week_number, start_date, end_date, is_holiday, holder_key, selection_round)
  ON public.use_calendar_weeks TO authenticated;
GRANT ALL ON public.use_calendar_years, public.use_calendar_weeks, public.use_calendar_priority TO service_role;
ALTER TABLE public.use_calendar_years ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.use_calendar_weeks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.use_calendar_priority ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owners read calendar years" ON public.use_calendar_years;
CREATE POLICY "owners read calendar years" ON public.use_calendar_years
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR (status <> 'draft' AND public.is_property_owner(auth.uid(), property_id)));

DROP POLICY IF EXISTS "owners read calendar weeks" ON public.use_calendar_weeks;
CREATE POLICY "owners read calendar weeks" ON public.use_calendar_weeks
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.is_property_owner(auth.uid(), property_id));

DROP POLICY IF EXISTS "owners read calendar priority" ON public.use_calendar_priority;
CREATE POLICY "owners read calendar priority" ON public.use_calendar_priority
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.is_property_owner(auth.uid(), property_id));

-- select_week: one transaction with the year's row locked. Concurrent picks
-- queue on the lock; the second sees the moved turn_seq and is refused.
CREATE OR REPLACE FUNCTION public.select_use_calendar_week(
  p_year_id uuid,
  p_week_number integer,
  p_holder_key text,
  p_user_id uuid,
  p_expected_seq integer,
  p_next_holder_key text,
  p_next_phase text,
  p_next_round integer,
  p_next_deadline timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  y public.use_calendar_years%ROWTYPE;
  w public.use_calendar_weeks%ROWTYPE;
BEGIN
  SELECT * INTO y FROM public.use_calendar_years WHERE id = p_year_id FOR UPDATE;
  IF NOT FOUND OR y.status <> 'selection_open' THEN RETURN 'not_open'; END IF;
  IF y.turn_holder_key IS DISTINCT FROM p_holder_key THEN RETURN 'not_your_turn'; END IF;
  IF y.turn_seq <> p_expected_seq THEN RETURN 'stale'; END IF;

  SELECT * INTO w FROM public.use_calendar_weeks
    WHERE property_id = y.property_id AND year = y.year AND week_number = p_week_number
    FOR UPDATE;
  IF NOT FOUND THEN RETURN 'no_week'; END IF;
  IF w.holder_key IS NOT NULL THEN RETURN 'taken'; END IF;
  IF (y.turn_phase = 'holiday') <> w.is_holiday THEN RETURN 'wrong_phase'; END IF;

  UPDATE public.use_calendar_weeks
    SET holder_key = p_holder_key, selected_by_user_id = p_user_id, selected_at = now(), selection_round = y.turn_round
    WHERE id = w.id;
  UPDATE public.use_calendar_years
    SET turn_holder_key = p_next_holder_key, turn_phase = p_next_phase, turn_round = p_next_round,
        turn_deadline_at = p_next_deadline, turn_seq = y.turn_seq + 1
    WHERE id = y.id;
  RETURN 'ok';
END;
$$;

-- Move the turn without a pick (a missed deadline or an admin override).
CREATE OR REPLACE FUNCTION public.advance_use_calendar_turn(
  p_year_id uuid,
  p_expected_seq integer,
  p_next_holder_key text,
  p_next_phase text,
  p_next_round integer,
  p_next_deadline timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.use_calendar_years
    SET turn_holder_key = p_next_holder_key, turn_phase = p_next_phase, turn_round = p_next_round,
        turn_deadline_at = p_next_deadline, turn_seq = turn_seq + 1
    WHERE id = p_year_id AND status = 'selection_open' AND turn_seq = p_expected_seq;
  RETURN FOUND;
END;
$$;

-- These take the holder as a parameter, so only server code may call them.
REVOKE ALL ON FUNCTION public.select_use_calendar_week(uuid, integer, text, uuid, integer, text, text, integer, timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.advance_use_calendar_turn(uuid, integer, text, text, integer, timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.select_use_calendar_week(uuid, integer, text, uuid, integer, text, text, integer, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.advance_use_calendar_turn(uuid, integer, text, text, integer, timestamptz) TO service_role;
