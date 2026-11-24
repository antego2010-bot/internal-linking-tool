#!/usr/bin/env python3
"""Build the internal linking tool's data files from a crawl, a Search Console export and a Moz keyword pull.

Usage:
  python build_site.py --config config.json --crawl ilt-work/crawl-2026-11-20.jsonl.gz \
      [--crawl more.jsonl.gz] [--gsc ilt-work/gsc_pages.csv] [--moz ilt-work/moz_keywords.csv] \
      --out ilt-site --work ilt-work

Writes to --out (everything the artifact serves):
  index-N.json   content index: one page per line inside a JSON array (the artifact host won't serve .gz)
  library.json   destinations for "Links from this post"
  meta.json      build date, counts, and the site config the page reads
Writes to --work:
  pagemeta.json  per-URL section, title, clicks, impressions, position, keywords (read by build_audit.py)

Crawl format (one JSON object per line, from crawler.js or crawl.py):
  {"u": "/path", "f": "/final-path-after-redirects", "t": "Title", "p": "2026-01-31", "b": [[kind, text, [[href, anchor], ...]], ...]}
  kind: 0 = h2, 1 = h3/h4, 2 = paragraph, 3 = list item, 4 = quote, 5 = table cell. Pages with no blocks
  (e.g. commercial pages crawled for their title only) go into the library but not the index.
"""
import argparse, csv, datetime, gzip, json, os, re, sys
from collections import Counter, defaultdict

def load_config(p):
    cfg = json.load(open(p))
    for k in ("site", "domain", "sections"):
        if k not in cfg:
            sys.exit(f"config is missing '{k}'")
    for s in cfg["sections"]:
        s.setdefault("label", s["key"]); s.setdefault("role", "editorial"); s.setdefault("priority", 5)
        s["_re"] = re.compile(s["pattern"])
    cfg["_ex"] = [re.compile(x) for x in cfg.get("exclude_patterns", [])]
    return cfg

def make_path(domain):
    dom = re.escape(domain.replace("www.", ""))
    rx = re.compile(r"^https?://(www\.)?" + dom, re.I)
    def path(u):
        u = rx.sub("", str(u or "").strip()).split("#")[0].split("?")[0]
        return (u.rstrip("/") if len(u) > 1 else u) or "/"
    return path

def section_of(cfg, p):
    for s in cfg["sections"]:
        if s["_re"].search(p):
            return s["key"]
    return None

def num(v):
    try:
        return float(str(v).replace(",", "").replace("%", "")) if v not in (None, "") else None
    except ValueError:
        return None

def read_csv(p):
    with open(p, newline="", encoding="utf-8-sig") as fh:
        return list(csv.reader(fh))

def load_gsc(p, path):
    """Search Console Performance > Pages export: Top pages, Clicks, Impressions, CTR, Position (any language)."""
    rows = read_csv(p)
    head = [h.strip().lower() for h in rows[0]]
    def col(*names):
        for i, h in enumerate(head):
            if any(n in h for n in names):
                return i
        return None
    iu = 0
    ic, ii, ip = col("click"), col("impression"), col("position")
    out = {}
    for r in rows[1:]:
        if not r or not r[iu].startswith("http"):
            continue
        out[path(r[iu])] = {"c": num(r[ic]) if ic is not None else None, "im": num(r[ii]) if ii is not None else None, "pos": num(r[ip]) if ip is not None else None}
    return out

