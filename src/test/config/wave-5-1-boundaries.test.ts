/**
 * Phase 5 (Wave 5.1) — Client-Server Boundary Guard, DEF-13 & Pure SVG Invariants
 *
 * Verifies in Node runtime (required by esbuild AST scanning inside `vite.config.ts`):
 * 1. `DEF-13`: `src/components/editor/pending-edits-exit-modal.tsx` never imports `src/client/router.tsx`.
 * 2. Pure Native SVG invariant: `src/components/agent/decision-graph-explorer.tsx` imports zero external graph libraries.
 * 3. `clientServerBoundaryGuardPlugin`: all 11 Wave 5.1 client modules have zero `@/server/*`,
 *    `@/lib/supabase/server`, `*.server.*`, or `node:*` imports (both static `resolveId` and AST `transform`).
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Plugin, UserConfig } from "vite";
import viteConfig from "../../../vite.config";

const REPO_ROOT = path.resolve(__dirname, "../../..");

const WAVE_5_1_CLIENT_MODULES = [
  "src/components/editor/workspace-tab-bar.tsx",
  "src/components/editor/unresolved-edits-tracker.tsx",
  "src/components/editor/pending-edits-exit-modal.tsx",
  "src/components/vault/workspace-decryption-warning-modal.tsx",
  "src/client/routes/workspace-layout.tsx",
  "src/components/files/file-context-menu.tsx",
  "src/components/agent/decision-graph-explorer.tsx",
  "src/components/layout/sidebar.tsx",
  "src/lib/sync/idb-types.ts",
  "src/lib/sync/indexeddb.ts",
  "src/lib/sync/rollback.ts",
] as const;

describe("Wave 5.1 Architectural Boundary & Hygiene Contracts (DEF-13, Client-Server Guard, Pure SVG)", () => {
  it("enforces DEF-13: pending-edits-exit-modal.tsx never imports src/client/router", () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, "src/components/editor/pending-edits-exit-modal.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+["'][^"']*client\/router(?:\.tsx?)?["']/);
    expect(source).not.toMatch(/import\s*\([^)]*router(?:\.tsx?)?["']\)/);
  });

  it("enforces pure Native SVG in decision-graph-explorer.tsx with zero external graph library imports", () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, "src/components/agent/decision-graph-explorer.tsx"),
      "utf8",
    );
    const forbiddenGraphLibs = [
      "d3",
      "cytoscape",
      "reactflow",
      "@xyflow",
      "dagre",
      "elkjs",
      "vis-network",
      "sigma",
      "graphology",
      "mermaid",
    ];
    for (const lib of forbiddenGraphLibs) {
      const importRegex = new RegExp(`from\\s+["']${lib}(?:\\/[^"']*)?["']`);
      expect(source).not.toMatch(importRegex);
    }
  });

  it("passes clientServerBoundaryGuardPlugin (resolveId + transform) for all 11 Wave 5.1 client modules", async () => {
    const resolvedConfig = (
      typeof viteConfig === "function"
        ? await (
            viteConfig as (env: {
              command: "build";
              mode: "production";
            }) => Promise<UserConfig> | UserConfig
          )({ command: "build", mode: "production" })
        : await viteConfig
    ) as UserConfig;

    type BoundaryPlugin = Plugin & {
      resolveId: (
        this: { error: (msg: string) => never },
        id: string,
        importer: string,
      ) => unknown;
      transform: (
        this: { error: (msg: string) => never },
        code: string,
        id: string,
      ) => unknown;
    };

    const boundaryPlugin = (resolvedConfig.plugins ?? [])
      .flat()
      .find(
        (p): p is BoundaryPlugin =>
          p !== null &&
          typeof p === "object" &&
          "name" in p &&
          p.name === "client-server-boundary-guard",
      );
    expect(boundaryPlugin).toBeDefined();

    const ctx = {
      error: (msg: string): never => {
        throw new Error(msg);
      },
    };

    const importSpecifierRegex =
      /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;

    for (const relPath of WAVE_5_1_CLIENT_MODULES) {
      const absPosix = path.join(REPO_ROOT, relPath).replace(/\\/g, "/");
      const code = fs.readFileSync(absPosix, "utf8");

      // 1. Validate AST transform guard (dynamic imports & require calls)
      expect(() =>
        boundaryPlugin!.transform.call(ctx, code, absPosix),
      ).not.toThrow();

      // 2. Validate every static import specifier via resolveId guard
      importSpecifierRegex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = importSpecifierRegex.exec(code)) !== null) {
        const specifier = match[1];
        expect(() =>
          boundaryPlugin!.resolveId.call(ctx, specifier, absPosix),
        ).not.toThrow();
      }
    }
  });
});
