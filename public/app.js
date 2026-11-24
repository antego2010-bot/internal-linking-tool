(() => {
// ================= Vercel version: settings, storage, server API =================
const SKEY = "il:settings";
function loadSettings() {
  let s = {};
  try { s = JSON.parse(sessionStorage.getItem(SKEY) || localStorage.getItem(SKEY) || "{}"); } catch (e) {}
  return { moz: "", claude: "", model: "", domain: "", brand: "", sections: "", size: 1000, mozRows: 1000, volumeLimit: 200, remember: false, ...s };
}
let CFG = loadSettings();
function saveSettings() {
  const data = JSON.stringify(CFG), site = JSON.stringify({ ...CFG, moz: "", claude: "" });
  try {
    if (CFG.remember) { localStorage.setItem(SKEY, data); sessionStorage.removeItem(SKEY); }
    else { sessionStorage.setItem(SKEY, data); localStorage.setItem(SKEY, site); }
  } catch (e) {}
}
function siteDomain() { return String(CFG.domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""); }
function brandName() { return (CFG.brand || "").split(",")[0].trim() || (siteDomain() ? siteDomain().split(".")[0].replace(/^./, c => c.toUpperCase()) : "your site"); }
const listOf = (s) => String(s || "").split(/[,\n]+/).map(x => x.trim()).filter(Boolean);
const num = (v) => { if (v === "" || v == null) return null; const n = Number(String(v).replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
function sectionOf(path) {
  const p = String(path || "").toLowerCase();
  if (/^\/(blog|news|articles?|posts?|insights|resources\/blog)(\/|$)/.test(p)) return "Blog";
  if (/^\/(products?|pricing|features?|tools?|solutions?|platform|app)(\/|$)/.test(p)) return "Product";
  if (/^\/(beginners?-guide|guides?)/.test(p)) return "Guide";
  if (/^\/(learn|academy|resources|glossary|docs|help|courses?)(\/|$)/.test(p)) return "Learn";
  const seg = p.split("/")[1] || "home";
  return seg.charAt(0).toUpperCase() + seg.slice(1).replace(/-/g, " ");
}
const typeRank = (t) => TYPE_RANK[t] || 4;

class ApiError extends Error { constructor(message, code, status) { super(message); this.code = code; this.status = status; } }
async function api(path, payload, opts = {}) {
  const headers = { "content-type": "application/json" };
  if (CFG.moz) headers["x-moz-token"] = CFG.moz;
  if (CFG.claude) headers["x-claude-key"] = CFG.claude;
  let reqBody = payload === undefined ? undefined : JSON.stringify(payload);
  if (reqBody && opts.gzip) {
    reqBody = await new Response(new Blob([reqBody]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    if (reqBody.byteLength > 4_300_000) throw new ApiError("Your Search Console file is too big to send in one go (over 4 MB compressed). Export a shorter date range or fewer rows, then upload it again.", "too_large", 413);
    headers["content-type"] = "application/octet-stream"; headers["x-body-encoding"] = "gzip";
  }
  const res = await fetch("/api/" + path, { method: payload === undefined ? "GET" : "POST", headers, body: reqBody, signal: opts.signal, credentials: "same-origin" });
  if (res.ok && res.headers.get("x-library-encoding") === "gzip") return await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).json();
  let data = null; try { data = await res.json(); } catch (e) {}
  if (!res.ok) { const er = (data && data.error) || {}; throw new ApiError(er.message || `Request failed (${res.status})`, er.code || "http_" + res.status, res.status); }
  return data;
}
const IDB = (() => {
  let p = null;
  const open = () => p || (p = new Promise((res, rej) => { const r = indexedDB.open("internal-linking-tool", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
  const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction("kv", mode); const req = fn(t.objectStore("kv")); t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); };
  return { get: (k) => tx("readonly", s => s.get(k)).catch(() => null), set: (k, v) => tx("readwrite", s => s.put(v, k)), del: (k) => tx("readwrite", s => s.delete(k)).catch(() => null) };
})();
const K = { lib: () => "lib:" + siteDomain(), up: () => "upload:" + siteDomain(), index: () => "index:" + siteDomain() };
const dbSave = (k, v) => IDB.set(k, v).catch(() => toast("Couldn't save in this browser (storage full or private mode)."));
const ST = { site: null, building: false, buildMsg: "", buildError: null, up: {}, meta: null, loadedAt: null, indexInfo: null, mock: false, indexing: null, indexError: null, traffic: "Clicks (3 mo)" };

// ================= library + index =================
function libFromInv(inv) {
  const ix = (c) => inv.cols.indexOf(c);
  const iU = ix("URL"), iS = ix("Section"), iT = ix("Page title"), iK = ix("Target keyword"), iP = ix("Primary topic"), iC = ix("Clicks (3 mo)"), iI = ix("Impressions (3 mo)"), iPos = ix("Avg position"), iSe = ix("Sessions (12 mo)"), iTop = ix("Top URL for (keyword library)"), iV = ix("Target keyword volume");
  const g = (r, i) => i >= 0 ? r[i] : "";
  const out = [], seen = new Set();
  for (const r of inv.rows) {
    const u = normPath(g(r, iU)); if (!u || seen.has(u)) continue;
    const host = (() => { try { return new URL(String(g(r, iU))).hostname.replace(/^www\./, ""); } catch (e) { return siteDomain(); } })();
    if (siteDomain() && host && host !== siteDomain()) continue;
    seen.add(u);
    const clicks = num(g(r, iC)), sessions = num(g(r, iSe));
    const kws = [String(g(r, iK) || ""), ...String(g(r, iTop) || "").split(/,\s*/)].map(s => s.trim()).filter(Boolean);
    const title = String(g(r, iT) || "").trim(), topic = String(g(r, iP) || "").trim();
    if (!title && !kws.length && !topic) continue;
    out.push({ u, type: String(g(r, iS) || "") || sectionOf(u), title: title || topic || u, kw: kws[0] || "", kws: [...new Set(kws)], topic, clicks, sessions, impr: num(g(r, iI)), pos: num(g(r, iPos)), vol: num(g(r, iV)) });
  }
  return out;
}
function setLibrary(rec) {
  ST.meta = rec ? rec.meta : null; ST.loadedAt = rec ? rec.loadedAt : null;
  const lib = rec && rec.data && rec.data.inv ? libFromInv(rec.data.inv) : [];
  const hasClicks = lib.some(r => r.clicks != null), hasSess = lib.some(r => r.sessions != null);
  ST.traffic = hasClicks ? "Clicks (3 mo)" : hasSess ? "Sessions (12 mo)" : "Clicks (3 mo)";
  lib.forEach(r => { r.c = hasClicks ? r.clicks : hasSess ? r.sessions : null; });
  lib.sort((a, b) => typeRank(a.type) - typeRank(b.type) || (b.c || 0) - (a.c || 0));
  S.lib = lib; S.libByPath = new Map();
  S.lib.forEach((r, i) => { r.id = "L" + (i + 1); S.libByPath.set(r.u, r); });
  document.querySelectorAll("th").forEach(th => { th.textContent = th.textContent.replace(/Clicks \(3 mo\)|Sessions \(12 mo\)/, ST.traffic); });
  if (S.index.length) S.index.forEach(p => { const l = S.libByPath.get(p.u); p.c = l ? l.c : null; if (l && l.type) p.s = l.type; });
  A.data = null; A.byPath = new Map(); A.inited = false;
  renderLibHeader();
}
function setIndex(pages, info) {
  S.index = pages; S.indexByPath = new Map();
  S.index.forEach(p => { const l = S.libByPath.get(p.u); p.s = l && l.type ? l.type : sectionOf(p.u); p.c = l ? l.c : null; annotate(p); S.indexByPath.set(p.u, p); });
  S.ready = true; ST.indexInfo = info;
  const blocks = S.index.reduce((a, p) => a + p.b.length, 0);
  $("s-meta").textContent = `Searches ${fmt(blocks)} paragraphs on ${fmt(S.index.length)} pages.`;
  A.data = null; A.byPath = new Map(); A.inited = false;
  renderLibHeader();
}
async function loadIndex() {
  const d = siteDomain(); if (!d) return false;
  let info;
  try { info = await api("site/index?domain=" + encodeURIComponent(d)); } catch (e) { return false; }
  if (!info || !info.ready) return false;
  const cached = await IDB.get(K.index());
  if (cached && cached.version === info.version && Array.isArray(cached.pages)) { setIndex(cached.pages, info); return true; }
  setStatus("busy", `Downloading the content index for ${esc(d)}…`);
  let u8;
  if (info.url) u8 = new Uint8Array(await (await fetch(info.url, { cache: "no-store" })).arrayBuffer());
  else { const bin = atob(info.inline); u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); }
  const text = u8[0] === 0x1f && u8[1] === 0x8b ? await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"))).text() : new TextDecoder().decode(u8);
  const pages = JSON.parse(text);
  dbSave(K.index(), { version: info.version, pages });
  setIndex(pages, info);
  return true;
}
function renderLibHeader() {
  const d = siteDomain();
  $("brand-sub").textContent = d ? `Two-way internal link suggestions for ${d}` : "Two-way internal link suggestions for any site · bring your own Moz and Claude keys";
  document.querySelectorAll("[data-site]").forEach(el => el.textContent = d || "your site");
  updateStatus();
}
function updateStatus() {
  const miss = [!CFG.moz && !ST.mock && "Moz API token", !siteDomain() && "your site's domain"].filter(Boolean);
  if (ST.building) return setStatus("busy", esc(ST.buildMsg || "Building the library…"));
  if (miss.length) return setStatus("busy", "Settings needed: " + esc(miss.join(", ")));
  const parts = [];
  parts.push(S.ready ? `Index: ${fmt(S.index.length)} pages${ST.indexInfo && ST.indexInfo.partial ? " (still indexing)" : ""}` : "Index: not built yet");
  parts.push(S.lib.length ? `Library: ${fmt(S.lib.length)} URLs` : "Library: not built yet");
  const age = ST.loadedAt ? (Date.now() - new Date(ST.loadedAt)) / 864e5 : 0;
  setStatus(S.ready && S.lib.length ? (age > 35 ? "busy" : "ok") : "busy", `${esc(siteDomain())} · ${parts.join(" · ")}${age > 35 ? " · over a month old, rebuild" : ""}${!CFG.claude && !ST.mock ? " · add a Claude key for suggestions" : ""}`);
}
function needSetup(what) {
  const miss = [];
  if (!S.ready) miss.push("the content index");
  if (what !== "index" && !S.lib.length) miss.push("the URL library");
  if (what !== "index" && !CFG.claude && !ST.mock) miss.push("a Claude API key");
  if (!miss.length) return false;
  toast("Set up " + miss.join(" and ") + " in Settings first.");
  return true;
}

// ================= audit, worked out in the browser =================
const GENERIC_A = /^(here|click here|this|this post|this article|this guide|this page|read more|learn more|more|link|post|article|guide|source|study|report|research|see here|find out more|our guide|full guide|this study|this report|this one|website|site|blog post|page)$/i;
const STOPA = new Set("a an and are as at be by for from how in into is it its of on or our the this to vs what when where which who why with you your guide best tips".split(" "));
const atoks = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter(w => w.length > 1 && !STOPA.has(w)).map(stemWord);
function computeAudit() {
  const brand = new Set([...listOf(CFG.brand), siteDomain().split(".")[0]].flatMap(atoks));
  const rows = new Map();
  const ensure = (u) => {
    if (rows.has(u)) return rows.get(u);
    const l = S.libByPath.get(u), pg = S.indexByPath.get(u);
    if (!l && !pg) return null;
    const r = { u, t: (l && l.title) || (pg && pg.t) || u, s: (l && l.type) || (pg && pg.s) || sectionOf(u), c: l ? l.c : null, pos: l ? l.pos : null, impr: l ? l.impr : null, kw: l ? l.kws : [], inst: [], src: new Set(), outSet: new Set(), ix: !!pg };
    r.kt = new Set([...r.kw.flatMap(atoks), ...atoks(r.t)]);
    rows.set(u, r); return r;
  };
  S.lib.forEach(l => ensure(l.u)); S.index.forEach(p => ensure(p.u));
  const conflicts = {};
  for (const pg of S.index) {
    const me = rows.get(pg.u);
    pg.b.forEach((b, i) => {
      if (!b[2] || pg.z[i] === "head") return;
      for (const [h, t0] of b[2]) {
        const u = normPath(h); if (u === pg.u) continue;
        const r = rows.get(u); if (!r) continue;
        me.outSet.add(u);
        if (pg.z[i] !== "body") continue;   // contextual links in article body text only
        const t = normQ(t0 || "").trim(), at = atoks(t);
        let cls = 3;
        if (!t || GENERIC_A.test(t)) cls = 1;
        else if (at.length && at.every(w => brand.has(w))) cls = 2;
        else if (at.some(w => r.kt.has(w))) cls = 0;
        else if (at.some(w => brand.has(w)) && !at.some(w => r.kt.has(w))) cls = 2;
        r.inst.push([pg.u, i, t, cls]); r.src.add(pg.u);
        if (cls !== 1 && t) { const k = t.toLowerCase(); (conflicts[k] || (conflicts[k] = {}))[u] = ((conflicts[k] || {})[u] || 0) + 1; }
      }
    });
  }
  Object.keys(conflicts).forEach(k => { if (Object.keys(conflicts[k]).length < 2) delete conflicts[k]; });
  // related pages: TF-IDF over title, headings and opening text, candidates from shared distinctive terms
  const docs = S.index.map(pg => {
    const tf = new Map(), add = (s, w) => atoks(s).forEach(t => tf.set(t, (tf.get(t) || 0) + w));
    add(pg.t, 3); let chars = 0;
    pg.b.forEach(b => { if (b[0] <= 1) add(b[1], 2); else if (chars < 1500) { add(b[1], 1); chars += b[1].length; } });
    return { u: pg.u, tf };
  });
  const df = new Map(); docs.forEach(d => d.tf.forEach((_, t) => df.set(t, (df.get(t) || 0) + 1)));
  const N = Math.max(1, docs.length), maxDf = Math.max(8, N * 0.05);
  const post = new Map();
  docs.forEach((d, di) => {
    const v = new Map(); let norm = 0;
    d.tf.forEach((n, t) => { const w = (1 + Math.log(n)) * Math.log(1 + N / (df.get(t) || 1)); v.set(t, w); norm += w * w; });
    norm = Math.sqrt(norm) || 1; v.forEach((w, t) => v.set(t, w / norm)); d.v = v;
    [...v.entries()].filter(([t]) => (df.get(t) || 0) <= maxDf && (df.get(t) || 0) > 1).sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([t]) => (post.get(t) || post.set(t, []).get(t)).push(di));
  });
  docs.forEach((d, di) => {
    const cand = new Set(); d.v.forEach((_, t) => (post.get(t) || []).forEach(j => { if (j !== di) cand.add(j); }));
    const sims = [...cand].map(j => { const o = docs[j]; let s = 0; const [a, b] = d.v.size < o.v.size ? [d.v, o.v] : [o.v, d.v]; a.forEach((w, t) => { const x = b.get(t); if (x) s += w * x; }); return [o.u, s]; }).filter(x => x[1] >= 0.2).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const r = rows.get(d.u);
    r.rel = sims.map(([u, s]) => [u, Math.round(s * 100) / 100, r.outSet.has(u), (rows.get(u) || { outSet: new Set() }).outSet.has(d.u)]);
    r.dup = sims.filter(x => x[1] >= 0.72).map(x => x[0]);
  });
  const out = [];
  rows.forEach(r => {
    r.rel = r.rel || []; r.dup = r.dup || [];
    r.in = r.inst.length; r.inP = r.src.size; r.out = r.outSet.size;
    r.exp = Math.max(2, Math.round(2 * Math.log10(10 + (r.c || 0))));
    r.a = [0, 0, 0, 0]; r.inst.forEach(x => r.a[x[3]]++);
    const tot = r.a.reduce((x, y) => x + y, 0);
    const relND = r.rel.filter(x => !r.dup.includes(x[0]));
    r.iss = { U: Math.max(0, (r.exp - r.inP) / r.exp), A: tot >= 3 ? (r.a[1] + r.a[2]) / tot : 0, G: relND.length ? relND.filter(x => !x[2] && !x[3]).length / relND.length : 0 };
    r.sk = r.pos != null && r.pos >= 4 && r.pos <= 20 && (r.impr || 0) >= 1000;
    r.q = Math.round((Math.log10(1 + (r.c || 0)) + 0.5) * (r.iss.U + 0.7 * r.iss.A + 0.5 * r.iss.G + (r.dup.length ? 0.3 : 0)) * 30) / 10;
    delete r.src; delete r.outSet; delete r.kt;
    out.push(r);
  });
  return { rows: out, conflicts };
}

// ================= settings view =================
const SIZE_INFO = { 500: "2–4 min", 1000: "5–8 min", 2500: "12–20 min", 5000: "25–40 min" };
function renderSettings() {
  $("set-moz").value = CFG.moz; $("set-claude").value = CFG.claude; $("set-domain").value = CFG.domain; $("set-brand").value = CFG.brand;
  $("set-sections").value = CFG.sections || ""; $("set-remember").checked = !!CFG.remember; $("set-vol").value = String(CFG.volumeLimit ?? 200);
  const sel = $("set-model");
  if (CFG.model && ![...sel.options].some(o => o.value === CFG.model)) sel.innerHTML = `<option value="${esc(CFG.model)}">${esc(CFG.model)}</option>` + sel.innerHTML;
  sel.value = CFG.model || "";
  renderSizes(); renderRows(); renderSite(); renderUploads(); renderDataBox(); renderCost(); updateStatus();
  if (!ST.site && siteDomain()) refreshSite();
}
async function loadModels() {
  const sel = $("set-model"), btn = $("set-models");
  if (!CFG.claude && !ST.mock) { toast("Paste your Claude API key first."); return; }
  btn.disabled = true; btn.textContent = "Loading…";
  try {
    const { models } = await api("models");
    const pref = (m) => /opus/i.test(m.id) ? 0 : /sonnet/i.test(m.id) ? 1 : 2;
    const list = models.slice().sort((a, b) => pref(a) - pref(b));
    sel.innerHTML = list.map(m => `<option value="${esc(m.id)}">${esc(m.name)} (${esc(m.id)})</option>`).join("");
    if (!CFG.model || !list.some(m => m.id === CFG.model)) CFG.model = (list.find(m => /sonnet/i.test(m.id)) || list[0] || {}).id || "";
    sel.value = CFG.model; saveSettings(); updateStatus(); toast(`${list.length} models available.`);
  } catch (e) { $("set-msg").textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = "Load models"; }
}
async function refreshSite() {
  const d = siteDomain(); if (!d) { ST.site = null; renderSite(); return; }
  try { ST.site = await api("site?domain=" + encodeURIComponent(d)); } catch (e) { ST.site = { error: e.message }; }
  renderSite();
}
function renderSizes() {
  const cur = Number(CFG.size) || 1000;
  $("set-sizes").innerHTML = `<table class="mini"><thead><tr><th></th><th>Pages</th><th>Time to finish</th><th>Moz API</th><th>Claude API</th></tr></thead><tbody>${[500, 1000, 2500, 5000].map(n => `<tr><td><input type="radio" name="set-size" value="${n}" ${n === cur ? "checked" : ""} aria-label="${n} pages"></td><td><b>${fmt(n)}</b></td><td>${SIZE_INFO[n]}</td><td>about 200 rows</td><td>none</td></tr>`).join("")}</tbody></table>
  <p class="hint">The crawl reads your public pages (sitemap first, respects robots.txt) and records their text and internal links, so every size costs the same: one Moz look-up of your top ranking pages to crawl them first, reused for 30 days. You can start once 300 pages are in; the rest keeps indexing while this page is open and overnight.</p>`;
  document.querySelectorAll('input[name="set-size"]').forEach(r => r.onchange = () => { CFG.size = Number(r.value); saveSettings(); renderSite(); });
}
function renderRows() {
  const cur = Number(CFG.mozRows) || 1000;
  $("set-rows").innerHTML = `<table class="mini"><thead><tr><th></th><th>Ranking keywords from Moz</th><th>Moz API per build</th></tr></thead><tbody>${[500, 1000, 2500, 5000].map(n => `<tr><td><input type="radio" name="set-rows" value="${n}" ${n === cur ? "checked" : ""} aria-label="${n} keywords"></td><td><b>${fmt(n)}</b> (by search volume)</td><td>up to ${fmt(n)} rows</td></tr>`).join("")}</tbody></table>`;
  document.querySelectorAll('input[name="set-rows"]').forEach(r => r.onchange = () => { CFG.mozRows = Number(r.value); saveSettings(); renderCost(); });
}
function renderCost() {
  const g = !!(ST.up && ST.up.gsc), rows = Number(CFG.mozRows) || 1000, vol = g ? Number(CFG.volumeLimit) || 0 : 0;
  $("set-cost").innerHTML = `<b>Estimated cost of one build</b>
    <div class="small">Moz API: up to <b>${fmt(rows + vol * 5)} rows</b> (${fmt(rows)} ranking keywords${g ? ` + search volume for up to ${fmt(vol)} Search Console keywords at up to 5 rows each` : ""}). Your plan's quota is shown in the Moz API dashboard.</div>
    <div class="small">Claude: none to build. Link suggestions use your Anthropic account: about one request per draft for "Links from this post" and one per 15 pages checked for "Links to this post", usually a few cents each.</div>`;
}
function renderSite() {
  const el = $("set-site"), s = ST.site;
  if (!siteDomain()) { el.innerHTML = '<span class="muted small">Enter your domain above.</span>'; $("set-index").hidden = true; return; }
  $("set-index").hidden = false;
  if (!s) { el.innerHTML = '<span class="muted small">Checking…</span>'; return; }
  if (s.error) { el.innerHTML = `<span class="src-bad small">${esc(s.error)}</span>`; return; }
  const parts = [];
  if (s.ready) parts.push(`<span class="pill ${s.fresh ? "good" : "warn"}">${fmt(s.pages)} pages indexed${s.partial ? " so far" : ""}</span> <span class="small muted">${s.partial ? "usable now, still indexing" : `crawled ${esc(String(s.crawledAt || "").slice(0, 10))}`}${s.cap ? ` · size ${fmt(s.cap)}` : ""}${(s.sections || []).length ? ` · paths ${esc(s.sections.join(", "))}` : ""}${s.fresh || s.partial ? "" : " · over 30 days old, re-index"}</span>`);
  else parts.push('<span class="pill warn">Not indexed yet</span> <span class="small muted">Building the library indexes it first.</span>');
  if (s.crawling) parts.push(`<span class="progress"><span class="spinner"></span>${ST.indexing ? "Indexing" : "Indexing paused (continues while this page is open, or tonight)"}: ${fmt(s.crawling.done)} of ${fmt(s.crawling.total)} URLs checked, ${fmt(s.crawling.pages)} pages kept</span>`);
  if (s.failed) parts.push(`<span class="src-bad small">${esc(s.failed)}</span>`);
  el.innerHTML = parts.join("<br>");
  const want = Number(CFG.size) || 1000, cur = s.cap || 0;
  $("set-index").textContent = s.crawling && !ST.indexing ? "Continue indexing" : s.ready && cur === want ? "Re-index now" : s.ready ? `Re-index at ${fmt(want)} pages` : `Index my site (${fmt(want)} pages)`;
  $("set-index").disabled = !!ST.indexing;
}
function indexSite(onProgress, opts = {}) {
  const d = siteDomain(); if (!d) return Promise.reject(new ApiError("Enter your site's domain in Settings.", "no_domain"));
  const waitFor = (cond) => new Promise((resolve, reject) => {
    const check = () => { const s = ST.site; if (s && cond(s)) return resolve(s); if (ST.indexError) return reject(ST.indexError); if (!ST.indexing) return s && s.ready ? resolve(s) : reject(new ApiError("Indexing stopped.", "crawl_stopped")); setTimeout(check, 800); };
    check();
  });
  if (!ST.indexing) {
    ST.indexError = null; let first = !!opts.restart;
    ST.indexing = (async () => {
      try {
        for (let i = 0; i < 400; i++) {
          const s = await api("site", { domain: d, cap: Number(CFG.size) || 1000, sections: CFG.sections || "", restart: first });
          first = false; ST.site = s; renderSite();
          if (onProgress) onProgress(s);
          if (s.failed && !s.ready) throw new ApiError(s.failed, "crawl_failed");
          if (s.ready && !s.crawling) return s;
        }
      } catch (e) { ST.indexError = e; throw e; }
      finally { ST.indexing = null; renderSite(); loadIndex().then(updateStatus); }
    })();
    ST.indexing.catch(() => {});
  }
  return opts.untilUsable ? waitFor(s => s.ready) : waitFor(s => s.ready && !s.crawling);
}

// ---- uploads: Search Console / GA4 exports, or a whole URL library ----
const hnorm = (h) => String(h ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const colOf = (h, names) => h.findIndex(x => names.includes(x));
const GSC_Q = ["query", "queries", "top queries", "search query", "keyword", "keywords"], GSC_P = ["page", "pages", "url", "landing page", "top pages", "address"];
const GA_P = ["pagepath", "page path", "page path and screen class", "landingpage", "landing page", "landing page query string", "pagelocation", "page location", "page", "url"];
const LIB_U = ["url", "page url", "address", "page", "link", "urls"], LIB_T = ["title", "page title", "post title", "h1", "name"], LIB_K = ["target keyword", "keyword", "primary keyword", "focus keyword", "main keyword", "keywords"], LIB_TOP = ["topic", "primary topic", "topic cluster", "cluster", "category"], LIB_TY = ["type", "section", "page type", "content type"], LIB_SES = ["sessions", "sessions 12 mo", "sessions last 12 months"], LIB_CL = ["clicks", "clicks 3 mo"];
function headerRow(aoa, test) { for (let i = 0; i < Math.min(aoa.length, 40); i++) { const h = (aoa[i] || []).map(hnorm); const m = test(h); if (m) return { i, m }; } return null; }
const hostOf = (u) => { try { return new URL(String(u)).hostname.replace(/^www\./, "").toLowerCase(); } catch (e) { return ""; } };
const startsCol = (h, names) => h.findIndex(x => names.some(n => x === n || x.startsWith(n + " ")));
function tableOf(aoa) {
  const head = (aoa[0] || []).map(h => String(h ?? "").trim()); let last = head.length; while (last > 0 && !head[last - 1]) last--;
  const cols = head.slice(0, last);
  return { cols, rows: aoa.slice(1).filter(r => r.some(c => c !== "" && c != null)).map(r => cols.map((_, i) => { const v = r[i]; return v == null ? "" : typeof v === "number" ? v : String(v); })) };
}
function loadXlsxLib() {
  if (window.XLSX) return Promise.resolve();
  return new Promise((res, rej) => { const s = document.createElement("script"); s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"; s.onload = res; s.onerror = () => rej(new Error("The spreadsheet library didn't load.")); document.head.appendChild(s); });
}
const INV_COLS = ["URL", "Section", "Topic cluster", "Primary topic", "Target keyword", "Target keyword volume", "Ranking status", "Clicks (3 mo)", "Impressions (3 mo)", "Avg position", "Sessions (12 mo)", "Overlap type", "Page title", "Published", "Intent", "Top URL for (keyword library)", "Competes for (keyword library)"];
async function readUploads(files) {
  await loadXlsxLib();
  const found = { gsc: null, ga4: null, lib: null, own: null }, notes = [];
  for (const file of files) {
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const names = wb.SheetNames;
    if (names.includes("URL Inventory")) { found.lib = { inv: tableOf(XLSX.utils.sheet_to_json(wb.Sheets["URL Inventory"], { header: 1, raw: true, defval: "" })), name: file.name }; continue; }
    for (const n of names) {
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: "" });
      const g = headerRow(aoa, h => { const q = colOf(h, GSC_Q), p = colOf(h, GSC_P), c = colOf(h, ["clicks"]), im = colOf(h, ["impressions", "impr"]), pos = colOf(h, ["position", "avg position", "average position", "avg pos"]); return q >= 0 && p >= 0 && c >= 0 && im >= 0 && pos >= 0 ? { q, p, c, im, pos } : null; });
      if (g) {
        const { q, p, c, im, pos } = g.m; const rows = found.gsc ? found.gsc.rows : [];
        for (const r of aoa.slice(g.i + 1)) { const ps = num(r[pos]); if (!r[q] || !r[p] || ps == null || ps > 20) continue; rows.push([String(r[q]).trim(), String(r[p]).trim(), num(r[c]) || 0, num(r[im]) || 0, Math.round(ps * 10) / 10]); }
        found.gsc = { rows, name: (found.gsc ? found.gsc.name + ", " : "") + `${file.name} › ${n}` }; continue;
      }
      const a = headerRow(aoa, h => { const p = colOf(h, GA_P), s = colOf(h, ["sessions"]); return p >= 0 && s >= 0 && colOf(h, LIB_T) < 0 ? { p, s } : null; });
      if (a) {
        const m = new Map(found.ga4 ? found.ga4.rows : []);
        for (const r of aoa.slice(a.i + 1)) { if (!r[a.m.p] || /^(total|grand total)/i.test(String(r[a.m.p]))) continue; const k = normPath(String(r[a.m.p]).replace(/^https?:\/\/[^/]+/, "")); m.set(k, (m.get(k) || 0) + (num(r[a.m.s]) || 0)); }
        found.ga4 = { rows: [...m.entries()], name: (found.ga4 ? found.ga4.name + ", " : "") + `${file.name} › ${n}` }; continue;
      }
      // Your own URL library: a URL column plus a title, keyword or topic column (one tab per page type is fine)
      const l = headerRow(aoa, h => { const u = colOf(h, LIB_U), t = colOf(h, LIB_T), k = startsCol(h, LIB_K), tp = startsCol(h, LIB_TOP); return u >= 0 && (t >= 0 || k >= 0 || tp >= 0) ? { u, t, k, tp, ty: colOf(h, LIB_TY), se: startsCol(h, LIB_SES), cl: startsCol(h, LIB_CL) } : null; });
      if (l) {
        const own = found.own || (found.own = { rows: [], names: [] }); own.names.push(`${file.name} › ${n}`);
        const typeOfTab = /^(sheet|tab)\s*\d*$/i.test(n) ? "" : n.trim();
        for (const r of aoa.slice(l.i + 1)) {
          const url = String(r[l.m.u] || "").trim(); if (!/^https?:\/\/|^\//.test(url)) continue;
          const row = INV_COLS.map(() => "");
          row[0] = /^\//.test(url) ? "https://" + (siteDomain() || "example.com") + url : url;
          row[1] = (l.m.ty >= 0 && r[l.m.ty]) ? String(r[l.m.ty]) : (typeOfTab || sectionOf(normPath(url)));
          row[3] = l.m.tp >= 0 ? String(r[l.m.tp] || "") : ""; row[4] = l.m.k >= 0 ? String(r[l.m.k] || "").split(/[,;|]/)[0].trim() : "";
          row[7] = l.m.cl >= 0 ? (num(r[l.m.cl]) ?? "") : ""; row[10] = l.m.se >= 0 ? (num(r[l.m.se]) ?? "") : "";
          row[12] = l.m.t >= 0 ? String(r[l.m.t] || "") : "";
          own.rows.push(row);
        }
        continue;
      }
      if (aoa.length > 1) notes.push(`${file.name} › ${n}`);
    }
  }
  return { found, notes };
}
async function useLibrary(inv, label) {
  const ui = inv.cols.indexOf("URL"), hosts = new Map();
  inv.rows.forEach(r => { const h = hostOf(r[ui]); if (h) hosts.set(h, (hosts.get(h) || 0) + 1); });
  const host = [...hosts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (host && host[0] !== siteDomain()) { CFG.domain = host[0]; saveSettings(); $("set-domain").value = CFG.domain; ST.site = null; refreshSite(); }
  const rec = { data: { inv }, meta: { domain: siteDomain(), builtAt: new Date().toISOString(), sources: [label] }, loadedAt: new Date().toISOString() };
  await dbSave(K.lib(), rec);
  setLibrary(rec); renderDataBox();
  if (!S.ready) await loadIndex().catch(() => false);
  if (S.ready) pageNotice(null, "");
  updateStatus();
  toast(`Library loaded: ${fmt(S.lib.length)} URLs.`);
}
async function onUpload(files) {
  const msg = (t, bad) => { $("set-uploads").innerHTML = `<span class="small ${bad ? "src-bad" : "muted"}">${esc(t)}</span>`; };
  if (!files.length) return;
  msg("Reading your file…");
  let res; try { res = await readUploads([...files]); } catch (e) { msg("Couldn't read that file: " + (e.message || e), true); return; }
  const { found, notes } = res;
  if (found.lib) { await useLibrary(found.lib.inv, `Uploaded library (${found.lib.name})`); renderUploads(); return; }
  if (found.own && !found.gsc) { await useLibrary({ cols: INV_COLS, rows: found.own.rows }, `Uploaded library (${found.own.names.join(", ")})`); renderUploads(); return; }
  if (!found.gsc && !found.ga4) { msg("No Search Console, GA4 or URL library data found. Search Console needs Query, Page, Clicks, Impressions and Position columns; GA4 needs a page path column and Sessions; a URL library needs a URL column and a title or keyword column." + (notes.length ? " Sheets checked: " + notes.join(", ") + "." : ""), true); return; }
  if (found.gsc && !siteDomain()) {
    const hosts = new Map(); found.gsc.rows.forEach(r => { const h = hostOf(r[1]); if (h) hosts.set(h, (hosts.get(h) || 0) + 1); });
    const host = [...hosts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (host) { CFG.domain = host[0]; saveSettings(); $("set-domain").value = CFG.domain; refreshSite(); await openSite(); }
  }
  if (found.gsc) ST.up.gsc = found.gsc;
  if (found.ga4) ST.up.ga4 = found.ga4;
  await dbSave(K.up(), ST.up);
  renderUploads(); renderCost(); updateStatus();
  toast("Saved in this browser. Build the library to use it.");
}
function renderUploads() {
  const el = $("set-uploads"); if (!el) return;
  const u = ST.up || {}, parts = [];
  if (u.gsc) parts.push(`<div class="small"><span class="pill good">Search Console</span> ${fmt(u.gsc.rows.length)} query × page rows (positions 1–20) from ${esc(u.gsc.name)} <button class="btn small" type="button" data-rm="gsc">Remove</button></div>`);
  if (u.ga4) parts.push(`<div class="small"><span class="pill good">GA4</span> sessions for ${fmt(u.ga4.rows.length)} pages from ${esc(u.ga4.name)} <button class="btn small" type="button" data-rm="ga4">Remove</button></div>`);
  el.innerHTML = parts.join("") || '<span class="small muted">No Search Console or GA4 file yet. Without one, the library uses Moz data only.</span>';
  el.querySelectorAll("[data-rm]").forEach(b => b.onclick = async () => { delete ST.up[b.dataset.rm]; await dbSave(K.up(), ST.up); renderUploads(); renderCost(); });
}
function renderDataBox() {
  const el = $("set-data");
  if (!siteDomain()) { el.innerHTML = '<span class="muted small">Enter your domain first.</span>'; return; }
  if (!S.lib.length) { el.innerHTML = `<span class="small muted">No URL library saved for ${esc(siteDomain())} in this browser yet.</span>`; return; }
  const m = ST.meta || {};
  const by = new Map(); S.lib.forEach(r => by.set(r.type, (by.get(r.type) || 0) + 1));
  el.innerHTML = `<div class="small"><b>${fmt(S.lib.length)} URLs</b> · ${[...by.entries()].sort((a, b) => typeRank(a[0]) - typeRank(b[0]) || b[1] - a[1]).slice(0, 8).map(([t, n]) => `${esc(t)} ${fmt(n)}`).join(" · ")}</div>
    <div class="small muted">Built ${esc(new Date(ST.loadedAt).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }))} from ${esc((m.sources || []).join(" · "))}</div>
    <div class="row"><button class="btn small" type="button" id="set-xlsx">Download .xlsx</button><button class="btn small" type="button" id="set-clear">Delete from this browser</button></div>`;
  $("set-xlsx").onclick = downloadXlsx;
  $("set-clear").onclick = async () => { await Promise.all([IDB.del(K.lib()), IDB.del(K.up())]); ST.up = {}; setLibrary(null); renderDataBox(); renderUploads(); toast("Library and uploaded files deleted from this browser."); };
}
async function downloadXlsx() {
  const rec = await IDB.get(K.lib()); if (!rec) return;
  try {
    await loadXlsxLib();
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([rec.data.inv.cols, ...rec.data.inv.rows]), "URL Inventory");
    XLSX.writeFile(wb, `${siteDomain()}-url-library-${String(rec.loadedAt).slice(0, 10)}.xlsx`);
  } catch (e) { toast(e.message || "Couldn't create the file."); }
}
function bindSettings() {
  const upd = () => {
    const before = siteDomain();
    CFG.moz = $("set-moz").value.trim(); CFG.claude = $("set-claude").value.trim(); CFG.domain = $("set-domain").value.trim(); CFG.brand = $("set-brand").value.trim();
    CFG.sections = $("set-sections").value.trim(); CFG.model = $("set-model").value; CFG.remember = $("set-remember").checked; CFG.volumeLimit = Number($("set-vol").value) || 0;
    saveSettings();
    if (siteDomain() !== before) { ST.site = null; refreshSite(); openSite(); }
    updateStatus(); renderCost(); renderLibHeader();
  };
  ["set-moz", "set-claude", "set-domain", "set-brand", "set-sections", "set-model", "set-remember", "set-vol"].forEach(id => $(id).addEventListener("change", upd));
  $("set-models").onclick = () => { upd(); loadModels(); };
  $("set-index").onclick = async () => {
    upd(); const s = ST.site || {};
    const restart = !(s.crawling && !ST.indexing) && (!!s.ready || !!s.crawling);
    try { await indexSite(null, { restart }); toast("Site indexed."); } catch (e) { $("set-msg2").textContent = e.message; }
  };
  $("set-build").onclick = () => { upd(); buildLib(); };
  $("set-upload").onchange = (e) => { onUpload(e.target.files); e.target.value = ""; };
  $("set-forget").onclick = () => { CFG.moz = ""; CFG.claude = ""; CFG.remember = false; try { sessionStorage.removeItem(SKEY); } catch (e) {} saveSettings(); renderSettings(); toast("Keys removed from this browser."); };
}
async function buildLib() {
  if (ST.building) return;
  const d = siteDomain();
  if (!d || (!CFG.moz && !ST.mock)) { toast("Add your Moz API token and domain first."); location.hash = "#settings"; return; }
  ST.building = true; ST.buildError = null; $("set-build").disabled = true;
  const t0 = Date.now(), say = (m) => { ST.buildMsg = m; $("set-build-msg").textContent = m; updateStatus(); };
  let tick;
  try {
    if (!ST.site) await refreshSite();
    if (!(ST.site && ST.site.ready)) {
      say("Indexing your site (text and internal links of every page)…");
      await indexSite(s => say(`Indexing your site: ${fmt(s.crawling ? s.crawling.pages : s.pages)} pages kept so far. The library is built once 300 are in.`), { untilUsable: true });
    }
    const up = ST.up || {};
    const steps = [up.gsc ? "Search Console" : null, up.ga4 ? "GA4" : null, "Moz ranking keywords"].filter(Boolean).join(", ");
    tick = setInterval(() => say(`Reading ${steps} and building the URL library… ${Math.round((Date.now() - t0) / 1000)}s (usually 1–3 minutes)`), 1000);
    const { library } = await api("library", {
      gscUpload: up.gsc ? { rows: up.gsc.rows, name: up.gsc.name } : undefined, ga4Upload: up.ga4 ? { rows: up.ga4.rows, name: up.ga4.name } : undefined,
      domain: d, brandTerms: listOf(CFG.brand).length ? listOf(CFG.brand) : [d.split(".")[0]], include: listOf(CFG.sections),
      mozRows: Number(CFG.mozRows) || 1000, volumeLimit: Number(CFG.volumeLimit) || 0,
    }, { gzip: !!(up.gsc || up.ga4) });
    clearInterval(tick);
    const rec = { data: { inv: library.inv }, meta: library.meta, loadedAt: library.meta.builtAt };
    await dbSave(K.lib(), rec);
    setLibrary(rec);
    say("Loading the content index…");
    await loadIndex();
    ST.building = false; say("");
    renderDataBox(); if (S.ready) pageNotice(null, ""); toast(`Library built: ${fmt(S.lib.length)} URLs. Add a draft to start.`);
  } catch (e) {
    clearInterval(tick); ST.buildError = e.message || String(e); $("set-build-msg").textContent = ST.buildError;
  } finally { ST.building = false; ST.buildMsg = ""; $("set-build").disabled = false; updateStatus(); }
}

// ================= boot =================
async function openSite() {
  S.ready = false; S.index = []; S.indexByPath = new Map(); setLibrary(null);
  S.draft = null; S.from = null; S.to = null; $("draft-loaded").hidden = true; renderFrom(); renderTo();
  if (!siteDomain()) { renderLibHeader(); return; }
  const [rec, up] = await Promise.all([IDB.get(K.lib()), IDB.get(K.up())]);
  ST.up = up && typeof up === "object" ? up : {};
  if (rec && rec.data) setLibrary(rec);
  setStatus("busy", "Loading the content index…");
  try { await loadIndex(); } catch (e) { pageNotice("err", `<p>The content index couldn't load (${esc(e.message || e)}). Reload the page, or re-index in Settings.</p>`); }
  updateStatus();
  if (S.ready) restoreLocal();
  if (!S.ready || !S.lib.length) pageNotice("warn", `<p>${!CFG.moz && !ST.mock ? "Start in Settings: add your Moz API token and your site's domain, then build the URL library." : !S.lib.length ? "Build or upload your URL library in Settings to get link suggestions." : "Your site's content index isn't ready yet: index it in Settings."}</p><a class="btn small" href="#settings">Open Settings</a>`);
  else pageNotice(null, "");
  if (location.hash === "#audit") renderAudit();
}

"use strict";
// ================= utilities =================
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MASK = "\u2022\u2022\u2022";
let DEMO = false;
try { DEMO = localStorage.getItem("ilDemo") === "1"; } catch (e) {}
const fmtS = (n) => DEMO ? MASK : fmt(n);           // traffic numbers, hidden in demo mode
const cv = (n) => DEMO ? "" : (n ?? "");            // traffic numbers in copied tables
const fmt = (n) => n == null || n === "" ? "–" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
const reDom = () => siteDomain().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const short = (u) => { const d = siteDomain(); return (d ? String(u || "").replace(new RegExp("^https?://(www\\.)?" + reDom() + "(?=/|$)", "i"), "") : String(u || "")) || "/"; };
const normPath = (u) => { let p = short(String(u || "").trim()).split("#")[0].split("?")[0]; if (p.length > 1) p = p.replace(/\/+$/, ""); return p || "/"; };
const full = (p) => /^https?:/.test(p) ? p : "https://" + (siteDomain() || "example.com") + p;
const linkTo = (p, label) => `<a href="${esc(full(p))}" target="_blank" rel="noopener">${esc(label ?? p)}</a>`;
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normQ = (s) => String(s || "").replace(/[‘’‛′]/g, "'").replace(/[“”″]/g, '"').replace(/[–—]/g, "-").replace(/ /g, " ");
const words = (s) => (String(s).match(/\S+/g) || []).length;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 3200); }
function setStatus(kind, html) { $("status").innerHTML = `<span class="dot ${kind}"></span>${html}`; }
function pageNotice(kind, html) { const n = $("page-notice"); if (!html) { n.hidden = true; return; } n.className = "notice " + (kind || ""); n.innerHTML = html; n.hidden = false; }
const TYPE_RANK = { Product: 1, BGuide: 2, Guide: 2, Learn: 3, Docs: 3, Resources: 3, Academy: 3, Blog: 5 };
const TYPE_LABEL = new Proxy({ BGuide: "Beginner's Guide" }, { get: (o, k) => (k in o ? o[k] : k) });
const KIND = ["h2", "h3", "p", "li", "quote", "td"];
const CONCL_RE = /^\s*(in\s+)?(conclusion|conclusions|final thoughts|closing thoughts|wrapping (it )?up|wrap[- ]up|to sum (it )?up|summing up|in summary|summary|the bottom line|bottom line|over to you|tl;?dr|parting thoughts|last words)\b/i;

// ================= state =================
const S = { meta: null, lib: [], libByPath: new Map(), index: [], indexByPath: new Map(), draft: null, target: "", from: null, to: null, ready: false };
let SAMPLE = null;

// ================= data loading =================
function annotate(pg) {
  // zones: intro (before first H2), body, concl (inside a conclusion-style H2 section)
  let seenH2 = false, zone = "intro", head = "";
  pg.z = new Array(pg.b.length); pg.hd = new Array(pg.b.length);
  pg.links = new Set();
  pg.b.forEach((b, i) => {
    if (b[0] === 0) { seenH2 = true; head = b[1]; zone = CONCL_RE.test(b[1]) ? "concl" : "body"; pg.z[i] = "head"; pg.hd[i] = head; return; }
    if (b[0] === 1) { pg.z[i] = "head"; pg.hd[i] = head; return; }
    pg.z[i] = seenH2 ? zone : "intro"; pg.hd[i] = head;
    if (b[2]) b[2].forEach(([h]) => pg.links.add(normPath(h)));
  });
}

// ================= draft parsing =================
async function inflateRaw(u8) { return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer()); }
async function unzip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("That file isn't a .docx (no zip directory found).");
  const n = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
  const files = {};
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nl));
    files[name] = { method, csize, off };
    p += 46 + nl + xl + cl;
  }
  return async (name) => {
    const f = files[name]; if (!f) return null;
    const lnl = dv.getUint16(f.off + 26, true), lxl = dv.getUint16(f.off + 28, true);
    const start = f.off + 30 + lnl + lxl, data = u8.subarray(start, start + f.csize);
    const out = f.method === 0 ? data : await inflateRaw(data);
    return new TextDecoder().decode(out);
  };
}
const kids = (el, name) => [...el.childNodes].filter(n => n.nodeType === 1 && n.localName === name);
const attr = (el, name) => { if (!el) return null; for (const a of el.attributes) if (a.localName === name) return a.value; return null; };
async function parseDocx(buf) {
  const get = await unzip(buf);
  const docXml = await get("word/document.xml"); if (!docXml) throw new Error("No document.xml in that file.");
  const relsXml = await get("word/_rels/document.xml.rels"), stylesXml = await get("word/styles.xml");
  const P = (s) => new DOMParser().parseFromString(s, "application/xml");
  const rels = {}; if (relsXml) for (const r of P(relsXml).getElementsByTagName("Relationship")) rels[r.getAttribute("Id")] = r.getAttribute("Target");
  const styles = {}; if (stylesXml) for (const s of P(stylesXml).getElementsByTagNameNS("*", "style")) { const nm = s.getElementsByTagNameNS("*", "name")[0]; styles[attr(s, "styleId")] = (attr(nm, "val") || "").toLowerCase(); }
  const doc = P(docXml), body = doc.getElementsByTagNameNS("*", "body")[0];
  const blocks = [];
  function paraText(p) {
    let text = ""; const links = [];
    const walk = (node, href) => {
      for (const c of node.childNodes) {
        if (c.nodeType !== 1) continue;
        const ln = c.localName;
        if (ln === "t") text += c.textContent;
        else if (ln === "tab" || ln === "br" || ln === "cr") text += " ";
        else if (ln === "hyperlink") { const id = attr(c, "id"); const h = id ? rels[id] : (attr(c, "anchor") ? "#" + attr(c, "anchor") : null); const s0 = text.length; walk(c, h); if (h) links.push({ href: h, text: text.slice(s0), s: s0, e: text.length }); }
        else if (ln === "pPr" || ln === "rPr" || ln === "instrText" || ln === "delText" || ln === "footnoteReference" || ln === "commentReference") continue;
        else walk(c, href);
      }
    };
    walk(p, null);
    return { text, links };
  }
  function addPara(p, inTable) {
    const pPr = kids(p, "pPr")[0];
    const sid = pPr ? attr(kids(pPr, "pStyle")[0], "val") : null;
    const sname = (sid && styles[sid]) || (sid || "").toLowerCase();
    const outl = pPr ? attr(kids(pPr, "outlineLvl")[0], "val") : null;
    const isList = pPr && kids(pPr, "numPr").length > 0;
    let k = inTable ? "td" : isList ? "li" : "p";
    const hm = sname.match(/heading\s*(\d)/) || (sid || "").match(/^Heading(\d)$/);
    if (sname === "title") k = "h1";
    else if (hm) k = "h" + Math.min(4, Number(hm[1]));
    else if (outl != null && !inTable) k = "h" + Math.min(4, Number(outl) + 1);
    const { text, links } = paraText(p);
    const raw = text.replace(/\s+/g, " ");
    if (!raw.trim()) return;
    // keep link offsets aligned after whitespace collapse: recompute by searching link text
    const t = raw.trim();
    const ls = links.filter(l => l.href && l.text.trim()).map(l => { const lt = l.text.replace(/\s+/g, " ").trim(); const s = t.indexOf(lt); return { href: l.href, text: lt, s, e: s < 0 ? -1 : s + lt.length }; });
    blocks.push({ k, text: t, links: ls });
  }
  for (const c of body.childNodes) {
    if (c.nodeType !== 1) continue;
    if (c.localName === "p") addPara(c, false);
    else if (c.localName === "tbl") for (const p of c.getElementsByTagNameNS("*", "p")) addPara(p, true);
    else if (c.localName === "sdt") for (const p of c.getElementsByTagNameNS("*", "p")) addPara(p, false);
  }
  return blocks;
}
function parsePaste(txt) {
  const blocks = [];
  for (let line of String(txt).split(/\r?\n/)) {
    line = line.trim(); if (!line) continue;
    let k = "p", m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { k = "h" + m[1].length; line = m[2]; }
    else if ((m = line.match(/^([-*•]|\d+[.)])\s+(.*)$/))) { k = "li"; line = m[2]; }
    const links = []; let text = "";
    let last = 0; const re = /\[([^\]]+)\]\(([^)\s]+)\)/g; let mm;
    while ((mm = re.exec(line))) { text += line.slice(last, mm.index); links.push({ href: mm[2], text: mm[1], s: text.length, e: text.length + mm[1].length }); text += mm[1]; last = re.lastIndex; }
    text += line.slice(last);
    blocks.push({ k, text: text.replace(/\s+/g, " ").trim(), links });
  }
  return blocks;
}
function buildDraft(blocks, source) {
  blocks = blocks.map((b, i) => ({ ...b, id: "B" + (i + 1), text: normQ(b.text), links: b.links.map(l => ({ ...l, text: normQ(l.text) })) }));
  // A Doc can hold a brief or outline before the article. The article starts at the LAST Title/H1.
  let start = -1;
  blocks.forEach((b, i) => { if (b.k === "h1") start = i; });
  if (start < 0) { const f = blocks.findIndex(b => b.text.length > 3); if (f >= 0 && blocks[f].text.length < 140 && !/^h[2-4]$/.test(blocks[f].k)) { blocks[f].k = "h1"; start = f; } }
  const d = { blocks, source, start: Math.max(0, start) };
  zoneDraft(d);
  return d;
}
function zoneDraft(d) {
  const blocks = d.blocks, start = d.start;
  const art = blocks.slice(start);
  d.title = art[0] && art[0].k === "h1" ? art[0].text : (art[0] ? art[0].text : "Untitled draft");
  let seenH2 = false, zone = "intro", head = "";
  const hasH2 = art.some(b => b.k === "h2");
  blocks.forEach((b, i) => {
    b.head = ""; b.sub = "";
    if (i < start) { b.zone = "brief"; return; }
    if (i === start && /^h/.test(b.k)) { b.zone = "title"; return; }
    if (b.k === "h1") { b.zone = "title"; return; }
    if (b.k === "h2" || (!hasH2 && b.k === "h3")) { seenH2 = true; head = b.text; zone = CONCL_RE.test(b.text) ? "concl" : "body"; b.zone = "head"; b.head = head; return; }
    if (/^h\d$/.test(b.k)) { b.zone = "head"; b.head = head; b.sub = b.text; return; }
    b.zone = seenH2 ? zone : "intro"; b.head = head;
  });
  const linksAll = art.flatMap(b => b.links.map(l => ({ ...l, block: b.id })));
  d.internal = [...new Set(linksAll.filter(l => /^\/(?!\/)/.test(l.href) || (siteDomain() && new RegExp("^https?://(www\\.)?" + reDom() + "(/|$)", "i").test(l.href))).map(l => normPath(l.href)))];
  d.words = art.filter(b => !/^h/.test(b.k)).reduce((a, b) => a + words(b.text), 0);
  return d;
}
function slugify(t) {
  return String(t).toLowerCase().replace(/^chapter\s+\d+\s*[-:–]\s*/, "").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(w => !["a", "an", "the", "and", "of", "to", "for", "in", "on", "with", "is", "are", "how", "what", "why"].includes(w) || false).slice(0, 7).join("-");
}

