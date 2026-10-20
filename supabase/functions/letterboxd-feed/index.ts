// MovieMap: read a member's public Letterboxd data and return it as JSON.
// Browsers can't read letterboxd.com directly, so the site asks this function instead.
// It only fetches letterboxd.com pages built from a validated username or film slug, so it can't reach other sites.
// Deploy: Supabase dashboard → Edge Functions → letterboxd-feed → Code, paste this file, Deploy.
//
// Request bodies (POST, JSON):
//   {username}                         recent diary feed (RSS, last 50 entries)
//   {username, mode:"films", page:N, sort?}  one page of the member's watched films (about 72 per page);
//                                      sort "date" = most recently added first, "rated-date" = most recently rated
//   {mode:"film", slugs:[...]}         TMDB id + year for up to 20 film slugs (used when a list entry has no year)
//   {username, mode:"following"}       usernames of everyone this person follows (complete list, or an error)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const UA = { "User-Agent": "MovieMap/1.0 (+https://dominicvhoule.github.io/moviemap/)" };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
const tag = (s: string, t: string) => {
  const m = s.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`));
  return m ? decode(m[1].replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "")).trim() : "";
};
const attr = (s: string, name: string) => {
  const m = s.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decode(m[1]).trim() : "";
};
const thisYear = new Date().getUTCFullYear();
const okYear = (y: number) => y >= 1870 && y <= thisYear + 2;

async function get(url: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: UA });
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); continue; }
    return res;
  }
  return fetch(url, { headers: UA });
}

// ---------- diary feed ----------
async function feed(username: string) {
  const res = await get(`https://letterboxd.com/${username}/rss/`);
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
      // Series are sent as a negative TMDB id so they never collide with film ids.
      tmdb: Number(tag(s, "tmdb:movieId")) || -Number(tag(s, "tmdb:tvId")) || null,
      // the film's Letterboxd id, from the entry link (…/username/film/<slug>/ or …/<slug>/2/ for rewatches)
      slug: (tag(s, "link").match(/\/film\/([a-z0-9-]+)\//) ?? [])[1] ?? null,
    }))
    .filter((f) => f.title && f.tmdb); // drops list posts
  return json({ username, films });
}

