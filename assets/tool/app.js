(() => {
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
// Site config comes from meta.json (written by build_site.py); defaults keep the page working before it loads.
let CFG = { site: "our site", domain: "example.com", newPostPath: "/blog/", sections: [] };
const domRe = () => new RegExp("^https?://(www\\.)?" + CFG.domain.replace(/^www\./, "").replace(/[.]/g, "\\."), "i");
const short = (u) => String(u || "").replace(domRe(), "") || "/";
const normPath = (u) => { let p = short(String(u || "").trim()).split("#")[0].split("?")[0]; if (p.length > 1) p = p.replace(/\/+$/, ""); return p || "/"; };
const full = (p) => /^https?:/.test(p) ? p : "https://" + CFG.domain + p;
const linkTo = (p, label) => `<a href="${esc(full(p))}" target="_blank" rel="noopener">${esc(label ?? p)}</a>`;
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normQ = (s) => String(s || "").replace(/[‘’‛′]/g, "'").replace(/[“”″]/g, '"').replace(/[–—]/g, "-").replace(/ /g, " ");
const words = (s) => (String(s).match(/\S+/g) || []).length;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 3200); }
function setStatus(kind, html) { $("status").innerHTML = `<span class="dot ${kind}"></span>${html}`; }
function pageNotice(kind, html) { const n = $("page-notice"); if (!html) { n.hidden = true; return; } n.className = "notice " + (kind || ""); n.innerHTML = html; n.hidden = false; }
const cap = (name) => (window.claude && typeof window.claude.use === "function") ? window.claude.use(name).catch(() => null) : Promise.resolve(null);
let TYPE_RANK = {}, TYPE_LABEL = {}, TYPE_CLS = {};
const tlabel = (t) => TYPE_LABEL[t] || t || "Other";
const tpill = (t) => `<span class="pill ${TYPE_CLS[t] || "neutral"}">${esc(tlabel(t))}</span>`;
const isCommercial = (t) => (CFG.sections.find(x => x.key === t) || {}).role === "commercial";
function applyConfig(meta) {
  CFG = { ...CFG, ...(meta.config || {}) };
  TYPE_RANK = {}; TYPE_LABEL = {}; TYPE_CLS = {};
  [...CFG.sections].sort((a, b) => a.priority - b.priority).forEach((x, i) => { TYPE_RANK[x.key] = x.priority; TYPE_LABEL[x.key] = x.label || x.key; TYPE_CLS[x.key] = "s" + (i % 6); });
  document.title = "Internal linking tool · " + CFG.site;
  $("brand-sub").textContent = "Two-way internal link suggestions for " + CFG.site;
  $("d-url").placeholder = "https://" + CFG.domain + CFG.newPostPath + "your-post-slug";
  const opts = CFG.sections.map(x => `<option value="${esc(x.key)}">${esc(x.label || x.key)}</option>`).join("");
  $("au-sec").innerHTML = `<option value="">All page types</option>` + opts;
}
const KIND = ["h2", "h3", "p", "li", "quote", "td"];
const CONCL_RE = /^\s*(in\s+)?(conclusion|conclusions|final thoughts|closing thoughts|wrapping (it )?up|wrap[- ]up|to sum (it )?up|summing up|in summary|summary|the bottom line|bottom line|over to you|tl;?dr|parting thoughts|last words)\b/i;

// ================= state =================
const S = { meta: null, lib: [], libByPath: new Map(), index: [], indexByPath: new Map(), draft: null, target: "", from: null, to: null, ready: false };
let SAMPLE = null, MCP = null;

