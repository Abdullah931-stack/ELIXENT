/**
 * Unit & Contract Test Suite: Vite Client-Server Boundary Guard Plugin & Bundler Hygiene (Wave 1.2)
 *
 * Verifies:
 * 1. Bundler Config Hygiene:
 *    - `vite.config.ts` does NOT define `process.env` (removal of legacy Next.js `define: { "process.env": "{}" }`).
 *    - `client-server-boundary-guard` plugin is registered with `enforce: "pre"`.
 * 2. SSR Bypass (`options.ssr = true`):
 *    - Direct client/server specifiers bypass boundary guard during SSR compilation.
 * 3. Null / Undefined Specifier & Importer Resilience:
 *    - Gracefully returns `null` without throwing when `id` or `importer` is missing or empty.
 * 4. Virtual Module Exclusion:
 *    - `\0` rollup virtual modules and `virtual:*` specifiers are excluded.
 * 5. node_modules Invariant Bypass:
 *    - Third-party packages in `node_modules` (both importer and target id) are excluded.
 * 6. Server Plane Bypass (`/src/server/` Importer):
 *    - Server modules importing other server modules or server Supabase client pass freely.
 * 7. Relative Path Resolution (`./`, `../`):
 *    - Mathematical resolution from client files into `/src/server/` or `/src/lib/supabase/server` triggers violation.
 *    - Legitimate intra-client relative paths pass freely.
 * 8. Exact Fail-Closed Assertions:
 *    - Blocks `@/server`, `@/server/*`, `@/lib/supabase/server`, `@/lib/supabase/server/*`,
 *      `/src/server/*`, `/src/server`, and `/src/lib/supabase/server`.
 * 9. Error Generation & Context Contract:
 *    - Invokes `this.error` with authoritative architectural violation message and importer context.
 * 10. Legitimate Client & Shared Specifier Invariance:
 *    - Allows `@/client/*`, `@/types/rpc-contracts`, `@/lib/supabase/client`, and third-party imports.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Plugin, UserConfig } from "vite";
import viteConfig from "../../../vite.config";

type BoundaryGuardContext = {
  error: (msg: string, ...args: unknown[]) => void;
};

type PluginWithResolveId = Plugin & {
  resolveId: (
    this: BoundaryGuardContext,
    id: string | undefined | null,
    importer: string | undefined | null,
    options?: { ssr?: boolean }
  ) => Promise<unknown> | unknown;
};

describe("Vite Bundler Config & clientServerBoundaryGuardPlugin() (Wave 1.2)", () => {
  let resolvedConfig: UserConfig;
  let boundaryPlugin: PluginWithResolveId;
  let mockError: ReturnType<typeof vi.fn> & ((msg: string, ...args: unknown[]) => void);
  let mockContext: BoundaryGuardContext;

  beforeEach(async () => {
    // Resolve vite configuration (supports sync object or async factory)
    resolvedConfig =
      typeof viteConfig === "function"
        ? await (viteConfig as (...args: unknown[]) => Promise<UserConfig> | UserConfig)({
            command: "build",
            mode: "production",
          })
        : await viteConfig;

    const plugins = (resolvedConfig.plugins ?? []).flat();
    const found = plugins.find(
      (p): p is PluginWithResolveId =>
        p !== null &&
        typeof p === "object" &&
        "name" in p &&
        p.name === "client-server-boundary-guard"
    );

    if (!found) {
      throw new Error(
        "Expected 'client-server-boundary-guard' plugin to be registered in vite.config.ts"
      );
    }

    boundaryPlugin = found;
    mockError = vi.fn((msg: string) => {
      throw new Error(msg);
    }) as unknown as ReturnType<typeof vi.fn> & ((msg: string, ...args: unknown[]) => void);
    mockContext = {
      error: mockError,
    };
  });

  // -------------------------------------------------------------------------
  // 1. Bundler Config Hygiene (Removal of define: process.env)
  // -------------------------------------------------------------------------
  describe("1. Bundler Config Hygiene & Plugin Registration", () => {
    it("strictly removes define['process.env'] to allow native Vite definePlugin handling", () => {
      const defineMap = (resolvedConfig as { define?: Record<string, unknown> }).define;
      expect(defineMap?.["process.env"]).toBeUndefined();
    });

    it("registers boundary guard with enforce: 'pre' to intercept imports before resolution", () => {
      expect(boundaryPlugin.name).toBe("client-server-boundary-guard");
      expect(boundaryPlugin.enforce).toBe("pre");
      expect(typeof boundaryPlugin.resolveId).toBe("function");
    });

    it("configures standard @ alias pointing to rootDir/src", () => {
      const aliases = resolvedConfig.resolve?.alias;
      expect(aliases).toBeDefined();
      const atAlias = Array.isArray(aliases)
        ? aliases.find((a) => a.find === "@")?.replacement
        : (aliases as Record<string, string>)?.["@"];
      expect(atAlias).toBeDefined();
      expect(atAlias?.replace(/\\/g, "/")).toMatch(/\/src$/);
    });
  });

  // -------------------------------------------------------------------------
  // 2. SSR Bypass
  // -------------------------------------------------------------------------
  describe("2. SSR Mode Bypass (options.ssr = true)", () => {
    it.each([
      ["@/server", "D:/Projects/ELIXENT/src/client/App.tsx"],
      ["@/server/routes/agent.routes", "D:/Projects/ELIXENT/src/client/main.tsx"],
      ["@/lib/supabase/server", "D:/Projects/ELIXENT/src/client/routes/workspace.tsx"],
      ["../../server/app", "D:/Projects/ELIXENT/src/client/components/Dashboard.tsx"],
      ["/src/server/index", "D:/Projects/ELIXENT/src/client/App.tsx"],
    ])("bypasses boundary guard when options.ssr is true for %s", (id, importer) => {
      const result = boundaryPlugin.resolveId.call(mockContext, id, importer, { ssr: true });
      expect(result).toBeNull();
      expect(mockError).not.toHaveBeenCalled();
    });

    it("enforces boundary guard when options.ssr is false", () => {
      expect(() => {
        boundaryPlugin.resolveId.call(
          mockContext,
          "@/server",
          "D:/Projects/ELIXENT/src/client/App.tsx",
          { ssr: false }
        );
      }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);
      expect(mockError).toHaveBeenCalledTimes(1);
    });

    it("enforces boundary guard when options is undefined", () => {
      expect(() => {
        boundaryPlugin.resolveId.call(
          mockContext,
          "@/server",
          "D:/Projects/ELIXENT/src/client/App.tsx",
          undefined
        );
      }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);
      expect(mockError).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Null / Undefined Specifier & Importer Resilience
  // -------------------------------------------------------------------------
  describe("3. Null & Undefined Resilience", () => {
    it.each([
      [undefined, "D:/Projects/ELIXENT/src/client/App.tsx", "undefined id"],
      [null, "D:/Projects/ELIXENT/src/client/App.tsx", "null id"],
      ["", "D:/Projects/ELIXENT/src/client/App.tsx", "empty string id"],
      ["@/server", undefined, "undefined importer"],
      ["@/server", null, "null importer"],
      ["@/server", "", "empty string importer"],
      [undefined, undefined, "both undefined"],
      [null, null, "both null"],
      ["", "", "both empty"],
    ])("returns null safely without error when %s (%s)", (id, importer, _label) => {
      const result = boundaryPlugin.resolveId.call(mockContext, id, importer);
      expect(result).toBeNull();
      expect(mockError).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Virtual Module Exclusion
  // -------------------------------------------------------------------------
  describe("4. Virtual Module Exclusion", () => {
    it.each([
      ["\0virtual:vite/module", "D:/Projects/ELIXENT/src/client/App.tsx"],
      ["\0@/server", "D:/Projects/ELIXENT/src/client/App.tsx"],
      ["\0/src/server/app", "D:/Projects/ELIXENT/src/client/App.tsx"],
      ["virtual:pwa-register", "D:/Projects/ELIXENT/src/client/main.tsx"],
      ["virtual:icons/@/server", "D:/Projects/ELIXENT/src/client/main.tsx"],
    ])("excludes virtual specifier %s without error", (id, importer) => {
      const result = boundaryPlugin.resolveId.call(mockContext, id, importer);
      expect(result).toBeNull();
      expect(mockError).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 5. node_modules Invariant Bypass
  // -------------------------------------------------------------------------
  describe("5. node_modules Invariant Bypass (Importer & Target)", () => {
    it.each([
      [
        "@/server",
        "D:/Projects/ELIXENT/node_modules/some-library/index.js",
        "POSIX node_modules importer",
      ],
      [
        "@/server",
        "D:\\Projects\\ELIXENT\\node_modules\\some-library\\index.js",
        "Windows backslash node_modules importer",
      ],
      [
        "@/lib/supabase/server",
        "/home/runner/work/elixent/elixent/node_modules/pkg/dist/index.mjs",
        "CI POSIX node_modules importer",
      ],
      [
        "../server/app",
        "D:/Projects/ELIXENT/node_modules/@tanstack/react-router/dist/index.js",
        "Relative import from node_modules",
      ],
    ])("bypasses when importer is in node_modules: %s (%s)", (id, importer) => {
      const result = boundaryPlugin.resolveId.call(mockContext, id, importer);
      expect(result).toBeNull();
      expect(mockError).not.toHaveBeenCalled();
    });

    it.each([
      [
        "D:/Projects/ELIXENT/node_modules/my-pkg/src/server.js",
        "D:/Projects/ELIXENT/src/client/App.tsx",
        "POSIX node_modules target id",
      ],
      [
        "D:\\Projects\\ELIXENT\\node_modules\\@supabase\\server\\index.js",
        "D:\\Projects\\ELIXENT\\src\\client\\App.tsx",
        "Windows backslash node_modules target id",
      ],
      [
        "/node_modules/some-pkg/server/index.js",
        "D:/Projects/ELIXENT/src/client/App.tsx",
        "Relative root node_modules target id",
      ],
    ])("bypasses when target id is in node_modules: %s (%s)", (id, importer) => {
      const result = boundaryPlugin.resolveId.call(mockContext, id, importer);
      expect(result).toBeNull();
      expect(mockError).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 6. Server Plane Bypass (/src/server/ Importer)
  // -------------------------------------------------------------------------
  describe("6. Server Plane Bypass (/src/server/ Importer)", () => {
    it.each([
      [
        "@/server/routes/agent.routes",
        "D:/Projects/ELIXENT/src/server/app.ts",
        "POSIX server importer to server alias",
      ],
      [
        "@/server/db/schema",
        "D:\\Projects\\ELIXENT\\src\\server\\actions\\files.ts",
        "Windows backslash server importer to server alias",
      ],
      [
        "@/lib/supabase/server",
        "D:/Projects/ELIXENT/src/server/routes/auth-callback.routes.ts",
        "Server importer to supabase/server",
      ],
      [
        "./routes/rpc.routes",
        "D:/Projects/ELIXENT/src/server/app.ts",
        "Intra-server relative import",
      ],
      [
        "../db/index",
        "D:/Projects/ELIXENT/src/server/routes/files-api.routes.ts",
        "Parent server relative import",
      ],
      [
        "/src/server/context/request-context",
        "D:/Projects/ELIXENT/src/server/middleware/session-middleware.ts",
        "Server importer to physical server path",
      ],
    ])("permits server imports from %s: %s (%s)", (id, importer) => {
      const result = boundaryPlugin.resolveId.call(mockContext, id, importer);
      expect(result).toBeNull();
      expect(mockError).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 7. Relative Path Resolution from Client into Server Plane
  // -------------------------------------------------------------------------
  describe("7. Relative Path Resolution from Client Plane", () => {
    it.each([
      [
        "../../server/app",
        "D:/Projects/ELIXENT/src/client/components/Dashboard.tsx",
        "Relative traversal ../../server/app from client component",
      ],
      [
        "../../../src/server/middleware/session-middleware",
        "D:/Projects/ELIXENT/src/client/routes/workspace.tsx",
        "Deep relative traversal into /src/server/",
      ],
      [
        "../supabase/server",
        "D:/Projects/ELIXENT/src/lib/sync/sync-coordinator.ts",
        "Relative traversal into /src/lib/supabase/server from sync library",
      ],
      [
        "..\\server\\index",
        "D:\\Projects\\ELIXENT\\src\\client\\main.tsx",
        "Windows backslash relative traversal into server plane",
      ],
      [
        "..\\..\\server\\index",
        "D:\\Projects\\ELIXENT\\src\\client\\components\\main.tsx",
        "Windows backslash deep relative traversal into server plane",
      ],
      [
        "./server/app",
        "D:/Projects/ELIXENT/src/app.tsx",
        "Relative import from root src/ into src/server/",
      ],
    ])("blocks client relative traversal: %s from %s (%s)", (id, importer) => {
      expect(() => {
        boundaryPlugin.resolveId.call(mockContext, id, importer);
      }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);

      expect(mockError).toHaveBeenCalledWith(
        `[Security / Architecture Boundary Violation] Direct client import of server module "${id}" from "${importer}" is prohibited. Use Hono RPC client (src/client/rpc-client.ts) or extract shared types into src/types/rpc-contracts.ts.`
      );
    });

    it.each([
      [
        "./components/Header",
        "D:/Projects/ELIXENT/src/client/App.tsx",
        "Client sibling component",
      ],
      [
        "../hooks/useAuth",
        "D:/Projects/ELIXENT/src/client/routes/workspace.tsx",
        "Client parent hook",
      ],
      [
        "./sync-coordinator",
        "D:/Projects/ELIXENT/src/lib/sync/use-sync.ts",
        "Library intra-directory relative import",
      ],
      [
        "../types/rpc-contracts",
        "D:/Projects/ELIXENT/src/client/rpc-client.ts",
        "Client relative import of shared types",
      ],
    ])("allows legitimate client relative imports: %s from %s (%s)", (id, importer) => {
      const result = boundaryPlugin.resolveId.call(mockContext, id, importer);
      expect(result).toBeNull();
      expect(mockError).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 8. Fail-Closed Server Specifier Assertions
  // -------------------------------------------------------------------------
  describe("8. Fail-Closed Assertions for Server Aliases and Physical Paths", () => {
    const clientImporter = "D:/Projects/ELIXENT/src/client/routes/workspace.tsx";

    it.each([
      ["@/server", "Exact server root alias"],
      ["@/server/", "Server root alias with trailing slash"],
      ["@/server/index", "Server index alias"],
      ["@/server/app", "Server app entry alias"],
      ["@/server/routes/agent.routes", "Server agent route alias"],
      ["@/server/actions/files", "Server actions alias"],
      ["@/server/db/schema", "Server db schema alias"],
      ["@/lib/supabase/server", "Exact supabase/server alias"],
      ["@/lib/supabase/server.ts", "Supabase/server.ts file alias"],
      ["@/lib/supabase/server/client", "Supabase/server/ sub-module alias"],
      ["/src/server", "POSIX physical /src/server path"],
      ["/src/server/", "POSIX physical /src/server/ path with trailing slash"],
      ["/src/server/app.ts", "POSIX physical /src/server/app.ts"],
      ["/src/lib/supabase/server", "POSIX physical /src/lib/supabase/server"],
      ["/src/lib/supabase/server.ts", "POSIX physical /src/lib/supabase/server.ts"],
      ["D:/Projects/ELIXENT/src/server/index.ts", "Absolute POSIX server module path"],
      ["D:\\Projects\\ELIXENT\\src\\server\\app.ts", "Absolute Windows server module path"],
      ["D:\\Projects\\ELIXENT\\src\\lib\\supabase\\server.ts", "Absolute Windows supabase/server path"],
    ])("strictly blocks direct client import of %s (%s)", (id, _label) => {
      mockError.mockClear();

      expect(() => {
        boundaryPlugin.resolveId.call(mockContext, id, clientImporter);
      }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);

      expect(mockError).toHaveBeenCalledTimes(1);
      expect(mockError).toHaveBeenCalledWith(
        `[Security / Architecture Boundary Violation] Direct client import of server module "${id}" from "${clientImporter}" is prohibited. Use Hono RPC client (src/client/rpc-client.ts) or extract shared types into src/types/rpc-contracts.ts.`
      );
    });
  });

  // -------------------------------------------------------------------------
  // 9. Error Generation & Context Contract
  // -------------------------------------------------------------------------
  describe("9. Error Generation & Context Contract", () => {
    it("calls this.error with exact boundary violation phrasing and caller details", () => {
      const id = "@/server/routes/rpc.routes";
      const importer = "D:/Projects/ELIXENT/src/client/main.tsx";

      try {
        boundaryPlugin.resolveId.call(mockContext, id, importer);
      } catch {
        // Expected throw from mockError
      }

      expect(mockError).toHaveBeenCalledTimes(1);
      const callArg = mockError.mock.calls[0][0];
      expect(callArg).toContain("[Security / Architecture Boundary Violation]");
      expect(callArg).toContain(`Direct client import of server module "${id}"`);
      expect(callArg).toContain(`from "${importer}" is prohibited`);
      expect(callArg).toContain("Use Hono RPC client (src/client/rpc-client.ts)");
      expect(callArg).toContain("extract shared types into src/types/rpc-contracts.ts");
    });

    it("does not catch or swallow errors thrown by this.error", () => {
      const customRollupError = new Error("Custom Rollup Build Error");
      const customContext: BoundaryGuardContext = {
        error: () => {
          throw customRollupError;
        },
      };

      expect(() => {
        boundaryPlugin.resolveId.call(
          customContext,
          "@/server",
          "D:/Projects/ELIXENT/src/client/App.tsx"
        );
      }).toThrow(customRollupError);
    });
  });

  // -------------------------------------------------------------------------
  // 10. Legitimate Client & Shared Specifier Invariance
  // -------------------------------------------------------------------------
  describe("10. Legitimate Client & Shared Specifier Invariance", () => {
    const clientImporter = "D:/Projects/ELIXENT/src/client/App.tsx";

    it.each([
      ["@/client/rpc-client", "Hono RPC client wrapper"],
      ["@/client/routes/workspace", "TanStack Router route component"],
      ["@/types/rpc-contracts", "Shared RPC contracts and Zod types"],
      ["@/lib/supabase/client", "Browser-side Supabase client"],
      ["@/lib/sync/indexeddb", "Client-side IndexedDB manager"],
      ["@/lib/vault/vault-crypto", "Client WebCrypto vault engine"],
      ["react", "Third-party framework package"],
      ["react-dom/client", "Third-party DOM renderer"],
      ["@tanstack/react-router", "Third-party router package"],
      ["hono/client", "Third-party Hono RPC client library"],
      ["lucide-react", "Third-party icon set"],
      ["clsx", "Utility library"],
    ])("allows legitimate client specifier %s (%s)", (id, _label) => {
      const result = boundaryPlugin.resolveId.call(mockContext, id, clientImporter);
      expect(result).toBeNull();
      expect(mockError).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 11. Stress & Adversarial Boundary Scenarios
  // -------------------------------------------------------------------------
  describe("11. Adversarial & Edge Case Invariants", () => {
    const clientImporter = "D:/Projects/ELIXENT/src/client/views/Settings.tsx";

    it("does not false-positive on similarly named non-server folders (e.g. server-fake)", () => {
      const id = "D:/Projects/ELIXENT/src/server-fake/index.ts";
      const result = boundaryPlugin.resolveId.call(mockContext, id, clientImporter);
      expect(result).toBeNull();
      expect(mockError).not.toHaveBeenCalled();
    });

    it("does not false-positive on client files containing server in their filename", () => {
      const id = "@/client/server-status-widget.tsx";
      const result = boundaryPlugin.resolveId.call(mockContext, id, clientImporter);
      expect(result).toBeNull();
      expect(mockError).not.toHaveBeenCalled();
    });

    it("blocks redundant slash attempts in relative traversals (e.g. ..//..//server//app)", () => {
      const id = "..//..//server//app";
      expect(() => {
        boundaryPlugin.resolveId.call(mockContext, id, clientImporter);
      }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);
      expect(mockError).toHaveBeenCalledTimes(1);
    });

    it("blocks complex path traversal escaping client dir back into server dir", () => {
      // From src/client/views/Settings.tsx, traverse ../../server/app.ts
      const id = "../../../src/server/app.ts";
      expect(() => {
        boundaryPlugin.resolveId.call(mockContext, id, clientImporter);
      }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);
      expect(mockError).toHaveBeenCalledTimes(1);
    });

    it("strictly blocks supabase server even if targeted without extension", () => {
      const id = "@/lib/supabase/server";
      expect(() => {
        boundaryPlugin.resolveId.call(mockContext, id, clientImporter);
      }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);
      expect(mockError).toHaveBeenCalledTimes(1);
    });

    it("strictly allows supabase client without confusion with server", () => {
      const id = "@/lib/supabase/client";
      const result = boundaryPlugin.resolveId.call(mockContext, id, clientImporter);
      expect(result).toBeNull();
      expect(mockError).not.toHaveBeenCalled();
    });
  });
});