// ================= draft UI =================
function showDraft(d, opts = {}) {
  S.draft = d;
  if (!opts.keepResults) { S.from = null; S.to = null; }
  $("draft-loaded").hidden = false;
  $("d-title").textContent = d.title;
  const elig = d.blocks.filter(b => b.zone === "body").length;
  $("d-meta").textContent = `${fmt(d.words)} words · ${d.blocks.filter(b => b.k === "h2").length} H2 sections · ${elig} paragraphs and list items eligible for links · from ${d.source}`;
  if (!opts.keepUrl) {
    const stripBrand = (t) => String(t || "").toLowerCase().replace(/\s+[-|–—:]\s+[^-|–—:]{1,40}$/, "").trim();
    const guess = S.index.find(p => stripBrand(p.t) === d.title.toLowerCase() || p.t.toLowerCase() === d.title.toLowerCase());
    // a brief's SEO table often carries the planned URL: a "URL" cell followed by the path
    let briefUrl = "";
    d.blocks.slice(0, d.start).forEach((b, i, arr) => { if (/^url:?$/i.test(b.text.trim()) && arr[i + 1] && /^(https?:\/\/|\/)\S+$/.test(arr[i + 1].text.trim())) briefUrl = arr[i + 1].text.trim(); });
    $("d-url").value = guess ? full(guess.u) : briefUrl ? full(normPath(briefUrl)) : full("/blog/" + slugify(d.title));
  }
  S.target = normPath($("d-url").value);
  const starts = d.blocks.map((b, i) => [b, i]).filter(([b]) => /^h[12]$/.test(b.k));
  $("d-start").innerHTML = starts.map(([b, i]) => `<option value="${i}" ${i === d.start ? "selected" : ""}>${b.k.toUpperCase()} · ${esc(b.text.slice(0, 90))}</option>`).join("");
  $("d-start-wrap").hidden = starts.length < 2;
  $("d-brief").textContent = d.start > 0 ? `${d.start} blocks above the article (brief or outline) are ignored.` : "";
  $("d-outline").innerHTML = d.blocks.filter(b => b.zone !== "brief" && /^h[234]$/.test(b.k)).map(b => `<div class="${b.k === "h2" ? "h2" : "h3"}">${esc(b.text)}${b.zone === "head" && CONCL_RE.test(b.text) && b.k === "h2" ? ' <span class="pill warn">conclusion · no links</span>' : ""}</div>`).join("") || '<div class="muted small">No headings found. The first paragraph is treated as the introduction.</div>';
  const intro = d.blocks.filter(b => b.zone === "intro").length;
  $("d-links").innerHTML = `<div class="small muted">Introduction: ${intro} block${intro === 1 ? "" : "s"} (no links). ${d.internal.length ? `</div><details class="small muted"><summary>${d.internal.length} existing internal link${d.internal.length === 1 ? "" : "s"}, excluded from suggestions</summary><div style="margin-top:6px">${d.internal.map(p => linkTo(p, p)).join("<br>")}</div></details>` : "No internal links in the draft yet.</div>"}`;
  renderFrom(); renderTo();
  saveLocal();
}
async function loadFile(file) {
  if (!file) return;
  if (!/\.docx$/i.test(file.name)) { toast("Choose a .docx file, or paste the text."); return; }
  try { showDraft(buildDraft(await parseDocx(await file.arrayBuffer()), file.name)); toast("Draft loaded."); }
  catch (e) { pageNotice("err", `<p>Couldn't read that file: ${esc(e.message || e)}</p>`); }
}
async function loadGdoc() {
  const url = $("gdoc").value.trim();
  if (!/^https?:\/\//.test(url)) { toast("Paste a Google Doc link or a page URL."); return; }
  const btn = $("gdoc-btn"); btn.disabled = true; btn.textContent = "Loading…";
  try {
    const out = await api("page", { url });
    if (out.docx) {
      const bin = atob(out.docx); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      showDraft(buildDraft(await parseDocx(u8.buffer), "Google Doc")); toast("Draft loaded from Google Docs.");
    } else {
      const pg = out.page, K2 = { h1: "h1", h2: "h2", h3: "h3", h4: "h4", p: "p", li: "li", td: "td", quote: "p" };
      const blocks = pg.blocks.filter(b => K2[b.k] && b.text).map(b => { const text = b.text.replace(/\s+/g, " ").trim(); return { k: K2[b.k], text, links: (b.links || []).map(l => { const lt = String(l.text || "").replace(/\s+/g, " ").trim(); const i = text.indexOf(lt); return { href: l.href, text: lt, s: i, e: i < 0 ? -1 : i + lt.length }; }).filter(l => l.text) }; });
      if (!blocks.some(b => b.k === "h1")) blocks.unshift({ k: "h1", text: pg.title || url, links: [] });
      showDraft(buildDraft(blocks, "live page"));
      if (pg.url) { $("d-url").value = pg.url; S.target = normPath(pg.url); }
      toast("Page loaded.");
    }
  } catch (e) { pageNotice("err", `<p>${esc(e.message || "Couldn't load that link.")}</p>`); }
  finally { btn.disabled = false; btn.textContent = "Load"; }
}

// ================= Claude helpers =================
function sampleCopy(e) {
  switch (e && e.code) {
    case "not_granted": case "sampling_disabled": case "not_declared": case "capability_disabled": return "Asking Claude isn't allowed in this view. Open the tool on claude.ai.";
    case "rate_limited": return "Claude is busy or you've hit a usage limit. Try again in a little while.";
    case "session_expired": return "Sign in to claude.ai again, then retry.";
    case "invalid_json": return "Claude's answer couldn't be read. Press Run again.";
    case "cancelled": return "Stopped.";
    case "no_key": return "Add your Claude API key and model in Settings to get suggestions.";
    default: return (e && e.message) || "Claude couldn't answer just now. Press Run again.";
  }
}
async function ask(prompt, tier) {
  if (!CFG.claude && !ST.mock) throw { code: "no_key" };
  return (await api("claude", { prompt, model: CFG.model })).json;
}
const RULES = `Internal linking rules (apply strictly):
- Never place a link in an introduction (everything before the first H2), in a conclusion section, or in a heading.
- Each destination URL is linked once per page. Don't link a page to itself.
- Prefer prose paragraphs over list items; use a list item only when no prose placement exists.
- Anchors are descriptive and natural (usually 2–6 words) and say what the destination is about. Never "click here", "this post", "read more" or a bare brand name.
- Only link when the destination clearly helps a reader at that exact point.`;

function findAnchor(text, anchor) {
  if (!anchor) return null;
  const a = normQ(anchor).trim();
  let i = text.indexOf(a); if (i >= 0) return { s: i, e: i + a.length };
  i = text.toLowerCase().indexOf(a.toLowerCase()); if (i >= 0) return { s: i, e: i + a.length };
  return null;
}
const overlaps = (r, links) => links.some(l => l.s >= 0 && r.s < l.e && r.e > l.s);

// ================= SIDE 1: links from this post =================
async function runFrom() {
  if (!S.draft || !S.ready) return;
  const d = S.draft;
  S.from = { status: "running", rows: [], dropped: [], filter: "" };
  renderFrom(); location.hash = "#from";
  const excluded = new Set([...d.internal, S.target]);
  const lib = S.lib.filter(r => !excluded.has(r.u));
  const draftLines = [];
  d.blocks.forEach(b => {
    if (b.zone === "brief") return;
    if (b.k === "h1") draftLines.push(`# ${b.text}`);
    else if (b.k === "h2") draftLines.push(`\n## ${b.text}${b.zone === "head" && CONCL_RE.test(b.text) ? "  (conclusion: no links)" : ""}`);
    else if (/^h[34]$/.test(b.k)) draftLines.push(`### ${b.text}`);
    else if (b.zone === "body") draftLines.push(`[${b.id}] (${b.k === "li" ? "list item" : b.k === "td" ? "table cell" : "paragraph"}) ${b.text}`);
    else draftLines.push(`(${b.zone === "intro" ? "introduction" : "conclusion"}, no links) ${b.text.slice(0, 160)}${b.text.length > 160 ? "…" : ""}`);
  });
  const libLines = lib.map(r => `${r.id}|${r.type}|${r.u}|${r.kw}|${r.title}|${r.topic}|${r.c ?? ""}`).join("\n");
  const prompt = `You are the internal linking specialist for ${siteDomain()}. Suggest internal links to add to this draft, pointing to pages in the site's URL library.

${RULES}
- Priority when several destinations fit the same spot: product/tool pages first, then guides and pillar pages, then learn/docs/hub pages, then blog posts. Between pages of the same type, prefer the one with more traffic (the traffic column).
- Match on meaning, not just shared words: the destination's topic must be what the anchor is about.
- The anchor must be copied EXACTLY, character for character, from the text of the block you cite. Only blocks with an id like [B12] can hold links.
- If an anchor would read better slightly changed (e.g. extended by a word or two that already exist next to it, or a light reword), give that as revised_anchor; otherwise leave revised_anchor empty.
- Return every genuinely useful link, without padding: typically 15–35 for a 2,000-word draft.
- The draft already links to these URLs on the site (do not suggest them): ${d.internal.join(", ") || "none"}.

URL library (id|type|path|keyword|title|topic|traffic):
${libLines}

DRAFT: ${d.title}
${draftLines.join("\n")}

Reply with only JSON: {"suggestions":[{"block":"B12","anchor":"exact text from that block","lib":"L123","revised_anchor":"","reason":"max 20 words: why this destination fits here"}]}`;
  try {
    const out = await ask(prompt, "complex");
    const list = Array.isArray(out) ? out : (out && out.suggestions) || [];
    verifyFrom(list);
    S.from.status = "done";
  } catch (e) { S.from.status = "error"; S.from.error = sampleCopy(e); }
  renderFrom(); saveLocal();
}
function verifyFrom(list) {
  const d = S.draft, byId = new Map(d.blocks.map(b => [b.id, b])), libById = new Map(S.lib.map(r => [r.id, r]));
  const excluded = new Set([...d.internal, S.target]);
  const rows = [], dropped = [], usedDest = new Map(), usedRanges = new Map();
  const cand = list.map(s => {
    const b = byId.get(String(s.block || "").trim()), r = libById.get(String(s.lib || "").trim()) || S.libByPath.get(normPath(s.url || ""));
    return { s, b, r };
  });
  // prose first, then draft order, so a destination repeated in a list item yields to its prose placement
  cand.sort((x, y) => ((x.b && x.b.k === "li") - (y.b && y.b.k === "li")) || ((x.b ? d.blocks.indexOf(x.b) : 1e9) - (y.b ? d.blocks.indexOf(y.b) : 1e9)));
  for (const { s, b, r } of cand) {
    const anchor = String(s.anchor || "");
    const why = (msg) => dropped.push({ anchor, url: r ? r.u : (s.lib || s.url || ""), msg });
    if (!r) { why("destination isn't in the URL library"); continue; }
    if (!b) { why("block not found in the draft"); continue; }
    if (b.zone !== "body") { why(b.zone === "intro" ? "in the introduction" : b.zone === "concl" ? "in the conclusion" : "in a heading"); continue; }
    if (excluded.has(r.u)) { why("the draft already links there"); continue; }
    if (usedDest.has(r.u)) { why("repeat destination"); continue; }
    const range = findAnchor(b.text, anchor);
    if (!range) { why("anchor not found word for word in the draft"); continue; }
    if (words(b.text.slice(range.s, range.e)) > 10) { why("anchor too long (over 10 words)"); continue; }
    if (overlaps(range, b.links)) { why("anchor is already a link"); continue; }
    const taken = usedRanges.get(b.id) || [];
    if (taken.some(t => range.s < t.e && range.e > t.s)) { why("overlaps another suggested anchor"); continue; }
    taken.push(range); usedRanges.set(b.id, taken); usedDest.set(r.u, 1);
    rows.push({ block: b, anchor: b.text.slice(range.s, range.e), range, revised: String(s.revised_anchor || "").trim(), r, reason: String(s.reason || "").trim() });
  }
  rows.sort((x, y) => d.blocks.indexOf(x.block) - d.blocks.indexOf(y.block) || x.range.s - y.range.s);
  S.from.rows = rows; S.from.dropped = dropped;
}
function renderFrom() {
  const F = S.from;
  $("from-empty").hidden = !!F;
  $("from-stats").hidden = $("from-panel").hidden = !F;
  $("count-from").textContent = F && F.rows.length ? F.rows.length : "";
  if (!F) return;
  const rows = F.rows;
  const byType = (t) => rows.filter(x => x.r.type === t).length;
  const types = [...new Set(rows.map(x => x.r.type))].sort((a, b) => typeRank(a) - typeRank(b));
  $("from-stats").innerHTML = [["Suggestions", rows.length], ...types.slice(0, 5).map(t => [TYPE_LABEL[t], byType(t)])].map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${fmt(v)}</div></div>`).join("");
  $("from-chips").innerHTML = ["", ...types].map(t => `<button class="chip" type="button" data-t="${t}" aria-pressed="${F.filter === t}">${t ? TYPE_LABEL[t] : "All"}<span class="c">${t ? byType(t) : rows.length}</span></button>`).join("");
  $("from-chips").querySelectorAll("button").forEach(b => b.onclick = () => { F.filter = b.dataset.t; renderFrom(); });
  $("from-rerun").disabled = F.status === "running";
  $("from-progress").innerHTML = F.status === "running" ? `<span class="progress"><span class="spinner"></span>Claude is reading the draft against ${fmt(S.lib.length)} library URLs…</span>` : F.status === "error" ? `<span style="color:var(--bad)">${esc(F.error)}</span>` : `Every anchor verified word for word against the draft.`;
  const shown = rows.filter(x => !F.filter || x.r.type === F.filter);
  $("from-body").innerHTML = F.status === "running" && !rows.length ? `<tr><td colspan="7" class="empty">Working… this usually takes under a minute.</td></tr>` :
    shown.length ? shown.map((x, i) => `<tr>
      <td class="n">${i + 1}</td>
      <td><b>${esc(x.anchor)}</b><div class="small muted sentence">${esc(x.block.text.slice(Math.max(0, x.range.s - 70), x.range.s)).replace(/^/, x.range.s > 70 ? "…" : "")}<mark>${esc(x.anchor)}</mark>${esc(x.block.text.slice(x.range.e, x.range.e + 70))}${x.block.text.length > x.range.e + 70 ? "…" : ""}</div></td>
      <td>${x.revised ? esc(x.revised) : '<span class="muted">—</span>'}</td>
      <td><span class="t">${esc(x.r.title.replace(/\s+[-|–]\s+[^-|–]{1,40}$/, ""))}</span><span class="u">${linkTo(x.r.u, full(x.r.u))}</span></td>
      <td><span class="pill ${x.r.type}">${TYPE_LABEL[x.r.type]}</span></td>
      <td class="small">${esc(x.block.head || "")}${x.block.k === "li" ? ' <span class="pill neutral">list item</span>' : ""}</td>
      <td class="why">${esc(x.reason)}</td></tr>`).join("") : `<tr><td colspan="7" class="empty">${F.status === "done" ? "No suggestions passed the checks." : ""}</td></tr>`;
  $("from-dropped").innerHTML = F.dropped.length ? `<details><summary>${F.dropped.length} suggestion${F.dropped.length === 1 ? "" : "s"} removed by the checks</summary><ul>${F.dropped.map(x => `<li><b>${esc(x.anchor)}</b> → ${esc(x.url)}: ${esc(x.msg)}</li>`).join("")}</ul></details>` : "";
}
function copyFrom() {
  const F = S.from; if (!F || !F.rows.length) return;
  const head = ["Anchor Text in Draft", "Revised Anchor Text", "Suggested URL", "Destination Page Title", "Page Type", "Section in Draft", "Sentence", "Reason"];
  const lines = F.rows.filter(x => !F.filter || x.r.type === F.filter).map(x => [x.anchor, x.revised, full(x.r.u), x.r.title, TYPE_LABEL[x.r.type], x.block.head || "", x.block.text, x.reason]);
  copyTSV(head, lines);
}
function copyTSV(head, lines) {
  const clean = (v) => String(v ?? "").replace(/[\t\r\n]+/g, " ");
  head = head.map(h => h === "Clicks (3 mo)" ? ST.traffic : h);
  const tsv = [head, ...lines].map(r => r.map(clean).join("\t")).join("\n");
  navigator.clipboard.writeText(tsv).then(() => toast(`Copied ${lines.length} rows. Paste into Google Sheets.`), () => toast("Copy was blocked by the browser."));
}

// ================= SIDE 2: links to this post =================
function buildMatcher(phrases) {
  const ps = [...new Set(phrases.map(p => normQ(p).toLowerCase().trim()).filter(p => p.length > 2))].sort((a, b) => b.length - a.length);
  if (!ps.length) return null;
  return new RegExp("(?<![\\p{L}\\p{N}])(" + ps.map(p => reEsc(p).replace(/\\-|\s+/g, "[\\s\\-]+")).join("|") + ")(?:s|es)?(?![\\p{L}\\p{N}])", "giu");
}
function anchorRanges(text, links) {
  const out = [];
  if (links) for (const [, t0] of links) { const t = normQ(t0); if (!t) continue; let i = text.indexOf(t); if (i >= 0) out.push({ s: i, e: i + t.length }); }
  return out;
}
function searchIndex(core, related, opts = {}) {
  const reC = buildMatcher(core), reR = buildMatcher(related || []);
  const target = opts.target || "";
  const results = [], already = [];
  for (const pg of S.index) {
    if (target && pg.u === target) continue;
    if (target && pg.links.has(target)) { already.push(pg); continue; }
    let best = null, count = 0;
    pg.b.forEach((b, i) => {
      if (b[0] <= 1 || b[0] === 5) return;
      const zone = pg.z[i];
      if (!opts.all && zone !== "body") return;
      const text = normQ(b[1]);
      const ranges = opts.all ? [] : anchorRanges(text, b[2]);
      for (const [re, kind] of [[reC, "core"], [reR, "related"]]) {
        if (!re) continue;
        re.lastIndex = 0; let m;
        while ((m = re.exec(text))) {
          const r = { s: m.index, e: m.index + m[0].length };
          if (overlaps(r, ranges)) continue;
          count++;
          const score = (kind === "core" ? 3 : 1) * (b[0] === 2 ? 1 : b[0] === 3 ? 0.75 : 0.85) * (zone === "body" ? 1 : 0.3);
          if (!best || score > best.score) best = { bi: i, text, s: r.s, e: r.e, phrase: m[0], kind, score, k: b[0], head: pg.hd[i], zone };
        }
      }
    });
    if (best) results.push({ pg, ...best, count, rank: best.score * (1 + Math.log10(1 + (pg.c || 0))) * (1 + Math.min(count, 6) * 0.05) });
  }
  results.sort((a, b) => b.rank - a.rank);
  return { results, already };
}
async function runTo() {
  if (!S.draft || !S.ready) return;
  S.target = normPath($("d-url").value);
  const d = S.draft;
  S.to = { status: "phrases", core: [], related: [], summary: "", results: [], already: [], checked: 0, filter: "fit", title: d.title, url: S.target };
  renderTo(); location.hash = "#to";
  const outline = d.blocks.filter(b => b.zone !== "brief" && /^h[1-3]$/.test(b.k)).map(b => (b.k === "h1" ? "# " : b.k === "h2" ? "## " : "### ") + b.text).join("\n");
  const text = d.blocks.filter(b => b.zone !== "brief" && !/^h/.test(b.k)).map(b => b.text).join("\n").slice(0, 9000);
  try {
    const out = await askPhrases(d.title, outline, text, true);
    S.to.summary = out.summary; S.to.core = out.core; S.to.related = out.related;
  } catch (e) { S.to.status = "error"; S.to.error = sampleCopy(e); renderTo(); return; }
  await searchAndCheck();
}
async function askPhrases(title, outline, text, isNew, knownKeywords) {
  const prompt = `${isNew ? "A new article is about to be published on " + siteDomain() + "." : "This is an existing page on " + siteDomain() + " that needs more internal links pointing to it."} We'll search the body text of every other ${siteDomain()} page for phrases that refer to this page's topic, so those pages can link to it.

TITLE: ${title}
OUTLINE:
${outline}
TEXT (start):
${text}
${knownKeywords && knownKeywords.length ? "Search Console keywords this page targets: " + knownKeywords.join(", ") + "\n" : ""}
Give:
- "summary": one sentence on what the article covers and who it helps.
- "core": 4–10 phrases that name the article's MAIN topic the way other writers would mention it in passing (variants, synonyms, singular forms, common abbreviations). These are anchor candidates for a link to this article.
- "related": up to 10 narrower sub-topics the article explains in depth, where it would also be the best page to link to.
Phrases are 1–5 words, lowercase, exact wording likely to appear in prose. Avoid broad terms that would match unrelated pages (e.g. "seo", "content", "google", "ai", "search"). A single word is fine only when it's specific to this topic.
Reply with only JSON: {"summary": string, "core": [string], "related": [string]}`;
  const out = await ask(prompt, "default");
  return { summary: String(out.summary || ""), core: (out.core || []).map(String).filter(Boolean).slice(0, 14), related: (out.related || []).map(String).filter(Boolean).slice(0, 14) };
}
async function searchAndCheck() {
  const T = S.to; T.url = S.target; T.title = S.draft.title;
  const { results, already } = searchIndex(T.core, T.related, { target: S.target });
  T.results = results.map(r => ({ ...r, state: "unchecked" })); T.already = already; T.checked = 0; T.status = "checking";
  renderTo(); saveLocal();
  await checkMore(45);
}
async function checkMore(n, T = S.to, render = renderTo) {
  if (!T || T.busy) return;
  const queue = T.results.filter(r => r.state === "unchecked").slice(0, n);
  if (!queue.length) { T.status = "done"; render(); return; }
  T.busy = true; T.status = "checking"; render();
  const BATCH = 15;
  try {
    for (let i = 0; i < queue.length; i += BATCH) {
      const chunk = queue.slice(i, i + BATCH);
      T.progress = `Claude is checking ${T.checked + 1}–${T.checked + chunk.length} of ${T.results.length} pages…`; render();
      const items = chunk.map((r, j) => {
        const s0 = Math.max(0, r.s - 350), e0 = Math.min(r.text.length, r.e + 350);
        return { id: j + 1, page_title: r.pg.t, page_url: r.pg.u, page_type: r.pg.s, published: r.pg.d, section_heading: r.head || "", text: (s0 > 0 ? "…" : "") + r.text.slice(s0, e0) + (e0 < r.text.length ? "…" : ""), matched_phrase: r.text.slice(r.s, r.e) };
      });
      const prompt = `We're adding internal links TO a new article from existing ${siteDomain()} pages.

NEW ARTICLE: ${T.title}
URL: ${full(T.url)}
ABOUT: ${T.summary}

${RULES}

For each passage below (from an existing page), decide whether a link to the new article belongs there.
Keep it only when the passage is actually about the article's topic at that point, a reader would want to go deeper there, and the new article is a better destination than a generic page. Drop passing, ironic or unrelated uses of the phrase, and passages where the topic is only listed among many.
"anchor" must be copied EXACTLY from the passage text: usually the matched phrase, or a slightly longer natural span around it.
If the sentence needs a light edit to carry the link well, put the full rewritten sentence in "edit" (it must contain the anchor); otherwise "edit" is "".

Passages:
${JSON.stringify(items)}

Reply with only JSON: {"results":[{"id":1,"keep":true,"anchor":"","edit":"","reason":"max 20 words","confidence":"high"|"medium"|"low"}]}`;
      let out;
      try { out = await ask(prompt, "default"); }
      catch (e) { T.error = sampleCopy(e); break; }
      const arr = Array.isArray(out) ? out : (out && out.results) || [];
      chunk.forEach((r, j) => {
        const o = arr.find(x => Number(x.id) === j + 1);
        if (!o) return;
        r.reason = String(o.reason || ""); r.conf = String(o.confidence || "").toLowerCase();
        if (!o.keep) { r.state = "rejected"; return; }
        const edit = normQ(String(o.edit || "").trim());
        let range = findAnchor(r.text, o.anchor);
        if (range && overlaps(range, anchorRanges(r.text, r.pg.b[r.bi][2]))) range = null;
        if (range && words(r.text.slice(range.s, range.e)) > 8) range = null;  // a whole sentence is not an anchor: fall back to the matched phrase
        r.anchor = range ? r.text.slice(range.s, range.e) : r.text.slice(r.s, r.e);
        r.ar = range || { s: r.s, e: r.e };
        r.edit = edit && findAnchor(edit, r.anchor) ? edit : "";
        r.state = "fit";
      });
      T.checked += chunk.length;
      render();
    }
  } finally {
    T.busy = false; T.status = T.error ? "error" : "done"; T.progress = ""; render(); if (T === S.to) saveLocal();
  }
}
function renderTo() {
  const T = S.to;
  $("to-empty").hidden = !!T;
  ["to-phrases-panel", "to-stats", "to-panel"].forEach(id => $(id).hidden = !T);
  const fit = T ? T.results.filter(r => r.state === "fit") : [];
  $("count-to").textContent = fit.length ? fit.length : "";
  if (!T) return;
  $("to-chips").innerHTML = T.status === "phrases" ? `<span class="progress"><span class="spinner"></span>Claude is working out how other pages would mention this topic…</span>` :
    [...T.core.map(p => [p, "core"]), ...T.related.map(p => [p, "related"])].map(([p, k], i) => `<span class="chip ${k}" title="${k === "core" ? "Core topic" : "Related sub-topic"}">${esc(p)}<button class="x" type="button" aria-label="Remove ${esc(p)}" data-p="${esc(p)}" data-k="${k}">×</button></span>`).join("");
  $("to-chips").querySelectorAll(".x").forEach(b => b.onclick = () => { const arr = b.dataset.k === "core" ? T.core : T.related; arr.splice(arr.indexOf(b.dataset.p), 1); renderTo(); });
  const counts = { fit: fit.length, rejected: T.results.filter(r => r.state === "rejected").length, unchecked: T.results.filter(r => r.state === "unchecked").length, already: T.already.length };
  $("to-stats").innerHTML = [["Pages mentioning the topic", T.results.length], ["Suggested links", counts.fit], ["Checked by Claude", T.checked], ["Already link to this URL", counts.already]].map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${fmt(v)}</div></div>`).join("");
  $("to-filter").innerHTML = [["fit", "Suggested"], ["unchecked", "Not checked yet"], ["rejected", "Not a fit"], ["already", "Already link here"]].map(([k, l]) => `<button class="chip" type="button" data-f="${k}" aria-pressed="${T.filter === k}">${l}<span class="c">${counts[k]}</span></button>`).join("");
  $("to-filter").querySelectorAll("button").forEach(b => b.onclick = () => { T.filter = b.dataset.f; renderTo(); });
  $("to-more").hidden = !counts.unchecked || T.busy || T.status === "phrases";
  $("to-more").textContent = `Check ${Math.min(45, counts.unchecked)} more with Claude`;
  $("to-search").disabled = !!T.busy || T.status === "phrases";
  $("to-progress").innerHTML = T.busy || T.status === "phrases" ? `<span class="progress"><span class="spinner"></span>${esc(T.progress || "Working…")}</span>` : T.error ? `<span style="color:var(--bad)">${esc(T.error)}</span>` : `Linking to <b>${esc(S.target)}</b>`;
  let body = "";
  if (T.filter === "already") {
    body = T.already.length ? T.already.sort((a, b) => (b.c || 0) - (a.c || 0)).map(pg => `<tr><td><span class="t">${esc(pg.t)}</span><span class="u">${linkTo(pg.u, pg.u)}</span></td><td class="n">${fmtS(pg.c)}</td><td colspan="3" class="muted small">Already links to ${esc(S.target)}.</td></tr>`).join("") : `<tr><td colspan="5" class="empty">No indexed page links to ${esc(S.target)} yet.</td></tr>`;
  } else {
    const list = T.results.filter(r => r.state === T.filter);
    body = list.length ? list.map(r => {
      const rg = r.ar || { s: r.s, e: r.e };
      const s0 = Math.max(0, rg.s - 220), e0 = Math.min(r.text.length, rg.e + 220);
      const sent = (s0 > 0 ? "…" : "") + esc(r.text.slice(s0, rg.s)) + `<mark>${esc(r.text.slice(rg.s, rg.e))}</mark>` + esc(r.text.slice(rg.e, e0)) + (e0 < r.text.length ? "…" : "");
      const conf = r.conf ? `<span class="pill ${r.conf === "high" ? "good" : r.conf === "medium" ? "warn" : "neutral"}">${esc(r.conf)}</span> ` : "";
      return `<tr class="${r.state === "rejected" ? "dim" : ""}">
        <td style="min-width:230px;max-width:320px"><span class="t">${esc(r.pg.t)}</span><span class="u">${linkTo(r.pg.u, r.pg.u)}</span><div class="small muted"><span class="pill ${r.pg.s}">${TYPE_LABEL[r.pg.s] || r.pg.s}</span> ${esc((r.pg.d || "").slice(0, 4))}${r.count > 1 ? ` · ${r.count} mentions` : ""}</div></td>
        <td class="n">${fmtS(r.pg.c)}</td>
        <td class="sentence">${r.head ? `<div class="small muted">Under “${esc(r.head)}”</div>` : ""}${sent}${r.edit ? `<div class="small" style="margin-top:6px"><span class="pill claude">Suggested edit</span> ${esc(r.edit)}</div>` : ""}</td>
        <td>${r.state === "fit" ? `<b>${esc(r.anchor)}</b>` : `<span class="muted">${esc(r.text.slice(r.s, r.e))}</span>`}</td>
        <td class="why">${conf}${esc(r.reason || (r.state === "unchecked" ? "Matched “" + r.phrase + "”. Not checked yet." : ""))}</td></tr>`;
    }).join("") : `<tr><td colspan="5" class="empty">${T.status === "phrases" || T.busy ? "Working…" : T.filter === "fit" ? "No suggested links yet." : "Nothing here."}</td></tr>`;
  }
  $("to-body").innerHTML = body;
}
function copyTo() {
  const T = S.to; if (!T) return;
  const list = T.results.filter(r => r.state === "fit");
  if (!list.length) { toast("No suggested links to copy yet."); return; }
  copyTSV(["Source URL", "Source Page Title", "Page Type", "Clicks (3 mo)", "Section on Source Page", "Anchor Text", "Current Sentence", "Suggested Edit", "Link To", "Reason", "Confidence"],
    list.map(r => [full(r.pg.u), r.pg.t, TYPE_LABEL[r.pg.s] || r.pg.s, cv(r.pg.c), r.head || "", r.anchor, r.text, r.edit || "", full(S.target), r.reason || "", r.conf || ""]));
}

