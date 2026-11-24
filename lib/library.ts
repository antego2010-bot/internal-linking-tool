// Builds the keyword cannibalization library (the same four tables as the Google Sheet version):
// URL Inventory, Cannibalization Library, Topic Overlaps, Keyword URLs.
import type { IndexPage } from "./crawl";
export type GscRow = { query: string; page: string; clicks: number; impressions: number; position: number };
import { toks } from "./match";
import { mozCall } from "./moz";

export type Table = { cols: string[]; rows: (string | number)[][] };
export type Library = { inv: Table; lib: Table; ov: Table; ku: Table; meta: Record<string, unknown> };
type Obs = { kw: string; path: string; clicks: number | null; impr: number | null; pos: number; source: "Search Console" | "Moz" };

const ws = (s: string) => String(s || "").replace(/\s+/g, " ").trim();
const words = (s: string) => ws(s).split(" ").filter(Boolean).length;
const normKw = (s: string) => ws(String(s).toLowerCase());
const variantKey = (s: string) => [...new Set(toks(s))].sort().join(" ");

export function sectionOf(path: string): string {
  const p = path.toLowerCase();
  if (/^\/(blog|news|articles?|posts?|insights|resources\/blog)(\/|$)/.test(p)) return "Blog";
  if (/^\/(products?|pricing|features?|tools?|solutions?|platform|app)(\/|$)/.test(p)) return "Product";
  if (/^\/(beginners?-guide|guides?)/.test(p)) return "Guide";
  if (/^\/(learn|academy|resources|glossary|docs|help|courses?)(\/|$)/.test(p)) return "Learn";
  const seg = p.split("/")[1] || "home";
  return seg.charAt(0).toUpperCase() + seg.slice(1).replace(/-/g, " ");
}
const HUBS = new Set(["Learn", "Guide", "Product"]);
export const isHub = (s: string) => HUBS.has(s);

function intentOf(kw: string, mozIntent?: string): string {
  if (mozIntent) return mozIntent.charAt(0).toUpperCase() + mozIntent.slice(1);
  const k = kw.toLowerCase();
  if (/\b(buy|price|pricing|cost|cheap|discount|coupon|free trial|download|signup|sign up)\b/.test(k)) return "Transactional";
  if (/\b(best|top|vs|versus|review|reviews|compare|comparison|alternatives?|tool|tools|software)\b/.test(k)) return "Commercial";
  if (/\b(login|log in|account)\b/.test(k)) return "Navigational";
  return "Informational";
}
function cleanTitle(t: string, brandTerms: string[]) {
  let s = ws(t).replace(/\s*[|\-–—:]\s*[^|\-–—:]{2,40}$/, "");
  for (const b of brandTerms) if (b) s = s.replace(new RegExp("\\b" + b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "ig"), "").trim();
  return s.replace(/\s*[[(][^\])]*[\])]\s*/g, " ").replace(/\b(19|20)\d\d\b/g, "").replace(/\s+/g, " ").replace(/^[-:|\s]+|[-:|\s]+$/g, "").trim() || ws(t);
}
const statusOf = (pos: number | null) => pos == null ? "Not ranking (top 20)" : pos <= 3 ? "Top 3" : pos <= 10 ? "Page 1" : "Page 2";

export type BuildInput = {
  domain: string; brandTerms: string[]; pages: IndexPage[]; excludePrefixes: string[]; includePrefixes?: string[];
  mozToken: string; mozRows: number; volumeLimit: number;
  gsc?: { rows: GscRow[]; siteUrl: string; start: string; end: string } | null;
  ga4?: Map<string, number> | null; ga4Property?: string;
  mock?: boolean;
  onProgress?: (msg: string) => void;
};

