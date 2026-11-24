import { listModels } from "@/lib/claude";
import { json, fail, isMock } from "@/lib/api";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    if (isMock()) return json({ models: [{ id: "claude-sonnet-mock", name: "Claude Sonnet (mock)" }, { id: "claude-opus-mock", name: "Claude Opus (mock)" }] });
    const key = req.headers.get("x-claude-key") || "";
    if (!key) return json({ error: { message: "Add your Claude API key.", code: "no_key" } }, 401);
    return json({ models: await listModels(key) });
  } catch (e) { return fail(e); }
}
