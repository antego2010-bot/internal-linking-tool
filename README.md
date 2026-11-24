# Internal linking tool

Two-way internal link suggestions for any site, plus an internal link audit. Every user brings their own Moz API token and Claude API key, and can upload a Search Console + GA4 export (or their own URL library) from Google Sheets.

**Tabs**

- **Draft**: upload a .docx, paste text, or load a public Google Doc or a live page URL. Intros, conclusions and headings are never linked.
- **Links from this post**: Claude reads the draft against the site's URL library and suggests anchors and destinations; every anchor is checked word for word against the draft.
- **Links to this post**: Claude works out how other pages would mention the topic, the tool searches every indexed page's body text, and Claude checks each passage.
- **Internal link audit**: every page ranked by quick-win score (traffic × what there is to fix): pages linking in vs expected, anchor text mix (keyword, generic, branded), related pages linked both ways, possible duplicates. Worked out in the browser from the content index. Claude can find pages that should link in, rewrite weak anchors, and place missing links between related pages.
- **Search the index**: which pages mention a phrase (exact, word forms, related).
- **Settings**: keys, Search Console + GA4 upload or your own URL library, domain and paths, index size, build the library.

**Data**

| Source | What it adds |
| --- | --- |
| Site crawl (sitemap, robots.txt respected) | Text blocks and internal links of every page (the content index, stored as a public file in Vercel Blob and reused for 30 days) |
| Moz API (user's token) | Keywords each page ranks for, search volume, intent |
| Search Console + GA4 upload (optional) | Clicks, impressions, position, sessions per page ([how-to](public/how-to-library.html), Claude skill in `public/skills/`) |
| Claude (user's key) | Link suggestions and checks |

**Privacy**: keys, the URL library, uploads and drafts live in the user's browser. Uploaded Search Console / GA4 data is processed in memory to build the library and never stored on the server. See `/privacy.html`.

## Deploy

1. Import the repo in Vercel (framework: Next.js).
2. Storage → Blob → create a store (Public), connect it to the project, tick "add a read-write token", then redeploy.

## Local

```
npm install
MOCK=1 npm run dev   # canned Moz / Claude data, no keys needed
```

The UI is plain HTML/JS in `public/`, built from `ui/` with `python3 ui/build.py` (`ui/source.html` is the original Claude artifact; `ui/extra.js` adds settings, storage and the audit).
