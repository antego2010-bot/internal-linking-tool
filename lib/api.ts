import { NextResponse } from "next/server";

export const isMock = () => process.env.MOCK === "1";
export function json(data: unknown, status = 200) { return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } }); }
export function fail(e: unknown) {
  const err = e as { message?: string; code?: string; status?: number };
  const status = err && typeof err.status === "number" && err.status >= 400 ? err.status : 500;
  return json({ error: { message: err?.message || String(e), code: err?.code || "error" } }, status);
}
export async function body<T>(req: Request): Promise<T> {
  const text = await req.text();
  if (text.length > 3_000_000) throw Object.assign(new Error("Request too large"), { status: 413, code: "too_large" });
  try { return JSON.parse(text) as T; } catch { throw Object.assign(new Error("Bad JSON"), { status: 400, code: "bad_json" }); }
}
