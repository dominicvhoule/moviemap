// MovieMap: read a member's public Letterboxd diary feed and return it as JSON.
// Browsers can't read letterboxd.com directly, so the site asks this function instead.
// It only ever fetches https://letterboxd.com/<username>/rss/ for a valid username, so it can't be used to reach other sites.
// Deploy: Supabase dashboard → Edge Functions → Deploy a new function → Via editor, name it "letterboxd-feed", paste this file.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
const tag = (s: string, t: string) => {
  const m = s.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`));
  return m ? decode(m[1].replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "")).trim() : "";
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  let username = "";
  try { username = String((await req.json()).username ?? "").trim(); } catch { /* fall through */ }
  if (!/^[A-Za-z0-9_]{1,30}$/.test(username)) return json({ error: "bad_username" }, 400);

  let res: Response;
  try {
    res = await fetch(`https://letterboxd.com/${username}/rss/`, {
      headers: { "User-Agent": "MovieMap/1.0 (+https://dominicvhoule.github.io/moviemap/)", Accept: "application/rss+xml" },
    });
  } catch {
    return json({ error: "unreachable" }, 502);
  }
  if (res.status === 404) return json({ error: "not_found" }, 404);
  if (!res.ok) return json({ error: "upstream", status: res.status }, 502);

  const xml = await res.text();
  const films = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .map((m) => m[1])
    .map((s) => ({
      title: tag(s, "letterboxd:filmTitle"),
      year: Number(tag(s, "letterboxd:filmYear")) || null,
      rating: Number(tag(s, "letterboxd:memberRating")) || null,
      watched: tag(s, "letterboxd:watchedDate") || null,
      rewatch: tag(s, "letterboxd:rewatch") === "Yes",
      tmdb: Number(tag(s, "tmdb:movieId")) || null,
    }))
    .filter((f) => f.title && f.tmdb);   // drops list posts and TV entries

  return json({ username, films });
});
