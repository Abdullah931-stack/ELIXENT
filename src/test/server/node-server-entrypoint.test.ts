/**
 * Exhaustive Integration & Contract Test Suite: Node Server Entrypoint & SPA Fallback
 * (`src/test/server/node-server-entrypoint.test.ts`)
 *
 * Verifies:
 * 1. Server Module Exports:
 *    - Exports Hono app instance and sessionMiddleware.
 * 2. 'server-only' Resolution Hook:
 *    - Resolves 'server-only' to 'src/server/empty.ts' in Node runtime.
 * 3. SPA Route Fallback & Static Distribution Handling:
 *    - Returns 404 with helpful instructions when dist/client/index.html does not exist.
 *    - Returns 200 with HTML content when dist/client/index.html exists.
 * 4. API & OAuth Route Passthrough:
 *    - Confirms API subroutes (such as /api/files/sync) execute their own router handlers
 *      rather than falling through to the SPA static wildcard.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import Module from "node:module";

// Import the server module under test
import { app, sessionMiddleware } from "@/server/index";

describe("Node Server Entrypoint (src/server/index.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("1. Server Exports & Configuration", () => {
    it("exports initialized Hono app and sessionMiddleware", () => {
      expect(app).toBeDefined();
      expect(typeof app.fetch).toBe("function");
      expect(typeof sessionMiddleware).toBe("function");
    });

    it("hooks 'server-only' resolution to src/server/empty.ts", () => {
      const modAny = Module as unknown as {
        _resolveFilename: (request: string, parent: unknown) => string;
      };

      const resolved = modAny._resolveFilename("server-only", null);
      expect(resolved).toContain("empty.ts");
    });
  });

  describe("2. SPA Catch-All Route Fallback", () => {
    it("returns 404 with diagnostic message when dist/client/index.html does not exist on public SPA route", async () => {
      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        if (typeof p === "string" && p.includes("index.html")) {
          return false;
        }
        return false;
      });

      const res = await app.fetch(
        new Request("http://localhost:3000/terms")
      );

      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).toContain("LUGX SPA client build not found");
      expect(text).toContain("vite build");
    });

    it("returns 200 HTML content when dist/client/index.html exists on public SPA route", async () => {
      const mockHtml = "<!DOCTYPE html><html><body><div id='root'>SPA Root</div></body></html>";

      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        if (typeof p === "string" && p.includes("index.html")) {
          return true;
        }
        return false;
      });

      vi.spyOn(fs, "readFileSync").mockImplementation((p) => {
        if (typeof p === "string" && p.includes("index.html")) {
          return mockHtml;
        }
        return "";
      });

      const res = await app.fetch(
        new Request("http://localhost:3000/privacy")
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const text = await res.text();
      expect(text).toBe(mockHtml);
    });
  });

  describe("3. Preserves Non-SPA API Subroutes", () => {
    it("dispatches /api/files/sync route requests to API handler (yielding 401 unauthenticated)", async () => {
      const res = await app.fetch(
        new Request("http://localhost:3000/api/files/sync")
      );

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe("Authentication required");
    });
  });
});
