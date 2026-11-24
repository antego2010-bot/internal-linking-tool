import { json, isMock } from "@/lib/api";

export const runtime = "nodejs";

export async function GET() {
  return json({ ok: true, mock: isMock(), storage: !!process.env.BLOB_READ_WRITE_TOKEN });
}
