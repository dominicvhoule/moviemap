// MovieMap data layer: TMDB lookups, Wikidata setting lookups, country helpers.
(function(){
const CFG = window.MOVIEMAP_CONFIG || {};
const MM = window.MM = {};

/* ---------------- small utilities ---------------- */
MM.norm = s => String(s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/&/g,"and").replace(/[^a-z0-9]/g,"");
MM.filmKey = f => MM.norm(f.t) + "|" + (f.y||"");
MM.sleep = ms => new Promise(r=>setTimeout(r,ms));
function lsGet(k,d){ try{ const v = localStorage.getItem(k); return v===null ? d : JSON.parse(v); }catch(e){ return d; } }
function lsSet(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)); return true; }catch(e){ return false; } }
MM.lsGet = lsGet; MM.lsSet = lsSet;

// Run fn over items with at most n in flight.
MM.pool = async function(items, n, fn){
  const out = new Array(items.length); let i = 0;
  const worker = async()=>{ while(i < items.length){ const k = i++; try{ out[k] = await fn(items[k], k); }catch(e){ out[k] = undefined; } } };
  await Promise.all(Array.from({length:Math.min(n, items.length)}, worker));
  return out;
};

/* ---------------- countries ---------------- */
// Wikidata / TMDB names → names used in the map geometry (world-atlas, Natural Earth).
const GEO_ALIASES = {
  "united states":"United States of America","usa":"United States of America","united states of america":"United States of America",
  "people's republic of china":"China","hong kong":"China","macau":"China","republic of china":"Taiwan",
  "kingdom of the netherlands":"Netherlands","the netherlands":"Netherlands","czech republic":"Czechia",
  "democratic republic of the congo":"Dem. Rep. Congo","republic of the congo":"Congo","bosnia and herzegovina":"Bosnia and Herz.",
  "dominican republic":"Dominican Rep.","central african republic":"Central African Rep.","south sudan":"S. Sudan",
  "ivory coast":"Côte d'Ivoire","north macedonia":"Macedonia","eswatini":"eSwatini","equatorial guinea":"Eq. Guinea",
  "western sahara":"W. Sahara","solomon islands":"Solomon Is.","state of palestine":"Palestine","palestinian territories":"Palestine",
  "soviet union":"Russia","russian empire":"Russia","russian soviet federative socialist republic":"Russia",
  "east germany":"Germany","west germany":"Germany","nazi germany":"Germany","german reich":"Germany","weimar republic":"Germany",
  "england":"United Kingdom","scotland":"United Kingdom","wales":"United Kingdom","northern ireland":"United Kingdom","great britain":"United Kingdom",
  "kingdom of italy":"Italy","francoist spain":"Spain","second spanish republic":"Spain","yugoslavia":"Serbia",
  "south korea":"South Korea","republic of korea":"South Korea","north korea":"North Korea","korea":"South Korea",
  "viet nam":"Vietnam","türkiye":"Turkey","turkiye":"Turkey","myanmar":"Myanmar","burma":"Myanmar","cabo verde":"Cape Verde"
};
// Display names: keep Wikidata's label except for a few long official forms.
const DISPLAY = {"People's Republic of China":"China","United States of America":"United States","Kingdom of the Netherlands":"Netherlands"};
MM.displayCountry = c => DISPLAY[c] || c || "";
MM.geoName = c => { if(!c) return ""; return GEO_ALIASES[String(c).toLowerCase()] || c; };

const CONTINENT_FIX = {"Insular Oceania":"Oceania","Australian continent":"Oceania","Australia":"Oceania","Eurasia":"Europe","Americas":"North America"};
MM.fixContinent = c => CONTINENT_FIX[c] || c || "";

