-- divieight — schedule every /api/public/* sweep via pg_cron + pg_net.
--
-- Run ONCE in the Supabase SQL editor after the app is live on Vercel.
-- Before running, replace <SWEEP_SECRET> below with the same value you set as
-- ESCALATION_SWEEP_SECRET in Vercel. If the domain changes, update app_url too.
-- The publishable (anon) key is already public; it is what most sweeps check.
--
-- Re-running is safe: each job is unscheduled first, then recreated.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
DECLARE
  app_url  text := 'https://divieight.vercel.app';
  anon_key text := 'sb_publishable_UL-b0rINbdm07Mjrv104UA_JG1tHTrC';
  secret   text := '<SWEEP_SECRET>';
  job record;
BEGIN
  FOR job IN
    SELECT * FROM (VALUES
      -- name,                          path,                            schedule,       auth
      ('divieight-authorization-escalation', 'authorization-escalation',  '*/15 * * * *', 'apikey'),
      ('divieight-earnest-money-sweep',      'earnest-money-sweep',       '0 * * * *',    'secret'),
      ('divieight-substitution-sweep',       'substitution-sweep',        '15 * * * *',   'secret'),
      ('divieight-listing-approval-esc',     'listing-approval-escalation','30 * * * *',  'apikey'),
      ('divieight-arello-retry',             'arello-retry',              '45 * * * *',   'apikey'),
      ('divieight-logging-health',           'logging-health',            '50 * * * *',   'apikey'),
      ('divieight-diligence-escalation',     'diligence-escalation',      '0 13 * * *',   'apikey'),
      ('divieight-designation-sweep',        'designation-sweep',         '10 13 * * *',  'apikey'),
      ('divieight-enrollment-maintenance',   'enrollment-maintenance',    '20 13 * * *',  'apikey'),
      ('divieight-eo-expiry-sweep',          'eo-expiry-sweep',           '30 13 * * *',  'apikey'),
      ('divieight-hla-sweep',                'hla-sweep',                 '40 13 * * *',  'apikey'),
      ('divieight-nar-cert-sweep',           'nar-cert-sweep',            '50 13 * * *',  'apikey'),
      ('divieight-broker-relationship',      'broker-relationship-sweep', '0 14 * * 1',   'apikey')
    ) AS t(name, path, schedule, auth)
  LOOP
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = job.name;
    PERFORM cron.schedule(
      job.name,
      job.schedule,
      format(
        $cmd$SELECT net.http_post(url := %L, headers := %L::jsonb, body := '{}'::jsonb, timeout_milliseconds := 60000);$cmd$,
        app_url || '/api/public/' || job.path,
        CASE WHEN job.auth = 'secret'
          THEN jsonb_build_object('content-type', 'application/json', 'x-sweep-secret', secret)
          ELSE jsonb_build_object('content-type', 'application/json', 'apikey', anon_key)
        END::text
      )
    );
  END LOOP;
END $$;

-- Check what's scheduled / recent runs:
--   SELECT jobname, schedule FROM cron.job WHERE jobname LIKE 'divieight-%';
--   SELECT * FROM net._http_response ORDER BY created DESC LIMIT 20;
