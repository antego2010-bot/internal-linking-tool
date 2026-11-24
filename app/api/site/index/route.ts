import zlib from "zlib";
import { getIndex } from "@/lib/crawl";
import { normDomain } from "@/lib/http";
import { blobInfo, putBytes, sitePath } from "@/lib/store";
import { json, fail } from "@/lib/api";

export const runtime = "nodejs";
export const maxDuration = 60;

// The site's public-page index (titles, text blocks and links) for the page to search in the browser.
// Big sites don't fit in a function response, so it's published once as a gzipped file and the page downloads it directly.
export async function GET(req: Request) {
  try {
    const domain = normDomain(new URL(req.url).searchParams.get("domain") || "");
    if (!domain) return json({ error: { message: "Enter your site's domain in Settings.", code: "no_domain" } }, 400);
    const index = await getIndex(domain);
    if (!index || index.status !== "ready") return json({ ready: false });
    const version = `${index.crawledAt}|${index.pages.length}`;
    const path = sitePath(domain, `index-${Buffer.from(version).toString("base64url").slice(0, 40)}.json.gz`);
    const meta = { ready: true, domain, crawledAt: index.crawledAt, pages: index.pages.length, partial: !!index.partial, version };
    const have = await blobInfo(path);
    if (have) return json({ ...meta, url: have.url });
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(index.pages)));
    const url = await putBytes(path, gz, "application/gzip");
    if (url) return json({ ...meta, url });
    // Local dev without Blob: inline (small indexes only).
    return json({ ...meta, inline: gz.toString("base64") });
  } catch (e) { return fail(e); }
}
