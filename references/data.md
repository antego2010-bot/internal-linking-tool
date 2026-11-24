# Search Console and Moz data

## Search Console: clicks per page

What the tool uses it for: the audit's priority (clicks), "striking distance" (average position 4-20 with 1,000+ impressions), and sorting suggestions so the busiest pages come first.

Steps for the user:

1. Search Console > the site's property > **Performance > Search results**.
2. Date: **Last 3 months**. Search type: Web.
3. Open the **Pages** tab under the chart.
4. **Export > Download CSV**. The download is a zip with several CSVs; the one needed is **Pages.csv** (columns: Top pages, Clicks, Impressions, CTR, Position).
5. Attach Pages.csv to the chat (or put it in the connected folder).

Save it as `ilt-work/gsc_pages.csv`. `build_site.py` finds the columns by name in any language, as long as the first column holds full URLs.

The UI export is capped at 1,000 rows. That's usually enough: those are the pages with traffic, and the audit's quick wins come from them. For a bigger site, the Search Analytics for Sheets add-on or the Search Console API can export more rows grouped by Page only; save them in the same column layout.

## Moz: target keywords per page

What it's for: each page's target keywords, so the audit can tell a keyword anchor ("backlink checker") from a branded one ("BrandName Link Tool"), and so the library gives Claude a keyword for every destination.

Use the Moz connector's `DataSiteRankingKeywordList`:

- `target_query`: `{"query": "<domain>", "scope": "domain", "locale": "<locale>"}`
- `options`: `{"sort": "volume"}`
- `page`: `{"limit": 100, "n": 0}`, then `n: 1, 2, …` until you reach the target count or results run out.

Each row has `keyword`, `ranking_page`, `rank_position`, `volume`. Append each page of results to `ilt-work/moz_keywords.csv` with columns `keyword,volume,position,url` as you go, so an interrupted pull keeps what it has. Write only the four columns; keep the raw responses out of the conversation.

At domain scope Moz returns the best-ranking page per keyword, which is what this needs: one page per keyword, its strongest. `build_site.py` keeps each page's top six non-branded keywords by volume.

### Cost

Moz bills in rows: about one row per keyword returned.

| Pull | Rows |
| --- | --- |
| 1,000 keywords | about 1,000 |
| 2,000 keywords (default) | about 2,000 |
| Quota check | negligible |

Run `QuotaLookup` first and tell the user the estimate and what's left. If overage is enabled, say so: going over costs money. Wait for a yes.

Pages with no Moz keyword still work everywhere; the audit just can't classify their anchors as "keyword", so treat their anchor mix with care.
