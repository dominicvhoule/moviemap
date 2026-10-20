// MovieMap app: routing, map, logbook, logging, Letterboxd import, accounts, people.
(function(){
const CFG = window.MOVIEMAP_CONFIG || {};
const FEATURED = window.FEATURED;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const stars = r => r==null || r==="" ? "" : "★".repeat(Math.floor(r)) + (r%1 ? "½" : "");
const fmtCoord = (lat,lon)=>`${Math.abs(lat).toFixed(2)}°${lat>=0?"N":"S"} · ${Math.abs(lon).toFixed(2)}°${lon>=0?"E":"W"}`;
const siteURL = () => location.origin + location.pathname;
const profileURL = u => siteURL() + "#/u/" + encodeURIComponent(u);
let toastT;
function toast(msg){ const el = $("#toast"); el.textContent = msg; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(()=>el.hidden = true, 2600); }

// Continents for the featured list's countries (logged films carry their own).
const CONT = {"Russia":"Europe","Mexico":"North America","United Arab Emirates":"Asia","Brazil":"South America","United States":"North America","Argentina":"South America","Italy":"Europe","Germany":"Europe","Norway":"Europe","France":"Europe","Spain":"Europe","Vietnam":"Asia","Chile":"South America","China":"Asia","Lebanon":"Asia"};
const contOf = f => f.cont || CONT[f.c] || "";
const placeLine = f => (!f.p ? f.c : !f.c || f.p.includes(f.c) ? f.p : f.p + ", " + f.c) || "";

/* ================= accounts (Supabase) ================= */
// Accept the project URL with or without a trailing /rest/v1/ copied from the dashboard.
const SB_URL = String(CFG.SUPABASE_URL||"").trim().replace(/\/(rest|auth)\/v1\/?$/,"").replace(/\/+$/,"");
const sb = (SB_URL && CFG.SUPABASE_ANON_KEY && window.supabase) ? window.supabase.createClient(SB_URL, CFG.SUPABASE_ANON_KEY) : null;
let session = null, me = null;     // me = my profile row
const cloud = () => !!(sb && session && me);

const toRow = f => ({
  title:f.t, year:f.y||null, director:f.d||null, tmdb_id:f.tmdb||null, poster_path:f.poster||null,
  place:f.p||null, country:f.c||null, continent:f.cont||null, lat:f.lat, lon:f.lon, approx:!!f.ap,
  note:f.n ? String(f.n).slice(0,500) : null, rating:f.r||null, reviewed:!!f.rv, watched_on:f.watched||null, source:f.src||null,
  lb_slug:f.lbs||null
});
const fromRow = r => ({
  id:r.id, t:r.title, y:r.year||"", d:r.director||"", tmdb:r.tmdb_id, poster:r.poster_path, p:r.place||"", c:r.country||"",
  cont:r.continent||"", lat:r.lat, lon:r.lon, ap:r.approx?1:0, n:r.note||"", r:r.rating!=null?+r.rating:null, rv:r.reviewed?1:0,
  watched:r.watched_on||"", src:r.source||"", created:r.created_at, lbs:r.lb_slug||""
});

async function fetchLogs(userId){
  const out = [];
  for(let from=0; ; from+=1000){
    const {data, error} = await sb.from("logs").select("*").eq("user_id", userId).order("watched_on", {ascending:false, nullsFirst:false}).order("created_at", {ascending:false}).range(from, from+999);
    if(error) throw error;
    out.push(...data.map(fromRow));
    if(data.length < 1000) break;
  }
  return out;
}

// Shared setting cache hooks used by MM.resolveSettings.
if(sb){
  MM.remoteSettings = async ids => {
    const got = {};
    for(let i=0; i<ids.length; i+=200){
      const {data} = await sb.from("film_settings").select("*").in("tmdb_id", ids.slice(i, i+200));
      (data||[]).forEach(r=>got[r.tmdb_id] = {p:r.place, c:r.country, cont:r.continent||"", lat:r.lat, lon:r.lon, ap:r.approx?1:0, n:r.note||"", src:r.source});
    }
    return got;
  };
  MM.aiSetting = null;   // switched on after sign-in, once the function answers
  MM.saveRemoteSettings = async map => {
    if(!session) return;
    const rows = Object.keys(map).filter(id=>["wikidata","wikipedia","production"].includes(map[id].src)).map(id=>{ const s = map[id]; return {tmdb_id:+id, place:s.p, country:s.c, continent:s.cont||null, lat:s.lat, lon:s.lon, approx:!!s.ap, note:s.n||null, source:s.src}; });
    for(let i=0; i<rows.length; i+=200) await sb.from("film_settings").upsert(rows.slice(i, i+200), {onConflict:"tmdb_id", ignoreDuplicates:true});
  };
}

/* ================= my films: account or this browser ================= */
const LOCAL = "mm-local-films";
const Store = {
  async load(){
    if(cloud()) return fetchLogs(me.id);
    return MM.lsGet(LOCAL, []);
  },
  async add(list){
    if(!list.length) return {added:0};
    if(cloud()){
      const rows = list.map(toRow);
      let added = 0;
      for(let i=0; i<rows.length; i+=200){
        const {data, error} = await sb.from("logs").upsert(rows.slice(i, i+200), {onConflict:"user_id,title,year", ignoreDuplicates:true}).select("id");
        if(error) throw error;
        added += (data||[]).length;
      }
      return {added};
    }
    const cur = MM.lsGet(LOCAL, []); const have = new Set(cur.map(MM.filmKey));
    const fresh = list.filter(f=>!have.has(MM.filmKey(f)));
    if(!MM.lsSet(LOCAL, [...fresh, ...cur])) throw new Error("This browser is out of storage space. Create an account to keep more films.");
    return {added:fresh.length};
  },
  async update(f, patch){
    if(cloud() && f.id){
      const row = toRow(Object.assign({}, f, patch));
      const {error} = await sb.from("logs").update({lat:row.lat, lon:row.lon, approx:row.approx, place:row.place, country:row.country, continent:row.continent, note:row.note, rating:row.rating, source:row.source}).eq("id", f.id);
      if(error) throw error;
    } else if(!cloud()){
      const cur = MM.lsGet(LOCAL, []); const k = MM.filmKey(f);
      MM.lsSet(LOCAL, cur.map(x=>MM.filmKey(x)===k ? Object.assign({}, x, patch) : x));
    }
    Object.assign(f, patch);
  },
  async remove(f){
    if(cloud() && f.id){ const {error} = await sb.from("logs").delete().eq("id", f.id); if(error) throw error; }
    else if(!cloud()){ const k = MM.filmKey(f); MM.lsSet(LOCAL, MM.lsGet(LOCAL, []).filter(x=>MM.filmKey(x)!==k)); }
  }
};
let myFilms = [];
async function reloadMine(){ try{ myFilms = await Store.load(); }catch(e){ myFilms = []; toast("Couldn't load your films. Check your connection."); } }
const myKeys = () => new Set(myFilms.map(MM.filmKey));

// The printable poster is built (js/poster.js) but switched off until it's ready to sell.
const POSTERS = false;

/* ================= map ================= */
// A real street map (MapLibre + OpenFreeMap tiles, free and keyless) that behaves like Google Maps
// (place names and detail appear as you zoom, pins merge into counts and split apart) but is drawn in
// the Swiss palette: grey land, white water and roads, black lettering, red pins.
let countries = [];
let viewing = {owner:null, films:[], mine:false};   // what the map shows
let selected = null, picking = null, preview = null;
let map = null, mapReady = false, markers = [], previewMarker = null;
const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const WORLD_VIEW = {center:[10, 25], zoom:1.3};

function initMap(){
  if(map || !window.maplibregl) return;
  map = new maplibregl.Map({container:"map", style:MAP_STYLE, center:WORLD_VIEW.center, zoom:WORLD_VIEW.zoom,
    minZoom:0.8, maxZoom:17, attributionControl:false, dragRotate:false, pitchWithRotate:false, renderWorldCopies:true});
  map.touchZoomRotate.disableRotation();
  map.getCanvasContainer().style.background = "#E6E6E6";
  map.addControl(new maplibregl.AttributionControl({compact:true}), "bottom-right");
  // Restyle and pin as soon as the style arrives, without waiting for every tile to finish.
  map.once("style.load", ()=>{
    swissStyle();
    // Countries with a film: solid black with white names, as on the original MovieMap. Zoomed in to
    // city level, the black fades so the streets show through and the map's own names take over.
    const firstLabel = map.getStyle().layers.find(l=>l.type === "symbol");
    map.addSource("mm-countries", {type:"geojson", data:{type:"FeatureCollection", features:countries.map(unwrapFeature)}});
    map.addLayer({id:"mm-visited", type:"fill", source:"mm-countries",
      paint:{"fill-color":"#111111", "fill-opacity":["interpolate", ["linear"], ["zoom"], 3.5, 1, 6, 0.14]},
      filter:["in", ["get","name"], ["literal", []]]}, firstLabel && firstLabel.id);
    countryPoints();
    map.addSource("mm-country-points", {type:"geojson", data:{type:"FeatureCollection", features:[]}});
    // Their names: white on black, moving to a free side of their spot when a pin is in the way,
    // and turning black as the fill fades when you zoom in.
    map.addLayer({id:"mm-visited-labels", type:"symbol", source:"mm-country-points", maxzoom:7,
      layout:{"text-field":["get","label"], "text-font":["Noto Sans Bold"], "text-transform":"uppercase", "text-letter-spacing":0.08,
        "text-size":["interpolate", ["linear"], ["zoom"], 1, 9, 4, 13], "text-max-width":7, "symbol-sort-key":["get","rank"],
        "text-padding":2},
      paint:{"text-color":["interpolate", ["linear"], ["zoom"], 4.5, "#FFFFFF", 5.5, "#111111"],
        "text-halo-color":["interpolate", ["linear"], ["zoom"], 4.5, "rgba(17,17,17,0)", 5.5, "#E6E6E6"], "text-halo-width":1},
      filter:["in", ["get","name"], ["literal", []]]});
    // Invisible stand-ins for the pins, so the map's names keep clear of them instead of running under them.
    map.addImage("mm-block", {width:32, height:32, data:new Uint8Array(32 * 32 * 4)});
    map.addSource("mm-pins", {type:"geojson", data:{type:"FeatureCollection", features:[]}});
    map.addLayer({id:"mm-pin-blocks", type:"symbol", source:"mm-pins",
      layout:{"icon-image":"mm-block", "icon-size":["get","s"], "icon-offset":["get","o"], "icon-allow-overlap":true, "icon-ignore-placement":false}});
    mapReady = true;
    renderPins(); fitPins(false);
    // Keep the map credit folded away until it's clicked.
    const fold = () => { const at = map.getContainer().querySelector(".maplibregl-ctrl-attrib"); if(at) at.classList.remove("maplibregl-compact-show"); };
    fold(); map.once("load", fold); map.once("idle", fold);
  });
  map.on("zoomend", ()=>renderPins());
  map.on("click", ev=>{
    if(!picking){
      if(ev.originalEvent && ev.originalEvent.target.closest && ev.originalEvent.target.closest(".gpin")) return;   // that was a pin
      if(!$("#detail").hidden){ closeDetail(); return; }
      // Clicking a black country (one with a film) opens its page.
      const hit = map.getLayer("mm-visited") && map.queryRenderedFeatures(ev.point, {layers:["mm-visited"]})[0];
      if(hit) openCountry(hit.properties.name);
      return;
    }
    const ll = [ev.lngLat.wrap().lng, ev.lngLat.lat];
    const hit = countries.find(c=>d3.geoContains(c, ll));
    const cb = picking; picking = null;
    $("#map").classList.remove("picking"); $("#pickhint").hidden = true;
    cb({lon:+ll[0].toFixed(3), lat:+ll[1].toFixed(3), country: hit ? MM.displayCountry(hit.properties.name) : ""});
  });
}
// One label point per country (on its largest landmass), with the short name used on the map.
const SHORT_NAMES = {"United States of America":"United States","Dem. Rep. Congo":"DR Congo","Bosnia and Herz.":"Bosnia","S. Sudan":"South Sudan","Falkland Is.":"Falklands","W. Sahara":"W. Sahara","Central African Rep.":"Central African Rep.","Dominican Rep.":"Dominican Rep.","Eq. Guinea":"Eq. Guinea","Solomon Is.":"Solomon Is."};
let countryPointsCache = null;
// Up to 40 spots inside a country (deepest first), each with how much land runs across and up from it.
function labelSpots(p){
  if(p.spots) return p.spots;
  p.spots = deepestPoint(p.part).slice(0, 40).map(s=>{ const [w, h] = landRun(p.part, s.c); return {c:s.c, w, h}; });
  return p.spots;
}
// How much land runs across (west-east) and up (south-north) through a point, in degrees, so we can
// tell whether a name written there fits inside the country.
function landRun(poly, [x, y]){
  const xs = [], ys = [];
  poly.coordinates.forEach(r=>{ for(let i=1; i<r.length; i++){
    const [ax, ay] = r[i-1], [bx, by] = r[i];
    if((ay > y) !== (by > y)) xs.push(ax + (y - ay) * (bx - ax) / (by - ay));
    if((ax > x) !== (bx > x)) ys.push(ay + (x - ax) * (by - ay) / (bx - ax));
  } });
  const span = (list, v) => { list.sort((a,b)=>a-b); for(let i=0; i+1<list.length; i+=2) if(list[i] <= v && v <= list[i+1]) return list[i+1] - list[i]; return 0; };
  return [span(xs, x), span(ys, y)];
}
// The point deepest inside a country's land (furthest from any coast or border), so its name sits on
// the country rather than on a bay or the sea next to it (Canada's middle is Hudson Bay).
// Returns spots inside the country, deepest first.
function deepestPoint(poly){
  const ring = poly.coordinates[0]; if(!ring || ring.length < 4) return [{c:d3.geoCentroid(poly), d:0}];
  const xs = ring.map(p=>p[0]), ys = ring.map(p=>p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  if(x1 - x0 > 180) return [{c:d3.geoCentroid(poly), d:0}];      // wraps the date line: keep it simple
  const k = Math.cos((y0 + y1) / 2 * Math.PI / 180) || 1;
  const segs = [];
  poly.coordinates.forEach(r=>{ for(let i=1; i<r.length; i++) segs.push([r[i-1][0] * k, r[i-1][1], r[i][0] * k, r[i][1]]); });
  const dist = (x, y) => { let m = Infinity; for(const [ax, ay, bx, by] of segs){ const dx = bx - ax, dy = by - ay, l = dx*dx + dy*dy; let t = l ? ((x - ax) * dx + (y - ay) * dy) / l : 0; t = Math.max(0, Math.min(1, t)); const ex = ax + t*dx - x, ey = ay + t*dy - y; const d = ex*ex + ey*ey; if(d < m) m = d; } return m; };
  const pts = [];
  const N = 18;
  for(let i=1; i<N; i++) for(let j=1; j<N; j++){
    const x = x0 + (x1 - x0) * i / N, y = y0 + (y1 - y0) * j / N;
    if(d3.geoContains(poly, [x, y])) pts.push({c:[x, y], d:dist(x * k, y)});
  }
  pts.sort((a,b)=>b.d - a.d);
  return pts.length ? pts : [{c:d3.geoCentroid(poly), d:0}];
}
function countryPoints(){
  if(countryPointsCache) return countryPointsCache;
  countryPointsCache = countries.map(f=>{
    const g = f.geometry; if(!g) return null;
    let part = g;
    if(g.type === "MultiPolygon"){ let best = -1; g.coordinates.forEach(c=>{ const p = {type:"Polygon", coordinates:c}, a = d3.geoArea(p); if(a > best){ best = a; part = p; } }); }
    const name = f.properties.name;
    // Candidate spots are worked out the first time the country needs a label (see labelSpots).
    return {type:"Feature", part, properties:{name, label:SHORT_NAMES[name] || name, rank:-Math.round(d3.geoArea(part) * 1e4)}, geometry:{type:"Point", coordinates:d3.geoCentroid(part)}};
  }).filter(Boolean);
  return countryPointsCache;
}
// Repaint the OpenFreeMap "liberty" style in black, white and grey, in English, without the clutter.
let countryLabelLayers = [];
const NAME_EN = ["coalesce", ["get","name:en"], ["get","name_en"], ["get","name:latin"], ["get","name"]];
const SW = {land:"#E6E6E6", water:"#FFFFFF", road:"#FFFFFF", casing:"#D2D2D2", building:"#D9D9D9", border:"#FFFFFF", ink:"#111111", muted:"#6E6E6E"};
function swissStyle(){
  const set = (id, k, v) => { try{ map.setPaintProperty(id, k, v); }catch(e){} };
  const hide = id => { try{ map.setLayoutProperty(id, "visibility", "none"); }catch(e){} };
  for(const l of map.getStyle().layers){
    const id = l.id, t = l.type;
    if(t === "background") set(id, "background-color", SW.land);
    else if(t === "raster" || t === "hillshade" || t === "fill-extrusion") hide(id);
    else if(t === "fill"){
      if(/water/.test(id)) set(id, "fill-color", SW.water);
      else if(/building/.test(id)) set(id, "fill-color", SW.building);
      else hide(id);                                   // parks, woods, landuse: keep the land plain
    }
    else if(t === "line"){
      if(/water|river|stream|canal/.test(id)) set(id, "line-color", SW.water);
      else if(/boundary|admin/.test(id)){ set(id, "line-color", SW.border); set(id, "line-dasharray", [1]); }
      else if(/casing/.test(id)) set(id, "line-color", SW.casing);
      else if(/rail|transit/.test(id)) set(id, "line-color", "#C4C4C4");
      else set(id, "line-color", SW.road);
    }
    else if(t === "symbol"){
      if(/poi|shield|aerodrome|airport|transit|station|housenumber|oneway/.test(id)){ hide(id); continue; }
      if(map.getLayoutProperty(id, "text-field")){
        map.setLayoutProperty(id, "text-field", ["coalesce", ["get","name:en"], ["get","name_en"], ["get","name:latin"], ["get","name"]]);
        const water = /water|ocean|sea|lake|marine/.test(id);
        if(/country/.test(id)){
          countryLabelLayers.push(id);
          map.setLayoutProperty(id, "text-transform", "uppercase");
          map.setLayoutProperty(id, "text-letter-spacing", 0.08);
          map.setLayoutProperty(id, "text-font", ["Noto Sans Bold"]);
          set(id, "text-color", SW.muted); set(id, "text-halo-color", SW.land); set(id, "text-halo-width", 1);
          continue;
        }
        set(id, "text-color", water ? "#9A9A9A" : /country|continent|state/.test(id) || /city|capital/.test(id) ? SW.ink : "#3A3A3A");
        set(id, "text-halo-color", water ? SW.water : SW.land);
        set(id, "text-halo-width", 1.2);
        if(map.getLayoutProperty(id, "icon-image")) set(id, "icon-opacity", 0);   // keep the name, drop the town dot
      }
    }
  }
}
// Shapes that cross the date line (Russia, Fiji) jump from +180 to -180 between two points, which
// the map would draw as a line right across the world. Keep each ring's longitudes continuous instead.
function unwrapRing(ring){
  const out = []; let prev = null, shift = 0;
  for(const [x, y] of ring){
    if(prev !== null){ const d = x - prev; if(d > 180) shift -= 360; else if(d < -180) shift += 360; }
    prev = x; out.push([x + shift, y]);
  }
  return out;
}
function unwrapFeature(f){
  const g = f.geometry; if(!g) return f;
  const poly = p => p.map(unwrapRing);
  const geometry = g.type === "Polygon" ? {type:"Polygon", coordinates:poly(g.coordinates)}
    : g.type === "MultiPolygon" ? {type:"MultiPolygon", coordinates:g.coordinates.map(poly)} : g;
  return {type:"Feature", properties:f.properties, geometry};
}
function drawBase(){ if(!map) initMap(); else map.resize(); }
$("#zin").onclick = ()=>map && map.zoomIn();
$("#zout").onclick = ()=>map && map.zoomOut();
$("#zfit").onclick = ()=>fitPins(true);

// Films whose pins would overlap on screen at this zoom share one pin with a count.
function groupFilms(list){
  const groups = [];
  const near = 26;   // pixels
  list.forEach(f=>{
    if(!isFinite(f.lat) || !isFinite(f.lon)) return;
    const p = map.project([f.lon, f.lat]);
    let g = groups.find(g=>Math.abs(g.px - p.x) < near && Math.abs(g.py - p.y) < near);
    if(!g){ g = {lat:f.lat, lon:f.lon, px:p.x, py:p.y, films:[]}; groups.push(g); }
    g.films.push(f);
  });
  groups.forEach(g=>{ g.ap = g.films.every(f=>f.ap); g.key = g.films.map(MM.filmKey).join("~"); });
  return groups;
}
const isSeries = f => MM.isTv(f.tmdb);
let kind = "all";   // logbook / map filter: all, film, series
function filtered(){
  const q = ($("#q").value||"").toLowerCase().trim();
  let list = viewing.films;
  if(kind !== "all") list = list.filter(f=>isSeries(f) === (kind === "series"));
  return q ? list.filter(f=>[f.t,f.p,f.c,f.d].join(" ").toLowerCase().includes(q)) : list;
}
document.querySelectorAll(".kinds button").forEach(b=>b.onclick = ()=>{
  kind = b.dataset.k;
  document.querySelectorAll(".kinds button").forEach(x=>x.setAttribute("aria-selected", String(x === b)));
  closeDetail(); renderList(); renderCountryList();
});
// Pin icons (white, drawn on the coloured badge).
const ICON = {
  film:'<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 5h2v2h2V5h8v2h2V5h2v14h-2v-2h-2v2H8v-2H6v2H4V5Zm2 4v2h2V9H6Zm10 0v2h2V9h-2ZM6 13v2h2v-2H6Zm10 0v2h2v-2h-2Z"/></svg>',
  series:'<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8.6 3.2 12 6.1l3.4-2.9 1.3 1.5L14.3 7H20a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h5.7L7.3 4.7l1.3-1.5ZM5 9v9h14V9H5Z"/></svg>'
};
function pinElement(d){
  const lone = d.films.length === 1;
  const el = document.createElement("button");
  el.type = "button";
  el.className = "gpin" + (d.ap ? " approx" : "") + (lone && isSeries(d.films[0]) ? " series" : "") + (!!selected && d.films.includes(selected) ? " sel" : "") + (lone ? "" : " many");
  el.setAttribute("aria-label", d.films.map(f=>f.t).join(", "));
  el.title = d.films.length > 1 ? `${d.films.length} titles` : d.films[0].t;
  el.innerHTML = `<span class="b">${lone ? ICON[isSeries(d.films[0]) ? "series" : "film"] : `<b>${d.films.length}</b>`}</span>`;
  el.addEventListener("click", ev=>{ ev.stopPropagation(); openGroup(d); });
  return el;
}
function renderPins(){
  if(!mapReady) return;
  markers.forEach(m=>m.remove()); markers = [];
  // Smaller pins when looking at the whole world, so country names show between them.
  map.getContainer().classList.toggle("far", map.getZoom() < 2.6);
  const groups = groupFilms(filtered());
  // Selected pin last, so it sits on top.
  groups.sort((a,b)=>(!!selected && a.films.includes(selected)) - (!!selected && b.films.includes(selected)));
  groups.forEach(g=>{
    const sel = !!selected && g.films.includes(selected);
    markers.push(new maplibregl.Marker({element:pinElement(g), anchor: sel ? "bottom" : "center"}).setLngLat([g.lon, g.lat]).addTo(map));
  });
  // Where each pin is, so names avoid them (sizes match the pins drawn on screen).
  const far = map.getZoom() < 2.6;
  if(map.getSource("mm-pins")) map.getSource("mm-pins").setData({type:"FeatureCollection", features:groups.map(g=>{
    const sel = !!selected && g.films.includes(selected), many = g.films.length > 1;
    const px = (sel ? 34 : far ? (many ? 22 : 18) : (many ? 28 : 24)) + 4, s = px / 32;
    return {type:"Feature", properties:{s, o:[0, sel ? -21 / s : 0]}, geometry:{type:"Point", coordinates:[g.lon, g.lat]}};
  })});
  const visited = [...new Set(viewing.films.map(f=>MM.geoName(f.c)))];
  if(map.getLayer("mm-visited")) map.setFilter("mm-visited", ["in", ["get","name"], ["literal", visited]]);
  // A name is only written where it fits inside its country at this zoom, like a printed map;
  // smaller countries get theirs as you zoom in.
  const z = map.getZoom(), pxPerDeg = 512 * Math.pow(2, z) / 360;
  const fs = Math.max(9, Math.min(13, 9 + (z - 1) * 4 / 3));
  const set = new Set(visited);
  // Try each country's spots, deepest first: the first where the name fits inside the land and
  // doesn't touch a pin wins. No spot, no name (it appears as you zoom in).
  const pinBoxes = groups.map(g=>{ const p = map.project([g.lon, g.lat]), r = (g.films.length > 1 ? 15 : 13) + 3; return [p.x - r, p.y - r, p.x + r, p.y + r]; });
  const placed = [];
  for(const p of (countryPointsCache || [])){
    const q = p.properties; if(!set.has(q.name)) continue;
    const textW = String(q.label).length * fs * 0.78 + 6, textH = fs * 1.3;
    for(const spot of labelSpots(p)){
      const lat = spot.c[1] * Math.PI / 180;
      if(z < 5 && (textW > spot.w * pxPerDeg * 0.92 || textH * 1.25 > spot.h * pxPerDeg / Math.cos(lat))) continue;
      const sp = map.project(spot.c), box = [sp.x - textW/2, sp.y - textH/2, sp.x + textW/2, sp.y + textH/2];
      if(pinBoxes.some(b=>!(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue;
      placed.push({type:"Feature", properties:q, geometry:{type:"Point", coordinates:spot.c}});
      break;
    }
  }
  if(map.getSource("mm-country-points")) map.getSource("mm-country-points").setData({type:"FeatureCollection", features:placed});
  if(map.getLayer("mm-visited-labels")) map.setFilter("mm-visited-labels", null);
  // The map's own name for a country with a film is left out entirely (not just hidden, which would
  // still take up room), so the white name has the space to itself.
  const named = [...new Set(visited.flatMap(n=>[n, MM.displayCountry(n), (countryPointsCache || []).find(p=>p.properties.name === n)?.properties.label].filter(Boolean)))];
  const onBlack = ["any", ["in", ["get","name:en"], ["literal", named]], ["in", ["get","name"], ["literal", named]]];
  countryLabelLayers.forEach(id=>map.setLayoutProperty(id, "text-field", ["case", onBlack, "", NAME_EN]));
  if(previewMarker){ previewMarker.remove(); previewMarker = null; }
  if(preview){
    const el = document.createElement("div"); el.className = "gpin sel preview"; el.innerHTML = `<span class="b">${ICON.film}</span>`;
    previewMarker = new maplibregl.Marker({element:el, anchor:"bottom"}).setLngLat([preview.lon, preview.lat]).addTo(map);
  }
}
function fitPins(animate){
  if(!mapReady) return;
  const pts = viewing.films.filter(f=>isFinite(f.lat) && isFinite(f.lon));
  if(!pts.length){ map.jumpTo(WORLD_VIEW); return; }
  const b = new maplibregl.LngLatBounds();
  pts.forEach(f=>b.extend([f.lon, f.lat]));
  const pad = Math.min(60, Math.max(24, map.getContainer().clientWidth / 14));
  map.fitBounds(b, {padding:{top:pad + 50, bottom:pad + 30, left:pad, right:pad}, maxZoom:6, duration: animate ? 700 : 0});
}
function flyTo(f){
  if(!mapReady || !isFinite(f.lat)) return;
  map.flyTo({center:[f.lon, f.lat], zoom:Math.max(map.getZoom(), 5), duration:900, essential:true});
}
function startPicking(cb){ picking = cb; $("#map").classList.add("picking"); $("#pickhint").hidden = false; if(window.innerWidth <= 860) $(".mapwrap").scrollIntoView({behavior:"smooth", block:"start"}); }

/* ================= film card ================= */
const detail = $("#detail");
function posterSlot(f, url){
  return `<div class="poster">${url ? `<img src="${esc(url)}" alt="Poster for ${esc(f.t)}">` : `<span class="ph">${esc(f.t)}</span>`}</div>`;
}
function openGroup(g){
  if(g.films.length === 1) return openFilm(g.films[0]);
  selected = null; detail.hidden = false;
  const label = g.films[0].p || g.films[0].c;
  detail.innerHTML = `<div class="stub" style="background:var(--moss)"><small>${g.films.length} films · one spot</small><h3>${esc(label)}</h3><button class="x" aria-label="Close">×</button></div>
    <div class="body"><ul class="multi">${g.films.map((f,i)=>`<li><button data-i="${i}"><b>${esc(f.t)}</b><span class="meta">${esc(f.y)}</span></button></li>`).join("")}</ul></div>`;
  detail.querySelector(".x").onclick = closeDetail;
  detail.querySelectorAll(".multi button").forEach(b=>b.onclick = ()=>openFilm(g.films[+b.dataset.i]));
}
// The film card appears in one go: poster, details and suggestions together (a moment later, rather
// than piece by piece). Opening another film meanwhile cancels this one.
let openToken = 0;
async function openFilm(f, fly){
  const token = ++openToken;
  selected = f;
  if(fly) flyTo(f);
  renderPins(); markListSelection();
  const ids = new Set(myFilms.map(x=>x.tmdb).filter(Boolean)), keys = myKeys();
  const timeout = (p, ms) => Promise.race([p, new Promise(r=>setTimeout(()=>r(null), ms))]);
  const [url, sim] = await Promise.all([
    f.poster ? MM.poster(f.poster) : timeout(MM.posterFor(f).catch(()=>null), 5000),
    timeout(MM.similarFrom(f, MM.isoFor(f.c), m=>ids.has(m.tmdb) || keys.has(MM.filmKey(m))).catch(()=>null), 8000)
  ]);
  if(token !== openToken || selected !== f) return;
  const mine = viewing.mine;
  const list = sim && sim.list || [];
  detail.innerHTML = `<div class="top">${posterSlot(f, url)}
    <div class="stub"><small>${esc(f.y)}${f.d ? " · " + esc(f.d) : ""}</small><h3>${esc(f.t)}</h3><button class="x" aria-label="Close">×</button></div></div>
    <div class="body">
      <div><div class="place">${esc(placeLine(f))}</div><div class="coord">${fmtCoord(f.lat, f.lon)}</div></div>
      ${f.n ? `<p class="note">${esc(f.n)}</p>` : ""}
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${f.r ? `<span class="stars">${stars(f.r)}</span>` : ""}${f.rv ? '<span class="tag">Reviewed</span>' : ""}${isSeries(f) ? '<span class="tag tv">Series</span>' : ""}${f.ap ? '<span class="tag ap">Approx. setting</span>' : ""}${f.watched ? `<span class="tag" style="color:var(--muted)">Watched ${esc(f.watched)}</span>` : ""}</div>
      ${mine ? `<div class="cta"><button class="btn ghost small" id="d-move">Move pin</button><button class="btn ghost small" id="d-del">Remove</button></div>` : ""}
      ${f.tmdb ? `<a class="linkbtn" href="${MM.tmdbPage(f.tmdb)}" target="_blank" rel="noopener">${MM.isTv(f.tmdb) ? "Series" : "Film"} page on TMDB ↗</a>` : ""}
      ${list.length ? `<div class="more"><div class="more-h"><b class="sub" style="font-size:15px">${esc(sim.heading)}</b><span class="hint">Scroll for more →</span></div>
        <ul>${list.map((m,i)=>`<li><button type="button" data-i="${i}" title="Log ${esc(m.t)}"><span class="th" style="background-image:url('${MM.poster(m.poster, "w185")}')"></span><span class="t">${esc(m.t)}</span><span class="y">${esc(m.y)}${MM.isTv(m.tmdb) ? " · Series" : ""}</span></button></li>`).join("")}</ul>
        <p class="hint" style="font-size:12px;margin:0">Tap one to add it to your map.</p></div>` : ""}
    </div>`;
  detail.hidden = false; detail.scrollTop = 0;
  detail.querySelector(".x").onclick = closeDetail;
  detail.querySelectorAll(".more button").forEach(b=>b.onclick = ()=>{ const m = list[+b.dataset.i]; pendingLog = {tmdb:m.tmdb, t:m.t, y:m.y}; location.hash = "#/log"; });
  if(mine){
    detail.querySelector("#d-move").onclick = ()=>{ toast("Tap the map where it takes place"); startPicking(async pt=>{
      const moved = pt.country && pt.country !== f.c;
      try{ await Store.update(f, {lat:pt.lat, lon:pt.lon, ap:0, src:"user", c: moved ? pt.country : f.c, p: moved ? pt.country : f.p}); toast("Pin moved"); }
      catch(e){ toast("Couldn't move the pin. Try again."); }
      openFilm(f); renderAll();
    }); };
    const del = detail.querySelector("#d-del");
    del.onclick = async ()=>{
      if(del.dataset.armed !== "1"){ del.dataset.armed = "1"; del.textContent = "Tap again to remove"; return; }
      try{ await Store.remove(f); myFilms = myFilms.filter(x=>x!==f); viewing.films = viewing.films.filter(x=>x!==f); closeDetail(); renderAll(); toast("Removed " + f.t); }
      catch(e){ toast("Couldn't remove it. Try again."); }
    };
  }
}
function closeDetail(){ openToken++; detail.hidden = true; selected = null; renderPins(); markListSelection(); }

/* ================= profile + logbook ================= */
function setOwnerHeader(){
  const o = viewing.owner || {};
  const name = o.display_name || o.name || o.username || "Your map";
  const av = $("#av"); av.textContent = (name||"?")[0]; av.style.background = MM.avatarColor(o.username || name);
  $("#uname").textContent = name;
  $("#ubio").textContent = [o.username ? "@" + o.username : "", o.bio].filter(Boolean).join(" · ");
  const ctry = new Set(viewing.films.map(f=>f.c).filter(Boolean));
  const cont = new Set(viewing.films.map(contOf).filter(Boolean));
  const nSeries = viewing.films.filter(isSeries).length;
  $("#s-films").textContent = viewing.films.length - nSeries;
  $("#s-series").textContent = nSeries;
  $("#s-ctry").textContent = ctry.size;
  $("#s-cont").textContent = cont.size;
  $("#whose-k").textContent = viewing.mine ? (me ? "Your map" : "Saved in this browser") : o.featured ? "Starter map" : "Member's map";
  $("#whose-h").textContent = viewing.mine ? (me ? (me.display_name || me.username) : "Your map") : name;
}
let listObserver = null;
function renderList(){
  const ul = $("#films");
  const list = filtered();
  listObserver && listObserver.disconnect();
  if(!list.length){
    ul.innerHTML = `<li class="empty">${viewing.films.length ? "No films match that filter." : viewing.mine ? 'No films yet. <a href="#/log">Log a film</a> or <a href="#/import">connect Letterboxd</a>.' : "No films logged yet."}</li>`;
    return;
  }
  ul.innerHTML = list.map((f,i)=>`<li><button data-i="${i}"><span class="bar ${f.ap?"ap":""} ${isSeries(f)?"tv":""}"></span><span class="th" data-i="${i}" data-t="${esc(f.t)}"></span><span style="min-width:0"><b>${esc(f.t)}</b><span class="meta">${esc(placeLine(f))}</span></span><span class="r">${stars(f.r)}<em>${esc(f.y)}</em></span></button></li>`).join("");
  ul.querySelectorAll("button").forEach(b=>b.onclick = ()=>openFilm(list[+b.dataset.i], true));
  listObserver = new IntersectionObserver(entries=>entries.forEach(async en=>{
    if(!en.isIntersecting) return;
    listObserver.unobserve(en.target);
    const f = list[+en.target.dataset.i]; if(!f) return;
    const url = f.poster ? MM.poster(f.poster, "w185") : await MM.posterFor(f);
    if(url){ en.target.style.backgroundImage = `url("${url}")`; en.target.classList.add("has"); }
  }), {rootMargin:"200px"});
  ul.querySelectorAll(".th").forEach(el=>listObserver.observe(el));
  markListSelection();
}
function markListSelection(){
  const list = filtered();
  $("#films").querySelectorAll("button[data-i]").forEach(b=>b.classList.toggle("sel", list[+b.dataset.i] === selected));
}
$("#q").addEventListener("input", ()=>{ renderPins(); renderList(); renderCountryList(); });

async function renderCTA(){
  const cta = $("#cta"), ov = $("#overlap");
  ov.hidden = true; cta.innerHTML = "";
  const o = viewing.owner || {};
  if(viewing.mine){
    cta.innerHTML = `<a class="btn" href="#/log">Log a film</a><a class="btn ghost" href="#/import">Letterboxd</a>${POSTERS ? `<a class="btn ghost" href="#/poster">Poster</a>` : ""}${cloud() ? `<button class="btn ghost" id="share">Share</button>` : ""}`;
    const sh = $("#share"); if(sh) sh.onclick = ()=>shareLink(profileURL(me.username), "My MovieMap");
    return;
  }
  if(o.featured && !cloud()){
    cta.innerHTML = sb ? `<a class="btn" href="#/account">Create your map</a><a class="btn ghost" href="#/explore">Find people</a>` : `<a class="btn" href="#/log">Start your map</a>`;
  }
  // Overlap with my map.
  if(myFilms.length && viewing.films.length){
    const mineC = new Set(myFilms.map(f=>f.c)); const shared = [...new Set(viewing.films.map(f=>f.c))].filter(c=>mineC.has(c));
    const mk = myKeys(); const both = viewing.films.filter(f=>mk.has(MM.filmKey(f))).map(f=>f.t);
    ov.hidden = false;
    ov.innerHTML = `You overlap in <b>${shared.length} ${shared.length===1?"country":"countries"}</b>${both.length ? ` and have both logged <b>${both.slice(0,6).map(esc).join(", ")}${both.length>6 ? ` and ${both.length-6} more` : ""}</b>` : ""}.`;
  }
  if(cloud() && o.id && o.id !== me.id){
    const {data} = await sb.from("follows").select("followee").eq("follower", me.id).eq("followee", o.id).maybeSingle();
    let following = !!data;
    const b = document.createElement("button"); b.className = "btn" + (following ? " ghost" : "");
    const paint = ()=>{ b.textContent = following ? "Following" : "Follow"; b.className = "btn" + (following ? " ghost" : ""); };
    paint();
    b.onclick = async ()=>{
      b.disabled = true;
      const res = following ? await sb.from("follows").delete().eq("follower", me.id).eq("followee", o.id) : await sb.from("follows").insert({follower:me.id, followee:o.id});
      b.disabled = false;
      if(res.error) return toast("That didn't go through. Try again.");
      following = !following; paint();
    };
    cta.prepend(b);
  }
  if(POSTERS && viewing.films.length){ const a = document.createElement("a"); a.className = "btn ghost"; a.href = "#/poster"; a.textContent = "Poster"; cta.append(a); }
  if(o.letterboxd){ const a = document.createElement("a"); a.className = "btn ghost"; a.href = "https://letterboxd.com/" + encodeURIComponent(o.letterboxd) + "/"; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Letterboxd ↗"; cta.append(a); }
}
function renderAll(){ setOwnerHeader(); renderPins(); renderList(); renderCTA(); renderCountryList(); }

function showMap(owner, films, mine){
  viewing = {owner, films, mine};
  selected = null; detail.hidden = true; $("#q").value = "";
  kind = "all"; document.querySelectorAll(".kinds button").forEach(x=>x.setAttribute("aria-selected", String(x.dataset.k === "all")));
  renderAll(); fitPins(true);
}
function showMine(){
  const owner = me ? Object.assign({}, me) : {name:"Your map", username:"", bio:"Saved in this browser"};
  showMap(owner, myFilms, true);
}

/* ================= countries: the list view and each country's page ================= */
// Every title is pinned where its story is set. A country's page then splits its titles into ones
// made there and ones made elsewhere (a Spanish film set in Vietnam shows in Vietnam, as not from
// Vietnam). "Made in" uses TMDB's origin and production countries, so co-productions count for each.
const regionName = (()=>{ try{ const dn = new Intl.DisplayNames(["en"], {type:"region"}); return c => { try{ return dn.of(c); }catch(e){ return c; } }; }catch(e){ return c => c; } })();
const geoOf = f => MM.geoName(f.c || "");
function countryGroups(list){
  const m = new Map();
  list.forEach(f=>{ const g = geoOf(f); if(!g) return; if(!m.has(g)) m.set(g, []); m.get(g).push(f); });
  return [...m.entries()].map(([geo, films])=>({geo, name:MM.displayCountry(geo), films}))
    .sort((a,b)=>b.films.length - a.films.length || a.name.localeCompare(b.name));
}
async function originsOf(films){
  await MM.pool(films.filter(f=>f.tmdb && !f.made), 6, async f=>{
    const d = await MM.filmDetails(f.tmdb).catch(()=>null);
    f.made = d ? [...new Set(d.iso || [])] : [];
  });
}
const madeLine = f => f.made && f.made.length ? "Made in " + f.made.slice(0, 2).map(regionName).join(" and ") + (f.made.length > 2 ? " and others" : "") : "Where it was made isn't on record";
function filmRows(list){
  return list.map((f,i)=>`<li><button type="button" data-i="${i}"><span class="th" ${f.poster ? `style="background-image:url('${MM.poster(f.poster,"w154")}')"` : ""}></span><span style="min-width:0"><b>${esc(f.t)}</b><span class="meta">${esc([f.p && f.p !== f.c ? f.p : "", f._away ? madeLine(f) : ""].filter(Boolean).join(" · "))}</span></span><span class="r"><em>${esc(f.y)}</em></span></button></li>`).join("");
}
async function openCountry(geo){
  const films = viewing.films.filter(f=>geoOf(f) === geo);
  if(!films.length) return;
  const name = MM.displayCountry(geo);
  showPanel("country"); closeDetail();
  const el = $("#country");
  const head = `<button type="button" class="back" id="cback">← ${viewing.mine ? "Your logbook" : "Logbook"}</button>
    <small class="k">Country</small><h2 class="h" style="margin-top:2px">${esc(name)}</h2>
    <p class="hint">${films.length} title${films.length===1?"":"s"} set here${viewing.owner && !viewing.mine ? " on this map" : ""}.</p>`;
  el.innerHTML = head + `<p class="hint busy">Checking where each one was made…</p>`;
  const bind = ()=>{ $("#cback").onclick = ()=>{ showPanel("map"); }; };
  bind();
  if(window.innerWidth <= 860) $("#view-country").scrollIntoView({behavior:"smooth", block:"start"});
  await originsOf(films);
  if($("#view-country").hidden) return;
  const iso = MM.isoFor(geo) || MM.isoFor(name);
  const home = films.filter(f=>iso && (f.made || []).includes(iso));
  const away = films.filter(f=>!home.includes(f)).map(f=>Object.assign(f, {_away:true}));
  home.forEach(f=>f._away = false);
  el.innerHTML = head + `
    <h3 class="csec">Made in ${esc(name)} <span>${home.length}</span></h3>
    ${home.length ? `<ul class="cfilms">${filmRows(home)}</ul>` : `<p class="hint">None yet: everything here was made somewhere else.</p>`}
    <h3 class="csec">Set in ${esc(name)}, made elsewhere <span>${away.length}</span></h3>
    ${away.length ? `<ul class="cfilms away">${filmRows(away)}</ul>` : `<p class="hint">None: every title set here was made here.</p>`}`;
  bind();
  el.querySelectorAll("ul.cfilms").forEach((ul, k)=>{ const list = k === 0 && home.length ? home : away; ul.querySelectorAll("button").forEach(b=>b.onclick = ()=>openFilm(list[+b.dataset.i], true)); });
}

// Map, List and Stats: three ways to look at the same titles.
let mapView = "map", listQuery = "";
function setView(v){
  mapView = v;
  document.querySelectorAll(".viewtog button").forEach(b=>b.setAttribute("aria-pressed", String(b.dataset.v === v)));
  $(".mapwrap").classList.toggle("listing", v !== "map");
  $("#clist").hidden = v === "map";
  if(v === "map"){ if(map) map.resize(); } else renderCountryList(true);
}
document.querySelectorAll(".viewtog button").forEach(b=>b.onclick = ()=>setView(b.dataset.v));
function renderCountryList(fresh){
  if(mapView === "list") return renderList2(fresh);
  if(mapView === "stats") return renderStats();
}

// The list view: countries A to Z, with a search box.
function renderList2(fresh){
  const el = $("#clist");
  if(fresh || !el.querySelector("#csearch")){
    el.innerHTML = `<div class="clist-in"><div class="clist-top"><p class="k" id="ccount"></p>
      <input id="csearch" type="search" placeholder="Find a country" aria-label="Find a country" autocomplete="off" value="${esc(listQuery)}"></div><div id="cgroups"></div></div>`;
    $("#csearch").oninput = e=>{ listQuery = e.target.value; renderList2(false); };
  }
  const all = countryGroups(filtered()).sort((a,b)=>a.name.localeCompare(b.name));
  const q = MM.norm(listQuery);
  const groups = q ? all.filter(g=>MM.norm(g.name).includes(q)) : all;
  const total = all.reduce((n,g)=>n + g.films.length, 0);
  $("#ccount").textContent = `${all.length} countr${all.length===1?"y":"ies"} · ${total} title${total===1?"":"s"}`;
  const box = $("#cgroups");
  box.innerHTML = groups.length ? groups.map((g,i)=>`<section>
      <button type="button" class="chead" data-g="${i}"><b>${esc(g.name)}</b><span>${g.films.length}</span></button>
      <ul class="cposters">${g.films.map((f,j)=>`<li><button type="button" data-g="${i}" data-f="${j}" title="${esc(f.t)}${f.y ? " (" + esc(f.y) + ")" : ""}"><span class="th"${f.poster ? ` style="background-image:url('${MM.poster(f.poster,"w154")}')"` : ""}>${f.poster ? "" : esc(f.t)}</span><span class="t">${esc(f.t)}</span></button></li>`).join("")}</ul>
    </section>`).join("") : `<p class="hint">${all.length ? "No country matches that." : "No titles yet."}</p>`;
  box.querySelectorAll(".chead").forEach(b=>b.onclick = ()=>openCountry(groups[+b.dataset.g].geo));
  box.querySelectorAll(".cposters button").forEach(b=>b.onclick = ()=>openFilm(groups[+b.dataset.g].films[+b.dataset.f], false));
}

// The stats view.
let statsToken = 0;
async function renderStats(){
  const el = $("#clist"), token = ++statsToken;
  const films = filtered(), n = films.length;
  if(!n){ el.innerHTML = `<div class="clist-in"><p class="hint">No titles yet.</p></div>`; return; }
  const pct = x => Math.round(x * 100 / n);
  const groups = countryGroups(films);
  const conts = new Map(); films.forEach(f=>{ const c = contOf(f); if(c) conts.set(c, (conts.get(c) || 0) + 1); });
  const decades = new Map(); films.forEach(f=>{ const y = +f.y; if(y) { const d = Math.floor(y / 10) * 10; decades.set(d, (decades.get(d) || 0) + 1); } });
  const places = new Map(); films.forEach(f=>{ if(f.p && f.p !== f.c && !f.ap){ places.set(f.p, (places.get(f.p) || 0) + 1); } });
  const topPlace = [...places.entries()].sort((a,b)=>b[1] - a[1])[0];
  const rated = groups.map(g=>({name:g.name, geo:g.geo, rs:g.films.map(f=>+f.r).filter(Boolean)})).filter(g=>g.rs.length >= 2)
    .map(g=>({...g, avg:g.rs.reduce((a,b)=>a + b, 0) / g.rs.length})).sort((a,b)=>b.avg - a.avg).slice(0, 5);
  const bars = (rows, max) => `<ul class="bars">${rows.map(r=>`<li${r.geo ? ` data-geo="${esc(r.geo)}"` : ""}><span class="bl">${esc(r.label)}</span><span class="bt"><i style="width:${Math.max(2, r.v * 100 / max)}%"></i></span><span class="bv">${esc(r.text)}</span></li>`).join("")}</ul>`;
  const top = groups.slice(0, 10), rest = groups.slice(10).reduce((s,g)=>s + g.films.length, 0);
  const ctryRows = top.map(g=>({label:g.name, geo:g.geo, v:g.films.length, text:pct(g.films.length) + "%"}));
  if(rest) ctryRows.push({label:`${groups.length - 10} other countries`, v:rest, text:pct(rest) + "%"});
  const contRows = [...conts.entries()].sort((a,b)=>b[1] - a[1]).map(([c,v])=>({label:c, v, text:pct(v) + "%"}));
  const decRows = [...decades.entries()].sort((a,b)=>a[0] - b[0]).map(([d,v])=>({label:d + "s", v, text:String(v)}));
  el.innerHTML = `<div class="clist-in stats">
    <div class="bignums">
      <div><b>${groups.length}</b><span>countries, ${Math.round(groups.length * 100 / 195)}% of the world</span></div>
      <div><b>${conts.size}</b><span>continent${conts.size===1?"":"s"}</span></div>
      <div><b id="st-home">–</b><span>made in the country they're set in</span></div>
      <div><b>${topPlace ? esc(topPlace[0]) : "–"}</b><span>${topPlace ? `most-visited place, ${topPlace[1]} title${topPlace[1]===1?"":"s"}` : "most-visited place"}</span></div>
    </div>
    <h3 class="csec">Where your titles are set <span>% of ${n}</span></h3>${bars(ctryRows, top[0].films.length)}
    ${contRows.length ? `<h3 class="csec">By continent</h3>${bars(contRows, contRows[0].v)}` : ""}
    ${decRows.length ? `<h3 class="csec">By decade of release</h3>${bars(decRows, Math.max(...decRows.map(r=>r.v)))}` : ""}
    ${rated.length ? `<h3 class="csec">Best-rated countries <span>2+ rated titles</span></h3>${bars(rated.map(r=>({label:r.name, geo:r.geo, v:r.avg, text:"★ " + r.avg.toFixed(1)})), 5)}` : ""}
    <h3 class="csec">Where they were made <span id="st-madeh"></span></h3><div id="st-made"><p class="hint busy">Checking where each title was made…</p></div>
  </div>`;
  el.querySelectorAll(".bars li[data-geo]").forEach(li=>{ li.tabIndex = 0; li.onclick = ()=>openCountry(li.dataset.geo); li.onkeydown = e=>{ if(e.key === "Enter") openCountry(li.dataset.geo); }; });
  // Made at home vs. abroad needs each title's origin (cached after the first look).
  await originsOf(films);
  if(token !== statsToken || mapView !== "stats") return;
  const known = films.filter(f=>f.made && f.made.length);
  const home = known.filter(f=>{ const iso = MM.isoFor(geoOf(f)) || MM.isoFor(f.c); return iso && f.made.includes(iso); });
  $("#st-home").textContent = known.length ? Math.round(home.length * 100 / known.length) + "%" : "–";
  const makers = new Map(); known.forEach(f=>{ const c = f.made[0]; makers.set(c, (makers.get(c) || 0) + 1); });
  const mk = [...makers.entries()].sort((a,b)=>b[1] - a[1]).slice(0, 8);
  $("#st-madeh").textContent = `main country of origin, % of ${known.length}`;
  $("#st-made").innerHTML = mk.length ? bars(mk.map(([c,v])=>({label:regionName(c), v, text:Math.round(v * 100 / known.length) + "%"})), mk[0][1]) : `<p class="hint">Not on record.</p>`;
}

/* ================= rail views ================= */
function showPanel(id){
  ["map","explore","log","import","account","poster","country"].forEach(v=>$("#view-"+v).hidden = v !== id);
}
function setNav(name){ document.querySelectorAll(".nav a, .acct").forEach(a=>a.setAttribute("aria-current", a.dataset.nav === name ? "page" : "false")); }
function paintAccountLink(){ $("#acct-link").textContent = me ? "@" + me.username : (sb ? "Sign in" : "Account"); }

/* ---------- log a film: search TMDB, pick the right one, we find the setting ---------- */
let draft = null, draftRating = null, searchT = null, searchSeq = 0;
function renderLog(){
  showMine_keepView();
  const el = $("#log");
  el.innerHTML = `<h2 class="h">Log a film or series</h2>
    <div class="search"><label for="lq" class="sr">Film title</label><input id="lq" type="search" autocomplete="off" placeholder="Search a film or series, e.g. Belén"></div>
    <p class="hint" id="ls">Start typing and pick the right film. We'll work out where it takes place.</p>
    <ul class="results" id="lr"></ul>
    <div id="lc" hidden></div>
    ${!cloud() ? `<p class="notice">${sb ? 'You\'re not signed in, so films save in this browser only. <a href="#/account">Sign in</a> to keep them on your account.' : "Films save in this browser."}</p>` : ""}`;
  const q = $("#lq");
  q.addEventListener("input", ()=>{ clearTimeout(searchT); searchT = setTimeout(()=>runSearch(q.value.trim()), 280); });
  q.focus({preventScroll:true});
  if(pendingLog){ const p = pendingLog; pendingLog = null; q.value = p.t; chooseFilm({tmdb:p.tmdb, t:p.t, y:p.y}); }
}
async function runSearch(text){
  const seq = ++searchSeq, st = $("#ls"), ul = $("#lr");
  if(!st) return;
  $("#lc").hidden = true;
  if(text.length < 2){ ul.innerHTML = ""; st.textContent = "Start typing and pick the right film."; st.classList.remove("busy"); return; }
  st.textContent = "Searching…"; st.classList.add("busy");
  try{
    const res = await MM.searchFilms(text);
    if(seq !== searchSeq) return;
    st.classList.remove("busy");
    if(!res.length){ ul.innerHTML = ""; st.textContent = `No films found for "${text}". Check the spelling.`; return; }
    st.textContent = "Pick the one you watched.";
    const mk = myKeys();
    ul.innerHTML = res.map((m,i)=>`<li><button data-i="${i}"><span class="th" ${m.poster ? `style="background-image:url('${MM.poster(m.poster,"w92")}')"` : ""}></span><span style="min-width:0"><b>${esc(m.t)} <span class="m">${esc(m.y)}</span></b><span class="m">${m.tv ? "Series" : ""}${m.tv && m.ot && m.ot!==m.t ? " · " : ""}${m.ot && m.ot!==m.t ? esc(m.ot) : ""}</span>${mk.has(MM.filmKey(m)) ? '<br><span class="have">On your map</span>' : ""}</span></button></li>`).join("");
    ul.querySelectorAll("button").forEach(b=>b.onclick = ()=>chooseFilm(res[+b.dataset.i]));
  }catch(e){
    if(seq !== searchSeq) return;
    st.classList.remove("busy");
    st.textContent = e.message === "tmdb-auth" ? "The film database key isn't working. The site owner needs to update it." : "Search didn't go through. Check your connection and try again.";
  }
}
async function chooseFilm(m){
  const st = $("#ls"); $("#lr").innerHTML = "";
  st.textContent = `Finding where ${m.t} takes place…`; st.classList.add("busy");
  try{
    const det = (m.tmdb ? await MM.filmDetails(m.tmdb).catch(()=>null) : null) || (m.t ? await MM.matchFilm(m.t, m.y).then(x=>x ? MM.filmDetails(x.id) : null).catch(()=>null) : null);
    if(!det){
      // Not in the film database: still let the person pin it by hand.
      st.classList.remove("busy");
      draft = {t:m.t, y:m.y||"", d:"", tmdb:null, poster:null, p:"", c:"", lat:NaN, lon:NaN, ap:0, n:"", src:"user", watched:new Date().toISOString().slice(0,10)};
      draftRating = null;
      st.textContent = "We couldn't find this one in the film database. Tap Place pin on the map, then tap where it takes place.";
      return renderConfirm();
    }
    const [s] = await MM.resolveSettings([det], null, [m.t]);
    st.classList.remove("busy");
    draft = Object.assign({t:det.t, y:det.y, d:det.d, tmdb:det.tmdb, poster:det.poster}, s || {p:"", c:"", lat:NaN, lon:NaN, ap:1, n:"", src:""});
    draft.watched = new Date().toISOString().slice(0,10);
    draftRating = null;
    st.textContent = s ? "Check the setting, rate it, then pin it." : "We couldn't find where this one is set. Tap Place pin on the map, then tap where it takes place.";
    renderConfirm();
    if(isFinite(draft.lat)){ preview = {lat:draft.lat, lon:draft.lon}; renderPins(); flyTo(draft); }
  }catch(e){
    st.classList.remove("busy"); st.textContent = "Couldn't load that film. Try again.";
  }
}
function renderConfirm(){
  const f = draft, el = $("#lc"); el.hidden = false;
  const placed = isFinite(f.lat);
  const have = myKeys().has(MM.filmKey(f));
  el.innerHTML = `<div class="box" style="background:var(--card)">
    <div style="display:grid;grid-template-columns:72px minmax(0,1fr);gap:12px;align-items:start">
      <div class="poster" style="width:72px">${f.poster ? `<img src="${MM.poster(f.poster,"w185")}" alt="">` : `<span class="ph">${esc(f.t)}</span>`}</div>
      <div style="min-width:0"><b class="sub" style="display:block;font-size:22px;line-height:1.05">${esc(f.t)}</b><span class="hint">${esc(f.y)}${f.d ? " · " + esc(f.d) : ""}</span></div>
    </div>
    ${placed ? `<div><b>${esc(placeLine(f))}</b><div class="hint" style="font-family:var(--f-mono);font-size:12px">${fmtCoord(f.lat,f.lon)}${f.ap ? " · approximate" : ""}</div></div>` : ""}
    ${f.n ? `<p class="hint">${esc(f.n)}</p>` : ""}
    <button type="button" class="linkbtn" id="c-move">${placed ? "Pin in the wrong place? Move it" : "Place pin on the map"}</button>
    <div><div class="field" style="margin-bottom:2px">Your rating</div><div class="rate" id="c-rate"></div></div>
    <label class="field" for="c-date">Watched on<input type="date" id="c-date" value="${esc(f.watched)}"></label>
    ${have ? '<p class="ok">This film is already on your map.</p>' : ""}
    <div class="cta"><button class="btn" id="c-pin" ${placed && !have ? "" : "disabled"}>Pin it</button><button class="btn ghost" id="c-back">Back</button></div>
  </div>`;
  renderRate();
  $("#c-move").onclick = ()=>startPicking(pt=>{
    // A pin moved into a different country takes that country's name; within the same country the place name stays.
    if(pt.country && pt.country !== draft.c){ draft.c = pt.country; draft.p = pt.country; draft.n = ""; }
    Object.assign(draft, {lat:pt.lat, lon:pt.lon, ap:0, src:"user"});
    preview = {lat:pt.lat, lon:pt.lon}; renderConfirm(); renderPins();
  });
  $("#c-back").onclick = ()=>{ draft = null; preview = null; el.hidden = true; renderPins(); $("#lq").focus(); };
  $("#c-date").onchange = e=>draft.watched = e.target.value;
  $("#c-pin").onclick = async ()=>{
    const f = Object.assign({}, draft); if(draftRating) f.r = draftRating;
    $("#c-pin").disabled = true;
    try{
      await Store.add([f]); await reloadMine();
      draft = null; preview = null; toast("Pinned " + f.t);
      location.hash = "#/";
      setTimeout(()=>{ const g = myFilms.find(x=>MM.filmKey(x)===MM.filmKey(f)); if(g) openFilm(g, true); }, 700);
    }catch(e){ $("#c-pin").disabled = false; toast(e.message && e.message.includes("storage") ? e.message : "Couldn't save it. Try again."); }
  };
}
function renderRate(){
  const el = $("#c-rate"); if(!el) return;
  el.innerHTML = [1,2,3,4,5].map(n=>{ const half = draftRating === n-0.5, on = draftRating != null && draftRating >= n;
    return `<button type="button" data-n="${n}" class="${half ? "half" : on ? "on" : ""}" aria-label="${n} stars" title="Tap a star twice for a half star">★</button>`; }).join("")
    + `<button type="button" class="clear" data-n="0">${draftRating == null ? "No rating" : stars(draftRating) + " · clear"}</button>`;
  el.querySelectorAll("button").forEach(b=>b.onclick = ()=>{ const n = +b.dataset.n; draftRating = !n ? null : draftRating === n ? n - 0.5 : n; renderRate(); });
}
function showMine_keepView(){ if(!viewing.mine) showMine(); }

/* ---------- Letterboxd: username feed ---------- */
const LB_SYNC_EVERY = 6*60*60*1000;   // check the feed at most every 6 hours per browser
const lbSyncKey = () => "mm-lb-sync:" + (me ? me.id : "");
const lbReportKey = () => "mm-lb-report:" + (me ? me.id : "");
let pendingLog = null;   // a skipped Letterboxd film waiting to be pinned by hand

// Turn Letterboxd feed entries ({t, y, r, watched, tmdb}) into map-ready films.
async function placeEntries(entries, progress){
  let done = 0;
  const dets = await MM.pool(entries, 6, async e=>{
    let d = null;
    if(e.tmdb) d = await MM.filmDetails(e.tmdb);
    if(!d){ const m = await MM.matchFilm(e.t, e.y); d = m ? await MM.filmDetails(m.id) : null; }
    done++; progress && progress(done, entries.length);
    return d;
  });
  const found = dets.filter(Boolean);
  const settings = await MM.resolveSettings(found, null, entries.filter((e,i)=>dets[i]).map(e=>e.t));
  const setBy = new Map(found.map((d,i)=>[d.tmdb, settings[i]]));
  const ready = [], unmatched = [], unplaced = [];
  entries.forEach((e,i)=>{
    const d = dets[i];
    if(!d){ unmatched.push(e); return; }
    const s = setBy.get(d.tmdb);
    if(!s){ unplaced.push(Object.assign({}, e, {tmdb:d.tmdb, poster:d.poster})); return; }
    ready.push(Object.assign({t:e.t, y:e.y || d.y, d:d.d, tmdb:d.tmdb, poster:d.poster, r:e.r || null, rv:e.rv ? 1 : 0, watched:/^\d{4}-\d{2}-\d{2}$/.test(e.watched||"") ? e.watched : "", lbs:e.slug || ""}, s));
  });
  return {ready, unmatched, unplaced};
}

// Talk to the server function that reads Letterboxd for us.
async function lbInvoke(body){
  const {data, error} = await sb.functions.invoke("letterboxd-feed", {body});
  if(error){
    let code = "";
    const status = error.context && error.context.status;
    try{ code = (await error.context.json()).error; }catch(e){}
    // No "error" field from our function plus a 404 means the function itself isn't deployed.
    throw new Error(code || (status === 404 || error.name === "FunctionsFetchError" ? "not_deployed" : "failed"));
  }
  return data || {};
}
// Recent diary entries: exact TMDB ids and watch dates.
async function fetchLetterboxdFeed(username){
  const d = await lbInvoke({username});
  return (d.films || []).map(f=>({t:f.title, y:f.year || "", r:f.rating || null, watched:f.watched || "", tmdb:f.tmdb, slug:f.slug || undefined}));
}
// Every film on the member's Films page (all pages), including ones never logged in the diary.
// all.complete is true only when every page was read, which is what removals rely on.
async function fetchLetterboxdFilms(username, maxPages, onPage){
  const all = [];
  all.complete = false;
  for(let page=1; page<=maxPages; page++){
    let d;
    // Letterboxd only lets us read the first page; a refused later page just means the list is partial.
    try{ d = await lbInvoke({username, mode:"films", page}); }catch(e){ if(page === 1) throw e; break; }
    if(d.films && d.films.length && d.films[0].slug === undefined) throw new Error("old_function");   // the deployed function predates list support
    all.push(...(d.films || []).map(f=>({t:f.title, y:f.year || "", r:f.rating || null, slug:f.slug})));
    onPage && onPage(page, all.length);
    if(!d.more){ all.complete = true; break; }
  }
  return all;
}
// Fill in year + TMDB id from each film's Letterboxd page when the grid didn't show a year.
async function fillFromFilmPages(entries, onStep){
  const need = entries.filter(e=>!e.y && !e.tmdb && e.slug);
  for(let i=0; i<need.length; i+=20){
    const d = await lbInvoke({mode:"film", slugs:need.slice(i, i+20).map(e=>e.slug)}).catch(()=>({}));
    (d.films || []).forEach(x=>{ const e = need.find(n=>n.slug === x.slug); if(e){ if(x.year) e.y = x.year; if(x.tmdb) e.tmdb = x.tmdb; } });
    onStep && onStep(Math.min(i+20, need.length), need.length);
  }
}
const LB_ERRORS = {
  not_found:"Letterboxd has no public profile with that username. Check the spelling, and make sure the profile isn't private.",
  bad_username:"That isn't a valid Letterboxd username.",
  not_deployed:"Letterboxd sync isn't switched on for this site yet.",
  old_function:"The Letterboxd sync on the server is out of date, so only your diary came through. The site owner needs to redeploy the letterboxd-feed function.",
  upstream:"Letterboxd didn't answer just now. Try again in a few minutes.",
  unreachable:"Letterboxd didn't answer just now. Try again in a few minutes."
};

// Pull films into the signed-in member's map.
// full: read every page of the member's films (Connect, Sync now). Otherwise: the diary feed plus the first page.
let syncing = false;
async function syncLetterboxd({quiet=false, full=false, progress=null} = {}){
  if(syncing || !cloud() || !me.letterboxd) return null;
  syncing = true;
  const say = s => progress && progress(s);
  try{
    say("Reading your Letterboxd diary…");
    const feed = await fetchLetterboxdFeed(me.letterboxd);
    let list = [];
    try{
      list = await fetchLetterboxdFilms(me.letterboxd, full ? 200 : 1, (pg, n)=>say(`Reading your Letterboxd films… page ${pg} (${n} films)`));
    }catch(e){ if(full) throw e; }
    // Merge: diary entries win (exact TMDB id and watch date); the films list adds everything else.
    const merged = new Map();
    feed.forEach(e=>{ const k = MM.filmKey(e); if(!merged.has(k)) merged.set(k, e); });
    list.forEach(e=>{
      const k = e.y ? MM.filmKey(e) : "slug:" + e.slug;   // no year yet: keep apart until its film page fills it in
      if(merged.has(k)){ const m = merged.get(k); if(e.r != null) m.r = e.r; m.slug = m.slug || e.slug; }
      else merged.set(k, e);
    });
    const all = [...merged.values()];
    const have = myKeys(), haveIds = new Set(myFilms.map(f=>f.tmdb).filter(Boolean));
    let todo = all.filter(e=>!(e.tmdb && haveIds.has(e.tmdb)) && !have.has(MM.filmKey(e)));
    await fillFromFilmPages(todo, (d,n)=>say(`Looking up ${n} film${n===1?"":"s"} without a year… ${d}/${n}`));
    const once = new Set();
    todo = todo.filter(e=>{
      const k = e.tmdb ? "t" + e.tmdb : MM.filmKey(e);
      if(once.has(k) || once.has(MM.filmKey(e))) return false;
      once.add(k); once.add(MM.filmKey(e));
      return !(e.tmdb && haveIds.has(e.tmdb)) && !have.has(MM.filmKey(e));
    });
    let added = 0, missed = [];
    if(todo.length){
      say(`Matching ${todo.length} new film${todo.length===1?"":"s"}…`);
      const {ready, unmatched, unplaced} = await placeEntries(todo, (d,n)=>say(d<n ? `Matching ${n} new films… ${d}/${n}` : "Finding where each film takes place…"));
      say("Saving to your map…");
      added = (await Store.add(ready)).added;
      await reloadMine();
      missed = [...unmatched, ...unplaced];
    }
    // Keep earlier skipped films that are still missing, so the list survives later syncs.
    const prev = (MM.lsGet(lbReportKey(), null) || {missed:[]});
    const nowIds = new Set(myFilms.map(f=>f.tmdb).filter(Boolean)), nowKeys = myKeys();
    const byId = new Map();
    [...prev.missed, ...missed].forEach(m=>{ if(!(m.tmdb && nowIds.has(m.tmdb)) && !nowKeys.has(MM.filmKey(m))) byId.set(m.tmdb || MM.filmKey(m), {t:m.t, y:m.y, tmdb:m.tmdb||null, poster:m.poster||null}); });
    MM.lsSet(lbReportKey(), {total: full ? all.length : Math.max(prev.total||0, all.length), full: full || !!prev.full, missed:[...byId.values()]});
    MM.lsSet(lbSyncKey(), Date.now());
    // With the complete films list in hand: copy rating changes over and drop films removed from Letterboxd.
    let changes = {rated:0, removed:0, held:0};
    // Ratings follow Letterboxd for every film we could read; removals only after a complete read.
    // (The films list shows current ratings and wins; the diary feed fills in films beyond the first page,
    // newest entry last so it wins over older rewatches.)
    if(list.length || feed.length) changes = await reconcileLetterboxd([...feed.filter(e=>e.slug && e.r != null).reverse(), ...list], full && list.complete);
    if((added || changes.rated || changes.removed) && viewing.mine){ viewing.films = myFilms; renderAll(); if(added || changes.removed) fitPins(true); }
    if(changes.removed || changes.rated) toast([changes.removed ? `Removed ${changes.removed} film${changes.removed===1?"":"s"} you took off Letterboxd` : "", changes.rated ? `updated ${changes.rated} rating${changes.rated===1?"":"s"}` : ""].filter(Boolean).join(", ").replace(/^u/, "U"));
    if(changes.held) toast(`${changes.held} films are missing from your Letterboxd list, which looks like a reading problem, so none were removed`);
    if(byId.size && (added || !quiet)) toast(`${added ? `Added ${added} from Letterboxd. ` : ""}${byId.size} need${byId.size===1?"s":""} a pin: see the Letterboxd tab`);
    else if(added) toast(`Added ${added} film${added===1?"":"s"} from Letterboxd`);
    else if(!quiet) toast("You're up to date with Letterboxd");
    return {added, total:all.length, rated:changes.rated, removed:changes.removed};
  }catch(e){
    if(!quiet) toast(LB_ERRORS[e.message] || "Sync didn't go through. Try again.");
    return {error:e.message};
  }finally{ syncing = false; }
}
// Keep the map in step with Letterboxd, given the complete list of films on the member's profile.
// Each pin remembers which Letterboxd film it came from (its slug). Pins made before that was recorded
// are linked up by title and year the first time. Films added by hand that aren't on Letterboxd are
// never touched. If an unusually large share would disappear at once, nothing is removed, since that's
// more likely a reading problem than a real clear-out.
const lbSlugify = t => String(t||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, "").replace(/['’.]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
async function reconcileLetterboxd(list, complete){
  const bySlug = new Map(list.map(e=>[e.slug, e]));
  const byKey = new Map(list.filter(e=>e.y).map(e=>[MM.filmKey(e), e]));
  const out = {rated:0, removed:0, held:0};
  // 1. link older pins to their Letterboxd film
  const claimed = new Set(myFilms.filter(f=>f.lbs).map(f=>f.lbs));
  for(const f of myFilms){
    if(f.lbs || !f.id) continue;
    const e = byKey.get(MM.filmKey(f)) || bySlug.get(lbSlugify(f.t) + (f.y ? "-" + f.y : "")) || bySlug.get(lbSlugify(f.t));
    if(!e || claimed.has(e.slug)) continue;
    const {error} = await sb.from("logs").update({lb_slug:e.slug}).eq("id", f.id);
    if(!error){ f.lbs = e.slug; claimed.add(e.slug); }
  }
  // 2. ratings follow Letterboxd (including a rating being cleared)
  for(const f of myFilms){
    const e = f.lbs && bySlug.get(f.lbs); if(!e || !f.id) continue;
    const want = e.r != null ? +e.r : null, have = f.r != null ? +f.r : null;
    if(want === have) continue;
    const {error} = await sb.from("logs").update({rating:want}).eq("id", f.id);
    if(!error){ f.r = want; out.rated++; }
  }
  // 3. films no longer on Letterboxd come off the map (only when we've seen the whole list)
  if(!complete) return out;
  const linked = myFilms.filter(f=>f.lbs && f.id), gone = linked.filter(f=>!bySlug.has(f.lbs));
  if(gone.length > Math.max(5, linked.length * 0.3)){ out.held = gone.length; return out; }
  for(let i=0; i<gone.length; i+=100){
    const part = gone.slice(i, i+100);
    const {error} = await sb.from("logs").delete().in("id", part.map(f=>f.id));
    if(!error){ const ids = new Set(part.map(f=>f.id)); myFilms = myFilms.filter(f=>!ids.has(f.id)); out.removed += part.length; }
  }
  if(out.removed && viewing.mine) viewing.films = myFilms;
  return out;
}

// Re-check pins that were only country guesses (or have a hand-checked setting now). Pins you moved yourself are left alone.
const FIX_VERSION = "mm-fix-v4:";
async function refreshSettings(force){
  if(!cloud()) return;
  const flag = FIX_VERSION + me.id;
  if(!force && MM.lsGet(flag, false)) return;
  const cands = myFilms.filter(f=>f.tmdb && f.src !== "user" && f.src !== "curated");
  if(!cands.length){ MM.lsSet(flag, true); return; }
  const dets = await MM.pool(cands, 6, f=>MM.filmDetails(f.tmdb));
  const pairs = cands.map((f,i)=>[f, dets[i]]).filter(([f,d])=>d);
  // Recorded (Wikidata) settings stay unless a hand-checked one exists; country guesses get recomputed.
  const settings = await MM.resolveSettings(pairs.map(([,d])=>d), null, pairs.map(([f])=>f.t));
  let changed = 0;
  for(let i=0; i<pairs.length; i++){
    const [f] = pairs[i], s = settings[i];
    if(!s) continue;
    if(f.src === "wikidata" && s.src !== "curated") continue;
    if(Math.abs(s.lat - f.lat) < 0.01 && Math.abs(s.lon - f.lon) < 0.01) continue;
    try{ await Store.update(f, {p:s.p, c:s.c, cont:s.cont||"", lat:s.lat, lon:s.lon, ap:s.ap, n:s.n||"", src:s.src}); changed++; }catch(e){}
  }
  // Keep re-checking on later visits until the AI step is available, so guesses get upgraded once it's switched on.
  MM.lsSet(flag, true);
  if(changed && viewing.mine){ renderAll(); fitPins(true); toast(`Moved ${changed} pin${changed===1?"":"s"} to a better spot`); }
}
function maybeAutoSync(){
  if(!cloud()) return;
  refreshSettings(false);
  if(!me.letterboxd) return;
  const last = MM.lsGet(lbSyncKey(), 0);
  const rep = MM.lsGet(lbReportKey(), null);
  // Quick check (diary + newest page) every 6 hours; a full re-read of the whole list once a week.
  const lastFull = MM.lsGet(lbSyncKey() + ":full", 0);
  const full = !(rep && rep.full) || Date.now() - lastFull > 7*24*60*60*1000;
  if(full || Date.now() - last > LB_SYNC_EVERY) syncLetterboxd({quiet:true, full}).then(r=>{ if(full && r && !r.error) MM.lsSet(lbSyncKey() + ":full", Date.now()); });
}

/* ---------- Letterboxd export import (the full history) ---------- */
// Letterboxd's export is a zip of CSV files. watched.csv lists every film, ratings.csv the current
// ratings, diary.csv the watch dates. Any of them (or the zip) can be chosen.
function parseCSV(text){
  const rows = []; let row = [], cell = "", q = false;
  for(let i=0; i<text.length; i++){
    const ch = text[i];
    if(q){ if(ch === '"'){ if(text[i+1] === '"'){ cell += '"'; i++; } else q = false; } else cell += ch; }
    else if(ch === '"') q = true;
    else if(ch === ","){ row.push(cell); cell = ""; }
    else if(ch === "\n" || ch === "\r"){ if(ch === "\r" && text[i+1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if(cell || row.length){ row.push(cell); rows.push(row); }
  const head = (rows.shift() || []).map(h=>h.trim());
  return rows.filter(r=>r.some(Boolean)).map(r=>Object.fromEntries(head.map((h,i)=>[h, (r[i] || "").trim()])));
}
let jszipLoading = null;
function loadJSZip(){
  if(window.JSZip) return Promise.resolve(window.JSZip);
  return jszipLoading ||= new Promise((ok, no)=>{ const sc = document.createElement("script"); sc.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"; sc.onload = ()=>ok(window.JSZip); sc.onerror = no; document.head.append(sc); });
}
async function readExport(files){
  const csv = {};   // watched / ratings / diary → rows
  for(const f of files){
    if(/\.zip$/i.test(f.name)){
      const Z = await loadJSZip(), z = await Z.loadAsync(f);
      for(const name of Object.keys(z.files)){
        const m = name.match(/(?:^|\/)(watched|ratings|diary)\.csv$/i);
        if(m) csv[m[1].toLowerCase()] = parseCSV(await z.files[name].async("string"));
      }
    } else {
      const m = f.name.match(/(watched|ratings|diary)[^/]*\.csv$/i);
      if(m) csv[m[1].toLowerCase()] = parseCSV(await f.text());
    }
  }
  const films = new Map();
  const add = r => { const t = r.Name, y = +r.Year || ""; if(!t) return null; const k = MM.filmKey({t, y}); if(!films.has(k)) films.set(k, {t, y, r:null, watched:""}); return films.get(k); };
  (csv.watched || []).forEach(add);
  (csv.diary || []).forEach(r=>{ const e = add(r); if(!e) return; const w = r["Watched Date"] || r.Date; if(w > e.watched) e.watched = w; if(e.r == null && +r.Rating) e.r = +r.Rating; });
  (csv.ratings || []).forEach(r=>{ const e = add(r); if(e && +r.Rating) e.r = +r.Rating; });   // current ratings win
  return {films:[...films.values()], found:Object.keys(csv)};
}
let importing = false;
async function importLetterboxdExport(files, status, button){
  if(importing) return;
  importing = true; if(button) button.setAttribute("aria-disabled", "true");
  const say = t => { if(status) status.textContent = t; };
  try{
    say("Reading your export…");
    const {films, found} = await readExport(files);
    if(!found.length){ say("That file doesn't look like a Letterboxd export. Choose the zip you downloaded from Letterboxd, or watched.csv from inside it."); return; }
    const have = myKeys();
    // Films already on the map: bring their ratings up to date with the export.
    const byKey = new Map(myFilms.map(f=>[MM.filmKey(f), f]));
    let rerated = 0;
    for(const e of films){
      const f = byKey.get(MM.filmKey(e)); if(!f || e.r == null || +f.r === +e.r) continue;
      try{ await Store.update(f, {r:e.r}); rerated++; }catch(err){}
    }
    const todo = films.filter(e=>!have.has(MM.filmKey(e)));
    if(!todo.length){ say(`All ${films.length} films from your export are already on your map${rerated ? `; updated ${rerated} rating${rerated===1?"":"s"}` : ""}.`); if(rerated && viewing.mine) renderAll(); return; }
    let added = 0, missed = [];
    // In batches, saving each one, so a big library keeps its progress if the page closes.
    for(let i=0; i<todo.length; i+=40){
      const part = todo.slice(i, i+40);
      say(`Placing your films… ${i} of ${todo.length}. Keep this page open.`);
      const {ready, unmatched, unplaced} = await placeEntries(part, null);
      added += (await Store.add(ready)).added;
      missed.push(...unmatched, ...unplaced);
    }
    await reloadMine();
    if(cloud()){
      const prev = MM.lsGet(lbReportKey(), null) || {missed:[], total:0};
      const byId = new Map(); [...prev.missed, ...missed].forEach(m=>byId.set(m.tmdb || MM.filmKey(m), {t:m.t, y:m.y, tmdb:m.tmdb || null, poster:m.poster || null}));
      MM.lsSet(lbReportKey(), {total:Math.max(prev.total || 0, films.length), full:true, missed:[...byId.values()]});
    }
    if(viewing.mine){ viewing.films = myFilms; renderAll(); fitPins(true); }
    toast(`Added ${added} film${added===1?"":"s"} from your Letterboxd export`);
    renderImport();
    const s2 = $("#lbzs"); if(s2) s2.textContent = `Done: ${added} added${missed.length ? `, ${missed.length} need${missed.length===1?"s":""} a pin (listed above)` : ""}.`;
  }catch(e){ say("Couldn't read that file. Try the zip exactly as Letterboxd sent it."); }
  finally{ importing = false; if(button) button.removeAttribute("aria-disabled"); }
}

let lbEditing = false;   // the linked profile stays locked until "Change profile" is clicked
function renderImport(){
  showMine_keepView();
  const el = $("#import");
  const lb = me && me.letterboxd;
  const last = cloud() ? MM.lsGet(lbSyncKey(), 0) : 0;
  const rep = cloud() ? MM.lsGet(lbReportKey(), null) : null;
  const onMap = new Set(myFilms.map(f=>f.tmdb).filter(Boolean)), mk = myKeys();
  const missing = rep ? rep.missed.filter(m=>!(m.tmdb && onMap.has(m.tmdb)) && !mk.has(MM.filmKey(m))) : [];
  el.innerHTML = `<h2 class="h">Letterboxd</h2>
    <h3 class="step"><span>1</span>Link your username</h3>
    <p class="hint">Adds your recent films, then new ones automatically. No password needed.</p>
    ${cloud() ? `
    ${lb && !lbEditing ? `
    <div class="linked">
      <div style="min-width:0"><small>Linked profile</small><b><a href="https://letterboxd.com/${esc(lb)}/" target="_blank" rel="noopener">letterboxd.com/${esc(lb)}</a></b></div>
      <div class="cta"><button class="btn ghost" type="button" id="lbchange">Change profile</button></div>
    </div>
    <p class="hint" id="lbs">New films are added automatically.${last ? " Last checked " + new Date(last).toLocaleString([], {dateStyle:"medium", timeStyle:"short"}) + "." : ""}</p>
`
    : `
    <form class="search" id="lbf"><label for="lbu" class="sr">Letterboxd username</label><input id="lbu" autocomplete="off" spellcheck="false" placeholder="your Letterboxd username" value="${lbEditing ? "" : esc(lb||"")}"><button class="btn" type="submit">Connect</button>${lbEditing ? `<button class="btn ghost" type="button" id="lbcancel">Cancel</button>` : ""}</form>
    <p class="hint" id="lbs">${lbEditing ? `Currently linked to letterboxd.com/${esc(lb)}. Films already on your map stay there.` : "Your Letterboxd profile needs to be public."}</p>`}
    ${rep ? `<div class="box">
      <p class="ok" style="margin:0"><b>${rep.total} title${rep.total===1?"":"s"}</b> on your Letterboxd${missing.length ? `, <b>${missing.length}</b> still need${missing.length===1?"s":""} a pin` : ", all on your map"}.</p>
      ${missing.length ? `<p class="hint">We couldn't work out where ${missing.length===1 ? "this one takes" : "these take"} place. Tap Place it to pin ${missing.length===1 ? "it" : "each one"} yourself.</p>
      <ul class="results">${missing.map((m,i)=>`<li><button data-i="${i}"><span class="th" ${m.poster ? `style="background-image:url('${MM.poster(m.poster,"w92")}')"` : ""}></span><span style="min-width:0"><b>${esc(m.t)} <span class="m">${esc(m.y)}</span></b><span class="m" style="color:var(--rust)">Place it →</span></span></button></li>`).join("")}</ul>` : ""}
    </div>` : ""}
`
    : `<p class="notice">${sb ? '<a href="#/account">Sign in</a> to link your Letterboxd username.' : "Accounts aren't switched on for this site yet."}</p>`}
    <h3 class="step"><span>2</span>Add your older films</h3>
    <p class="hint">Do this once to bring in everything you've ever watched.</p>
    <ol class="howto">
      <li><a href="https://letterboxd.com/settings/data/" target="_blank" rel="noopener">Export your data ↗</a><span>on Letterboxd</span></li>
      <li><b>Save the zip file</b><span>the one Letterboxd gives you</span></li>
      <li><label class="btn" for="lbzip" tabindex="0">Choose the zip</label><input type="file" id="lbzip" accept=".zip,.csv" multiple hidden></li>
    </ol>
    <p class="hint" id="lbzs" aria-live="polite"></p>`;
  el.querySelectorAll(".results button").forEach(b=>b.onclick = ()=>{ pendingLog = missing[+b.dataset.i]; location.hash = "#/log"; });
  const zip = $("#lbzip"), zl = el.querySelector('label[for="lbzip"]');
  if(zl) zl.onkeydown = e=>{ if(e.key === "Enter" || e.key === " "){ e.preventDefault(); zip.click(); } };
  if(zip) zip.onchange = ()=>{ if(zip.files.length) importLetterboxdExport([...zip.files], $("#lbzs"), zl); };
  const ch = $("#lbchange"); if(ch) ch.onclick = ()=>{ lbEditing = true; renderImport(); $("#lbu").focus(); };
  const cc = $("#lbcancel"); if(cc) cc.onclick = ()=>{ lbEditing = false; renderImport(); };
  const f = $("#lbf");
  if(f) f.onsubmit = async ev=>{
    ev.preventDefault();
    const s = $("#lbs"), btn = f.querySelector("button");
    const name = $("#lbu").value.trim().replace(/^@/,"").replace(/^https?:\/\/(www\.)?letterboxd\.com\//i,"").replace(/\/.*$/,"");
    if(!/^[A-Za-z0-9_]{1,30}$/.test(name)){ s.textContent = "Letterboxd usernames are letters, numbers and underscores."; return; }
    btn.disabled = true; s.textContent = "Checking your Letterboxd profile…"; s.classList.add("busy");
    try{
      if(name !== me.letterboxd){
        try{ await fetchLetterboxdFeed(name); }
        catch(e){ s.classList.remove("busy"); s.textContent = LB_ERRORS[e.message] || "Couldn't reach Letterboxd. Try again."; return; }
        const {error} = await sb.from("profiles").update({letterboxd:name}).eq("id", me.id);
        if(error){ s.classList.remove("busy"); s.textContent = "Couldn't save your username. Try again."; return; }
        me.letterboxd = name;
        MM.lsSet(lbReportKey(), null);   // the old profile's report no longer applies
      }
      lbEditing = false;
      const r = await syncLetterboxd({full:true, progress: msg=>{ s.textContent = msg; }});
      renderImport();   // back to the locked, linked view either way
      if(!r || r.error){ const s2 = $("#lbs"); if(s2) s2.textContent = (r && LB_ERRORS[r.error]) || "Sync didn't go through. Try again."; }
    }finally{ btn.disabled = false; }
  };
}

/* ---------- poster ---------- */
let posterOpts = Object.assign({theme:"swiss", size:"18x24", showKey:true}, MM.lsGet("mm-poster-v2", {}));
let posterCanvas = null, posterURL = null, posterSeq = 0;
function posterTitle(){
  const o = viewing.owner || {};
  const name = viewing.mine ? (me ? (me.display_name || me.username) : "My") : (o.display_name || o.name || o.username || "My");
  return name === "My" ? "My MovieMap" : `${name}'s MovieMap`;
}
function posterSubtitle(){
  const films = viewing.films, nS = films.filter(isSeries).length, nF = films.length - nS;
  const ctry = new Set(films.map(f=>f.c).filter(Boolean)).size, cont = new Set(films.map(contOf).filter(Boolean)).size;
  return [`${nF} film${nF===1?"":"s"}`, nS ? `${nS} series` : "", `${ctry} countr${ctry===1?"y":"ies"}`, cont ? `${cont} continent${cont===1?"":"s"}` : ""].filter(Boolean).join("  ·  ");
}
function renderPoster(){
  const el = $("#poster");
  if(!viewing.films.length){ el.innerHTML = `<h2 class="h">Poster</h2><p class="hint">There are no films on this map yet. Log a few first, then come back for a poster.</p>`; return; }
  const seg = (name, items) => `<div class="seg" role="group" aria-label="${name}">${items}</div>`;
  el.innerHTML = `<h2 class="h">Poster</h2>
    <p class="hint">${esc(posterTitle())}, ready to print. Every place gets a number, with a key underneath.</p>
    <div class="pv busy" id="pv">Drawing your poster…</div>
    <div class="opts">
      <div class="field">Style${seg("Style", Object.entries(MM.POSTER_THEMES).map(([k,t])=>`<button type="button" data-theme="${k}" aria-pressed="${posterOpts.theme===k}"><i style="background:${t.bg};box-shadow:inset -8px 0 0 ${t.pin}"></i>${t.label}</button>`).join(""))}</div>
      <label class="field" for="ps">Size<select id="ps">${Object.entries(MM.POSTER_SIZES).map(([k,s])=>`<option value="${k}" ${posterOpts.size===k?"selected":""}>${s.label}</option>`).join("")}</select></label>
      <label class="check" for="pk"><input type="checkbox" id="pk" ${posterOpts.showKey?"checked":""}> Include the key of places and titles</label>
      <div class="cta"><button class="btn" id="pdf">Download PDF</button><button class="btn ghost" id="png">Download PNG</button></div>
      <p class="hint">The PDF is sized for printing at the size you pick, at 200 dpi. Any print shop, or an online service like Printful or Mpix, can print it. For a home printer, choose A3.</p>
    </div>`;
  el.querySelectorAll("[data-theme]").forEach(b=>b.onclick = ()=>{ posterOpts.theme = b.dataset.theme; el.querySelectorAll("[data-theme]").forEach(x=>x.setAttribute("aria-pressed", String(x===b))); drawPoster(); });
  $("#ps").onchange = e=>{ posterOpts.size = e.target.value; drawPoster(); };
  $("#pk").onchange = e=>{ posterOpts.showKey = e.target.checked; drawPoster(); };
  $("#png").onclick = ()=>downloadPoster("png");
  $("#pdf").onclick = ()=>downloadPoster("pdf");
  drawPoster();
}
async function drawPoster(){
  const seq = ++posterSeq;
  MM.lsSet("mm-poster-v2", posterOpts);
  await MM.posterFontsReady();
  if(seq !== posterSeq) return;
  posterCanvas = MM.renderPoster({
    title: posterTitle(), subtitle: posterSubtitle(), films: viewing.films, countries,
    theme: posterOpts.theme, size: posterOpts.size, showKey: posterOpts.showKey,
    isSeries, geoName: MM.geoName, url: siteURL().replace(/^https?:\/\//, "").replace(/\/$/, "")
  });
  const blob = await new Promise(r=>posterCanvas.toBlob(r, "image/jpeg", 0.85));
  if(seq !== posterSeq || !blob) return;
  if(posterURL) URL.revokeObjectURL(posterURL);
  posterURL = URL.createObjectURL(blob);
  const pv = $("#pv"); if(!pv) return;
  pv.classList.remove("busy");
  pv.innerHTML = `<img src="${posterURL}" alt="Poster preview of ${esc(posterTitle())}">`;
}
let jsPDFLoad = null;
function loadJsPDF(){
  if(window.jspdf) return Promise.resolve();
  return jsPDFLoad = jsPDFLoad || new Promise((res, rej)=>{
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
    s.onload = res; s.onerror = ()=>{ jsPDFLoad = null; rej(new Error("load")); };
    document.head.append(s);
  });
}
async function downloadPoster(kind){
  if(!posterCanvas) return;
  const name = "moviemap-" + (MM.norm(posterTitle().replace(/'s MovieMap$|MovieMap$/i,"")) || "poster");
  const btn = $(kind === "pdf" ? "#pdf" : "#png"); btn.disabled = true;
  try{
    let blob;
    if(kind === "png") blob = await new Promise(r=>posterCanvas.toBlob(r, "image/png"));
    else {
      await loadJsPDF();
      const S = MM.POSTER_SIZES[posterOpts.size];
      const doc = new window.jspdf.jsPDF(Object.assign({orientation:"portrait"}, S.pdf));
      const pw = doc.internal.pageSize.getWidth(), ph = doc.internal.pageSize.getHeight();
      doc.addImage(posterCanvas.toDataURL("image/jpeg", 0.93), "JPEG", 0, 0, pw, ph);
      blob = doc.output("blob");
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `${name}.${kind}`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
  }catch(e){ toast("The download didn't work. Check your connection and try again."); }
  finally{ btn.disabled = false; }
}

/* ---------- people ---------- */
async function renderExplore(){
  const el = $("#explore");
  const starter = `<a class="ucard" href="#/u/${FEATURED.username}"><span class="avatar" style="background:${MM.avatarColor(FEATURED.username)}">${FEATURED.name[0]}</span><span style="min-width:0"><b>${esc(FEATURED.name)}</b><span class="m">Starter map · ${FEATURED.synced ? "synced from Letterboxd" : "hand-checked settings"}</span></span><em><b>${FEATURED.films.length}</b><br>films</em></a>`;
  if(!sb){
    el.innerHTML = `<h2 class="h">People</h2><p class="hint">Accounts aren't switched on for this site yet, so there's one map to explore.</p><div class="list">${starter}</div>`;
    return;
  }
  el.innerHTML = `<h2 class="h">People</h2>
    <div class="search"><label for="pq" class="sr">Search people</label><input id="pq" type="search" autocomplete="off" placeholder="Search by username or name"></div>
    <div class="list" id="pr"></div>
    ${cloud() ? `<div class="cta"><button class="btn ghost small" id="invite">Invite friends</button>${("contacts" in navigator && "ContactsManager" in window) ? `<button class="btn ghost small" id="fromcontacts">Find friends in contacts</button>` : ""}</div><div id="cres"></div>
      <h3 class="sub">Following</h3><div class="list" id="following"><p class="hint">Loading…</p></div>` : `<p class="notice"><a href="#/account">Sign in</a> to follow people and find friends from your contacts.</p>`}
    <h3 class="sub">New on MovieMap</h3><div class="list" id="newest"><p class="hint">Loading…</p></div>
    <h3 class="sub">Starter map</h3><div class="list">${starter}</div>`;
  let t; $("#pq").addEventListener("input", e=>{ clearTimeout(t); t = setTimeout(()=>searchPeople(e.target.value.trim()), 250); });
  if(cloud()){
    $("#invite").onclick = ()=>shareLink(profileURL(me.username), "Follow my MovieMap");
    const fc = $("#fromcontacts"); if(fc) fc.onclick = findFromContacts;
    const {data} = await sb.from("follows").select("followee:profiles!follows_followee_fkey(id,username,display_name,logs(count))").eq("follower", me.id).limit(100);
    const fl = (data||[]).map(r=>r.followee).filter(Boolean);
    $("#following").innerHTML = fl.length ? fl.map(personCard).join("") : `<p class="hint">You're not following anyone yet. Search above, or invite friends.</p>`;
  }
  const {data:newest} = await sb.from("profiles").select("id,username,display_name,logs(count)").order("created_at", {ascending:false}).limit(12);
  const nn = $("#newest"); if(nn) nn.innerHTML = (newest||[]).length ? newest.map(personCard).join("") : `<p class="hint">Nobody yet. Be the first.</p>`;
}
function personCard(p){
  const n = p.logs && p.logs[0] ? p.logs[0].count : "";
  const name = p.display_name || p.username;
  return `<a class="ucard" href="#/u/${encodeURIComponent(p.username)}"><span class="avatar" style="background:${MM.avatarColor(p.username)}">${esc(name[0]||"?")}</span><span style="min-width:0"><b>${esc(name)}</b><span class="m">@${esc(p.username)}</span></span><em>${n!=="" ? `<b>${n}</b><br>films` : ""}</em></a>`;
}
async function searchPeople(q){
  const box = $("#pr"); if(!box) return;
  if(q.length < 2){ box.innerHTML = ""; return; }
  const like = "%" + q.replace(/[%_\\]/g, m=>"\\" + m) + "%";
  const {data, error} = await sb.from("profiles").select("id,username,display_name,logs(count)").or(`username.ilike.${like},display_name.ilike.${like}`).limit(20);
  if(error){ box.innerHTML = `<p class="err">Search didn't go through.</p>`; return; }
  box.innerHTML = data.length ? data.map(personCard).join("") : `<p class="hint">No one matches "${esc(q)}".</p>`;
}
async function sha256(s){ const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join(""); }
const normEmail = e => String(e||"").trim().toLowerCase();
const normPhone = p => { const d = String(p||"").replace(/\D/g,""); return d.length >= 7 ? d.slice(-10) : ""; };
async function findFromContacts(){
  const out = $("#cres");
  try{
    const picked = await navigator.contacts.select(["email","tel"], {multiple:true});
    if(!picked.length) return;
    const keys = new Set();
    for(const c of picked){ (c.email||[]).forEach(e=>{ if(normEmail(e)) keys.add("e:" + normEmail(e)); }); (c.tel||[]).forEach(t=>{ if(normPhone(t)) keys.add("p:" + normPhone(t)); }); }
    const hashes = await Promise.all([...keys].slice(0,500).map(sha256));
    const {data, error} = await sb.rpc("find_by_contacts", {hashes});
    if(error) throw error;
    out.innerHTML = data.length ? `<h3 class="sub">From your contacts</h3><div class="list">${data.map(personCard).join("")}</div>` : `<p class="hint">None of those contacts are on MovieMap yet, or they haven't turned on "Let friends find me". Try Invite friends.</p>`;
  }catch(e){ out.innerHTML = `<p class="hint">Couldn't read your contacts.</p>`; }
}
async function shareLink(url, title){
  if(navigator.share){ try{ await navigator.share({title, url}); return; }catch(e){ if(e && e.name === "AbortError") return; } }
  try{ await navigator.clipboard.writeText(url); toast("Link copied"); }catch(e){ prompt("Copy this link", url); }
}

/* ---------- account ---------- */
let acctTab = "in";
function renderAccount(){
  const el = $("#account");
  if(!sb){
    el.innerHTML = `<h2 class="h">Accounts</h2><p class="hint">Accounts aren't switched on for this site yet. Until they are, your films save in this browser.</p>`;
    return;
  }
  if(!session){
    el.innerHTML = `<h2 class="h">${acctTab === "up" ? "Create your map" : "Sign in"}</h2>
      <div class="tabs" role="tablist"><button role="tab" aria-selected="${acctTab==="in"}" data-t="in">Sign in</button><button role="tab" aria-selected="${acctTab==="up"}" data-t="up">Create account</button></div>
      <form id="af" class="pad" style="padding:0">
        ${acctTab==="up" ? `<label class="field" for="a-user">Username<input id="a-user" required autocomplete="username" placeholder="letters, numbers, _" pattern="[A-Za-z0-9_]{3,20}"></label>
        <label class="field" for="a-name">Display name<input id="a-name" maxlength="40" autocomplete="name"></label>` : ""}
        <label class="field" for="a-email">Email<input id="a-email" type="email" required autocomplete="email"></label>
        <label class="field" for="a-pass">Password<input id="a-pass" type="password" required minlength="8" autocomplete="${acctTab==="up" ? "new-password" : "current-password"}"></label>
        <p class="err" id="a-err" hidden></p>
        <div class="cta"><button class="btn" type="submit">${acctTab==="up" ? "Create account" : "Sign in"}</button>${acctTab==="in" ? `<button type="button" class="linkbtn" id="a-forgot">Forgot password?</button>` : ""}</div>
      </form>
      ${myFilms.length ? `<p class="notice">The ${myFilms.length} film${myFilms.length===1?"":"s"} saved in this browser will move to your account when you sign in.</p>` : ""}`;
    el.querySelectorAll(".tabs button").forEach(b=>b.onclick = ()=>{ acctTab = b.dataset.t; renderAccount(); });
    const err = m=>{ const e = $("#a-err"); e.textContent = m; e.hidden = !m; };
    const fg = $("#a-forgot"); if(fg) fg.onclick = async ()=>{
      const email = $("#a-email").value.trim(); if(!email) return err("Type your email first, then tap Forgot password.");
      const {error} = await sb.auth.resetPasswordForEmail(email, {redirectTo: siteURL()});
      error ? err(error.message) : (err(""), toast("Check your email for a reset link"));
    };
    $("#af").onsubmit = async ev=>{
      ev.preventDefault(); err("");
      const email = $("#a-email").value.trim(), password = $("#a-pass").value;
      const btn = ev.target.querySelector('button[type="submit"]'); btn.disabled = true;
      try{
        if(acctTab === "up"){
          const username = $("#a-user").value.trim().toLowerCase();
          if(!/^[a-z0-9_]{3,20}$/.test(username)) throw new Error("Usernames are 3–20 letters, numbers or underscores.");
          const {data:ok} = await sb.rpc("username_available", {name:username});
          if(ok === false) throw new Error("That username is taken. Try another.");
          const {data, error} = await sb.auth.signUp({email, password, options:{data:{username, display_name:$("#a-name").value.trim()}, emailRedirectTo: siteURL()}});
          if(error) throw error;
          if(!data.session){ $("#account").innerHTML = `<h2 class="h">Check your email</h2><p class="hint">We sent a confirmation link to <b>${esc(email)}</b>. Open it on this device to finish creating your map.</p>`; return; }
        } else {
          const {error} = await sb.auth.signInWithPassword({email, password});
          if(error) throw new Error(error.message === "Invalid login credentials" ? "That email and password don't match." : error.message);
        }
      }catch(e){ err(e.message || "That didn't work. Try again."); }
      finally{ btn.disabled = false; }
    };
    return;
  }
  const p = me || {};
  el.innerHTML = `<h2 class="h">@${esc(p.username)}</h2>
    <form id="pf" style="display:grid;gap:12px">
      <label class="field" for="p-name">Display name<input id="p-name" maxlength="40" value="${esc(p.display_name)}"></label>
      <label class="field" for="p-bio">Bio<textarea id="p-bio" maxlength="160" rows="2">${esc(p.bio)}</textarea></label>
      <div class="field">Letterboxd<span style="font-weight:400;font-size:15px">${p.letterboxd ? `<a href="https://letterboxd.com/${esc(p.letterboxd)}/" target="_blank" rel="noopener">letterboxd.com/${esc(p.letterboxd)}</a> · <a href="#/import">Change on the Letterboxd tab</a>` : `Not linked · <a href="#/import">Connect on the Letterboxd tab</a>`}</span></div>
      <div class="box">
        <b class="sub" style="font-size:16px">Find friends from contacts</b>
        <label class="check" for="p-disc"><input type="checkbox" id="p-disc" ${p.discoverable ? "checked" : ""}> Let friends who have my email or phone number find me</label>
        <label class="field" for="p-phone">Phone number (optional)<input id="p-phone" type="tel" autocomplete="tel" placeholder="${p.discoverable ? "Saved privately. Type to replace" : "Only used for matching"}"></label>
        <p class="hint">We store a scrambled fingerprint of your email and phone, never the numbers themselves, and only match it when someone picks you from their contacts.</p>
      </div>
      <p class="err" id="p-err" hidden></p>
      <div class="cta"><button class="btn" type="submit">Save profile</button><button class="btn ghost" type="button" id="p-share">Share my map</button><button class="btn ghost" type="button" id="p-out">Sign out</button></div>
    </form>
    <p class="hint">Signed in as ${esc(session.user.email)}.</p>`;
  $("#p-out").onclick = async ()=>{ await sb.auth.signOut(); };
  $("#p-share").onclick = ()=>shareLink(profileURL(p.username), "My MovieMap");
  $("#pf").onsubmit = async ev=>{
    ev.preventDefault();
    const e = $("#p-err"); e.hidden = true;
    const disc = $("#p-disc").checked;
    const patch = {display_name:$("#p-name").value.trim(), bio:$("#p-bio").value.trim(), discoverable: disc};   // the Letterboxd link is managed on the Letterboxd tab
    const {error} = await sb.from("profiles").update(patch).eq("id", me.id);
    if(error){ e.textContent = "Couldn't save. Try again."; e.hidden = false; return; }
    try{
      const phone = normPhone($("#p-phone").value);
      if(!disc){ await sb.from("contact_keys").delete().eq("user_id", me.id); }
      else {
        const keys = [await sha256("e:" + normEmail(session.user.email))];
        if(phone) keys.push(await sha256("p:" + phone));
        if(phone || !(await sb.from("contact_keys").select("hash").eq("user_id", me.id)).data?.length){
          await sb.from("contact_keys").delete().eq("user_id", me.id);
          await sb.from("contact_keys").insert(keys.map(hash=>({user_id:me.id, hash})));
        }
      }
    }catch(x){}
    Object.assign(me, patch); paintAccountLink(); toast("Profile saved"); renderAccount();
  };
}

/* ================= routing ================= */
async function route(){
  const h = location.hash || "#/";
  if(/access_token|error_description|type=recovery/.test(h)) return;   // Supabase is handling a sign-in link
  closeDetail(); preview = null; picking = null; $("#pickhint").hidden = true; $("#map").classList.remove("picking");
  const [, a, b] = h.split("/");
  if(a === "u" && b){
    setNav(""); showPanel("map");
    const name = decodeURIComponent(b).toLowerCase();
    if(me && name === me.username){ setNav("home"); return showMine(); }
    if(sb){
      const {data:p} = await sb.from("profiles").select("*").eq("username", name).maybeSingle();
      if(p){ const films = await fetchLogs(p.id).catch(()=>[]); return showMap(p, films, false); }
    }
    if(name === FEATURED.username || name === "henry" || name === "grant") return showMap(FEATURED, FEATURED.films, false);   // its old names still work
    showMap({name:"Not found", username:name, bio:"No one has this username."}, [], false);
    return;
  }
  if(a === "explore"){ setNav("explore"); showPanel("explore"); if(!viewing.owner) showFeaturedOrMine(); return renderExplore(); }
  if(a === "log"){ setNav("log"); showPanel("log"); return renderLog(); }
  if(a === "import"){ setNav("import"); showPanel("import"); return renderImport(); }
  if(a === "poster" && !POSTERS){ location.replace("#/"); return; }
  if(a === "poster"){ setNav(""); showPanel("poster"); if(!viewing.owner) showFeaturedOrMine(); return renderPoster(); }
  if(a === "account"){ setNav("account"); showPanel("account"); if(!viewing.owner) showFeaturedOrMine(); return renderAccount(); }
  setNav("home"); showPanel("map"); showFeaturedOrMine();
}
// The starter map is @mattgoold's Letterboxd, kept in sync on the server (daily-sync → starter_logs).
// Until it loads (or if it can't), the hand-checked list in featured.js stands in.
async function loadStarter(){
  if(!sb) return;
  try{
    const {data:info} = await sb.from("starters").select("*").eq("username", FEATURED.username).maybeSingle();
    const rows = [];
    for(let from=0; ; from+=1000){
      const {data, error} = await sb.from("starter_logs").select("*").eq("map", FEATURED.username).order("watched_on", {ascending:false, nullsFirst:false}).order("created_at", {ascending:false}).range(from, from+999);
      if(error) throw error;
      rows.push(...data); if(data.length < 1000) break;
    }
    if(rows.length < 10) return;                         // still filling: keep the stand-in
    FEATURED.films = rows.map(fromRow);
    FEATURED.synced = true;
    if(info){ FEATURED.name = info.display_name || FEATURED.name; FEATURED.bio = info.bio || ""; }
    if(viewing.owner === FEATURED){ const keep = location.hash; showMap(FEATURED, FEATURED.films, false); if(/explore/.test(keep)) renderExplore(); }
    else if(/#\/explore/.test(location.hash)) renderExplore();
  }catch(e){}
}
function showFeaturedOrMine(){
  if(cloud() || myFilms.length) return showMine();
  showMap(FEATURED, FEATURED.films, false);
}
window.addEventListener("hashchange", route);

/* ================= auth wiring ================= */
async function loadMe(){
  me = null;
  if(!session) return;
  for(let i=0; i<3 && !me; i++){   // the profile row is created by a trigger right after sign-up
    const {data} = await sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
    me = data || null; if(!me) await MM.sleep(600);
  }
}
async function moveLocalFilms(){
  const local = MM.lsGet(LOCAL, []);
  if(!local.length || !cloud()) return;
  try{ const {added} = await Store.add(local); MM.lsSet(LOCAL, []); if(added) toast(`Moved ${added} film${added===1?"":"s"} to your account`); }catch(e){}
}
let aiState = "unknown";   // unknown | on | off
async function aiFor(d){
  if(aiState === "off" || !cloud()) return null;
  const {data, error} = await sb.functions.invoke("film-setting", {body:{tmdb:d.tmdb, title:d.t, year:d.y || null, qid:d.qid || null, overview:d.ov || "", tv:MM.isTv(d.tmdb)}});
  if(error){
    // Not deployed (404, or the browser blocks the request outright): stop asking for the rest of this visit.
    const status = error.context && error.context.status;
    if(!status || status === 404 || error.name === "FunctionsFetchError" || error.name === "FunctionsRelayError") aiState = "off";
    return null;
  }
  if(data && data.reason === "no_api_key"){ aiState = "off"; return null; }
  aiState = "on";
  return data && data.setting || null;
}
async function onAuth(newSession, event){
  session = newSession;
  await loadMe();
  MM.aiSetting = (sb && newSession) ? aiFor : null;
  if(cloud()) await moveLocalFilms();
  await reloadMine();
  paintAccountLink();
  maybeAutoSync();
  if(event === "PASSWORD_RECOVERY"){
    showPanel("account"); setNav("account");
    $("#account").innerHTML = `<h2 class="h">Choose a new password</h2><form id="np" style="display:grid;gap:12px"><label class="field" for="np-p">New password<input id="np-p" type="password" minlength="8" required autocomplete="new-password"></label><div class="cta"><button class="btn">Save password</button></div></form>`;
    $("#np").onsubmit = async e=>{ e.preventDefault(); const {error} = await sb.auth.updateUser({password:$("#np-p").value}); if(error) return toast(error.message); toast("Password updated"); location.hash = "#/"; };
    return;
  }
  if(/access_token|type=/.test(location.hash) || (event === "SIGNED_IN" && /#\/account/.test(location.hash))){ history.replaceState(null, "", siteURL() + "#/"); }
  route();
}

/* ================= boot ================= */
async function boot(){
  let topo;
  try{ topo = await (await fetch("data/world.json")).json(); }catch(e){ toast("The map didn't load. Refresh to try again."); return; }
  countries = topojson.feature(topo, topo.objects.countries).features;
  MM.setWorld(countries);
  let rT; new ResizeObserver(()=>{ clearTimeout(rT); rT = setTimeout(()=>{ drawBase(); fitPins(false); }, 60); }).observe($(".mapwrap"));
  drawBase();
  loadStarter();
  if(sb){
    const {data} = await sb.auth.getSession();
    sb.auth.onAuthStateChange((event, s)=>{
      if(event === "INITIAL_SESSION" || event === "TOKEN_REFRESHED") return;
      if(event === "USER_UPDATED"){ session = s; return; }
      setTimeout(()=>onAuth(s, event), 0);
    });
    await onAuth(data.session, "INITIAL");
  } else {
    await reloadMine(); paintAccountLink(); route();
  }
}
boot();
})();
