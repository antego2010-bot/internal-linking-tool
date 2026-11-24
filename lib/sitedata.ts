import { getJSON, putJSON, sitePath } from "./store";
import { mozCall } from "./moz";
import { normHost, normPath } from "./http";

export type SiteKeyword = { keyword: string; url: string; pos: number; volume: number };
type KwFile = { fetchedAt: string; rows: SiteKeyword[] };

/** Top keywords the domain ranks for (Moz, US), cached 30 days; fetched with the caller's token when stale. */
export async function siteKeywords(domain: string, token: string, mock = false): Promise<SiteKeyword[]> {
  const path = sitePath(domain, "keywords.json");
  const cached = await getJSON<KwFile>(path, 3600_000);
  if (cached && (Date.now() - Date.parse(cached.fetchedAt)) / 864e5 < 30) return cached.rows;
  if (!token && !mock) return cached ? cached.rows : [];
  const rows: SiteKeyword[] = [];
  try {
    for (let n = 0; n < 4; n++) {
      const r = mock ? (await import("./mock")).mockMoz("data.site.ranking-keyword.list") : await mozCall(token, "data.site.ranking-keyword.list", { target_query: { query: domain, scope: "domain", locale: "en-US" }, options: { sort: "volume" }, page: { n, limit: 50 } });
      const list = (r && r.ranking_keywords) || [];
      list.forEach((k: { keyword: string; ranking_page: string; rank_position: number; volume: number }) => {
        let host = ""; try { host = normHost(new URL(k.ranking_page).hostname); } catch { /* */ }
        if (host && host !== domain) return;
        rows.push({ keyword: k.keyword, url: normPath(k.ranking_page), pos: k.rank_position, volume: k.volume });
      });
      if (list.length < 50 || mock) break;
    }
  } catch (e) { if (cached) return cached.rows; throw e; }
  await putJSON(path, { fetchedAt: new Date().toISOString(), rows });
  return rows;
}

/** Best keyword per URL (highest volume). */
export function keywordByUrl(rows: SiteKeyword[]) {
  const m = new Map<string, SiteKeyword>();
  rows.forEach(r => { const c = m.get(r.url); if (!c || (r.volume || 0) > (c.volume || 0)) m.set(r.url, r); });
  return new Map([...m].map(([u, r]) => [u, r.keyword]));
}
