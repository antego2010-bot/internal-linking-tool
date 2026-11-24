// Fetching third-party pages politely and safely.
export const UA = "InternalLinkingTool/1.0 (+https://internal-linking-tool.vercel.app; internal link suggestions)";

export class FetchError extends Error {
  status: number;
  constructor(message: string, status = 0) { super(message); this.status = status; }
}

/** Only public http(s) hosts: no localhost, private ranges or bare hostnames (basic SSRF guard). */
export function assertPublicUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new FetchError("That isn't a valid URL."); }
  if (!/^https?:$/.test(u.protocol)) throw new FetchError("Only http and https URLs are supported.");
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) throw new FetchError("That host isn't publicly reachable.");
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) {
    const [a, b] = h.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224) throw new FetchError("That host isn't publicly reachable.");
  }
  if (h.startsWith("[") || h.includes(":")) throw new FetchError("IP-literal hosts aren't supported.");
  return u;
}

export async function fetchText(url: string, opts: { timeoutMs?: number; maxBytes?: number; accept?: string } = {}): Promise<{ text: string; url: string; contentType: string }> {
  const u = assertPublicUrl(url);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 15000);
  try {
    const res = await fetch(u.toString(), { headers: { "user-agent": UA, accept: opts.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5" }, redirect: "follow", signal: ctl.signal });
    if (!res.ok) throw new FetchError(`${u.hostname} answered ${res.status}`, res.status);
    const ct = res.headers.get("content-type") || "";
    const max = opts.maxBytes ?? 4_000_000;
    const reader = res.body?.getReader();
    if (!reader) return { text: await res.text(), url: res.url || u.toString(), contentType: ct };
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) { ctl.abort(); break; }
      chunks.push(value);
    }
    const buf = new Uint8Array(size > max ? max : size); let o = 0;
    for (const c of chunks) { const n = Math.min(c.length, buf.length - o); buf.set(c.subarray(0, n), o); o += n; if (o >= buf.length) break; }
    return { text: new TextDecoder().decode(buf), url: res.url || u.toString(), contentType: ct };
  } catch (e: unknown) {
    if (e instanceof FetchError) throw e;
    const msg = e instanceof Error ? (e.name === "AbortError" ? "timed out" : e.message) : String(e);
    throw new FetchError(`Couldn't fetch ${u.hostname}: ${msg}`);
  } finally { clearTimeout(t); }
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  });
  await Promise.all(workers);
  return out;
}

export const normHost = (h: string) => h.toLowerCase().replace(/^www\./, "");
export function normDomain(input: string): string {
  const s = String(input || "").trim().toLowerCase();
  if (!s) return "";
  try { return normHost(new URL(/^https?:\/\//.test(s) ? s : "https://" + s).hostname); } catch { return ""; }
}
/** Path without query/hash/trailing slash, for same-site comparisons. */
export function normPath(href: string, base?: string): string {
  try {
    const u = new URL(href, base);
    const p = u.pathname.replace(/\/+$/, "");
    return p || "/";
  } catch { return ""; }
}
