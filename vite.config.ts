import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import dotenv from "dotenv";
import type { IncomingMessage, ServerResponse } from "node:http";

// Load environment variables for explicit Vite define configuration
dotenv.config({ path: ".env.local" });
dotenv.config();

const rootDir = typeof import.meta.dirname !== "undefined"
  ? import.meta.dirname
  : path.resolve(".");

/**
 * Converts a Node.js IncomingMessage into a Web standard Request.
 */
async function nodeRequestToWebRequest(
  req: IncomingMessage,
  fullUrl: string
): Promise<Request> {
  const method = req.method || "GET";
  const hasBody = method !== "GET" && method !== "HEAD";

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        headers.append(key, v);
      }
    } else {
      headers.set(key, value);
    }
  }

  let bodyBuffer: Buffer | undefined;
  if (hasBody) {
    bodyBuffer = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  return new Request(fullUrl, {
    method,
    headers,
    body:
      hasBody && bodyBuffer && bodyBuffer.length > 0
        ? (bodyBuffer as unknown as BodyInit)
        : undefined,
    ...((hasBody && bodyBuffer && bodyBuffer.length > 0
      ? { duplex: "half" }
      : {}) as Record<string, unknown>),
  });
}

/**
 * Pipes a Web standard Response into a Node.js ServerResponse,
 * supporting multiple Set-Cookie headers and streaming bodies (such as SSE).
 */
async function pipeWebResponseToNodeResponse(
  webRes: Response,
  res: ServerResponse
): Promise<void> {
  res.statusCode = webRes.status;
  if (webRes.statusText) {
    res.statusMessage = webRes.statusText;
  }

  // Handle cookies (preserving multiple Set-Cookie headers)
  const setCookies =
    typeof webRes.headers.getSetCookie === "function"
      ? webRes.headers.getSetCookie()
      : [];
  if (setCookies.length > 0) {
    res.setHeader("Set-Cookie", setCookies);
  } else {
    const single = webRes.headers.get("set-cookie");
    if (single) {
      res.setHeader("Set-Cookie", single);
    }
  }

  // Apply all other headers
  for (const [key, value] of webRes.headers.entries()) {
    if (key.toLowerCase() === "set-cookie") continue;
    res.setHeader(key, value);
  }

  if (!webRes.body) {
    res.end();
    return;
  }

  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  const reader = webRes.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        res.write(value);
        if (typeof (res as unknown as { flush?: () => void }).flush === "function") {
          (res as unknown as { flush: () => void }).flush();
        }
      }
    }
  } finally {
    res.end();
  }
}

/**
 * Development middleware plugin integrating Hono server routes and session
 * guarding directly into Vite dev server.
 */
function elixentHonoDevServerPlugin(): Plugin {
  return {
    name: "elixent-hono-dev-server",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        try {
          if (!req.url) {
            return next();
          }

          const host = req.headers.host || "localhost:5173";
          const fullUrl = `http://${host}${req.url}`;
          const urlObj = new URL(req.url, `http://${host}`);
          const pathname = urlObj.pathname;

          // 1. Route API and OAuth callback requests directly to Hono app
          if (pathname.startsWith("/api/") || pathname.startsWith("/auth/callback")) {
            const { app } = await server.ssrLoadModule("/src/server/app.ts");
            const webRequest = await nodeRequestToWebRequest(req, fullUrl);
            const response = await app.fetch(webRequest);
            await pipeWebResponseToNodeResponse(response, res);
            return;
          }

          // 2. HTML page navigation session guarding
          const isPageNavigation =
            req.method === "GET" &&
            (pathname === "/" ||
              pathname === "/login" ||
              pathname === "/dashboard" ||
              pathname === "/account" ||
              pathname === "/workspace" ||
              pathname === "/workspace/" ||
              /^\/workspace\/editor\/.*$/.test(pathname));

          if (isPageNavigation) {
            const { handleSessionProxy } = await server.ssrLoadModule(
              "/src/server/middleware/session-middleware.ts"
            );
            const webRequest = await nodeRequestToWebRequest(req, fullUrl);
            const proxyRes = await handleSessionProxy(webRequest);

            if (proxyRes.status === 307 || proxyRes.status === 401) {
              await pipeWebResponseToNodeResponse(proxyRes, res);
              return;
            }

            // Apply any Set-Cookie headers produced during proxy evaluation (e.g. token refresh)
            const setCookies =
              typeof proxyRes.headers.getSetCookie === "function"
                ? proxyRes.headers.getSetCookie()
                : [];
            if (setCookies.length > 0) {
              res.setHeader("Set-Cookie", setCookies);
            } else {
              const sc = proxyRes.headers.get("set-cookie");
              if (sc) res.setHeader("Set-Cookie", sc);
            }

            return next();
          }

          return next();
        } catch (error) {
          console.error("[elixent-hono-dev-server] Middleware error:", error);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end("Internal Server Error");
          } else {
            res.end();
          }
        }
      });
    },
  };
}

function clientServerStubPlugin(): Plugin {
  const virtualModuleId = "\0virtual:server-empty";
  return {
    name: "client-server-stub",
    enforce: "pre",
    resolveId(id, _importer, options) {
      if (options?.ssr) {
        return null;
      }
      if (
        id.includes("/server/actions/") ||
        id.includes("@/server/actions/") ||
        id.includes("/server/services/") ||
        id.includes("@/server/services/") ||
        id.includes("/server/context/") ||
        id.includes("@/server/context/") ||
        id.includes("/lib/supabase/server") ||
        id.includes("@/lib/supabase/server")
      ) {
        return virtualModuleId;
      }
      return null;
    },
    load(id) {
      if (id === virtualModuleId) {
        return "export default {};";
      }
      return null;
    },
  };
}

export default defineConfig({
  esbuild: {
    target: "esnext",
  },
  optimizeDeps: {
    esbuildOptions: {
      target: "esnext",
    },
  },
  plugins: [
    clientServerStubPlugin(),
    react(),
    elixentHonoDevServerPlugin(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "./src"),
    },
  },
  envPrefix: ["VITE_", "NEXT_PUBLIC_"],
  worker: {
    format: "es",
  },
  build: {
    target: "esnext",
    outDir: "dist/client",
    emptyOutDir: true,
  },
  define: {
    "process.env.NEXT_PUBLIC_SUPABASE_URL": JSON.stringify(
      process.env.NEXT_PUBLIC_SUPABASE_URL || ""
    ),
    "process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY": JSON.stringify(
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""
    ),
    "process.env.NEXT_PUBLIC_APP_URL": JSON.stringify(
      process.env.NEXT_PUBLIC_APP_URL || ""
    ),
    "process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY": JSON.stringify(
      process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || ""
    ),
    "process.env.NEXT_PUBLIC_AI_STREAMING_ENABLED": JSON.stringify(
      process.env.NEXT_PUBLIC_AI_STREAMING_ENABLED || ""
    ),
    "process.env": "{}",
  },
});
