// MovieMap: keep every linked Letterboxd map up to date, even when nobody opens the site.
// Called by a schedule (see supabase/migrations/003_daily_sync.sql). Each run works through the
// members whose maps are oldest, adds any new Letterboxd films with a setting, and stops before
// the function's time limit; the next run carries on.
//
// Secrets (Edge Functions → Secrets):
//   CRON_SECRET   any long random string; the schedule sends it so nobody else can trigger this
//   TMDB_KEY      optional; defaults to the site's public key
// Deploy with "Verify JWT" OFF (the schedule authenticates with CRON_SECRET instead).

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const TMDB_KEY = Deno.env.get("TMDB_KEY") || "3cd25fb4afb7cee1db7ca88a3c386a30";
const UA = { "User-Agent": "MovieMap/1.0 (+https://dominicvhoule.github.io/moviemap/)" };
const TIME_BUDGET = 110_000;          // stop starting new work after this many ms
const STALE_HOURS = 20;               // a member is due once their map is this old
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- database (service role, bypasses row-level security) ----------
async function db(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`db ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

// ---------- Letterboxd ----------
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m);
const tag = (s: string, t: string) => { const m = s.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)); return m ? decode(m[1].replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "")).trim() : ""; };
const attr = (s: string, n: string) => { const m = s.match(new RegExp(`\\s${n}="([^"]*)"`)); return m ? decode(m[1]).trim() : ""; };

type Entry = { title: string; year: number | null; rating: number | null; watched: string | null; tmdb: number | null; slug: string | null };

// The diary feed (exact TMDB ids and watch dates) plus every page of the Films grid (every watched film,
// with ratings). complete is true only when every grid page was read, which removals depend on.
async function letterboxd(username: string, deadline: number): Promise<{ entries: Entry[]; grid: Entry[]; complete: boolean }> {
  const entries: Entry[] = [], grid: Entry[] = [];
  const rss = await fetch(`https://letterboxd.com/${username}/rss/`, { headers: UA });
  if (rss.ok) {
    for (const m of (await rss.text()).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const s = m[1];
      const tmdb = Number(tag(s, "tmdb:movieId")) || -Number(tag(s, "tmdb:tvId")) || null;
      const title = tag(s, "letterboxd:filmTitle");
      const slug = (tag(s, "link").match(/\/film\/([a-z0-9-]+)\//) ?? [])[1] ?? null;
      if (title && tmdb) entries.push({ title, year: Number(tag(s, "letterboxd:filmYear")) || null, rating: Number(tag(s, "letterboxd:memberRating")) || null, watched: tag(s, "letterboxd:watchedDate") || null, tmdb, slug });
    }
  }
  let complete = false;
  for (let page = 1; page <= 100 && Date.now() < deadline; page++) {
    const r = await fetch(`https://letterboxd.com/${username}/films/${page > 1 ? `page/${page}/` : ""}`, { headers: UA });
    if (!r.ok) break;
    const html = await r.text();
    const starts = [...html.matchAll(/<[a-z]+\b[^>]*\bdata-(?:film|item)-slug="[^"]+"[^>]*>/g)];
    starts.forEach((m, i) => {
      const open = m[0], chunk = html.slice(m.index!, i + 1 < starts.length ? starts[i + 1].index! : m.index! + 4000);
      const slug = attr(open, "data-film-slug") || attr(open, "data-item-slug");
      if (!slug || grid.some((g) => g.slug === slug)) return;
      const disp = attr(open, "data-item-full-display-name") || attr(open, "data-item-name");
      const dm = disp.match(/^(.*?)\s*\((\d{4})\)\s*$/);
      const title = attr(open, "data-film-name") || (dm ? dm[1] : disp);
      const year = Number(attr(open, "data-film-release-year")) || (dm ? Number(dm[2]) : null);
      const rm = chunk.match(/\brated-(\d{1,2})\b/);
      if (title) grid.push({ title, year, rating: rm ? Number(rm[1]) / 2 : null, watched: null, tmdb: null, slug });
    });
    const more = starts.length > 0 && (new RegExp(`/${username}/films/page/${page + 1}/`, "i").test(html) || /class="next"/.test(html));
    if (!more) { complete = page > 1 || starts.length > 0 || /no films/i.test(html); break; }
    await sleep(200);
  }
  return { entries, grid, complete };
}

// ---------- TMDB ----------
async function tmdb(path: string, params: Record<string, string> = {}) {
  const q = new URLSearchParams({ ...params, api_key: TMDB_KEY });
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`https://api.themoviedb.org/3${path}?${q}`);
    if (r.status === 429) { await sleep(1000 * (i + 1)); continue; }
    return r.ok ? r.json() : null;
  }
  return null;
}
const norm = (s: string) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/&/g, "and").replace(/[^a-z0-9]/g, "");

