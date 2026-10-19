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
  note:f.n ? String(f.n).slice(0,500) : null, rating:f.r||null, reviewed:!!f.rv, watched_on:f.watched||null, source:f.src||null
});
const fromRow = r => ({
  id:r.id, t:r.title, y:r.year||"", d:r.director||"", tmdb:r.tmdb_id, poster:r.poster_path, p:r.place||"", c:r.country||"",
  cont:r.continent||"", lat:r.lat, lon:r.lon, ap:r.approx?1:0, n:r.note||"", r:r.rating!=null?+r.rating:null, rv:r.reviewed?1:0,
  watched:r.watched_on||"", src:r.source||"", created:r.created_at
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
    const rows = Object.keys(map).filter(id=>["wikidata","production"].includes(map[id].src) && !map[id].aiTried).map(id=>{ const s = map[id]; return {tmdb_id:+id, place:s.p, country:s.c, continent:s.cont||null, lat:s.lat, lon:s.lon, approx:!!s.ap, note:s.n||null, source:s.src}; });
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

/* ================= map ================= */
const svg = d3.select("#map");
const gRoot = svg.append("g"), gLand = gRoot.append("g"), gLabels = gRoot.append("g").attr("aria-hidden","true"), gPins = gRoot.append("g");
let countries = [], projection, path, W = 0, H = 0, k = 1;
let viewing = {owner:null, films:[], mine:false};   // what the map shows
let selected = null, picking = null, preview = null;

function drawBase(){
  const box = svg.node().getBoundingClientRect();
  W = box.width; H = box.height; if(!W || !H) return;
  projection = d3.geoEqualEarth().fitExtent([[8,8],[W-8,H-8]], {type:"Sphere"});
  path = d3.geoPath(projection);
  gLand.selectAll("*").remove();
  gLand.append("path").attr("class","sphere").attr("d", path({type:"Sphere"}));
  gLand.append("path").attr("class","grat").attr("d", path(d3.geoGraticule10()));
  gLand.selectAll("path.country").data(countries).join("path").attr("class","country").attr("d", path);
  buildLabels();
  renderPins();
}

/* country names: placed on each country's largest landmass, shown once there's room at the current zoom */
const SHORT_NAMES = {"United States of America":"United States","Dem. Rep. Congo":"DR Congo","Central African Rep.":"Central African Rep.","Bosnia and Herz.":"Bosnia","Dominican Rep.":"Dominican Rep.","Eq. Guinea":"Eq. Guinea","S. Sudan":"South Sudan","Solomon Is.":"Solomon Is.","Fr. S. Antarctic Lands":"","Falkland Is.":"Falklands","W. Sahara":"W. Sahara","N. Cyprus":"","Somaliland":"","Antarctica":"Antarctica"};
let labels = [], pinGroups = [];
function largestPart(g){
  if(!g || g.type !== "MultiPolygon") return g;
  let best = null, bestA = -1;
  g.coordinates.forEach(c=>{ const p = {type:"Polygon", coordinates:c}; const a = d3.geoArea(p); if(a > bestA){ bestA = a; best = p; } });
  return best;
}
function buildLabels(){
  labels = countries.map(f=>{
    const name = f.properties.name;
    const label = SHORT_NAMES[name] ?? name;
    if(!label) return null;
    const part = largestPart(f.geometry); if(!part) return null;
    const p = path.centroid(part); if(!p || !isFinite(p[0])) return null;
    const b = path.bounds(part);
    // Spare spots inside the country (on a 5 x 5 grid), nearest the centre first, for when a pin sits on the centre.
    const spots = [[0,0]];
    for(let i=1; i<5; i++) for(let j=1; j<5; j++){
      const x = b[0][0] + (b[1][0]-b[0][0]) * i/5, y = b[0][1] + (b[1][1]-b[0][1]) * j/5;
      const ll = projection.invert([x, y]);
      if(ll && d3.geoContains(part, ll)) spots.push([x - p[0], y - p[1]]);
    }
    spots.sort((a,c)=>Math.hypot(a[0],a[1]) - Math.hypot(c[0],c[1]));
    return {name, label:label.toUpperCase(), x:p[0], y:p[1], area:path.area(part), bw:b[1][0] - b[0][0], bh:b[1][1] - b[0][1], spots};
  }).filter(Boolean).sort((a,b)=>b.area - a.area);
  gLabels.selectAll("text").data(labels, d=>d.name).join("text").attr("class","clabel").text(d=>d.label);
  updateLabels();
}
// Like a printed map: every country is named in a size that suits it, and a name only drops out
// when there's no room for it at this zoom (it comes back as you zoom in).
function updateLabels(){
  if(!labels.length) return;
  const visited = new Set(viewing.films.map(f=>MM.geoName(f.c)));
  const pins = pinGroups.map(g=>[g.x * k, g.y * k, g.films.length > 1 ? 15 : 8]);
  const order = [...labels].sort((a,b)=>(visited.has(b.name) - visited.has(a.name)) || b.area - a.area);
  const placed = [], shown = new Map();
  for(const d of order){
    const side = Math.sqrt(d.area) * k;                       // rough size of the country on screen
    const fs = Math.max(7, Math.min(13, 6 + side / 16));      // bigger countries get bigger names
    const w = d.label.length * fs * 0.64 + 2, h = fs + 2;
    const room = Math.max(d.bw * k * 1.35, side * 1.6);       // a name may spill a little past a narrow country
    if(w > room || d.bh * k < fs * 0.6) continue;
    const cx = d.x * k, cy = d.y * k;
    // Try the centre first, then nearby spots inside big countries, so pins don't knock names off.
    const dy = h + 4;
    const spots = [[0,0],[0,dy],[0,-dy], ...d.spots.slice(1).map(([sx,sy])=>[sx * k, sy * k])];
    let best = null;
    for(const [ox, oy] of spots){
      const box = [cx + ox - w/2, cy + oy - h/2, cx + ox + w/2, cy + oy + h/2];
      const onPin = pins.filter(([px,py,r])=>px > box[0]-r && px < box[2]+r && py > box[1]-r && py < box[3]+r).length;
      const onLabel = placed.some(o=>!(box[2] + 2 < o[0] || box[0] - 2 > o[2] || box[3] < o[1] || box[1] > o[3]));
      if(onLabel) continue;
      if(!onPin){ best = {box, ox, oy, fs}; break; }
      if(!best || onPin < best.pins) best = {box, ox, oy, fs, pins:onPin};
    }
    // Countries with films always keep their name, even if a pin has to sit on part of it.
    if(best && (!best.pins || visited.has(d.name) || side > 120)){ placed.push(best.box); shown.set(d.name, best); }
  }
  gLabels.selectAll("text")
    .attr("display", d=>shown.has(d.name) ? null : "none")
    .attr("font-size", d=>shown.has(d.name) ? shown.get(d.name).fs : null)
    .classed("visited", d=>visited.has(d.name))
    .attr("transform", d=>{ const s = shown.get(d.name) || {}; return `translate(${d.x + (s.ox||0)/k},${d.y + (s.oy||0)/k}) scale(${1/k})`; });
}
const zoom = d3.zoom().scaleExtent([1,40]).on("zoom", ev=>{
  gRoot.attr("transform", ev.transform); k = ev.transform.k;
  gPins.selectAll(".pin.film").attr("transform", d=>`translate(${d.x},${d.y}) scale(${1/k})`);
  updateLabels();
  if(preview && projection){ const p = projection([preview.lon, preview.lat]); gPins.selectAll(".preview").attr("transform", `translate(${p[0]},${p[1]}) scale(${1/k})`); }
});
svg.call(zoom).on("dblclick.zoom", null);
$("#zin").onclick = ()=>svg.transition().duration(300).call(zoom.scaleBy, 1.6);
$("#zout").onclick = ()=>svg.transition().duration(300).call(zoom.scaleBy, 1/1.6);
$("#zfit").onclick = ()=>fitPins(true);

function groupFilms(list){
  const groups = [];
  list.forEach(f=>{
    if(!isFinite(f.lat) || !isFinite(f.lon)) return;
    let g = groups.find(g=>Math.abs(g.lat-f.lat)<0.6 && Math.abs(g.lon-f.lon)<0.6);
    if(!g){ g = {lat:f.lat, lon:f.lon, films:[]}; groups.push(g); }
    g.films.push(f);
  });
  groups.forEach(g=>{ const p = projection([g.lon,g.lat]); g.x = p[0]; g.y = p[1]; g.ap = g.films.every(f=>f.ap); g.key = g.films.map(MM.filmKey).join("~"); });
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
  closeDetail(); renderList();
});
function renderPins(){
  if(!projection) return;
  const list = filtered();
  const groups = pinGroups = groupFilms(list);
  const pins = gPins.selectAll("g.pin.film").data(groups, d=>d.key).join(enter=>{
    const g = enter.append("g").attr("class","pin film").attr("tabindex",0).attr("role","button");
    g.append("circle").attr("class","dot"); g.append("rect").attr("class","dot"); g.append("text"); return g;
  });
  pins.classed("approx", d=>d.ap).classed("sel", d=>!!selected && d.films.includes(selected))
    .attr("aria-label", d=>d.films.map(f=>f.t).join(", "))
    .attr("transform", d=>`translate(${d.x},${d.y}) scale(${1/k})`)
    .on("click", (ev,d)=>{ ev.stopPropagation(); openGroup(d); })
    .on("keydown", (ev,d)=>{ if(ev.key==="Enter"||ev.key===" "){ ev.preventDefault(); openGroup(d); } });
  // A lone series gets a square pin; films and mixed groups get a round one.
  const lone = d => d.films.length === 1 && isSeries(d.films[0]);
  pins.select("circle").attr("display", d=>lone(d) ? "none" : null).attr("r", d=>d.films.length>1 ? Math.min(16, 9 + Math.log2(d.films.length)*2) : 7);
  pins.select("rect").attr("display", d=>lone(d) ? null : "none").attr("x",-6.5).attr("y",-6.5).attr("width",13).attr("height",13).attr("rx",2.5);
  pins.select("text").text(d=>d.films.length>1 ? d.films.length : "");
  const visited = new Set(viewing.films.map(f=>MM.geoName(f.c)));
  gLand.selectAll("path.country").classed("visited", d=>visited.has(d.properties.name));
  updateLabels();
  gPins.selectAll(".preview").remove();
  if(preview){
    const p = projection([preview.lon, preview.lat]);
    gPins.append("g").attr("class","pin preview sel").attr("transform", `translate(${p[0]},${p[1]}) scale(${1/k})`).append("circle").attr("class","dot").attr("r",8);
  }
}
function fitPins(animate){
  if(!projection) return;
  const pts = viewing.films.filter(f=>isFinite(f.lat)).map(f=>projection([f.lon,f.lat]));
  let t = d3.zoomIdentity;
  if(pts.length){
    const [x0,x1] = d3.extent(pts, p=>p[0]), [y0,y1] = d3.extent(pts, p=>p[1]);
    const s = Math.max(1, Math.min(8, 0.88/Math.max((x1-x0+70)/W, (y1-y0+70)/H)));
    t = d3.zoomIdentity.translate(W/2, H/2).scale(s).translate(-(x0+x1)/2, -(y0+y1)/2);
  }
  (animate ? svg.transition().duration(600) : svg).call(zoom.transform, t);
}
function flyTo(f){
  if(!projection) return;
  const [x,y] = projection([f.lon, f.lat]);
  svg.transition().duration(650).call(zoom.transform, d3.zoomIdentity.translate(W/2, H/2).scale(Math.max(k, 5)).translate(-x, -y));
}
svg.on("click", ev=>{
  if(!picking){ if(!$("#detail").hidden) closeDetail(); return; }
  const t = d3.zoomTransform(svg.node());
  const ll = projection.invert(t.invert(d3.pointer(ev, svg.node())));
  if(!ll || isNaN(ll[0])) return;
  const hit = countries.find(c=>d3.geoContains(c, ll));
  const cb = picking; picking = null;
  $("#map").classList.remove("picking"); $("#pickhint").hidden = true;
  cb({lon:+ll[0].toFixed(3), lat:+ll[1].toFixed(3), country: hit ? MM.displayCountry(hit.properties.name) : ""});
});
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
function openFilm(f, fly){
  selected = f; detail.hidden = false;
  const direct = f.poster ? MM.poster(f.poster) : null;
  const mine = viewing.mine;
  detail.innerHTML = `<div class="top">${posterSlot(f, direct)}
    <div class="stub"><small>${esc(f.y)}${f.d ? " · " + esc(f.d) : ""}</small><h3>${esc(f.t)}</h3><button class="x" aria-label="Close">×</button></div></div>
    <div class="body">
      <div><div class="place">${esc(placeLine(f))}</div><div class="coord">${fmtCoord(f.lat, f.lon)}</div></div>
      ${f.n ? `<p class="note">${esc(f.n)}</p>` : ""}
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${f.r ? `<span class="stars">${stars(f.r)}</span>` : ""}${f.rv ? '<span class="tag">Reviewed</span>' : ""}${isSeries(f) ? '<span class="tag tv">Series</span>' : ""}${f.ap ? '<span class="tag ap">Approx. setting</span>' : ""}${f.watched ? `<span class="tag" style="color:var(--muted)">Watched ${esc(f.watched)}</span>` : ""}</div>
      ${mine ? `<div class="cta"><button class="btn ghost small" id="d-move">Move pin</button><button class="btn ghost small" id="d-del">Remove</button></div>` : ""}
      ${f.tmdb ? `<a class="linkbtn" href="${MM.tmdbPage(f.tmdb)}" target="_blank" rel="noopener">${MM.isTv(f.tmdb) ? "Series" : "Film"} page on TMDB ↗</a>` : ""}
      <div class="more" id="more" hidden></div>
    </div>`;
  showSimilar(f);
  detail.querySelector(".x").onclick = closeDetail;
  if(!direct) MM.posterFor(f).then(url=>{
    if(!url || selected !== f) return;
    const slot = detail.querySelector(".poster"); if(slot) slot.outerHTML = posterSlot(f, url);
  });
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
  if(fly) flyTo(f);
  renderPins(); markListSelection();
}
// "More from Argentina": similar titles from the country this one is set in. Tap one to log it.
async function showSimilar(f){
  const iso = MM.isoFor(f.c); if(!iso) return;
  const ids = new Set(myFilms.map(x=>x.tmdb).filter(Boolean)), keys = myKeys();
  let list = [];
  try{ list = await MM.similarFrom(f, iso, m=>ids.has(m.tmdb) || keys.has(MM.filmKey(m))); }catch(e){ return; }
  const box = $("#more");
  if(!box || selected !== f || !list.length) return;
  box.hidden = false;
  box.innerHTML = `<b class="sub" style="font-size:15px">More from ${esc(f.c)}</b>
    <ul>${list.map((m,i)=>`<li><button type="button" data-i="${i}" title="Log ${esc(m.t)}"><span class="th" style="background-image:url('${MM.poster(m.poster, "w185")}')"></span><span class="t">${esc(m.t)}</span><span class="y">${esc(m.y)}${MM.isTv(m.tmdb) ? " · Series" : ""}</span></button></li>`).join("")}</ul>
    <p class="hint" style="font-size:12px">Tap one to add it to your map.</p>`;
  box.querySelectorAll("button").forEach(b=>b.onclick = ()=>{ const m = list[+b.dataset.i]; pendingLog = {tmdb:m.tmdb, t:m.t, y:m.y}; location.hash = "#/log"; });
}
function closeDetail(){ detail.hidden = true; selected = null; renderPins(); markListSelection(); }

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
$("#q").addEventListener("input", ()=>{ renderPins(); renderList(); });

async function renderCTA(){
  const cta = $("#cta"), ov = $("#overlap");
  ov.hidden = true; cta.innerHTML = "";
  const o = viewing.owner || {};
  if(viewing.mine){
    cta.innerHTML = `<a class="btn" href="#/log">Log a film</a><a class="btn ghost" href="#/import">Letterboxd</a><a class="btn ghost" href="#/poster">Poster</a>${cloud() ? `<button class="btn ghost" id="share">Share</button>` : ""}`;
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
  if(viewing.films.length){ const a = document.createElement("a"); a.className = "btn ghost"; a.href = "#/poster"; a.textContent = "Poster"; cta.append(a); }
  if(o.letterboxd){ const a = document.createElement("a"); a.className = "btn ghost"; a.href = "https://letterboxd.com/" + encodeURIComponent(o.letterboxd) + "/"; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Letterboxd ↗"; cta.append(a); }
}
function renderAll(){ setOwnerHeader(); renderPins(); renderList(); renderCTA(); }

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

/* ================= rail views ================= */
function showPanel(id){
  ["map","explore","log","import","account","poster"].forEach(v=>$("#view-"+v).hidden = v !== id);
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
    ready.push(Object.assign({t:e.t, y:e.y || d.y, d:d.d, tmdb:d.tmdb, poster:d.poster, r:e.r || null, rv:e.rv ? 1 : 0, watched:/^\d{4}-\d{2}-\d{2}$/.test(e.watched||"") ? e.watched : ""}, s));
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
  return (d.films || []).map(f=>({t:f.title, y:f.year || "", r:f.rating || null, watched:f.watched || "", tmdb:f.tmdb}));
}
// Every film on the member's Films page (all pages), including ones never logged in the diary.
async function fetchLetterboxdFilms(username, maxPages, onPage){
  const all = [];
  for(let page=1; page<=maxPages; page++){
    const d = await lbInvoke({username, mode:"films", page});
    if(d.films && d.films.length && d.films[0].slug === undefined) throw new Error("old_function");   // the deployed function predates list support
    all.push(...(d.films || []).map(f=>({t:f.title, y:f.year || "", r:f.rating || null, slug:f.slug})));
    onPage && onPage(page, all.length);
    if(!d.more) break;
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
      if(merged.has(k)){ const m = merged.get(k); if(m.r == null && e.r) m.r = e.r; m.slug = m.slug || e.slug; }
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
    if(added && viewing.mine){ viewing.films = myFilms; renderAll(); fitPins(true); }
    if(byId.size && (added || !quiet)) toast(`${added ? `Added ${added} from Letterboxd. ` : ""}${byId.size} need${byId.size===1?"s":""} a pin: see the Letterboxd tab`);
    else if(added) toast(`Added ${added} film${added===1?"":"s"} from Letterboxd`);
    else if(!quiet) toast("You're up to date with Letterboxd");
    return {added, total:all.length};
  }catch(e){
    if(!quiet) toast(LB_ERRORS[e.message] || "Sync didn't go through. Try again.");
    return {error:e.message};
  }finally{ syncing = false; }
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
    <p class="hint">Connect your Letterboxd username and every film you've watched shows up on your map. New ones are added automatically when you open MovieMap. It reads your public Letterboxd profile, so there's no password involved.</p>
    ${cloud() ? `
    ${lb && !lbEditing ? `
    <div class="linked">
      <div style="min-width:0"><small>Linked profile</small><b><a href="https://letterboxd.com/${esc(lb)}/" target="_blank" rel="noopener">letterboxd.com/${esc(lb)}</a></b></div>
      <div class="cta"><button class="btn ghost" type="button" id="lbchange">Change profile</button></div>
    </div>
    <p class="hint" id="lbs">New films are added automatically.${last ? " Last checked " + new Date(last).toLocaleString([], {dateStyle:"medium", timeStyle:"short"}) + "." : ""}</p>`
    : `
    <form class="search" id="lbf"><label for="lbu" class="sr">Letterboxd username</label><input id="lbu" autocomplete="off" spellcheck="false" placeholder="your Letterboxd username" value="${lbEditing ? "" : esc(lb||"")}"><button class="btn" type="submit">Connect</button>${lbEditing ? `<button class="btn ghost" type="button" id="lbcancel">Cancel</button>` : ""}</form>
    <p class="hint" id="lbs">${lbEditing ? `Currently linked to letterboxd.com/${esc(lb)}. Films already on your map stay there.` : "Your Letterboxd profile needs to be public."}</p>`}
    ${rep ? `<div class="box">
      <p class="ok" style="margin:0"><b>${rep.total} title${rep.total===1?"":"s"}</b> on your Letterboxd${missing.length ? `, <b>${missing.length}</b> still need${missing.length===1?"s":""} a pin` : ", all on your map"}.</p>
      ${missing.length ? `<p class="hint">We couldn't work out where ${missing.length===1 ? "this one takes" : "these take"} place. Tap Place it to pin ${missing.length===1 ? "it" : "each one"} yourself.</p>
      <ul class="results">${missing.map((m,i)=>`<li><button data-i="${i}"><span class="th" ${m.poster ? `style="background-image:url('${MM.poster(m.poster,"w92")}')"` : ""}></span><span style="min-width:0"><b>${esc(m.t)} <span class="m">${esc(m.y)}</span></b><span class="m" style="color:var(--rust)">Place it →</span></span></button></li>`).join("")}</ul>` : ""}
    </div>` : ""}
    <p class="hint">Connecting reads your whole Letterboxd films list, which takes a minute for big libraries. After that MovieMap checks for new films by itself. Your profile has to be public. Anything that doesn't come through can be added with <a href="#/log">Log a film</a>.</p>`
    : `<p class="notice">${sb ? '<a href="#/account">Sign in</a> to connect your Letterboxd username.' : "Accounts aren't switched on for this site yet."}</p>`}`;
  el.querySelectorAll(".results button").forEach(b=>b.onclick = ()=>{ pendingLog = missing[+b.dataset.i]; location.hash = "#/log"; });
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
  const starter = `<a class="ucard" href="#/u/${FEATURED.username}"><span class="avatar" style="background:${MM.avatarColor(FEATURED.username)}">${FEATURED.name[0]}</span><span style="min-width:0"><b>${esc(FEATURED.name)}</b><span class="m">Starter map · hand-checked settings</span></span><em><b>${FEATURED.films.length}</b><br>films</em></a>`;
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
    if(name === FEATURED.username) return showMap(FEATURED, FEATURED.films, false);
    showMap({name:"Not found", username:name, bio:"No one has this username."}, [], false);
    return;
  }
  if(a === "explore"){ setNav("explore"); showPanel("explore"); if(!viewing.owner) showFeaturedOrMine(); return renderExplore(); }
  if(a === "log"){ setNav("log"); showPanel("log"); return renderLog(); }
  if(a === "import"){ setNav("import"); showPanel("import"); return renderImport(); }
  if(a === "poster"){ setNav(""); showPanel("poster"); if(!viewing.owner) showFeaturedOrMine(); return renderPoster(); }
  if(a === "account"){ setNav("account"); showPanel("account"); if(!viewing.owner) showFeaturedOrMine(); return renderAccount(); }
  setNav("home"); showPanel("map"); showFeaturedOrMine();
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
