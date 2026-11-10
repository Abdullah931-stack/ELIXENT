/**
 * Wave 2.1 Decoupling & Architecture Invariant Suite
 *
 * Verifies the structural and architectural invariants established in Wave 2.1:
 * 1. Permanent deletion of legacy facade `src/server/actions/file-ops.ts`.
 * 2. Complete caller migration: zero imports from `file-ops` across all source files in `src/`.
 * 3. Contract completeness: all 15 operations previously on `file-ops` are exported directly
 *    from `@/server/actions/files` (11 functions) or `@/server/actions/folders` (4 functions).
 * 4. Next.js purge in `src/server/middleware/session-middleware.ts`:
 *    - `next-action` header check is purged.
 *    - `config.matcher` is purged.
 *    - `proxy` alias is purged (only `handleSessionProxy` and `sessionMiddleware` exported).
 * 5. ELIXENT branding and comment hygiene across core entrypoints.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as filesModule from "@/server/actions/files";
import * as foldersModule from "@/server/actions/folders";
import * as sessionMiddlewareModule from "@/server/middleware/session-middleware";

describe("Wave 2.1 Decoupling & Architecture Invariant Verification", () => {
  const projectRoot = path.resolve(__dirname, "../../..");

  describe("1. Legacy Facade Deletion & Zero-Caller Invariant", () => {
    it("confirms src/server/actions/file-ops.ts is permanently deleted from the filesystem", () => {
      const fileOpsPath = path.join(
        projectRoot,
        "src",
        "server",
        "actions",
        "file-ops.ts"
      );
      expect(fs.existsSync(fileOpsPath)).toBe(false);
    });

    it("verifies zero source files in src/ contain imports from 'file-ops'", () => {
      const srcDir = path.join(projectRoot, "src");
      const currentTestFile = path.resolve(__filename);
      const violatingFiles: string[] = [];

      function scanDir(dir: string) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else if (/\.(ts|tsx)$/.test(entry.name)) {
            // Exclude this architectural test file from self-matching
            if (path.resolve(fullPath) === currentTestFile) {
              continue;
            }
            const content = fs.readFileSync(fullPath, "utf-8");
            // Match import/require targeting file-ops
            const importMatch = /(?:from\s+['"][^'"]*file-ops['"]|require\(['"][^'"]*file-ops['"]\))/;
            if (importMatch.test(content)) {
              violatingFiles.push(path.relative(projectRoot, fullPath));
            }
          }
        }
      }

      scanDir(srcDir);
      expect(violatingFiles).toEqual([]);
    });
  });

  describe("2. Operations Contract Completeness (Decoupled Modules)", () => {
    it("exports all 11 file operations directly from @/server/actions/files", () => {
      const requiredFileOps = [
        "createFile",
        "updateFileContent",
        "toggleFileEncryption",
        "renameFile",
        "deleteFile",
        "restoreFile",
        "copyFile",
        "getFile",
        "getUserFiles",
        "getRootFiles",
        "getDeletedFiles",
      ] as const;

      for (const opName of requiredFileOps) {
        expect(
          typeof (filesModule as any)[opName],
          `Expected '${opName}' to be a function on @/server/actions/files`
        ).toBe("function");
      }
    });

    it("exports all 4 folder operations directly from @/server/actions/folders", () => {
      const requiredFolderOps = [
        "moveFile",
        "getFolderChildren",
        "getDescendantIds",
        "isDescendantOf",
      ] as const;

      for (const opName of requiredFolderOps) {
        expect(
          typeof (foldersModule as any)[opName],
          `Expected '${opName}' to be a function on @/server/actions/folders`
        ).toBe("function");
      }
    });
  });

  describe("3. Session Middleware Next.js Purge Invariants", () => {
    it("does not export 'proxy' alias or 'config' matcher from session-middleware", () => {
      expect((sessionMiddlewareModule as any).proxy).toBeUndefined();
      expect((sessionMiddlewareModule as any).config).toBeUndefined();
    });

    it("exports only handleSessionProxy and sessionMiddleware as primary middleware interfaces", () => {
      expect(typeof sessionMiddlewareModule.handleSessionProxy).toBe("function");
      expect(typeof sessionMiddlewareModule.sessionMiddleware).toBe("function");
    });

    it("verifies session-middleware.ts source code contains no 'next-action' or 'config.matcher'", () => {
      const middlewareSourcePath = path.join(
        projectRoot,
        "src",
        "server",
        "middleware",
        "session-middleware.ts"
      );
      const source = fs.readFileSync(middlewareSourcePath, "utf-8");

      expect(source.includes("next-action")).toBe(false);
      expect(source.includes("config.matcher")).toBe(false);
      expect(source.includes("export const config")).toBe(false);
      expect(source.includes("export const proxy")).toBe(false);
    });
  });

  describe("4. ELIXENT Branding & Runtime Consistency", () => {
    it("verifies src/server/index.ts uses ELIXENT server banners and messages", () => {
      const indexPath = path.join(projectRoot, "src", "server", "index.ts");
      const indexSource = fs.readFileSync(indexPath, "utf-8");

      expect(indexSource).toContain("ELIXENT SPA client build not found");
      expect(indexSource).toContain("[ELIXENT Server] Listening on");
      expect(indexSource).not.toContain("LUGX Server");
      expect(indexSource).not.toContain("LUGX SPA client");
    });
  });
});
