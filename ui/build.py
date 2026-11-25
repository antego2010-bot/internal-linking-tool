#!/usr/bin/env python3
"""Builds public/index.html + public/app.js from the internal linking tool artifact (ui/source.html) plus the Vercel parts."""
import pathlib, re, sys

HERE = pathlib.Path(__file__).parent
SRC = (HERE / "source.html").read_text()
OUT = HERE.parent / "public"


def rep(s, old, new, count=1):
    n = s.count(old)
    if n < 1 or (count and n != count):
        sys.exit(f"patch failed ({n} matches): {old[:100]!r}")
    return s.replace(old, new)


head, rest = SRC.split("<body>", 1)
body, script = rest.split("<script>\n(() => {\n", 1)
script = script.rsplit("})();", 1)[0]

head = rep(head, "<title>Internal linking tool</title>", '<title>Internal linking tool</title>\n<meta name="description" content="Two-way internal link suggestions for any site: links from a new draft, links to it from your existing pages, and an internal link audit. Moz API + Claude.">')
head = rep(head, "</style>", (HERE / "extra.css").read_text() + "</style>")

# ---------- HTML ----------
body = rep(body, '<div class="sub">Two-way internal link suggestions for Moz drafts</div>', '<div class="sub" id="brand-sub">Two-way internal link suggestions</div>')
body = rep(body, '<a href="#search" data-tab="search">Search the index</a>', '<a href="#search" data-tab="search">Search the index</a>\n    <a href="#settings" data-tab="settings">Settings</a>')
body = rep(body, '''          <label for="gdoc">Or a Google Doc link</label>
          <div class="row"><input type="url" id="gdoc" placeholder="https://docs.google.com/document/d/…" style="flex:1"><button class="btn" type="button" id="gdoc-btn">Load</button></div>
          <span class="hint">Reads the Doc through your Google Drive connector.</span>''', '''          <label for="gdoc">Or a Google Doc link or live page URL</label>
          <div class="row"><input type="url" id="gdoc" placeholder="https://docs.google.com/document/d/… or https://yoursite.com/blog/post" style="flex:1"><button class="btn" type="button" id="gdoc-btn">Load</button></div>
          <span class="hint">Google Docs need sharing set to "Anyone with the link". A live URL loads a published post, to find links for it.</span>''')
body = rep(body, "The tool searches the text of every Moz blog, Learn and Beginner's Guide page for mentions of this post's topic, then Claude checks each sentence makes sense as a link.", "The tool searches the text of every indexed page on <span data-site>your site</span> for mentions of this post's topic, then Claude checks each sentence makes sense as a link.")
body = rep(body, '<input type="text" id="d-url" placeholder="https://moz.com/blog/your-post-slug">', '<input type="text" id="d-url" placeholder="https://yoursite.com/blog/your-post-slug">')
body = rep(body, "Every page ranked by quick-win score: Search Console clicks (last 3 months) weighted by how much there is to fix. Issue filters only flag pages with 20+ clicks.", "Every page ranked by quick-win score: traffic (Search Console clicks, or GA4 sessions) weighted by how much there is to fix. Issue filters only flag pages with 20+ clicks or sessions.")
body = rep(body, "Counts contextual links in article body text across the indexed blog, Learn and guide pages. Menus, footers and links on product pages aren't counted.", "Counts contextual links in article body text across every indexed page, worked out in your browser from the content index. Menus and footers aren't counted.")
body = re.sub(r'<select id="au-sec" style="width:auto">.*?</select>', '<select id="au-sec" style="width:auto"><option value="">All page types</option></select>', body, count=1, flags=re.S)
body = rep(body, "</main>", (HERE / "settings.html").read_text() + "</main>")
body = body.rstrip() + '\n<footer class="foot small muted">Keys, libraries and drafts stay in your browser. <a href="privacy.html">Privacy</a> · Built with the Moz API and Claude.</footer>\n'

