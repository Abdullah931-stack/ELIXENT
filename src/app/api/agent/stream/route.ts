import type { NextRequest } from "next/server";
import {
  handleAgentStreamPost,
  dynamic,
  maxDuration,
} from "@/server/routes/agent.routes";

export { dynamic, maxDuration };

export async function POST(req: NextRequest | Request): Promise<Response> {
  return handleAgentStreamPost(req);
}
