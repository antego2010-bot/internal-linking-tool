# Setup

## What's needed and how to tell

| Needed | How to check | If missing, tell the user |
| --- | --- | --- |
| Code execution | You can run `python3 --version` | Turn on code execution in Claude's settings. Skills don't run without it. |
| Artifacts that can publish files and declare capabilities | An Artifact tool (or `claude-artifacts` tools) is listed | Use claude.ai or the Claude desktop app; the tool is a published artifact. |
| A way to read the site's pages | `curl -sI https://<domain>/` returns 200 from the sandbox, OR a browser tool is listed (Claude in Chrome, or the desktop app's browser) | Install Claude in Chrome, or use the Claude desktop app. As a last resort the user runs `crawler.js` in their own browser's DevTools console (see crawl.md). |
| Moz API + the Moz connector | Tools named like `DataSiteRankingKeywordList` and `QuotaLookup` are listed | Get Moz API access (moz.com/api), then add the Moz connector in Claude's connector settings and enable it for this chat. |
| Google Search Console access to the property | Can't be checked from here | They need at least restricted access to export Performance > Pages. |
| Python packages | `python3 -c "import numpy, sklearn, openpyxl"`; for crawl.py also `requests, bs4` | `pip install numpy scikit-learn requests beautifulsoup4` (add `--break-system-packages` where pip asks for it). |
| Google Drive connector (optional) | Google Drive tools are listed | Only needed to load drafts from a Google Doc link inside the tool. Uploading a .docx works without it. |

Moz is required: without it the audit can't tell keyword anchors from branded ones and the library has no target keywords. Stop after explaining how to connect it.

## Questions to ask (one message, with defaults)

1. **Domain**, and www or not (e.g. `example.com`).
2. **Content sections and their URL patterns.** For each: a short key, a label, a regex on the URL path, and its role:
   - editorial (crawled for text: blog, guides, docs, learn centre), or
   - commercial (product, pricing, feature pages: crawled for their title only; they are link destinations, not link sources).
3. **Priority order** for destinations when several fit the same spot. Default: commercial pages first, then evergreen guides, then reference pages, then blog posts.
4. **Brand terms**: company and product names, lower case (used to spot branded anchors and to drop branded keywords).
5. **Exclusions**: URL patterns to leave out (tag and author archives, forums, search pages, paginated listings).
6. **Library age limit** (optional): only suggest blog posts newer than a date, e.g. 2022-01-01. Older posts still appear in "Links to this post" and the audit.
7. **Where new posts live** (e.g. `/blog/`), used to suggest the draft's URL.
8. **Locale** for Moz (en-US, en-GB, en-CA, en-AU).

## config.json

```json
{
  "site": "Example",
  "domain": "example.com",
  "newPostPath": "/blog/",
  "content_selector": "article .entry-content",
  "sections": [
    {"key": "Product", "label": "Product", "pattern": "^/(product|pricing|features)", "role": "commercial", "priority": 1},
    {"key": "Guide", "label": "Guides", "pattern": "^/guides/", "priority": 2},
    {"key": "Blog", "label": "Blog", "pattern": "^/blog/", "priority": 3}
  ],
  "brand_terms": ["example", "example pro"],
  "exclude_patterns": ["^/blog/(tag|author|page)/"],
  "library": {"min_date": "2022-01-01", "min_date_sections": ["Blog"]},
  "locale": "en-US",
  "crawled": "2026-11-20"
}
```

- Section `key`s are short and stable (they're stored in the data); `label`s are what the tool shows.
- A URL takes the first section whose pattern matches, so list specific patterns before broad ones.
- `crawled` is the crawl date shown in the tool's header; set it when you crawl.
- `content_selector` is filled in during Phase 1.
