import type { NextRequest } from "next/server";
import {
  handleStripeWebhookPost,
  dynamic,
} from "@/server/routes/stripe.routes";

export { dynamic };

export async function POST(request: NextRequest | Request): Promise<Response> {
  return handleStripeWebhookPost(request);
}