// Filled by the app once the world geometry loads: geo name → [lon, lat] of the country's largest landmass.
MM.centroids = {};
MM.setWorld = function(features){
  MM.worldFeatures = features;
  features.forEach(f=>{
    let g = f.geometry;
    if(g && g.type==="MultiPolygon"){
      let best = null, bestA = -1;
      g.coordinates.forEach(c=>{ const p = {type:"Polygon", coordinates:c}; const a = d3.geoArea(p); if(a>bestA){ bestA=a; best=p; } });
      g = best;
    }
    if(g) MM.centroids[f.properties.name] = d3.geoCentroid(g);
  });
};
MM.countryPoint = c => MM.centroids[MM.geoName(c)] || null;

/* ---------------- TMDB ---------------- */
MM.TMDB_IMG = "https://image.tmdb.org/t/p/";
MM.poster = (path, size) => path ? MM.TMDB_IMG + (size||"w342") + path : null;

let tmdbGate = Promise.resolve();
async function tmdb(path, params){
  if(!CFG.TMDB_KEY) throw new Error("no-tmdb-key");
  const q = new URLSearchParams(Object.assign({}, params||{}, {api_key: CFG.TMDB_KEY}));
  for(let attempt=0; attempt<3; attempt++){
    const r = await fetch("https://api.themoviedb.org/3" + path + "?" + q);
    if(r.status === 429){ await MM.sleep(1200*(attempt+1)); continue; }
    if(r.status === 401) throw new Error("tmdb-auth");
    if(r.status === 404) return null;
    if(!r.ok) throw new Error("tmdb-http-" + r.status);
    return r.json();
  }
  throw new Error("tmdb-busy");
}
MM.tmdb = tmdb;

// TV series are stored with a negative TMDB id so they never collide with film ids.
const fromTv = s => ({id:-s.id, title:s.name, original_title:s.original_name, release_date:s.first_air_date, poster_path:s.poster_path, popularity:s.popularity, tv:true});
MM.isTv = id => +id < 0;
MM.tmdbPage = id => "https://www.themoviedb.org/" + (MM.isTv(id) ? "tv/" + (-id) : "movie/" + id);

MM.searchFilms = async function(query){
  const [mv, tv] = await Promise.all([
    tmdb("/search/movie", {query, include_adult:"false"}),
    tmdb("/search/tv", {query, include_adult:"false"}).catch(()=>null)
  ]);
  const films = (mv && mv.results || []).slice(0, 8);
  const shows = (tv && tv.results || []).slice(0, 4).map(fromTv);
  return [...films, ...shows].map(m=>({
    tmdb:m.id, t:m.title, ot:m.original_title, y:m.release_date ? +m.release_date.slice(0,4) : "", poster:m.poster_path, pop:m.popularity||0, tv:!!m.tv
  }));
};

// Best TMDB match for a title + year (the featured list and feed entries without a TMDB id).
MM.matchFilm = async function(title, year){
  const nt = MM.norm(title);
  const score = m => {
    const y = m.release_date ? +m.release_date.slice(0,4) : 0;
    let s = 0;
    if(MM.norm(m.title)===nt || MM.norm(m.original_title)===nt) s += 10;
    if(year && y===+year) s += 8; else if(year && Math.abs(y-year)===1) s += 4;
    s += Math.min(3, Math.log10(1+(m.popularity||0)));
    return s;
  };
  // Films first, then series. Stop early on an exact title (and year) match; otherwise keep the best seen.
  const searches = year
    ? [["movie",{year}], ["movie",{}], ["tv",{first_air_date_year:year}], ["tv",{}]]
    : [["movie",{}], ["tv",{}]];
  let best = null, bestS = -1;
  for(const [kind, extra] of searches){
    const d = await tmdb("/search/" + kind, Object.assign({query:title, include_adult:"false"}, extra));
    for(const r of (d && d.results || [])){
      const m = kind === "tv" ? fromTv(r) : r, s = score(m);
      if(s > bestS){ best = m; bestS = s; }
    }
    if(bestS >= (year ? 18 : 10)) break;
  }
  return (bestS >= 8 || !year) ? best : null;   // with a year, require a title or year match
};

