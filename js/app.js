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

/* ================= accounts (Supabase) ================= */
const sb = (CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && window.supabase) ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;
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
  MM.saveRemoteSettings = async map => {
    if(!session) return;
    const rows = Object.keys(map).map(id=>{ const s = map[id]; return {tmdb_id:+id, place:s.p, country:s.c, continent:s.cont||null, lat:s.lat, lon:s.lon, approx:!!s.ap, note:s.n||null, source:s.src}; });
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
      const {error} = await sb.from("logs").update({lat:row.lat, lon:row.lon, approx:row.approx, place:row.place, country:row.country, rating:row.rating, source:row.source}).eq("id", f.id);
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
const gRoot = svg.append("g"), gLand = gRoot.append("g"), gPins = gRoot.append("g");
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
  renderPins();
}
const zoom = d3.zoom().scaleExtent([1,40]).on("zoom", ev=>{
  gRoot.attr("transform", ev.transform); k = ev.transform.k;
  gPins.selectAll(".pin.film").attr("transform", d=>`translate(${d.x},${d.y}) scale(${1/k})`);
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
function filtered(){
  const q = ($("#q").value||"").toLowerCase().trim();
  return q ? viewing.films.filter(f=>[f.t,f.p,f.c,f.d].join(" ").toLowerCase().includes(q)) : viewing.films;
}
function renderPins(){
  if(!projection) return;
  const list = filtered();
  const groups = groupFilms(list);
  const pins = gPins.selectAll("g.pin.film").data(groups, d=>d.key).join(enter=>{
    const g = enter.append("g").attr("class","pin film").attr("tabindex",0).attr("role","button");
    g.append("circle").attr("class","dot"); g.append("text"); return g;
  });
  pins.classed("approx", d=>d.ap).classed("sel", d=>!!selected && d.films.includes(selected))
    .attr("aria-label", d=>d.films.map(f=>f.t).join(", "))
    .attr("transform", d=>`translate(${d.x},${d.y}) scale(${1/k})`)
    .on("click", (ev,d)=>{ ev.stopPropagation(); openGroup(d); })
    .on("keydown", (ev,d)=>{ if(ev.key==="Enter"||ev.key===" "){ ev.preventDefault(); openGroup(d); } });
  pins.select("circle").attr("r", d=>d.films.length>1 ? Math.min(16, 9 + Math.log2(d.films.length)*2) : 7);
  pins.select("text").text(d=>d.films.length>1 ? d.films.length : "");
  const visited = new Set(viewing.films.map(f=>MM.geoName(f.c)));
  gLand.selectAll("path.country").classed("visited", d=>visited.has(d.properties.name));
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
      <div><div class="place">${esc([f.p, f.p!==f.c ? f.c : ""].filter(Boolean).join(", "))}</div><div class="coord">${fmtCoord(f.lat, f.lon)}</div></div>
      ${f.n ? `<p class="note">${esc(f.n)}</p>` : ""}
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${f.r ? `<span class="stars">${stars(f.r)}</span>` : ""}${f.rv ? '<span class="tag">Reviewed</span>' : ""}${f.ap ? '<span class="tag ap">Approx. setting</span>' : ""}${f.watched ? `<span class="tag" style="color:var(--muted)">Watched ${esc(f.watched)}</span>` : ""}</div>
      ${mine ? `<div class="cta"><button class="btn ghost small" id="d-move">Move pin</button><button class="btn ghost small" id="d-del">Remove</button></div>` : ""}
      ${f.tmdb ? `<a class="linkbtn" href="https://www.themoviedb.org/movie/${encodeURIComponent(f.tmdb)}" target="_blank" rel="noopener">Film page on TMDB ↗</a>` : ""}
    </div>`;
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
  $("#s-films").textContent = viewing.films.length;
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
    ul.innerHTML = `<li class="empty">${viewing.films.length ? "No films match that filter." : viewing.mine ? 'No films yet. <a href="#/log">Log a film</a> or <a href="#/import">bring in your Letterboxd history</a>.' : "No films logged yet."}</li>`;
    return;
  }
  ul.innerHTML = list.map((f,i)=>`<li><button data-i="${i}"><span class="bar ${f.ap?"ap":""}"></span><span class="th" data-i="${i}" data-t="${esc(f.t)}"></span><span style="min-width:0"><b>${esc(f.t)}</b><span class="meta">${esc(f.p || f.c)}${f.c && f.p && f.p!==f.c ? ", " + esc(f.c) : ""}</span></span><span class="r">${stars(f.r)}<em>${esc(f.y)}</em></span></button></li>`).join("");
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
    cta.innerHTML = `<a class="btn" href="#/log">Log a film</a><a class="btn ghost" href="#/import">Letterboxd</a>${cloud() ? `<button class="btn ghost" id="share">Share</button>` : ""}`;
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
  if(o.letterboxd){ const a = document.createElement("a"); a.className = "btn ghost"; a.href = "https://letterboxd.com/" + encodeURIComponent(o.letterboxd) + "/"; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Letterboxd ↗"; cta.append(a); }
}
function renderAll(){ setOwnerHeader(); renderPins(); renderList(); renderCTA(); }

function showMap(owner, films, mine){
  viewing = {owner, films, mine};
  selected = null; detail.hidden = true; $("#q").value = "";
  renderAll(); fitPins(true);
}
function showMine(){
  const owner = me ? Object.assign({}, me) : {name:"Your map", username:"", bio:"Saved in this browser"};
  showMap(owner, myFilms, true);
}

/* ================= rail views ================= */
function showPanel(id){
  ["map","explore","log","import","account"].forEach(v=>$("#view-"+v).hidden = v !== id);
}
function setNav(name){ document.querySelectorAll(".nav a, .acct").forEach(a=>a.setAttribute("aria-current", a.dataset.nav === name ? "page" : "false")); }
function paintAccountLink(){ $("#acct-link").textContent = me ? "@" + me.username : (sb ? "Sign in" : "Account"); }

/* ---------- log a film: search TMDB, pick the right one, we find the setting ---------- */
let draft = null, draftRating = null, searchT = null, searchSeq = 0;
function renderLog(){
  showMine_keepView();
  const el = $("#log");
  el.innerHTML = `<h2 class="h">Log a film</h2>
    <div class="search"><label for="lq" class="sr">Film title</label><input id="lq" type="search" autocomplete="off" placeholder="Search a title, e.g. Belén"></div>
    <p class="hint" id="ls">Start typing and pick the right film. We'll work out where it takes place.</p>
    <ul class="results" id="lr"></ul>
    <div id="lc" hidden></div>
    ${!cloud() ? `<p class="notice">${sb ? 'You\'re not signed in, so films save in this browser only. <a href="#/account">Sign in</a> to keep them on your account.' : "Films save in this browser."}</p>` : ""}`;
  const q = $("#lq");
  q.addEventListener("input", ()=>{ clearTimeout(searchT); searchT = setTimeout(()=>runSearch(q.value.trim()), 280); });
  q.focus({preventScroll:true});
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
    ul.innerHTML = res.map((m,i)=>`<li><button data-i="${i}"><span class="th" ${m.poster ? `style="background-image:url('${MM.poster(m.poster,"w92")}')"` : ""}></span><span style="min-width:0"><b>${esc(m.t)} <span class="m">${esc(m.y)}</span></b><span class="m">${m.ot && m.ot!==m.t ? esc(m.ot) : ""}</span>${mk.has(MM.filmKey(m)) ? '<br><span class="have">On your map</span>' : ""}</span></button></li>`).join("");
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
    const det = await MM.filmDetails(m.tmdb);
    const [s] = await MM.resolveSettings([det]);
    st.classList.remove("busy");
    draft = Object.assign({t:det.t, y:det.y, d:det.d, tmdb:det.tmdb, poster:det.poster}, s || {p:"", c:"", lat:NaN, lon:NaN, ap:1, n:"", src:""});
    draft.watched = new Date().toISOString().slice(0,10);
    draftRating = null;
    st.textContent = s ? "Check the setting, rate it, then pin it." : "We couldn't find where this one is set. Tap Place pin, then tap the map.";
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
    ${placed ? `<div><b>${esc([f.p, f.p!==f.c ? f.c : ""].filter(Boolean).join(", "))}</b><div class="hint" style="font-family:var(--f-mono);font-size:12px">${fmtCoord(f.lat,f.lon)}${f.ap ? " · approximate" : ""}</div></div>` : ""}
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

/* ---------- Letterboxd import ---------- */
let importing = false;
function renderImport(){
  showMine_keepView();
  const el = $("#import");
  const lb = me && me.letterboxd;
  el.innerHTML = `<h2 class="h">Letterboxd</h2>
    <p class="hint">Letterboxd doesn't let other sites sign in to your account, so MovieMap reads your Letterboxd export instead. It brings in every film you've marked watched, with your ratings, and we find where each one takes place.</p>
    <ol class="steps">
      <li>Open <a href="https://letterboxd.com/settings/data/" target="_blank" rel="noopener">Letterboxd → Settings → Data</a> and choose <b>Export your data</b>.</li>
      <li>Drop the .zip file it downloads here. No need to unzip it.</li>
    </ol>
    <label class="drop" id="drop" for="lbfile"><b>Choose your Letterboxd .zip</b><br>or drag it here</label>
    <input type="file" id="lbfile" accept=".zip,.csv,application/zip,text/csv" multiple hidden>
    <div id="imp" hidden></div>
    <p class="notice"><b>Syncing later:</b> export again and drop the new file. Films already on your map are skipped, so only new ones get added.${lb ? ` Linked to <a href="https://letterboxd.com/${esc(lb)}/" target="_blank" rel="noopener">letterboxd.com/${esc(lb)}</a>.` : ""}</p>
    ${!cloud() ? `<p class="notice">${sb ? '<a href="#/account">Sign in</a> first to save imported films to your account. Otherwise they stay in this browser.' : "Imported films save in this browser."}</p>` : ""}`;
  const input = $("#lbfile"), drop = $("#drop");
  input.onchange = ()=>{ if(input.files.length) runImport([...input.files]); };
  ["dragenter","dragover"].forEach(t=>drop.addEventListener(t, e=>{ e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave","drop"].forEach(t=>drop.addEventListener(t, e=>{ e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e=>{ const fs = [...(e.dataTransfer.files||[])]; if(fs.length) runImport(fs); });
}
async function runImport(files){
  if(importing) return; importing = true;
  const box = $("#imp"); box.hidden = false;
  box.innerHTML = `<div class="box"><p class="hint busy" id="ip-t">Reading your export…</p><div class="progress"><i id="ip-b"></i></div><p class="hint" id="ip-n"></p></div>`;
  const T = s=>$("#ip-t") && ($("#ip-t").textContent = s), B = p=>$("#ip-b") && ($("#ip-b").style.width = Math.round(p*100) + "%"), N = s=>$("#ip-n") && ($("#ip-n").textContent = s);
  try{
    const entries = await MM.readLetterboxd(files);
    if(!entries.length){ box.innerHTML = `<p class="err">That file doesn't look like a Letterboxd export. Choose the .zip from Settings → Data → Export your data.</p>`; return; }
    await reloadMine();
    const have = myKeys();
    const todo = entries.filter(e=>!have.has(MM.filmKey(e)));
    const skipped = entries.length - todo.length;
    if(!todo.length){ box.innerHTML = `<p class="ok">All ${entries.length} films from your export are already on your map.</p>`; return; }
    T(`Matching ${todo.length} films…`);
    let done = 0;
    const dets = await MM.pool(todo, 6, async e=>{
      const m = await MM.matchFilm(e.t, e.y);
      const d = m ? await MM.filmDetails(m.id) : null;
      done++; B(done/todo.length*0.8); N(`${done} of ${todo.length}`);
      return d;
    });
    T("Finding where each film takes place…"); N("");
    const settings = await MM.resolveSettings(dets.filter(Boolean));
    B(0.92);
    const setBy = new Map(dets.filter(Boolean).map((d,i)=>[d.tmdb, settings[i]]));
    const ready = [], unmatched = [], unplaced = [];
    todo.forEach((e,i)=>{
      const d = dets[i];
      if(!d){ unmatched.push(e); return; }
      const s = setBy.get(d.tmdb);
      if(!s){ unplaced.push(e); return; }
      ready.push(Object.assign({t:e.t, y:e.y || d.y, d:d.d, tmdb:d.tmdb, poster:d.poster, r:e.r, rv:e.rv, watched:/^\d{4}-\d{2}-\d{2}$/.test(e.watched) ? e.watched : ""}, s));
    });
    T("Saving to your map…");
    const {added} = await Store.add(ready);
    B(1);
    await reloadMine();
    if(me && !me.letterboxd) {/* nothing to link automatically: the export doesn't include the username */}
    const approx = ready.filter(f=>f.ap).length;
    box.innerHTML = `<div class="box">
      <p class="ok"><b>Added ${added} film${added===1?"":"s"}</b> to your map.${skipped ? ` ${skipped} were already there.` : ""}</p>
      ${approx ? `<p class="hint">${approx} are pinned approximately (dashed pins) because no exact setting is on record. Open one and tap Move pin to fix it.</p>` : ""}
      ${unmatched.length || unplaced.length ? `<details><summary class="hint">${unmatched.length + unplaced.length} couldn't be placed</summary><p class="hint">${[...unmatched, ...unplaced].slice(0,60).map(e=>esc(e.t) + (e.y ? " (" + esc(e.y) + ")" : "")).join(", ")}${unmatched.length + unplaced.length > 60 ? "…" : ""}</p><p class="hint">Log these by hand from Log a film.</p></details>` : ""}
      <a class="btn" href="#/">See your map</a></div>`;
  }catch(e){
    box.innerHTML = `<p class="err">${e.message === "tmdb-auth" ? "The film database key isn't working, so films couldn't be matched." : e.message && e.message.includes("storage") ? esc(e.message) : "The import stopped partway. Your progress is cached, so dropping the file again picks up quickly."}</p>`;
  }finally{ importing = false; }
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
      <label class="field" for="p-lb">Letterboxd username<input id="p-lb" maxlength="30" value="${esc(p.letterboxd||"")}" placeholder="shown on your profile"></label>
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
    const lb = $("#p-lb").value.trim().replace(/^@/,"").replace(/^https?:\/\/(www\.)?letterboxd\.com\//,"").replace(/\/.*$/,"");
    if(lb && !/^[A-Za-z0-9_]{1,30}$/.test(lb)){ e.textContent = "That Letterboxd username has characters Letterboxd doesn't allow."; e.hidden = false; return; }
    const disc = $("#p-disc").checked;
    const patch = {display_name:$("#p-name").value.trim(), bio:$("#p-bio").value.trim(), letterboxd: lb || null, discoverable: disc};
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
async function onAuth(newSession, event){
  session = newSession;
  await loadMe();
  if(cloud()) await moveLocalFilms();
  await reloadMine();
  paintAccountLink();
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
