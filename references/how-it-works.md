# How the tool decides

Use this to answer "why did it suggest that?" or to change a rule. Rules live in `assets/tool/app.js` (the `RULES` text, the prompts and the checks after each Claude call) and in `scripts/build_audit.py`.

## Rules on both sides

- No links in the introduction (everything before the first H2), in a conclusion section (an H2 such as Conclusion, Final thoughts, Wrapping up, Summary, The bottom line), or in headings.
- One link per destination; a page never links to itself.
- Prose before list items: a destination suggested in both keeps the prose placement.
- Anchors are descriptive, usually 2-6 words; never "click here", "this post" or a bare brand name.

Claude proposes; the page verifies. A suggestion is dropped, and listed under "removed by the checks" with the reason, if its anchor isn't in the cited block word for word, the block is in an introduction, conclusion or heading, the destination isn't in the library or is already linked, it repeats a destination, or it overlaps an existing link or another suggestion.

## Links from this post

Claude gets the draft (eligible blocks numbered, the rest shown for context) and the whole URL library (path, keyword, title, type), with the section priority order from the config. Drafts that start with a brief or outline above the article: the tool starts the article at the last Title/H1, and the "Article starts at" menu changes it. A brief's SEO table with a "URL" row fills the post's URL.

## Links to this post

1. Claude reads the draft and returns core phrases (the topic as others would mention it) and related sub-topics.
2. The page searches every indexed page's body text (not introductions, conclusions, headings or text that's already a link) for those phrases, singular and plural.
3. Pages already linking to the post's URL are set aside. The rest are ranked by phrase type (core above related), block type (paragraph above list item) and the page's clicks.
4. Claude checks the top 45 in batches of 15: is the passage about the topic at that point, would a reader want to go deeper there? It returns an anchor copied from the passage and, if needed, a light rewrite. "Check more" sends the next batch.

## Internal link audit

Built by `build_audit.py`:

- **Links in** counts distinct pages linking to a page from body text. Expected links grow with traffic: `5 + 4 × log10(1 + clicks)`. "Few links in" is flagged when a page with 20+ clicks has fewer than half of that.
- **Anchor classes:** generic (here, this post, a bare URL), keyword (covers at least 60% of the words of one of the page's non-branded Moz keywords), branded (contains a brand term), other. "Weak anchors" is flagged when 3+ links come in, under 30% are keyword anchors, and branded plus generic make up half or more.
- **Related pages:** each page's 10 closest pages by text, from TF-IDF (title ×3, keywords ×3, headings ×2, body, with boilerplate repeated on 8+ pages removed) blended 50/50 with a 300-dimension LSA projection; matches below 0.15 similarity are dropped. 0.75 and above is marked "very similar: check cannibalization" and never suggested as a link. "Topic gaps" is flagged when a page with 20+ clicks links to fewer than half of its 8 closest pages.
- **Quick-win score** = √clicks × (striking-distance bonus 1.4 when position is 4-20 with 1,000+ impressions) × (few-links + 0.7 × weak-anchors + 0.4 × topic-gaps), each part between 0 and 1. Traffic dominates the order on purpose.
- **Anchor conflicts:** a two-word-plus anchor that points to three or more different pages across the site.

The Claude buttons on each page: "Find pages that should link here" (the Links-to engine with that page as the target), "Suggest better anchors" (rewrites up to 20 branded or generic anchors in their sentences, keeping the brand name where the sentence is about the product), "Suggest the missing links" (places links between the page and its related pages, both directions, anchors verified).

## Search the index

- **Exact phrase**, plus plurals.
- **Word forms**: each word reduced to a stem and matched with common endings and US/UK spellings (cannibalize, cannibalizing, cannibalisation), not any ending (so "intent" finds "intention" but not "intentional").
- **Related**: also each distinctive word on its own (a word used on more than 35% of pages is too broad and skipped), plus related terms Claude suggests on request.

Results show the matched wording as chips; clicking a chip leaves that wording out.
