-- Launch readiness: the editable status, owner and notes for each placeholder or simulated part of the app. Run once in the
-- Supabase SQL editor. Safe to re-run. Only the server reads and writes it (founder only); every change is also in the audit log.

CREATE TABLE IF NOT EXISTS public.launch_readiness_items (
  key text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('Placeholder', 'Simulated', 'Test mode', 'Needs counsel', 'Done')),
  owner text,
  notes text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.launch_readiness_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.launch_readiness_items FROM anon, authenticated;
GRANT ALL ON public.launch_readiness_items TO service_role;
