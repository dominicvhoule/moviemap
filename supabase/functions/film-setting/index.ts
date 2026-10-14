// MovieMap: work out where a film or series takes place by having Claude read its plot.
// Used only when Wikidata has no recorded setting. Each answer is saved in film_settings,
// so a title is looked up once for everyone.
//
// Needs these Edge Function secrets (Supabase → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY   your key from console.anthropic.com
//   ANTHROPIC_MODEL     optional; defaults to claude-haiku-5-5
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
// Deploy with "Verify JWT" on, so only signed-in MovieMap members can call it.
//
// POST {tmdb, title, year, qid?, overview?, tv?}  →  {setting} or {setting:null, reason}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-haiku-5-5";
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const UA = { "User-Agent": "MovieMap/1.0 (+https://dominicvhoule.github.io/moviemap/)" };

const db = (path: string, init: RequestInit = {}) =>
  fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });

// ---------- Wikipedia plot ----------
async function wikiTitle(qid: string | undefined, title: string, year: number | null, tv: boolean) {
  if (qid && /^Q\d+$/.test(qid)) {
    try {
      const r = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=sitelinks&sitefilter=enwiki&format=json`, { headers: UA });
      const t = (await r.json())?.entities?.[qid]?.sitelinks?.enwiki?.title;
      if (t) return t as string;
    } catch { /* fall through to search */ }
  }
  const q = `${title} ${year ?? ""} ${tv ? "TV series" : "film"}`;
  try {
    const r = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=1&format=json`, { headers: UA });
    return ((await r.json())?.query?.search?.[0]?.title as string) ?? null;
  } catch { return null; }
}
async function wikiPlot(page: string) {
  const r = await fetch(`https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=${encodeURIComponent(page)}`, { headers: UA });
  const pages = (await r.json())?.query?.pages ?? {};
  const text: string = (Object.values(pages)[0] as { extract?: string })?.extract ?? "";
  if (!text) return "";
  const m = text.match(/\n==\s*(Plot|Synopsis|Premise|Summary|Story|Plot summary|Overview)\s*==\n([\s\S]*?)(?=\n==[^=]|$)/i);
  const intro = text.split(/\n==/)[0];
  return (intro.slice(0, 1500) + "\n\n" + (m ? m[2] : "")).slice(0, 7000);
}

// ---------- Claude ----------
async function askClaude(kind: string, title: string, year: number | null, overview: string, plot: string) {
  const prompt = `You help a website pin each ${kind} on a world map at the place where its story takes place.

Title: ${title}${year ? ` (${year})` : ""}
TMDB description: ${overview || "(none)"}

Wikipedia text:
${plot || "(none found)"}

Where does the story of this ${kind} mainly take place? Use the in-story setting, not where it was filmed. Use the text above and what you know about this ${kind}. If the story moves around, choose the place where most of it happens.

Reply with only a JSON object:
{"place": "most specific place where most of the story happens (a city, town, region, or a fictional place's name)",
 "country": "modern country containing it, in English",
 "continent": "Africa, Asia, Europe, North America, South America, Oceania or Antarctica",
 "lat": latitude of that place as a number, "lon": longitude as a number,
 "precision": "city" | "region" | "country" | "fictional",
 "note": "one short sentence about where the story is set, under 25 words"}
For a fictional place, give the coordinates of the real region it stands in for. If you genuinely can't tell, reply {"unknown": true}.`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error(`anthropic_${r.status}`);
  const text: string = ((await r.json())?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}

const clip = (s: unknown, n: number) => String(s ?? "").trim().slice(0, n);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!ANTHROPIC_KEY) return json({ setting: null, reason: "no_api_key" });

  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* empty */ }
  const tmdb = Math.trunc(Number(b.tmdb));
  const title = clip(b.title, 200);
  const year = Number(b.year) || null;
  const tv = !!b.tv || tmdb < 0;
  if (!tmdb || !title) return json({ error: "bad_request" }, 400);

  // Already worked out for someone else? Reuse it.
  try {
    const hit = await (await db(`film_settings?tmdb_id=eq.${tmdb}&source=eq.ai&select=*`)).json();
    if (Array.isArray(hit) && hit[0]) {
      const s = hit[0];
      return json({ setting: { p: s.place, c: s.country, cont: s.continent ?? "", lat: s.lat, lon: s.lon, ap: s.approx ? 1 : 0, n: s.note ?? "", src: "ai" }, cached: true });
    }
  } catch { /* carry on */ }

  try {
    const page = await wikiTitle(clip(b.qid, 20), title, year, tv);
    const plot = page ? await wikiPlot(page) : "";
    const a = await askClaude(tv ? "TV series" : "film", title, year, clip(b.overview, 1500), plot);
    if (!a || a.unknown) return json({ setting: null, reason: "unknown" });
    const lat = Number(a.lat), lon = Number(a.lon);
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return json({ setting: null, reason: "bad_answer" });
    const approx = a.precision === "country" || a.precision === "fictional";
    const row = {
      tmdb_id: tmdb, place: clip(a.place, 120), country: clip(a.country, 60), continent: clip(a.continent, 20) || null,
      lat: +lat.toFixed(3), lon: +lon.toFixed(3), approx, note: clip(a.note, 300) || null, source: "ai", updated_at: new Date().toISOString(),
    };
    // Save for everyone (replaces any earlier country guess for this title).
    await db("film_settings?on_conflict=tmdb_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(row) }).catch(() => {});
    return json({ setting: { p: row.place, c: row.country, cont: row.continent ?? "", lat: row.lat, lon: row.lon, ap: approx ? 1 : 0, n: row.note ?? "", src: "ai" } });
  } catch (e) {
    return json({ setting: null, reason: String((e as Error).message || "failed") });
  }
});