// ================= search tab =================
// ---- near-match search: exact, word forms, related ----
const SQ = { mode: "forms", related: [], excluded: new Set(), sort: "match", last: null, dfCache: new Map() };
const STOPW = new Set("a an and are as at be by can do does for from how in into is it its of on or our the this to vs what when where which who why will with you your".split(" "));
const SUFFIXES = ["izations", "isations", "ization", "isation", "izing", "ising", "ized", "ised", "izes", "ises", "ize", "ise", "ations", "ation", "ments", "ment", "ingly", "ings", "ing", "edly", "ers", "er", "ies", "ied", "ed", "es", "s", "ly"];
const ENDINGS = ["s", "es", "ed", "d", "ing", "ings", "er", "ers", "ion", "ions", "ation", "ations", "ization", "izations", "isation", "isations", "ize", "izes", "ized", "izing", "ise", "ises", "ised", "ising", "ment", "ments", "e", "y", "ies", "ied"].sort((a, b) => b.length - a.length).join("|");
function stemWord(w) {
  w = w.toLowerCase().replace(/['’]s$/, "");
  for (const s of SUFFIXES) if (w.endsWith(s) && w.length - s.length >= 4) return w.slice(0, -s.length);
  return w;
}
function wordPat(w, mode) {
  const lw = w.toLowerCase();
  if (mode === "exact") return reEsc(lw) + "(?:s|es)?";
  const st = stemWord(lw);
  if (st.length < 4) return reEsc(lw) + "(?:s|es)?";
  // z/s spelling (optimize / optimise), any word ending
  // stem + a common ending only, so "intent" finds intents/intention but not intentional/intentionally
  return reEsc(st).replace(/iz/g, "i[sz]") + "(?:" + ENDINGS + ")?(?:['’]s|(?<=s)['’](?=\\s))?";
}
function phraseRe(phrase, mode) {
  const ws = normQ(phrase).toLowerCase().split(/[\s\-]+/).filter(Boolean);
  if (!ws.length) return null;
  return new RegExp("(?<![\\p{L}\\p{N}])" + ws.map(w => wordPat(w, mode)).join("[\\s\\-]+") + "(?![\\p{L}\\p{N}])", "giu");
}
function pageFreq(word) {
  // share of pages that use this word (any form): very common words are too broad to search alone
  const st = stemWord(word);
  if (SQ.dfCache.has(st)) return SQ.dfCache.get(st);
  const re = phraseRe(word, "forms"); let n = 0;
  for (const pg of S.index) { if (pg.b.some(b => { re.lastIndex = 0; return re.test(b[1]); })) n++; }
  const f = n / S.index.length; SQ.dfCache.set(st, f); return f;
}
function searchTerms(qs) {
  const terms = []; // {re, tier, label}  tier 3 exact · 2 word form · 1 related
  const seen = new Set();
  const add = (p, mode, tier, label) => { const re = phraseRe(p, mode); if (!re || seen.has(re.source)) return; seen.add(re.source); terms.push({ re, tier, label }); };
  for (const q of qs) {
    add(q, "exact", 3, q);
    if (SQ.mode !== "exact") add(q, "forms", 2, q);
    if (SQ.mode === "related") {
      const ws = normQ(q).toLowerCase().split(/[\s\-]+/).filter(w => w.length > 3 && !STOPW.has(w));
      if (ws.length > 1) ws.forEach(w => { if (pageFreq(w) <= 0.35) add(w, "forms", 1, w); });
    }
  }
  if (SQ.mode === "related") SQ.related.forEach(r => add(r, "forms", 1, r));
  // within a tier, longer phrases first so "user intent" wins over "intent"
  return terms.sort((a, b) => b.tier - a.tier || b.label.split(/\s+/).length - a.label.split(/\s+/).length);
}
function nearSearch(qs, all) {
  const terms = searchTerms(qs);
  const results = [], termCounts = new Map();
  for (const pg of S.index) {
    let best = null, count = 0; const found = new Set();
    pg.b.forEach((b, i) => {
      if (b[0] <= 1 || b[0] === 5) return;
      if (!all && pg.z[i] !== "body") return;
      const text = normQ(b[1]);
      const ranges = all ? [] : anchorRanges(text, b[2]);
      const taken = [];
      for (const t of terms) {
        t.re.lastIndex = 0; let m;
        while ((m = t.re.exec(text))) {
          const r = { s: m.index, e: m.index + m[0].length };
          if (overlaps(r, ranges) || overlaps(r, taken)) continue;
          const word = m[0].toLowerCase().replace(/[’]/g, "'");
          if (SQ.excluded.has(word)) continue;
          taken.push(r); count++; found.add(word);
          termCounts.set(word, (termCounts.get(word) || 0) + 1);
          if (!best || t.tier > best.tier) best = { bi: i, text, s: r.s, e: r.e, tier: t.tier, word };
        }
      }
    });
    if (best) results.push({ pg, ...best, count, words: [...found] });
  }
  return { results, termCounts, terms };
}
const TIER = { 3: ["Exact", "good"], 2: ["Word form", "neutral"], 1: ["Related", "claude"] };
function runSearch(e) {
  if (e) e.preventDefault();
  if (needSetup("index")) return;
  const q = $("s-q").value.split(",").map(s => s.trim()).filter(Boolean);
  if (!q.length) return;
  const key = q.join("|").toLowerCase() + SQ.mode;
  if (SQ.lastKey && SQ.lastKey.split("#")[0] !== q.join("|").toLowerCase()) { SQ.excluded.clear(); SQ.related = []; }
  SQ.lastKey = q.join("|").toLowerCase() + "#" + SQ.mode;
  const all = $("s-all").checked;
  const { results, termCounts } = nearSearch(q, all);
  const sorted = SQ.sort === "clicks" ? results.sort((a, b) => (b.pg.c || 0) - (a.pg.c || 0)) : results.sort((a, b) => b.tier - a.tier || (b.pg.c || 0) - (a.pg.c || 0));
  SQ.last = { q, results: sorted };
  $("s-panel").hidden = false;
  const byTier = [3, 2, 1].map(t => results.filter(r => r.tier === t).length);
  $("s-meta").innerHTML = `${fmt(results.length)} page${results.length === 1 ? "" : "s"} · ${byTier[0]} exact${SQ.mode !== "exact" ? ` · ${byTier[1]} word form${SQ.mode === "related" ? ` · ${byTier[2]} related` : ""}` : ""}${all ? "" : " · linkable body text only (not intros, conclusions, headings or existing links)"}`;
  // matched terms, click to exclude
  const allTerms = [...termCounts.entries()].sort((a, b) => b[1] - a[1]);
  const exl = [...SQ.excluded].map(w => [w, 0]);
  $("s-terms").innerHTML = (allTerms.length || exl.length) ? `<span class="small muted">Matched wording (click to leave one out):</span> ` + [...allTerms.slice(0, 40), ...exl].map(([w, n]) => `<button class="chip" type="button" data-w="${esc(w)}" aria-pressed="false" style="${SQ.excluded.has(w) ? "text-decoration:line-through;opacity:.55" : ""}">${esc(w)}${n ? `<span class="c">${n}</span>` : ""}</button>`).join("") : "";
  $("s-terms").querySelectorAll("button").forEach(b => b.onclick = () => { const w = b.dataset.w; SQ.excluded.has(w) ? SQ.excluded.delete(w) : SQ.excluded.add(w); runSearch(); });
  $("s-related").hidden = SQ.mode !== "related";
  $("s-rel-chips").innerHTML = SQ.related.map(r => `<span class="chip">${esc(r)}<button class="x" type="button" data-r="${esc(r)}" aria-label="Remove ${esc(r)}">×</button></span>`).join("");
  $("s-rel-chips").querySelectorAll(".x").forEach(b => b.onclick = () => { SQ.related = SQ.related.filter(x => x !== b.dataset.r); runSearch(); });
  $("s-body").innerHTML = sorted.slice(0, 300).map(r => {
    const s0 = Math.max(0, r.s - 140), e0 = Math.min(r.text.length, r.e + 140);
    const [tl, tc] = TIER[r.tier];
    return `<tr><td style="min-width:230px;max-width:340px"><span class="t">${esc(r.pg.t)}</span><span class="u">${linkTo(r.pg.u, r.pg.u)}</span></td><td class="n">${fmtS(r.pg.c)}</td><td class="n">${r.count}</td><td><span class="pill ${tc}">${tl}</span><div class="small muted" style="margin-top:3px">${r.words.slice(0, 4).map(esc).join(", ")}</div></td><td class="sentence small">${s0 > 0 ? "…" : ""}${esc(r.text.slice(s0, r.s))}<mark>${esc(r.text.slice(r.s, r.e))}</mark>${esc(r.text.slice(r.e, e0))}${e0 < r.text.length ? "…" : ""}</td></tr>`;
  }).join("") || `<tr><td colspan="5" class="empty">No mentions found.</td></tr>`;
  $("s-more").hidden = sorted.length <= 300;
  $("s-more").textContent = `Showing the top 300 of ${fmt(sorted.length)}. Copy the table to get them all.`;
}
async function suggestRelated() {
  const q = $("s-q").value.split(",").map(s => s.trim()).filter(Boolean);
  if (!q.length) { toast("Type a topic first."); return; }
  const btn = $("s-rel-btn"); btn.disabled = true; btn.textContent = "Asking Claude…";
  try {
    const out = await ask(`An SEO is searching the body text of ${siteDomain()}'s pages for passages about: ${q.map(x => `"${x}"`).join(", ")}.
Suggest up to 10 other phrases writers would use when discussing the same topic or its closest sub-topics (synonyms, narrower types, common related terms). Example: for "search intent" → "user intent", "keyword intent", "informational intent", "transactional queries".
Phrases are 1–4 words, lowercase. Avoid broad words that would match unrelated pages (e.g. "seo", "google", "content", "search").
Reply with only JSON: {"related": [string]}`, "quick");
    const add = ((out && out.related) || []).map(x => String(x).toLowerCase().trim()).filter(x => x && !SQ.related.includes(x) && !q.map(y => y.toLowerCase()).includes(x));
    SQ.related.push(...add.slice(0, 10));
    runSearch();
  } catch (e) { toast(sampleCopy(e)); }
  finally { btn.disabled = false; btn.textContent = "Add related terms with Claude"; }
}
function copySearch() {
  if (!SQ.last || !SQ.last.results.length) return;
  copyTSV(["URL", "Title", "Clicks (3 mo)", "Mentions", "Match", "Wording", "First Mention"], SQ.last.results.map(r => [full(r.pg.u), r.pg.t, cv(r.pg.c), r.count, TIER[r.tier][0], r.words.join(", "), r.text]));
}

// ================= AUDIT =================
const A = { data: null, byPath: new Map(), loading: false, filter: "all", section: "", q: "", sort: "q", page: 0, open: null, jobs: new Map() };
const ISS_LABEL = { U: "Few links in", A: "Weak anchors", G: "Topic gaps", D: "Possible duplicate" };
const ACLS = ["Keyword", "Generic", "Branded", "Other"];
const ACLR = ["good", "bad", "warn", "neutral"];
const PER = 50;
async function loadAudit() {
  if (A.data || A.loading) return;
  if (!S.ready) { A.error = "Index your site in Settings first: the audit is worked out from its content index."; return; }
  A.loading = true; A.error = ""; renderAudit();
  await new Promise(r => setTimeout(r, 30));
  try { A.data = computeAudit(); A.data.rows.forEach(r => A.byPath.set(r.u, r)); }
  catch (e) { A.error = "The audit couldn't be worked out: " + (e.message || e); }
  A.loading = false;
  try { const saved = JSON.parse(localStorage.getItem("ilAudit:" + siteDomain()) || "{}"); for (const [u, j] of Object.entries(saved)) A.jobs.set(u, j); } catch (e) {}
  initAuditControls(); renderAudit();
}
const issues = (r) => {
  const out = [];
  if (r.iss.U >= 0.5 && (r.c || 0) >= 20) out.push("U");
  if (r.iss.A >= 0.5) out.push("A");
  if (r.iss.G >= 0.5 && r.rel.length >= 3 && (r.c || 0) >= 20) out.push("G");
  if (r.dup.length) out.push("D");
  return out;
};
function initAuditControls() {
  if (!A.data) return;
  const secs = [...new Set(A.data.rows.map(r => r.s))].sort((a, b) => typeRank(a) - typeRank(b) || a.localeCompare(b));
  $("au-sec").innerHTML = '<option value="">All page types</option>' + secs.map(t => `<option value="${esc(t)}">${esc(TYPE_LABEL[t])}</option>`).join("");
  $("au-sec").value = secs.includes(A.section) ? A.section : (A.section = "");
  if (A.inited) return; A.inited = true;
  $("au-q").addEventListener("input", () => { A.q = $("au-q").value.trim().toLowerCase(); A.page = 0; renderAudit(); });
  $("au-sec").onchange = () => { A.section = $("au-sec").value; A.page = 0; renderAudit(); };
  $("au-sort").onchange = () => { A.sort = $("au-sort").value; A.page = 0; renderAudit(); };
  $("au-copy").onclick = () => {
    const list = auditList();
    copyTSV(["URL", "Title", "Type", ST.traffic, "Avg position", "Pages linking in", "Expected", "Links out", "Keyword anchors", "Generic anchors", "Branded anchors", "Other anchors", "Related pages linked", "Related pages", "Issues", "Quick win score"],
      list.slice(0, 1000).map(r => { const rel = r.rel.filter(x => !r.dup.includes(x[0])).slice(0, 8); return [full(r.u), r.t, TYPE_LABEL[r.s] || r.s, cv(r.c), r.pos ?? "", r.inP, r.exp, r.ix ? r.out : "", ...r.a, rel.filter(x => x[2]).length, rel.length, issues(r).map(i => ISS_LABEL[i]).join(", "), r.q]; }));
  };
}
function auditList() {
  let list = A.data.rows;
  if (A.filter !== "all") list = list.filter(r => issues(r).includes(A.filter));
  if (A.section) list = list.filter(r => r.s === A.section);
  if (A.q) list = list.filter(r => r.u.toLowerCase().includes(A.q) || r.t.toLowerCase().includes(A.q) || r.kw.some(k => k.includes(A.q)));
  const key = { q: r => -r.q, c: r => -(r.c || 0), in: r => r.inP - (r.c || 0) / 1e7, a: r => -(r.a[1] + r.a[2]) / Math.max(1, r.a[0] + r.a[1] + r.a[2] + r.a[3]) }[A.sort];
  return [...list].sort((x, y) => key(x) - key(y));
}
function mixBar(a) {
  const tot = a.reduce((x, y) => x + y, 0);
  if (!tot) return '<span class="muted small">No links in</span>';
  const col = ["var(--good)", "var(--bad)", "var(--warn)", "var(--line)"];
  const weak = Math.round((a[1] + a[2]) / tot * 100);
  return `<div class="mix" title="${a.map((n, i) => ACLS[i] + ": " + n).join(" · ")}">${a.map((n, i) => n ? `<i style="width:${n / tot * 100}%;background:${col[i]}"></i>` : "").join("")}</div><div class="small muted">${weak ? weak + "% branded or generic" : Math.round(a[0] / tot * 100) + "% keyword"}</div>`;
}
function renderAudit() {
  const v = $("view-audit");
  if (v.hidden) return;
  if (A.loading || !A.data) { $("au-body").innerHTML = `<tr><td colspan="9" class="empty">${A.error ? esc(A.error) : '<span class="progress" style="justify-content:center"><span class="spinner"></span>Loading the audit…</span>'}</td></tr>`; return; }
  const rows = A.data.rows;
  const cnt = (k) => rows.filter(r => issues(r).includes(k)).length;
  $("au-stats").innerHTML = [["Pages audited", rows.length], ["Few links in", cnt("U")], ["Weak anchors", cnt("A")], ["Topic gaps", cnt("G")], ["Possible duplicates", cnt("D")]].map(([k, n]) => `<div class="stat"><div class="k">${k}</div><div class="v">${fmt(n)}</div></div>`).join("");
  $("au-chips").innerHTML = [["all", "All pages", rows.length], ["U", "Few links in", cnt("U")], ["A", "Weak anchors", cnt("A")], ["G", "Topic gaps", cnt("G")], ["D", "Possible duplicates", cnt("D")]].map(([k, l, n]) => `<button class="chip" type="button" data-f="${k}" aria-pressed="${A.filter === k}">${l}<span class="c">${fmt(n)}</span></button>`).join("");
  $("au-chips").querySelectorAll("button").forEach(b => b.onclick = () => { A.filter = b.dataset.f; A.page = 0; A.open = null; renderAudit(); });
  const list = auditList();
  const pages = Math.max(1, Math.ceil(list.length / PER)); A.page = Math.min(A.page, pages - 1);
  const shown = list.slice(A.page * PER, A.page * PER + PER);
  $("au-meta").textContent = `${fmt(list.length)} pages`;
  $("au-body").innerHTML = shown.map((r, i) => {
    const rel = r.rel.filter(x => !r.dup.includes(x[0])).slice(0, 8);
    const linked = rel.filter(x => x[2]).length;
    const iss = issues(r);
    const open = A.open === r.u;
    return `<tr class="arow${open ? " open" : ""}" data-u="${esc(r.u)}">
      <td class="n muted">${A.page * PER + i + 1}</td>
      <td style="min-width:240px;max-width:360px"><span class="t">${esc(r.t)}</span><span class="u">${esc(r.u)}</span><div class="small muted"><span class="pill ${r.s}">${TYPE_LABEL[r.s] || r.s}</span>${r.kw[0] ? " · " + esc(r.kw[0]) : ""}</div></td>
      <td class="n">${fmtS(r.c)}${r.sk ? '<div class="small" title="Average position 4–20 with 1,000+ impressions"><span class="pill warn">striking distance</span></div>' : ""}</td>
      <td class="n">${r.pos ? r.pos.toFixed(1) : "–"}</td>
      <td class="n"><b>${fmt(r.inP)}</b><div class="small muted">expect ~${r.exp}</div></td>
      <td style="min-width:150px">${mixBar(r.a)}</td>
      <td class="n">${r.ix ? (rel.length ? `${linked} of ${rel.length}` : "–") : '<span class="muted small">not in the index</span>'}</td>
      <td>${iss.map(k => `<span class="pill ${k === "U" ? "bad" : k === "A" ? "warn" : k === "G" ? "neutral" : "claude"}">${ISS_LABEL[k]}</span>`).join(" ") || '<span class="muted small">—</span>'}</td>
      <td class="n"><b>${r.q.toFixed(1)}</b></td></tr>
      ${open ? `<tr class="detail"><td colspan="9" id="au-detail"></td></tr>` : ""}`;
  }).join("") || `<tr><td colspan="9" class="empty">No pages match.</td></tr>`;
  $("au-body").querySelectorAll("tr.arow").forEach(tr => tr.onclick = (e) => { if (e.target.closest("a")) return; A.open = A.open === tr.dataset.u ? null : tr.dataset.u; renderAudit(); });
  $("au-pager").innerHTML = pages > 1 ? `<button class="btn small" type="button" id="au-prev" ${A.page ? "" : "disabled"}>Previous</button><span class="small muted">Page ${A.page + 1} of ${pages}</span><button class="btn small" type="button" id="au-next" ${A.page < pages - 1 ? "" : "disabled"}>Next</button>` : "";
  if ($("au-prev")) { $("au-prev").onclick = () => { A.page--; A.open = null; renderAudit(); }; $("au-next").onclick = () => { A.page++; A.open = null; renderAudit(); }; }
  if (A.open) renderDetail();
}
function job(u) { if (!A.jobs.has(u)) A.jobs.set(u, {}); return A.jobs.get(u); }
function saveAuditJobs() {
  try {
    const o = {};
    [...A.jobs.entries()].slice(-25).forEach(([u, j]) => { o[u] = { anchors: j.anchors && j.anchors.status === "done" ? j.anchors : undefined, topic: j.topic && j.topic.status === "done" ? j.topic : undefined }; });
    localStorage.setItem("ilAudit:" + siteDomain(), JSON.stringify(o));
  } catch (e) {}
}
function blockText(u, bi) { const pg = S.indexByPath.get(u); return pg && pg.b[bi] ? normQ(pg.b[bi][1]) : ""; }
function snippet(text, s, e, pad = 160) {
  const s0 = Math.max(0, s - pad), e0 = Math.min(text.length, e + pad);
  return (s0 > 0 ? "…" : "") + esc(text.slice(s0, s)) + `<mark>${esc(text.slice(s, e))}</mark>` + esc(text.slice(e, e0)) + (e0 < text.length ? "…" : "");
}
function renderDetail() {
  const el = $("au-detail"); if (!el) return;
  const r = A.byPath.get(A.open); if (!r) return;
  const J = job(r.u);
  // anchors
  const anc = new Map();
  r.inst.forEach(([src, bi, t, c]) => { const k = t.trim().toLowerCase(); if (!anc.has(k)) anc.set(k, { t: t.trim(), c, n: 0 }); anc.get(k).n++; });
  const topA = [...anc.values()].sort((a, b) => b.n - a.n).slice(0, 12);
  const conflicts = topA.filter(a => A.data.conflicts[a.t.toLowerCase()]).map(a => ({ a: a.t, d: Object.entries(A.data.conflicts[a.t.toLowerCase()]).filter(([u]) => u !== r.u).sort((x, y) => y[1] - x[1]) }));
  const weakN = r.inst.filter(x => x[3] === 1 || x[3] === 2).length;
  const rel = r.rel;
  const missOut = rel.filter(x => !x[2] && !r.dup.includes(x[0])).length, missIn = rel.filter(x => !x[3] && !r.dup.includes(x[0])).length;
  el.innerHTML = `<div class="detail-grid">
    <div class="dcol">
      <h3>Links in</h3>
      <p class="small muted">${fmt(r.inP)} page${r.inP === 1 ? "" : "s"} link here in body text (${fmt(r.in)} links). For ${fmtS(r.c || 0)} ${ST.traffic.startsWith("Sessions") ? "sessions" : "clicks"} we'd expect about ${r.exp}.</p>
      ${r.ix || S.ready ? `<button class="btn small claude" type="button" id="dj-in">${J.inbound ? "Search again" : "Find pages that should link here"}</button>` : ""}
      <div id="dj-in-out"></div>
    </div>
    <div class="dcol">
      <h3>Anchor text</h3>
      ${mixBar(r.a)}
      <div class="anc">${topA.map(a => `<div><span class="pill ${ACLR[a.c]}">${ACLS[a.c]}</span> ${esc(a.t || "(empty)")} <span class="muted">×${a.n}</span></div>`).join("") || '<span class="muted small">No links in yet.</span>'}</div>
      ${r.kw.length ? `<p class="small muted">Keywords for this page: ${r.kw.slice(0, 4).map(esc).join(", ")}</p>` : ""}
      ${conflicts.length ? `<details class="small"><summary>${conflicts.length} anchor${conflicts.length === 1 ? "" : "s"} also point to other pages</summary>${conflicts.map(c => `<div style="margin-top:4px"><b>${esc(c.a)}</b> → ${c.d.slice(0, 4).map(([u, n]) => `${linkTo(u, u)} ×${n}`).join(", ")}</div>`).join("")}</details>` : ""}
      ${weakN ? `<button class="btn small claude" type="button" id="dj-an" style="margin-top:8px">Suggest better anchors (${Math.min(weakN, 20)})</button>` : ""}
    </div>
    <div class="dcol wide">
      <h3>Related pages</h3>
      ${r.ix ? (rel.length ? `<table class="mini"><thead><tr><th>Page</th><th class="n">Similarity</th><th class="n">Clicks</th><th>This page links to it</th><th>It links here</th></tr></thead><tbody>${rel.map(([u, sim, to, from]) => { const o = A.byPath.get(u) || { t: u, c: null }; const dup = r.dup.includes(u); const stronger = (o.c || 0) >= Math.max(3 * (r.c || 0), (r.c || 0) + 50); return `<tr><td><span class="t">${esc(o.t)}</span><span class="u">${linkTo(u, u)}</span>${dup ? ' <span class="pill claude">very similar: check cannibalization</span>' : stronger ? ' <span class="pill good">stronger page</span>' : ""}</td><td class="n">${Math.round(sim * 100)}%</td><td class="n">${fmtS(o.c)}</td><td>${to ? '<span class="pill good">Yes</span>' : '<span class="pill bad">No</span>'}</td><td>${from ? '<span class="pill good">Yes</span>' : '<span class="pill bad">No</span>'}</td></tr>`; }).join("")}</tbody></table>` : '<p class="small muted">No closely related pages found.</p>') : '<p class="small muted">This page isn\'t in the content index (outside the indexed paths, or not crawled yet), so related pages can\'t be worked out.</p>'}
      ${r.ix && (missOut || missIn) ? `<button class="btn small claude" type="button" id="dj-top" style="margin-top:8px">Suggest the missing links (${missOut} out, ${Math.min(missIn, 6)} in)</button>` : ""}
      <div id="dj-top-out"></div>
    </div>
  </div>
  <div id="dj-an-out"></div>`;
  if ($("dj-in")) $("dj-in").onclick = () => auditInbound(r);
  if ($("dj-an")) $("dj-an").onclick = () => auditAnchors(r);
  if ($("dj-top")) $("dj-top").onclick = () => auditTopic(r);
  renderInboundJob(r); renderAnchorJob(r); renderTopicJob(r);
}
const busyLine = (t) => `<div class="progress" style="margin-top:8px"><span class="spinner"></span>${esc(t || "Working…")}</div>`;

// ---- inbound: reuse the "Links to this post" engine with this page as the target ----
async function auditInbound(r) {
  if (needSetup("to")) return;
  const J = job(r.u);
  const T = J.inbound = { status: "phrases", core: [], related: [], summary: "", results: [], already: [], checked: 0, title: r.t, url: r.u, progress: "Claude is working out how other pages would mention this topic…" };
  const render = () => { if (A.open === r.u) renderInboundJob(r); };
  render();
  const pg = S.indexByPath.get(r.u);
  const outline = pg ? pg.b.filter(b => b[0] <= 1).map(b => (b[0] === 0 ? "## " : "### ") + b[1]).join("\n") : "";
  const text = pg ? pg.b.filter(b => b[0] > 1).map(b => b[1]).join("\n").slice(0, 7000) : "";
  try {
    const out = await askPhrases(r.t, outline, text, false, r.kw.slice(0, 5));
    Object.assign(T, out);
  } catch (e) { T.status = "error"; T.error = sampleCopy(e); render(); return; }
  const { results } = searchIndex(T.core, T.related, { target: r.u });
  T.results = results.map(x => ({ ...x, state: "unchecked" }));
  T.status = "checking"; render();
  await checkMore(30, T, render);
}
function renderInboundJob(r) {
  const el = $("dj-in-out"); if (!el) return;
  const T = job(r.u).inbound; if (!T) { el.innerHTML = ""; return; }
  const fit = T.results.filter(x => x.state === "fit"), left = T.results.filter(x => x.state === "unchecked").length;
  el.innerHTML = (T.busy || T.status === "phrases" ? busyLine(T.progress) : "") + (T.error ? `<p class="small" style="color:var(--bad)">${esc(T.error)}</p>` : "") +
    (T.core.length ? `<p class="small muted" style="margin:8px 0 4px">Searched: ${[...T.core, ...T.related].map(esc).join(", ")}</p>` : "") +
    (T.status !== "phrases" ? `<p class="small"><b>${fit.length}</b> suggested of ${T.results.length} pages that mention the topic${left && !T.busy ? ` · <button class="btn small" type="button" id="dj-in-more">Check ${Math.min(30, left)} more</button>` : ""}${fit.length ? ` · <button class="btn small" type="button" id="dj-in-copy">Copy</button>` : ""}</p>` : "") +
    fit.map(x => `<div class="sugg"><div><span class="t">${esc(x.pg.t)}</span><span class="u">${linkTo(x.pg.u, x.pg.u)}</span> <span class="muted small">${fmtS(x.pg.c)} clicks</span></div><div class="small">${snippet(x.text, x.ar.s, x.ar.e)}</div>${x.edit ? `<div class="small"><span class="pill claude">Suggested edit</span> ${esc(x.edit)}</div>` : ""}<div class="small muted">${esc(x.reason || "")}</div></div>`).join("");
  if ($("dj-in-more")) $("dj-in-more").onclick = () => checkMore(30, T, () => { if (A.open === r.u) renderInboundJob(r); });
  if ($("dj-in-copy")) $("dj-in-copy").onclick = () => copyTSV(["Source URL", "Source Title", "Clicks (3 mo)", "Anchor Text", "Current Sentence", "Suggested Edit", "Link To", "Reason"], fit.map(x => [full(x.pg.u), x.pg.t, cv(x.pg.c), x.anchor, x.text, x.edit || "", full(r.u), x.reason || ""]));
}

// ---- anchors: rewrite branded / generic anchors in their sentences ----
async function auditAnchors(r) {
  const J = job(r.u);
  const inst = r.inst.filter(x => x[3] === 1 || x[3] === 2).map(([src, bi, t]) => ({ src, bi, t, text: blockText(src, bi), pg: A.byPath.get(src) })).filter(x => x.text)
    .sort((a, b) => ((b.pg && b.pg.c) || 0) - ((a.pg && a.pg.c) || 0)).slice(0, 20);
  J.anchors = { status: "running", rows: [] };
  renderAnchorJob(r);
  const items = inst.map((x, i) => ({ id: i + 1, source_page: x.src, current_anchor: x.t, sentence: x.text.length > 700 ? x.text.slice(Math.max(0, x.text.indexOf(x.t) - 300), x.text.indexOf(x.t) + x.t.length + 300) : x.text }));
  const prompt = `These links on ${siteDomain()} point to ${full(r.u)} ("${r.t}"). The page targets these keywords: ${r.kw.slice(0, 5).join(", ") || "(none recorded)"}.
Their anchor text is branded (a ${brandName()} product or brand name) or generic ("here", "this post"). Descriptive, keyword-led anchors tell readers and search engines what the destination is about.

For each link, suggest a better anchor:
- Lead with what the page does or covers (e.g. "backlink checker" rather than "Acme Link Explorer"), using the target keywords where they read naturally. Vary the wording across links; don't give every link the identical anchor.
- Keep the brand name in the sentence if it matters there (e.g. "a backlink checker like Link Explorer").
- Give the full rewritten sentence; it must contain the new anchor exactly. Change as little as possible.
- If the branded anchor is right where it is (the sentence is about using that specific product), set keep to true.

Links:
${JSON.stringify(items)}

Reply with only JSON: {"results":[{"id":1,"keep":false,"new_anchor":"","new_sentence":"","reason":"max 15 words"}]}`;
  try {
    const out = await ask(prompt, "default");
    const arr = Array.isArray(out) ? out : (out && out.results) || [];
    J.anchors.rows = inst.map((x, i) => {
      const o = arr.find(y => Number(y.id) === i + 1) || {};
      const ns = normQ(String(o.new_sentence || "")), na = normQ(String(o.new_anchor || ""));
      const ok = !o.keep && na && ns && findAnchor(ns, na);
      return { src: x.src, bi: x.bi, cur: x.t, keep: !!o.keep, na: ok ? na : "", ns: ok ? ns : "", reason: String(o.reason || (o.keep ? "" : "No usable rewrite.")) };
    });
    J.anchors.status = "done";
  } catch (e) { J.anchors.status = "error"; J.anchors.error = sampleCopy(e); }
  saveAuditJobs();
  if (A.open === r.u) renderAnchorJob(r);
}
function renderAnchorJob(r) {
  const el = $("dj-an-out"); if (!el) return;
  const J = job(r.u).anchors; if (!J) { el.innerHTML = ""; return; }
  if (J.status === "running") { el.innerHTML = busyLine("Claude is rewriting the weakest anchors…"); return; }
  if (J.status === "error") { el.innerHTML = `<p class="small" style="color:var(--bad)">${esc(J.error)}</p>`; return; }
  const rows = J.rows;
  el.innerHTML = `<div class="row between" style="margin:12px 0 6px"><h3>Better anchors for links to this page</h3><button class="btn small" type="button" id="dj-an-copy">Copy</button></div>
  <div class="table-wrap"><table class="mini"><thead><tr><th>On page</th><th>Current</th><th>Suggested anchor</th><th>Rewritten sentence</th><th>Why</th></tr></thead><tbody>${rows.map(x => `<tr class="${x.keep ? "dim" : ""}"><td style="max-width:220px"><span class="u">${linkTo(x.src, x.src)}</span></td><td>${esc(x.cur)}</td><td>${x.keep ? '<span class="pill good">keep</span>' : `<b>${esc(x.na)}</b>`}</td><td class="sentence small">${x.ns ? (() => { const g = findAnchor(x.ns, x.na); return snippet(x.ns, g.s, g.e, 200); })() : ""}</td><td class="why">${esc(x.reason)}</td></tr>`).join("")}</tbody></table></div>`;
  $("dj-an-copy").onclick = () => copyTSV(["Source URL", "Current Anchor", "Suggested Anchor", "Current Sentence", "Rewritten Sentence", "Link To", "Reason"], rows.filter(x => !x.keep && x.na).map(x => [full(x.src), x.cur, x.na, blockText(x.src, x.bi), x.ns, full(r.u), x.reason]));
}

// ---- topic: place the missing links between this page and its related pages ----
function eligibleBlocks(pg, max = 70) {
  const out = [];
  pg.b.forEach((b, i) => { if (pg.z[i] === "body" && (b[0] === 2 || b[0] === 3 || b[0] === 4)) out.push({ i, k: b[0], text: normQ(b[1]), links: anchorRanges(normQ(b[1]), b[2]) }); });
  return out.slice(0, max);
}
async function auditTopic(r) {
  const J = job(r.u);
  J.topic = { status: "running", rows: [], dropped: 0 };
  renderTopicJob(r);
  const rel = r.rel.filter(x => !r.dup.includes(x[0]));
  const outs = rel.filter(x => !x[2]).map(x => x[0]), ins = rel.filter(x => !x[3]).map(x => x[0]).slice(0, 6);
  const desc = (u) => { const o = A.byPath.get(u) || {}; return { url: u, title: o.t || u, keywords: (o.kw || []).slice(0, 3) }; };
  const sources = [];
  const me = S.indexByPath.get(r.u);
  if (me && outs.length) sources.push({ src: r.u, dests: outs });
  ins.forEach(u => { if (S.indexByPath.get(u)) sources.push({ src: u, dests: [r.u] }); });
  const payload = sources.map((s, si) => {
    const pg = S.indexByPath.get(s.src);
    return { source_id: "S" + (si + 1), source_url: s.src, source_title: pg.t, link_to: s.dests.map(desc), blocks: eligibleBlocks(pg, s.src === r.u ? 90 : 45).map(b => ({ id: "P" + b.i, type: b.k === 3 ? "list item" : "paragraph", text: b.text.length > 600 ? b.text.slice(0, 600) + "…" : b.text })) };
  });
  const prompt = `We're tightening internal links between closely related ${siteDomain()} pages.
${RULES}

For each source page below, find where to add a link to each page in its "link_to" list. Pick the passage (by id) where the link fits best and an anchor copied EXACTLY from that passage's text that describes the destination. If the destination doesn't fit naturally anywhere, skip it rather than forcing it. If a light edit is needed to carry the link, give the full rewritten passage text as "edit" (it must contain the anchor); otherwise "".

${JSON.stringify(payload)}

Reply with only JSON: {"links":[{"source_id":"S1","to":"/destination/path","block":"P12","anchor":"","edit":"","reason":"max 15 words"}]}`;
  try {
    const out = await ask(prompt, "complex");
    const arr = Array.isArray(out) ? out : (out && out.links) || [];
    const used = new Set();
    for (const o of arr) {
      const s = sources[Number(String(o.source_id || "").replace(/\D/g, "")) - 1];
      const to = normPath(o.to || "");
      if (!s || !s.dests.includes(to) || used.has(s.src + ">" + to)) { J.topic.dropped++; continue; }
      const pg = S.indexByPath.get(s.src), bi = Number(String(o.block || "").replace(/\D/g, ""));
      const blk = eligibleBlocks(pg, 999).find(b => b.i === bi);
      if (!blk) { J.topic.dropped++; continue; }
      const edit = normQ(String(o.edit || "").trim());
      const base = edit && findAnchor(edit, o.anchor) ? edit : blk.text;
      const g = findAnchor(base, o.anchor);
      if (!g || (base === blk.text && overlaps(g, blk.links))) { J.topic.dropped++; continue; }
      used.add(s.src + ">" + to);
      J.topic.rows.push({ dir: s.src === r.u ? "out" : "in", src: s.src, to, bi, anchor: base.slice(g.s, g.e), text: blk.text, edit: base === blk.text ? "" : base, reason: String(o.reason || "") });
    }
    J.topic.status = "done";
  } catch (e) { J.topic.status = "error"; J.topic.error = sampleCopy(e); }
  saveAuditJobs();
  if (A.open === r.u) renderTopicJob(r);
}
function renderTopicJob(r) {
  const el = $("dj-top-out"); if (!el) return;
  const J = job(r.u).topic; if (!J) { el.innerHTML = ""; return; }
  if (J.status === "running") { el.innerHTML = busyLine("Claude is reading the related pages for good places to link…"); return; }
  if (J.status === "error") { el.innerHTML = `<p class="small" style="color:var(--bad)">${esc(J.error)}</p>`; return; }
  el.innerHTML = `<div class="row between" style="margin:10px 0 6px"><span class="small"><b>${J.rows.length}</b> link${J.rows.length === 1 ? "" : "s"} placed${J.dropped ? ` · ${J.dropped} removed by the checks` : ""}</span>${J.rows.length ? '<button class="btn small" type="button" id="dj-top-copy">Copy</button>' : ""}</div>` +
    J.rows.map(x => { const base = x.edit || x.text, g = findAnchor(base, x.anchor) || { s: 0, e: 0 }; return `<div class="sugg"><div class="small">${x.dir === "out" ? "On this page" : `On ${linkTo(x.src, x.src)}`} → link to ${linkTo(x.to, x.to)}</div><div class="small">${snippet(base, g.s, g.e)}</div>${x.edit ? '<div class="small"><span class="pill claude">Suggested edit</span></div>' : ""}<div class="small muted">${esc(x.reason)}</div></div>`; }).join("");
  if ($("dj-top-copy")) $("dj-top-copy").onclick = () => copyTSV(["Add Link On", "Anchor Text", "Current Sentence", "Suggested Edit", "Link To", "Reason"], J.rows.map(x => [full(x.src), x.anchor, x.text, x.edit, full(x.to), x.reason]));
}

// ================= persistence (this browser only) =================
function saveLocal() {
  try {
    if (!S.draft) { localStorage.removeItem("ilLast:" + siteDomain()); return; }
    const to = S.to ? { ...S.to, busy: false, results: S.to.results.map(r => ({ u: r.pg.u, bi: r.bi, s: r.s, e: r.e, phrase: r.phrase, kind: r.kind, count: r.count, state: r.state, anchor: r.anchor, ar: r.ar, edit: r.edit, reason: r.reason, conf: r.conf })), already: S.to.already.map(p => p.u) } : null;
    const from = S.from ? { ...S.from, rows: S.from.rows.map(x => ({ b: x.block.id, anchor: x.anchor, range: x.range, revised: x.revised, u: x.r.u, reason: x.reason })) } : null;
    localStorage.setItem("ilLast:" + siteDomain(), JSON.stringify({ draft: S.draft, url: $("d-url").value, from, to }));
  } catch (e) {}
}
function restoreLocal() {
  let saved; try { saved = JSON.parse(localStorage.getItem("ilLast:" + siteDomain()) || "null"); } catch (e) {}
  if (!saved || !saved.draft) return;
  $("d-url").value = saved.url || "";
  if (saved.draft.start == null) saved.draft.start = 0;
  zoneDraft(saved.draft);
  showDraft(saved.draft, { keepUrl: true, keepResults: true });
  const byId = new Map(S.draft.blocks.map(b => [b.id, b]));
  if (saved.from && saved.from.status === "done") {
    S.from = { ...saved.from, rows: saved.from.rows.map(x => ({ block: byId.get(x.b), anchor: x.anchor, range: x.range, revised: x.revised, r: S.libByPath.get(x.u), reason: x.reason })).filter(x => x.block && x.r) };
  }
  if (saved.to && saved.to.results) {
    const T = { title: S.draft.title, url: normPath(saved.url || ""), ...saved.to, busy: false, status: saved.to.status === "phrases" ? "error" : "done" };
    T.results = saved.to.results.map(r => { const pg = S.indexByPath.get(r.u); if (!pg || !pg.b[r.bi]) return null; return { ...r, pg, text: normQ(pg.b[r.bi][1]), head: pg.hd[r.bi], k: pg.b[r.bi][0], state: r.state === "unchecked" || r.state === "fit" || r.state === "rejected" ? r.state : "unchecked" }; }).filter(Boolean);
    T.already = (saved.to.already || []).map(u => S.indexByPath.get(u)).filter(Boolean);
    S.to = T;
  }
  renderFrom(); renderTo();
}

// ================= routing & wiring =================
const ROUTES = ["draft", "from", "to", "audit", "search", "settings"];
function route() {
  let r = location.hash.replace("#", ""); if (!ROUTES.includes(r)) r = "draft";
  document.querySelectorAll("nav.tabs a").forEach(a => a.setAttribute("aria-current", a.dataset.tab === r ? "page" : "false"));
  ROUTES.forEach(x => $("view-" + x).hidden = x !== r);
  if (r === "audit") { loadAudit(); renderAudit(); }
  if (r === "settings") renderSettings();
}
window.addEventListener("hashchange", route);
const drop = $("drop");
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", e => loadFile(e.dataTransfer.files[0]));
$("file").addEventListener("change", e => { loadFile(e.target.files[0]); e.target.value = ""; });
$("gdoc-btn").onclick = loadGdoc;
$("paste-btn").onclick = () => { const t = $("paste").value.trim(); if (!t) { toast("Paste the draft first."); return; } showDraft(buildDraft(parsePaste(t), "pasted text")); };
$("d-start").onchange = () => { if (!S.draft) return; S.draft.start = Number($("d-start").value); zoneDraft(S.draft); showDraft(S.draft, { keepUrl: false }); };
$("d-clear").onclick = () => { S.draft = null; S.from = null; S.to = null; $("draft-loaded").hidden = true; renderFrom(); renderTo(); saveLocal(); window.scrollTo(0, 0); };
$("d-url").addEventListener("change", () => { S.target = normPath($("d-url").value); saveLocal(); });
const guardReady = (fn, what) => () => { if (needSetup(what)) return; if (!S.draft) { toast("Add a draft first."); return; } fn(); };
$("run-from").onclick = guardReady(runFrom);
$("run-to").onclick = guardReady(runTo, "to");
$("run-both").onclick = guardReady(() => { runFrom(); runTo(); location.hash = "#from"; });
$("from-rerun").onclick = guardReady(runFrom);
$("from-copy").onclick = copyFrom;
$("to-copy").onclick = copyTo;
$("to-more").onclick = () => checkMore(45);
$("to-search").onclick = () => { if (S.to && !S.to.busy) searchAndCheck(); };
const addPhrase = () => { const v = $("to-add").value.trim().toLowerCase(); if (!v || !S.to) return; if (!S.to.core.includes(v)) S.to.core.push(v); $("to-add").value = ""; renderTo(); };
$("to-add-btn").onclick = addPhrase;
$("to-add").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); addPhrase(); } });
$("s-form").addEventListener("submit", runSearch);
document.querySelectorAll("#s-mode button").forEach(b => b.onclick = () => { SQ.mode = b.dataset.m; document.querySelectorAll("#s-mode button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); if ($("s-q").value.trim()) runSearch(); else $("s-related").hidden = SQ.mode !== "related"; });
$("s-sort").onchange = () => { SQ.sort = $("s-sort").value; if (SQ.last) runSearch(); };
$("s-rel-btn").onclick = suggestRelated;
$("s-copy").onclick = copySearch;
function applyDemo() {
  $("demo-btn").setAttribute("aria-pressed", String(DEMO));
  $("demo-btn").textContent = DEMO ? "Demo mode: on" : "Demo mode";
  $("demo-pill").hidden = !DEMO;
}
$("demo-btn").onclick = () => {
  DEMO = !DEMO;
  try { localStorage.setItem("ilDemo", DEMO ? "1" : "0"); } catch (e) {}
  applyDemo();
  renderFrom(); renderTo();
  if (A.data) renderAudit();
  if (SQ.last) runSearch();
};
applyDemo();
bindSettings();
route();
(async () => {
  try { const h = await fetch("/api/health").then(r => r.ok ? r.json() : {}); ST.mock = !!h.mock; } catch (e) {}
  renderLibHeader();
  await openSite();
  if (siteDomain()) refreshSite();
})();

})();