# ---------- JS ----------
s = script
s = rep(s, '''const short = (u) => String(u || "").replace(/^https?:\\/\\/(www\\.)?moz\\.com/, "") || "/";''',
        '''const reDom = () => siteDomain().replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");
const short = (u) => { const d = siteDomain(); return (d ? String(u || "").replace(new RegExp("^https?://(www\\\\.)?" + reDom() + "(?=/|$)", "i"), "") : String(u || "")) || "/"; };''')
s = rep(s, '''const full = (p) => /^https?:/.test(p) ? p : "https://moz.com" + p;''', '''const full = (p) => /^https?:/.test(p) ? p : "https://" + (siteDomain() || "example.com") + p;''')
s = rep(s, '''const cap = (name) => (window.claude && typeof window.claude.use === "function") ? window.claude.use(name).catch(() => null) : Promise.resolve(null);
const TYPE_RANK = { Product: 1, BGuide: 2, Learn: 3, Blog: 4 };
const TYPE_LABEL = { Product: "Product", BGuide: "Beginner's Guide", Learn: "Learn", Blog: "Blog" };''',
'''const TYPE_RANK = { Product: 1, BGuide: 2, Guide: 2, Learn: 3, Docs: 3, Resources: 3, Academy: 3, Blog: 5 };
const TYPE_LABEL = new Proxy({ BGuide: "Beginner's Guide" }, { get: (o, k) => (k in o ? o[k] : k) });''')
s = rep(s, '''let SAMPLE = null, MCP = null;''', '''let SAMPLE = null;''')
# data loading is replaced by extra.js (loadIndex / setLibrary)
s = re.sub(r"async function fetchLines\(name\) \{.*?\n\}\n", "", s, count=1, flags=re.S)
s = re.sub(r"async function loadData\(\) \{.*?\n\}\n", "", s, count=1, flags=re.S)
# draft: internal links + URL guess, generic site
s = rep(s, '''d.internal = [...new Set(linksAll.filter(l => /^(https?:\\/\\/(www\\.)?moz\\.com)?\\//.test(l.href)).map(l => normPath(l.href)))];''',
        '''d.internal = [...new Set(linksAll.filter(l => /^\\/(?!\\/)/.test(l.href) || (siteDomain() && new RegExp("^https?://(www\\\\.)?" + reDom() + "(/|$)", "i").test(l.href))).map(l => normPath(l.href)))];''')
s = rep(s, '''const guess = S.index.find(p => p.t.toLowerCase().replace(/ - moz$/, "") === d.title.toLowerCase());''', '''const stripBrand = (t) => String(t || "").toLowerCase().replace(/\\s+[-|–—:]\\s+[^-|–—:]{1,40}$/, "").trim();
    const guess = S.index.find(p => stripBrand(p.t) === d.title.toLowerCase() || p.t.toLowerCase() === d.title.toLowerCase());''')
s = rep(s, '''"https://moz.com/blog/" + slugify(d.title);''', '''full("/blog/" + slugify(d.title));''')
# Google Doc / live URL loader through this app's server
GDOC = '''async function loadGdoc() {
  const url = $("gdoc").value.trim();
  if (!/^https?:\\/\\//.test(url)) { toast("Paste a Google Doc link or a page URL."); return; }
  const btn = $("gdoc-btn"); btn.disabled = true; btn.textContent = "Loading…";
  try {
    const out = await api("page", { url });
    if (out.docx) {
      const bin = atob(out.docx); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      showDraft(buildDraft(await parseDocx(u8.buffer), "Google Doc")); toast("Draft loaded from Google Docs.");
    } else {
      const pg = out.page, K2 = { h1: "h1", h2: "h2", h3: "h3", h4: "h4", p: "p", li: "li", td: "td", quote: "p" };
      const blocks = pg.blocks.filter(b => K2[b.k] && b.text).map(b => { const text = b.text.replace(/\\s+/g, " ").trim(); return { k: K2[b.k], text, links: (b.links || []).map(l => { const lt = String(l.text || "").replace(/\\s+/g, " ").trim(); const i = text.indexOf(lt); return { href: l.href, text: lt, s: i, e: i < 0 ? -1 : i + lt.length }; }).filter(l => l.text) }; });
      if (!blocks.some(b => b.k === "h1")) blocks.unshift({ k: "h1", text: pg.title || url, links: [] });
      showDraft(buildDraft(blocks, "live page"));
      if (pg.url) { $("d-url").value = pg.url; S.target = normPath(pg.url); }
      toast("Page loaded.");
    }
  } catch (e) { pageNotice("err", `<p>${esc(e.message || "Couldn't load that link.")}</p>`); }
  finally { btn.disabled = false; btn.textContent = "Load"; }
}
'''
s = re.sub(r"function findZipB64\(x\) \{.*?\n\}\nfunction mcpCopy\(e\) \{.*?\n\}\nasync function loadGdoc\(\) \{.*?\n\}\n", lambda m: GDOC, s, count=1, flags=re.S)
if "MCP.callTool" in s: sys.exit("loadGdoc not replaced")
# Claude through this app's server with the user's own key
s = rep(s, '''    default: return "Claude couldn't answer just now (" + ((e && e.code) || "error") + "). Press Run again.";''', '''    case "no_key": return "Add your Claude API key and model in Settings to get suggestions.";
    default: return (e && e.message) || "Claude couldn't answer just now. Press Run again.";''')
