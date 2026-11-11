import { defineConfig, type Plugin, type ResolvedConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import dotenv from "dotenv";
import { transformSync } from "esbuild";
import * as acorn from "acorn";
import { builtinModules } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isGuardedPageNavigation,
  isPublicStaticAssetPath,
} from "./src/lib/auth/route-guard";

// Load environment variables from .env.local and .env (excluded in hermetic vitest)
if (!process.env.VITEST) {
  dotenv.config({ path: ".env.local" });
  dotenv.config();
}

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
          // 1. Prevent host hijacking via leading double-slash paths (e.g. //workspace)
          const cleanPath = req.url.replace(/^\/+/, "/");
          const targetOrigin = `http://${host}`;
          const urlObj = new URL(cleanPath, targetOrigin);
          const pathname = urlObj.pathname;
          const fullUrl = urlObj.toString();
          const method = req.method || "GET";

          // 2. Route API and OAuth callback requests directly to Hono app
          if (pathname.startsWith("/api/") || pathname.startsWith("/auth/callback")) {
            const { app } = await server.ssrLoadModule("/src/server/app.ts");
            const webRequest = await nodeRequestToWebRequest(req, fullUrl);
            const response = await app.fetch(webRequest);
            await pipeWebResponseToNodeResponse(response, res);
            return;
          }

          // 3. HTML page navigation session guarding unified with isGuardedPageNavigation
          const isGuardedPage = isGuardedPageNavigation(pathname, method);
          const isLoginNavigation =
            (method === "GET" || method === "HEAD") && pathname === "/login";
          const shouldCheckSession =
            (isGuardedPage || isLoginNavigation) &&
            !isPublicStaticAssetPath(pathname);

          if (shouldCheckSession) {
            const { handleSessionProxy } = await server.ssrLoadModule(
              "/src/server/middleware/session-middleware.ts"
            );
            const webRequest = await nodeRequestToWebRequest(req, fullUrl);
            const proxyRes = await handleSessionProxy(webRequest);

            if (
              (proxyRes.status >= 300 && proxyRes.status < 400) ||
              proxyRes.status === 401
            ) {
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

type EsbuildLoader = "ts" | "tsx" | "js" | "jsx";

interface BoundaryAnchors {
  rootDir: string;
  rootDirPosix: string;
  indexHtmlPosix: string;
  srcDir: string;
  srcDirPosix: string;
  serverDirPosix: string;
  serverSupabasePosix: string;
  stripePosix: string;
  rateLimitPosix: string;
  cronPosix: string;
  keyRotationPosix: string;
  appUrlPosix: string;
  rpcClientPosix: string;
}

const TRANSFORM_EXTENSIONS = new Map<string, EsbuildLoader>([
  [".ts", "ts"],
  [".mts", "ts"],
  [".cts", "ts"],
  [".tsx", "tsx"],
  [".js", "js"],
  [".mjs", "js"],
  [".cjs", "js"],
  [".jsx", "jsx"],
]);

const NODE_BUILTIN_SET = new Set<string>([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

function isNodeBuiltin(specifier: string): boolean {
  const clean = specifier.toLowerCase().trim();
  if (clean.startsWith("node:")) return true;
  const rootModule = clean.split("/")[0];
  return NODE_BUILTIN_SET.has(rootModule);
}

function stripQueryAndHash(rawPath: string): string {
  return rawPath.split("?")[0].split("#")[0];
}

function toPosixSlashes(rawPath: string): string {
  return rawPath.replace(/\\/g, "/");
}

function stripFsPrefix(posixPath: string): string {
  const withoutFs = posixPath.startsWith("/@fs/")
    ? posixPath.slice(4)
    : posixPath;
  return /^\/[a-z]:\//i.test(withoutFs) ? withoutFs.slice(1) : withoutFs;
}

function toCanonicalPosix(rawPath: string): string {
  const cleanPosix = stripFsPrefix(toPosixSlashes(rawPath));
  return toPosixSlashes(path.resolve(cleanPosix)).toLowerCase();
}

function isWithinDirectory(candidatePosix: string, dirPosix: string): boolean {
  return candidatePosix === dirPosix || candidatePosix.startsWith(`${dirPosix}/`);
}

function isServerSubmodulePath(
  candidatePosix: string,
  submodulePosix: string
): boolean {
  return (
    candidatePosix === submodulePosix ||
    candidatePosix.startsWith(`${submodulePosix}/`) ||
    candidatePosix.startsWith(`${submodulePosix}.`)
  );
}

function hasServerInFilename(candidatePosix: string): boolean {
  const base = path.posix.basename(candidatePosix);
  return base.includes(".server.") || base.endsWith(".server");
}

function isServerOnlySpecifier(rawId: string): boolean {
  const clean = stripFsPrefix(toPosixSlashes(stripQueryAndHash(rawId))).toLowerCase();
  const base = path.posix.basename(clean);
  if (base.includes(".server.") || base.endsWith(".server")) return true;
  if (clean.includes("*.server.") || clean.endsWith(".server.*")) return true;
  return false;
}

function isServerModulePath(
  candidatePosix: string,
  anchors: BoundaryAnchors
): boolean {
  return (
    isWithinDirectory(candidatePosix, anchors.serverDirPosix) ||
    isServerSubmodulePath(candidatePosix, anchors.serverSupabasePosix) ||
    isServerSubmodulePath(candidatePosix, anchors.stripePosix) ||
    isServerSubmodulePath(candidatePosix, anchors.rateLimitPosix) ||
    isServerSubmodulePath(candidatePosix, anchors.cronPosix) ||
    isServerSubmodulePath(candidatePosix, anchors.keyRotationPosix) ||
    isServerSubmodulePath(candidatePosix, anchors.appUrlPosix) ||
    hasServerInFilename(candidatePosix)
  );
}

function createBoundaryAnchors(effectiveRoot: string): BoundaryAnchors {
  const resolvedRoot = path.resolve(stripFsPrefix(toPosixSlashes(effectiveRoot)));
  const srcDir = path.resolve(resolvedRoot, "src");
  return {
    rootDir: resolvedRoot,
    rootDirPosix: toPosixSlashes(resolvedRoot).toLowerCase(),
    indexHtmlPosix: toCanonicalPosix(path.resolve(resolvedRoot, "index.html")),
    srcDir,
    srcDirPosix: toPosixSlashes(srcDir).toLowerCase(),
    serverDirPosix: toCanonicalPosix(path.resolve(srcDir, "server")),
    serverSupabasePosix: toCanonicalPosix(
      path.resolve(srcDir, "lib/supabase/server")
    ),
    stripePosix: toCanonicalPosix(path.resolve(srcDir, "lib/stripe")),
    rateLimitPosix: toCanonicalPosix(path.resolve(srcDir, "lib/rate-limit")),
    cronPosix: toCanonicalPosix(path.resolve(srcDir, "lib/cron")),
    keyRotationPosix: toCanonicalPosix(path.resolve(srcDir, "lib/ai/key-rotation")),
    appUrlPosix: toCanonicalPosix(path.resolve(srcDir, "lib/config/app-url")),
    rpcClientPosix: toCanonicalPosix(path.resolve(srcDir, "client/rpc-client.ts")),
  };
}

function resolveTargetToCanonicalPosix(
  rawIdPosix: string,
  importerCanonicalPosix: string,
  anchors: BoundaryAnchors
): string | null {
  if (rawIdPosix === "@") {
    return anchors.srcDirPosix;
  }
  if (rawIdPosix.startsWith("@/")) {
    return toCanonicalPosix(path.resolve(anchors.srcDir, rawIdPosix.slice(2)));
  }
  if (
    rawIdPosix === "." ||
    rawIdPosix === ".." ||
    rawIdPosix.startsWith("./") ||
    rawIdPosix.startsWith("../")
  ) {
    return toCanonicalPosix(
      path.resolve(path.posix.dirname(importerCanonicalPosix), rawIdPosix)
    );
  }

  const lowerId = rawIdPosix.toLowerCase();
  if (/^[a-z]:\//i.test(rawIdPosix)) {
    return toCanonicalPosix(rawIdPosix);
  }
  if (rawIdPosix.startsWith("/")) {
    const canonicalAbs = toCanonicalPosix(rawIdPosix);
    if (isWithinDirectory(canonicalAbs, anchors.rootDirPosix)) {
      return canonicalAbs;
    }
    return toCanonicalPosix(path.resolve(anchors.rootDir, rawIdPosix.slice(1)));
  }
  if (lowerId === "src" || lowerId.startsWith("src/")) {
    return toCanonicalPosix(path.resolve(anchors.rootDir, rawIdPosix));
  }

  // Bare third-party package specifiers (e.g. "react", "hono/client")
  return null;
}

function walkAst(
  node: unknown,
  visitor: (node: Record<string, unknown>) => void
): void {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  visitor(record);
  for (const key of Object.keys(record)) {
    if (key === "loc" || key === "range" || key === "comments") continue;
    const child = record[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        walkAst(item, visitor);
      }
    } else if (child && typeof child === "object") {
      walkAst(child, visitor);
    }
  }
}



function clientServerBoundaryGuardPlugin(
  initialRootDir: string = rootDir
): Plugin {
  let anchors = createBoundaryAnchors(initialRootDir);

  return {
    name: "client-server-boundary-guard",
    enforce: "pre",
    configResolved(resolved: Pick<ResolvedConfig, "root">) {
      if (resolved?.root) {
        anchors = createBoundaryAnchors(resolved.root);
      }
    },
    resolveId(id, importer, options) {
      // 1. Bypass during SSR compilation or if importer/id is missing
      if (options?.ssr || !importer || !id) return null;

      // 2. Strip query/hash parameters (?raw, ?url, #hash) prior to canonical resolution
      const cleanId = stripQueryAndHash(id);
      const cleanImporter = stripQueryAndHash(importer);
      if (!cleanId || !cleanImporter) return null;

      const rawIdPosix = stripFsPrefix(toPosixSlashes(cleanId));
      const rawIdLower = rawIdPosix.toLowerCase();

      // 3. Invariant: Exclude Rollup/Vite virtual modules
      if (rawIdPosix.startsWith("\0") || rawIdLower.startsWith("virtual:")) {
        return null;
      }

      // 4. Canonicalize importer and exclude node_modules / server-plane importers
      const importerPosix = toCanonicalPosix(cleanImporter);
      if (
        importerPosix.includes("/node_modules/") ||
        importerPosix.startsWith("node_modules/")
      ) {
        return null;
      }

      if (isServerModulePath(importerPosix, anchors)) {
        return null;
      }

      // 5. Fail-closed check: Prohibit client imports of Node.js built-ins
      if (isNodeBuiltin(cleanId)) {
        this.error(
          `[Security / Architecture Boundary Violation] Direct client import of Node.js built-in module "${id}" from "${importer}" is prohibited in client-side code.`
        );
      }

      // Allow root index.html synthetic fallback importer used by moduleGraph.ensureEntryFromUrl / vite:css-analysis.
      // Inline <script> blocks use ?html-proxy and remain strictly blocked in resolveId; direct loads are blocked in load().
      const isHtmlProxyImporter = /[?&]html-proxy\b/i.test(importer);
      const isSyntheticIndexHtmlFallback =
        !isHtmlProxyImporter && importerPosix === anchors.indexHtmlPosix;

      // 6. Fail-closed check: Prohibit server-only specifiers (e.g. *.server.*)
      if (isServerOnlySpecifier(rawIdPosix)) {
        if (isSyntheticIndexHtmlFallback) {
          return null;
        }
        this.error(
          `[Security / Architecture Boundary Violation] Direct client import of server module "${id}" from "${importer}" is prohibited. Use Hono RPC client (src/client/rpc-client.ts) or extract shared types into src/types/rpc-contracts.ts.`
        );
      }

      // 7. Resolve target specifier canonically (closing alias traversal & case bypasses)
      const targetPosix = resolveTargetToCanonicalPosix(
        rawIdPosix,
        importerPosix,
        anchors
      );
      if (targetPosix === null) {
        return null;
      }

      // Exclude genuine resolved node_modules targets after traversal resolution
      if (targetPosix.includes("/node_modules/")) {
        return null;
      }

      // 8. Fail-closed boundary check against server directory, server Supabase helper, and server modules
      if (isServerModulePath(targetPosix, anchors)) {
        if (isSyntheticIndexHtmlFallback) {
          return null;
        }
        this.error(
          `[Security / Architecture Boundary Violation] Direct client import of server module "${id}" from "${importer}" is prohibited. Use Hono RPC client (src/client/rpc-client.ts) or extract shared types into src/types/rpc-contracts.ts.`
        );
      }

      return null;
    },
    load(id, options) {
      if (options?.ssr || !id) return null;

      const cleanId = stripQueryAndHash(id);
      if (!cleanId) return null;

      const rawIdPosix = stripFsPrefix(toPosixSlashes(cleanId));
      const rawIdLower = rawIdPosix.toLowerCase();
      if (rawIdPosix.startsWith("\0") || rawIdLower.startsWith("virtual:")) {
        return null;
      }

      if (
        rawIdLower.includes("/node_modules/") ||
        rawIdLower.startsWith("node_modules/")
      ) {
        return null;
      }

      const modulePosix = resolveTargetToCanonicalPosix(
        rawIdPosix,
        anchors.indexHtmlPosix,
        anchors
      );
      if (
        modulePosix !== null &&
        (modulePosix.includes("/node_modules/") ||
          modulePosix.startsWith("node_modules/"))
      ) {
        return null;
      }

      if (
        (modulePosix !== null && isServerModulePath(modulePosix, anchors)) ||
        isServerOnlySpecifier(rawIdPosix)
      ) {
        this.error(
          `[Security / Architecture Boundary Violation] Direct client load of server module "${id}" is prohibited. Use Hono RPC client (src/client/rpc-client.ts) or extract shared types into src/types/rpc-contracts.ts.`
        );
      }

      return null;
    },
    transform(code, id, options) {
      if (options?.ssr || !id || !code) return null;

      const cleanId = stripQueryAndHash(id);
      if (!cleanId) return null;

      const rawIdPosix = stripFsPrefix(toPosixSlashes(cleanId));
      if (
        rawIdPosix.startsWith("\0") ||
        rawIdPosix.toLowerCase().startsWith("virtual:")
      ) {
        return null;
      }

      const modulePosix = toCanonicalPosix(rawIdPosix);
      if (
        modulePosix.includes("/node_modules/") ||
        modulePosix.startsWith("node_modules/")
      ) {
        return null;
      }

      const ext = path.posix.extname(modulePosix);
      const loader = TRANSFORM_EXTENSIONS.get(ext);
      if (!loader) return null;

      if (isServerModulePath(modulePosix, anchors)) {
        return null;
      }

      if (!code.includes("import") && !code.includes("require")) {
        return null;
      }

      let jsToScan = code;
      try {
        jsToScan = transformSync(code, {
          loader,
          jsx: "automatic",
          format: "esm",
        }).code;
      } catch {
        // Fall back to direct JS scanning if partial snippet fails esbuild parse
        jsToScan = code;
      }

      const comments: acorn.Comment[] = [];
      let ast: unknown;
      try {
        ast = acorn.parse(jsToScan, {
          ecmaVersion: "latest",
          sourceType: "module",
          onComment: comments,
          ranges: true,
          locations: true,
        });
      } catch {
        try {
          ast = acorn.parse(jsToScan, {
            ecmaVersion: "latest",
            sourceType: "script",
            onComment: comments,
            ranges: true,
            locations: true,
          });
        } catch {
          return null;
        }
      }

      walkAst(ast, (node) => {
        // 1. Detect dynamic import(...) expressions at any AST nesting level
        if (node.type === "ImportExpression") {
          const start = typeof node.start === "number" ? node.start : 0;
          const end = typeof node.end === "number" ? node.end : jsToScan.length;
          const raw = jsToScan.slice(start, end).trim();

          const hasViteIgnore =
            /@vite-ignore\b/i.test(raw) ||
            comments.some(
              (c) => c.start >= start && c.end <= end && /@vite-ignore\b/i.test(c.value)
            );

          let staticSpecifier: string | null = null;
          const source = node.source as Record<string, unknown> | undefined;
          if (source && source.type === "Literal" && typeof source.value === "string") {
            staticSpecifier = source.value;
          } else if (
            source &&
            source.type === "TemplateLiteral" &&
            Array.isArray(source.expressions) &&
            source.expressions.length === 0
          ) {
            const quasis = source.quasis as Array<{ value?: { cooked?: string; raw?: string } }> | undefined;
            staticSpecifier = quasis?.[0]?.value?.cooked ?? quasis?.[0]?.value?.raw ?? null;
          }

          if (hasViteIgnore || staticSpecifier === null) {
            this.error(
              `[Security / Architecture Boundary Violation] Dynamic or @vite-ignore import "${raw}" in client module "${id}" is prohibited because it bypasses static client-server boundary verification. Use static literal imports for client code-splitting or Hono RPC client (src/client/rpc-client.ts) for server communication.`
            );
          }

          if (isNodeBuiltin(staticSpecifier)) {
            this.error(
              `[Security / Architecture Boundary Violation] Direct client import of Node.js built-in module "${staticSpecifier}" from "${id}" is prohibited in client-side code.`
            );
          }

          if (isServerOnlySpecifier(staticSpecifier)) {
            this.error(
              `[Security / Architecture Boundary Violation] Direct client import of server module "${staticSpecifier}" from "${id}" is prohibited. Use Hono RPC client (src/client/rpc-client.ts) or extract shared types into src/types/rpc-contracts.ts.`
            );
          }

          const resolvedSpecifier = resolveTargetToCanonicalPosix(
            stripFsPrefix(toPosixSlashes(stripQueryAndHash(staticSpecifier))),
            modulePosix,
            anchors
          );
          if (
            resolvedSpecifier !== null &&
            !resolvedSpecifier.includes("/node_modules/") &&
            isServerModulePath(resolvedSpecifier, anchors)
          ) {
            this.error(
              `[Security / Architecture Boundary Violation] Direct client import of server module "${staticSpecifier}" from "${id}" is prohibited. Use Hono RPC client (src/client/rpc-client.ts) or extract shared types into src/types/rpc-contracts.ts.`
            );
          }
        }

        // 2. Detect require("...") call expressions in client-side modules
        if (
          node.type === "CallExpression" &&
          node.callee &&
          (node.callee as Record<string, unknown>).type === "Identifier" &&
          (node.callee as Record<string, unknown>).name === "require"
        ) {
          const args = (node.arguments as Array<Record<string, unknown>>) || [];
          const start = typeof node.start === "number" ? node.start : 0;
          const end = typeof node.end === "number" ? node.end : jsToScan.length;
          const raw = jsToScan.slice(start, end).trim();

          if (args.length === 0) {
            this.error(
              `[Security / Architecture Boundary Violation] Dynamic or @vite-ignore import "${raw}" in client module "${id}" is prohibited because it bypasses static client-server boundary verification. Use static literal imports for client code-splitting or Hono RPC client (src/client/rpc-client.ts) for server communication.`
            );
          }

          const firstArg = args[0];
          if (!firstArg || firstArg.type !== "Literal" || typeof firstArg.value !== "string") {
            this.error(
              `[Security / Architecture Boundary Violation] Dynamic or @vite-ignore import "${raw}" in client module "${id}" is prohibited because it bypasses static client-server boundary verification. Use static literal imports for client code-splitting or Hono RPC client (src/client/rpc-client.ts) for server communication.`
            );
          }

          const targetSpecifier = firstArg.value as string;
          if (isNodeBuiltin(targetSpecifier)) {
            this.error(
              `[Security / Architecture Boundary Violation] Direct client import of Node.js built-in module "${targetSpecifier}" from "${id}" is prohibited in client-side code.`
            );
          }

          if (isServerOnlySpecifier(targetSpecifier)) {
            this.error(
              `[Security / Architecture Boundary Violation] Direct client import of server module "${targetSpecifier}" from "${id}" is prohibited. Use Hono RPC client (src/client/rpc-client.ts) or extract shared types into src/types/rpc-contracts.ts.`
            );
          }

          const resolvedReq = resolveTargetToCanonicalPosix(
            stripFsPrefix(toPosixSlashes(stripQueryAndHash(targetSpecifier))),
            modulePosix,
            anchors
          );
          if (
            resolvedReq !== null &&
            !resolvedReq.includes("/node_modules/") &&
            isServerModulePath(resolvedReq, anchors)
          ) {
            this.error(
              `[Security / Architecture Boundary Violation] Direct client import of server module "${targetSpecifier}" from "${id}" is prohibited. Use Hono RPC client (src/client/rpc-client.ts) or extract shared types into src/types/rpc-contracts.ts.`
            );
          }
        }
      });

      return null;
    },
  };
}

export default defineConfig(({ mode }) => {
  // Never overwrite process.env if Vitest invokes vite.config.ts directly.
  // In Vite serve/build, scope process.env stubbing to client/optimizeDeps only
  // so elixentHonoDevServerPlugin()'s ssrLoadModule retains real server env vars.
  const isVitest = Boolean(process.env.VITEST) || mode === "test";

  return {
    esbuild: {
      target: "esnext",
    },
    optimizeDeps: {
      esbuildOptions: {
        target: "esnext",
        ...(isVitest
          ? {}
          : {
              define: {
                "process.env": "{}",
                "process.env.NODE_ENV": JSON.stringify(
                  process.env.NODE_ENV || mode
                ),
              },
            }),
      },
    },
    environments: {
      client: isVitest
        ? {}
        : {
            define: {
              "process.env": {},
            },
          },
    },
    plugins: [
      clientServerBoundaryGuardPlugin(),
      react(),
      elixentHonoDevServerPlugin(),
    ],
    resolve: {
      alias: {
        "@": path.resolve(rootDir, "./src"),
      },
    },
    envPrefix: ["VITE_"],
    worker: {
      format: "es",
    },
    build: {
      target: "esnext",
      outDir: "dist/client",
      emptyOutDir: true,
    },
  };
});
