import { mozCall, MOZ_METHODS } from "@/lib/moz";
import { json, fail, body, isMock } from "@/lib/api";
import { mockMoz } from "@/lib/mock";

export const runtime = "nodejs";
export const maxDuration = 60;

// Proxy for an allow-listed set of Moz API methods, using the caller's own token.
export async function POST(req: Request) {
  try {
    const { method, data } = await body<{ method: string; data: unknown }>(req);
    if (!MOZ_METHODS.has(method)) return json({ error: { message: "Method not allowed", code: "bad_method" } }, 400);
    if (isMock()) return json({ result: mockMoz(method) });
    const token = req.headers.get("x-moz-token") || "";
    return json({ result: await mozCall(token, method, data) });
  } catch (e) { return fail(e); }
}
