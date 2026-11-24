---
name: internal-linking-tool
description: Build a two-way internal linking tool for any website as a Claude artifact. It suggests links from a new draft to existing pages AND links to the draft from pages already published, audits existing internal links by traffic (under-linked pages, branded or generic anchors, related pages that don't link), and searches every page's text. Uses a site crawl, a Google Search Console export and the Moz API. Use whenever someone wants internal link suggestions for a draft, wants to know which pages should link to a new post, wants an internal linking audit, asks "which of our pages mention X", or mentions the two-way internal linking tool, even if they don't name this skill.
---

# Two-way internal linking tool

This skill builds, for one website, a Claude artifact with four tabs:

1. **Links from this post**: upload a draft (.docx, Google Doc link or pasted text); Claude suggests anchors and destinations from the site's URL library. The page checks every suggestion: anchor word for word in the draft, never in the introduction, conclusion or a heading, one link per destination.
2. **Links to this post**: Claude works out how other writers would mention the draft's topic, the page searches the text of every page on the site for those phrases, and Claude checks each sentence before suggesting it.
3. **Internal link audit**: every page ranked by a quick-win score (Search Console clicks weighted by how much there is to fix): too few pages linking in, branded or generic anchor text, and closely related pages that don't link to each other. Each page has Claude buttons to fix it.
4. **Search the index**: which pages mention a phrase, with exact, word-form and related-term matching.

On moz.com it indexed 4,124 pages (227,179 paragraphs). Expect about an hour for a site of a few thousand pages; most of it is the crawl and the user's Search Console export.

## How to run it

Work through the phases in order and say which phase you're in. End each phase with a short checkpoint in numbers. Keep a working folder `ilt-work/` for inputs and intermediate files, and `ilt-site/` for the files the artifact serves. Scripts are in `scripts/` next to this file; each prints `--help`.

Rules that hold throughout:

- **Never invent data.** Clicks, positions, keywords and volumes come from Search Console and Moz. A page with no data shows a dash, not a guess.
- **Keep page text and large exports out of the conversation.** Crawl files and exports move as files; read only counts and samples.
- **Ask before spending Moz rows.** State the estimated rows and wait for a yes. One yes covers one step.
- **Be polite to the site.** The crawler runs 6 requests at a time; on a small or slow host, set `delayMs` / `--delay`.

### Phase 0: Check the setup and gather the basics

Read `references/setup.md`. Check what's connected (code execution, artifacts, a browser tool, Moz, Google Drive), give the user the steps for anything missing, and in the same message ask the setup questions (domain, sections and their URL patterns, which sections are commercial, brand terms, exclusions, where new posts live). Moz is required for target keywords; if it isn't connected, explain how to connect it and wait.

Write `ilt-work/config.json` from the answers (format in `assets/config.example.json`). Checkpoint: the config, read back as a short table of sections.

### Phase 1: Crawl the site

Read `references/crawl.md`. First find out whether this sandbox can reach the site (`curl -sI https://<domain>/`).

- **Reachable:** `scripts/crawl.py --probe` on 2-3 pages per section to pick `content_selector`, then the full crawl.
- **Not reachable (the usual case):** run `scripts/crawler.js` in a browser tab on the site (Claude in Chrome or the app's browser): `ILT.probe([...])`, then `ILT.crawl({...})`. It downloads one `crawl-<date>.jsonl.gz`; bring it into `ilt-work/` (a connected Downloads folder, or the user uploads it).

Pick the selector that holds the article body and nothing else: check a probe's first paragraph is the post's opening, not navigation or a cookie notice. Checkpoint: pages per section, pages with no text (list a few, say why), errors (404s in the sitemap are worth reporting to the user).

### Phase 2: Search Console export

Read `references/data.md` (Search Console). Have the user export Performance > Pages for the last 3 months as CSV and attach it. Save it as `ilt-work/gsc_pages.csv`. Checkpoint: rows, and how many crawled pages have a row.

### Phase 3: Target keywords from Moz

Read `references/data.md` (Moz). Pull the domain's ranking keywords sorted by volume with `DataSiteRankingKeywordList` into `ilt-work/moz_keywords.csv` (`keyword,volume,position,url`). Default 2,000 keywords (about 2,000 rows); state the estimate and get a yes first, and check `QuotaLookup`. Checkpoint: keywords, and how many pages have at least one.

### Phase 4: Build the data

```
python scripts/build_site.py --config ilt-work/config.json --crawl ilt-work/crawl-<date>.jsonl.gz \
    --gsc ilt-work/gsc_pages.csv --moz ilt-work/moz_keywords.csv --out ilt-site --work ilt-work
python scripts/build_audit.py --site ilt-site --work ilt-work      # needs numpy + scikit-learn
python scripts/assemble.py --site ilt-site
```

Read the printed summaries. Look at the audit's top quick wins and sanity-check two or three against the site (does that page really get so few links?). Checkpoint: indexed pages, library size, top five quick wins.

### Phase 5: Publish the tool

Read `references/publish.md`. Publish every file in `ilt-site/` as one artifact titled "Internal linking tool", then declare its capabilities (`sample`, and Google Drive `download_file_content`). Open it and run the checks in publish.md: the header shows the right page count, the audit tab loads, a search returns results. Give the user the link.

### Phase 6: Hand over

Tell the user, briefly:

- how to use each tab, and that the first Claude button asks permission to let the page use Claude (usage counts against each viewer's own plan);
- sharing: Share > organization access as **Viewer**, so colleagues can use it without changing it; results stay in each person's browser;
- **Demo mode** (header button) hides all click numbers for screenshots and recordings;
- the refresh: re-run Phases 1-5 monthly (the header turns amber after 40 days). Offer to schedule a monthly reminder.

Finish with the link, the headline numbers, and the three to five quick wins worth fixing first.

## Reference files

- `references/setup.md`: prerequisites, how to detect each, the setup questions, config format
- `references/crawl.md`: choosing the content selector, browser and Python crawls, getting the file back, troubleshooting
- `references/data.md`: Search Console export steps, the Moz keyword pull and its cost
- `references/publish.md`: publishing, capabilities, verification, sharing, refresh, troubleshooting
- `references/how-it-works.md`: the linking rules, audit scoring, related pages, search modes: read when the user asks how something works or wants to change a rule
