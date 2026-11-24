import { put, head } from "@vercel/blob";

// JSON storage on Vercel Blob, with an in-memory fallback for local dev (no BLOB_READ_WRITE_TOKEN).
const mem = new Map<string, { at: number; value: unknown }>();
const hasBlob = () => !!process.env.BLOB_READ_WRITE_TOKEN;

export async function getJSON<T>(path: string, maxAgeMs = 60_000): Promise<T | null> {
  const hit = mem.get(path);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.value as T;
  if (!hasBlob()) return hit ? (hit.value as T) : null;
  try {
    const meta = await head(path);
    const res = await fetch(meta.url + "?v=" + Date.now(), { cache: "no-store" });
    if (!res.ok) return null;
    const value = (await res.json()) as T;
    mem.set(path, { at: Date.now(), value });
    return value;
  } catch { return hit ? (hit.value as T) : null; }
}

export async function putJSON(path: string, value: unknown): Promise<void> {
  mem.set(path, { at: Date.now(), value });
  if (!hasBlob()) return;
  await put(path, JSON.stringify(value), { access: "public", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json", cacheControlMaxAge: 60 });
}

export const sitePath = (domain: string, file: string) => `sites/${domain.replace(/[^a-z0-9.-]/g, "_")}/${file}`;

/** Stores raw bytes publicly and returns the URL (null without Blob, e.g. local dev). */
export async function putBytes(path: string, bytes: Buffer, contentType: string): Promise<string | null> {
  if (!hasBlob()) return null;
  const r = await put(path, bytes, { access: "public", addRandomSuffix: false, allowOverwrite: true, contentType, cacheControlMaxAge: 300 });
  return r.url;
}
export async function blobInfo(path: string): Promise<{ url: string; uploadedAt: Date } | null> {
  if (!hasBlob()) return null;
  try { const m = await head(path); return { url: m.url, uploadedAt: new Date(m.uploadedAt) }; } catch { return null; }
}
