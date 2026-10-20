-- MovieMap: remember which Letterboxd friends have already been followed for each member,
-- so someone you unfollow on MovieMap isn't followed again on the next check.
alter table public.profiles add column if not exists lb_seen text[] not null default '{}';
