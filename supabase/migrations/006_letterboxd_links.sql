-- MovieMap: remember which Letterboxd film each pin came from, so ratings and removals on Letterboxd
-- can be copied over. Pins added by hand have no slug and are never touched by syncing.
alter table public.logs add column if not exists lb_slug text check (lb_slug is null or lb_slug ~ '^[a-z0-9-]{1,120}$');
create index if not exists logs_user_lb_slug on public.logs (user_id, lb_slug);
