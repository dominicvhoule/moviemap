-- MovieMap: check every linked Letterboxd profile once a day, on the server.
-- Before running: deploy supabase/functions/daily-sync (Verify JWT OFF) and add the CRON_SECRET secret.
-- Replace PASTE-THE-SAME-CRON-SECRET-HERE below with that same value, then Run.

alter table public.profiles add column if not exists last_synced timestamptz;

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Keep the secret in Supabase Vault rather than in the schedule itself.
select vault.create_secret('PASTE-THE-SAME-CRON-SECRET-HERE', 'moviemap_cron_secret')
where not exists (select 1 from vault.secrets where name = 'moviemap_cron_secret');

-- Remove an older copy of the schedule if this is run twice.
select cron.unschedule(jobid) from cron.job where jobname in ('moviemap-daily-sync', 'moviemap-daily-sync-2');

-- 09:05 UTC, then again at 09:20 for anyone the first run didn't reach (each run stops after ~2 minutes).
select cron.schedule('moviemap-daily-sync', '5 9 * * *', $$
  select net.http_post(
    url := 'https://hwzxyfpqxqndgjbiaiec.supabase.co/functions/v1/daily-sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'moviemap_cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 150000);
$$);
select cron.schedule('moviemap-daily-sync-2', '20 9 * * *', $$
  select net.http_post(
    url := 'https://hwzxyfpqxqndgjbiaiec.supabase.co/functions/v1/daily-sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'moviemap_cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 150000);
$$);

-- To test right away, run just the net.http_post(...) part above, then check the result with:
--   select status_code, content from net._http_response order by created desc limit 1;
