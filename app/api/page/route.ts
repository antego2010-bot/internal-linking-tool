import { fetchText } from "@/lib/http";
import { parseHtml } from "@/lib/parse";
import { json, fail, body } from "@/lib/api";

export const runtime = "nodejs";
export const maxDuration = 30;

// Reads a draft or live page for the Draft tab: a public Google Doc (exported as .docx, parsed in the browser) or a live web page.
export async function POST(req: Request) {
  try {
    const { url } = await body<{ url: string }>(req);
    const doc = String(url || "").match(/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([\w-]{20,})/);
    if (doc) {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
      try {
        const res = await fetch(`https://docs.google.com/document/d/${doc[1]}/export?format=docx`, { redirect: "follow", signal: ctl.signal });
        const ct = res.headers.get("content-type") || "";
        if (!res.ok || /html/.test(ct)) return json({ error: { message: "That Google Doc isn't public. In the Doc, choose Share → General access → Anyone with the link (Viewer), or download it as .docx (File → Download → Microsoft Word) and upload that instead.", code: "doc_private" } }, 403);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 15_000_000) return json({ error: { message: "That Doc is too large to read.", code: "too_large" } }, 413);
        return json({ docx: buf.toString("base64") });
      } finally { clearTimeout(t); }
    }
    const { text, url: final, contentType } = await fetchText(url, { timeoutMs: 20000 });
    if (contentType && !/html|xml/.test(contentType)) return json({ error: { message: "That URL isn't an HTML page.", code: "not_html" } }, 400);
    return json({ page: parseHtml(text, final) });
  } catch (e) { return fail(e); }
}