// Full details for one TMDB id: director, Wikidata id, production countries.
MM.filmDetails = async function(id){
  id = +id; if(!id) return null;
  const cacheKey = "mm-tmdb5:" + id;
  const hit = lsGet(cacheKey, null); if(hit) return hit;
  const tv = MM.isTv(id);
  const d = await tmdb((tv ? "/tv/" : "/movie/") + Math.abs(id), {append_to_response:"external_ids,credits"});
  if(!d) return null;
  const dirs = tv ? (d.created_by || []).map(c=>c.name) : (d.credits && d.credits.crew || []).filter(c=>c.job==="Director").map(c=>c.name);
  const date = tv ? d.first_air_date : d.release_date;
  const out = {
    tmdb:tv ? -d.id : d.id, tv, t:tv ? d.name : d.title, ot:tv ? d.original_name : d.original_title, y:date ? +date.slice(0,4) : "",
    d:dirs.slice(0,3).join(", "), poster:d.poster_path || null, ov:(d.overview || "").slice(0, 1200), g:(d.genres || []).map(x=>x.id),
    qid:(d.external_ids && d.external_ids.wikidata_id) || null,
    pc:(d.production_countries||[]).map(c=>c.name),
    iso:[...(d.origin_country||[]), ...(d.production_countries||[]).map(c=>c.iso_3166_1)].filter(Boolean)
  };
  lsSet(cacheKey, out);
  return out;
};

// Poster for a film we only know by title + year (the featured list).
MM.posterFor = async function(f){
  if(f.poster) return MM.poster(f.poster);
  const k = "mm-pp:" + MM.filmKey(f);
  const c = lsGet(k, undefined);
  if(c !== undefined) return c ? MM.poster(c) : null;
  try{
    const m = await MM.matchFilm(f.t, f.y);
    const p = m && m.poster_path || "";
    lsSet(k, p);
    return p ? MM.poster(p) : null;
  }catch(e){ return null; }
};

/* ---------------- Wikidata: where the story takes place (P840, narrative location) ---------------- */
function parsePoint(s){
  if(!s || s.charAt(0)==="<") return null;               // coordinates on another globe (Mars, the Moon)
  const m = /Point\(([-\d.eE]+) ([-\d.eE]+)\)/.exec(s);
  return m ? [+m[1], +m[2]] : null;
}
const qidOf = uri => uri ? uri.split("/").pop() : null;

MM.wikidataSettings = async function(qids){
  const out = {};
  const list = [...new Set(qids.filter(q=>/^Q\d+$/.test(q||"")))];
  for(let i=0; i<list.length; i+=40){
    const chunk = list.slice(i, i+40);
    const query = `SELECT ?film ?loc ?locLabel ?coord ?country ?countryLabel ?contLabel WHERE {
      VALUES ?film { ${chunk.map(q=>"wd:"+q).join(" ")} }
      ?film wdt:P840 ?loc .
      OPTIONAL { ?loc wdt:P625 ?coord . }
      OPTIONAL { ?loc wdt:P17 ?country . OPTIONAL { ?country wdt:P30 ?cont . } }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }`;
    let rows = [];
    try{
      const r = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(query), {headers:{Accept:"application/sparql-results+json"}});
      if(r.ok) rows = (await r.json()).results.bindings;
    }catch(e){}
    const byFilm = {};
    rows.forEach(b=>{ const f = qidOf(b.film && b.film.value); (byFilm[f] = byFilm[f] || []).push(b); });
    Object.keys(byFilm).forEach(f=>{ const s = pickSetting(byFilm[f]); if(s) out[f] = s; });
    if(i + 40 < list.length) await MM.sleep(250);
  }
  // Second pass for films with no narrative location: the film's country of origin (P495), marked approximate.
  const rest = list.filter(q=>!out[q]);
  for(let i=0; i<rest.length; i+=60){
    const chunk = rest.slice(i, i+60);
    const query = `SELECT ?film ?country ?countryLabel ?contLabel WHERE {
      VALUES ?film { ${chunk.map(q=>"wd:"+q).join(" ")} }
      ?film wdt:P495 ?country .
      OPTIONAL { ?country wdt:P30 ?cont . }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }`;
    try{
      const r = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(query), {headers:{Accept:"application/sparql-results+json"}});
      if(!r.ok) continue;
      (await r.json()).results.bindings.forEach(b=>{
        const f = qidOf(b.film.value); if(out[f]) return;
        const name = b.countryLabel ? b.countryLabel.value : "";
        const pt = MM.countryPoint(name); if(!pt) return;
        out[f] = {p:MM.displayCountry(name), c:MM.displayCountry(name), cont:MM.fixContinent(b.contLabel ? b.contLabel.value : ""),
          lon:+pt[0].toFixed(3), lat:+pt[1].toFixed(3), ap:1, n:FALLBACK_NOTE, src:"production", weak:1};
      });
    }catch(e){}
  }
  return out;
};
const FALLBACK_NOTE = "No setting on record yet, so this is pinned to the country the film comes from. Move the pin if you know better.";

