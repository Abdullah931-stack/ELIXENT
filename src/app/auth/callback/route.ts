import type { NextRequest } from "next/server";
import { handleAuthCallbackGet } from "@/server/routes/auth-callback.routes";

export async function GET(request: NextRequest | Request): Promise<Response> {
  return handleAuthCallbackGet(request);
}
