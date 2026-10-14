-- MovieMap database. Paste this whole file into Supabase → SQL Editor → New query, then Run.
-- Safe to re-run: it creates what's missing and replaces the functions and policies.

-- ---------- profiles: one per account, readable by everyone ----------
create table if not exists public.profiles (
  id           uuid primary key references auth.users on delete cascade,
  username     text unique not null check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name text not null default '' check (char_length(display_name) <= 40),
  bio          text not null default '' check (char_length(bio) <= 160),
  letterboxd   text check (letterboxd is null or letterboxd ~ '^[A-Za-z0-9_]{1,30}$'),
  discoverable boolean not null default false,
  created_at   timestamptz not null default now()
);
alter table public.profiles enable row level security;
drop policy if exists "profiles are public" on public.profiles;
create policy "profiles are public" on public.profiles for select using (true);
drop policy if exists "edit own profile" on public.profiles;
create policy "edit own profile" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

-- Create the profile row when someone signs up (username comes from the sign-up form).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, display_name)
  values (new.id, lower(new.raw_user_meta_data->>'username'), coalesce(new.raw_user_meta_data->>'display_name', ''));
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Lets the sign-up form check a username before creating the account.
create or replace function public.username_available(name text) returns boolean
language sql stable security definer set search_path = public as $$
  select lower(name) ~ '^[a-z0-9_]{3,20}$' and not exists (select 1 from profiles where username = lower(name));
$$;
grant execute on function public.username_available(text) to anon, authenticated;

-- ---------- logs: the films on each person's map, readable by everyone ----------
create table if not exists public.logs (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  title       text not null check (char_length(title) <= 300),
  year        int,
  director    text,
  tmdb_id     int,
  poster_path text,
  place       text,
  country     text,
  continent   text,
  lat         double precision not null check (lat between -90 and 90),
  lon         double precision not null check (lon between -180 and 180),
  approx      boolean not null default false,
  note        text check (char_length(note) <= 500),
  rating      numeric(2,1) check (rating between 0.5 and 5),
  reviewed    boolean not null default false,
  watched_on  date,
  source      text,
  created_at  timestamptz not null default now(),
  unique (user_id, title, year)
);
create index if not exists logs_user_idx on public.logs(user_id);
alter table public.logs enable row level security;
drop policy if exists "logs are public" on public.logs;
create policy "logs are public" on public.logs for select using (true);
drop policy if exists "add own logs" on public.logs;
create policy "add own logs" on public.logs for insert with check (auth.uid() = user_id);
drop policy if exists "edit own logs" on public.logs;
create policy "edit own logs" on public.logs for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "delete own logs" on public.logs;
create policy "delete own logs" on public.logs for delete using (auth.uid() = user_id);

-- ---------- follows ----------
create table if not exists public.follows (
  follower   uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  followee   uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower, followee),
  check (follower <> followee)
);
alter table public.follows enable row level security;
drop policy if exists "follows are public" on public.follows;
create policy "follows are public" on public.follows for select using (true);
drop policy if exists "follow as yourself" on public.follows;
create policy "follow as yourself" on public.follows for insert with check (auth.uid() = follower);
drop policy if exists "unfollow as yourself" on public.follows;
create policy "unfollow as yourself" on public.follows for delete using (auth.uid() = follower);

-- ---------- shared cache of film settings (saves every user re-looking-up the same film) ----------
create table if not exists public.film_settings (
  tmdb_id    int primary key,
  place      text, country text, continent text,
  lat        double precision not null check (lat between -90 and 90),
  lon        double precision not null check (lon between -180 and 180),
  approx     boolean not null default false,
  note       text check (char_length(note) <= 500),
  source     text check (source in ('wikidata','production')),
  updated_at timestamptz not null default now()
);
alter table public.film_settings enable row level security;
drop policy if exists "settings are public" on public.film_settings;
create policy "settings are public" on public.film_settings for select using (true);
drop policy if exists "signed-in users add settings" on public.film_settings;
create policy "signed-in users add settings" on public.film_settings for insert to authenticated with check (true);
-- No update policy: a cached setting is written once. Personal corrections live on each person's own log.

-- ---------- finding friends from phone contacts ----------
-- Each person can store hashes of their own email/phone. Nobody can read the table;
-- the only way in is find_by_contacts, which answers for people who opted in.
create table if not exists public.contact_keys (
  user_id uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  hash    text not null check (hash ~ '^[0-9a-f]{64}$'),
  primary key (user_id, hash)
);
alter table public.contact_keys enable row level security;
drop policy if exists "manage own contact keys" on public.contact_keys;
create policy "manage own contact keys" on public.contact_keys for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function public.find_by_contacts(hashes text[]) returns table (username text, display_name text)
language sql stable security definer set search_path = public as $$
  select distinct p.username, p.display_name
  from contact_keys k join profiles p on p.id = k.user_id
  where p.discoverable
    and k.hash = any (hashes[1:500])
    and p.id <> auth.uid();
$$;
revoke execute on function public.find_by_contacts(text[]) from public, anon;
grant execute on function public.find_by_contacts(text[]) to authenticated;
