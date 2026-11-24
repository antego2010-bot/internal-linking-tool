// Anthropic Messages API with the user's own key (never stored).
export class ClaudeError extends Error {
  code: string; status: number;
  constructor(message: string, code = "claude_error", status = 502) { super(message); this.code = code; this.status = status; }
}
export type Source = { url: string; title: string };

const API = "https://api.anthropic.com/v1";
const headers = (key: string) => ({ "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" });

function errFrom(status: number, body: any): ClaudeError {
  const m = body && body.error && body.error.message ? body.error.message : `Anthropic API answered ${status}`;
  if (status === 401) return new ClaudeError("Anthropic rejected the API key. Check it in Settings.", "auth", 401);
  if (status === 429) return new ClaudeError("Claude rate limit reached. Wait a minute and run again.", "rate_limited", 429);
  if (status === 529 || status === 503) return new ClaudeError("Claude is overloaded right now. Try again shortly.", "overloaded", 503);
  return new ClaudeError(m, "claude_" + status, status >= 400 && status < 500 ? 400 : 502);
}

export async function listModels(key: string): Promise<{ id: string; name: string }[]> {
  const res = await fetch(`${API}/models?limit=100`, { headers: headers(key) });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw errFrom(res.status, body);
  return (body.data || []).map((m: any) => ({ id: m.id, name: m.display_name || m.id }));
}

export function extractJSON(text: string): any {
  const t = text.replace(/```(?:json)?/g, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw new ClaudeError("Claude's answer had no JSON in it. Run again.", "invalid_json", 502);
  try { return JSON.parse(t.slice(a, b + 1)); }
  catch { throw new ClaudeError("Claude's answer couldn't be read. Run again.", "invalid_json", 502); }
}

/** Best-effort repair of JSON truncated mid-way: cut back to the last complete value and close open brackets. */
export function repairJSON(text: string): any | null {
  const t = text.replace(/```(?:json)?/g, "");
  const start = t.indexOf("{"); if (start < 0) return null;
  const s = t.slice(start);
  for (let cut = s.length; cut > 0; ) {
    cut = Math.max(s.lastIndexOf("},", cut - 1), s.lastIndexOf("],", cut - 1), s.lastIndexOf("\",", cut - 1));
    if (cut <= 0) break;
    const head = s.slice(0, cut + 1);
    const stack: string[] = []; let inStr = false, esc = false;
    for (const ch of head) {
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true; else if (ch === "{" || ch === "[") stack.push(ch); else if (ch === "}" || ch === "]") stack.pop();
    }
    if (inStr) continue;
    const closed = head + stack.reverse().map(c => (c === "{" ? "}" : "]")).join("");
    try { return JSON.parse(closed); } catch { /* try an earlier cut */ }
  }
  return null;
}

export async function askJSON(key: string, model: string, prompt: string, opts: { webSearch?: number; maxTokens?: number } = {}): Promise<{ json: any; sources: Source[]; searches: number; truncated?: boolean }> {
  const tools = opts.webSearch ? [{ type: "web_search_20250305", name: "web_search", max_uses: opts.webSearch }] : undefined;
  const messages: any[] = [{ role: "user", content: prompt }];
  const sources = new Map<string, Source>(); let searches = 0; let text = "";
  for (let turn = 0; turn < 4; turn++) {
    const res = await fetch(`${API}/messages`, { method: "POST", headers: headers(key), body: JSON.stringify({ model, max_tokens: opts.maxTokens ?? 12000, messages, ...(tools ? { tools } : {}) }) });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      if (tools && res.status === 400 && body && /web.?search/i.test(JSON.stringify(body))) throw new ClaudeError("Web search isn't enabled for this Anthropic organization. An admin can turn it on in the Claude Console (Settings → Privacy / Tools), or untick 'Use web search' in Settings.", "web_search_disabled", 400);
      throw errFrom(res.status, body);
    }
    for (const c of body.content || []) {
      if (c.type === "text") {
        text += c.text;
        (c.citations || []).forEach((ct: any) => { if (ct.url) sources.set(ct.url, { url: ct.url, title: ct.title || ct.url }); });
      } else if (c.type === "server_tool_use") searches++;
      else if (c.type === "web_search_tool_result" && Array.isArray(c.content)) c.content.forEach((r: any) => { if (r.url && !sources.has(r.url)) sources.set(r.url, { url: r.url, title: r.title || r.url }); });
    }
    if (body.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: body.content }); text = ""; continue; }
    if (body.stop_reason === "max_tokens") {
      // Salvage what we can: close the JSON at the last complete array item.
      const fixed = repairJSON(text);
      if (fixed) return { json: fixed, sources: [...sources.values()], searches, truncated: true };
      throw new ClaudeError("Claude's answer was cut off. Run again.", "max_tokens", 502);
    }
    break;
  }
  return { json: extractJSON(text), sources: [...sources.values()], searches };
}
