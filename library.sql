-- Buyer Learning Library. Run once in the Supabase SQL editor, AFTER agent-qr-attribution.sql.
-- Safe to re-run. Only adds tables. Seeds the 7 clusters with PLACEHOLDER names and no videos:
-- content comes after Module 3 compliance review.

CREATE TABLE IF NOT EXISTS public.library_clusters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0
);

-- Only into an empty table, so re-running this never undoes a rename.
INSERT INTO public.library_clusters (name, sort_order)
SELECT v.name, v.sort_order
FROM (VALUES
  ('Basics', 1), ('Co-Ownership', 2), ('Legal Structure', 3), ('Costs & Fees', 4),
  ('Agents & Referrals', 5), ('Closing Process', 6), ('Living as an Owner', 7)
) AS v(name, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM public.library_clusters);

CREATE TABLE IF NOT EXISTS public.library_videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id uuid NOT NULL REFERENCES public.library_clusters(id) ON DELETE RESTRICT,
  title text NOT NULL,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text,
  -- Always this one form, so nothing but a YouTube video can reach the embed.
  youtube_url text CHECK (youtube_url ~ '^https://www\.youtube\.com/watch\?v=[A-Za-z0-9_-]{11}$'),
  script_text text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'compliance_review', 'approved', 'published')),
  compliance_approved_by uuid,
  compliance_approved_at timestamptz,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS library_videos_cluster_idx ON public.library_videos (cluster_id, sort_order);
CREATE INDEX IF NOT EXISTS library_videos_status_idx ON public.library_videos (status);

-- No personal data: which video, when, and the agent's link if the visitor came through one.
CREATE TABLE IF NOT EXISTS public.library_view_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES public.library_videos(id) ON DELETE RESTRICT,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  attribution_token_id uuid REFERENCES public.agent_attribution_tokens(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS library_view_events_video_idx ON public.library_view_events (video_id, viewed_at DESC);

-- The compliance path, held here so no write can skip it:
-- draft → compliance_review → approved (an admin, recorded) → published.
-- Changing what a viewer sees sends a video back to draft: approval was for the old content.
CREATE OR REPLACE FUNCTION public.library_video_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Only a draft can be deleted' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtext('library_videos_capacity'));
    IF (SELECT count(*) FROM public.library_videos) >= 24 THEN
      RAISE EXCEPTION 'The library holds 24 videos' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status <> 'draft' OR NEW.compliance_approved_by IS NOT NULL OR NEW.compliance_approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'A new video starts as a draft' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  NEW.updated_at := now();

  IF OLD.status <> 'draft' AND (
    NEW.title IS DISTINCT FROM OLD.title OR NEW.slug IS DISTINCT FROM OLD.slug
    OR NEW.description IS DISTINCT FROM OLD.description OR NEW.youtube_url IS DISTINCT FROM OLD.youtube_url
    OR NEW.script_text IS DISTINCT FROM OLD.script_text
  ) THEN
    NEW.status := 'draft';
    NEW.compliance_approved_by := NULL;
    NEW.compliance_approved_at := NULL;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status = 'compliance_review')
    OR (OLD.status = 'compliance_review' AND NEW.status IN ('approved', 'draft'))
    OR (OLD.status = 'approved' AND NEW.status IN ('published', 'draft'))
    OR (OLD.status = 'published' AND NEW.status IN ('approved', 'draft'))
  ) THEN
    RAISE EXCEPTION 'A % video can''t move to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'compliance_review' AND (NEW.youtube_url IS NULL OR COALESCE(btrim(NEW.script_text), '') = '') THEN
    RAISE EXCEPTION 'A video needs its YouTube link and script before review' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status IN ('draft', 'compliance_review') THEN
    NEW.compliance_approved_by := NULL;
    NEW.compliance_approved_at := NULL;
  ELSIF OLD.status = 'compliance_review' THEN
    IF NEW.compliance_approved_by IS NULL THEN
      RAISE EXCEPTION 'Approval must record who approved' USING ERRCODE = 'check_violation';
    END IF;
    NEW.compliance_approved_at := now();
  ELSIF NEW.compliance_approved_by IS DISTINCT FROM OLD.compliance_approved_by
     OR NEW.compliance_approved_at IS DISTINCT FROM OLD.compliance_approved_at THEN
    RAISE EXCEPTION 'A recorded approval can''t be changed' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS library_videos_guard ON public.library_videos;
CREATE TRIGGER library_videos_guard BEFORE INSERT OR UPDATE OR DELETE ON public.library_videos
  FOR EACH ROW EXECUTE FUNCTION public.library_video_guard();

-- The public reads through the server, which returns published videos only.
GRANT SELECT ON public.library_clusters, public.library_videos, public.library_view_events TO authenticated;
GRANT ALL ON public.library_clusters, public.library_videos, public.library_view_events TO service_role;
ALTER TABLE public.library_clusters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.library_videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.library_view_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admins read library clusters" ON public.library_clusters;
CREATE POLICY "admins read library clusters" ON public.library_clusters
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS "admins read library videos" ON public.library_videos;
CREATE POLICY "admins read library videos" ON public.library_videos
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS "admins read library views" ON public.library_view_events;
CREATE POLICY "admins read library views" ON public.library_view_events
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
