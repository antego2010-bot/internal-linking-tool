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
