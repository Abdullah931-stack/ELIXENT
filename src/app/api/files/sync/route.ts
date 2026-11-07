import type { NextRequest } from "next/server";
import {
  handleFilesSyncGet,
  dynamic,
} from "@/server/routes/files-api.routes";

export { dynamic };

export async function GET(request: NextRequest | Request): Promise<Response> {
  return handleFilesSyncGet(request);
}
