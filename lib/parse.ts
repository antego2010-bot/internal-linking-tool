import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { normHost, normPath } from "./http";

// Block kinds match the client: h1-h4, p, li, td, quote, img, table
export type Link = { href: string; text: string };
export type Block = { k: string; text: string; links: Link[]; alt?: string };
export type ParsedPage = {
  url: string; title: string; published: string; modified: string; description: string;
  schema: string[]; blocks: Block[]; words: number;
};

const ws = (s: string) => s.replace(/\s+/g, " ").trim();
const DROP = "script,style,noscript,svg,iframe,form,button,nav,header,footer,aside,template,[role=navigation],[role=banner],[role=contentinfo],[aria-hidden=true],.sidebar,.nav,.menu,.breadcrumb,.breadcrumbs,.share,.social,.newsletter,.related,.comments,#comments,.cookie,.cookies,.author-bio,.toc,.table-of-contents";

function isoDate(s?: string | null): string {
  if (!s) return "";
  const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "";
}

function jsonLd($: cheerio.CheerioAPI) {
  const out: { types: string[]; published: string; modified: string; headline: string } = { types: [], published: "", modified: "", headline: "" };
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      const visit = (x: unknown) => {
        if (!x || typeof x !== "object") return;
        if (Array.isArray(x)) { x.forEach(visit); return; }
        const o = x as Record<string, unknown>;
        const t = o["@type"]; if (t) (Array.isArray(t) ? t : [t]).forEach(v => out.types.push(String(v)));
        if (!out.published && o.datePublished) out.published = isoDate(String(o.datePublished));
        if (!out.modified && o.dateModified) out.modified = isoDate(String(o.dateModified));
        if (!out.headline && o.headline) out.headline = String(o.headline);
        if (o["@graph"]) visit(o["@graph"]);
      };
      visit(data);
    } catch { /* ignore bad JSON-LD */ }
  });
  out.types = [...new Set(out.types)];
  return out;
}

function pickMain($: cheerio.CheerioAPI): cheerio.Cheerio<Element> {
  const cands = ["article", "main", "[role=main]", ".post-content", ".entry-content", ".article-body", ".post-body", ".content", "#content"];
  let best: cheerio.Cheerio<Element> | null = null, bestLen = 0;
  for (const sel of cands) {
    $(sel).each((_, el) => {
      const len = ws($(el).text()).length;
      if (len > bestLen) { best = $(el) as cheerio.Cheerio<Element>; bestLen = len; }
    });
    if (best && bestLen > 1500) break;
  }
  return best && bestLen > 400 ? best : ($("body") as cheerio.Cheerio<Element>);
}

export function parseHtml(html: string, pageUrl: string): ParsedPage {
  const $ = cheerio.load(html);
  const ld = jsonLd($);
  const meta = (sel: string) => $(sel).attr("content") || "";
  const title = ws(meta('meta[property="og:title"]') || $("title").first().text() || ld.headline || $("h1").first().text());
  const published = isoDate(meta('meta[property="article:published_time"]') || meta('meta[name="date"]') || meta('meta[itemprop="datePublished"]')) || ld.published || isoDate($("time[datetime]").first().attr("datetime"));
  const modified = isoDate(meta('meta[property="article:modified_time"]')) || ld.modified;
  const description = ws(meta('meta[name="description"]') || meta('meta[property="og:description"]'));
  const host = normHost(new URL(pageUrl).hostname);

  const main = pickMain($);
  main.find(DROP).remove();
  const blocks: Block[] = [];
  const h1 = ws($("h1").first().text());
  if (h1 && !main.find("h1").length) blocks.push({ k: "h1", text: h1, links: [] });

  const linksOf = (el: cheerio.Cheerio<AnyNode>): Link[] => {
    const out: Link[] = [];
    el.find("a[href]").each((_, a) => {
      const href = $(a).attr("href") || ""; const text = ws($(a).text());
      if (!text || /^(#|javascript:|mailto:|tel:)/i.test(href)) return;
      try {
        const u = new URL(href, pageUrl);
        out.push({ href: normHost(u.hostname) === host ? normPath(u.toString()) : u.toString(), text });
      } catch { /* skip */ }
    });
    return out;
  };

  const walk = (node: AnyNode) => {
    if (node.type !== "tag") return;
    const el = node as Element; const tag = el.tagName.toLowerCase(); const $el = $(el);
    if (/^h[1-6]$/.test(tag)) { const t = ws($el.text()); if (t) blocks.push({ k: "h" + Math.min(4, Number(tag[1])), text: t, links: [] }); return; }
    if (tag === "p") { const t = ws($el.text()); if (t) blocks.push({ k: "p", text: t, links: linksOf($el) }); $el.find("img").each((_, im) => { blocks.push({ k: "img", text: "", alt: ws($(im).attr("alt") || ""), links: [] }); }); return; }
    if (tag === "li") { const t = ws($el.clone().children("ul,ol").remove().end().text()); if (t) blocks.push({ k: "li", text: t, links: linksOf($el.clone().children("ul,ol").remove().end()) }); $el.children("ul,ol").each((_, c) => walk(c)); return; }
    if (tag === "blockquote") { const t = ws($el.text()); if (t) blocks.push({ k: "quote", text: t, links: linksOf($el) }); return; }
    if (tag === "img") { blocks.push({ k: "img", text: "", alt: ws($el.attr("alt") || ""), links: [] }); return; }
    if (tag === "table") {
      blocks.push({ k: "table", text: "", links: [] });
      $el.find("tr").each((_, tr) => { const t = $(tr).find("th,td").map((__, c) => ws($(c).text())).get().filter(Boolean).join(" · "); if (t) blocks.push({ k: "td", text: t, links: linksOf($(tr)) }); });
      return;
    }
    if (tag === "pre") return;
    el.children.forEach(walk);
  };
  main.children().each((_, c) => walk(c));
  // a div-only page with no <p>: fall back to text of leaf divs
  if (blocks.filter(b => b.k === "p").length < 2) {
    main.find("div").each((_, d) => { const $d = $(d); if ($d.children("div,p,ul,ol,table").length) return; const t = ws($d.text()); if (t.length > 60) blocks.push({ k: "p", text: t, links: linksOf($d) }); });
  }
  if (!blocks.some(b => b.k === "h1")) blocks.unshift({ k: "h1", text: title.replace(/\s*[-|–]\s*[^-|–]{2,40}$/, ""), links: [] });
  const words = blocks.filter(b => !/^h/.test(b.k)).reduce((a, b) => a + (b.text.match(/\S+/g) || []).length, 0);
  return { url: pageUrl, title, published, modified, description, schema: ld.types, blocks, words };
}

/** Compact form for the site index: [kind, text, links?] with kind 0=h2 1=h3 2=p 3=li 4=other. */
export function compactBlocks(blocks: Block[]): [number, string, [string, string][]?][] {
  const K: Record<string, number> = { h2: 0, h3: 1, h4: 1, p: 2, li: 3, td: 4, quote: 2 };
  return blocks.filter(b => b.k in K && b.text).map(b => {
    const l = b.links.filter(x => x.href.startsWith("/")).map(x => [x.href, x.text] as [string, string]);
    return l.length ? [K[b.k], b.text.slice(0, 2000), l] : [K[b.k], b.text.slice(0, 2000)];
  });
}
