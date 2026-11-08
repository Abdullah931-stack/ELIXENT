import path from "node:path";
import fs from "node:fs";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { app } from "./app";
import { sessionMiddleware } from "./middleware/session-middleware";

const clientDist = path.resolve(process.cwd(), "dist/client");
const publicDir = path.resolve(process.cwd(), "public");

// Mount static asset handlers from Vite client distribution
if (fs.existsSync(clientDist)) {
  app.use("/*", serveStatic({ root: "./dist/client" }));
}

// Mount static asset handlers from public directory
if (fs.existsSync(publicDir)) {
  app.use("/*", serveStatic({ root: "./public" }));
}

// Fallback to dist/client/index.html for SPA routes with session validation
app.get("*", async (c) => {
  const indexPath = path.resolve(clientDist, "index.html");
  if (fs.existsSync(indexPath)) {
    const html = fs.readFileSync(indexPath, "utf-8");
    return c.html(html);
  }
  return c.text(
    "LUGX SPA client build not found. Run 'vite build' to generate dist/client.",
    404
  );
});

const port = Number(process.env.PORT || 3000);

if (process.env.NODE_ENV !== "test") {
  console.log(`[LUGX Server] Listening on http://localhost:${port}`);
  serve({
    fetch: app.fetch,
    port,
  });
}

export { app, sessionMiddleware };
export default app;
