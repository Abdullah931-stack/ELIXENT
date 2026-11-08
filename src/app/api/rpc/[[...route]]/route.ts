import type { NextRequest } from "next/server";
import { Hono } from "hono";
import { sessionMiddleware } from "@/server/middleware/session-middleware";
import { rpcRoutes } from "@/server/routes/rpc.routes";

export const dynamic = "force-dynamic";

const rpcApp = new Hono()
    .use("*", sessionMiddleware)
    .route("/api/rpc", rpcRoutes);

export async function GET(request: NextRequest | Request): Promise<Response> {
    return rpcApp.fetch(request);
}

export async function POST(request: NextRequest | Request): Promise<Response> {
    return rpcApp.fetch(request);
}
