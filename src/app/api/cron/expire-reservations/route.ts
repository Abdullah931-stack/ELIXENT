import type { NextRequest } from "next/server";
import {
  handleExpireReservationsCron,
  runtime,
  dynamic,
} from "@/server/routes/cron.routes";

export { runtime, dynamic };

export async function GET(request: NextRequest | Request): Promise<Response> {
  return handleExpireReservationsCron(request);
}

export const POST = GET;
