#!/usr/bin/env python3
"""Inline the tool's script into its page and write the finished index.html into the site folder.

Usage: python assemble.py --site ilt-site
Reads ../assets/tool/index.html and ../assets/tool/app.js (next to this script's folder).
"""
import argparse, os
here = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser(description=__doc__)
ap.add_argument("--site", required=True)
a = ap.parse_args()
tool = os.path.join(here, "..", "assets", "tool")
page = open(os.path.join(tool, "index.html"), encoding="utf-8").read()
app = open(os.path.join(tool, "app.js"), encoding="utf-8").read()
assert "/*__APP__*/" in page
os.makedirs(a.site, exist_ok=True)
out = os.path.join(a.site, "index.html")
open(out, "w", encoding="utf-8").write(page.replace("/*__APP__*/", app.replace("</script", "<\\/script")))
print("wrote", out, os.path.getsize(out), "bytes")
