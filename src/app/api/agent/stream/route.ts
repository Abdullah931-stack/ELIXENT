import type { NextRequest } from "next/server";
import { handleAgentStreamPost } from "@/server/routes/agent.routes";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest | Request): Promise<Response> {
  return handleAgentStreamPost(req);
}
