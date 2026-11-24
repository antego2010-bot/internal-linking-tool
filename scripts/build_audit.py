#!/usr/bin/env python3
"""Build audit.json for the "Internal link audit" tab.

Reads the built site (index-N.json, library.json, meta.json) and the work folder's pagemeta.json
(written by build_site.py: Search Console clicks/impressions/position and Moz keywords per URL), then computes:
  - contextual inbound/outbound internal links per page
  - every inbound anchor, classified as keyword / branded / generic / other
  - each page's closest related pages (TF-IDF + LSA over page text) and whether they link to each other
  - a quick-win score that weights issues by traffic
Usage: python build_audit.py --site ilt-site --work ilt-work
Needs: numpy, scikit-learn.
"""
import argparse, glob, json, math, os, re, collections
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer

BRAND = []  # filled from meta.json config.brand_terms
GENERIC = re.compile(r"^(here|click here|this|this post|this article|this guide|this page|this tool|this one|read more|learn more|"
                     r"more|link|source|website|site|post|article|guide|blog|blog post|check (it|this) out|"
                     r"(see|read|view) (it|this|here|more)|find out more|this study|this report|this research|"
                     r"report|study|research|data|tool|our guide|our post|our blog|full guide|https?://\S+|www\.\S+|[a-z0-9-]+\.(com|org|net|io|co)\S*)$", re.I)
STOP = set("a an and are as at be by for from how in into is it its of on or our the this to vs what when where which who why with you your their his her".split())

DOMAIN_RE = None

def path(u):
    u = DOMAIN_RE.sub("", str(u or "").strip()).split("#")[0].split("?")[0]
    return (u.rstrip("/") if len(u) > 1 else u) or "/"

def toks(s):
    return [w for w in re.sub(r"[^a-z0-9 ]+", " ", str(s).lower().replace("’", "'").replace("'s", "")).split() if w not in STOP]

