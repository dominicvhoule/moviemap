-- MovieMap: keep the starter map's username (and its old one) from being taken by a member.
create or replace function public.username_available(name text) returns boolean
language sql stable security definer set search_path = public as $$
  select lower(name) ~ '^[a-z0-9_]{3,20}$' and lower(name) not in ('henry', 'grant')
     and not exists (select 1 from profiles where username = lower(name));
$$;