s = rep(s, '''async function ask(prompt, tier) {
  SAMPLE = SAMPLE || await cap("sample");
  if (!SAMPLE) throw { code: "not_granted" };
  return SAMPLE.json(prompt, { modelTier: tier || "default" });
}''', '''async function ask(prompt, tier) {
  if (!CFG.claude && !ST.mock) throw { code: "no_key" };
  return (await api("claude", { prompt, model: CFG.model })).json;
}''')
s = rep(s, "const RULES = `Moz internal linking rules (apply strictly):", "const RULES = `Internal linking rules (apply strictly):")
s = rep(s, "You are the internal linking specialist for the Moz blog. Suggest internal links to add to this draft, pointing to pages in Moz's URL library.", "You are the internal linking specialist for ${siteDomain()}. Suggest internal links to add to this draft, pointing to pages in the site's URL library.")
s = rep(s, "- Priority when several destinations fit the same spot: Product pages first, then Beginner's Guide (BGuide) pillar chapters, then Learn Center pages, then Blog posts.", "- Priority when several destinations fit the same spot: product/tool pages first, then guides and pillar pages, then learn/docs/hub pages, then blog posts. Between pages of the same type, prefer the one with more traffic (the traffic column).")
s = rep(s, "- The draft already links to these Moz URLs (do not suggest them):", "- The draft already links to these URLs on the site (do not suggest them):")
s = rep(s, '''const libLines = lib.map(r => `${r.id}|${r.type}|${r.u}|${r.kw}|${r.title}|${r.topic}`).join("\\n");''', '''const libLines = lib.map(r => `${r.id}|${r.type}|${r.u}|${r.kw}|${r.title}|${r.topic}|${r.c ?? ""}`).join("\\n");''')
s = rep(s, "URL library (id|type|path|keyword|title|topic):", "URL library (id|type|path|keyword|title|topic|traffic):")
s = rep(s, '''${isNew ? "A new Moz article is about to be published." : "This is an existing Moz page that needs more internal links pointing to it."} We'll search the body text of every other moz.com page''', '''${isNew ? "A new article is about to be published on " + siteDomain() + "." : "This is an existing page on " + siteDomain() + " that needs more internal links pointing to it."} We'll search the body text of every other ${siteDomain()} page''')
s = rep(s, "We're adding internal links TO a new Moz article from existing moz.com pages.", "We're adding internal links TO a new article from existing ${siteDomain()} pages.")
s = rep(s, "An SEO is searching the body text of moz.com's blog and Learn pages for passages about:", "An SEO is searching the body text of ${siteDomain()}'s pages for passages about:")
s = rep(s, '''const prompt = `These links on moz.com point to''', '''const prompt = `These links on ${siteDomain()} point to''')
s = rep(s, '''Their anchor text is branded (a Moz product name) or generic ("here", "this post").''', '''Their anchor text is branded (a ${brandName()} product or brand name) or generic ("here", "this post").''')
s = rep(s, '''- Lead with what the page does or covers (e.g. "backlink checker" rather than "Moz Link Explorer"),''', '''- Lead with what the page does or covers (e.g. "backlink checker" rather than "Acme Link Explorer"),''')
s = rep(s, "We're tightening internal links between closely related moz.com pages.", "We're tightening internal links between closely related ${siteDomain()} pages.")
s = rep(s, '''<span class="t">${esc(x.r.title.replace(/ - Moz$/, ""))}</span>''', '''<span class="t">${esc(x.r.title.replace(/\\s+[-|–]\\s+[^-|–]{1,40}$/, ""))}</span>''')
# From tab: page types present in this site's results
s = rep(s, '''  $("from-stats").innerHTML = [["Suggestions", rows.length], ["Product", byType("Product")], ["Beginner's Guide", byType("BGuide")], ["Learn", byType("Learn")], ["Blog", byType("Blog")]].map''', '''  const types = [...new Set(rows.map(x => x.r.type))].sort((a, b) => typeRank(a) - typeRank(b));
  $("from-stats").innerHTML = [["Suggestions", rows.length], ...types.slice(0, 5).map(t => [TYPE_LABEL[t], byType(t)])].map''')
