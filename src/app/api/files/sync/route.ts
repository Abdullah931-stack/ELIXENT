import type { NextRequest } from "next/server";
import { handleFilesSyncGet } from "@/server/routes/files-api.routes";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest | Request): Promise<Response> {
  return handleFilesSyncGet(request);
}