async function match(title: string, year: number | null) {
  let best: { id: number; s: number } | null = null;
  for (const [kind, extra] of [["movie", year ? { year: String(year) } : {}], ["movie", {}], ["tv", {}]] as const) {
    const d = await tmdb(`/search/${kind}`, { query: title, include_adult: "false", ...extra });
    for (const r of d?.results ?? []) {
      const t = kind === "tv" ? r.name : r.title, ot = kind === "tv" ? r.original_name : r.original_title;
      const y = Number(((kind === "tv" ? r.first_air_date : r.release_date) || "").slice(0, 4));
      let s = 0;
      if (norm(t) === norm(title) || norm(ot) === norm(title)) s += 10;
      if (year && y === year) s += 8; else if (year && Math.abs(y - year) === 1) s += 4;
      if (!best || s > best.s) best = { id: kind === "tv" ? -r.id : r.id, s };
    }
    if (best && best.s >= 18) break;
  }
  return best && best.s >= 8 ? best.id : null;
}

async function details(id: number) {
  const tv = id < 0;
  const d = await tmdb(`/${tv ? "tv" : "movie"}/${Math.abs(id)}`, { append_to_response: "external_ids,credits" });
  if (!d) return null;
  const date = tv ? d.first_air_date : d.release_date;
  return {
    id, tv, title: tv ? d.name : d.title, year: date ? Number(date.slice(0, 4)) : null,
    director: (tv ? (d.created_by ?? []).map((c: { name: string }) => c.name) : (d.credits?.crew ?? []).filter((c: { job: string }) => c.job === "Director").map((c: { name: string }) => c.name)).slice(0, 3).join(", "),
    poster: d.poster_path ?? null, qid: d.external_ids?.wikidata_id ?? null,
    iso: [...(d.origin_country ?? []), ...(d.production_countries ?? []).map((c: { iso_3166_1: string }) => c.iso_3166_1)] as string[],
  };
}

// ---------- where the story takes place ----------
type Setting = { place: string; country: string; continent: string | null; lat: number; lon: number; approx: boolean; note: string | null; source: string };
async function sparql(q: string) {
  const r = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q), { headers: { Accept: "application/sparql-results+json", ...UA } });
  return r.ok ? (await r.json()).results.bindings : [];
}
const qidOf = (u: string) => u.split("/").pop()!;
const point = (s: string) => { if (!s || s[0] === "<") return null; const m = /Point\(([-\d.eE]+) ([-\d.eE]+)\)/.exec(s); return m ? [Number(m[1]), Number(m[2])] : null; };

async function fromWikidata(qid: string): Promise<Setting | null> {
  const rows = await sparql(`SELECT ?loc ?locLabel ?coord ?country ?countryLabel ?contLabel WHERE {
    wd:${qid} wdt:P840 ?loc . OPTIONAL { ?loc wdt:P625 ?coord . }
    OPTIONAL { ?loc wdt:P17 ?country . OPTIONAL { ?country wdt:P30 ?cont . } }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }`);
  const cands = rows.map((b: Record<string, { value: string }>) => ({ id: qidOf(b.loc.value), label: b.locLabel?.value ?? "", pt: point(b.coord?.value ?? ""), cid: b.country ? qidOf(b.country.value) : null, country: b.countryLabel?.value ?? "", cont: b.contLabel?.value ?? null }))
    .filter((c: { pt: number[] | null; label: string }) => c.pt && !/^Q\d+$/.test(c.label));
  const specific = cands.find((c: { cid: string | null; id: string }) => c.cid && c.cid !== c.id);
  const chosen = specific ?? cands[0];
  if (!chosen) return null;
  return { place: chosen.label, country: specific ? chosen.country : chosen.label, continent: chosen.cont, lon: chosen.pt[0], lat: chosen.pt[1], approx: !specific, note: null, source: "wikidata" };
}

