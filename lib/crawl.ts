import { fetchText, mapLimit, normHost, normPath } from "./http";
import { parseHtml, compactBlocks } from "./parse";
import { getJSON, putJSON, sitePath } from "./store";

export type IndexPage = { u: string; t: string; d: string; s: string; w: number; b: ReturnType<typeof compactBlocks> };
export type SiteIndex = {
  domain: string; status: "crawling" | "ready" | "failed"; error?: string;
  startedAt: string; crawledAt: string; cap: number; sections?: string[]; partial?: boolean;
  urls: string[]; next: number; failed: number; pages: IndexPage[];
};

// Index sizes users can choose. Crawling itself uses no Moz or Claude calls.
export const SIZES = [500, 1000, 2500, 5000];
export const MIN_USABLE = 300; // an index becomes usable for reviews once this many pages are in

export const MAX_AGE_DAYS = 30;
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|mp3|xml|json|txt|css|js|ico|csv|xlsx?|docx?|pptx?)$/i;
const SKIP_PATH = /\/(tag|tags|category|categories|author|authors|page\/\d+|feed|search|cart|checkout|account|login|signin|signup|register|wp-json|wp-admin|cdn-cgi|amp)(\/|$)|[?#]/i;

// Site presets: which paths count as content worth indexing.
const PRESETS: Record<string, { include?: RegExp; exclude?: RegExp; cap: number }> = {
  // Same scope as the Moz keyword cannibalization library: full blog archive, Learn, Beginner's Guides, products; no /community.
  "moz.com": { include: /^\/(blog|learn|beginners-guide-to-[a-z0-9-]+|products)(\/|$)/, exclude: /^\/(community|blog\/category|blog\/author)(\/|$)/, cap: 5000 },
};
export const presetFor = (domain: string) => PRESETS[domain] || { cap: 500 };
export const capFor = (domain: string, requested?: number) => {
  const n = SIZES.includes(Number(requested)) ? Number(requested) : presetFor(domain).cap;
  return Math.min(5000, n);
};
/** "/blog/, /guides" → ["/blog", "/guides"] */
export const parseSections = (raw: unknown): string[] => (Array.isArray(raw) ? raw : String(raw || "").split(/[,\s]+/))
  .map(x => String(x).trim()).filter(Boolean).map(x => "/" + x.replace(/^https?:\/\/[^/]+/i, "").replace(/^\/+|\/+$/g, "")).filter(x => x !== "/").slice(0, 20);

export const isFresh = (s: SiteIndex | null) => !!s && s.status === "ready" && !s.partial && (Date.now() - Date.parse(s.crawledAt)) / 864e5 < MAX_AGE_DAYS;

async function robots(domain: string) {
  const out = { disallow: [] as string[], sitemaps: [] as string[] };
  try {
    const { text } = await fetchText(`https://${domain}/robots.txt`, { timeoutMs: 8000, maxBytes: 500_000, accept: "text/plain" });
    let applies = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/#.*/, "").trim(); if (!line) continue;
      const [k, ...rest] = line.split(":"); const v = rest.join(":").trim(); const key = k.toLowerCase();
      if (key === "sitemap") out.sitemaps.push(v);
      else if (key === "user-agent") applies = v === "*" || /mozonpagegrader/i.test(v);
      else if (key === "disallow" && applies && v) out.disallow.push(v);
    }
  } catch { /* no robots.txt */ }
  return out;
}
const disallowed = (path: string, rules: string[]) => rules.some(r => {
  if (r.includes("*") || r.endsWith("$")) { const re = new RegExp("^" + r.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")); return re.test(path); }
  return path.startsWith(r);
});

async function sitemapUrls(domain: string, seeds: string[], max = 20000): Promise<{ loc: string; lastmod: string }[]> {
  const queue = [...new Set(seeds.length ? seeds : [`https://${domain}/sitemap.xml`, `https://${domain}/sitemap_index.xml`])];
  const seen = new Set<string>(); const out: { loc: string; lastmod: string }[] = [];
  let files = 0;
  while (queue.length && files < 60 && out.length < max) {
    const sm = queue.shift()!; if (seen.has(sm)) continue; seen.add(sm); files++;
    let xml = "";
    try { xml = (await fetchText(sm, { timeoutMs: 12000, maxBytes: 20_000_000, accept: "application/xml,text/xml,*/*" })).text; } catch { continue; }
    if (/<sitemapindex/i.test(xml)) {
      for (const m of xml.matchAll(/<sitemap>[\s\S]*?<loc>\s*([^<\s]+)\s*<\/loc>[\s\S]*?<\/sitemap>/gi)) queue.push(m[1].replace(/&amp;/g, "&"));
    } else {
      for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
        const loc = (m[1].match(/<loc>\s*([^<\s]+)\s*<\/loc>/i) || [])[1]; if (!loc) continue;
        const lastmod = (m[1].match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i) || [])[1] || "";
        out.push({ loc: loc.replace(/&amp;/g, "&"), lastmod });
      }
    }
  }
  return out;
}