// ---------- watched films grid ----------
// Letterboxd has used a few markups for the poster grid; read whichever attributes are present.
function parseFilmsPage(html: string) {
  const starts = [...html.matchAll(/<[a-z]+\b[^>]*\bdata-(?:film|item)-slug="[^"]+"[^>]*>/g)];
  const out: { slug: string; title: string; year: number | null; rating: number | null }[] = [];
  const seen = new Set<string>();
  starts.forEach((m, i) => {
    const open = m[0];
    const chunk = html.slice(m.index!, i + 1 < starts.length ? starts[i + 1].index! : m.index! + 4000);
    const slug = attr(open, "data-film-slug") || attr(open, "data-item-slug");
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    let title = attr(open, "data-film-name") || "";
    let year: number | null = Number(attr(open, "data-film-release-year")) || null;
    const display = attr(open, "data-item-full-display-name") || attr(open, "data-item-name");
    const dm = display.match(/^(.*?)\s*\((\d{4})\)\s*$/);
    if (dm) { title = title || dm[1]; year = year || Number(dm[2]); }
    else if (display) title = title || display;
    if (!title) { const alt = chunk.match(/<img\b[^>]*\balt="([^"]*)"/); if (alt) title = decode(alt[1]).replace(/^Poster for\s+/i, "").trim(); }
    if (!year) { const ym = slug.match(/-(\d{4})$/); if (ym && okYear(Number(ym[1]))) year = Number(ym[1]); }
    const rm = chunk.match(/\brated-(\d{1,2})\b/);
    const rating = rm ? Number(rm[1]) / 2 : null;
    if (title) out.push({ slug, title, year: year && okYear(year) ? year : null, rating });
  });
  return out;
}

async function filmsPage(username: string, page: number, sort: string) {
  const url = `https://letterboxd.com/${username}/films/${sort ? `by/${sort}/` : ""}${page > 1 ? `page/${page}/` : ""}`;
  const res = await get(url);
  if (res.status === 404) return page === 1 ? json({ error: "not_found" }, 404) : json({ username, page, films: [], more: false });
  if (!res.ok) return json({ error: "upstream", status: res.status }, 502);
  const html = await res.text();
  const films = parseFilmsPage(html);
  const more = films.length > 0 && (new RegExp(`/${username}/films/(by/[a-z-]+/)?page/${page + 1}/`, "i").test(html) || /class="next"/.test(html));
  return json({ username, page, films, more });
}

// ---------- single film pages (TMDB id) ----------
async function filmInfo(slugs: string[]) {
  const out = [];
  for (const slug of slugs) {
    try {
      const res = await get(`https://letterboxd.com/film/${slug}/`);
      if (!res.ok) { out.push({ slug, tmdb: null, year: null }); continue; }
      const html = await res.text();
      const body = html.match(/<body\b[^>]*>/)?.[0] ?? "";
      const id = Number(attr(body, "data-tmdb-id")) || Number(html.match(/themoviedb\.org\/(?:movie|tv)\/(\d+)/)?.[1]) || 0;
      const isTv = attr(body, "data-tmdb-type") === "tv" || /themoviedb\.org\/tv\//.test(html);
      const tmdb = id ? (isTv ? -id : id) : null;
      const og = html.match(/<meta property="og:title" content="([^"]*)"/);
      const y = og ? Number(decode(og[1]).match(/\((\d{4})\)\s*$/)?.[1]) : NaN;
      out.push({ slug, tmdb, year: okYear(y) ? y : null });
    } catch { out.push({ slug, tmdb: null, year: null }); }
    await new Promise((r) => setTimeout(r, 150)); // be gentle with Letterboxd
  }
  return json({ films: out });
}

// ---------- people the member follows ----------
// Always the complete list or an error, never a partial list (the site unfollows anyone missing from it).
async function following(username: string) {
  const names: string[] = [];
  for (let page = 1; page <= 40; page++) {
    const res = await get(`https://letterboxd.com/${username}/following/${page > 1 ? `page/${page}/` : ""}`);
    if (res.status === 404 && page === 1) return json({ error: "not_found" }, 404);
    if (!res.ok) return json({ error: "upstream", status: res.status }, 502);
    const html = await res.text();
    const found = [...html.matchAll(/<a href="\/([A-Za-z0-9_]{1,30})\/" class="name"/g)].map((m) => m[1]);
    if (page === 1 && !found.length && !/not following/i.test(html)) return json({ error: "layout" }, 502);
    found.forEach((n) => { if (n.toLowerCase() !== username.toLowerCase() && !names.includes(n)) names.push(n); });
    if (!found.length || !new RegExp(`/${username}/following/page/${page + 1}/`, "i").test(html)) return json({ username, following: names, complete: true });
    await new Promise((r) => setTimeout(r, 150));
  }
  return json({ error: "too_many" }, 413);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const mode = String(body.mode ?? "feed");

  try {
    if (mode === "film") {
      const slugs = (Array.isArray(body.slugs) ? body.slugs : []).map(String).filter((s) => /^[a-z0-9-]{1,120}$/.test(s)).slice(0, 20);
      if (!slugs.length) return json({ error: "bad_slugs" }, 400);
      return await filmInfo(slugs);
    }
    const username = String(body.username ?? "").trim();
    if (!/^[A-Za-z0-9_]{1,30}$/.test(username)) return json({ error: "bad_username" }, 400);
    if (mode === "following") return await following(username);
    if (mode === "films") {
      const page = Math.max(1, Math.min(200, Math.floor(Number(body.page) || 1)));
      const sort = ["date", "rated-date"].includes(String(body.sort)) ? String(body.sort) : "";
      return await filmsPage(username, page, sort);
    }
    return await feed(username);
  } catch {
    return json({ error: "unreachable" }, 502);
  }
});
