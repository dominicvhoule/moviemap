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

MM.searchFilms = async function(query){
  const d = await tmdb("/search/movie", {query, include_adult:"false"});
  return (d && d.results || []).slice(0, 10).map(m=>({
    tmdb:m.id, t:m.title, ot:m.original_title, y:m.release_date ? +m.release_date.slice(0,4) : "", poster:m.poster_path, pop:m.popularity||0
  }));
};

// Best TMDB match for a title + year (the featured list and feed entries without a TMDB id).
MM.matchFilm = async function(title, year){
  const tries = year ? [{year}, {}] : [{}];
  for(const extra of tries){
    const d = await tmdb("/search/movie", Object.assign({query:title, include_adult:"false"}, extra));
    const res = d && d.results || [];
    if(!res.length) continue;
    const nt = MM.norm(title);
    const score = m => {
      const y = m.release_date ? +m.release_date.slice(0,4) : 0;
      let s = 0;
      if(MM.norm(m.title)===nt || MM.norm(m.original_title)===nt) s += 10;
      if(year && y===+year) s += 8; else if(year && Math.abs(y-year)===1) s += 4;
      s += Math.min(3, Math.log10(1+(m.popularity||0)));
      return s;
    };
    res.sort((a,b)=>score(b)-score(a));
    return res[0];
  }
  return null;
};

// Full details for one TMDB id: director, Wikidata id, production countries.
MM.filmDetails = async function(id){
  const cacheKey = "mm-tmdb3:" + id;
  const hit = lsGet(cacheKey, null); if(hit) return hit;
  const d = await tmdb("/movie/" + id, {append_to_response:"external_ids,credits"});
  if(!d) return null;
  const dirs = (d.credits && d.credits.crew || []).filter(c=>c.job==="Director").map(c=>c.name);
  const out = {
    tmdb:d.id, t:d.title, ot:d.original_title, y:d.release_date ? +d.release_date.slice(0,4) : "",
    d:dirs.slice(0,3).join(", "), poster:d.poster_path || null,
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
  const need = dets.filter(d=>d && !curated.has(d.tmdb) && !MM.settingCache.get(d.tmdb));
  if(MM.remoteSettings && need.length){
    // Only trust shared entries that came from a recorded setting; country fallbacks get re-checked.
    try{ const got = await MM.remoteSettings(need.map(d=>d.tmdb)); Object.keys(got).forEach(id=>{ if(got[id].src === "wikidata") MM.settingCache.put(id, got[id]); }); }catch(e){}
  }
  const still = need.filter(d=>!MM.settingCache.get(d.tmdb));
  const wd = await MM.wikidataSettings(still.map(d=>d.qid));
  const fresh = {};
  still.forEach(d=>{
    const w = d.qid && wd[d.qid];
    const s = (w && !w.weak ? w : null) || MM.fallbackSetting(d) || w;
    if(s){ MM.settingCache.put(d.tmdb, s); fresh[d.tmdb] = s; }
  });
  if(MM.saveRemoteSettings && Object.keys(fresh).length){ try{ await MM.saveRemoteSettings(fresh); }catch(e){} }
  if(onStep) onStep(dets.length, dets.length);
  return dets.map(d=>d ? (curated.get(d.tmdb) || MM.settingCache.get(d.tmdb)) : null);
};

/* ---------------- avatar colour ---------------- */
MM.avatarColor = function(name){
  const pal = ["#BF4E2A","#56663A","#3E7590","#A0712A","#7A4E7E","#2F6F62"];
  let h = 0; for(const ch of String(name||"")) h = (h*31 + ch.charCodeAt(0)) >>> 0;
  return pal[h % pal.length];
};
})();