async function homepageLinks(domain: string): Promise<string[]> {
  try {
    const { text, url } = await fetchText(`https://${domain}/`, { timeoutMs: 12000 });
    const hrefs = [...text.matchAll(/href="([^"#]+)"/gi)].map(m => { try { return new URL(m[1], url).toString(); } catch { return ""; } });
    return hrefs.filter(Boolean);
  } catch { return []; }
}

function mockIndex(domain: string): SiteIndex {
  const P = (u: string, t: string, d: string, b: unknown[]) => ({ u, t, d, s: u.split("/")[1] || "home", w: 900, b }) as unknown as IndexPage;
  const pages: IndexPage[] = [
    P("/blog/ai-search-tips", "AI Search Tips", "2025-06-01", [[2, "AI search is changing how people find answers."], [0, "Why AI search matters"], [2, "Many marketers now invest in generative engine optimization to win citations in AI answers.", [["/learn/keyword-research", "keyword research"]]], [2, "Read more about it here in our guide.", [["/blog/generative-engine-optimization", "here"]]]]),
    P("/blog/generative-engine-optimization", "What Is Generative Engine Optimization", "2025-03-01", [[2, "Intro."], [0, "What it is"], [2, "Generative engine optimization is the practice of making content citable by AI search tools.", [["/learn/keyword-research", "Learn keyword research"]]], [3, "AI answers cite sources that are clear and specific."]]),
    P("/learn/keyword-research", "Keyword Research Guide", "2024-01-10", [[2, "Intro."], [0, "Basics"], [2, "Keyword research finds the words people search for, including in AI search.", [["/blog/ai-search-tips", "Moz"]]]]),
    P("/explorer", "Keyword Research Tool", "", [[0, "Keyword research"], [2, "Find keywords with our keyword research tool."]]),
  ];
  const now = new Date().toISOString();
  return { domain, status: "ready", startedAt: now, crawledAt: now, cap: pages.length, urls: pages.map(p => p.u), next: pages.length, failed: 0, pages };
}

export async function startCrawl(domain: string, opts: { cap?: number; sections?: string[]; priority?: string[] } = {}): Promise<SiteIndex> {
  if (process.env.MOCK === "1") { const m = mockIndex(domain); await putJSON(sitePath(domain, "index.json"), m); await putJSON(sitePath(domain, "crawl.json"), { ...m, pages: [] }); return m; }
  const preset = presetFor(domain);
  const cap = capFor(domain, opts.cap);
  const sections = opts.sections || [];
  const inSections = (p: string) => !sections.length || sections.some(sec => p === sec || p.startsWith(sec + "/"));
  const priority = new Map((opts.priority || []).map((u, i) => [u, i]));
  const rb = await robots(domain);
  let found = await sitemapUrls(domain, rb.sitemaps);
  if (!found.length) found = (await homepageLinks(domain)).map(loc => ({ loc, lastmod: "" }));
  const seen = new Set<string>();
  const urls = found
    .filter(x => { try { const u = new URL(x.loc); return normHost(u.hostname) === domain; } catch { return false; } })
    .map(x => ({ path: normPath(x.loc), lastmod: x.lastmod }))
    .filter(x => x.path && !SKIP_EXT.test(x.path) && !SKIP_PATH.test(x.path) && !disallowed(x.path, rb.disallow))
    .filter(x => (sections.length ? inSections(x.path) : (!preset.include || preset.include.test(x.path))) && (!preset.exclude || !preset.exclude.test(x.path)))
    .filter(x => { if (seen.has(x.path)) return false; seen.add(x.path); return true; })
    // pages that rank (Moz) first, then most recently updated
    .sort((a, b) => (priority.has(a.path) ? priority.get(a.path)! : 1e9) - (priority.has(b.path) ? priority.get(b.path)! : 1e9) || (b.lastmod || "").localeCompare(a.lastmod || ""))
    .slice(0, cap)
    .map(x => x.path);
  const state: SiteIndex = { domain, status: urls.length ? "crawling" : "failed", error: urls.length ? undefined : (sections.length ? "No URLs in those sections were found in the sitemap." : "No content URLs found (no sitemap and no links on the homepage)."), startedAt: new Date().toISOString(), crawledAt: "", cap, sections, urls, next: 0, failed: 0, pages: [] };
  await putJSON(sitePath(domain, "crawl.json"), state);
  return state;
}

/** Crawl the next batch within a time budget; saves progress so the next call resumes. */
export async function crawlStep(domain: string, budgetMs = 45_000, restart?: { cap?: number; sections?: string[]; priority?: string[] }): Promise<SiteIndex> {
  // A new crawl is written to crawl.json and only replaces index.json when complete, so the old index stays usable meanwhile.
  let state = await getJSON<SiteIndex>(sitePath(domain, "crawl.json"), 0);
  const stale = state && state.status === "crawling" && Date.now() - Date.parse(state.startedAt) > 3 * 864e5;
  if (restart || !state || state.status !== "crawling" || stale) state = await startCrawl(domain, restart || (state ? { cap: state.cap, sections: state.sections } : {}));
  if (state.status !== "crawling") return state;
  const t0 = Date.now();
  while (state.next < state.urls.length && Date.now() - t0 < budgetMs) {
    const batch = state.urls.slice(state.next, state.next + 24);
    const res = await mapLimit(batch, 8, async (path) => {
      try {
        const { text, url } = await fetchText(`https://${domain}${path}`, { timeoutMs: 12000, maxBytes: 3_000_000 });
        const pg = parseHtml(text, url);
        if (pg.words < 120) return null;
        return { u: path, t: pg.title, d: pg.published, s: path.split("/")[1] || "home", w: pg.words, b: compactBlocks(pg.blocks) } as IndexPage;
      } catch { return undefined; }
    });
    res.forEach(r => { if (r) state!.pages.push(r); else if (r === undefined) state!.failed++; });
    state.next += batch.length;
  }
  if (state.next >= state.urls.length) {
    state.status = "ready"; state.crawledAt = new Date().toISOString();
    await putJSON(sitePath(domain, "index.json"), { ...state, urls: [], partial: false });
  } else if (state.pages.length >= MIN_USABLE) {
    // First crawl of a site: publish a partial index so reviews can start while the rest is crawled.
    const current = await getJSON<SiteIndex>(sitePath(domain, "index.json"), 0);
    if (!current || current.partial) await putJSON(sitePath(domain, "index.json"), { ...state, urls: [], status: "ready", partial: true, crawledAt: new Date().toISOString() });
  }
  await putJSON(sitePath(domain, "crawl.json"), state.status === "ready" ? { ...state, pages: [], urls: [] } : state);
  return state;
}

export async function getIndex(domain: string): Promise<SiteIndex | null> {
  return getJSON<SiteIndex>(sitePath(domain, "index.json"), 10 * 60_000);
}

export async function getCrawl(domain: string): Promise<SiteIndex | null> {
  return getJSON<SiteIndex>(sitePath(domain, "crawl.json"), 0);
}

export function siteSummary(index: SiteIndex | null, crawl: SiteIndex | null) {
  const crawling = crawl && crawl.status === "crawling" ? { done: crawl.next, total: crawl.urls.length, pages: crawl.pages.length, startedAt: crawl.startedAt, cap: crawl.cap } : null;
  const failed = crawl && crawl.status === "failed" ? crawl.error || "Crawl failed" : null;
  return {
    ready: !!index && index.status === "ready", fresh: isFresh(index), partial: !!(index && index.partial),
    pages: index ? index.pages.length : 0, crawledAt: index ? index.crawledAt : null,
    cap: index ? index.cap : crawl ? crawl.cap : null, sections: (index && index.sections) || (crawl && crawl.sections) || [],
    crawling, failed,
  };
}
