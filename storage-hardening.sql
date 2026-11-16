-- Storage hardening: size and type limits on every bucket, and the private ones forced private. Run in the Supabase SQL editor. Safe to run again.
--
-- A browser uploads straight to Supabase Storage, so the only limit the browser cannot skip is the one on the bucket itself. (The app also checks a file before it
-- uploads, to give a clear message; that check is a courtesy, this is the enforcement.) A bucket that does not exist yet is skipped: run this after the scripts that
-- create the buckets, and again when a new bucket is added.
--
--   private (public = false): identity-documents, liveness-selfies, property-documents, ledger-receipts, agent-documents, statements, year-end-packets, packet-pii, tax-ready
--   public by design:        property-media (listing photos shown on public pages)
--
-- Private files are only ever handed out as signed URLs that expire in 10 minutes or less (see docs/security-hardening.md).

DO $$
DECLARE spec record;
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN RETURN; END IF;
  FOR spec IN SELECT * FROM (VALUES
    -- bucket,              public, max bytes,             allowed types
    ('identity-documents',   false, 10 * 1024 * 1024,  ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
    ('liveness-selfies',     false,  5 * 1024 * 1024,  ARRAY['image/jpeg', 'image/png', 'image/webp']),
    ('property-documents',   false, 25 * 1024 * 1024,  ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/markdown', 'text/plain',
                                                             'application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
    ('ledger-receipts',      false, 10 * 1024 * 1024,  ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp']),
    ('agent-documents',      false, 10 * 1024 * 1024,  ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp']),
    ('statements',           false, 25 * 1024 * 1024,  ARRAY['application/pdf']),
    ('year-end-packets',     false, 50 * 1024 * 1024,  ARRAY['application/pdf', 'application/json', 'text/csv', 'application/zip',
                                                             'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']),
    ('packet-pii',           false, 50 * 1024 * 1024,  ARRAY['application/pdf', 'application/json', 'text/csv', 'application/zip',
                                                             'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']),
    ('tax-ready',            false, 50 * 1024 * 1024,  ARRAY['application/pdf', 'application/json', 'text/csv', 'application/zip',
                                                             'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']),
    ('property-media',       true,  50 * 1024 * 1024,  ARRAY['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime'])
  ) AS t(id, is_public, max_bytes, types)
  LOOP
    UPDATE storage.buckets SET public = spec.is_public, file_size_limit = spec.max_bytes, allowed_mime_types = spec.types WHERE id = spec.id;
  END LOOP;
END;
$$;
