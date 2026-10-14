-- MovieMap: allow settings worked out by AI from a film's plot.
-- Paste into Supabase → SQL Editor → New query, then Run. Safe to run more than once.
alter table public.film_settings drop constraint if exists film_settings_source_check;
alter table public.film_settings add constraint film_settings_source_check check (source in ('wikidata','production','ai'));