// From all narrative-location rows for one film, pick the most specific place that has coordinates.
function pickSetting(rows){
  const locs = {};
  rows.forEach(b=>{
    const id = qidOf(b.loc.value);
    const L = locs[id] = locs[id] || {id, label:b.locLabel ? b.locLabel.value : "", pt:null, country:null, countryId:null, cont:null};
    if(!L.pt && b.coord) L.pt = parsePoint(b.coord.value);
    if(!L.country && b.country){ L.country = b.countryLabel ? b.countryLabel.value : ""; L.countryId = qidOf(b.country.value); }
    if(!L.cont && b.contLabel) L.cont = b.contLabel.value;
  });
  const all = Object.values(locs).filter(L=>!/^Q\d+$/.test(L.label));  // drop items with no English label
  const specific = all.filter(L=>L.pt && L.countryId && L.countryId !== L.id);
  const countryLevel = all.filter(L=>L.pt && (!L.countryId || L.countryId === L.id));
  const chosen = specific[0] || countryLevel[0];
  if(!chosen) return null;
  const others = all.filter(L=>L!==chosen).map(L=>L.label).slice(0,3);
  const isCountry = !specific.length;
  const country = isCountry ? chosen.label : (chosen.country || "");
  return {
    p: chosen.label, c: MM.displayCountry(country), cont: MM.fixContinent(chosen.cont),
    lon: +chosen.pt[0].toFixed(3), lat: +chosen.pt[1].toFixed(3),
    ap: isCountry ? 1 : 0,
    n: others.length ? "Also set in " + others.join(", ") + "." : "",
    src: "wikidata"
  };
}

// Fallback when Wikidata has no setting: the first production country, marked approximate.
let regionNames = null;
try{ regionNames = new Intl.DisplayNames(["en"], {type:"region"}); }catch(e){}
MM.fallbackSetting = function(det){
  // TMDB's origin country is the film's primary country, so it goes first; then production countries.
  const names = [];
  ((det && det.iso) || []).forEach(code=>{ try{ const n = regionNames && regionNames.of(code); if(n) names.push(n); }catch(e){} });
  names.push(...((det && det.pc) || []));
  for(const c of names){
    const pt = MM.countryPoint(c);
    if(pt) return {p:MM.displayCountry(c), c:MM.displayCountry(c), cont:"", lon:+pt[0].toFixed(3), lat:+pt[1].toFixed(3), ap:1, n:FALLBACK_NOTE, src:"production"};
  }
  return null;
};

// Shared cache of resolved settings (Supabase when signed in, plus this browser).
MM.settingCache = {
  get(id){ return lsGet("mm-set2:" + id, null); },
  put(id, s){ lsSet("mm-set2:" + id, s); }
};