def load_moz(p, path, brand):
    """keyword,volume,position,url from the Moz ranking keywords pull."""
    by = defaultdict(list)
    with open(p, newline="", encoding="utf-8-sig") as fh:
        for r in csv.DictReader(fh):
            kw = (r.get("keyword") or "").strip().lower()
            if not kw or any(re.search(r"(?<![a-z])" + re.escape(b.lower()) + r"(?![a-z])", kw) for b in brand):
                continue
            by[path(r.get("url"))].append((num(r.get("volume")) or 0, num(r.get("position")) or 99, kw))
    return {u: [k for _, _, k in sorted(v, key=lambda x: (-x[0], x[1]))][:6] for u, v in by.items()}

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", required=True)
    ap.add_argument("--crawl", action="append", required=True)
    ap.add_argument("--gsc")
    ap.add_argument("--moz")
    ap.add_argument("--out", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--chunks", type=int, default=0, help="index files (default: about 8 MB each)")
    a = ap.parse_args()
    cfg = load_config(a.config)
    path = make_path(cfg["domain"])
    os.makedirs(a.out, exist_ok=True); os.makedirs(a.work, exist_ok=True)
    gsc = load_gsc(a.gsc, path) if a.gsc else {}
    moz = load_moz(a.moz, path, cfg.get("brand_terms", [])) if a.moz else {}

    pages, seen, crawled_dates = [], set(), []
    lib_only = {}
    for f in a.crawl:
        op = gzip.open if f.endswith(".gz") else open
        with op(f, "rt", encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                pg = json.loads(line)
                p = path(pg.get("f") or pg["u"])
                if p in seen or any(x.search(p) for x in cfg["_ex"]):
                    continue
                sec = section_of(cfg, p) or section_of(cfg, path(pg["u"]))
                if not sec:
                    continue
                seen.add(p)
                title = re.sub(r"\s+", " ", pg.get("t") or "").strip() or p
                date = (pg.get("p") or "")[:10]
                if not pg.get("b"):
                    lib_only[p] = {"t": title, "s": sec, "d": date}
                    continue
                blocks = []
                for b in pg["b"]:
                    if len(b) > 2 and b[2]:
                        b = [b[0], b[1], [[path(h) if (h.startswith("/") or cfg["domain"].replace("www.", "") in h) else h, t] for h, t in b[2]]]
                    else:
                        b = b[:2]
                    blocks.append(b)
                g = gsc.get(p, {})
                pages.append({"u": p, "t": title, "s": sec, "d": date, "c": g.get("c"), "il": 1, "b": blocks})
    if not pages:
        sys.exit("No crawled pages matched the config's section patterns. Check 'sections' and the crawl file.")
    pages.sort(key=lambda x: -(x["c"] or 0))

    # ---- library (destinations for links FROM a draft) ----
    lcfg = cfg.get("library", {})
    min_date = lcfg.get("min_date")
    min_date_sections = set(lcfg.get("min_date_sections", []))
    lib = []
    def add_lib(p, sec, title, date):
        if min_date and sec in min_date_sections and date and date < min_date:
            return
        g = gsc.get(p, {})
        kws = moz.get(p, [])
        lib.append({"u": p, "type": sec, "kw": kws[0] if kws else "", "topic": ", ".join(kws[1:3]), "cat": "", "title": title, "sessions": g.get("c"), "date": date})
    for pg in pages:
        add_lib(pg["u"], pg["s"], pg["t"], pg["d"])
    for p, v in lib_only.items():
        add_lib(p, v["s"], v["t"], v["d"])
    rank = {s["key"]: s["priority"] for s in cfg["sections"]}
    lib.sort(key=lambda r: (rank.get(r["type"], 9), -(r["sessions"] or 0)))

    # ---- write ----
    n = a.chunks or max(1, round(sum(len(json.dumps(p)) for p in pages) / 8e6 + 0.5))
    files = []
    for old in [x for x in os.listdir(a.out) if re.match(r"index-\d+\.json$", x)]:
        os.remove(os.path.join(a.out, old))
    for i in range(n):
        part = pages[i::n]
        fn = f"index-{i + 1}.json"
        with open(os.path.join(a.out, fn), "w", encoding="utf-8") as fh:
            fh.write("[\n" + ",\n".join(json.dumps(p, ensure_ascii=False, separators=(",", ":")) for p in part) + "\n]")
        files.append(fn)
    with open(os.path.join(a.out, "library.json"), "w", encoding="utf-8") as fh:
        json.dump(lib, fh, ensure_ascii=False, separators=(",", ":"))
    pub = {k: v for k, v in cfg.items() if not k.startswith("_") and k not in ("exclude_patterns",)}
    pub["sections"] = [{k: v for k, v in s.items() if not k.startswith("_")} for s in cfg["sections"]]
    meta = {
        "built": datetime.date.today().isoformat(),
        "crawled": cfg.get("crawled") or datetime.date.today().isoformat(),
        "library": dict(Counter(r["type"] for r in lib)), "libraryTotal": len(lib),
        "index": dict(Counter(p["s"] for p in pages)), "indexTotal": len(pages),
        "blocks": sum(len(p["b"]) for p in pages), "files": files, "config": pub,
    }
    with open(os.path.join(a.out, "meta.json"), "w") as fh:
        json.dump(meta, fh, indent=1)
    # per-URL metadata for build_audit.py
    pm = {}
    for p in pages:
        pm[p["u"]] = {"t": p["t"], "s": p["s"], "ix": 1}
    for p, v in lib_only.items():
        pm[p] = {"t": v["t"], "s": v["s"], "ix": 0}
    for p, g in gsc.items():
        sec = section_of(cfg, p)
        if p not in pm and sec and not any(x.search(p) for x in cfg["_ex"]):
            pm[p] = {"t": p, "s": sec, "ix": 0}
    for p, v in pm.items():
        g = gsc.get(p, {})
        v.update({"c": g.get("c"), "im": g.get("im"), "pos": g.get("pos"), "kw": moz.get(p, [])})
    with open(os.path.join(a.work, "pagemeta.json"), "w") as fh:
        json.dump(pm, fh, ensure_ascii=False)

    print(json.dumps({k: meta[k] for k in ("library", "libraryTotal", "index", "indexTotal", "blocks", "files")}, indent=1))
    no_gsc = sum(1 for p in pages if p["c"] is None)
    no_kw = sum(1 for p in pages if p["u"] not in moz)
    print(f"indexed pages with no Search Console row: {no_gsc}; with no Moz keyword: {no_kw}")

if __name__ == "__main__":
    main()
