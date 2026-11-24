import type { IndexPage } from "./crawl";

export const CONCL_RE = /^\s*(in\s+)?(conclusion|conclusions|final thoughts|closing thoughts|wrapping (it )?up|wrap[- ]up|to sum (it )?up|summing up|in summary|summary|the bottom line|bottom line|over to you|tl;?dr|parting thoughts|last words)\b/i;
const normQ = (s: string) => String(s ?? "").replace(/[‘’‛]/g, "'").replace(/[“”]/g, '"').replace(/ /g, " ");
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
type Range = { s: number; e: number };
const overlaps = (r: Range, ranges: Range[]) => ranges.some(l => r.s < l.e && r.e > l.s);

const STOP = new Set("a an and are as at be by can do does for from how i in into is it its my of on or our should the this to vs what when where which who why will with you your guide best ways way tips 2024 2025 2026 2027 complete ultimate".split(" "));
const stem = (w: string) => w.replace(/(ies)$/, "y").replace(/(ing|ed|es|s)$/, "").replace(/(ation)$/, "ate");
export const toks = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter(w => w.length > 1 && !STOP.has(w)).map(stem);

function zones(pg: IndexPage) {
  let seenH2 = false, zone = "intro", head = "";
  const z: string[] = [], hd: string[] = [];
  pg.b.forEach(b => {
    if (b[0] === 0) { seenH2 = true; head = b[1]; zone = CONCL_RE.test(b[1]) ? "concl" : "body"; z.push("head"); hd.push(head); return; }
    if (b[0] === 1) { z.push("head"); hd.push(head); return; }
    z.push(seenH2 ? zone : "intro"); hd.push(head);
  });
  return { z, hd };
}
function buildMatcher(phrases: string[]) {
  const ps = [...new Set(phrases.map(p => normQ(p).toLowerCase().trim()).filter(p => p.length > 2))].sort((a, b) => b.length - a.length);
  if (!ps.length) return null;
  return new RegExp("(?<![\\p{L}\\p{N}])(" + ps.map(p => reEsc(p).replace(/\\-|\s+/g, "[\\s\\-]+")).join("|") + ")(?:s|es)?(?![\\p{L}\\p{N}])", "giu");
}
function anchorRanges(text: string, links?: [string, string][]) {
  const out: Range[] = [];
  if (links) for (const [, t0] of links) { const t = normQ(t0); if (!t) continue; const i = text.indexOf(t); if (i >= 0) out.push({ s: i, e: i + t.length }); }
  return out;
}

export type InboundCandidate = { u: string; t: string; s: string; d: string; head: string; text: string; ms: number; me: number; existing: [string, string][]; count: number };
/** Existing pages whose body text mentions the topic and don't already link to the target. */
export function searchInbound(pages: IndexPage[], core: string[], related: string[], target: string, limit = 45) {
  const reC = buildMatcher(core), reR = buildMatcher(related || []);
  const results: (InboundCandidate & { rank: number })[] = []; let already = 0;
  for (const pg of pages) {
    if (target && pg.u === target) continue;
    if (target && pg.b.some(b => (b[2] || []).some(([h]) => h === target))) { already++; continue; }
    const { z, hd } = zones(pg);
    let best: { i: number; text: string; s: number; e: number; score: number } | null = null, count = 0;
    pg.b.forEach((b, i) => {
      if (b[0] <= 1 || z[i] !== "body") return;
      const text = normQ(b[1]), ranges = anchorRanges(text, b[2]);
      for (const [re, kind] of [[reC, "core"], [reR, "related"]] as const) {
        if (!re) continue;
        re.lastIndex = 0; let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
          const r = { s: m.index, e: m.index + m[0].length };
          if (overlaps(r, ranges)) continue;
          count++;
          const score = (kind === "core" ? 3 : 1) * (b[0] === 2 ? 1 : b[0] === 3 ? 0.75 : 0.85);
          if (!best || score > best.score) best = { i, text, s: r.s, e: r.e, score };
        }
      }
    });
    if (best) {
      const bb = best as { i: number; text: string; s: number; e: number; score: number };
      results.push({ u: pg.u, t: pg.t, s: pg.s, d: pg.d, head: hd[bb.i], text: bb.text, ms: bb.s, me: bb.e, existing: pg.b[bb.i][2] || [], count, rank: bb.score * (1 + Math.min(count, 6) * 0.05) * (1 + Math.log10(1 + pg.w / 500)) });
    }
  }
  results.sort((a, b) => b.rank - a.rank);
  return { matched: results.length, already, candidates: results.slice(0, limit) };
}

/** Pages on the site whose title/headings match the topic (for overlap). */
export function matchTopic(pages: IndexPage[], query: string, selfPath: string, kwByUrl: Map<string, string>) {
  const df = new Map<string, number>();
  const docs = pages.map(p => {
    const heads = p.b.filter(b => b[0] === 0).map(b => b[1]).join(" ");
    const fields = { title: toks(p.t), heads: toks(heads), url: toks(p.u), kw: toks(kwByUrl.get(p.u) || "") };
    new Set(Object.values(fields).flat()).forEach(t => df.set(t, (df.get(t) || 0) + 1));
    return { p, fields };
  });
  const q = [...new Set(toks(query))]; if (!q.length) return [];
  const N = docs.length, idf = (t: string) => Math.log(1 + N / (1 + (df.get(t) || 0)));
  const total = q.reduce((a, t) => a + idf(t), 0) || 1;
  const W: Record<string, number> = { title: 1.15, heads: 0.8, url: 0.8, kw: 1.1 };
  return docs.map(d => {
    let best = 0;
    for (const [f, w] of Object.entries(W)) { const set = new Set((d.fields as Record<string, string[]>)[f]); best = Math.max(best, w * q.reduce((a, t) => a + (set.has(t) ? idf(t) : 0), 0) / total); }
    return { u: d.p.u, t: d.p.t, s: d.p.s, d: d.p.d, kw: kwByUrl.get(d.p.u) || "", score: Math.min(1, best) };
  }).filter(x => x.score >= 0.35 && x.u !== selfPath).sort((a, b) => b.score - a.score).slice(0, 8);
}

/** Candidate destinations for links from the draft. */
export function libraryCandidates(pages: IndexPage[], draftHeads: string, draftBody: string, exclude: Set<string>, kwByUrl: Map<string, string>, limit = 160) {
  const headT = new Set(toks(draftHeads));
  const bodyT = new Map<string, number>(); toks(draftBody).forEach(t => bodyT.set(t, (bodyT.get(t) || 0) + 1));
  return pages.filter(p => !exclude.has(p.u)).map(p => {
    const kw = kwByUrl.get(p.u) || "";
    const t = [...new Set(toks(p.t + " " + kw))]; if (!t.length) return { p, kw, s: 0 };
    const s = t.reduce((a, w) => a + (headT.has(w) ? 2 : 0) + Math.min(3, bodyT.get(w) || 0), 0) / t.length;
    const kwT = toks(kw); const bonus = kwT.length && kwT.every(w => bodyT.has(w)) ? 2 : 0;
    return { p, kw, s: s + bonus };
  }).filter(x => x.s > 0.6).sort((a, b) => b.s - a.s).slice(0, limit).map(x => ({ u: x.p.u, t: x.p.t, s: x.p.s, kw: x.kw }));
}
