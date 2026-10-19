# MovieMap

Log the films you watch and see where each one takes place on a world map.

Live at **https://dominicvhoule.github.io/moviemap/**

## What it does

- **Map**: every film is a pin at the place its story is set. Dashed pins are approximate (country-level or fictional settings). Every country is labelled, like a printed map. Opening a film suggests well-known titles from the same country.
- **Log a film**: search a title, pick the right match, and MovieMap finds the setting and poster. Move the pin if it's wrong.
- **Letterboxd**: connect your Letterboxd username and every film on your Letterboxd Films page is added, with ratings. The profile stays linked until you press Change profile. New films are picked up automatically: once a day on the server (if `daily-sync` is set up), and whenever the site is opened (at most every 6 hours, with a full re-read weekly).
- **People**: search members by username, follow them, view their maps, find friends from your phone's contacts (Android Chrome), or share an invite link.
- **Phone layout**: wide map on top, posters in a swipeable strip below.

## Where the data comes from

| What | Source |
|---|---|
| Titles, years, directors, posters | [TMDB](https://www.themoviedb.org/) API (key in `config.js`) |
| Where a film takes place | [Wikidata](https://www.wikidata.org/) "narrative location" (P840) |
| When Wikidata has no setting | The places linked in the title's Wikipedia plot, weighted by how often and how early they're mentioned (free, runs in the browser) |
| Optional AI step | Claude reads the Wikipedia plot and TMDB description (`film-setting` function, needs an API key) |
| Last resort | The film's country of origin (TMDB, then Wikidata), marked approximate |
| Accounts, maps, follows | [Supabase](https://supabase.com/) (optional, see below) |

Resolved settings are cached in a shared `film_settings` table so each film is only looked up once.

## Switching on accounts (Supabase, free tier)

Without this step the site still works, but films save only in each visitor's browser.

1. Create a project at [supabase.com](https://supabase.com/).
2. **SQL Editor → New query**: paste all of `supabase/schema.sql` and press **Run**.
3. **Authentication → URL Configuration**: set **Site URL** to `https://dominicvhoule.github.io/moviemap/` and add the same URL under **Redirect URLs**.
4. **Project Settings → API**: copy the **Project URL** and the **anon public** key into `config.js`.

6. **Daily sync (optional)**: keeps maps up to date even when nobody opens the site.
   - **Edge Functions → Secrets**: add `CRON_SECRET` with any long random string (for example from a password generator).
   - **Edge Functions → Deploy a new function → Via editor**: name it `daily-sync`, paste `supabase/functions/daily-sync/index.ts`, turn **Verify JWT off**, and press **Deploy**.
   - **SQL Editor**: paste `supabase/migrations/003_daily_sync.sql`, replace `PASTE-THE-SAME-CRON-SECRET-HERE` with the same string, and press **Run**. It checks everyone at 09:05 UTC, with a second pass at 09:20.

7. **AI settings**: run `supabase/migrations/002_ai_settings.sql` in the SQL Editor. Create an API key at [console.anthropic.com](https://console.anthropic.com/) (add a payment method; it costs well under a cent per title). In **Edge Functions → Secrets**, add `ANTHROPIC_API_KEY`. Then deploy `supabase/functions/film-setting/index.ts` as a new function named `film-setting`, with "Verify JWT" on.

5. **Letterboxd sync**: **Edge Functions → Deploy a new function → Via editor**. Name it `letterboxd-feed`, replace the sample code with `supabase/functions/letterboxd-feed/index.ts`, and press **Deploy**. Leave "Verify JWT" on, so only signed-in members can use it.

The anon key is meant to be public. Row-level security in `schema.sql` lets anyone read maps and profiles, and lets people change only their own.

## Files

```
index.html          page shell
styles.css          all styles (phone layout at the bottom)
config.js           TMDB key + Supabase settings
js/featured.js      Grant's hand-checked starter map, shown to signed-out visitors
js/data.js          TMDB and Wikidata lookups
js/wikiplot.js      reads the places linked in a Wikipedia plot
js/poster.js        printable poster
js/app.js           map, logbook, logging, import, accounts, people
data/world.json     country shapes (Natural Earth via world-atlas)
supabase/schema.sql database tables and access rules
supabase/functions/letterboxd-feed/index.ts  reads public Letterboxd profiles (diary feed, Films pages, film pages)
supabase/functions/daily-sync/index.ts       adds new Letterboxd films for every member, once a day
supabase/functions/film-setting/index.ts     asks Claude where a title is set, from its Wikipedia plot
supabase/migrations/                         database changes to run after the first setup
```

## Limits

- **Letterboxd**: there's no sign-in yet (Letterboxd's API is invitation-only). Sync reads public profile pages, so it only works for public profiles and can break if Letterboxd changes its page layout. Reading pages this way may not be allowed under Letterboxd's terms; switch to the official API once access is granted.
- **Contacts on iPhone**: Safari doesn't let websites read contacts. iPhone users can share an invite link or search by username instead.
- **Settings**: Wikidata has gaps for new and small films. The Wikipedia step picks the most-mentioned linked place, so a plot that passes through a city can land there; titles without linked places fall back to AI (if set up) or the country. Move pin always wins, and moved pins are never overwritten.

This product uses the TMDB API but is not endorsed or certified by TMDB.