async function wiki(params: Record<string, string>) {
  const r = await fetch("https://en.wikipedia.org/w/api.php?" + new URLSearchParams({ format: "json", formatversion: "2", ...params }), { headers: UA });
  return r.ok ? r.json() : {};
}
const TOO_BIG = /^(europe|asia|africa|north america|south america|latin america|oceania|antarctica|the americas|middle east|the middle east|caribbean|scandinavia|balkans|earth|world|outer space|space)$/i;
const NATURAL = /( river| mountains| mountain range| range| desert| falls| ocean| sea| gulf| strait| glacier| rainforest)$|^(gulf|strait|sea|bay) of |^(andes|alps|himalayas|sahara|amazon)$/i;

async function fromWikipedia(qid: string | null, title: string, year: number | null, tv: boolean): Promise<Setting | null> {
  let page: string | null = null;
  if (qid) {
    const r = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=sitelinks&sitefilter=enwiki&format=json`, { headers: UA });
    page = r.ok ? (await r.json())?.entities?.[qid]?.sitelinks?.enwiki?.title ?? null : null;
  }
  if (!page) {
    const d = await wiki({ action: "query", list: "search", srsearch: `${title} ${year ?? ""} ${tv ? "TV series" : "film"}`, srlimit: "5" });
    page = (d.query?.search ?? []).find((s: { title: string }) => norm(s.title.replace(/\s*\([^)]*\)\s*$/, "")) === norm(title))?.title ?? null;
  }
  if (!page) return null;
  const secs = (await wiki({ action: "parse", page, prop: "sections", redirects: "1" })).parse?.sections ?? [];
  const plot = secs.find((x: { line: string }) => /^(plot|plot summary|synopsis|premise|summary|story|overview)$/i.test(String(x.line).replace(/<[^>]+>/g, "").trim()));
  const text: string = (await wiki({ action: "parse", page, prop: "wikitext", section: plot ? String(plot.index) : "0", redirects: "1" })).parse?.wikitext ?? "";
  const body = text.replace(/<ref[\s\S]*?(<\/ref>|\/>)/g, "").replace(/\{\{[^{}]*\}\}/g, "");
  const links = new Map<string, { shown: string; n: number; first: number }>();
  for (const m of body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g)) {
    const t = m[1].trim(); if (/^(file|image|category):/i.test(t)) continue;
    const base = t.replace(/\s*\([^)]*\)$/, "").split(",")[0].trim();
    if (TOO_BIG.test(t) || NATURAL.test(base)) continue;
    const c = links.get(t) ?? { shown: (m[2] ?? m[1]).replace(/'''?/g, "").trim(), n: 0, first: m.index! };
    c.n++; links.set(t, c);
  }
  if (!links.size) return null;
  const titles = [...links.keys()].slice(0, 50);
  const q = await wiki({ action: "query", prop: "coordinates|pageprops", ppprop: "wikibase_item", titles: titles.join("|"), redirects: "1" });
  const back = new Map<string, string>(); for (const r of [...(q.query?.redirects ?? []), ...(q.query?.normalized ?? [])]) back.set(r.to, r.from);
  type Cand = { t: string; lat: number; lon: number; item: string | null; score: number; shown: string };
  const cands: Cand[] = [];
  for (const p of q.query?.pages ?? []) {
    const co = (p.coordinates ?? []).find((x: { globe?: string }) => !x.globe || x.globe === "earth"); if (!co) continue;
    let t = p.title; while (!links.has(t) && back.has(t)) t = back.get(t)!;
    const l = links.get(t); if (!l) continue;
    cands.push({ t, lat: co.lat, lon: co.lon, item: p.pageprops?.wikibase_item ?? null, shown: l.shown, score: l.n * 3 + (1 - l.first / Math.max(1, body.length)) * 1.5 });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  let country = "", isCountry = false;
  if (best.item) {
    const rows = await sparql(`SELECT ?c ?cLabel WHERE { OPTIONAL { wd:${best.item} wdt:P17 ?c . } SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 1`);
    country = rows[0]?.cLabel?.value ?? "";
    isCountry = rows[0]?.c ? qidOf(rows[0].c.value) === best.item : false;
  }
  const label = best.shown.replace(/\s*\([^)]*\)$/, "");
  return { place: label, country: country || label, continent: null, lat: best.lat, lon: best.lon, approx: isCountry || !plot, note: `Set in ${label}, from the Wikipedia ${plot ? "plot summary" : "article"}.`, source: "wikipedia" };
}

async function fromCountry(iso: string[]): Promise<Setting | null> {
  for (const code of iso) {
    if (!/^[A-Z]{2}$/.test(code)) continue;
    const rows = await sparql(`SELECT ?cLabel ?coord WHERE { ?c wdt:P297 "${code}" ; wdt:P625 ?coord . SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 1`);
    const pt = point(rows[0]?.coord?.value ?? "");
    if (pt) { const n = rows[0].cLabel.value; return { place: n, country: n, continent: null, lon: pt[0], lat: pt[1], approx: true, note: "No setting on record yet, so this is pinned to the country the film comes from.", source: "production" }; }
  }
  return null;
}

async function settingFor(d: NonNullable<Awaited<ReturnType<typeof details>>>): Promise<Setting | null> {
  const cached = await db(`film_settings?tmdb_id=eq.${d.id}&source=in.(wikidata,ai)&select=*`).catch(() => []);
  if (cached?.[0]) { const c = cached[0]; return { place: c.place, country: c.country, continent: c.continent, lat: c.lat, lon: c.lon, approx: c.approx, note: c.note, source: c.source }; }
  let s: Setting | null = null;
  if (d.qid) s = await fromWikidata(d.qid).catch(() => null);
  if (s) { await db("film_settings?on_conflict=tmdb_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ tmdb_id: d.id, place: s.place, country: s.country, continent: s.continent, lat: s.lat, lon: s.lon, approx: s.approx, note: s.note, source: "wikidata" }) }).catch(() => {}); return s; }
  s = await fromWikipedia(d.qid, d.title, d.year, d.tv).catch(() => null);
  return s ?? await fromCountry(d.iso).catch(() => null);
}

// ---------- friends: follow anyone this member follows on Letterboxd who is on MovieMap ----------
// The full list of who a member follows, or null if it couldn't be read completely (never a partial
// list, since anything missing from it would be unfollowed).
async function letterboxdFollowing(username: string): Promise<string[] | null> {
  const names: string[] = [];
  for (let page = 1; page <= 40; page++) {
    const r = await fetch(`https://letterboxd.com/${username}/following/${page > 1 ? `page/${page}/` : ""}`, { headers: UA });
    if (!r.ok) return null;
    const html = await r.text();
    const found = [...html.matchAll(/<a href="\/([A-Za-z0-9_]{1,30})\/" class="name"/g)].map((m) => m[1]);
    if (page === 1 && !found.length && !/not following/i.test(html)) return null;   // page layout changed
    found.forEach((n) => { if (n.toLowerCase() !== username.toLowerCase() && !names.includes(n)) names.push(n); });
    if (!found.length || !new RegExp(`/${username}/following/page/${page + 1}/`, "i").test(html)) return names;
    await sleep(300);
  }
  return null;   // more than 1,000 follows: too many to be sure, leave things as they are
}
// Mirror Letterboxd: follow friends who are on MovieMap, and unfollow ones followed that way who were
// unfollowed on Letterboxd. Follows made by hand on MovieMap are never touched.
async function syncFriends(p: { id: string; letterboxd: string; lb_seen?: string[] | null }) {
  const names = await letterboxdFollowing(p.letterboxd);
  if (!names) return { added: 0, removed: 0 };
  const now = new Set(names.map((n) => n.toLowerCase()));
  const seen = new Set((p.lb_seen ?? []).map((n) => n.toLowerCase()));
  const lookup = async (list: string[]) => {
    const out: { id: string; letterboxd: string }[] = [];
    for (let i = 0; i < list.length; i += 40) {
      const part = list.slice(i, i + 40), want = new Set(part.map((n) => n.toLowerCase()));
      const rows = await db(`profiles?select=id,letterboxd&or=(${part.map((n) => `letterboxd.ilike.${n}`).join(",")})`) ?? [];
      rows.forEach((r: { id: string; letterboxd: string }) => { if (r.id !== p.id && r.letterboxd && want.has(r.letterboxd.toLowerCase())) out.push(r); });
    }
    return out;
  };
  // Someone already followed by hand stays a hand-made follow, so Letterboxd never removes them.
  const mine: { followee: string }[] = await db(`follows?follower=eq.${p.id}&select=followee`) ?? [];
  const already = new Set(mine.map((r) => r.followee));
  const toAdd = (await lookup(names.filter((n) => !seen.has(n.toLowerCase())))).filter((f) => !already.has(f.id));
  const gone = [...seen].filter((n) => !now.has(n));
  const toRemove = gone.length ? await lookup(gone) : [];
  if (toAdd.length) await db("follows?on_conflict=follower,followee", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates" },
    body: JSON.stringify(toAdd.map((f) => ({ follower: p.id, followee: f.id }))) });
  if (toRemove.length) await db(`follows?follower=eq.${p.id}&followee=in.(${toRemove.map((f) => f.id).join(",")})`, { method: "DELETE" });
  if (toAdd.length || gone.length) {
    const next = [...[...seen].filter((n) => now.has(n)), ...toAdd.map((f) => f.letterboxd.toLowerCase())];
    await db(`profiles?id=eq.${p.id}`, { method: "PATCH", body: JSON.stringify({ lb_seen: next }) }).catch(() => {});
  }
  return { added: toAdd.length, removed: toRemove.length };
}

// ---------- one member ----------
const slugify = (t: string) => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/&/g, "").replace(/['’.]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
type Log = { id: number; title: string; year: number | null; tmdb_id: number | null; rating: number | null; lb_slug: string | null };

async function syncMember(p: { id: string; letterboxd: string }, deadline: number) {
  const { entries, grid, complete } = await letterboxd(p.letterboxd, deadline);
  const gridBySlug = new Map(grid.map((g) => [g.slug!, g]));
  const gridByKey = new Map(grid.filter((g) => g.year).map((g) => [norm(g.title) + "|" + g.year, g]));
  // Diary entries first (exact ids), then the rest of the grid; grid ratings are the current ones.
  const todo: Entry[] = [];
  entries.forEach((e) => { const g = (e.slug && gridBySlug.get(e.slug)) || gridByKey.get(norm(e.title) + "|" + (e.year ?? "")); todo.push({ ...e, slug: e.slug ?? g?.slug ?? null, rating: g ? g.rating : e.rating }); });
  grid.forEach((g) => { if (!todo.some((t) => t.slug === g.slug)) todo.push(g); });

  let have: Log[] = await db(`logs?user_id=eq.${p.id}&select=id,title,year,tmdb_id,rating,lb_slug&limit=10000`) ?? [];
  const ids = new Set(have.map((h) => h.tmdb_id).filter(Boolean)), keys = new Set(have.map((h) => norm(h.title) + "|" + (h.year ?? "")));
  const slugs = new Set(have.map((h) => h.lb_slug).filter(Boolean));
  const seen = new Set<string>();
  let added = 0;
  for (const e of todo) {
    if (Date.now() > deadline) break;
    const k = norm(e.title) + "|" + (e.year ?? "");
    if ((e.slug && slugs.has(e.slug)) || seen.has(e.tmdb ? "t" + e.tmdb : k) || keys.has(k) || (e.tmdb && ids.has(e.tmdb))) continue;
    seen.add(e.tmdb ? "t" + e.tmdb : k);
    const id = e.tmdb ?? await match(e.title, e.year);
    if (!id || ids.has(id)) continue;
    const d = await details(id); if (!d) continue;
    const s = await settingFor(d); if (!s) continue;
    await db("logs?on_conflict=user_id,title,year", {
      method: "POST", headers: { Prefer: "resolution=ignore-duplicates" },
      body: JSON.stringify({ user_id: p.id, title: e.title, year: e.year ?? d.year, director: d.director || null, tmdb_id: d.id, poster_path: d.poster,
        place: s.place, country: s.country, continent: s.continent, lat: +s.lat.toFixed(3), lon: +s.lon.toFixed(3), approx: s.approx,
        note: s.note ? s.note.slice(0, 500) : null, rating: e.rating && e.rating >= 0.5 ? e.rating : null, watched_on: e.watched, source: s.source, lb_slug: e.slug }),
    });
    ids.add(d.id); keys.add(k); if (e.slug) slugs.add(e.slug); added++;
  }
  // With the complete list: link older pins, copy ratings over, and remove films taken off Letterboxd.
  const out = { added, rated: 0, removed: 0, held: 0 };
  if (!complete || !grid.length || Date.now() > deadline) return out;
  have = await db(`logs?user_id=eq.${p.id}&select=id,title,year,tmdb_id,rating,lb_slug&limit=10000`) ?? [];
  const claimed = new Set(have.map((h) => h.lb_slug).filter(Boolean));
  for (const h of have) {
    if (h.lb_slug) continue;
    const g = gridByKey.get(norm(h.title) + "|" + (h.year ?? "")) || gridBySlug.get(slugify(h.title) + (h.year ? "-" + h.year : "")) || gridBySlug.get(slugify(h.title));
    if (!g || claimed.has(g.slug)) continue;
    await db(`logs?id=eq.${h.id}`, { method: "PATCH", body: JSON.stringify({ lb_slug: g.slug }) });
    h.lb_slug = g.slug; claimed.add(g.slug);
  }
  for (const h of have) {
    const g = h.lb_slug ? gridBySlug.get(h.lb_slug) : null; if (!g) continue;
    const want = g.rating != null ? g.rating : null, now = h.rating != null ? Number(h.rating) : null;
    if (want === now) continue;
    await db(`logs?id=eq.${h.id}`, { method: "PATCH", body: JSON.stringify({ rating: want }) });
    out.rated++;
  }
  const linked = have.filter((h) => h.lb_slug), gone = linked.filter((h) => !gridBySlug.has(h.lb_slug!));
  // A sudden large disappearance is more likely a reading problem than a real clear-out: hold off.
  if (gone.length > Math.max(5, linked.length * 0.3)) { out.held = gone.length; return out; }
  for (let i = 0; i < gone.length; i += 100) {
    await db(`logs?id=in.(${gone.slice(i, i + 100).map((h) => h.id).join(",")})`, { method: "DELETE" });
    out.removed += Math.min(100, gone.length - i);
  }
  return out;
}

Deno.serve(async (req) => {
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) return new Response("forbidden", { status: 403 });
  const started = Date.now(), deadline = started + TIME_BUDGET;
  const due = new Date(Date.now() - STALE_HOURS * 3600_000).toISOString();
  const q = (cols: string) => db(`profiles?letterboxd=not.is.null&or=(last_synced.is.null,last_synced.lt.${due})&select=${cols}&order=last_synced.asc.nullsfirst&limit=50`);
  // lb_seen arrives with migration 005; work without it until then.
  const members: { id: string; letterboxd: string; lb_seen?: string[] }[] = await q("id,letterboxd,lb_seen").catch(() => q("id,letterboxd")) ?? [];
  const report: Record<string, unknown> = {};
  for (const m of members) {
    if (Date.now() > deadline) break;
    try { report[m.letterboxd] = await syncMember(m, deadline); }
    catch (e) { report[m.letterboxd] = "error: " + String((e as Error).message).slice(0, 120); }
    try { const n = await syncFriends(m); if (n.added || n.removed) report[m.letterboxd + " friends"] = `+${n.added} -${n.removed}`; } catch { /* friends are a bonus */ }
    await db(`profiles?id=eq.${m.id}`, { method: "PATCH", body: JSON.stringify({ last_synced: new Date().toISOString() }) }).catch(() => {});
    await sleep(500);   // be gentle with Letterboxd
  }
  return new Response(JSON.stringify({ checked: Object.keys(report).length, due: members.length, ms: Date.now() - started, report }), { headers: { "Content-Type": "application/json" } });
});
