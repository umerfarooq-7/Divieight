-- Referral confirmation and the library approver. Run once in the Supabase SQL editor, AFTER agent-qr-attribution.sql and
-- library.sql. Safe to re-run.
--
--  1. buyer_attribution.response: what the buyer said to "Confirm this agent as your referring agent?"
--     ('confirmed' or 'declined'; NULL means not asked yet). Only a confirmation sets referring_agent_id, and that is
--     done by the server; nothing here touches buyer_accounts or any existing referring agent.
--  2. library_videos.created_by: who created a video, so the compliance approver can be required to be someone else
--     (the server checks it, and so does the database).

ALTER TABLE public.buyer_attribution ADD COLUMN IF NOT EXISTS response text;
ALTER TABLE public.buyer_attribution DROP CONSTRAINT IF EXISTS buyer_attribution_response_check;
ALTER TABLE public.buyer_attribution ADD CONSTRAINT buyer_attribution_response_check CHECK (response IS NULL OR response IN ('confirmed', 'declined'));
ALTER TABLE public.buyer_attribution ADD COLUMN IF NOT EXISTS responded_at timestamptz;

ALTER TABLE public.library_videos ADD COLUMN IF NOT EXISTS created_by uuid;

-- The approver is never the creator. (A video with no recorded creator, from before this existed, isn't blocked.)
CREATE OR REPLACE FUNCTION public.library_videos_different_approver()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.compliance_approved_by IS NOT NULL
     AND NEW.created_by IS NOT NULL
     AND NEW.compliance_approved_by = NEW.created_by
     AND (TG_OP = 'INSERT' OR OLD.compliance_approved_by IS DISTINCT FROM NEW.compliance_approved_by) THEN
    RAISE EXCEPTION 'A video has to be approved by a different admin than the one who created it.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS library_videos_different_approver ON public.library_videos;
CREATE TRIGGER library_videos_different_approver BEFORE INSERT OR UPDATE ON public.library_videos
  FOR EACH ROW EXECUTE FUNCTION public.library_videos_different_approver();
