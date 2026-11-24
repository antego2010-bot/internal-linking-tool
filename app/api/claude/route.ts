import { askJSON } from "@/lib/claude";
import { json, fail, body, isMock } from "@/lib/api";

export const runtime = "nodejs";
export const maxDuration = 300;

// Asks Claude for JSON with the caller's own Anthropic key (prompts are built in the page).
export async function POST(req: Request) {
  try {
    const { prompt, model } = await body<{ prompt: string; model: string }>(req);
    if (isMock()) return json({ json: mockAnswer(prompt) });
    const key = req.headers.get("x-claude-key") || "";
    if (!key) return json({ error: { message: "Add your Claude API key in Settings.", code: "no_key" } }, 401);
    if (!model) return json({ error: { message: "Choose a Claude model in Settings.", code: "no_model" } }, 400);
    if (!prompt || prompt.length > 400_000) return json({ error: { message: "Bad prompt", code: "bad_prompt" } }, 400);
    const out = await askJSON(key, model, prompt, { maxTokens: 16000 });
    return json(out);
  } catch (e) { return fail(e); }
}

// Canned answers for local UI testing (MOCK=1): shaped like real ones so every check in the page runs.
function mockAnswer(prompt: string): unknown {
  if (prompt.includes('"suggestions"')) {
    const block = prompt.match(/\[(B\d+)\] \((?:paragraph|list item)\) (.+)/);
    const lib = prompt.match(/^(L\d+)\|/m);
    if (!block || !lib) return { suggestions: [] };
    const anchor = block[2].split(" ").slice(0, 3).join(" ");
    return { suggestions: [{ block: block[1], anchor, lib: lib[1], revised_anchor: "", reason: "Mock: closely related destination." }] };
  }
  if (prompt.includes('"core"')) return { summary: "Mock summary of the article.", core: ["generative engine optimization", "ai search"], related: ["ai answers"] };
  if (prompt.includes('"keep":true') || prompt.includes('"results":[{"id":1,"keep"')) {
    const ids = [...prompt.matchAll(/"id":(\d+),"page_title"/g)].map(m => Number(m[1]));
    const phrases = [...prompt.matchAll(/"matched_phrase":"([^"]*)"/g)].map(m => m[1]);
    return { results: ids.map((id, i) => ({ id, keep: true, anchor: phrases[i] || "", edit: "", reason: "Mock: on-topic mention.", confidence: "high" })) };
  }
  if (prompt.includes('"related": [string]')) return { related: ["ai answers", "llm visibility"] };
  if (prompt.includes('"new_anchor"')) return { results: [{ id: 1, keep: false, new_anchor: "", new_sentence: "", reason: "Mock." }] };
  if (prompt.includes('"links":[')) return { links: [] };
  return {};
}
