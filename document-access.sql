-- Document access stages (Pre-Engagement, Pre-Payment, Pre-Signing, At-Signing, Post-Signing).
-- Run in the Supabase SQL editor AFTER member-steps.sql (account_members, signed_documents). Safe to run again. Only adds two tables: nothing existing is changed.
--
--   * document_review_acknowledgments: the positive acknowledgment a member gives after reading a document to the end on a review screen (the Pre-Payment
--     Review of the PRA, and each Pre-Signing Review). One per member per document per version. Never edited or deleted.
--   * executed_document_texts: the exact text of a document as it was executed, keyed by its document hash. Written once, never changed, so a later
--     template revision can never alter what a member signed. Member Documents downloads the executed copy from here.

CREATE TABLE IF NOT EXISTS public.document_review_acknowledgments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_member_id uuid NOT NULL,
  buyer_account_id uuid NOT NULL,
  document_type text NOT NULL,
  document_version text NOT NULL,
  document_hash text NOT NULL,
  -- The reader scrolled to the bottom before acknowledging (the server refuses an acknowledgment without it).
  reached_end boolean NOT NULL DEFAULT true CHECK (reached_end),
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  UNIQUE (account_member_id, document_type, document_version)
);
CREATE INDEX IF NOT EXISTS document_review_ack_account_idx ON public.document_review_acknowledgments (buyer_account_id, document_type);

CREATE OR REPLACE FUNCTION public.document_access_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is a record: it is never edited or deleted.', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END;
$$;
DROP TRIGGER IF EXISTS document_review_ack_history ON public.document_review_acknowledgments;
CREATE TRIGGER document_review_ack_history BEFORE UPDATE OR DELETE ON public.document_review_acknowledgments FOR EACH ROW EXECUTE FUNCTION public.document_access_immutable();

CREATE TABLE IF NOT EXISTS public.executed_document_texts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_hash text NOT NULL,
  document_type text NOT NULL,
  document_version text NOT NULL,
  body text NOT NULL,
  -- A real digest of the text (the document hash above is the one the signing screen shows and the signature carries).
  body_sha256 text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_hash, document_type)
);
DROP TRIGGER IF EXISTS executed_document_texts_history ON public.executed_document_texts;
CREATE TRIGGER executed_document_texts_history BEFORE UPDATE OR DELETE ON public.executed_document_texts FOR EACH ROW EXECUTE FUNCTION public.document_access_immutable();

ALTER TABLE public.document_review_acknowledgments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.executed_document_texts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.document_review_acknowledgments, public.executed_document_texts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.document_review_acknowledgments, public.executed_document_texts TO service_role;
REVOKE ALL ON FUNCTION public.document_access_immutable() FROM PUBLIC, anon, authenticated;
-- Everything is read and written through the server (service role), which checks who is asking. No policy for members or anon: they have no direct access.
