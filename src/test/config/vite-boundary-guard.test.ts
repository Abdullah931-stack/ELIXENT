/**
 * Unit & Contract Test Suite: Vite Client-Server Boundary Guard Plugin & Bundler Hygiene (DEF-A02)
 *
 * Verifies:
 * 1. Bundler Config Hygiene & Client Env Protection:
 *    - `environments.client.define["process.env"]` is `{}` and `optimizeDeps.esbuildOptions.define["process.env"]`
 *      is `"{}"` (with `NODE_ENV` preserved) during Vite serve/build so browser code never crashes on `process.env`.
 *    - Top-level `define` and `environments.ssr.define` do NOT strip `process.env`, preserving Hono dev SSR middleware.
 *    - Vitest runs (`process.env.VITEST` truthy or `mode === "test"`) omit client `process.env` replacement completely.
 *    - `client-server-boundary-guard` plugin is registered with `enforce: "pre"`, `resolveId`, `transform`, and `configResolved`.
 * 2. SSR Bypass (`options.ssr = true`):
 *    - Direct client/server specifiers bypass boundary guard during SSR compilation.
 * 3. Null / Undefined Specifier & Importer Resilience:
 *    - Gracefully returns `null` without throwing when `id` or `importer` is missing or empty.
 * 4. Virtual Module Exclusion:
 *    - `\0` Rollup virtual modules and `virtual:*` specifiers are excluded.
 * 5. `node_modules` Invariant Bypass:
 *    - Third-party packages in `node_modules` (both importer and resolved target id) are excluded,
 *      while traversal through fake `node_modules` segments into `src/server` is still blocked.
 * 6. Server Plane Bypass (Anchored `/src/server/` & `/src/lib/supabase/server` Importer):
 *    - Server modules importing other server modules or server Supabase client pass freely.
 * 7. Relative Path Resolution (`./`, `../`):
 *    - Canonical resolution from client files into `/src/server/` or `/src/lib/supabase/server` triggers violation.
 *    - Legitimate intra-client relative paths pass freely.
 * 8. Exact Fail-Closed Assertions & Error Contract.
 * 9. Legitimate Client & Shared Specifier Invariance + Adversarial Edge Cases.
 * 10. All 5 Forensic Audit Bypass Vectors (`DEF-A02`):
 *    - Alias traversal (`@/client/../server/app`, `@/lib/supabase/../supabase/server`)
 *    - Case-insensitivity (`@/Server/app`, `@/lib/Supabase/server`, `../../Server/app`, `/SRC/Server/app`)
 *    - Query & hash parameters (`@/server?raw`, `@/server/app#hash`, `@/lib/supabase/server?url`, HMR `?t=` importers)
 *    - Repo cloned under an ancestor containing `/src/server/` (`/ci/src/server/ELIXENT/src/client/test.ts`)
 *    - Non-literal dynamic expression & `@vite-ignore` imports (`transform` hook protection)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { Plugin, ResolvedConfig, UserConfig } from "vite";
import viteConfig from "../../../vite.config";

const PROJECT_ROOT_POSIX = path.resolve(__dirname, "../../..").replace(/\\/g, "/");
const PROJECT_ROOT_WIN = PROJECT_ROOT_POSIX.replace(/\//g, "\\");

type BoundaryGuardContext = {
  error: (msg: string, ...args: unknown[]) => void;
};

type PluginWithBoundaryHooks = Plugin & {
  configResolved?: (config: Pick<ResolvedConfig, "root">) => void;
  resolveId: (
    this: BoundaryGuardContext,
    id: string | undefined | null,
    importer: string | undefined | null,
    options?: { ssr?: boolean }
  ) => Promise<unknown> | unknown;
  load: (
    this: BoundaryGuardContext,
    id: string,
    options?: { ssr?: boolean }
  ) => Promise<unknown> | unknown;
  transform: (
    this: BoundaryGuardContext,
    code: string,
    id: string,
    options?: { ssr?: boolean }
  ) => Promise<unknown> | unknown;
};

type ConfigWithEnvironments = UserConfig & {
  environments?: Record<string, { define?: Record<string, unknown> }>;
};

async function resolveViteConfigWithEnv(
  env: { command: "build" | "serve"; mode: string },
  vitestOverride: string | undefined
): Promise<ConfigWithEnvironments> {
  const prevVitest = process.env.VITEST;
  try {
    if (vitestOverride === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = vitestOverride;
    }

    const cfg =
      typeof viteConfig === "function"
        ? await (viteConfig as (...args: unknown[]) => Promise<UserConfig> | UserConfig)(env)
        : await viteConfig;

    return cfg as ConfigWithEnvironments;
  } finally {
    if (prevVitest === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = prevVitest;
    }
  }
}

describe("Vite Bundler Config & clientServerBoundaryGuardPlugin() (DEF-A02)", () => {
  let resolvedConfig: ConfigWithEnvironments;
  let boundaryPlugin: PluginWithBoundaryHooks;
  let mockError: ReturnType<typeof vi.fn> & ((msg: string, ...args: unknown[]) => void);
  let mockContext: BoundaryGuardContext;

  beforeEach(async () => {
    resolvedConfig = await resolveViteConfigWithEnv(
      { command: "build", mode: "production" },
      process.env.VITEST
    );

    const plugins = (resolvedConfig.plugins ?? []).flat();
    const found = plugins.find(
      (p): p is PluginWithBoundaryHooks =>
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
  // 1. Bundler Config Hygiene, Env Define Protection & Plugin Registration
  // -------------------------------------------------------------------------
  describe("1. Bundler Config Hygiene, process.env Define & Plugin Registration", () => {
    it.each([
      [{ command: "serve" as const, mode: "development" }],
      [{ command: "build" as const, mode: "production" }],
    ])(
      "scopes process.env: {} to client & optimizeDeps without clobbering SSR during Vite $command ($mode)",
      async (env) => {
        const cfg = await resolveViteConfigWithEnv(env, undefined);

        // Client environment receives safe empty process.env object
        expect(cfg.environments?.client?.define?.["process.env"]).toEqual({});

        // Dep optimization pre-bundler defines process.env while preserving NODE_ENV
        expect(cfg.optimizeDeps?.esbuildOptions?.define?.["process.env"]).toBe("{}");
        expect(cfg.optimizeDeps?.esbuildOptions?.define?.["process.env.NODE_ENV"]).toBeDefined();

        // Top-level & SSR environment must NOT overwrite process.env (preserves elixentHonoDevServerPlugin ssrLoadModule)
        expect((cfg as { define?: Record<string, unknown> }).define?.["process.env"]).toBeUndefined();
        expect(cfg.environments?.ssr?.define?.["process.env"]).toBeUndefined();
      }
    );

    it("omits process.env define stubs inside Vitest (process.env.VITEST set or mode === 'test')", async () => {
      const vitestCfg = await resolveViteConfigWithEnv(
        { command: "serve", mode: "development" },
        "true"
      );
      expect(vitestCfg.environments?.client?.define?.["process.env"]).toBeUndefined();
      expect(vitestCfg.optimizeDeps?.esbuildOptions?.define?.["process.env"]).toBeUndefined();
      expect((vitestCfg as { define?: Record<string, unknown> }).define?.["process.env"]).toBeUndefined();

      const testModeCfg = await resolveViteConfigWithEnv(
        { command: "serve", mode: "test" },
        undefined
      );
      expect(testModeCfg.environments?.client?.define?.["process.env"]).toBeUndefined();
      expect(testModeCfg.optimizeDeps?.esbuildOptions?.define?.["process.env"]).toBeUndefined();

      // Confirm live Vitest process.env remains intact
      expect(process.env.VITEST).toBeTruthy();
    });

    it("registers boundary guard with enforce: 'pre', resolveId, transform, and configResolved", () => {
      expect(boundaryPlugin.name).toBe("client-server-boundary-guard");
      expect(boundaryPlugin.enforce).toBe("pre");
      expect(typeof boundaryPlugin.resolveId).toBe("function");
      expect(typeof boundaryPlugin.transform).toBe("function");
      expect(typeof boundaryPlugin.configResolved).toBe("function");
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
      ["@/server", `${PROJECT_ROOT_POSIX}/src/client/App.tsx`],
      ["@/server/routes/agent.routes", `${PROJECT_ROOT_POSIX}/src/client/main.tsx`],
      ["@/lib/supabase/server", `${PROJECT_ROOT_POSIX}/src/client/routes/workspace.tsx`],
      ["../../server/app", `${PROJECT_ROOT_POSIX}/src/client/components/Dashboard.tsx`],
      ["/src/server/index", `${PROJECT_ROOT_POSIX}/src/client/App.tsx`],
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
          `${PROJECT_ROOT_POSIX}/src/client/App.tsx`,
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
          `${PROJECT_ROOT_POSIX}/src/client/App.tsx`,
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
      [undefined, `${PROJECT_ROOT_POSIX}/src/client/App.tsx`, "undefined id"],
      [null, `${PROJECT_ROOT_POSIX}/src/client/App.tsx`, "null id"],
      ["", `${PROJECT_ROOT_POSIX}/src/client/App.tsx`, "empty string id"],
      ["@/server", undefined, "undefined importer"],
      ["@/server", null, "null importer"],
      ["@/server", "", "empty string importer"],
      ["?raw", `${PROJECT_ROOT_POSIX}/src/client/App.tsx`, "query-only empty id"],
      ["@/server", "?t=123", "query-only empty importer"],
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
      ["\0virtual:vite/module", `${PROJECT_ROOT_POSIX}/src/client/App.tsx`],
      ["\0@/server", `${PROJECT_ROOT_POSIX}/src/client/App.tsx`],
      ["\0/src/server/app", `${PROJECT_ROOT_POSIX}/src/client/App.tsx`],
      ["virtual:pwa-register", `${PROJECT_ROOT_POSIX}/src/client/main.tsx`],
      ["VIRTUAL:icons/@/server", `${PROJECT_ROOT_POSIX}/src/client/main.tsx`],
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
        `${PROJECT_ROOT_POSIX}/node_modules/some-library/index.js`,
        "POSIX node_modules importer",
      ],
      [
        "@/server",
        `${PROJECT_ROOT_WIN}\\node_modules\\some-library\\index.js`,
        "Backslash node_modules importer",
      ],
      [
        "@/lib/supabase/server",
        "/home/runner/work/elixent/elixent/node_modules/pkg/dist/index.mjs",
        "CI POSIX node_modules importer",
      ],
      [
        "../server/app",
        `${PROJECT_ROOT_POSIX}/node_modules/@tanstack/react-router/dist/index.js`,
        "Relative import from node_modules",
      ],
    ])("bypasses when importer is in node_modules: %s (%s)", (id, importer) => {
      const result = boundaryPlugin.resolveId.call(mockContext, id, importer);
      expect(result).toBeNull();
      expect(mockError).not.toHaveBeenCalled();
    });

    it.each([
      [
        `${PROJECT_ROOT_POSIX}/node_modules/my-pkg/src/server.js`,
        `${PROJECT_ROOT_POSIX}/src/client/App.tsx`,
        "POSIX node_modules target id",
      ],
      [
        `${PROJECT_ROOT_WIN}\\node_modules\\@supabase\\server\\index.js`,
        `${PROJECT_ROOT_WIN}\\src\\client\\App.tsx`,
        "Backslash node_modules target id",
      ],
      [
        "/node_modules/some-pkg/server/index.js",
        `${PROJECT_ROOT_POSIX}/src/client/App.tsx`,
        "Relative root node_modules target id",
      ],
    ])("bypasses when target id is in node_modules: %s (%s)", (id, importer) => {
      const result = boundaryPlugin.resolveId.call(mockContext, id, importer);
      expect(result).toBeNull();
      expect(mockError).not.toHaveBeenCalled();
    });

    it("still blocks relative traversal escaping through a fake node_modules segment into src/server", () => {
      expect(() => {
        boundaryPlugin.resolveId.call(
          mockContext,
          "./node_modules/../../server/app",
          `${PROJECT_ROOT_POSIX}/src/client/App.tsx`
        );
      }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);
      expect(mockError).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Server Plane Bypass (Anchored /src/server/ & /src/lib/supabase/server)
  // -------------------------------------------------------------------------
  describe("6. Server Plane Bypass (Anchored Server Importers)", () => {
    it.each([
      [
        "@/server/routes/agent.routes",
        `${PROJECT_ROOT_POSIX}/src/server/app.ts`,
        "POSIX server importer to server alias",
      ],
      [
        "@/server/db/schema",
        `${PROJECT_ROOT_WIN}\\src\\server\\actions\\files.ts`,
        "Backslash server importer to server alias",
      ],
      [
        "@/lib/supabase/server",
        `${PROJECT_ROOT_POSIX}/src/server/routes/auth-callback.routes.ts`,
        "Server importer to supabase/server",
      ],
      [
        "@/server/context/request-context",
        `${PROJECT_ROOT_POSIX}/src/lib/supabase/server.ts`,
        "Server-only supabase/server module importing server request-context",
      ],
      [
        "./routes/rpc.routes",
        `${PROJECT_ROOT_POSIX}/src/server/app.ts`,
        "Intra-server relative import",
      ],
      [
        "../db/index",
        `${PROJECT_ROOT_POSIX}/src/server/routes/files-api.routes.ts`,
        "Parent server relative import",
      ],
      [
        "/src/server/context/request-context",
        `${PROJECT_ROOT_POSIX}/src/server/middleware/session-middleware.ts`,
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
        `${PROJECT_ROOT_POSIX}/src/client/components/Dashboard.tsx`,
        "Relative traversal ../../server/app from client component",
      ],
      [
        "../../../src/server/middleware/session-middleware",
        `${PROJECT_ROOT_POSIX}/src/client/routes/workspace.tsx`,
        "Deep relative traversal into /src/server/",
      ],
      [
        "../supabase/server",
        `${PROJECT_ROOT_POSIX}/src/lib/sync/sync-coordinator.ts`,
        "Relative traversal into /src/lib/supabase/server from sync library",
      ],
      [
        "..\\server\\index",
        `${PROJECT_ROOT_WIN}\\src\\client\\main.tsx`,
        "Backslash relative traversal into server plane",
      ],
      [
        "..\\..\\server\\index",
        `${PROJECT_ROOT_WIN}\\src\\client\\components\\main.tsx`,
        "Backslash deep relative traversal into server plane",
      ],
      [
        "./server/app",
        `${PROJECT_ROOT_POSIX}/src/app.tsx`,
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
        `${PROJECT_ROOT_POSIX}/src/client/App.tsx`,
        "Client sibling component",
      ],
      [
        "../hooks/useAuth",
        `${PROJECT_ROOT_POSIX}/src/client/routes/workspace.tsx`,
        "Client parent hook",
      ],
      [
        "./sync-coordinator",
        `${PROJECT_ROOT_POSIX}/src/lib/sync/use-sync.ts`,
        "Library intra-directory relative import",
      ],
      [
        "../types/rpc-contracts",
        `${PROJECT_ROOT_POSIX}/src/client/rpc-client.ts`,
        "Client relative import of shared types",
      ],
    ])("allows legitimate client relative imports: %s from %s (%s)", (id, importer) => {
      const result = boundaryPlugin.resolveId.call(mockContext, id, importer);
      expect(result).toBeNull();
      expect(mockError).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 8. Fail-Closed Server Specifier Assertions & Error Contract
  // -------------------------------------------------------------------------
  describe("8. Fail-Closed Assertions for Server Aliases, Physical Paths & Error Contract", () => {
    const clientImporter = `${PROJECT_ROOT_POSIX}/src/client/routes/workspace.tsx`;

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
      [`${PROJECT_ROOT_POSIX}/src/server/index.ts`, "Absolute POSIX server module path"],
      [`${PROJECT_ROOT_WIN}\\src\\server\\app.ts`, "Absolute backslash server module path"],
      [`${PROJECT_ROOT_WIN}\\src\\lib\\supabase\\server.ts`, "Absolute backslash supabase/server path"],
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
          `${PROJECT_ROOT_POSIX}/src/client/App.tsx`
        );
      }).toThrow(customRollupError);
    });
  });

  // -------------------------------------------------------------------------
  // 9. Legitimate Client Specifiers & Adversarial Non-False-Positives
  // -------------------------------------------------------------------------
  describe("9. Legitimate Client Specifier Invariance & Adversarial Edge Cases", () => {
    const clientImporter = `${PROJECT_ROOT_POSIX}/src/client/views/Settings.tsx`;

    it.each([
      ["@/client/rpc-client", "Hono RPC client wrapper"],
      ["@/client/routes/workspace", "TanStack Router route component"],
      ["@/types/rpc-contracts", "Shared RPC contracts and Zod types"],
      ["@/lib/supabase/client", "Browser-side Supabase client"],
      ["@/lib/supabase/server-helpers", "Hyphenated client helper sharing prefix"],
      ["@/lib/sync/indexeddb", "Client-side IndexedDB manager"],
      ["@/lib/vault/vault-crypto", "Client WebCrypto vault engine"],
      ["@/client/server-status-widget.tsx", "Client file containing server in filename"],
      [`${PROJECT_ROOT_POSIX}/src/server-fake/index.ts`, "Similarly named non-server folder"],
      ["react", "Third-party framework package"],
      ["react-dom/client", "Third-party DOM renderer"],
      ["@tanstack/react-router", "Third-party router package"],
      ["hono/client", "Third-party Hono RPC client library"],
      ["lucide-react", "Third-party icon set"],
      ["clsx", "Utility library"],
    ])("allows legitimate specifier %s (%s)", (id, _label) => {
      const result = boundaryPlugin.resolveId.call(mockContext, id, clientImporter);
      expect(result).toBeNull();
      expect(mockError).not.toHaveBeenCalled();
    });

    it("blocks redundant slash attempts in relative traversals (e.g. ..//..//server//app)", () => {
      expect(() => {
        boundaryPlugin.resolveId.call(mockContext, "..//..//server//app", clientImporter);
      }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);
      expect(mockError).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // 10. Bypass Vector 1: Alias Traversal & Unprefixed src/ Resolution
  // -------------------------------------------------------------------------
  describe("10. Audit Vector 1: Alias Traversal & Root-Relative Bypass Prevention", () => {
    const clientImporter = `${PROJECT_ROOT_POSIX}/src/client/App.tsx`;

    it.each([
      ["@/client/../server/app", "Single parent traversal inside @/ alias"],
      ["@/client/components/../../server/db", "Multi-segment traversal inside @/ alias"],
      ["@/./server/routes/rpc.routes", "Dot-segment alias path"],
      ["@/lib/supabase/../supabase/server", "Sibling traversal into @/lib/supabase/server"],
      ["@/lib/supabase/../../server/index", "Traversal from @/lib/supabase/ into @/server/"],
      ["/client/../src/server/app", "Root-relative traversal into src/server"],
      ["src/server/app", "Unprefixed src/server specifier"],
      ["src/client/../server/app", "Unprefixed src/ traversal specifier"],
    ])("blocks canonical alias/path traversal: %s (%s)", (id, _label) => {
      mockError.mockClear();
      expect(() => {
        boundaryPlugin.resolveId.call(mockContext, id, clientImporter);
      }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);
      expect(mockError).toHaveBeenCalledTimes(1);
    });

    it("allows canonicalized alias traversal staying strictly inside client/shared code", () => {
      const result = boundaryPlugin.resolveId.call(
        mockContext,
        "@/client/routes/../rpc-client",
        clientImporter
      );
      expect(result).toBeNull();
      expect(mockError).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 11. Bypass Vector 2: Windows / macOS Case-Insensitive Path Normalization
  // -------------------------------------------------------------------------
  describe("11. Audit Vector 2: Case-Insensitive Path & Alias Normalization", () => {
    const clientImporter = `${PROJECT_ROOT_POSIX}/src/Client/Routes/Workspace.tsx`;

    it.each([
      ["@/Server/app", "Mixed-case @/Server/app"],
      ["@/SERVER", "Uppercase @/SERVER"],
      ["@/SERVER/DB/SCHEMA", "Uppercase nested server module"],
      ["@/lib/Supabase/server", "Mixed-case @/lib/Supabase/server"],
      ["@/LIB/SUPABASE/SERVER.TS", "Uppercase @/LIB/SUPABASE/SERVER.TS"],
      ["@/Client/../Server/App", "Mixed-case alias traversal"],
      ["../../Server/app", "Mixed-case relative traversal"],
      ["../../../SRC/Server/middleware/session-middleware", "Mixed-case deep traversal"],
      ["/SRC/Server/app", "Mixed-case root-relative /SRC/Server/app"],
      ["/Src/Lib/Supabase/Server", "Mixed-case root-relative supabase/server"],
      ["SRC/SERVER/app", "Uppercase unprefixed SRC/SERVER/app"],
      [`${PROJECT_ROOT_POSIX}/SRC/SERVER/App.ts`, "Uppercase absolute path"],
    ])("blocks case-variant server import: %s (%s)", (id, _label) => {
      mockError.mockClear();
      expect(() => {
        boundaryPlugin.resolveId.call(mockContext, id, clientImporter);
      }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);
      expect(mockError).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["@/Server/db", `${PROJECT_ROOT_POSIX}/SRC/SERVER/App.ts`],
      ["@/server/context/request-context", `${PROJECT_ROOT_POSIX}/SRC/Lib/Supabase/Server.ts`],
    ])("allows case-variant legitimate server importer %s from %s", (id, importer) => {
      const result = boundaryPlugin.resolveId.call(mockContext, id, importer);
      expect(result).toBeNull();
      expect(mockError).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 12. Bypass Vector 3: Query/Hash Stripping, HMR Importers & /@fs/ Prefix
  // -------------------------------------------------------------------------
  describe("12. Audit Vector 3: Query, Hash, HMR Importer & /@fs/ Prefix Evasion", () => {
    const clientImporter = `${PROJECT_ROOT_POSIX}/src/client/App.tsx`;

    it.each([
      ["@/server?raw", "Query ?raw on server root"],
      ["@/server?url", "Query ?url on server root"],
      ["@/server#hash", "Hash fragment on server root"],
      ["@/server/app?raw#section", "Combined query and hash on server module"],
      ["@/lib/supabase/server?url", "Query ?url on supabase/server"],
      ["@/lib/supabase/server.ts?raw#top", "Query and hash on supabase/server.ts"],
      ["@/client/../server/app?inline", "Alias traversal with query suffix"],
      ["../server/app?raw", "Relative traversal with query suffix"],
      ["/src/server/app#fragment", "Root-relative server path with hash"],
      [`/@fs/${PROJECT_ROOT_POSIX}/src/server/app.ts`, "Vite /@fs/ physical server module"],
      [`/@fs/${PROJECT_ROOT_POSIX}/src/lib/supabase/server.ts?import`, "Vite /@fs/ supabase/server with query"],
    ])("blocks query/hash/fs evasion: %s (%s)", (id, _label) => {
      mockError.mockClear();
      expect(() => {
        boundaryPlugin.resolveId.call(mockContext, id, clientImporter);
      }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);
      expect(mockError).toHaveBeenCalledTimes(1);
    });

    it("blocks server imports when client importer itself carries a Vite HMR query suffix", () => {
      expect(() => {
        boundaryPlugin.resolveId.call(
          mockContext,
          "../../server/app",
          `${PROJECT_ROOT_POSIX}/src/client/components/Editor.tsx?t=1731280000#view`
        );
      }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);
      expect(mockError).toHaveBeenCalledTimes(1);
    });

    it("still allows server-to-server imports when server importer carries an HMR query suffix", () => {
      const result = boundaryPlugin.resolveId.call(
        mockContext,
        "@/server/db",
        `${PROJECT_ROOT_POSIX}/src/server/app.ts?t=1731280000`
      );
      expect(result).toBeNull();
      expect(mockError).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 13. Bypass Vector 4: Ancestor Directory Containing /src/server/
  // -------------------------------------------------------------------------
  describe("13. Audit Vector 4: Ancestor Clone Path Containing /src/server/", () => {
    const poisonedClientImporter = "/ci/src/server/ELIXENT/src/client/test.ts";

    it.each([
      ["@/server"],
      ["@/server/app"],
      ["@/client/../server/app"],
      ["@/lib/supabase/server"],
      ["/src/server/app"],
    ])(
      "keeps guard active and blocks %s from /ci/src/server/ELIXENT/src/client/test.ts (default root)",
      (id) => {
        mockError.mockClear();
        expect(() => {
          boundaryPlugin.resolveId.call(mockContext, id, poisonedClientImporter);
        }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);
        expect(mockError).toHaveBeenCalledTimes(1);
      }
    );

    it("anchored root mode: blocks client imports under /ci/src/server/ELIXENT while allowing actual server files", () => {
      const ciRoot = "/ci/src/server/ELIXENT";
      boundaryPlugin.configResolved?.({ root: ciRoot });

      // Client files inside a parent folder named .../src/server/... MUST STILL BE BLOCKED
      for (const [id, importer] of [
        ["@/server", `${ciRoot}/src/client/test.ts`],
        ["@/lib/supabase/server?url", `${ciRoot}/src/client/test.ts`],
        ["../server/app", `${ciRoot}/src/client/test.ts`],
        ["../../server/app", `${ciRoot}/src/client/sub/test.ts`],
        ["/src/server/app", `${ciRoot}/src/client/test.ts`],
        [`${ciRoot}/src/server/app.ts`, `${ciRoot}/src/client/test.ts`],
      ]) {
        mockError.mockClear();
        expect(() => {
          boundaryPlugin.resolveId.call(mockContext, id, importer);
        }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);
        expect(mockError).toHaveBeenCalledTimes(1);
      }

      // Actual server modules under <root>/src/server/ remain permitted
      mockError.mockClear();
      expect(
        boundaryPlugin.resolveId.call(mockContext, "@/server/db", `${ciRoot}/src/server/app.ts`)
      ).toBeNull();
      expect(
        boundaryPlugin.resolveId.call(
          mockContext,
          "@/server/context/request-context",
          `${ciRoot}/src/lib/supabase/server.ts`
        )
      ).toBeNull();
      expect(mockError).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 14. Bypass Vector 5: Non-Literal Dynamic Expression & @vite-ignore Guard
  // -------------------------------------------------------------------------
  describe("14. Audit Vector 5: Dynamic Expression & @vite-ignore Protection (transform hook)", () => {
    const clientFile = `${PROJECT_ROOT_POSIX}/src/client/App.tsx`;
    const sidebarFile = `${PROJECT_ROOT_POSIX}/src/components/layout/sidebar.tsx`;

    it.each([
      [
        "identifier dynamic import",
        `const target = "@" + "/server/app"; export async function load() { return import(target); }`,
        clientFile,
      ],
      [
        "@vite-ignore with server path",
        `export async function load() { return import(/* @vite-ignore */ "@/server/app"); }`,
        clientFile,
      ],
      [
        "@vite-ignore with client path",
        `export async function load() { return import(/* @vite-ignore */ "./safe-helper"); }`,
        clientFile,
      ],
      [
        "template interpolation import",
        "export async function load(route: string) { return import(`@/server/${route}`); }",
        sidebarFile,
      ],
      [
        "constant-folded string concatenation to server module",
        `export async function load() { return import("@" + "/server/app"); }`,
        clientFile,
      ],
      [
        "function call expression inside import()",
        `export async function load(getPath: () => string) { return import(getPath()); }`,
        clientFile,
      ],
      [
        "static dynamic import targeting server alias traversal",
        `export async function load() { return import("@/client/../server/app"); }`,
        clientFile,
      ],
      [
        "static dynamic import targeting case-variant supabase/server with query",
        `export async function load() { return import("@/lib/Supabase/server?raw"); }`,
        clientFile,
      ],
    ])("blocks %s in client code", (_label, code, id) => {
      mockError.mockClear();
      expect(() => {
        boundaryPlugin.transform.call(mockContext, code, id);
      }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);
      expect(mockError).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        "legitimate static literal client code-splitting imports",
        `const a = await import("@/lib/export/export-service"); const b = await import('../parsers/pdf-table-extractor'); export { a, b };`,
        sidebarFile,
      ],
      [
        "TSX apostrophes and text mentioning import(...) alongside legitimate static import",
        `export function View() {
          const load = () => import("@/lib/export/export-service");
          return <p onClick={load}>You're editing — don't import(variable) directly</p>;
        }`,
        clientFile,
      ],
      [
        "comments, regexes, and string literals mentioning import()",
        `// import(variable) in comment
         /* import(/* @vite-ignore */ foo) */
         export const pattern = /import\\(/g;
         export const text = "await import(serverPath)";`,
        clientFile,
      ],
      [
        "object method declaration named import",
        `export const importer = { async import(file: string) { return file.length; } };`,
        clientFile,
      ],
      [
        "TypeScript type-only imports from server contracts",
        `import type { AppType } from "@/server/app";
         export type ClientRef = import("@/server/app").AppType | AppType;`,
        clientFile,
      ],
    ])("allows %s without false positives", (_label, code, id) => {
      const result = boundaryPlugin.transform.call(mockContext, code, id);
      expect(result).toBeNull();
      expect(mockError).not.toHaveBeenCalled();
    });

    it("allows dynamic imports during SSR, in server modules, and in node_modules", () => {
      const dynamicCode = `export async function load(p: string) { return import(/* @vite-ignore */ p); }`;

      expect(
        boundaryPlugin.transform.call(mockContext, dynamicCode, clientFile, { ssr: true })
      ).toBeNull();
      expect(
        boundaryPlugin.transform.call(
          mockContext,
          dynamicCode,
          `${PROJECT_ROOT_POSIX}/src/server/app.ts`
        )
      ).toBeNull();
      expect(
        boundaryPlugin.transform.call(
          mockContext,
          dynamicCode,
          `${PROJECT_ROOT_POSIX}/src/lib/supabase/server.ts`
        )
      ).toBeNull();
      expect(
        boundaryPlugin.transform.call(
          mockContext,
          dynamicCode,
          `${PROJECT_ROOT_POSIX}/node_modules/some-pkg/index.js`
        )
      ).toBeNull();
      expect(mockError).not.toHaveBeenCalled();
    });

    it("strictly guards src/client/rpc-client.ts against dynamic/@vite-ignore imports and transforms real rpc-client.ts cleanly", () => {
      const rpcClientPath = `${PROJECT_ROOT_POSIX}/src/client/rpc-client.ts`;
      const bridgeCode = `const p = "@" + "/server/app"; export const load = () => import(/* @vite-ignore */ p);`;

      expect(() => {
        boundaryPlugin.transform.call(mockContext, bridgeCode, rpcClientPath);
      }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);
      expect(mockError).toHaveBeenCalledTimes(1);

      mockError.mockClear();
      const realRpcClientSource = fs.readFileSync(
        path.resolve(PROJECT_ROOT_POSIX, "src/client/rpc-client.ts"),
        "utf-8"
      );
      expect(
        boundaryPlugin.transform.call(mockContext, realRpcClientSource, rpcClientPath)
      ).toBeNull();
      expect(mockError).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 15. AST Obfuscated Dynamic Import & Require Detection (FIND-02)
  // -------------------------------------------------------------------------
  describe("15. AST Obfuscated Dynamic Import & Require Detection (FIND-02)", () => {
    const clientFile = `${PROJECT_ROOT_POSIX}/src/client/App.tsx`;

    it("detects dynamic import nested inside default parameter: { x = import('@/server/app') }", () => {
      const code = `export function configure({ x = import("@/server/app") } = {}) { return x; }`;
      expect(() => {
        boundaryPlugin.transform.call(mockContext, code, clientFile);
      }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);
      expect(mockError).toHaveBeenCalledWith(
        `[Security / Architecture Boundary Violation] Direct client import of server module "@/server/app" from "${clientFile}" is prohibited. Use Hono RPC client (src/client/rpc-client.ts) or extract shared types into src/types/rpc-contracts.ts.`
      );
    });

    it("detects nested dynamic import inside method default parameter: { import(x = import(...)) {} }", () => {
      const code = `export const handler = { import(x = import("@/server/app")) { return x; } };`;
      expect(() => {
        boundaryPlugin.transform.call(mockContext, code, clientFile);
      }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);
      expect(mockError).toHaveBeenCalledWith(
        `[Security / Architecture Boundary Violation] Direct client import of server module "@/server/app" from "${clientFile}" is prohibited. Use Hono RPC client (src/client/rpc-client.ts) or extract shared types into src/types/rpc-contracts.ts.`
      );
    });

    it("detects dynamic import preceded by division / arithmetic expressions like n++ / 2", () => {
      const code = `
        const n = 1;
        export const math = (n++ / 2);
        export async function load() {
          return import("@/server/routes/agent.routes");
        }
      `;
      expect(() => {
        boundaryPlugin.transform.call(mockContext, code, clientFile);
      }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);
      expect(mockError).toHaveBeenCalledWith(
        `[Security / Architecture Boundary Violation] Direct client import of server module "@/server/routes/agent.routes" from "${clientFile}" is prohibited. Use Hono RPC client (src/client/rpc-client.ts) or extract shared types into src/types/rpc-contracts.ts.`
      );
    });

    it("does not false-positive on pure arithmetic division expressions without imports", () => {
      const code = `
        export function calc(n: number) {
          const a = n++ / 2;
          const b = 100 / 5;
          return a + b;
        }
      `;
      const result = boundaryPlugin.transform.call(mockContext, code, clientFile);
      expect(result).toBeNull();
      expect(mockError).not.toHaveBeenCalled();
    });

    it.each([
      ['require("@/server/app")', `const s = require("@/server/app");`],
      ['require("node:fs")', `const fs = require("node:fs");`],
      ['require("crypto")', `const crypto = require("crypto");`],
      ['dynamic require(name)', `const dynamicName = "crypto"; const mod = require(dynamicName);`],
    ])("blocks client require call: %s", (_label, code) => {
      mockError.mockClear();
      expect(() => {
        boundaryPlugin.transform.call(mockContext, code, clientFile);
      }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);
      expect(mockError).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // 16. Client Restrictions: Node.js Built-ins & Server-Only Modules (FIND-03)
  // -------------------------------------------------------------------------
  describe("16. Client Module Restrictions: Node.js Built-ins & Server-Only Modules (FIND-03)", () => {
    const clientFile = `${PROJECT_ROOT_POSIX}/src/client/components/Dashboard.tsx`;

    it.each([
      ["node:fs", "Prefix node:fs built-in"],
      ["node:crypto", "Prefix node:crypto built-in"],
      ["node:path", "Prefix node:path built-in"],
      ["node:async_hooks", "Prefix node:async_hooks built-in"],
      ["crypto", "Bare crypto built-in"],
      ["fs", "Bare fs built-in"],
      ["path", "Bare path built-in"],
      ["async_hooks", "Bare async_hooks built-in"],
      ["fs/promises", "Subpath fs/promises built-in"],
    ])("blocks client import of Node built-in %s (%s) in resolveId", (specifier, _label) => {
      mockError.mockClear();
      expect(() => {
        boundaryPlugin.resolveId.call(mockContext, specifier, clientFile);
      }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);
      expect(mockError).toHaveBeenCalledWith(
        `[Security / Architecture Boundary Violation] Direct client import of Node.js built-in module "${specifier}" from "${clientFile}" is prohibited in client-side code.`
      );
    });

    it.each([
      ["@/lib/sync/etag-generator.server.ts", "Exact .server.ts file under lib"],
      ["./calc.server.ts", "Relative .server.ts file"],
      ["../workers/job.server.js", "Relative .server.js file"],
      ["data.server.ts", "Bare .server.ts file"],
      ["@/lib/stripe", "Stripe lib module"],
      ["@/lib/stripe/index", "Stripe index submodule"],
      ["@/lib/rate-limit", "Rate-limit lib module"],
      ["@/lib/cron/worker", "Cron submodule"],
      ["@/lib/ai/key-rotation", "AI key-rotation module"],
      ["@/lib/config/app-url", "App URL configuration module"],
    ])("blocks client import of server-only module %s (%s) in resolveId", (specifier, _label) => {
      mockError.mockClear();
      expect(() => {
        boundaryPlugin.resolveId.call(mockContext, specifier, clientFile);
      }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);
      expect(mockError).toHaveBeenCalledWith(
        `[Security / Architecture Boundary Violation] Direct client import of server module "${specifier}" from "${clientFile}" is prohibited. Use Hono RPC client (src/client/rpc-client.ts) or extract shared types into src/types/rpc-contracts.ts.`
      );
    });

    it("allows server modules to import Node built-ins and server-only modules", () => {
      const serverFile = `${PROJECT_ROOT_POSIX}/src/server/routes/billing.routes.ts`;
      const etagServerFile = `${PROJECT_ROOT_POSIX}/src/lib/sync/etag-generator.server.ts`;

      expect(boundaryPlugin.resolveId.call(mockContext, "node:crypto", serverFile)).toBeNull();
      expect(boundaryPlugin.resolveId.call(mockContext, "crypto", serverFile)).toBeNull();
      expect(boundaryPlugin.resolveId.call(mockContext, "@/lib/stripe", serverFile)).toBeNull();
      expect(boundaryPlugin.resolveId.call(mockContext, "node:crypto", etagServerFile)).toBeNull();
      expect(mockError).not.toHaveBeenCalled();
    });

    it("allows Node built-ins and server-only modules during SSR compilation", () => {
      expect(
        boundaryPlugin.resolveId.call(mockContext, "node:fs", clientFile, { ssr: true })
      ).toBeNull();
      expect(
        boundaryPlugin.resolveId.call(mockContext, "@/lib/stripe", clientFile, { ssr: true })
      ).toBeNull();
      expect(mockError).not.toHaveBeenCalled();
    });

    it("blocks dynamic imports of Node built-ins and server-only modules in client transform", () => {
      expect(() => {
        boundaryPlugin.transform.call(
          mockContext,
          `export const load = () => import("node:fs");`,
          clientFile
        );
      }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);

      expect(() => {
        boundaryPlugin.transform.call(
          mockContext,
          `export const load = () => import("@/lib/stripe");`,
          clientFile
        );
      }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);
    });
  });

  // -------------------------------------------------------------------------
  // 17. Vite CSS Analysis Watch Fallback (index.html) & Fail-Closed load() Hook
  // -------------------------------------------------------------------------
  describe("17. Vite CSS Analysis Watch Fallback & Fail-Closed load() Hook", () => {
    const indexHtmlImporter = `${PROJECT_ROOT_POSIX}/index.html`;
    const htmlProxyImporter = `${PROJECT_ROOT_POSIX}/index.html?html-proxy&index=0.js`;
    const cssImporter = `${PROJECT_ROOT_POSIX}/src/client/styles/globals.css`;

    it.each([
      ["/src/lib/ai/key-rotation.ts", "AI key rotation watch dep"],
      ["/src/lib/sync/etag-generator.server.ts", "Server-only .server.ts watch dep"],
      ["/src/server/app.ts", "Server entry watch dep"],
    ])(
      "permits resolveId with root index.html synthetic fallback importer for %s (%s)",
      (id) => {
        const result = boundaryPlugin.resolveId.call(mockContext, id, indexHtmlImporter);
        expect(result).toBeNull();
        expect(mockError).not.toHaveBeenCalled();
      }
    );

    it.each([
      ["/src/lib/ai/key-rotation.ts", htmlProxyImporter, "inline HTML proxy script"],
      ["/src/lib/sync/etag-generator.server.ts", htmlProxyImporter, "inline HTML proxy script"],
      ["/src/server/app.ts", htmlProxyImporter, "inline HTML proxy script"],
      ["/src/lib/ai/key-rotation.ts", cssImporter, "CSS file importer"],
      ["/src/server/app.ts", cssImporter, "CSS file importer"],
    ])(
      "still blocks resolveId for %s from non-synthetic importer (%s: %s)",
      (id, importer) => {
        mockError.mockClear();
        expect(() => {
          boundaryPlugin.resolveId.call(mockContext, id, importer);
        }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);
        expect(mockError).toHaveBeenCalledTimes(1);
      }
    );

    it("still fails closed in resolveId for Node.js built-ins even with index.html importer", () => {
      for (const builtin of ["node:fs", "crypto"]) {
        mockError.mockClear();
        expect(() => {
          boundaryPlugin.resolveId.call(mockContext, builtin, indexHtmlImporter);
        }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);
        expect(mockError).toHaveBeenCalledTimes(1);
      }
    });

    it.each([
      ["/src/lib/ai/key-rotation.ts"],
      ["/src/lib/sync/etag-generator.server.ts"],
      ["/src/server/app.ts"],
      [`${PROJECT_ROOT_POSIX}/src/lib/ai/key-rotation.ts`],
      [`${PROJECT_ROOT_POSIX}/src/lib/sync/etag-generator.server.ts`],
      [`${PROJECT_ROOT_POSIX}/src/server/app.ts?t=1731280000`],
    ])("rejects client load() for server module %s (ssr omitted or false)", (id) => {
      mockError.mockClear();
      expect(() => {
        boundaryPlugin.load.call(mockContext, id);
      }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);
      expect(mockError).toHaveBeenCalledWith(
        `[Security / Architecture Boundary Violation] Direct client load of server module "${id}" is prohibited. Use Hono RPC client (src/client/rpc-client.ts) or extract shared types into src/types/rpc-contracts.ts.`
      );

      mockError.mockClear();
      expect(() => {
        boundaryPlugin.load.call(mockContext, id, { ssr: false });
      }).toThrow(/\[Security \/ Architecture Boundary Violation\]/);
      expect(mockError).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["/src/lib/ai/key-rotation.ts"],
      ["/src/lib/sync/etag-generator.server.ts"],
      ["/src/server/app.ts"],
    ])("allows SSR load() (ssr: true) for server module %s", (id) => {
      expect(boundaryPlugin.load.call(mockContext, id, { ssr: true })).toBeNull();
      expect(mockError).not.toHaveBeenCalled();
    });

    it("allows client load() for client modules, virtual modules, and node_modules", () => {
      expect(boundaryPlugin.load.call(mockContext, "/src/client/App.tsx")).toBeNull();
      expect(boundaryPlugin.load.call(mockContext, `${PROJECT_ROOT_POSIX}/index.html`)).toBeNull();
      expect(boundaryPlugin.load.call(mockContext, "\0virtual:server.ts")).toBeNull();
      expect(
        boundaryPlugin.load.call(mockContext, `${PROJECT_ROOT_POSIX}/node_modules/pkg/foo.server.js`)
      ).toBeNull();
      expect(mockError).not.toHaveBeenCalled();
    });
  });
});
