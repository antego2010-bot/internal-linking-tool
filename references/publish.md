# Publishing, checking, sharing and refreshing the tool

## Publish

`ilt-site/` holds everything the artifact serves:

| File | What it is |
| --- | --- |
| `index.html` | The tool (from `assemble.py`) |
| `meta.json` | Build and crawl dates, counts, the site config |
| `library.json` | Destinations for "Links from this post" |
| `index-N.json` | The content index, about 8 MB per file |
| `audit.json` | The audit data |

1. Publish all of them in one call as a new artifact titled **Internal linking tool**, with the tool that publishes files from disk (each file `as` its own name). Artifact hosts serve `.json` but not `.gz`, which is why the index files are plain JSON. Per-file and per-call size limits apply (they were 20 MB a file and 64 MB a call when this was written); `build_site.py --chunks N` makes more, smaller index files if a site needs it.
2. Declare the page's capabilities: `{"sample": {}, "mcp": {"servers": [{"server": "Google Drive", "tools": ["download_file_content"]}]}}`. `sample` lets the page ask Claude; Google Drive lets it load a draft from a Google Doc link. Leave Google Drive out if the user has no Drive connector.
3. On a republish (the monthly refresh), publish the changed files into the same artifact so the link stays the same.

If publishing from files isn't available, the index can't be inlined into a single page for a large site. Say so, and offer the files as a download the user can host as a static site.

## Check it before handing over

Open the artifact and confirm:

- the header reads "Index: N pages · crawled <date> · Library: M URLs" with the numbers from Phase 4;
- **Internal link audit** loads and its first rows match the audit's printed top quick wins;
- **Search the index** finds a phrase you know is on the site, in Word forms mode too;
- **Draft**: paste a short sample with a `## heading` line and check the outline and suggested URL look right. Running the Claude buttons is optional here; the first run asks the viewer's permission.

## Sharing

- Share > organization access as **Viewer**. Viewers can use every feature: the tool runs in each person's browser with their own Claude account and connectors, and saves results only in their browser. Editors could change or republish the tool itself.
- Usage of the Claude buttons counts against each viewer's own Claude plan.
- **Demo mode** (header button) replaces every click figure with ••• and leaves clicks out of copied tables. It stays on in that browser until switched off.

## Monthly refresh

Pages and links change; the header dot turns amber when the crawl is more than 40 days old. Each month:

1. Crawl again (Phase 1); the selector rarely needs changing, but probe one new post.
2. New Search Console Pages export (Phase 2).
3. Moz pull: optional monthly, quarterly is usually enough (Phase 3).
4. `build_site.py`, `build_audit.py`, `assemble.py`, then republish into the same artifact.

Offer to set up a monthly reminder or scheduled task for it.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| "The content index couldn't load" | A file named in meta.json wasn't published, or a publish was cut off | List the artifact's files; republish the missing ones. |
| Audit tab says it couldn't load | `audit.json` missing | Run `build_audit.py` and publish `audit.json`. |
| Claude buttons say they aren't allowed | `sample` not declared, or the viewer declined | Declare `sample`; the viewer presses the button again and allows it. |
| Google Doc link fails | No Google Drive connector for that viewer, or the page doesn't declare it | Upload the .docx instead, or connect Drive and declare it. |
| "Links to this post" finds nothing | The draft's URL matches an existing page, or the phrases are too narrow | Check the URL field; add phrases in the chips row and press Search again. |
| Suggestions in an introduction | The draft has no H2 headings, so everything after the title looks like body | Use real Heading 2 styles in the doc, or `## ` lines when pasting. |
