-- MovieMap: the starter map shown to visitors who aren't signed in, synced from a Letterboxd profile
-- by daily-sync. Anyone can read it; only the server (service role) writes to it.
create table if not exists public.starters (
  username     text primary key check (username ~ '^[A-Za-z0-9_]{1,30}$'),   -- the Letterboxd username
  display_name text not null default '',
  bio          text not null default '',
  last_synced  timestamptz
);
create table if not exists public.starter_logs (
  id          bigint generated always as identity primary key,
  map         text not null references public.starters(username) on delete cascade,
  title       text not null check (char_length(title) <= 300),
  year        int,
  director    text,
  tmdb_id     int,
  poster_path text,
  place       text, country text, continent text,
  lat         double precision not null check (lat between -90 and 90),
  lon         double precision not null check (lon between -180 and 180),
  approx      boolean not null default false,
  note        text check (char_length(note) <= 500),
  rating      numeric(2,1) check (rating between 0.5 and 5),
  watched_on  date,
  source      text,
  lb_slug     text,
  created_at  timestamptz not null default now(),
  unique (map, title, year)
);
create index if not exists starter_logs_map on public.starter_logs (map, lb_slug);
alter table public.starters enable row level security;
alter table public.starter_logs enable row level security;
drop policy if exists "starters are public" on public.starters;
create policy "starters are public" on public.starters for select using (true);
drop policy if exists "starter films are public" on public.starter_logs;
create policy "starter films are public" on public.starter_logs for select using (true);

insert into public.starters (username, display_name) values ('mattgoold', 'mattgoold') on conflict do nothing;
