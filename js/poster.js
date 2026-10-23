// TheMovieMap poster: draws a print-ready poster of a map onto a canvas.
// Numbered pins on a world map, with a key of places and titles underneath.
(function(){
const SIZES = {
  "18x24": {label:"18 × 24 in", w:3600, h:4800, pdf:{unit:"in", format:[18,24]}},
  "a2":    {label:"A2 (42 × 59.4 cm)", w:3600, h:5091, pdf:{unit:"mm", format:"a2"}},
  "a3":    {label:"A3 (29.7 × 42 cm)", w:3600, h:5091, pdf:{unit:"mm", format:"a3"}}
};
// Four takes on the site's Drive-In look: pine green, marquee yellow, red, white.
const THEMES = {
  drivein: {label:"Drive-In", bg:"#FFFFFF", band:"#0E3B2C", bandInk:"#FFFFFF", bandSub:"#FFC93C", bandRule:"#FFC93C", ink:"#0E3B2C", muted:"#3F6457", rule:"#0E3B2C",
    ocean:"#D9E6DF", land:"#FFFFFF", border:"#B9CDC3", vline:"#0E3B2C", grat:"#C9DAD1", visited:"#FFC93C", pin:"#C8281C", series:"#0E3B2C", ring:"#FFFFFF", num:"#FFFFFF", seriesNum:"#FFC93C", keynum:"#C8281C"},
  pine:    {label:"Pine", bg:"#0E3B2C", band:"#FFC93C", bandInk:"#0E3B2C", bandSub:"#0E3B2C", bandRule:"#C8281C", ink:"#FFFFFF", muted:"#A9C7BA", rule:"#FFC93C",
    ocean:"#0A2E22", land:"#1C5240", border:"#2C634F", vline:"#0A2E22", grat:"#134434", visited:"#FFC93C", pin:"#C8281C", series:"#FFFFFF", ring:"#0E3B2C", num:"#FFFFFF", seriesNum:"#0E3B2C", keynum:"#FFC93C"},
  marquee: {label:"Marquee", bg:"#FFC93C", band:"#0E3B2C", bandInk:"#FFC93C", bandSub:"#FFFFFF", bandRule:"#C8281C", ink:"#0E3B2C", muted:"#5A4A12", rule:"#0E3B2C",
    ocean:"#F2B526", land:"#FFF1C4", border:"#D79E14", vline:"#0E3B2C", grat:"#E9AC22", visited:"#0E3B2C", pin:"#C8281C", series:"#FFFFFF", ring:"#FFC93C", num:"#FFFFFF", seriesNum:"#0E3B2C", keynum:"#C8281C"},
  boxoffice:{label:"Box Office", bg:"#C8281C", band:"#0E3B2C", bandInk:"#FFFFFF", bandSub:"#FFC93C", bandRule:"#FFC93C", ink:"#FFFFFF", muted:"#FFDAD5", rule:"#FFFFFF",
    ocean:"#A81F15", land:"#E2584B", border:"#B8291E", vline:"#0E3B2C", grat:"#B5251A", visited:"#FFC93C", pin:"#0E3B2C", series:"#FFFFFF", ring:"#FFFFFF", num:"#FFFFFF", seriesNum:"#C8281C", keynum:"#FFC93C"}
};
MM.POSTER_SIZES = SIZES; MM.POSTER_THEMES = THEMES;

// Archivo throughout, heavy for display, as on the site.
const SANS = `"Archivo", "Helvetica Neue", Arial, sans-serif`;
const F = {
  display: w => `900 ${w}px ${SANS}`,
  body: (w, wt) => `${wt||400} ${w}px ${SANS}`,
  mono: (w, wt) => `${wt||700} ${w}px ${SANS}`
};
MM.posterFontsReady = async function(){
  try{
    await Promise.all(["900 100px Archivo","700 100px Archivo","600 100px Archivo","400 100px Archivo"].map(f=>document.fonts.load(f)));
    await document.fonts.ready;
  }catch(e){}
};
// The site's mark: a pin projected on an outdoor-cinema screen.
function drawMark(ctx, x, y, s, T){
  const k = s / 32;
  ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
  ctx.fillStyle = T.bandSub; ctx.fillRect(2, 6, 28, 15);
  ctx.globalAlpha = .55; ctx.beginPath(); ctx.moveTo(8, 21); ctx.lineTo(24, 21); ctx.lineTo(27, 28); ctx.lineTo(5, 28); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
  ctx.fillStyle = "#C8281C"; ctx.fill(new Path2D("M16 8.5c-2.7 0-4.9 2.1-4.9 4.7 0 3.5 4.9 7.3 4.9 7.3s4.9-3.8 4.9-7.3c0-2.6-2.2-4.7-4.9-4.7Z"));
  ctx.fillStyle = T.bandSub; ctx.beginPath(); ctx.arc(16, 13.2, 1.7, 0, Math.PI*2); ctx.fill();
  ctx.restore();
}

function fitText(ctx, text, font, maxW, startPx, minPx){
  let px = startPx;
  ctx.font = font(px);
  while(ctx.measureText(text).width > maxW && px > minPx){ px -= 4; ctx.font = font(px); }
  return px;
}
function ellipsize(ctx, text, maxW){
  if(ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while(s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s.trimEnd() + "…";
}
function spaced(ctx, text, x, y, spacing){   // letter-spaced label
  for(const ch of text){ ctx.fillText(ch, x, y); x += ctx.measureText(ch).width + spacing; }
}

/**
 * opts: {title, subtitle, films, countries (topojson features), theme, size, showKey, isSeries(f), geoName(c), url}
 */
MM.renderPoster = function(opts){
  const S = SIZES[opts.size] || SIZES["18x24"], T = THEMES[opts.theme] || THEMES.drivein;
  const W = S.w, H = S.h, M = Math.round(W * 0.06);
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = T.bg; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "alphabetic";

  // ---- header: a masthead band, like the site's
  const bandH = 220;
  ctx.fillStyle = T.band; ctx.fillRect(0, 0, W, bandH);
  ctx.fillStyle = T.bandRule; ctx.fillRect(0, bandH, W, 18);
  drawMark(ctx, M, bandH/2 - 60, 120, T);
  ctx.fillStyle = T.bandInk; ctx.font = F.display(84);
  ctx.fillText("THEMOVIEMAP", M + 150, bandH/2 + 4);
  ctx.fillStyle = T.bandSub; ctx.font = F.body(40, 500);
  ctx.fillText("See the world one film at a time", M + 152, bandH/2 + 58);
  let y = bandH + 18 + 70;
  const title = opts.title;
  if("letterSpacing" in ctx) ctx.letterSpacing = "-4px";
  const tpx = fitText(ctx, title.toUpperCase(), F.display, W - 2*M, 300, 120);
  y += tpx * 0.9;
  ctx.fillStyle = T.ink; ctx.font = F.display(tpx); ctx.fillText(title.toUpperCase(), M - tpx*0.02, y);
  if("letterSpacing" in ctx) ctx.letterSpacing = "0px";
  y += 90;
  ctx.font = F.body(64, 400); ctx.fillStyle = T.muted;
  ctx.fillText(ellipsize(ctx, opts.subtitle, W - 2*M), M, y);
  y += 70;

  // ---- map
  const mapW = W - 2*M, mapH = Math.round(mapW * 0.5);
  const mapTop = y;
  const proj = d3.geoEqualEarth().fitExtent([[M, mapTop], [M + mapW, mapTop + mapH]], {type:"Sphere"});
  const path = d3.geoPath(proj, ctx);
  ctx.beginPath(); path({type:"Sphere"}); ctx.fillStyle = T.ocean; ctx.fill();
  ctx.beginPath(); path(d3.geoGraticule10()); ctx.strokeStyle = T.grat; ctx.lineWidth = 2; ctx.stroke();
  const visited = new Set(opts.films.map(f=>opts.geoName(f.c)).filter(n=>n !== "Antarctica"));
  opts.countries.forEach(c=>{
    ctx.beginPath(); path(c);
    ctx.fillStyle = visited.has(c.properties.name) ? T.visited : T.land; ctx.fill();
    ctx.strokeStyle = T.border; ctx.lineWidth = 1.6; ctx.stroke();
  });
  // Countries with films get an ink outline, as on the site.
  opts.countries.forEach(c=>{ if(!visited.has(c.properties.name)) return; ctx.beginPath(); path(c); ctx.strokeStyle = T.vline; ctx.lineWidth = 3; ctx.stroke(); });
  ctx.beginPath(); path({type:"Sphere"}); ctx.strokeStyle = T.rule; ctx.lineWidth = 6; ctx.stroke();

  // One pin per place (films at the same spot share it), numbered west to east so the key reads like the map.
  const R = 30, groups = [];
  opts.films.filter(f=>isFinite(f.lat) && isFinite(f.lon)).forEach(f=>{
    let g = groups.find(g=>Math.abs(g.lat - f.lat) < 0.35 && Math.abs(g.lon - f.lon) < 0.35);
    if(!g){ g = {lat:f.lat, lon:f.lon, films:[]}; groups.push(g); }
    g.films.push(f);
  });
  groups.forEach(g=>{ [g.x0, g.y0] = proj([g.lon, g.lat]); g.x = g.x0; g.y = g.y0; });
  groups.sort((a,b)=>a.x0 - b.x0 || a.y0 - b.y0).forEach((g,i)=>{
    g.n = i + 1;
    const places = [...new Set(g.films.map(f=>f.p || f.c))];
    g.place = places.join(" · ");
    const c = g.films[0].c || "";
    g.country = c && !places.some(p=>p.includes(c)) ? c : "";
  });
  // Nudge overlapping pins apart; each keeps a thin leader line to its true spot.
  for(let it=0; it<120; it++){
    let moved = false;
    for(let i=0; i<groups.length; i++) for(let j=i+1; j<groups.length; j++){
      const a = groups[i], b = groups[j];
      let dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
      const min = 2*R + 6;
      if(d < min){
        if(d < 0.01){ dx = 1; dy = 0; d = 1; }
        const push = (min - d) / 2;
        a.x -= dx/d*push; a.y -= dy/d*push; b.x += dx/d*push; b.y += dy/d*push; moved = true;
      }
    }
    // gentle pull back toward the true spot
    groups.forEach(g=>{ g.x += (g.x0 - g.x) * 0.02; g.y += (g.y0 - g.y) * 0.02; });
    if(!moved) break;
  }
  groups.forEach(g=>{
    if(Math.hypot(g.x - g.x0, g.y - g.y0) > 8){
      ctx.beginPath(); ctx.moveTo(g.x0, g.y0); ctx.lineTo(g.x, g.y); ctx.strokeStyle = T.ink; ctx.globalAlpha = .55; ctx.lineWidth = 3; ctx.stroke(); ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(g.x0, g.y0, 7, 0, Math.PI*2); ctx.fillStyle = T.ink; ctx.fill();
    }
  });
  groups.forEach(g=>{
    const series = g.films.every(opts.isSeries);
    const approx = g.films.every(f=>f.ap);
    ctx.beginPath();
    if(series) ctx.roundRect(g.x - R, g.y - R, 2*R, 2*R, 8); else ctx.arc(g.x, g.y, R, 0, Math.PI*2);
    ctx.fillStyle = series ? T.series : T.pin; ctx.fill();
    ctx.lineWidth = 6; ctx.strokeStyle = T.ring; ctx.setLineDash(approx ? [10, 7] : []); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = series ? T.seriesNum : T.num; ctx.font = F.mono(g.n > 99 ? 22 : 28, 700); ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(g.n), g.x, g.y + 1);
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  });
  y = mapTop + mapH + 90;

  // ---- key
  const footH = 150;
  const keyBottom = H - M - footH;
  if(opts.showKey && groups.length){
    ctx.fillStyle = T.rule; ctx.fillRect(M, y - 40, W - 2*M, 6);
    const cols = 3, gap = 70, colW = (W - 2*M - gap*(cols-1)) / cols;
    const rowH = 132;
    const maxRows = Math.max(1, Math.floor((keyBottom - y) / rowH));
    const rows = Math.min(maxRows, Math.ceil(groups.length / cols));   // balance the columns
    const cap = cols * rows;
    const shown = groups.length > cap ? groups.slice(0, cap - 1) : groups;
    shown.forEach((g,i)=>{
      const col = Math.floor(i / rows), row = i % rows;
      const x = M + col * (colW + gap), yy = y + row * rowH + 40;
      ctx.fillStyle = T.keynum; ctx.font = F.mono(36, 800);
      ctx.fillText(String(g.n).padStart(2, "0"), x, yy);
      const tx = x + 92, tw = colW - 92;
      ctx.fillStyle = T.ink; ctx.font = F.body(40, 700);
      ctx.fillText(ellipsize(ctx, g.place + (g.country ? ", " + g.country : ""), tw), tx, yy);
      ctx.fillStyle = T.muted; ctx.font = F.body(34, 400);
      ctx.fillText(ellipsize(ctx, g.films.map(f=>f.t).join(" · "), tw), tx, yy + 48);
    });
    if(groups.length > cap){
      const i = cap - 1, col = Math.floor(i / rows), row = i % rows;
      ctx.fillStyle = T.muted; ctx.font = F.body(40, 600);
      ctx.fillText(`+ ${groups.length - cap + 1} more places`, M + col * (colW + gap) + 92, y + row * rowH + 40);
    }
  }

  // ---- footer
  const fy = H - M;
  ctx.fillStyle = T.rule; ctx.fillRect(M, fy - footH + 40, W - 2*M, 6);
  ctx.fillStyle = T.muted; ctx.font = F.body(40, 400);
  ctx.fillText(opts.url || "", M, fy - 20);
  const date = new Date().toLocaleDateString("en-US", {month:"long", year:"numeric"});
  ctx.textAlign = "right"; ctx.fillText(date, W - M, fy - 20); ctx.textAlign = "left";
  return cv;
};
function spacedRight(ctx, text, right, y, spacing){
  ctx.textAlign = "left";
  let w = 0; for(const ch of text) w += ctx.measureText(ch).width + spacing;
  spaced(ctx, text, right - w + spacing, y, spacing);
}
})();