// Hand-checked settings (the featured starter map). Matched by title, including alternate titles.
MM.curated = function(det, entryTitle){
  const F = window.FEATURED; if(!F) return null;
  const titles = [det && det.t, det && det.ot, entryTitle].filter(Boolean).map(MM.norm);
  const y = det && +det.y;
  const f = F.films.find(x=>[x.t, ...(x.aka||[])].some(n=>titles.includes(MM.norm(n))) && !(x.y && y && Math.abs(x.y - y) > 1));
  if(!f) return null;
  return {p:f.p, c:f.c, cont:"", lat:f.lat, lon:f.lon, ap:f.ap ? 1 : 0, n:f.n || "", src:"curated"};
};

// Resolve a list of TMDB-matched films to full log entries with a setting. onStep(done, total) reports progress.
MM.resolveSettings = async function(dets, onStep, titles){
  const curated = new Map();
  dets.forEach((d,i)=>{ if(!d) return; const c = MM.curated(d, titles && titles[i]); if(c) curated.set(d.tmdb, c); });
  // A cached country guess gets another try with each step that hasn't had a go at it yet.
  const weakCached = s => s && s.src === "production" && ((MM.wikiPlotSetting && !s.wikiTried) || (MM.aiSetting && !s.aiTried));
  const need = dets.filter(d=>d && !curated.has(d.tmdb) && (!MM.settingCache.get(d.tmdb) || weakCached(MM.settingCache.get(d.tmdb))));
  if(MM.remoteSettings && need.length){
    // Only trust shared entries that came from a recorded setting; country fallbacks get re-checked.
    try{ const got = await MM.remoteSettings(need.map(d=>d.tmdb)); Object.keys(got).forEach(id=>{ if(got[id].src === "wikidata" || got[id].src === "ai") MM.settingCache.put(id, got[id]); }); }catch(e){}
  }
  const still = need.filter(d=>!MM.settingCache.get(d.tmdb) || weakCached(MM.settingCache.get(d.tmdb)));
  const wd = await MM.wikidataSettings(still.map(d=>d.qid));
  const fresh = {};
  // 1) a setting recorded on Wikidata
  const noRecord = [];
  still.forEach(d=>{
    const w = d.qid && wd[d.qid];
    if(w && !w.weak){ MM.settingCache.put(d.tmdb, w); fresh[d.tmdb] = w; }
    else noRecord.push(d);
  });
  // 2) places linked in the Wikipedia plot (free)  3) AI reads the plot, if switched on  4) otherwise the film's country
  let done = 0;
  await MM.pool(noRecord, 2, async d=>{
    let s = null;
    if(MM.wikiPlotSetting){ try{ s = await MM.wikiPlotSetting(d); }catch(e){} }
    if(!s && MM.aiSetting){ try{ s = await MM.aiSetting(d); }catch(e){} }
    if(!s){
      const w = d.qid && wd[d.qid];
      s = MM.fallbackSetting(d) || w || null;
      if(s) s = Object.assign({}, s, {wikiTried: MM.wikiPlotSetting ? 1 : 0, aiTried: MM.aiSetting ? 1 : 0});
    }
    if(s){ MM.settingCache.put(d.tmdb, s); if(s.src === "production" || s.src === "wikidata") fresh[d.tmdb] = s; }
    done++; if(onStep) onStep(done, noRecord.length);
  });
  if(MM.saveRemoteSettings && Object.keys(fresh).length){ try{ await MM.saveRemoteSettings(fresh); }catch(e){} }
  return dets.map(d=>d ? (curated.get(d.tmdb) || MM.settingCache.get(d.tmdb)) : null);
};

