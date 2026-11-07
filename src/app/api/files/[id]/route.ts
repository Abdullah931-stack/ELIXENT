import type { NextRequest } from "next/server";
import {
  handleFileByIdGet,
  handleFileByIdPut,
  handleFileByIdDelete,
  dynamic,
} from "@/server/routes/files-api.routes";

export { dynamic };

export interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(
  request: NextRequest | Request,
  context: RouteParams
): Promise<Response> {
  return handleFileByIdGet(request, context);
}

export async function PUT(
  request: NextRequest | Request,
  context: RouteParams
): Promise<Response> {
  return handleFileByIdPut(request, context);
}

export async function DELETE(
  request: NextRequest | Request,
  context: RouteParams
): Promise<Response> {
  return handleFileByIdDelete(request, context);
}
