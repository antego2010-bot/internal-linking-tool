#!/usr/bin/env python3
"""Crawl a site's content pages into the format build_site.py reads. Use this when Claude's sandbox can
reach the site (try `curl -I https://<domain>/` first); otherwise use crawler.js in the browser.

  python crawl.py --config config.json --out ilt-work/crawl.jsonl.gz [--probe /blog/a /blog/b]

--probe prints, for a few pages, how many blocks each candidate selector finds (and an automatic guess),
so you can set config.content_selector before the full crawl. Needs: requests, beautifulsoup4.
"""
import argparse, concurrent.futures as cf, gzip, json, re, sys, time
from urllib.parse import urljoin, urlparse
import requests
from bs4 import BeautifulSoup

CANDIDATES = ["article .entry-content", ".entry-content", ".post-content", ".article-body", ".post-body", "article", "main", "[role=main]", ".content", "#content"]
SKIP = "nav,aside,footer,header,form,figure,figcaption,[role=navigation],[class*=related],[class*=share],[class*=author],[class*=comment],[class*=newsletter],[class*=subscribe],[class*=breadcrumb],[class*=toc],[class*=sidebar],[class*=cta]"
K = {"h2": 0, "h3": 1, "h4": 1, "p": 2, "li": 3, "blockquote": 4, "td": 5}
UA = {"User-Agent": "Mozilla/5.0 (internal-linking-tool crawler)"}

def clean(s):
    return re.sub(r"\s+", " ", s or "").strip()

def make_short(origin):
    def short(u):
        x = urlparse(urljoin(origin + "/", u))
        if f"{x.scheme}://{x.netloc}".replace("www.", "") == origin.replace("www.", ""):
            p = x.path.rstrip("/") or "/"
            return p
        return x.geturl()
    return short

def blocks_from(soup, selector, short):
    roots = soup.select(selector) if selector else []
    out, seen = [], set()
    skip = set(id(x) for x in soup.select(SKIP))
    for root in roots:
        for el in root.select("h2,h3,h4,p,li,blockquote,td"):
            if id(el) in seen:
                continue
            anc, bad = el, False
            while anc is not None and anc is not root:  # skip boxes inside the article, not the page around it
                if id(anc) in skip:
                    bad = True; break
                anc = anc.parent
            if bad:
                continue
            if el.name == "li" and el.find("p"): continue
            if el.name == "blockquote" and el.find("p"): continue
            if el.name == "td" and el.find(["p", "li"]): continue
            node = el
            if el.name == "li" and el.find(["ul", "ol"]):
                node = BeautifulSoup(str(el), "html.parser").li
                for x in node.find_all(["ul", "ol"]): x.decompose()
            text, k = clean(node.get_text(" ")), K[el.name]
            if len(text) < 3 or (k > 1 and len(text) < 25):
                continue
            links = [[short(a.get("href")), clean(a.get_text(" "))] for a in node.find_all("a", href=True)]
            b = [k, text] + ([links] if links else [])
            seen.add(id(el)); out.append(b)
    return out

def auto_selector(soup):
    score = {}
    for p in soup.find_all("p"):
        par = p.parent
        if par is None or p.find_parent(["nav", "footer", "header", "aside"]): continue
        score[id(par)] = (par, score.get(id(par), (par, 0))[1] + len(clean(p.get_text(" "))))
    if not score: return None
    best = max(score.values(), key=lambda x: x[1])[0]
    if best.get("id"): return "#" + best["id"]
    cls = [c for c in best.get("class", []) if not re.match(r"^(col|row|d-|p[xytblr]?-|m[xytblr]?-|text-|w-|h-|flex|grid)", c)][:2]
    return best.name + "".join("." + c for c in cls)

def meta(soup):
    h1 = soup.find("h1"); og = soup.find("meta", property="og:title")
    t = clean(h1.get_text(" ") if h1 else (og.get("content") if og else (soup.title.string if soup.title else "")))
    pub = soup.find("meta", property="article:published_time"); tm = soup.find("time", datetime=True)
    return t, ((pub.get("content") if pub else (tm["datetime"] if tm else "")) or "")[:10]

