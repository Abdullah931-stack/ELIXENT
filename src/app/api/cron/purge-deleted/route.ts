import type { NextRequest } from "next/server";
import {
  handlePurgeDeletedCron,
  runtime,
  dynamic,
} from "@/server/routes/cron.routes";

export { runtime, dynamic };

export async function GET(request: NextRequest | Request): Promise<Response> {
  return handlePurgeDeletedCron(request);
}

export const POST = GET;
