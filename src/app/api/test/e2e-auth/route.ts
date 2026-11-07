import type { NextRequest } from "next/server";
import {
  handleE2EAuthPost,
  handleE2EAuthDelete,
  dynamic,
} from "@/server/routes/e2e-auth.routes";

export { dynamic };

export async function POST(request: NextRequest | Request): Promise<Response> {
  return handleE2EAuthPost(request);
}

export async function DELETE(request: NextRequest | Request): Promise<Response> {
  return handleE2EAuthDelete(request);
}
