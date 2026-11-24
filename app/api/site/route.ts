import { crawlStep, getCrawl, getIndex, siteSummary, isFresh, capFor, parseSections } from "@/lib/crawl";
import { siteKeywords } from "@/lib/sitedata";
import { normDomain } from "@/lib/http";
import { mozRpc } from "@/lib/moz";
import { json, fail, body, isMock } from "@/lib/api";

export const runtime = "nodejs";
export const maxDuration = 60;

// GET ?domain= : index status. POST {domain}: crawl the next batch (needs a valid Moz token, to tie crawling to real users).
export async function GET(req: Request) {
  try {
    const domain = normDomain(new URL(req.url).searchParams.get("domain") || "");
    if (!domain) return json({ error: { message: "Enter your site's domain in Settings.", code: "no_domain" } }, 400);
    const [index, crawl] = await Promise.all([getIndex(domain), getCrawl(domain)]);
    return json({ domain, ...siteSummary(index, crawl) });
  } catch (e) { return fail(e); }
}

const verified = new Map<string, number>();
export async function POST(req: Request) {
  try {
    const { domain: raw, cap, sections, restart } = await body<{ domain: string; cap?: number; sections?: string | string[]; restart?: boolean }>(req);
    const domain = normDomain(raw);
    if (!domain) return json({ error: { message: "Enter your site's domain in Settings.", code: "no_domain" } }, 400);
    const token = req.headers.get("x-moz-token") || "";
    if (!isMock()) {
      if (!token) return json({ error: { message: "Add your Moz API token in Settings to index a site.", code: "no_token" } }, 401);
      const k = token.slice(-12);
      if (!verified.has(k)) { await mozRpc(token, "quota.lookup", { path: "api.limits.data.rows" }); verified.set(k, Date.now()); }
    }
    const index = await getIndex(domain);
    const crawl = await getCrawl(domain);
    const inProgress = !!crawl && crawl.status === "crawling";
    if (!restart && isFresh(index) && !inProgress) return json({ domain, ...siteSummary(index, crawl) });
    let start: { cap?: number; sections?: string[]; priority?: string[] } | undefined;
    if (restart || !inProgress) {
      // New crawl: pages the site ranks for (Moz, cached 30 days) are crawled first.
      let priority: string[] = [];
      try { priority = [...new Set((await siteKeywords(domain, token, isMock())).map(k => k.url))]; } catch { /* rank data is optional */ }
      start = { cap: capFor(domain, cap ?? index?.cap), sections: sections !== undefined ? parseSections(sections) : (index?.sections || []), priority };
    }
    await crawlStep(domain, 40_000, start);
    const [i2, c2] = await Promise.all([getIndex(domain), getCrawl(domain)]);
    return json({ domain, ...siteSummary(i2, c2) });
  } catch (e) { return fail(e); }
}
