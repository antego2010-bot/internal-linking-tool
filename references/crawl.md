# Crawling the site

The crawl keeps, for every content page: the title, the publish date if the page states one, and the article body as blocks (headings, paragraphs, list items, quotes, table cells) with the links inside each block. Commercial pages are fetched for their title only. Output: one gzipped JSON-lines file, read by `build_site.py`.

## 1. Choose the route

Run `curl -sI https://<domain>/ | head -1` in the sandbox.

- **200 or a redirect:** use `scripts/crawl.py` (Python). Everything stays in the sandbox.
- **Blocked, refused or a proxy error:** most sandboxes only reach allow-listed hosts. Use `scripts/crawler.js` in a browser tab on the site. The browser fetches pages as an ordinary visitor from the same origin, so there are no CORS problems, and the result downloads as one file.

## 2. Pick the content selector

The selector must cover the article body and nothing else. Probe 2-3 pages per section, including an older post (templates change over the years):

- Python: `python scripts/crawl.py --config ilt-work/config.json --probe /blog/a /guides/b`
- Browser: paste `crawler.js` once, then `await ILT.probe(["/blog/a", "/guides/b"])`

Each result lists, per candidate selector, the blocks found, plus `auto`: the element whose paragraphs hold the most text. Choose the selector that:

- finds the body on every probed page (a selector that finds nothing on one template will miss that whole section);
- starts at the post's first paragraph (check `first` in the browser probe, or open the page) rather than a cookie banner or navigation;
- doesn't pull in related posts, author bios or comments. The crawler already skips nav, aside, footer, header, forms, figures and elements whose class mentions related, share, author, comment, newsletter, subscribe, breadcrumb, toc, sidebar or cta, when they sit inside the article.

Two sections can need different selectors. Use a comma list (`"article .entry-content, .guide-body"`).

Save it as `content_selector` in config.json.

## 3a. Crawl with Python

```
python scripts/crawl.py --config ilt-work/config.json --out ilt-work/crawl-<date>.jsonl.gz [--delay 0.2]
```

It reads `/sitemap.xml` (falling back to `Sitemap:` lines in robots.txt), keeps URLs matching a section and not an exclusion, adds `extra_urls` from the config, and prints counts and errors.

## 3b. Crawl in the browser

In a tab open on the site (any page), run the whole of `crawler.js`, then:

```js
ILT.crawl({
  selector: "article .entry-content",
  sections: [{key: "Blog", pattern: "^/blog/"}, {key: "Guide", pattern: "^/guides/"}],  // editorial: text crawled
  commercial: ["^/(product|pricing|features)"],                                          // title only
  exclude: ["^/blog/(tag|author|page)/"],
  extra: [],               // pages in no sitemap, as paths
  // sitemap: "/sitemap_index.xml", delayMs: 200, concurrency: 6
})
```

Poll `ILT.status()` every 15-30 seconds (about 4,000 pages took under a minute on moz.com; slower hosts take longer). When it finishes, `ILT.result()` gives counts and errors, and the browser downloads `crawl-<date>.jsonl.gz`.

Getting the file to Claude:

- Cowork / desktop app: ask the user to connect their Downloads folder, then stage the file into the sandbox.
- claude.ai: the user attaches the file to the chat.
- Never route page text through the browser tool's return value: tool results come back into the conversation, and 50 MB of page text would flood it.

If the user runs it themselves (no browser tool), give them the file and these two calls to paste into the DevTools console (View > Developer > JavaScript Console) on any page of their site.

## 4. Check the result

- **Pages with no text** in an editorial section usually mean a second template: probe one of them and add a selector. A few genuinely empty pages (redirect stubs, video-only posts) are normal.
- **404s listed in the sitemap**: report them to the user; they're worth removing from the sitemap.
- **Pages your library or Search Console know about but the sitemap doesn't**: add them as `extra` and crawl again into a second file; `build_site.py` takes several `--crawl` files.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Every page has 0 blocks | Content is rendered by JavaScript after load, so the fetched HTML has no article text | Probe shows `auto: null` or tiny counts. Look for the text in the raw HTML (JSON in a `<script>` tag, e.g. `__NEXT_DATA__`). If it isn't there, crawling this way won't work; say so. |
| Many 403 or 429 errors | Bot protection or rate limiting | Browser route; lower `concurrency` to 2 and set `delayMs: 500`. |
| Sitemap count 0 | Sitemap at another path | Find it in robots.txt and pass `sitemap: "/path.xml"`. |
| Blocks include menus or footers | Selector too broad (e.g. `main`) | Pick a narrower selector from the probe. |
| Download didn't appear | Browser blocked multiple downloads | Ask the user to allow downloads for the site, then rerun the last lines of `crawl` (or `ILT.crawl` again). |
