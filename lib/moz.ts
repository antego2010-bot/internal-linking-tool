// Moz API v3 (JSON-RPC). The user's own token is passed per request and never stored.
export const MOZ_METHODS = new Set([
  "data.keyword.serp.fetch",
  "data.keyword.serp.generate",
  "data.keyword.suggestion.list",
  "data.keyword.metrics.fetch",
  "data.site.ranking-keyword.list",
  "data.site.metrics.fetch.multiple",
  "async.call.lookup",
  "quota.lookup",
]);

export class MozError extends Error {
  code: string; status: number;
  constructor(message: string, code = "moz_error", status = 502) { super(message); this.code = code; this.status = status; }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function mozRpc(token: string, method: string, data: unknown): Promise<any> {
  if (!MOZ_METHODS.has(method)) throw new MozError("Method not allowed: " + method, "bad_method", 400);
  if (!token) throw new MozError("Add your Moz API token in Settings.", "no_token", 401);
  const res = await fetch("https://api.moz.com/jsonrpc", {
    method: "POST",
    headers: { "x-moz-token": token, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params: { data } }),
  });
  let body: any = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (res.status === 401 || res.status === 403) throw new MozError("Moz rejected the API token. Check it in Settings.", "auth", 401);
  if (res.status === 429) throw new MozError("Moz API rate limit or quota reached. Try again later.", "rate_limited", 429);
  if (body && body.error) {
    const e = body.error; const msg = (e.message || "Moz API error") + (e.data && e.data.name ? ` (${e.data.name})` : "");
    throw new MozError(msg, e.data && e.data.name === "NotFoundError" ? "not_found" : String(e.code || "moz_error"), res.status >= 400 ? res.status : 502);
  }
  if (!res.ok || !body) throw new MozError(`Moz API answered ${res.status}`, "http_" + res.status, 502);
  return body.result;
}

/** Calls a method and, if it answers with a pending async call, polls until it completes. */
export async function mozCall(token: string, method: string, data: unknown, waitMs = 40_000): Promise<any> {
  let r = await mozRpc(token, method, data);
  const t0 = Date.now();
  while (r && r.async_call && r.async_call.status !== "complete") {
    if (["failed", "error"].includes(r.async_call.status)) throw new MozError("Moz async call failed", "async_failed");
    if (Date.now() - t0 > waitMs) throw new MozError("Moz took too long to answer", "timeout", 504);
    await sleep(1500);
    r = await mozRpc(token, "async.call.lookup", { id: r.async_call.id });
  }
  return r && r.async_call ? r.async_call.result : r;
}
