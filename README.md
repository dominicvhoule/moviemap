# MovieMap

Log the films you watch and see where each one takes place on a world map.

Live at **https://dominicvhoule.github.io/moviemap/**

## What it does

- **Map**: every film is a pin at the place its story is set. Dashed pins are approximate (country-level or fictional settings). Country names appear as you zoom in.
- **Log a film**: search a title, pick the right match, and MovieMap finds the setting and poster. Move the pin if it's wrong.
- **Letterboxd**: connect your Letterboxd username and every film on your Letterboxd Films page is added, with ratings. New ones are picked up when you open the site (at most every 6 hours); Sync now re-reads everything.
- **People**: search members by username, follow them, view their maps, find friends from your phone's contacts (Android Chrome), or share an invite link.
- **Phone layout**: wide map on top, posters in a swipeable strip below.

## Where the data comes from

| What | Source |
|---|---|
| Titles, years, directors, posters | [TMDB](https://www.themoviedb.org/) API (key in `config.js`) |
| Where a film takes place | [Wikidata](https://www.wikidata.org/) "narrative location" (P840) |
| Fallback when Wikidata has no setting | The film's country of origin (Wikidata, then TMDB), marked approximate |
| Accounts, maps, follows | [Supabase](https://supabase.com/) (optional, see below) |

Resolved settings are cached in a shared `film_settings` table so each film is only looked up once.

## Switching on accounts (Supabase, free tier)

Without this step the site still works, but films save only in each visitor's browser.

1. Create a project at [supabase.com](https://supabase.com/).
2. **SQL Editor → New query**: paste all of `supabase/schema.sql` and press **Run**.
3. **Authentication → URL Configuration**: set **Site URL** to `https://dominicvhoule.github.io/moviemap/` and add the same URL under **Redirect URLs**.
4. **Project Settings → API**: copy the **Project URL** and the **anon public** key into `config.js`.

5. **Letterboxd sync**: **Edge Functions → Deploy a new function → Via editor**. Name it `letterboxd-feed`, replace the sample code with `supabase/functions/letterboxd-feed/index.ts`, and press **Deploy**. Leave "Verify JWT" on, so only signed-in members can use it.

The anon key is meant to be public. Row-level security in `schema.sql` lets anyone read maps and profiles, and lets people change only their own.

## Files

```
index.html          page shell
styles.css          all styles (phone layout at the bottom)
config.js           TMDB key + Supabase settings
js/featured.js      Grant's hand-checked starter map, shown to signed-out visitors
js/data.js          TMDB and Wikidata lookups
js/app.js           map, logbook, logging, import, accounts, people
data/world.json     country shapes (Natural Earth via world-atlas)
supabase/schema.sql database tables and access rules
supabase/functions/letterboxd-feed/index.ts  reads public Letterboxd profiles (diary feed, Films pages, film pages)
```

## Limits

- **Letterboxd**: there's no sign-in yet (Letterboxd's API is invitation-only). Sync reads public profile pages, so it only works for public profiles and can break if Letterboxd changes its page layout. Reading pages this way may not be allowed under Letterboxd's terms; switch to the official API once access is granted.
- **Contacts on iPhone**: Safari doesn't let websites read contacts. iPhone users can share an invite link or search by username instead.
- **Wikidata coverage**: very new or obscure films often have no setting recorded yet, so they fall back to an approximate country pin.

This product uses the TMDB API but is not endorsed or certified by TMDB.
