// MovieMap settings. Everything here is public by design: it ships to every visitor's browser.
window.MOVIEMAP_CONFIG = {
  // TMDB API key (read-only). Regenerate at themoviedb.org → Settings → API if it's ever misused.
  TMDB_KEY: "3cd25fb4afb7cee1db7ca88a3c386a30",

  // Supabase project for accounts. Leave blank to run without accounts (films save in the browser).
  // Find both at supabase.com → your project → Project Settings → API.
  // The anon key is meant to be public; the database rules in supabase/schema.sql protect the data.
  SUPABASE_URL: "https://hwzxyfpqxqndgjbiaiec.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh3enh5ZnBxeHFuZGdqYmlhaWVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIwMDcwNTUsImV4cCI6MjEwNzU4MzA1NX0.S_hcRPnvgmq5uMyKWU2i8W0AJ97tuJ8lAbBgPhYPP04"
};