/* ---------------- similar titles from a country ---------------- */
// Country name → ISO code, built from the browser's own list of region names.
let isoMap = null;
const ISO_EXTRA = {"unitedstatesofamerica":"US","usa":"US","unitedkingdom":"GB","england":"GB","scotland":"GB","wales":"GB","southkorea":"KR","korea":"KR","northkorea":"KP","russia":"RU","sovietunion":"RU","czechia":"CZ","czechrepublic":"CZ","turkey":"TR","turkiye":"TR","vietnam":"VN","iran":"IR","syria":"SY","laos":"LA","bolivia":"BO","venezuela":"VE","tanzania":"TZ","moldova":"MD","palestine":"PS","taiwan":"TW","eastgermany":"DE","westgermany":"DE","nazigermany":"DE","demrepcongo":"CD","congo":"CG","ivorycoast":"CI","cotedivoire":"CI","bosniaandherz":"BA","dominicanrep":"DO","centralafricanrep":"CF","ssudan":"SS","macedonia":"MK","northmacedonia":"MK","eswatini":"SZ","eqguinea":"GQ","wsahara":"EH","solomonis":"SB","hongkong":"HK","macau":"MO"};
MM.isoFor = function(name){
  if(!name) return null;
  if(!isoMap){
    isoMap = Object.assign({}, ISO_EXTRA);
    try{
      const dn = new Intl.DisplayNames(["en"], {type:"region"});
      for(let a=65; a<91; a++) for(let b=65; b<91; b++){
        const code = String.fromCharCode(a, b);
        try{ const n = dn.of(code); if(n && n !== code) isoMap[MM.norm(n)] = isoMap[MM.norm(n)] || code; }catch(e){}
      }
    }catch(e){}
  }
  return isoMap[MM.norm(name)] || isoMap[MM.norm(MM.geoName(name))] || isoMap[MM.norm(MM.displayCountry(name))] || null;
};

// "More like this, from here": titles set in the same place as this one, ranked by how alike they are.
//   1. Wikidata: titles whose story is set within a short distance of this pin (or anywhere in the
//      country, for country-wide pins), with their genres.
//   2. TMDB's own "recommendations" and "similar" lists for this title, which boost matching titles.
//   3. Ranked by shared genres, a TMDB match and how well known they are. If the place is thin,
//      TMDB's recommendations from the same country, then well-known titles from the country, fill in.
async function wdq(query){
  const r = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(query), {headers:{Accept:"application/sparql-results+json"}});
  return r.ok ? (await r.json()).results.bindings : [];
}
const MOVIE_OR_SERIES = `{ ?film wdt:P4947 ?tm . } UNION { ?film wdt:P4983 ?tvid . }`;
async function titlesSetNear(lat, lon, km){
  return wdq(`SELECT ?film ?tm ?tvid ?locLabel ?links (GROUP_CONCAT(DISTINCT ?g; separator=" ") AS ?gs) WHERE {
    SERVICE wikibase:around { ?loc wdt:P625 ?c . bd:serviceParam wikibase:center "Point(${(+lon).toFixed(4)} ${(+lat).toFixed(4)})"^^geo:wktLiteral ; wikibase:radius "${km}" . }
    ?film wdt:P840 ?loc . ${MOVIE_OR_SERIES}
    OPTIONAL { ?film wdt:P136 ?g . } OPTIONAL { ?film wikibase:sitelinks ?links . }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". ?loc rdfs:label ?locLabel . }
  } GROUP BY ?film ?tm ?tvid ?locLabel ?links ORDER BY DESC(?links) LIMIT 250`);
}
async function titlesSetIn(iso){
  return wdq(`SELECT ?film ?tm ?tvid ?links (GROUP_CONCAT(DISTINCT ?g; separator=" ") AS ?gs) WHERE {
    ?country wdt:P297 "${iso}" .
    { ?film wdt:P840 ?country . } UNION { ?film wdt:P840 ?loc . ?loc wdt:P17 ?country . }
    ${MOVIE_OR_SERIES}
    OPTIONAL { ?film wdt:P136 ?g . } OPTIONAL { ?film wikibase:sitelinks ?links . }
  } GROUP BY ?film ?tm ?tvid ?links ORDER BY DESC(?links) LIMIT 250`);
}
async function genresOf(qid){
  if(!qid) return [];
  const rows = await wdq(`SELECT ?g WHERE { wd:${qid} wdt:P136 ?g . }`).catch(()=>[]);
  return rows.map(b=>qidOf(b.g.value));
}
async function tmdbRelated(det){
  const base = (det.tv ? "/tv/" : "/movie/") + Math.abs(det.tmdb);
  const pages = await Promise.all(["/recommendations", "/similar"].map(x=>tmdb(base + x, {}).catch(()=>null)));
  const out = new Map();
  pages.forEach((pg, j)=>((pg && pg.results) || []).forEach((m, i)=>{
    const id = det.tv ? -m.id : m.id;
    if(!out.has(id)) out.set(id, {rank:i + j*3, t:det.tv ? m.name : m.title, y:((det.tv ? m.first_air_date : m.release_date) || "").slice(0,4), poster:m.poster_path, lang:m.original_language});
  }));
  return out;
}
const shortPlace = s => String(s||"").replace(/\s*\([^)]*\)/g, "").split(",").pop().trim();

