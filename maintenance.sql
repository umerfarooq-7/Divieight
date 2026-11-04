-- Maintenance Requests. Run once in the Supabase SQL editor, AFTER owner-dashboard.sql.
-- Safe to re-run. Only adds tables; existing tables are untouched.

CREATE TABLE IF NOT EXISTS public.maintenance_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  submitted_by_user_id uuid NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  category text NOT NULL,
  urgency text NOT NULL DEFAULT 'normal' CHECK (urgency IN ('low', 'normal', 'urgent')),
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'triaged', 'approved', 'in_progress', 'completed', 'rejected')),
  estimated_cost numeric CHECK (estimated_cost >= 0),
  actual_cost numeric CHECK (actual_cost >= 0),
  vendor_name text,
  -- Storage paths in the private property-documents bucket, never public links.
  photos text[] NOT NULL DEFAULT '{}',
  -- Set by the Expense system (Prompt 11) when it links the expense.
  expense_id uuid,
  -- "Attributed to LLC operating account": waiting for the Expense system to pick it up.
  expense_queued_at timestamptz,
  expense_queued_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expense_queued_at IS NULL OR (status = 'completed' AND COALESCE(actual_cost, 0) > 0))
);
CREATE INDEX IF NOT EXISTS maintenance_requests_property_idx ON public.maintenance_requests (property_id, created_at DESC);
CREATE INDEX IF NOT EXISTS maintenance_requests_status_idx ON public.maintenance_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS maintenance_requests_expense_queue_idx ON public.maintenance_requests (expense_queued_at) WHERE expense_queued_at IS NOT NULL AND expense_id IS NULL;

CREATE TABLE IF NOT EXISTS public.maintenance_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.maintenance_requests(id) ON DELETE CASCADE,
  author_id uuid,
  note text,
  status_change text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS maintenance_updates_request_idx ON public.maintenance_updates (request_id, created_at);

-- Read-only for signed-in users: every write goes through the server functions.
GRANT SELECT ON public.maintenance_requests, public.maintenance_updates TO authenticated;
GRANT ALL ON public.maintenance_requests, public.maintenance_updates TO service_role;
ALTER TABLE public.maintenance_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_updates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owners read their property's maintenance" ON public.maintenance_requests;
CREATE POLICY "owners read their property's maintenance" ON public.maintenance_requests
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.is_property_owner(auth.uid(), property_id));

DROP POLICY IF EXISTS "owners read their property's maintenance updates" ON public.maintenance_updates;
CREATE POLICY "owners read their property's maintenance updates" ON public.maintenance_updates
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (
      SELECT 1 FROM public.maintenance_requests r
      WHERE r.id = request_id AND public.is_property_owner(auth.uid(), r.property_id)
    )
  );
