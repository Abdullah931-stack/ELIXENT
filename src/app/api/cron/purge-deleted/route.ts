import type { NextRequest } from "next/server";
import { handlePurgeDeletedCron } from "@/server/routes/cron.routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest | Request): Promise<Response> {
  return handlePurgeDeletedCron(request);
}

export const POST = GET;