s = rep(s, '''  $("from-chips").innerHTML = ["", "Product", "BGuide", "Learn", "Blog"].map''', '''  $("from-chips").innerHTML = ["", ...types].map''')
# copy: traffic column label
s = rep(s, '''  const tsv = [head, ...lines]''', '''  head = head.map(h => h === "Clicks (3 mo)" ? ST.traffic : h);
  const tsv = [head, ...lines]''')
# audit computed in the browser
s = rep(s, '''async function loadAudit() {
  if (A.data || A.loading) return;
  A.loading = true; renderAudit();
  try {
    A.data = await (await fetch("audit.json", { cache: "no-cache" })).json();
    A.data.rows.forEach(r => A.byPath.set(r.u, r));
  } catch (e) { A.error = "The audit data couldn't load. Reload the page."; }
  A.loading = false;
  try { const saved = JSON.parse(localStorage.getItem("ilAudit") || "{}"); for (const [u, j] of Object.entries(saved)) A.jobs.set(u, j); } catch (e) {}
  initAuditControls(); renderAudit();
}''', '''async function loadAudit() {
  if (A.data || A.loading) return;
  if (!S.ready) { A.error = "Index your site in Settings first: the audit is worked out from its content index."; return; }
  A.loading = true; A.error = ""; renderAudit();
  await new Promise(r => setTimeout(r, 30));
  try { A.data = computeAudit(); A.data.rows.forEach(r => A.byPath.set(r.u, r)); }
  catch (e) { A.error = "The audit couldn't be worked out: " + (e.message || e); }
  A.loading = false;
  try { const saved = JSON.parse(localStorage.getItem("ilAudit:" + siteDomain()) || "{}"); for (const [u, j] of Object.entries(saved)) A.jobs.set(u, j); } catch (e) {}
  initAuditControls(); renderAudit();
}''')
s = rep(s, '''  if (A.inited || !A.data) return; A.inited = true;''', '''  if (!A.data) return;
  const secs = [...new Set(A.data.rows.map(r => r.s))].sort((a, b) => typeRank(a) - typeRank(b) || a.localeCompare(b));
  $("au-sec").innerHTML = '<option value="">All page types</option>' + secs.map(t => `<option value="${esc(t)}">${esc(TYPE_LABEL[t])}</option>`).join("");
  $("au-sec").value = secs.includes(A.section) ? A.section : (A.section = "");
  if (A.inited) return; A.inited = true;''')
