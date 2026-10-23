// TheMovieMap: find where a film or series is set by reading the places linked in its Wikipedia plot.
// Free and AI-free: Wikipedia plot summaries link the places they mention, and linked places have coordinates.
// Runs in the visitor's browser (Wikipedia's API allows this with origin=*).
(function(){
const API = "https://en.wikipedia.org/w/api.php";
const PLOT = /^(plot|plot summary|synopsis|premise|summary|story|storyline|overview|series overview|episodes?)$/i;
// Places too big to be a "setting" on their own.
const TOO_BIG = new Set(["europe","asia","africa","north america","south america","latin america","oceania","antarctica","the americas","americas","middle east","the middle east","western europe","eastern europe","central europe","southeast asia","east asia","south asia","central asia","caribbean","the caribbean","scandinavia","balkans","the balkans","mediterranean sea","atlantic ocean","pacific ocean","indian ocean","arctic ocean","earth","world","the world","space","outer space","moon","mars"]);

// Natural features have coordinates but aren't really "where a story is set".
const NATURAL = /( river| mountains| mountain range| range| desert| falls| ocean| sea| gulf| strait| glacier| rainforest)$|^(gulf|strait|sea|bay) of |^(andes|alps|himalayas|sahara|amazon)$/i;

async function wiki(params){
  const q = new URLSearchParams(Object.assign({format:"json", formatversion:"2", origin:"*"}, params));
  const r = await fetch(API + "?" + q);
  if(!r.ok) throw new Error("wiki-" + r.status);
  return r.json();
}

// The English Wikipedia article for this title: via Wikidata when we have its id, else a careful search.
async function findArticle(det){
  if(det.qid && /^Q\d+$/.test(det.qid)){
    try{
      const r = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${det.qid}&props=sitelinks&sitefilter=enwiki&format=json&origin=*`);
      const t = (await r.json())?.entities?.[det.qid]?.sitelinks?.enwiki?.title;
      if(t) return t;
    }catch(e){}
  }
  const kind = det.tv ? "TV series" : "film";
  const d = await wiki({action:"query", list:"search", srsearch:`${det.t} ${det.y || ""} ${kind}`, srlimit:"5"});
  const want = MM.norm(det.t), alt = MM.norm(det.ot);
  // Only accept a page whose title is this title (optionally with "(2023 film)" etc.), so we never read the wrong plot.
  const hit = (d.query?.search || []).find(s=>{
    const base = MM.norm(s.title.replace(/\s*\([^)]*\)\s*$/, ""));
    return base === want || (alt && base === alt);
  });
  return hit ? hit.title : null;
}

// Wikitext of the plot section (or the lead section if there's no plot section).
async function plotWikitext(page){
  const s = await wiki({action:"parse", page, prop:"sections", redirects:"1"});
  const secs = s.parse?.sections || [];
  const plot = secs.find(x=>PLOT.test(String(x.line).replace(/<[^>]+>/g, "").trim()));
  const section = plot ? plot.index : "0";
  const w = await wiki({action:"parse", page, prop:"wikitext", section, redirects:"1"});
  return {text: w.parse?.wikitext || "", fromPlot: !!plot};
}

// Score each linked place: how often it (or its displayed name) appears, how early, and how specific it is.
function linkCandidates(wikitext){
  const body = wikitext.replace(/<ref[\s\S]*?(<\/ref>|\/>)/g, "").replace(/\{\{[^{}]*\}\}/g, "");
  const cands = new Map();
  const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;
  let m;
  while((m = re.exec(body))){
    const target = m[1].trim();
    if(/^(file|image|category|wikt|wiktionary):/i.test(target)) continue;
    const shown = (m[2] || m[1]).replace(/'''?/g, "").trim();
    const c = cands.get(target) || {target, shown:new Map(), links:0, first:m.index};
    c.links++; c.shown.set(shown, (c.shown.get(shown) || 0) + 1);
    cands.set(target, c);
  }
  const plain = body.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1");
  cands.forEach(c=>{
    const names = new Set([c.target.replace(/\s*\([^)]*\)$/, ""), ...c.shown.keys()].map(n=>n.split(",")[0].trim()).filter(n=>n.length > 2));
    let mentions = 0;
    names.forEach(n=>{ const r = new RegExp("\\b" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "g"); mentions = Math.max(mentions, (plain.match(r) || []).length); });
    c.mentions = Math.max(mentions, c.links);
    c.pos = c.first / Math.max(1, body.length);
  });
  return [...cands.values()];
}

async function coordinates(titles){
  const out = new Map();
  for(let i=0; i<titles.length; i+=50){
    const d = await wiki({action:"query", prop:"coordinates", titles:titles.slice(i, i+50).join("|"), redirects:"1", colimit:"max"});
    const back = new Map(); (d.query?.redirects || []).forEach(r=>back.set(r.to, r.from)); (d.query?.normalized || []).forEach(r=>back.set(r.to, r.from));
    (d.query?.pages || []).forEach(p=>{
      const c = (p.coordinates || []).find(x=>x.globe === "earth" || !x.globe);
      if(!c) return;
      let t = p.title; const orig = new Set([t]);
      while(back.has(t)){ t = back.get(t); orig.add(t); }
      orig.forEach(o=>out.set(o, {lat:c.lat, lon:c.lon, title:p.title}));
    });
  }
  return out;
}

const countryNames = () => new Set(Object.keys(MM.centroids).map(n=>n.toLowerCase()));
function isCountry(title){
  const t = title.toLowerCase().replace(/\s*\([^)]*\)$/, "");
  return countryNames().has(t) || countryNames().has(MM.geoName(t).toLowerCase()) || /^(kingdom|republic|empire|state) of /.test(t) || /(empire|soviet union|nazi germany|east germany|west germany|yugoslavia|czechoslovakia)$/.test(t);
}
// Country containing a point. Coastal cities can fall just outside the simplified shapes, so look nearby too.
function countryAt(lon, lat){
  const feats = MM.worldFeatures || [];
  const offsets = [[0,0],[0.15,0],[-0.15,0],[0,0.15],[0,-0.15],[0.35,0],[-0.35,0],[0,0.35],[0,-0.35],[0.35,0.35],[-0.35,-0.35],[0.35,-0.35],[-0.35,0.35]];
  for(const [dx,dy] of offsets){
    const f = feats.find(c=>d3.geoContains(c, [lon + dx, lat + dy]));
    if(f) return MM.displayCountry(f.properties.name);
  }
  return "";
}

MM.wikiPlotSetting = async function(det){
  if(!det || !det.t) return null;
  const page = await findArticle(det);
  if(!page) return null;
  const {text, fromPlot} = await plotWikitext(page);
  if(!text) return null;
  const cands = linkCandidates(text).filter(c=>!TOO_BIG.has(c.target.toLowerCase()) && !NATURAL.test(c.target.replace(/\s*\([^)]*\)$/, "").split(",")[0].trim()));
  if(!cands.length) return null;
  const coords = await coordinates(cands.map(c=>c.target));
  const places = cands.filter(c=>coords.has(c.target)).map(c=>{
    const country = isCountry(c.target);
    const score = c.mentions * (country ? 1 : 3) + (1 - c.pos) * 1.5;
    return Object.assign(c, coords.get(c.target), {country, score});
  });
  if(!places.length) return null;
  places.sort((a,b)=>b.score - a.score);
  const specific = places.filter(p=>!p.country);
  // A specific place wins unless a country is mentioned far more often (a story spread across one country).
  const best = specific.length && specific[0].score * 1.6 >= places[0].score ? specific[0] : places[0];
  const shown = [...best.shown.entries()].sort((a,b)=>b[1]-a[1])[0][0];
  const label = shown.replace(/\s*\([^)]*\)$/, "");
  const country = best.country ? MM.displayCountry(label) : countryAt(best.lon, best.lat);
  const others = specific.filter(p=>p !== best).slice(0, 2).map(p=>[...p.shown.keys()][0]);
  return {
    p: label, c: country || "", cont: "",
    lat: +best.lat.toFixed(3), lon: +best.lon.toFixed(3),
    ap: best.country || !fromPlot ? 1 : 0,
    n: `Set in ${label}, from the Wikipedia ${fromPlot ? "plot summary" : "article"}.` + (others.length ? ` Also mentions ${others.join(" and ")}.` : ""),
    src: "wikipedia"
  };
};
})();
