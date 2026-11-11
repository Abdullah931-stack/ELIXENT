import { vi } from "vitest";
import { loadTestEnv } from "./src/test/load-test-env";

// Phase 10 (Neon Branch isolation): load the isolated test-branch environment
// BEFORE any test module — and its database pool — is imported.
// Priority: shell TEST_DATABASE_URL > .env.test.local > .env.test > .env.local > .env
// Then DATABASE_URL is hard-bound to TEST_DATABASE_URL (fail-closed binding).
loadTestEnv();

const initialGlobalFetch = globalThis.fetch;

/**
 * In-memory loopback fetch transport delegating directly to Hono app.fetch during Vitest runs.
 * Lazily imports `@/server/app` on request so test files' hoisted `vi.mock(...)` declarations
 * run first and non-RPC unit tests incur zero server import overhead.
 */
export const vitestLoopbackFetch: typeof fetch = async (
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> => {
  // Respect explicit unit-test stubs/mocks on globalThis.fetch (e.g., vi.stubGlobal('fetch', ...)
  // or global.fetch = mockFetch) so non-loopback unit tests for AI streaming and sync are not hijacked.
  if (
    typeof globalThis.fetch === "function" &&
    globalThis.fetch !== initialGlobalFetch &&
    globalThis.fetch !== vitestLoopbackFetch
  ) {
    return globalThis.fetch(input, init);
  }

  const { app } = await import("@/server/app");
  if (input instanceof Request) {
    const req = init ? new Request(input, init) : input;
    return app.fetch(req);
  }
  const urlStr = input instanceof URL ? input.toString() : input;
  const absoluteUrl = /^https?:\/\//i.test(urlStr)
    ? urlStr
    : `http://localhost${urlStr.startsWith("/") ? "" : "/"}${urlStr}`;
  const req = new Request(absoluteUrl, init);
  return app.fetch(req);
};

// Use vi.importActual so test files that mock `@/client/rpc-client` without
// exporting `setRpcClientFetch` still initialize cleanly.
const rpcMod = await vi.importActual<typeof import("@/client/rpc-client")>(
  "@/client/rpc-client"
);
rpcMod.setRpcClientFetch(vitestLoopbackFetch);

// Global JSDOM polyfills for CodeMirror 6 DOM measurements
if (typeof Range !== "undefined") {
    if (typeof Range.prototype.getClientRects !== "function") {
        Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    }
    if (typeof Range.prototype.getBoundingClientRect !== "function") {
        Range.prototype.getBoundingClientRect = () => ({
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            width: 0,
            height: 0,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        });
    }
}