export async function buildLibrary(inp: BuildInput): Promise<Library> {
  const { domain } = inp;
  const brand = inp.brandTerms.map(b => b.toLowerCase().trim()).filter(Boolean);
  const isBranded = (k: string) => brand.some(b => k.includes(b));
  const under = (p: string, x: string) => { const b = "/" + x.replace(/^https?:\/\/[^/]+/, "").replace(/^\/+|\/+$/g, ""); return b === "/" || p === b || p.startsWith(b + "/"); };
  const inc = (inp.includePrefixes || []).filter(Boolean);
  // Only the sections the user picked (if any), minus anything excluded.
  const excluded = (p: string) => (inc.length > 0 && !inc.some(x => under(p, x))) || inp.excludePrefixes.some(x => under(p, x));
  const full = (p: string) => `https://${domain}${p}`;
  const pathOf = (u: string) => { try { const x = new URL(u); if (x.hostname.replace(/^www\./, "") !== domain) return null; return x.pathname.replace(/\/+$/, "") || "/"; } catch { return null; } };
  const keep = (kw: string, pos: number) => pos <= 20 && words(kw) >= 2 && !isBranded(kw);

  // ---- 1. observations: keyword × page ----
  const obs: Obs[] = [];
  if (inp.gsc) for (const r of inp.gsc.rows) {
    const p = pathOf(r.page); const kw = normKw(r.query);
    if (!p || excluded(p) || !keep(kw, r.position)) continue;
    obs.push({ kw, path: p, clicks: r.clicks, impr: r.impressions, pos: Math.round(r.position * 10) / 10, source: "Search Console" });
  }
  const mozVol = new Map<string, number>(), mozDiff = new Map<string, number>(), mozIntent = new Map<string, string>();
  const gscKws = new Set(obs.map(o => o.kw));
  let mozFetched = 0;
  try {
    for (let n = 0; n * 50 < inp.mozRows; n++) {
      const r = inp.mock ? (await import("./mock")).mockMoz("data.site.ranking-keyword.list") : await mozCall(inp.mozToken, "data.site.ranking-keyword.list", { target_query: { query: domain, scope: "domain", locale: "en-US" }, options: { sort: "volume" }, page: { n, limit: 50 } });
      const list = (r && r.ranking_keywords) || [];
      mozFetched += list.length;
      for (const k of list) {
        const kw = normKw(k.keyword), p = pathOf(k.ranking_page);
        if (k.volume != null) mozVol.set(kw, k.volume); if (k.difficulty != null) mozDiff.set(kw, k.difficulty);
        if (!p || excluded(p) || !keep(kw, k.rank_position)) continue;
        if (!gscKws.has(kw)) obs.push({ kw, path: p, clicks: null, impr: null, pos: k.rank_position, source: "Moz" });
      }
      inp.onProgress?.(`Moz ranking keywords: ${mozFetched}`);
      if (list.length < 50 || inp.mock) break;
    }
  } catch (e) { if (!inp.gsc) throw e; }

  // ---- 2. group by keyword (+ Moz keyword variants that point to different pages) ----
  type Grp = { keyword: string; pages: Map<string, { clicks: number | null; impr: number | null; pos: number }>; source: string };
  const groups = new Map<string, Grp>();
  for (const o of obs) {
    let g = groups.get(o.kw); if (!g) { g = { keyword: o.kw, pages: new Map(), source: o.source }; groups.set(o.kw, g); }
    const cur = g.pages.get(o.path);
    if (!cur) g.pages.set(o.path, { clicks: o.clicks, impr: o.impr, pos: o.pos });
    else { cur.clicks = (cur.clicks ?? 0) + (o.clicks ?? 0); cur.impr = (cur.impr ?? 0) + (o.impr ?? 0); cur.pos = Math.min(cur.pos, o.pos); }
  }
  if (!inp.gsc) { // Moz sees one ranking page per keyword: merge close variants ("fix keyword cannibalization" / "keyword cannibalization fix")
    const byVar = new Map<string, Grp[]>();
    groups.forEach(g => { const k = variantKey(g.keyword); if (!k.includes(" ")) return; (byVar.get(k) || byVar.set(k, []).get(k)!).push(g); });
    byVar.forEach(list => {
      const paths = new Set(list.flatMap(g => [...g.pages.keys()]));
      if (list.length < 2 || paths.size < 2) return;
      list.sort((a, b) => (mozVol.get(b.keyword) || 0) - (mozVol.get(a.keyword) || 0));
      const head = list[0]; head.source = "Moz (keyword variants)";
      for (const g of list.slice(1)) { g.pages.forEach((v, p) => { const c = head.pages.get(p); if (!c || v.pos < c.pos) head.pages.set(p, v); }); groups.delete(g.keyword); }
    });
  }

  // ---- 3. which groups are cannibalized ----
  type Cann = { g: Grp; main: string; urls: { path: string; clicks: number | null; impr: number | null; pos: number; role: string }[]; severity: string; clicks: number; impr: number };
  const cann: Cann[] = [];
  groups.forEach(g => {
    let list = [...g.pages.entries()].map(([path, v]) => ({ path, ...v }));
    const totImpr = list.reduce((a, x) => a + (x.impr || 0), 0);
    if (g.source === "Search Console") list = list.filter(x => totImpr === 0 || (x.impr || 0) / totImpr >= 0.1);
    if (list.length < 2) return;
    list.sort((a, b) => (b.clicks ?? -1) - (a.clicks ?? -1) || (b.impr ?? -1) - (a.impr ?? -1) || a.pos - b.pos);
    const main = list[0].path, totClicks = list.reduce((a, x) => a + (x.clicks || 0), 0);
    const second = list[1];
    const share = totClicks ? (second.clicks || 0) / totClicks : (totImpr ? (second.impr || 0) / totImpr : 0);
    const top10 = list.filter(x => x.pos <= 10).length;
    const severity = top10 >= 2 && (share >= 0.2 || !totClicks) ? "High" : list.filter(x => x.pos <= 20).length >= 2 && (share >= 0.1 || !totClicks) ? "Medium" : "Low";
    cann.push({ g, main, urls: list.map((x, i) => ({ ...x, role: i === 0 ? "Main" : "Cannibalizing" })), severity, clicks: totClicks, impr: totImpr });
  });

  // ---- 3b. without Search Console: other pages whose title + URL target the same keyword ----
  // Moz reports one ranking page per keyword, so pages that are built around the same keyword are the next best signal.
  const targetsOf = new Map<string, string[]>();
  if (!inp.gsc) {
    const cannKw = new Set(cann.map(c => c.g.keyword));
    const docs = inp.pages.filter(p => !excluded(p.u)).map(p => ({ u: p.u, t: new Set(toks(p.t + " " + p.u.split("/").filter(Boolean).pop()!.replace(/-/g, " "))) }));
    const df = new Map<string, number>(); docs.forEach(d => d.t.forEach(t => df.set(t, (df.get(t) || 0) + 1)));
    groups.forEach(g => {
      if (cannKw.has(g.keyword) || (mozVol.get(g.keyword) ?? 0) < 20) return;
      const k = [...new Set(toks(g.keyword))];
      if (k.length < 2 || k.every(t => (df.get(t) || 0) > docs.length * 0.15)) return; // too generic to mean anything
      const [main, mv] = [...g.pages.entries()].sort((a, b) => a[1].pos - b[1].pos)[0];
      const hits = docs.filter(d => d.u !== main && k.every(t => d.t.has(t)))
        .map(d => ({ u: d.u, score: k.length / d.t.size })).sort((a, b) => b.score - a.score).slice(0, 4);
      if (!hits.length) return;
      hits.forEach(h => (targetsOf.get(h.u) || targetsOf.set(h.u, []).get(h.u)!).push(g.keyword));
      g.source = "Moz + page titles";
      cann.push({ g, main, severity: mv.pos <= 10 ? "Medium" : "Low", clicks: 0, impr: 0,
        urls: [{ path: main, clicks: null, impr: null, pos: mv.pos, role: "Main" }, ...hits.map(h => ({ path: h.u, clicks: null, impr: null, pos: NaN, role: "Cannibalizing" }))] });
    });
  }

  // ---- 4. Moz volume + intent for the keywords that matter most ----
  const needVol = [...new Set([
    ...cann.sort((a, b) => b.impr - a.impr || b.clicks - a.clicks).map(c => c.g.keyword),
  ])].filter(k => !mozVol.has(k)).slice(0, inp.volumeLimit);
  for (let i = 0; i < needVol.length; i += 50) {
    const chunk = needVol.slice(i, i + 50);
    try {
      const r = inp.mock ? { results_by_serp_query: chunk.map(k => ({ serp_query: { keyword: k }, keyword_metrics: { volume: 100, difficulty: 30, intent: { primary_intents: ["informational"] } } })) } : await mozCall(inp.mozToken, "data.keyword.metrics.fetch.multiple", { serp_queries: chunk.map(keyword => ({ keyword, locale: "en-US", device: "desktop", engine: "google" })) });
      (r.results_by_serp_query || []).forEach((x: { serp_query: { keyword: string }; keyword_metrics?: { volume?: number; difficulty?: number; intent?: { primary_intents?: string[] } } }) => {
        const k = normKw(x.serp_query.keyword), m = x.keyword_metrics || {};
        if (m.volume != null) mozVol.set(k, m.volume); if (m.difficulty != null) mozDiff.set(k, m.difficulty);
        const pi = m.intent && m.intent.primary_intents && m.intent.primary_intents[0]; if (pi) mozIntent.set(k, pi);
      });
    } catch { break; }
    inp.onProgress?.(`Moz keyword volumes: ${Math.min(i + 50, needVol.length)}/${needVol.length}`);
  }

  // ---- 5. URL inventory ----
  const byPath = new Map<string, IndexPage>(); inp.pages.forEach(p => { if (!excluded(p.u)) byPath.set(p.u, p); });
  const pagesKw = new Map<string, { kw: string; clicks: number | null; impr: number | null; pos: number }[]>();
  groups.forEach(g => g.pages.forEach((v, p) => { (pagesKw.get(p) || pagesKw.set(p, []).get(p)!).push({ kw: g.keyword, ...v }); }));
  const allPaths = new Set([...byPath.keys(), ...pagesKw.keys()]);
  const mainOf = new Map<string, string[]>(), competesOf = new Map<string, string[]>();
  cann.forEach(c => c.urls.forEach(u => { if (Number.isNaN(u.pos)) return; const m = u.role === "Main" ? mainOf : competesOf; (m.get(u.path) || m.set(u.path, []).get(u.path)!).push(c.g.keyword); }));
  type InvRow = { path: string; title: string; topic: string; target: string; vol: number | null; status: string; clicks: number | null; impr: number | null; pos: number | null; section: string; published: string; intent: string; sessions: number | null; cluster: string; overlap: string };
  const inv: InvRow[] = [];
  allPaths.forEach(path => {
    const pg = byPath.get(path); const kws = (pagesKw.get(path) || []).slice();
    kws.sort((a, b) => (b.clicks ?? -1) - (a.clicks ?? -1) || (mozVol.get(b.kw) || 0) - (mozVol.get(a.kw) || 0) || a.pos - b.pos);
    const target = kws[0] ? kws[0].kw : "";
    const clicks = inp.gsc ? kws.reduce((a, k) => a + (k.clicks || 0), 0) : null;
    const impr = inp.gsc ? kws.reduce((a, k) => a + (k.impr || 0), 0) : null;
    const pos = kws.length ? (impr ? Math.round(kws.reduce((a, k) => a + k.pos * (k.impr || 0), 0) / impr * 10) / 10 : Math.min(...kws.map(k => k.pos))) : null;
    const title = pg ? pg.t : "";
    inv.push({ path, title, topic: target || cleanTitle(title || path.split("/").pop()!.replace(/-/g, " "), brand), target, vol: target ? mozVol.get(target) ?? null : null, status: statusOf(kws.length ? Math.min(...kws.map(k => k.pos)) : null), clicks, impr, pos, section: sectionOf(path), published: pg ? pg.d : "", intent: target ? intentOf(target, mozIntent.get(target)) : "", sessions: inp.ga4 ? inp.ga4.get(path) ?? 0 : null, cluster: "", overlap: mainOf.has(path) || competesOf.has(path) ? "Ranking cannibalization" : targetsOf.has(path) ? "Keyword targeting overlap" : "None" });
  });

  // topic clusters: the most specific shared word (appears in 3+ topics but not everywhere)
  const df = new Map<string, number>(), label = new Map<string, string>();
  inv.forEach(r => { const seen = new Set<string>(); r.topic.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2).forEach(w => { const s = toks(w)[0]; if (!s || seen.has(s)) return; seen.add(s); df.set(s, (df.get(s) || 0) + 1); if (!label.has(s)) label.set(s, w); }); });
  const maxDf = Math.max(4, inv.length * 0.2);
  inv.forEach(r => {
    const cands = [...new Set(toks(r.topic))].filter(s => (df.get(s) || 0) >= 3 && (df.get(s) || 0) <= maxDf);
    cands.sort((a, b) => (df.get(b) || 0) - (df.get(a) || 0));
    const w = cands[0] ? label.get(cands[0]) || cands[0] : "";
    r.cluster = w ? w.charAt(0).toUpperCase() + w.slice(1) : "Other";
  });

  // ---- 6. topic overlaps: pages with near-identical topics (inverted index on specific words) ----
  const tset = inv.map(r => new Set(toks(r.topic)));
  const post = new Map<string, number[]>();
  tset.forEach((s, i) => s.forEach(t => { const d = df.get(t) || 0; if (d <= 60) (post.get(t) || post.set(t, []).get(t)!).push(i); }));
  const parent = inv.map((_, i) => i); const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const tried = new Set<string>();
  post.forEach(list => {
    for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
      const i = list[a], j = list[b], key = i < j ? i + "," + j : j + "," + i; if (tried.has(key)) continue; tried.add(key);
      const A = tset[i], B = tset[j]; if (A.size < 2 || B.size < 2) continue;
      let inter = 0; A.forEach(t => { if (B.has(t)) inter++; });
      if (inter >= 2 && inter / (A.size + B.size - inter) >= 0.6) parent[find(i)] = find(j);
    }
  });
  const clusters = new Map<number, number[]>(); inv.forEach((_, i) => { const r = find(i); (clusters.get(r) || clusters.set(r, []).get(r)!).push(i); });
  const ovRows: (string | number)[][] = [];
  const pairKw = new Set<string>(); cann.forEach(c => { const ps = c.urls.filter(u => !Number.isNaN(u.pos)).map(u => u.path); for (const a of ps) for (const b of ps) if (a !== b) pairKw.add(a + "|" + b); });
  clusters.forEach(ix => {
    if (ix.length < 2) return;
    const rows = ix.map(i => inv[i]).sort((a, b) => (b.clicks ?? b.sessions ?? 0) - (a.clicks ?? a.sessions ?? 0) || (b.vol || 0) - (a.vol || 0));
    rows.forEach(r => { if (r.overlap === "None") r.overlap = "Topic overlap"; });
    const s = rows[0];
    const evidence = rows.slice(1).some(r => pairKw.has(s.path + "|" + r.path)) ? "Yes" : "No";
    const stat = (r: InvRow) => [r.clicks != null ? `${r.clicks} clicks` : r.sessions != null ? `${r.sessions} sessions` : "", r.published ? r.published.slice(0, 4) : "", r.status].filter(Boolean).join(", ");
    const tc = inp.gsc ? rows.reduce((a, r) => a + (r.clicks || 0), 0) : "", ti = inp.gsc ? rows.reduce((a, r) => a + (r.impr || 0), 0) : "";
    ovRows.push([s.topic, s.cluster, full(s.path), stat(s), rows.slice(1).map(r => `${full(r.path)} (${stat(r)})`).join("\n"), evidence,
      evidence === "Yes" ? "Pages compete in search: pick the strongest page, merge or differentiate the others, and cross-link." : "Same topic, no ranking conflict yet: give each page a distinct angle and link them together.", rows.length, tc, ti]);
  });

  // ---- 7. tables ----
  const invT: Table = { cols: ["URL", "Section", "Topic cluster", "Primary topic", "Target keyword", "Target keyword volume", "Ranking status", "Clicks (3 mo)", "Impressions (3 mo)", "Avg position", "Sessions (12 mo)", "Overlap type", "Page title", "Published", "Intent", "Top URL for (keyword library)", "Competes for (keyword library)"], rows: [] };
  inv.sort((a, b) => (b.clicks ?? -1) - (a.clicks ?? -1) || (b.vol ?? -1) - (a.vol ?? -1));
  inv.forEach(r => invT.rows.push([full(r.path), r.section, r.cluster, r.topic, r.target, r.vol ?? "", r.status, r.clicks ?? "", r.impr ?? "", r.pos ?? "", r.sessions ?? "", r.overlap, r.title, r.published, r.intent, (mainOf.get(r.path) || []).slice(0, 5).join(", "), (competesOf.get(r.path) || []).slice(0, 5).join(", ")]));

  const libT: Table = { cols: ["Keyword", "Search volume", "Difficulty", "Top URL", "Top URL position", "Cannibalized?", "Cannibalized URLs", "Severity", "Section", "Source", "Total clicks (3 mo)", "Total impressions (3 mo)"], rows: [] };
  const cannBy = new Map(cann.map(c => [c.g.keyword, c]));
  const libList = [...groups.values()].map(g => {
    const c = cannBy.get(g.keyword);
    const list = [...g.pages.entries()].map(([path, v]) => ({ path, ...v })).sort((a, b) => (b.clicks ?? -1) - (a.clicks ?? -1) || a.pos - b.pos);
    const top = c ? c.urls[0] : list[0];
    const clicks = list.reduce((a, x) => a + (x.clicks || 0), 0), impr = list.reduce((a, x) => a + (x.impr || 0), 0);
    return { g, c, top, clicks, impr };
  }).sort((a, b) => (mozVol.get(b.g.keyword) || 0) - (mozVol.get(a.g.keyword) || 0) || b.impr - a.impr).slice(0, 20000);
  libList.forEach(({ g, c, top, clicks, impr }) => libT.rows.push([g.keyword, mozVol.get(g.keyword) ?? "", mozDiff.get(g.keyword) ?? "", full(top.path), top.pos, c ? "Yes" : "No", c ? c.urls.slice(1).map(u => `${full(u.path)} (${Number.isNaN(u.pos) ? "title match" : "#" + u.pos})`).join(", ") : "", c ? c.severity : "", sectionOf(top.path), g.source, inp.gsc ? clicks : "", inp.gsc ? impr : ""]));

  const kuT: Table = { cols: ["Keyword", "Search volume", "Severity", "Section", "Source", "Main URL", "URL", "Role", "Position", "Clicks (3 mo)", "Impressions (3 mo)"], rows: [] };
  cann.forEach(c => c.urls.forEach(u => kuT.rows.push([c.g.keyword, mozVol.get(c.g.keyword) ?? "", c.severity, sectionOf(c.main), c.g.source, full(c.main), full(u.path), u.role, Number.isNaN(u.pos) ? "" : u.pos, u.clicks ?? "", u.impr ?? ""])));

  const ovT: Table = { cols: ["Topic", "Cluster", "Strongest page", "Strongest page stats", "Other pages (clicks, year, status)", "Ranking cannibalization evidence?", "Suggested action", "# pages", "Total clicks (3 mo)", "Total impressions (3 mo)"], rows: ovRows.sort((a, b) => Number(b[7]) - Number(a[7])) };

  return {
    inv: invT, lib: libT, ov: ovT, ku: kuT,
    meta: { domain, builtAt: new Date().toISOString(), sources: [inp.gsc ? `Search Console (${inp.gsc.siteUrl}${inp.gsc.start ? `, ${inp.gsc.start} to ${inp.gsc.end}` : ""})` : null, `Moz API (${mozFetched} ranking keywords)`, inp.ga4 ? `GA4 (${/^\d+$/.test(String(inp.ga4Property)) ? "property " + inp.ga4Property + ", last 12 months" : inp.ga4Property})` : null, `Site index (${inp.pages.length} pages)`].filter(Boolean), mode: inp.gsc ? "gsc" : "moz", urls: invT.rows.length, keywords: libT.rows.length, cannibalized: cann.length, overlaps: ovT.rows.length, mozKeywordRows: mozFetched, mozVolumeLookups: needVol.length },
  };
}