def num(v):
    try:
        return float(str(v).replace(",", "")) if v not in (None, "") else None
    except ValueError:
        return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", required=True)
    ap.add_argument("--work", required=True)
    a = ap.parse_args()
    meta = json.load(open(os.path.join(a.site, "meta.json")))
    pages = []
    for f in meta["files"]:
        pages += json.load(open(os.path.join(a.site, f)))
    lib = json.load(open(os.path.join(a.site, "library.json")))
    idx = {p["u"]: i for i, p in enumerate(pages)}

    # ---- config & page universe ----
    global DOMAIN_RE
    cfg = meta.get("config", {})
    DOMAIN_RE = re.compile(r"^https?://(www\.)?" + re.escape(cfg.get("domain", "example.com").replace("www.", "")), re.I)
    BRAND[:] = sorted({b.lower() for b in cfg.get("brand_terms", [])}, key=len, reverse=True)
    pm = json.load(open(os.path.join(a.work, "pagemeta.json")))
    libby = {r["u"]: r for r in lib}

    rows = {}
    def row(u):
        if u in rows:
            return rows[u]
        k, l, p = pm.get(u, {}), libby.get(u, {}), (pages[idx[u]] if u in idx else None)
        sec = k.get("s") or l.get("type") or (p and p.get("s")) or "Other"
        kws = []
        for v in list(k.get("kw") or []) + [l.get("kw")]:
            v = str(v or "").strip().lower()
            if v and v not in kws and len(v) > 2:
                kws.append(v)
        rows[u] = {
            "u": u, "t": (p and p["t"]) or str(k.get("t") or l.get("title") or u),
            "s": sec, "c": k.get("c"), "im": k.get("im"), "pos": k.get("pos"),
            "kw": kws[:6], "ix": 1 if p else 0,
            "in": 0, "inP": 0, "out": 0, "a": [0, 0, 0, 0], "inst": [], "rel": [], "dup": [],
        }
        return rows[u]
    for p in pages:
        row(p["u"])
    for u in pm:
        row(u)
    for r in lib:
        row(r["u"])

    # ---- links ----
    def brand_only(kw):
        k = kw.lower()
        for b in BRAND:
            k = re.sub(r"(?<![a-z])" + re.escape(b) + r"(?![a-z])", " ", k)
        return not [w for w in toks(k) if w not in ("tool", "tools", "free")]
    for r in rows.values():
        r["kwNB"] = [k for k in r["kw"] if not brand_only(k)]
    def anchor_class(anchor, r):
        t = anchor.strip().lower().replace("’", "'")
        if not t or GENERIC.match(t) or len(t) <= 2:
            return 1  # generic
        stripped = t
        for b in BRAND:
            stripped = re.sub(r"(?<![a-z])" + re.escape(b) + r"(?![a-z])", " ", stripped)
        at = {x.rstrip("s") for x in toks(stripped)}
        if "kwNB" not in r:
            r["kwNB"] = [k for k in r["kw"] if not brand_only(k)]
        for kw in r["kwNB"]:
            kt = [w.rstrip("s") for w in toks(kw)]
            if kt and sum(w in at for w in kt) / len(kt) >= 0.6:
                return 0  # keyword
        if any(re.search(r"(?<![a-z])" + re.escape(b) + r"(?![a-z])", t) for b in BRAND):
            return 2  # branded
        return 3  # other / descriptive
    anchor_dests = collections.defaultdict(collections.Counter)
    for si, p in enumerate(pages):
        outs = set()
        for bi, b in enumerate(p["b"]):
            if len(b) < 3:
                continue
            for h, txt in b[2]:
                if not h.startswith("/"):
                    continue
                d = path(h)
                if d not in rows:
                    continue  # only count links to pages in the audit (crawled, in Search Console or in the library)
                if d == p["u"]:
                    continue
                outs.add(d)
                r = row(d)
                cls = anchor_class(txt, r)
                r["in"] += 1
                r["a"][cls] += 1
                r["inst"].append([p["u"], bi, txt, cls])
                at = txt.strip().lower()
                if len(at.split()) >= 2 and cls != 1:
                    anchor_dests[at][d] += 1
        rows[p["u"]]["out"] = len(outs)
        rows[p["u"]]["outs"] = outs
    for r in rows.values():
        r["inP"] = len({i[0] for i in r["inst"]})

    # ---- relatedness: TF-IDF + LSA blend over title, keywords, headings, body (boilerplate removed) ----
    from sklearn.decomposition import TruncatedSVD
    from sklearn.preprocessing import normalize
    cnt = collections.Counter(b[1] for p in pages for b in p["b"])
    boiler = {t for t, c in cnt.items() if c >= 8}
    docs = []
    for p in pages:
        kw = " ".join(rows[p["u"]]["kw"][:3])
        heads = " ".join(b[1] for b in p["b"] if b[0] <= 1 and b[1] not in boiler)
        body = " ".join(b[1] for b in p["b"] if b[0] > 1 and b[1] not in boiler)
        docs.append(((p["t"] + " ") * 3) + ((kw + " ") * 3) + ((heads + " ") * 2) + body[:15000])
    sims = None
    if len(pages) >= 5:
        try:
            vec = TfidfVectorizer(stop_words="english", sublinear_tf=True, min_df=2 if len(pages) >= 50 else 1, max_df=0.3 if len(pages) >= 50 else 1.0, ngram_range=(1, 2), max_features=200000, dtype=np.float32)
            X = vec.fit_transform(docs)
            k = min(300, X.shape[0] - 1, X.shape[1] - 1)
            Z = normalize(TruncatedSVD(k, random_state=0).fit_transform(X)).astype(np.float32) if k >= 2 else None
            sims = (X @ X.T).toarray()
            if Z is not None:
                sims = 0.5 * sims + 0.5 * (Z @ Z.T)
        except ValueError as e:  # e.g. an empty vocabulary on a tiny site
            print("related pages skipped:", e)
    if sims is None:
        sims = np.zeros((len(pages), len(pages)), dtype=np.float32)
    np.fill_diagonal(sims, 0)
    K = 10
    top = np.argsort(-sims, axis=1)[:, :K]
    for i, p in enumerate(pages):
        r = rows[p["u"]]
        for j in top[i]:
            s = float(sims[i, j])
            if s < 0.15:
                continue
            q = pages[j]["u"]
            r["rel"].append([q, round(s, 3), 1 if q in r.get("outs", ()) else 0, 1 if p["u"] in rows[q].get("outs", ()) else 0])
            if s >= 0.75:
                r["dup"].append(q)

    # ---- scoring ----
    def score(r):
        c = r["c"] or 0
        T = math.sqrt(c)  # traffic dominates the ordering
        striking = 1.4 if r["pos"] and 4 <= r["pos"] <= 20 and (r["im"] or 0) >= 1000 else 1.0
        r["exp"] = round(5 + 4 * math.log10(1 + c))  # linking pages we'd expect for this much traffic
        U = max(0.0, 1 - r["inP"] / r["exp"])
        tot = sum(r["a"])
        A = ((r["a"][1] + r["a"][2]) / tot) if tot >= 3 and r["a"][0] / tot < 0.3 else 0.0
        rel = [x for x in r["rel"][:8] if x[0] not in r["dup"]]
        G = (sum(1 for x in rel if not x[2]) / len(rel)) if rel else 0.0
        r["iss"] = {"U": round(U, 2), "A": round(A, 2), "G": round(G, 2)}
        r["sk"] = 1 if striking > 1 else 0
        return round(T * striking * (U + 0.7 * A + 0.4 * G), 2)

    out = []
    for r in rows.values():
        if not r["ix"] and not r["in"] and not r["c"]:
            continue
        r["q"] = score(r)
        r.pop("outs", None); r.pop("kwNB", None)
        out.append(r)
    out.sort(key=lambda r: -r["q"])

    conflicts = {a: dict(c) for a, c in anchor_dests.items() if len(c) >= 3}
    res = {"built": meta["built"], "crawled": meta["crawled"], "brand": BRAND, "rows": out, "conflicts": conflicts}
    with open(os.path.join(a.site, "audit.json"), "w") as fh:
        json.dump(res, fh, ensure_ascii=False, separators=(",", ":"))
    print("rows", len(out), "conflicting anchors", len(conflicts), "size MB", round(os.path.getsize(os.path.join(a.site, "audit.json")) / 1e6, 2))
    print("top quick wins:")
    for r in out[:10]:
        print(f'  {r["q"]:>7}  clicks {int(r["c"] or 0):>6}  linking pages {r["inP"]:>3}  anchors kw/gen/brand/other {r["a"]}  {r["u"]}')

if __name__ == "__main__":
    main()
