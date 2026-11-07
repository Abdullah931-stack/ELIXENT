import type { NextRequest } from "next/server";
import { handleStripeWebhookPost } from "@/server/routes/stripe.routes";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest | Request): Promise<Response> {
  return handleStripeWebhookPost(request);
}
