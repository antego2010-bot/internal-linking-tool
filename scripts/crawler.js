// Internal linking tool: browser crawler.
// Run it in a tab that is open on the site itself (same origin), through Claude's browser tool or the
// browser's DevTools console. It reads the sitemap, fetches every page in the configured sections, keeps
// the article body (paragraphs, list items, headings and the links inside them) and downloads one file:
// crawl-<date>.jsonl.gz to the browser's Downloads folder.
//
// 1. Paste this whole file once. It defines window.ILT.
// 2. Probe a few pages to find the selector that holds the article body:
//      await ILT.probe(["/blog/some-post", "/learn/some-page"])
//    It reports, per candidate selector, how many paragraphs and characters it finds. Pick the one that
//    holds the post body and nothing else (no nav, related posts, author box or comments).
// 3. Crawl:
//      ILT.crawl({ selector: ".post-content", sections: [{key: "Blog", pattern: "^/blog/"}, ...],
//                  commercial: ["^/products/"], exclude: ["^/tag/", "^/author/"], extra: ["/guide/a"] })
//    It runs in the background. Check progress with ILT.status(); the download starts when it finishes.
//    ILT.result() returns counts and any errors (no page text) once it's done.
(() => {
  const CANDIDATES = ["article .entry-content", ".entry-content", ".post-content", ".article-body", ".post-body", "article", "main", "[role=main]", ".content", "#content"];
  const SKIP = "nav,aside,footer,header,form,figure,figcaption,[role=navigation],[class*=related],[class*=share],[class*=author],[class*=comment],[class*=newsletter],[class*=subscribe],[class*=breadcrumb],[class*=toc],[class*=sidebar],[class*=cta]";
  const K = { H2: 0, H3: 1, H4: 1, P: 2, LI: 3, BLOCKQUOTE: 4, TD: 5 };
  const clean = (s) => s.replace(/\s+/g, " ").trim();
  const short = (u) => { try { const x = new URL(u, location.origin); return x.origin === location.origin ? x.pathname.replace(/\/+$/, "") || "/" : x.href; } catch (e) { return u; } };
  const parse = (html) => new DOMParser().parseFromString(html, "text/html");

  function blocksFrom(doc, selector) {
    const roots = selector ? [...doc.querySelectorAll(selector)] : [];
    const blocks = [];
    const seen = new Set();
    for (const root of roots) {
      for (const el of root.querySelectorAll("h2,h3,h4,p,li,blockquote,td")) {
        if (seen.has(el)) continue;
        const sk = el.closest(SKIP);  // skip boxes INSIDE the article (related posts, share bars), not the page around it
        if (sk && sk !== root && root.contains(sk)) continue;
        if (el.tagName === "LI" && el.querySelector("p")) continue;
        if (el.tagName === "BLOCKQUOTE" && el.querySelector("p")) continue;
        if (el.tagName === "TD" && el.querySelector("p,li")) continue;
        let node = el;
        if (el.tagName === "LI" && el.querySelector("ul,ol")) { node = el.cloneNode(true); node.querySelectorAll("ul,ol").forEach(x => x.remove()); }
        const text = clean(node.textContent), k = K[el.tagName];
        if (text.length < 3 || (k > 1 && text.length < 25)) continue;
        const links = [...node.querySelectorAll("a[href]")].map(a => [short(a.getAttribute("href")), clean(a.textContent)]);
        const b = [k, text]; if (links.length) b.push(links);
        seen.add(el); blocks.push(b);
      }
    }
    return blocks;
  }
  // The element whose direct <p> children hold the most text, as a CSS selector: a good first guess.
  function autoSelector(doc) {
    const score = new Map();
    doc.querySelectorAll("p").forEach(p => { const par = p.parentElement; if (!par || p.closest("nav,footer,header,aside")) return; score.set(par, (score.get(par) || 0) + clean(p.textContent).length); });
    let best = null, top = 0;
    score.forEach((v, el) => { if (v > top) { top = v; best = el; } });
    if (!best) return null;
    if (best.id) return "#" + CSS.escape(best.id);
    const cls = [...best.classList].filter(c => !/^(col|row|d-|p[xytblr]?-|m[xytblr]?-|text-|w-|h-|flex|grid)/.test(c)).slice(0, 2);
    return best.tagName.toLowerCase() + cls.map(c => "." + CSS.escape(c)).join("");
  }
  function meta(doc) {
    const t = clean(doc.querySelector("h1")?.textContent || doc.querySelector("meta[property='og:title']")?.content || doc.title || "");
    const p = doc.querySelector("meta[property='article:published_time']")?.content || doc.querySelector("time[datetime]")?.getAttribute("datetime") || "";
    return { t, p: p.slice(0, 10) };
  }
  async function sitemapUrls(start = "/sitemap.xml", depth = 0, out = new Set()) {
    if (depth > 3) return out;
    let xml;
    try { const r = await fetch(start); if (!r.ok) return out; xml = new DOMParser().parseFromString(await r.text(), "text/xml"); } catch (e) { return out; }
    const maps = [...xml.querySelectorAll("sitemap > loc")].map(l => l.textContent.trim());
    for (const m of maps) await sitemapUrls(m, depth + 1, out);
    xml.querySelectorAll("url > loc").forEach(l => out.add(l.textContent.trim()));
    return out;
  }
  const state = { running: false, done: 0, total: 0, pages: [], errors: [] };

  window.ILT = {
    async probe(paths) {
      const out = [];
      for (const p of paths) {
        const r = await fetch(p); const doc = parse(await r.text());
        const per = {};
        const auto = autoSelector(doc);
        for (const sel of [auto, ...CANDIDATES].filter(Boolean)) {
          const bl = blocksFrom(doc, sel);
          if (bl.length) per[sel] = { blocks: bl.length, chars: bl.reduce((a, b) => a + b[1].length, 0), first: bl.find(b => b[0] === 2)?.[1].slice(0, 90) || "" };
        }
        out.push({ path: p, status: r.status, title: meta(doc).t, auto, candidates: per });
      }
      return out;
    },
    async sitemapCount(sections) {
      const urls = [...await sitemapUrls()].map(short);
      return Object.fromEntries(sections.map(s => [s.key, urls.filter(u => new RegExp(s.pattern).test(u)).length]));
    },
    crawl(cfg) {
      if (state.running) return "Already running: check ILT.status()";
      Object.assign(state, { running: true, done: 0, total: 0, pages: [], errors: [] });
      (async () => {
        let found = await sitemapUrls(cfg.sitemap || "/sitemap.xml");
        if (!found.size) {  // no /sitemap.xml: try the Sitemap: lines in robots.txt
          const robots = await fetch("/robots.txt").then(r => r.ok ? r.text() : "").catch(() => "");
          for (const m of robots.matchAll(/^sitemap:\s*(\S+)/gim)) await sitemapUrls(m[1], 0, found);
        }
        const all = [...found].map(short);
        const ex = (cfg.exclude || []).map(x => new RegExp(x));
        const secRe = (cfg.sections || []).map(s => new RegExp(s.pattern));
        const comRe = (cfg.commercial || []).map(x => new RegExp(x));
        const pick = (u) => !ex.some(r => r.test(u)) && (secRe.some(r => r.test(u)) || comRe.some(r => r.test(u)));
        const list = [...new Set([...all.filter(u => u.startsWith("/") && pick(u)), ...(cfg.extra || [])])];
        state.total = list.length;
        let i = 0;
        const worker = async () => {
          while (i < list.length) {
            const u = list[i++];
            try {
              const r = await fetch(u);
              if (!r.ok) { state.errors.push([u, r.status]); continue; }
              const doc = parse(await r.text()), m = meta(doc);
              const titleOnly = comRe.some(x => x.test(u)) && !secRe.some(x => x.test(u));
              state.pages.push({ u, f: short(r.url), t: m.t, p: m.p, b: titleOnly ? [] : blocksFrom(doc, cfg.selector) });
            } catch (e) { state.errors.push([u, String(e)]); }
            finally { state.done++; }
            if (cfg.delayMs) await new Promise(res => setTimeout(res, cfg.delayMs));
          }
        };
        await Promise.all(Array.from({ length: cfg.concurrency || 6 }, worker));
        const gz = await new Response(new Blob([state.pages.map(p => JSON.stringify(p)).join("\n")]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([gz], { type: "application/gzip" }));
        a.download = (cfg.filename || "crawl") + "-" + new Date().toISOString().slice(0, 10) + ".jsonl.gz";
        if (cfg.download !== false) { document.body.appendChild(a); a.click(); }
        state.running = false; state.file = a.download; state.bytes = gz.byteLength;
      })().catch(e => { state.running = false; state.fatal = String(e); });
      return "Started. Check ILT.status()";
    },
    status() { return { running: state.running, done: state.done, total: state.total, errors: state.errors.length, file: state.file, fatal: state.fatal }; },
    result() {
      return { pages: state.pages.length, withText: state.pages.filter(p => p.b.length).length, empty: state.pages.filter(p => !p.b.length).map(p => p.u).slice(0, 30), errors: state.errors.slice(0, 50), file: state.file, bytes: state.bytes };
    },
  };
  return "ILT ready: ILT.probe([...]), ILT.sitemapCount(sections), ILT.crawl({...}), ILT.status(), ILT.result()";
})();