def sitemap_urls(sess, url, depth=0, out=None):
    out = set() if out is None else out
    if depth > 3: return out
    try:
        r = sess.get(url, timeout=30)
        if not r.ok: return out
        x = BeautifulSoup(r.content, "xml")
    except Exception:
        return out
    for loc in x.select("sitemap > loc"):
        sitemap_urls(sess, loc.text.strip(), depth + 1, out)
    for loc in x.select("url > loc"):
        out.add(loc.text.strip())
    return out

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", required=True)
    ap.add_argument("--out")
    ap.add_argument("--probe", nargs="*")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--delay", type=float, default=0.0)
    a = ap.parse_args()
    cfg = json.load(open(a.config))
    origin = cfg.get("origin") or "https://" + cfg["domain"]
    short = make_short(origin)
    sess = requests.Session(); sess.headers.update(UA)
    if a.probe:
        for p in a.probe:
            r = sess.get(urljoin(origin, p), timeout=30); soup = BeautifulSoup(r.text, "html.parser")
            auto = auto_selector(soup)
            res = {sel: len(blocks_from(soup, sel, short)) for sel in [auto] + CANDIDATES if sel}
            print(json.dumps({"path": p, "status": r.status_code, "title": meta(soup)[0], "auto": auto, "blocks": {k: v for k, v in res.items() if v}}))
        return
    if not a.out: sys.exit("--out is required for a crawl")
    sel = cfg.get("content_selector") or sys.exit("set content_selector in config.json (use --probe to find it)")
    found = sitemap_urls(sess, cfg.get("sitemap") or origin + "/sitemap.xml")
    if not found:
        rb = sess.get(origin + "/robots.txt", timeout=30).text
        for m in re.finditer(r"(?im)^sitemap:\s*(\S+)", rb):
            sitemap_urls(sess, m.group(1), 0, found)
    sec = [re.compile(s["pattern"]) for s in cfg["sections"] if s.get("role", "editorial") != "commercial"]
    com = [re.compile(s["pattern"]) for s in cfg["sections"] if s.get("role") == "commercial"]
    ex = [re.compile(x) for x in cfg.get("exclude_patterns", [])]
    paths = sorted({short(u) for u in found})
    todo = [p for p in paths if p.startswith("/") and not any(r.search(p) for r in ex) and any(r.search(p) for r in sec + com)]
    todo += [p for p in cfg.get("extra_urls", []) if p not in todo]
    print(f"{len(found)} sitemap URLs, {len(todo)} to crawl", file=sys.stderr)
    def one(p):
        if a.delay: time.sleep(a.delay)
        try:
            r = sess.get(urljoin(origin, p), timeout=30)
            if not r.ok: return None, (p, r.status_code)
            soup = BeautifulSoup(r.text, "html.parser"); t, d = meta(soup)
            title_only = any(x.search(p) for x in com) and not any(x.search(p) for x in sec)
            return {"u": p, "f": short(r.url), "t": t, "p": d, "b": [] if title_only else blocks_from(soup, sel, short)}, None
        except Exception as e:
            return None, (p, str(e))
    pages, errors = [], []
    with cf.ThreadPoolExecutor(a.workers) as pool:
        for i, (pg, err) in enumerate(pool.map(one, todo), 1):
            (pages.append(pg) if pg else errors.append(err))
            if i % 200 == 0: print(f"{i}/{len(todo)}", file=sys.stderr)
    with gzip.open(a.out, "wt", encoding="utf-8") as fh:
        fh.write("\n".join(json.dumps(p, ensure_ascii=False) for p in pages))
    print(json.dumps({"pages": len(pages), "with_text": sum(1 for p in pages if p["b"]), "errors": errors[:30], "out": a.out}, indent=1))

if __name__ == "__main__":
    main()
