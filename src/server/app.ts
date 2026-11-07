import { Hono } from "hono";
import { sessionMiddleware } from "@/server/middleware/session-middleware";
import { agentRoutes } from "@/server/routes/agent.routes";
import { filesApiRoutes } from "@/server/routes/files-api.routes";
import { stripeRoutes } from "@/server/routes/stripe.routes";
import { cronRoutes } from "@/server/routes/cron.routes";
import { authCallbackRoutes } from "@/server/routes/auth-callback.routes";
import { e2eAuthRoutes } from "@/server/routes/e2e-auth.routes";

export const app = new Hono()
  .use("*", sessionMiddleware)
  .route("/api/agent", agentRoutes)
  .route("/api/files", filesApiRoutes)
  .route("/api/stripe", stripeRoutes)
  .route("/api/cron", cronRoutes)
  .route("/api/test/e2e-auth", e2eAuthRoutes)
  .route("/auth/callback", authCallbackRoutes);

export type AppType = typeof app;
export default app;
