-- Keep the starter map's names (and the site's) from being taken by sign-ups.
create or replace function public.username_available(name text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select lower(name) ~ '^[a-z0-9_]{3,20}$' and lower(name) not in ('henry', 'grant', 'bookmap', 'jack', 'themoviemap', 'moviemap')
     and not exists (select 1 from profiles where username = lower(name));
$function$;
