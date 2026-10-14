// MovieMap data layer: TMDB lookups, Wikidata setting lookups, Letterboxd export parsing, storage.
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

// Best TMDB match for a title + year (from a Letterboxd export or the featured list).
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
  const cacheKey = "mm-tmdb:" + id;
  const hit = lsGet(cacheKey, null); if(hit) return hit;
  const d = await tmdb("/movie/" + id, {append_to_response:"external_ids,credits"});
  if(!d) return null;
  const dirs = (d.credits && d.credits.crew || []).filter(c=>c.job==="Director").map(c=>c.name);
  const out = {
    tmdb:d.id, t:d.title, ot:d.original_title, y:d.release_date ? +d.release_date.slice(0,4) : "",
    d:dirs.slice(0,3).join(", "), poster:d.poster_path || null,
    qid:(d.external_ids && d.external_ids.wikidata_id) || null,
    pc:(d.production_countries||[]).map(c=>c.name)
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
  return out;
};

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
MM.fallbackSetting = function(det){
  for(const c of (det && det.pc) || []){
    const pt = MM.countryPoint(c);
    if(pt) return {p:MM.displayCountry(c), c:MM.displayCountry(c), cont:"", lon:+pt[0].toFixed(3), lat:+pt[1].toFixed(3), ap:1,
      n:"No setting on record yet, so this is pinned to the country that produced it. Move the pin if you know better.", src:"production"};
  }
  return null;
};

// Shared cache of resolved settings (Supabase when signed in, plus this browser).
MM.settingCache = {
  get(id){ return lsGet("mm-set:" + id, null); },
  put(id, s){ lsSet("mm-set:" + id, s); }
};

// Resolve a list of TMDB-matched films to full log entries with a setting. onStep(done, total) reports progress.
MM.resolveSettings = async function(dets, onStep){
  const need = dets.filter(d=>d && !MM.settingCache.get(d.tmdb));
  if(MM.remoteSettings && need.length){
    try{ const got = await MM.remoteSettings(need.map(d=>d.tmdb)); Object.keys(got).forEach(id=>MM.settingCache.put(id, got[id])); }catch(e){}
  }
  const still = need.filter(d=>!MM.settingCache.get(d.tmdb));
  const wd = await MM.wikidataSettings(still.map(d=>d.qid));
  const fresh = {};
  still.forEach(d=>{
    const s = (d.qid && wd[d.qid]) || MM.fallbackSetting(d);
    if(s){ MM.settingCache.put(d.tmdb, s); fresh[d.tmdb] = s; }
  });
  if(MM.saveRemoteSettings && Object.keys(fresh).length){ try{ await MM.saveRemoteSettings(fresh); }catch(e){} }
  if(onStep) onStep(dets.length, dets.length);
  return dets.map(d=>d ? MM.settingCache.get(d.tmdb) : null);
};

/* ---------------- Letterboxd export ---------------- */
// RFC 4180-ish CSV parser (quoted fields, commas and newlines inside quotes).
MM.parseCSV = function(text){
  const rows = []; let row = [], field = "", q = false;
  text = text.replace(/^﻿/, "");
  for(let i=0; i<text.length; i++){
    const ch = text[i];
    if(q){
      if(ch === '"'){ if(text[i+1] === '"'){ field += '"'; i++; } else q = false; }
      else field += ch;
    } else if(ch === '"') q = true;
    else if(ch === ","){ row.push(field); field = ""; }
    else if(ch === "\n" || ch === "\r"){
      if(ch === "\r" && text[i+1] === "\n") i++;
      row.push(field); field = ""; rows.push(row); row = [];
    } else field += ch;
  }
  if(field !== "" || row.length){ row.push(field); rows.push(row); }
  const head = (rows.shift() || []).map(h=>h.trim());
  return rows.filter(r=>r.some(c=>c.trim()!=="")).map(r=>{ const o = {}; head.forEach((h,i)=>o[h] = (r[i]||"").trim()); return o; });
};

// Accepts the export .zip or any of its CSVs (watched, ratings, diary, reviews). Returns one entry per film.
MM.readLetterboxd = async function(files){
  const texts = {};
  for(const file of files){
    if(/\.zip$/i.test(file.name) || file.type === "application/zip"){
      const zip = await JSZip.loadAsync(file);
      for(const name of Object.keys(zip.files)){
        const base = name.split("/").pop().toLowerCase();
        if(["watched.csv","ratings.csv","diary.csv","reviews.csv"].includes(base) && !name.includes("deleted/")) texts[base] = await zip.files[name].async("string");
      }
    } else if(/\.csv$/i.test(file.name)){
      texts[file.name.toLowerCase().split("/").pop()] = await file.text();
    }
  }
  const films = new Map();
  const keyOf = r => r.Name ? MM.norm(r.Name) + "|" + (r.Year||"") : null;
  const touch = r => { const k = keyOf(r); if(!k) return null; if(!films.has(k)) films.set(k, {t:r.Name, y:+r.Year||"", watched:r.Date||""}); return films.get(k); };
  const order = ["watched.csv","diary.csv","ratings.csv","reviews.csv"];
  let used = 0;
  for(const name of order){
    if(!texts[name]) continue; used++;
    MM.parseCSV(texts[name]).forEach(r=>{
      const f = touch(r); if(!f) return;
      const wd = r["Watched Date"] || r.Date;
      if(wd && (!f.watched || wd > f.watched)) f.watched = wd;
      if(r.Rating && +r.Rating > 0) f.r = +r.Rating;
      if(name === "reviews.csv") f.rv = 1;
    });
  }
  // Any other CSV someone drops in: use it if it has Name + Year columns.
  if(!used){
    Object.values(texts).forEach(t=>MM.parseCSV(t).forEach(r=>{ const f = touch(r); if(f && r.Rating && +r.Rating>0) f.r = +r.Rating; }));
  }
  return [...films.values()];
};

/* ---------------- avatar colour ---------------- */
MM.avatarColor = function(name){
  const pal = ["#BF4E2A","#56663A","#3E7590","#A0712A","#7A4E7E","#2F6F62"];
  let h = 0; for(const ch of String(name||"")) h = (h*31 + ch.charCodeAt(0)) >>> 0;
  return pal[h % pal.length];
};
})();
