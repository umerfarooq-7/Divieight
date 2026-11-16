-- divieight — schedule every /api/public/* sweep via pg_cron + pg_net.
--
-- Run ONCE in the Supabase SQL editor after the app is live on Vercel.
-- Before running, replace <SWEEP_SECRET> below with the same value you set as
-- ESCALATION_SWEEP_SECRET in Vercel. If the domain changes, update app_url too.
-- Every job is called with the shared secret in the x-sweep-secret header. (An earlier version sent the publishable key, which is public: anyone could have
-- triggered those jobs. The endpoints now accept only the secret, so re-run this file after setting ESCALATION_SWEEP_SECRET (24 characters or more).)
--
-- Re-running is safe: each job is unscheduled first, then recreated.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
DECLARE
  app_url  text := 'https://divieight.vercel.app';
  secret   text := '<SWEEP_SECRET>';
  job record;
BEGIN
  FOR job IN
    SELECT * FROM (VALUES
      -- name,                          path,                            schedule,       auth
      ('divieight-authorization-escalation', 'authorization-escalation',  '*/15 * * * *', 'secret'),
      ('divieight-earnest-money-sweep',      'earnest-money-sweep',       '0 * * * *',    'secret'),
      ('divieight-closing-funds-sweep',      'closing-funds-sweep',       '5 * * * *',    'secret'),
      ('divieight-substitution-sweep',       'substitution-sweep',        '15 * * * *',   'secret'),
      ('divieight-listing-approval-esc',     'listing-approval-escalation','30 * * * *',  'secret'),
      ('divieight-arello-retry',             'arello-retry',              '45 * * * *',   'secret'),
      ('divieight-logging-health',           'logging-health',            '50 * * * *',   'secret'),
      ('divieight-diligence-escalation',     'diligence-escalation',      '0 13 * * *',   'secret'),
      ('divieight-designation-sweep',        'designation-sweep',         '10 13 * * *',  'secret'),
      ('divieight-enrollment-maintenance',   'enrollment-maintenance',    '20 13 * * *',  'secret'),
      ('divieight-eo-expiry-sweep',          'eo-expiry-sweep',           '30 13 * * *',  'secret'),
      ('divieight-hla-sweep',                'hla-sweep',                 '40 13 * * *',  'secret'),
      ('divieight-nar-cert-sweep',           'nar-cert-sweep',            '50 13 * * *',  'secret'),
      ('divieight-insurance-sweep',          'insurance-sweep',           '0 12 * * *',   'secret'),
      ('divieight-use-calendar-sweep',       'use-calendar-sweep',        '15 * * * *',   'secret'),
      ('divieight-retention-sweep',          'retention-sweep',           '25 * * * *',   'secret'),
      ('divieight-resale-sweep',             'resale-sweep',              '35 * * * *',   'secret'),
      ('divieight-bank-feed-sweep',          'bank-feed-sweep',           '0 11 * * *',   'secret'),
      ('divieight-recurring-sweep',          'recurring-sweep',           '30 11 * * *',  'secret'),
      ('divieight-statements-sweep',         'statements-sweep',          '0 10 * * *',   'secret'),
      ('divieight-year-end-packet-sweep',    'year-end-packet-sweep',     '0 9 * * *',    'secret'),
      ('divieight-tax-form-sweep',          'tax-form-sweep',            '30 9 * * *',   'secret'),
      ('divieight-audit-vault-sweep',       'audit-vault-sweep',         '15 3 * * *',   'secret'),
      ('divieight-kyo-retention-sweep',     'kyo-retention-sweep',       '45 3 * * *',   'secret'),
      ('divieight-resale-expiry',            'resale-expiry-sweep',       '30 4 * * *',   'secret'),
      ('divieight-held-reminders',           'held-reminder-sweep',       '0 5 * * *',    'secret'),
      ('divieight-capital-call-sweep',       'capital-call-sweep',        '5 13 * * *',   'secret'),
      ('divieight-conversion-sweep',         'conversion-sweep',          '45 * * * *',   'secret'),
      ('divieight-owner-reminders',          'owner-reminders-sweep',     '10 * * * *',   'secret'),
      ('divieight-founder-refresh',          'founder-refresh',           '30 7 * * *',   'secret'),
      ('divieight-broker-relationship',      'broker-relationship-sweep', '0 14 * * 1',   'secret')
    ) AS t(name, path, schedule, auth)
  LOOP
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = job.name;
    PERFORM cron.schedule(
      job.name,
      job.schedule,
      format(
        $cmd$SELECT net.http_post(url := %L, headers := %L::jsonb, body := '{}'::jsonb, timeout_milliseconds := 60000);$cmd$,
        app_url || '/api/public/' || job.path,
        jsonb_build_object('content-type', 'application/json', 'x-sweep-secret', secret)::text
      )
    );
  END LOOP;
END $$;

-- Check what's scheduled / recent runs:
--   SELECT jobname, schedule FROM cron.job WHERE jobname LIKE 'divieight-%';
--   SELECT * FROM net._http_response ORDER BY created DESC LIMIT 20;
