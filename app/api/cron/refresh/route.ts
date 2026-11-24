import { crawlStep, getCrawl, getIndex, isFresh } from "@/lib/crawl";
import { normDomain } from "@/lib/http";
import { json, fail } from "@/lib/api";
import { list } from "@vercel/blob";

export const runtime = "nodejs";
export const maxDuration = 300;

// Daily (vercel.json): keeps pre-crawled site indexes (PRECRAWL_DOMAINS) under 30 days old, so libraries rebuild quickly.
export async function GET(req: Request) {
  try {
    // With CRON_SECRET set, Vercel sends it as a Bearer token. Without it, only Vercel's cron user agent is accepted
    // (the job is idempotent: it only refreshes stale data, so this is low-risk).
    const secret = process.env.CRON_SECRET;
    const ok = secret ? req.headers.get("authorization") === `Bearer ${secret}` : /^vercel-cron\//.test(req.headers.get("user-agent") || "");
    if (!ok) return json({ error: { message: "unauthorized" } }, 401);
    const t0 = Date.now(); const log: string[] = [];
    // Pre-crawled sites, plus any site whose crawl is still in progress (big indexes finish over nightly runs).
    const inProgress: string[] = [];
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      try {
        let cursor: string | undefined;
        do { const r = await list({ prefix: "sites/", cursor, limit: 1000 }); r.blobs.filter(b => b.pathname.endsWith("/crawl.json")).forEach(b => inProgress.push(b.pathname.split("/")[1])); cursor = r.hasMore ? r.cursor : undefined; } while (cursor);
      } catch { /* listing is best-effort */ }
    }
    const domains = [...new Set(["moz.com", ...(process.env.PRECRAWL_DOMAINS || "").split(",").map(normDomain).filter(Boolean), ...inProgress])];
    for (const d of domains) {
      if (Date.now() - t0 > 240_000) break;
      const [index, crawl] = await Promise.all([getIndex(d), getCrawl(d)]);
      if (isFresh(index) && !(crawl && crawl.status === "crawling")) { log.push(`${d}: fresh`); continue; }
      if (d !== "moz.com" && !(crawl && crawl.status === "crawling") && !(process.env.PRECRAWL_DOMAINS || "").includes(d)) continue; // other sites re-crawl when someone uses them
      const s = await crawlStep(d, Math.max(10_000, 240_000 - (Date.now() - t0)));
      log.push(`${d}: ${s.status} ${s.next}/${s.urls.length}`);
    }
    return json({ ok: true, log });
  } catch (e) { return fail(e); }
}
