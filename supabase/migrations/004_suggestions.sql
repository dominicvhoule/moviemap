-- MovieMap: shared "More like this" suggestions, so each title is only looked up once for everybody.
create table if not exists public.film_suggestions (
  key        text primary key check (char_length(key) <= 80),
  pool       jsonb not null check (jsonb_typeof(pool) = 'array' and jsonb_array_length(pool) <= 30),
  updated_at timestamptz not null default now()
);
alter table public.film_suggestions enable row level security;

drop policy if exists "suggestions are public" on public.film_suggestions;
create policy "suggestions are public" on public.film_suggestions for select using (true);
drop policy if exists "members add suggestions" on public.film_suggestions;
create policy "members add suggestions" on public.film_suggestions for insert to authenticated with check (true);
drop policy if exists "members refresh suggestions" on public.film_suggestions;
create policy "members refresh suggestions" on public.film_suggestions for update to authenticated using (true) with check (true);