MM.similarFrom = async function(f, iso, exclude){
  let det = f.tmdb ? await MM.filmDetails(f.tmdb).catch(()=>null) : null;
  if(!det && f.t){ const m = await MM.matchFilm(f.t, f.y).catch(()=>null); det = m ? await MM.filmDetails(m.id).catch(()=>null) : null; }
  const self = det ? det.tmdb : f.tmdb;
  // Country-wide pins ("Across Argentina", or a dashed pin on the country's middle) look across the whole country.
  const mid = MM.countryPoint(f.c);
  const countryWide = !f.p || MM.norm(f.p) === MM.norm(f.c) || MM.norm(f.p) === MM.norm(MM.displayCountry(f.c)) || !isFinite(f.lat)
    || (f.ap && mid && Math.abs(mid[0] - f.lon) < 1.5 && Math.abs(mid[1] - f.lat) < 1.5);
  const key = `mm-sim4:${self || MM.filmKey(f)}:${countryWide ? iso : (+f.lat).toFixed(1) + "," + (+f.lon).toFixed(1)}`;
  let pool = lsGet(key, null);
  if(!pool){
    const [myGenres, related] = await Promise.all([
      det ? genresOf(det.qid) : [],
      det ? tmdbRelated(det).catch(()=>new Map()) : new Map()
    ]);
    // Titles set here: close by first, then a wider ring, then the whole country.
    const byId = new Map();
    const take = (rows, tier0) => rows.forEach(b=>{
      let tier = tier0;
      const id = b.tm ? +b.tm.value : (b.tvid ? -b.tvid.value : 0);
      if(!id || isNaN(id) || byId.has(id)) return;
      let where = b.locLabel ? b.locLabel.value : "";
      // a title set in "Norway" as a whole isn't set near this pin
      if(where && [f.c, MM.displayCountry(f.c)].some(n=>MM.norm(n) === MM.norm(where))){ where = ""; tier = 2; }
      byId.set(id, {tmdb:id, tier, where, links:b.links ? +b.links.value : 0, g:(b.gs ? b.gs.value.split(" ") : []).map(qidOf)});
    });
    if(!countryWide && isFinite(f.lat)){
      take(await titlesSetNear(f.lat, f.lon, f.ap ? 120 : 40).catch(()=>[]), 0);
      if(byId.size < 12) take(await titlesSetNear(f.lat, f.lon, 250).catch(()=>[]), 1);
    }
    if(byId.size < 12) take(await titlesSetIn(iso).catch(()=>[]), 2);
    byId.delete(self);
    // Score: shared genres matter most, then TMDB thinking they're alike, then how close and how well known.
    const mine = new Set(myGenres);
    const scored = [...byId.values()].map(c=>{
      const shared = c.g.filter(g=>mine.has(g)).length;
      const genre = mine.size ? shared / Math.max(1, Math.min(mine.size, c.g.length || 1)) : 0;
      const rel = related.has(c.tmdb) ? 2.5 - related.get(c.tmdb).rank * 0.05 : 0;
      return Object.assign(c, {score: genre*4 + rel + Math.log10(1 + c.links) * 0.8 - c.tier * 0.9});
    }).sort((a,b)=>b.score - a.score);
    pool = scored.slice(0, 30).map(c=>({tmdb:c.tmdb, where:c.tier < 2 ? shortPlace(c.where) : "", tier:c.tier}));
    // Fill with TMDB's look-alikes from the same country, then the country's best known.
    const relIds = [...related.keys()].filter(id=>id !== self && !byId.has(id)).slice(0, 12);
    for(const id of relIds){
      const d = await MM.filmDetails(id).catch(()=>null);
      if(d && (d.iso || []).includes(iso)) pool.push({tmdb:id, where:"", tier:3, t:d.t, y:String(d.y||""), poster:d.poster});
    }
    lsSet(key, pool);
  }
  // Details (title, year, poster) for the best few that aren't already on the map.
  const skip = new Set([self, f.tmdb].filter(Boolean)), out = [];
  for(const c of pool){
    if(out.length >= 6) break;
    if(skip.has(c.tmdb)) continue;
    let m = c;
    if(!c.poster){ const d = await MM.filmDetails(c.tmdb).catch(()=>null); if(!d) continue; m = Object.assign({}, c, {t:d.t, y:String(d.y||""), poster:d.poster}); }
    if(!m.poster || (exclude && exclude(m))) continue;
    out.push(m); skip.add(m.tmdb);
  }
  if(out.length < 6){
    const old = await countryFavourites(f, det, iso).catch(()=>[]);
    for(const m of old){ if(out.length >= 6) break; if(!skip.has(m.tmdb) && !(exclude && exclude(m))){ out.push(m); skip.add(m.tmdb); } }
  }
  // Heading: "More set in Buenos Aires" when most picks share this place, else "More from Argentina".
  const near = out.filter(m=>m.tier === 0 && m.where);
  const counts = {}; near.forEach(m=>counts[m.where] = (counts[m.where] || 0) + 1);
  const top = Object.keys(counts).sort((a,b)=>counts[b] - counts[a])[0];
  const here = !countryWide && near.length >= 3 ? (counts[top] >= 2 ? top : shortPlace(f.p)) : "";
  return {list: out, heading: here ? "More set in " + here : "More from " + MM.displayCountry(f.c)};
};