// ================= data loading =================
async function fetchLines(name) {
  const r = await fetch(name, { cache: "no-cache" });
  if (!r.ok) throw new Error(name + " " + r.status);
  const u8 = new Uint8Array(await r.arrayBuffer());
  let text;
  if (u8[0] === 0x1f && u8[1] === 0x8b) text = await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  else text = new TextDecoder().decode(u8);
  const t = text.trimStart();
  if (t.startsWith("[")) return JSON.parse(t);
  return text.split("\n").filter(Boolean).map(l => JSON.parse(l));
}
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
const configReady = (() => { let done; const p = new Promise(r => { done = r; }); p.done = done; return p; })();
async function loadData() {
  setStatus("busy", "Loading the content index…");
  try {
    S.meta = await (await fetch("meta.json", { cache: "no-cache" })).json();
    applyConfig(S.meta);
    configReady.done();
    S.lib = await (await fetch("library.json", { cache: "no-cache" })).json();
    S.lib.forEach((r, i) => { r.id = "L" + (i + 1); S.libByPath.set(r.u, r); });
    let done = 0;
    const parts = await Promise.all(S.meta.files.map(f => fetchLines(f).then(x => { done++; setStatus("busy", `Loading the content index… ${done}/${S.meta.files.length}`); return x; })));
    S.index = parts.flat();
    S.index.forEach(p => { annotate(p); S.indexByPath.set(p.u, p); });
    S.ready = true;
    const crawled = new Date(S.meta.crawled + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    const age = (Date.now() - new Date(S.meta.crawled)) / 864e5;
    setStatus(age > 40 ? "busy" : "ok", `Index: ${fmt(S.index.length)} pages · crawled ${crawled} · Library: ${fmt(S.lib.length)} URLs${age > 40 ? " · over a month old" : ""}`);
    $("s-meta").textContent = `Searches ${fmt(S.meta.blocks)} paragraphs on ${fmt(S.index.length)} pages.`;
  } catch (e) {
    configReady.done();
    setStatus("err", "Index didn't load");
    pageNotice("err", `<p>The content index couldn't load (${esc(e.message || e)}). Reload the page; if it keeps failing, the index files need republishing.</p>`);
  }
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
  d.internal = [...new Set(linksAll.filter(l => /^\//.test(l.href) || domRe().test(l.href)).map(l => normPath(l.href)))];
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
    const guess = S.index.find(p => p.t.toLowerCase().replace(/\s+[-|–]\s+[^-|–]+$/, "") === d.title.toLowerCase());
    // a brief's SEO table often carries the planned URL: a "URL" cell followed by the path
    let briefUrl = "";
    d.blocks.slice(0, d.start).forEach((b, i, arr) => { if (/^url:?$/i.test(b.text.trim()) && arr[i + 1] && /^(https?:\/\/|\/)\S+$/.test(arr[i + 1].text.trim())) briefUrl = arr[i + 1].text.trim(); });
    $("d-url").value = guess ? full(guess.u) : briefUrl ? full(normPath(briefUrl)) : full(CFG.newPostPath + slugify(d.title));
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
function findZipB64(x) {
  let best = null;
  const visit = (v, d) => {
    if (d > 8 || v == null) return;
    if (typeof v === "string") { let s = v.trim(); const m = s.match(/^data:[^,]*;base64,/); if (m) s = s.slice(m[0].length); if (s.startsWith("UEsDB") && (!best || s.length > best.length)) best = s; else if ((s.startsWith("{") || s.startsWith("[")) && s.length > 1000) { try { visit(JSON.parse(s), d + 1); } catch (e) {} } return; }
    if (Array.isArray(v)) { v.forEach(i => visit(i, d + 1)); return; }
    if (typeof v === "object") Object.values(v).forEach(i => visit(i, d + 1));
  };
  visit(x, 0); return best;
}
function mcpCopy(e) {
  switch (e && e.code) {
    case "server_not_connected": return "Google Drive isn't connected for you. Add it in claude.ai Settings → Connectors, or upload the .docx instead.";
    case "needs_reauth": return "Your Google Drive connection has expired. Reconnect it in claude.ai Settings → Connectors.";
    case "not_in_manifest": case "blocked_by_policy": return "This page isn't allowed to use Google Drive. Upload the .docx instead.";
    case "tool_error": return "Google Drive couldn't export that Doc: " + (e.message || "") + ". Check you can open it.";
    default: return "Couldn't load the Doc (" + ((e && e.code) || "error") + "). Upload the .docx instead.";
  }
}
async function loadGdoc() {
  const m = $("gdoc").value.match(/\/d\/([\w-]{20,})/) || $("gdoc").value.match(/^([\w-]{25,})$/);
  if (!m) { toast("Paste a Google Doc link."); return; }
  const btn = $("gdoc-btn"); btn.disabled = true; btn.textContent = "Loading…";
  try {
    MCP = MCP || await cap("mcp");
    if (!MCP) throw { code: "no_mcp" };
    const res = await MCP.callTool("Google Drive", "download_file_content", { fileId: m[1], exportMimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, { cache: false });
    const b64 = findZipB64(res); if (!b64) throw { code: "tool_error", message: "no document in the response" };
    const bin = atob(b64.replace(/\s+/g, "")); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    showDraft(buildDraft(await parseDocx(u8.buffer), "Google Doc")); toast("Draft loaded from Google Docs.");
  } catch (e) { pageNotice("err", `<p>${esc(e && e.code === "no_mcp" ? "Connectors aren't available in this view. Upload the .docx instead." : mcpCopy(e))}</p>`); }
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
    default: return "Claude couldn't answer just now (" + ((e && e.code) || "error") + "). Press Run again.";
  }
}
async function ask(prompt, tier) {
  SAMPLE = SAMPLE || await cap("sample");
  if (!SAMPLE) throw { code: "not_granted" };
  return SAMPLE.json(prompt, { modelTier: tier || "default" });
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
  const libLines = lib.map(r => `${r.id}|${r.type}|${r.u}|${r.kw}|${r.title}|${r.topic}`).join("\n");
  const order = [...CFG.sections].sort((a, b) => a.priority - b.priority).map(x => `${x.label || x.key} (${x.key})`);
  const prompt = `You are the internal linking specialist for ${CFG.site} (${CFG.domain}). Suggest internal links to add to this draft, pointing to pages in the site's URL library.

${RULES}
- Priority when several destinations fit the same spot: ${order.join(", then ")}.
- Match on meaning, not just shared words: the destination's topic must be what the anchor is about.
- The anchor must be copied EXACTLY, character for character, from the text of the block you cite. Only blocks with an id like [B12] can hold links.
- If an anchor would read better slightly changed (e.g. extended by a word or two that already exist next to it, or a light reword), give that as revised_anchor; otherwise leave revised_anchor empty.
- Return every genuinely useful link, without padding: typically 15–35 for a 2,000-word draft.
- The draft already links to these URLs on the site (do not suggest them): ${d.internal.join(", ") || "none"}.

URL library (id|type|path|keyword|title|topic):
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
  const keys = Object.keys(TYPE_RANK).sort((a, b) => TYPE_RANK[a] - TYPE_RANK[b]);
  $("from-stats").innerHTML = [["Suggestions", rows.length], ...keys.map(k => [tlabel(k), byType(k)])].map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${fmt(v)}</div></div>`).join("");
  $("from-chips").innerHTML = ["", ...keys].map(t => `<button class="chip" type="button" data-t="${t}" aria-pressed="${F.filter === t}">${t ? esc(tlabel(t)) : "All"}<span class="c">${t ? byType(t) : rows.length}</span></button>`).join("");
  $("from-chips").querySelectorAll("button").forEach(b => b.onclick = () => { F.filter = b.dataset.t; renderFrom(); });
  $("from-rerun").disabled = F.status === "running";
  $("from-progress").innerHTML = F.status === "running" ? `<span class="progress"><span class="spinner"></span>Claude is reading the draft against ${fmt(S.lib.length)} library URLs…</span>` : F.status === "error" ? `<span style="color:var(--bad)">${esc(F.error)}</span>` : `Every anchor verified word for word against the draft.`;
  const shown = rows.filter(x => !F.filter || x.r.type === F.filter);
  $("from-body").innerHTML = F.status === "running" && !rows.length ? `<tr><td colspan="7" class="empty">Working… this usually takes under a minute.</td></tr>` :
    shown.length ? shown.map((x, i) => `<tr>
      <td class="n">${i + 1}</td>
      <td><b>${esc(x.anchor)}</b><div class="small muted sentence">${esc(x.block.text.slice(Math.max(0, x.range.s - 70), x.range.s)).replace(/^/, x.range.s > 70 ? "…" : "")}<mark>${esc(x.anchor)}</mark>${esc(x.block.text.slice(x.range.e, x.range.e + 70))}${x.block.text.length > x.range.e + 70 ? "…" : ""}</div></td>
      <td>${x.revised ? esc(x.revised) : '<span class="muted">—</span>'}</td>
      <td><span class="t">${esc(x.r.title)}</span><span class="u">${linkTo(x.r.u, full(x.r.u))}</span></td>
      <td>${tpill(x.r.type)}</td>
      <td class="small">${esc(x.block.head || "")}${x.block.k === "li" ? ' <span class="pill neutral">list item</span>' : ""}</td>
      <td class="why">${esc(x.reason)}</td></tr>`).join("") : `<tr><td colspan="7" class="empty">${F.status === "done" ? "No suggestions passed the checks." : ""}</td></tr>`;
  $("from-dropped").innerHTML = F.dropped.length ? `<details><summary>${F.dropped.length} suggestion${F.dropped.length === 1 ? "" : "s"} removed by the checks</summary><ul>${F.dropped.map(x => `<li><b>${esc(x.anchor)}</b> → ${esc(x.url)}: ${esc(x.msg)}</li>`).join("")}</ul></details>` : "";
}
function copyFrom() {
  const F = S.from; if (!F || !F.rows.length) return;
  const head = ["Anchor Text in Draft", "Revised Anchor Text", "Suggested URL", "Destination Page Title", "Page Type", "Section in Draft", "Sentence", "Reason"];
  const lines = F.rows.filter(x => !F.filter || x.r.type === F.filter).map(x => [x.anchor, x.revised, full(x.r.u), x.r.title, tlabel(x.r.type), x.block.head || "", x.block.text, x.reason]);
  copyTSV(head, lines);
}
function copyTSV(head, lines) {
  const clean = (v) => String(v ?? "").replace(/[\t\r\n]+/g, " ");
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
  const prompt = `${isNew ? `A new ${CFG.site} article is about to be published.` : `This is an existing ${CFG.site} page that needs more internal links pointing to it.`} We'll search the body text of every other moz.com page for phrases that refer to this page's topic, so those pages can link to it.

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
      const prompt = `We're adding internal links TO a new article from existing ${CFG.domain} pages.

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
        <td style="min-width:230px;max-width:320px"><span class="t">${esc(r.pg.t)}</span><span class="u">${linkTo(r.pg.u, r.pg.u)}</span><div class="small muted">${tpill(r.pg.s)} ${esc((r.pg.d || "").slice(0, 4))}${r.count > 1 ? ` · ${r.count} mentions` : ""}</div></td>
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
    list.map(r => [full(r.pg.u), r.pg.t, tlabel(r.pg.s), cv(r.pg.c), r.head || "", r.anchor, r.text, r.edit || "", full(S.target), r.reason || "", r.conf || ""]));
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
  if (!S.ready) { toast("The content index is still loading."); return; }
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
    const out = await ask(`An SEO is searching the body text of ${CFG.domain}'s pages for passages about: ${q.map(x => `"${x}"`).join(", ")}.
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
  A.loading = true; renderAudit();
  await configReady;
  try {
    A.data = await (await fetch("audit.json", { cache: "no-cache" })).json();
    A.data.rows.forEach(r => A.byPath.set(r.u, r));
  } catch (e) { A.error = "The audit data couldn't load. Reload the page."; }
  A.loading = false;
  try { const saved = JSON.parse(localStorage.getItem("ilAudit") || "{}"); for (const [u, j] of Object.entries(saved)) A.jobs.set(u, j); } catch (e) {}
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
  if (A.inited || !A.data) return; A.inited = true;
  $("au-q").addEventListener("input", () => { A.q = $("au-q").value.trim().toLowerCase(); A.page = 0; renderAudit(); });
  $("au-sec").onchange = () => { A.section = $("au-sec").value; A.page = 0; renderAudit(); };
  $("au-sort").onchange = () => { A.sort = $("au-sort").value; A.page = 0; renderAudit(); };
  $("au-copy").onclick = () => {
    const list = auditList();
    copyTSV(["URL", "Title", "Type", "Clicks (3 mo)", "Avg position", "Pages linking in", "Expected", "Links out", "Keyword anchors", "Generic anchors", "Branded anchors", "Other anchors", "Related pages linked", "Related pages", "Issues", "Quick win score"],
      list.slice(0, 1000).map(r => { const rel = r.rel.filter(x => !r.dup.includes(x[0])).slice(0, 8); return [full(r.u), r.t, tlabel(r.s), cv(r.c), r.pos ?? "", r.inP, r.exp, r.ix ? r.out : "", ...r.a, rel.filter(x => x[2]).length, rel.length, issues(r).map(i => ISS_LABEL[i]).join(", "), r.q]; }));
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
      <td style="min-width:240px;max-width:360px"><span class="t">${esc(r.t)}</span><span class="u">${esc(r.u)}</span><div class="small muted">${tpill(r.s)}${r.kw[0] ? " · " + esc(r.kw[0]) : ""}</div></td>
      <td class="n">${fmtS(r.c)}${r.sk ? '<div class="small" title="Average position 4–20 with 1,000+ impressions"><span class="pill warn">striking distance</span></div>' : ""}</td>
      <td class="n">${r.pos ? r.pos.toFixed(1) : "–"}</td>
      <td class="n"><b>${fmt(r.inP)}</b><div class="small muted">expect ~${r.exp}</div></td>
      <td style="min-width:150px">${mixBar(r.a)}</td>
      <td class="n">${r.ix ? (rel.length ? `${linked} of ${rel.length}` : "–") : '<span class="muted small">' + (isCommercial(r.s) ? "not crawled (commercial page)" : "not crawled") + '</span>'}</td>
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
    localStorage.setItem("ilAudit", JSON.stringify(o));
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
      <p class="small muted">${fmt(r.inP)} page${r.inP === 1 ? "" : "s"} link here in body text (${fmt(r.in)} links). For ${fmtS(r.c || 0)} clicks we'd expect about ${r.exp}.</p>
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
      ${r.ix ? (rel.length ? `<table class="mini"><thead><tr><th>Page</th><th class="n">Similarity</th><th class="n">Clicks</th><th>This page links to it</th><th>It links here</th></tr></thead><tbody>${rel.map(([u, sim, to, from]) => { const o = A.byPath.get(u) || { t: u, c: null }; const dup = r.dup.includes(u); const stronger = (o.c || 0) >= Math.max(3 * (r.c || 0), (r.c || 0) + 50); return `<tr><td><span class="t">${esc(o.t)}</span><span class="u">${linkTo(u, u)}</span>${dup ? ' <span class="pill claude">very similar: check cannibalization</span>' : stronger ? ' <span class="pill good">stronger page</span>' : ""}</td><td class="n">${Math.round(sim * 100)}%</td><td class="n">${fmtS(o.c)}</td><td>${to ? '<span class="pill good">Yes</span>' : '<span class="pill bad">No</span>'}</td><td>${from ? '<span class="pill good">Yes</span>' : '<span class="pill bad">No</span>'}</td></tr>`; }).join("")}</tbody></table>` : '<p class="small muted">No closely related pages found.</p>') : '<p class="small muted">This page isn\'t in the content index (product pages aren\'t crawled), so related pages can\'t be worked out.</p>'}
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
  if (!S.ready) { toast("The content index is still loading."); return; }
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
  const prompt = `These links on ${CFG.domain} point to ${full(r.u)} ("${r.t}"). The page targets these keywords: ${r.kw.slice(0, 5).join(", ") || "(none recorded)"}.
Their anchor text is branded (a ${CFG.site} brand or product name) or generic ("here", "this post"). Descriptive, keyword-led anchors tell readers and search engines what the destination is about.

For each link, suggest a better anchor:
- Lead with what the page does or covers (e.g. "backlink checker" rather than "BrandName Link Tool"), using the target keywords where they read naturally. Vary the wording across links; don't give every link the identical anchor.
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
  const prompt = `We're tightening internal links between closely related ${CFG.domain} pages.
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
    if (!S.draft) { localStorage.removeItem("ilLast"); return; }
    const to = S.to ? { ...S.to, busy: false, results: S.to.results.map(r => ({ u: r.pg.u, bi: r.bi, s: r.s, e: r.e, phrase: r.phrase, kind: r.kind, count: r.count, state: r.state, anchor: r.anchor, ar: r.ar, edit: r.edit, reason: r.reason, conf: r.conf })), already: S.to.already.map(p => p.u) } : null;
    const from = S.from ? { ...S.from, rows: S.from.rows.map(x => ({ b: x.block.id, anchor: x.anchor, range: x.range, revised: x.revised, u: x.r.u, reason: x.reason })) } : null;
    localStorage.setItem("ilLast", JSON.stringify({ draft: S.draft, url: $("d-url").value, from, to }));
  } catch (e) {}
}
function restoreLocal() {
  let saved; try { saved = JSON.parse(localStorage.getItem("ilLast") || "null"); } catch (e) {}
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
const ROUTES = ["draft", "from", "to", "audit", "search"];
function route() {
  let r = location.hash.replace("#", ""); if (!ROUTES.includes(r)) r = "draft";
  document.querySelectorAll("nav.tabs a").forEach(a => a.setAttribute("aria-current", a.dataset.tab === r ? "page" : "false"));
  ROUTES.forEach(x => $("view-" + x).hidden = x !== r);
  if (r === "audit") { loadAudit(); renderAudit(); }
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
const guardReady = (fn) => () => { if (!S.ready) { toast("The content index is still loading."); return; } if (!S.draft) { toast("Add a draft first."); return; } fn(); };
$("run-from").onclick = guardReady(runFrom);
$("run-to").onclick = guardReady(runTo);
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
route();
loadData().then(() => { if (S.ready) restoreLocal(); });
cap("sample").then(s => { SAMPLE = s; });
})();