s = rep(s, '''copyTSV(["URL", "Title", "Type", "Clicks (3 mo)", "Avg position",''', '''copyTSV(["URL", "Title", "Type", ST.traffic, "Avg position",''')
s = rep(s, '''localStorage.setItem("ilAudit", JSON.stringify(o));''', '''localStorage.setItem("ilAudit:" + siteDomain(), JSON.stringify(o));''')
s = rep(s, '''<td class="n">${r.ix ? (rel.length ? `${linked} of ${rel.length}` : "–") : '<span class="muted small">' + (r.s === "Product" ? "product page" : "not crawled") + '</span>'}</td>''', '''<td class="n">${r.ix ? (rel.length ? `${linked} of ${rel.length}` : "–") : '<span class="muted small">not in the index</span>'}</td>''')
s = rep(s, '''For ${fmtS(r.c || 0)} clicks we'd expect about ${r.exp}.''', '''For ${fmtS(r.c || 0)} ${ST.traffic.startsWith("Sessions") ? "sessions" : "clicks"} we'd expect about ${r.exp}.''')
s = rep(s, '''This page isn\\'t in the content index (product pages aren\\'t crawled), so related pages can\\'t be worked out.''', '''This page isn\\'t in the content index (outside the indexed paths, or not crawled yet), so related pages can\\'t be worked out.''')
# per-site draft memory
s = rep(s, '''localStorage.removeItem("ilLast"); return; }''', '''localStorage.removeItem("ilLast:" + siteDomain()); return; }''')
s = rep(s, '''localStorage.setItem("ilLast", JSON.stringify(''', '''localStorage.setItem("ilLast:" + siteDomain(), JSON.stringify(''')
s = rep(s, '''saved = JSON.parse(localStorage.getItem("ilLast") || "null");''', '''saved = JSON.parse(localStorage.getItem("ilLast:" + siteDomain()) || "null");''')
# routing + guards + boot
s = rep(s, '''const ROUTES = ["draft", "from", "to", "audit", "search"];''', '''const ROUTES = ["draft", "from", "to", "audit", "search", "settings"];''')
s = rep(s, '''  if (r === "audit") { loadAudit(); renderAudit(); }''', '''  if (r === "audit") { loadAudit(); renderAudit(); }
  if (r === "settings") renderSettings();''')
s = rep(s, '''const guardReady = (fn) => () => { if (!S.ready) { toast("The content index is still loading."); return; } if (!S.draft) { toast("Add a draft first."); return; } fn(); };''',
        '''const guardReady = (fn, what) => () => { if (needSetup(what)) return; if (!S.draft) { toast("Add a draft first."); return; } fn(); };''')
s = rep(s, '''$("run-from").onclick = guardReady(runFrom);
$("run-to").onclick = guardReady(runTo);
$("run-both").onclick = guardReady(() => { runFrom(); runTo(); location.hash = "#from"; });
$("from-rerun").onclick = guardReady(runFrom);''', '''$("run-from").onclick = guardReady(runFrom);
$("run-to").onclick = guardReady(runTo, "to");
$("run-both").onclick = guardReady(() => { runFrom(); runTo(); location.hash = "#from"; });
$("from-rerun").onclick = guardReady(runFrom);''')
s = rep(s, '''applyDemo();
route();
loadData().then(() => { if (S.ready) restoreLocal(); });
cap("sample").then(s => { SAMPLE = s; });''', '''applyDemo();
bindSettings();
route();
(async () => {
  try { const h = await fetch(API_BASE + "/api/health").then(r => r.ok ? r.json() : {}); ST.mock = !!h.mock; } catch (e) {}
  renderLibHeader();
  await openSite();
  if (siteDomain()) refreshSite();
})();''')
s = rep(s, '''  if (!S.ready) { toast("The content index is still loading."); return; }
  const q = $("s-q").value''', '''  if (needSetup("index")) return;
  const q = $("s-q").value''')
s = rep(s, '''async function auditInbound(r) {
  if (!S.ready) { toast("The content index is still loading."); return; }''', '''async function auditInbound(r) {
  if (needSetup("to")) return;''')

for bad in ["moz.com", "Moz ", "MCP", "cap(", "audit.json", "meta.json", "library.json"]:
    hits = [l.strip()[:110] for l in s.splitlines() if bad in l]
    if hits: sys.exit(f"leftover {bad!r}: {hits}")

app = "(() => {\n" + (HERE / "extra.js").read_text() + "\n" + s + "\n})();\n"
html = head + "<body>" + body + '<script src="app.js"></script>\n</body>\n</html>\n'
OUT.mkdir(exist_ok=True)
(OUT / "app.js").write_text(app)
(OUT / "index.html").write_text(html)
print("ok", len(html), len(app))
