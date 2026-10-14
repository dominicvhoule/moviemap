# MovieMap

Log the films you watch and see where each one takes place on a world map.

Live at **https://dominicvhoule.github.io/moviemap/**

## What it does

- **Map**: every film is a pin at the place its story is set. Dashed pins are approximate (country-level or fictional settings).
- **Log a film**: search a title, pick the right match, and MovieMap finds the setting and poster. Move the pin if it's wrong.
- **Letterboxd**: drop your Letterboxd export (.zip) to bring in your whole watched history with ratings. Export again later to add only new films.
- **People**: search members by username, follow them, view their maps, find friends from your phone's contacts (Android Chrome), or share an invite link.
- **Phone layout**: wide map on top, posters in a swipeable strip below.

## Where the data comes from

| What | Source |
|---|---|
| Titles, years, directors, posters | [TMDB](https://www.themoviedb.org/) API (key in `config.js`) |
| Where a film takes place | [Wikidata](https://www.wikidata.org/) "narrative location" (P840) |
| Fallback when Wikidata has nothing | The film's first production country, marked approximate |
| Accounts, maps, follows | [Supabase](https://supabase.com/) (optional, see below) |

Resolved settings are cached in a shared `film_settings` table so each film is only looked up once.

## Switching on accounts (Supabase, free tier)

Without this step the site still works, but films save only in each visitor's browser.

1. Create a project at [supabase.com](https://supabase.com/).
2. **SQL Editor → New query**: paste all of `supabase/schema.sql` and press **Run**.
3. **Authentication → URL Configuration**: set **Site URL** to `https://dominicvhoule.github.io/moviemap/` and add the same URL under **Redirect URLs**.
4. **Project Settings → API**: copy the **Project URL** and the **anon public** key into `config.js`.

The anon key is meant to be public. Row-level security in `schema.sql` lets anyone read maps and profiles, and lets people change only their own.

## Files

```
index.html          page shell
styles.css          all styles (phone layout at the bottom)
config.js           TMDB key + Supabase settings
js/featured.js      Grant's hand-checked starter map, shown to signed-out visitors
js/data.js          TMDB, Wikidata, Letterboxd export parsing
js/app.js           map, logbook, logging, import, accounts, people
data/world.json     country shapes (Natural Earth via world-atlas)
supabase/schema.sql database tables and access rules
```

## Limits

- **Letterboxd sign-in**: Letterboxd doesn't offer sign-in or an open API to other sites, so syncing works through the export file.
- **Contacts on iPhone**: Safari doesn't let websites read contacts. iPhone users can share an invite link or search by username instead.
- **Wikidata coverage**: very new or obscure films often have no setting recorded yet, so they fall back to an approximate country pin.

This product uses the TMDB API but is not endorsed or certified by TMDB.
