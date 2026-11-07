import type { NextRequest } from "next/server";
import { handleStripeCreateCheckoutPost } from "@/server/routes/stripe.routes";

export async function POST(request: NextRequest | Request): Promise<Response> {
  return handleStripeCreateCheckoutPost(request);
}
