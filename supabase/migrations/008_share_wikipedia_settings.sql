-- MovieMap: settings found from Wikipedia plots (and by the optional AI step) are shared too, so a
-- title is only looked up once for everybody.
alter table public.film_settings drop constraint if exists film_settings_source_check;
alter table public.film_settings add constraint film_settings_source_check check (source in ('wikidata','wikipedia','production','ai'));
