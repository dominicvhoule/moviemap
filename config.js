// MovieMap settings. Everything here is public by design: it ships to every visitor's browser.
window.MOVIEMAP_CONFIG = {
  // TMDB API key (read-only). Regenerate at themoviedb.org → Settings → API if it's ever misused.
  TMDB_KEY: "3cd25fb4afb7cee1db7ca88a3c386a30",

  // Supabase project for accounts. Leave blank to run without accounts (films save in the browser).
  // Find both at supabase.com → your project → Project Settings → API.
  // The anon key is meant to be public; the database rules in supabase/schema.sql protect the data.
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: ""
};