// Well-known titles from the country that share the film's genres (the old suggestions; now a filler).
async function countryFavourites(f, det, iso){
  const genres = (det && det.g || []).slice(0, 2);
  const key = `mm-sim:${iso}:${det ? det.tmdb : MM.filmKey(f)}`;
  let list = lsGet(key, null);
  if(!list){
    const base = {with_origin_country: iso, sort_by: "vote_count.desc", include_adult: "false", "vote_count.gte": "20"};
    const path = MM.isTv(f.tmdb) || (det && det.tv) ? "/discover/tv" : "/discover/movie";
    const ask = async extra => ((await tmdb(path, Object.assign({}, base, extra))) || {}).results || [];
    let res = genres.length ? await ask({with_genres: genres.join("|")}) : [];
    if(res.length < 6) res = res.concat(await ask({}));
    const isTvPath = path === "/discover/tv";
    list = res.map(m=>({tmdb: isTvPath ? -m.id : m.id, t: isTvPath ? m.name : m.title, y: ((isTvPath ? m.first_air_date : m.release_date) || "").slice(0,4), poster: m.poster_path, tier:4}))
      .filter((m,i,a)=>m.poster && a.findIndex(x=>x.tmdb === m.tmdb) === i);
    lsSet(key, list.slice(0, 20));
  }
  return list;
}

/* ---------------- avatar colour ---------------- */
MM.avatarColor = function(name){
  const pal = ["#BF4E2A","#56663A","#3E7590","#A0712A","#7A4E7E","#2F6F62"];
  let h = 0; for(const ch of String(name||"")) h = (h*31 + ch.charCodeAt(0)) >>> 0;
  return pal[h % pal.length];
};
})();
