/**
 * Comprehensive Unit & Integration Test Suite for Typed RPC Client (`src/client/rpc-client.ts`)
 *
 * Verifies:
 * 1. Factory, Transport State Management & DEF-A01 Purge Invariants:
 *    - `createElixentRpcClient`: returns typed Hono client with custom or default fetch.
 *    - `setRpcClientFetch` / `getRpcClientFetch`: updates active transport, invalidates cached defaultClient,
 *      and falls back to `globalThis.fetch` when cleared (`undefined`).
 *    - DEF-A01 Regression: confirms `isVitestBridgeActive` is removed and `src/client/rpc-client.ts` contains
 *      zero runtime server imports, zero split dynamic paths, and zero `@vite-ignore` directives.
 * 2. In-Memory Loopback Integration via `vitestLoopbackFetch` (`vitest.setup.ts` -> Hono `app.fetch`):
 *    - All 26 facades route through Hono HTTP `app.fetch` -> `rpc.routes.ts` (Zod validation + HTTP JSON serialization).
 *    - Malformed payloads fail at Hono's `zValidator` HTTP boundary without invoking server actions.
 *    - `getCreditBalance`: parses `BigInt(balanceMicro)` on 200 and returns `0n` on HTTP 401.
 * 3. Injected Custom HTTP Transport (Hono RPC Protocol Dispatch & Error Handling):
 *    - Routes facades via `client.api.rpc...` with proper HTTP methods and JSON payloads.
 *    - Handles non-OK HTTP responses (4xx JSON, 400 ZodError JSON, 500 plain text) cleanly.
 * 4. End-to-End Loopback Wire Round-Trips (`createElixentRpcClient` + `vitestLoopbackFetch`).
 */

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { vitestLoopbackFetch } from "../../../vitest.setup";
import {
  createElixentRpcClient,
  setRpcClientFetch,
  getRpcClientFetch,
  resolveRpcFetch,
  getRpcClient,
  getBaseUrl,
  parseRpcResult,
  createFile,
  updateFileContent,
  toggleFileEncryption,
  renameFile,
  deleteFile,
  restoreFile,
  copyFile,
  moveFile,
  importFile,
  getFile,
  getUserFiles,
  getRootFiles,
  getDeletedFiles,
  getFolderChildren,
  getUserVaultProfile,
  createUserVaultProfile,
  updateVaultPassword,
  updateVaultRecoveryEnvelope,
  revokeAllTrustedDevices,
  updateVaultAISetting,
  signInWithGoogle,
  signOut,
  syncUserToDatabase,
  getUserProfile,
  updateUserProfile,
  getCreditBalance,
  getCreditBalanceResult,
} from "@/client/rpc-client";

// ---------------------------------------------------------------------------
// Hoisted Mock State for Server Boundaries (Verified Behind Hono app.fetch)
// ---------------------------------------------------------------------------

const {
  mockServerCreateFile,
  mockServerUpdateFileContent,
  mockServerToggleFileEncryption,
  mockServerRenameFile,
  mockServerDeleteFile,
  mockServerRestoreFile,
  mockServerCopyFile,
  mockServerGetFile,
  mockServerGetUserFiles,
  mockServerGetRootFiles,
  mockServerGetDeletedFiles,
  mockServerMoveFile,
  mockServerGetFolderChildren,
  mockServerImportFile,
  mockServerGetUserVaultProfile,
  mockServerCreateUserVaultProfile,
  mockServerUpdateVaultPassword,
  mockServerUpdateVaultRecoveryEnvelope,
  mockServerRevokeAllTrustedDevices,
  mockServerUpdateVaultAISetting,
  mockServerSignInWithGoogle,
  mockServerSignOut,
  mockServerSyncUserToDatabase,
  mockServerGetUserProfile,
  mockServerUpdateUserProfile,
  mockServerGetUser,
  mockServerGetUserCreditBalance,
} = vi.hoisted(() => ({
  mockServerCreateFile: vi.fn(),
  mockServerUpdateFileContent: vi.fn(),
  mockServerToggleFileEncryption: vi.fn(),
  mockServerRenameFile: vi.fn(),
  mockServerDeleteFile: vi.fn(),
  mockServerRestoreFile: vi.fn(),
  mockServerCopyFile: vi.fn(),
  mockServerGetFile: vi.fn(),
  mockServerGetUserFiles: vi.fn(),
  mockServerGetRootFiles: vi.fn(),
  mockServerGetDeletedFiles: vi.fn(),
  mockServerMoveFile: vi.fn(),
  mockServerGetFolderChildren: vi.fn(),
  mockServerImportFile: vi.fn(),
  mockServerGetUserVaultProfile: vi.fn(),
  mockServerCreateUserVaultProfile: vi.fn(),
  mockServerUpdateVaultPassword: vi.fn(),
  mockServerUpdateVaultRecoveryEnvelope: vi.fn(),
  mockServerRevokeAllTrustedDevices: vi.fn(),
  mockServerUpdateVaultAISetting: vi.fn(),
  mockServerSignInWithGoogle: vi.fn(),
  mockServerSignOut: vi.fn(),
  mockServerSyncUserToDatabase: vi.fn(),
  mockServerGetUserProfile: vi.fn(),
  mockServerUpdateUserProfile: vi.fn(),
  mockServerGetUser: vi.fn(),
  mockServerGetUserCreditBalance: vi.fn(),
}));

vi.mock("@/server/actions/files", () => ({
  createFile: (...args: unknown[]) => mockServerCreateFile(...args),
  updateFileContent: (...args: unknown[]) => mockServerUpdateFileContent(...args),
  toggleFileEncryption: (...args: unknown[]) => mockServerToggleFileEncryption(...args),
  renameFile: (...args: unknown[]) => mockServerRenameFile(...args),
  deleteFile: (...args: unknown[]) => mockServerDeleteFile(...args),
  restoreFile: (...args: unknown[]) => mockServerRestoreFile(...args),
  copyFile: (...args: unknown[]) => mockServerCopyFile(...args),
  getFile: (...args: unknown[]) => mockServerGetFile(...args),
  getUserFiles: () => mockServerGetUserFiles(),
  getRootFiles: () => mockServerGetRootFiles(),
  getDeletedFiles: () => mockServerGetDeletedFiles(),
}));

vi.mock("@/server/actions/folders", () => ({
  moveFile: (...args: unknown[]) => mockServerMoveFile(...args),
  getFolderChildren: (...args: unknown[]) => mockServerGetFolderChildren(...args),
}));

vi.mock("@/server/actions/import-file", () => ({
  importFile: (...args: unknown[]) => mockServerImportFile(...args),
}));

vi.mock("@/server/actions/vault-actions", () => ({
  getUserVaultProfile: () => mockServerGetUserVaultProfile(),
  createUserVaultProfile: (...args: unknown[]) => mockServerCreateUserVaultProfile(...args),
  updateVaultPassword: (...args: unknown[]) => mockServerUpdateVaultPassword(...args),
  updateVaultRecoveryEnvelope: (...args: unknown[]) => mockServerUpdateVaultRecoveryEnvelope(...args),
  revokeAllTrustedDevices: () => mockServerRevokeAllTrustedDevices(),
  updateVaultAISetting: (...args: unknown[]) => mockServerUpdateVaultAISetting(...args),
}));

vi.mock("@/server/actions/auth-actions", () => ({
  signInWithGoogle: (...args: unknown[]) => mockServerSignInWithGoogle(...args),
  signOut: (...args: unknown[]) => mockServerSignOut(...args),
  syncUserToDatabase: () => mockServerSyncUserToDatabase(),
  getUserProfile: () => mockServerGetUserProfile(),
  updateUserProfile: (...args: unknown[]) => mockServerUpdateUserProfile(...args),
}));

vi.mock("@/server/services/ai-settlement-service", () => ({
  getUserCreditBalance: (...args: unknown[]) => mockServerGetUserCreditBalance(...args),
}));

vi.mock("@/lib/supabase/server", () => ({
  getUser: () => mockServerGetUser(),
  createClient: vi.fn(async () => ({
    auth: {
      getUser: () => mockServerGetUser(),
    },
  })),
}));

describe("Typed RPC Client (`src/client/rpc-client.ts`)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRpcClientFetch(vitestLoopbackFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setRpcClientFetch(vitestLoopbackFetch);
  });

  // ==========================================================================
  // Factory, Transport Invariants & DEF-A01 Purge Regression
  // ==========================================================================

  describe("Factory, Transport Invariants & DEF-A01 Purge", () => {
    it("creates a typed RPC client instance with default options", () => {
      const client = createElixentRpcClient();
      expect(client).toBeDefined();
      expect(client.api).toBeDefined();
      expect(client.api.rpc).toBeDefined();
    });

    it("creates a client instance with custom baseUrl and customFetch", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
      const client = createElixentRpcClient("https://api.elixent.app", mockFetch);

      await client.api.rpc.files.list.$get();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const calledUrl = mockFetch.mock.calls[0][0].toString();
      expect(calledUrl).toContain("https://api.elixent.app/api/rpc/files/list");
    });

    it("registers vitestLoopbackFetch by default in Vitest and restores it cleanly", () => {
      expect(getRpcClientFetch()).toBe(vitestLoopbackFetch);

      const dummyFetch = vi.fn() as unknown as typeof fetch;
      setRpcClientFetch(dummyFetch);
      expect(getRpcClientFetch()).toBe(dummyFetch);

      setRpcClientFetch(vitestLoopbackFetch);
      expect(getRpcClientFetch()).toBe(vitestLoopbackFetch);
    });

    it("falls back to globalThis.fetch when custom fetch is cleared via setRpcClientFetch(undefined)", async () => {
      const mockGlobalFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: { id: "f_global" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
      vi.stubGlobal("fetch", mockGlobalFetch);
      setRpcClientFetch(undefined);

      expect(getRpcClientFetch()).toBeUndefined();
      const result = await createFile("Browser.md", null, false);

      expect(result).toEqual({ success: true, data: { id: "f_global" } });
      expect(mockGlobalFetch).toHaveBeenCalledTimes(1);
      expect(mockGlobalFetch.mock.calls[0][0].toString()).toContain("/api/rpc/files/create");
    });

    it("resolves active transport or globalThis.fetch fallback via resolveRpcFetch", () => {
      expect(resolveRpcFetch()).toBe(vitestLoopbackFetch);

      const customFetch = vi.fn() as unknown as typeof fetch;
      setRpcClientFetch(customFetch);
      expect(resolveRpcFetch()).toBe(customFetch);

      setRpcClientFetch(undefined);
      expect(resolveRpcFetch()).toBe(globalThis.fetch);
    });

    it("honors VITE_APP_URL in getBaseUrl and falls back to window.location.origin or http://localhost:3000", () => {
      const origEnv = process.env.VITE_APP_URL;

      try {
        process.env.VITE_APP_URL = "https://custom.elixent.io";
        expect(getBaseUrl()).toBe("https://custom.elixent.io");

        delete process.env.VITE_APP_URL;
        const expectedWindowOrigin =
          typeof window !== "undefined" && window.location?.origin && window.location.origin !== "null"
            ? window.location.origin
            : "http://localhost:3000";
        expect(getBaseUrl()).toBe(expectedWindowOrigin);
      } finally {
        if (origEnv !== undefined) {
          process.env.VITE_APP_URL = origEnv;
        } else {
          delete process.env.VITE_APP_URL;
        }
      }
    });

    it("caches client instance by (baseUrl, activeCustomFetch) and invalidates upon setRpcClientFetch", () => {
      const client1 = getRpcClient();
      const client2 = getRpcClient();
      expect(client1).toBe(client2);

      const dummyFetch1 = vi.fn() as unknown as typeof fetch;
      setRpcClientFetch(dummyFetch1);
      const client3 = getRpcClient();
      expect(client3).not.toBe(client1);

      const client4 = getRpcClient();
      expect(client4).toBe(client3);

      setRpcClientFetch(undefined);
      const client5 = getRpcClient();
      expect(client5).not.toBe(client3);
    });

    it("DEF-A01 regression: purges isVitestBridgeActive, dynamic server imports, and @vite-ignore from src/client/rpc-client.ts", async () => {
      const rpcClientMod = await import("@/client/rpc-client");
      expect((rpcClientMod as Record<string, unknown>).isVitestBridgeActive).toBeUndefined();

      const expectedExports = [
        "createElixentRpcClient",
        "setRpcClientFetch",
        "getRpcClientFetch",
        "resolveRpcFetch",
        "getRpcClient",
        "getBaseUrl",
        "parseRpcResult",
        "createFile",
        "updateFileContent",
        "toggleFileEncryption",
        "renameFile",
        "deleteFile",
        "restoreFile",
        "copyFile",
        "moveFile",
        "importFile",
        "getFile",
        "getUserFiles",
        "getRootFiles",
        "getDeletedFiles",
        "getFolderChildren",
        "getUserVaultProfile",
        "createUserVaultProfile",
        "updateVaultPassword",
        "updateVaultRecoveryEnvelope",
        "revokeAllTrustedDevices",
        "updateVaultAISetting",
        "signInWithGoogle",
        "signOut",
        "syncUserToDatabase",
        "getUserProfile",
        "updateUserProfile",
        "getCreditBalance",
        "getCreditBalanceResult",
      ];
      for (const exportName of expectedExports) {
        expect(typeof (rpcClientMod as Record<string, unknown>)[exportName]).toBe("function");
      }

      const rpcClientPath = path.resolve(process.cwd(), "src/client/rpc-client.ts");
      const source = fs.readFileSync(rpcClientPath, "utf-8");

      expect(source).not.toContain("isVitestBridgeActive");
      expect(source).not.toContain("vitestLoopbackFetch");
      expect(source).not.toContain("server/actions");
      expect(source).not.toContain("server/services");
      expect(source).not.toContain("supabase/server");
      expect(source).not.toContain("@vite-ignore");
      expect(source).not.toMatch(/["']@["']\s*\+/);
      expect(source).not.toMatch(/\bimport\s*\(/);

      // Only allowed server reference is the erased `import type { AppType } from "@/server/app";`
      const serverMentionLines = source
        .split(/\r?\n/)
        .filter((line) => line.includes("@/server") || line.includes("server/"));
      expect(serverMentionLines).toEqual([
        'import type { AppType } from "@/server/app";',
      ]);
    });
  });

  // ==========================================================================
  // In-Memory Loopback Integration (vitestLoopbackFetch -> Hono app.fetch)
  // ==========================================================================

  describe("In-Memory Loopback Integration (vitestLoopbackFetch -> Hono app.fetch)", () => {
    beforeEach(() => {
      mockServerGetUser.mockResolvedValue({ id: "usr_loopback", email: "loopback@elixent.app" });
    });

    it("routes files operations through Hono HTTP app.fetch and rpc.routes.ts", async () => {
      mockServerCreateFile.mockResolvedValueOnce({ success: true, data: { id: "f_1" } });
      mockServerUpdateFileContent.mockResolvedValueOnce({ success: true, version: 2 });
      mockServerToggleFileEncryption.mockResolvedValueOnce({ success: true });
      mockServerRenameFile.mockResolvedValueOnce({ success: true });
      mockServerDeleteFile.mockResolvedValueOnce({ success: true });
      mockServerRestoreFile.mockResolvedValueOnce({ success: true });
      mockServerCopyFile.mockResolvedValueOnce({ success: true });
      mockServerGetFile.mockResolvedValueOnce({ success: true, data: { id: "f_1" } });
      mockServerGetUserFiles.mockResolvedValueOnce({ success: true, data: [] });
      mockServerGetRootFiles.mockResolvedValueOnce({ success: true, data: [] });
      mockServerGetDeletedFiles.mockResolvedValueOnce({ success: true, data: [] });

      const created = await createFile("Doc.md", null, false);
      expect(created).toEqual({ success: true, data: { id: "f_1" } });
      expect(mockServerCreateFile).toHaveBeenCalledWith("Doc.md", null, false);

      const updated = await updateFileContent("f_1", "New Content", { expectedVersion: 1 });
      expect(updated).toEqual({ success: true, version: 2 });
      expect(mockServerUpdateFileContent).toHaveBeenCalledWith("f_1", "New Content", {
        expectedVersion: 1,
      });

      await toggleFileEncryption("f_1", true, "cipher", null);
      expect(mockServerToggleFileEncryption).toHaveBeenCalledWith("f_1", true, "cipher", null, undefined);

      await renameFile("f_1", "Renamed.md");
      expect(mockServerRenameFile).toHaveBeenCalledWith("f_1", "Renamed.md");

      await deleteFile("f_1", { expectedVersion: 2 });
      expect(mockServerDeleteFile).toHaveBeenCalledWith("f_1", { expectedVersion: 2 });

      await restoreFile("f_1");
      expect(mockServerRestoreFile).toHaveBeenCalledWith("f_1");

      await copyFile("f_1", "fld_1", 2);
      expect(mockServerCopyFile).toHaveBeenCalledWith("f_1", "fld_1", 2, undefined);

      await getFile("f_1");
      expect(mockServerGetFile).toHaveBeenCalledWith("f_1");

      await getUserFiles();
      expect(mockServerGetUserFiles).toHaveBeenCalledTimes(1);

      await getRootFiles();
      expect(mockServerGetRootFiles).toHaveBeenCalledTimes(1);

      await getDeletedFiles();
      expect(mockServerGetDeletedFiles).toHaveBeenCalledTimes(1);
    });

    it("enforces Hono Zod validation at HTTP boundary in loopback mode before server actions run", async () => {
      const invalidCreate = await createFile(undefined as unknown as string, null, false);
      expect(invalidCreate.success).toBe(false);
      expect(typeof invalidCreate.error).toBe("string");
      expect(mockServerCreateFile).not.toHaveBeenCalled();

      const invalidImport = await importFile(
        "malware.exe",
        "binary",
        "exe" as unknown as "txt",
        null
      );
      expect(invalidImport.success).toBe(false);
      expect(typeof invalidImport.error).toBe("string");
      expect(mockServerImportFile).not.toHaveBeenCalled();
    });

    it("routes folder and import operations through Hono HTTP loopback transport", async () => {
      mockServerMoveFile.mockResolvedValueOnce({ success: true });
      mockServerGetFolderChildren.mockResolvedValueOnce({ success: true, data: [] });
      mockServerImportFile.mockResolvedValueOnce({ success: true, fileId: "f_imp_1" });

      await moveFile("f_1", "fld_2");
      expect(mockServerMoveFile).toHaveBeenCalledWith("f_1", "fld_2");

      await getFolderChildren("fld_1");
      expect(mockServerGetFolderChildren).toHaveBeenCalledWith("fld_1");

      await importFile("notes.txt", "Sample", "txt", null);
      expect(mockServerImportFile).toHaveBeenCalledWith("notes.txt", "Sample", "txt", null, undefined);
    });

    it("routes vault operations through Hono HTTP loopback transport", async () => {
      mockServerGetUserVaultProfile.mockResolvedValueOnce({ success: true, data: null });
      mockServerCreateUserVaultProfile.mockResolvedValueOnce({ success: true });
      mockServerUpdateVaultPassword.mockResolvedValueOnce({ success: true });
      mockServerUpdateVaultRecoveryEnvelope.mockResolvedValueOnce({ success: true });
      mockServerRevokeAllTrustedDevices.mockResolvedValueOnce({ success: true, data: { newEpoch: 2 } });
      mockServerUpdateVaultAISetting.mockResolvedValueOnce({ success: true });

      await getUserVaultProfile();
      expect(mockServerGetUserVaultProfile).toHaveBeenCalledTimes(1);

      const createInput = {
        encryptedMasterKey: "emk",
        recoveryEncryptedMasterKey: "remk",
        keySalt: "ks",
        recoverySalt: "rs",
      };
      await createUserVaultProfile(createInput);
      expect(mockServerCreateUserVaultProfile).toHaveBeenCalledWith(createInput);

      const passInput = {
        encryptedMasterKey: "new_emk",
        keySalt: "new_salt",
        proofOfPossession: "pop",
        proofNonce: "nonce",
      };
      await updateVaultPassword(passInput);
      expect(mockServerUpdateVaultPassword).toHaveBeenCalledWith(passInput);

      const recoveryInput = { recoveryEncryptedMasterKey: "fresh_remk" };
      await updateVaultRecoveryEnvelope(recoveryInput);
      expect(mockServerUpdateVaultRecoveryEnvelope).toHaveBeenCalledWith(recoveryInput);

      await revokeAllTrustedDevices();
      expect(mockServerRevokeAllTrustedDevices).toHaveBeenCalledTimes(1);

      await updateVaultAISetting(false);
      expect(mockServerUpdateVaultAISetting).toHaveBeenCalledWith(false);
    });

    it("routes auth operations through Hono HTTP loopback transport including BigInt JSON serialization", async () => {
      mockServerSignInWithGoogle.mockResolvedValueOnce({ success: true, redirectUrl: "/auth" });
      mockServerSignOut.mockResolvedValueOnce({ success: true, redirectUrl: "/" });
      mockServerSyncUserToDatabase.mockResolvedValueOnce({ success: true });
      mockServerGetUserProfile.mockResolvedValueOnce({
        success: true,
        data: { id: "usr_1", creditBalanceMicro: BigInt(999) },
      });
      mockServerUpdateUserProfile.mockResolvedValueOnce({ success: true });

      await signInWithGoogle("/editor");
      expect(mockServerSignInWithGoogle).toHaveBeenCalledWith("/editor");

      const signOutResult = await signOut();
      expect(signOutResult).toEqual({ success: true, redirectUrl: "/" });
      expect(mockServerSignOut).toHaveBeenCalledTimes(1);

      await syncUserToDatabase();
      expect(mockServerSyncUserToDatabase).toHaveBeenCalledTimes(1);

      const profileRes = await getUserProfile();
      expect(profileRes).toEqual({
        success: true,
        data: { id: "usr_1", creditBalanceMicro: "999" },
      });
      expect(mockServerGetUserProfile).toHaveBeenCalledTimes(1);

      await updateUserProfile({ displayName: "Elixent User" });
      expect(mockServerUpdateUserProfile).toHaveBeenCalledWith({ displayName: "Elixent User" });
    });

    it("routes getCreditBalance through Hono /api/rpc/billing/credit-balance in loopback mode", async () => {
      mockServerGetUser.mockResolvedValueOnce({ id: "usr_active_credit" });
      mockServerGetUserCreditBalance.mockResolvedValueOnce(BigInt(88000000));

      const balance = await getCreditBalance();
      expect(balance).toBe(BigInt(88000000));
      expect(mockServerGetUserCreditBalance).toHaveBeenCalledWith("usr_active_credit");
    });

    it("returns 0n from getCreditBalance when Hono returns HTTP 401 for missing session", async () => {
      mockServerGetUser.mockResolvedValueOnce(null);

      const balance = await getCreditBalance();
      expect(balance).toBe(BigInt(0));
      expect(mockServerGetUserCreditBalance).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Injected Custom HTTP Transport Mode
  // ==========================================================================

  describe("Injected Custom HTTP Transport Mode (Hono RPC Wire)", () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, _init?: RequestInit) => {
        const urlStr = input.toString();

        if (urlStr.includes("/api/rpc/files/create")) {
          return new Response(JSON.stringify({ success: true, data: { id: "f_http_1" } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (urlStr.includes("/api/rpc/files/update-content")) {
          return new Response(JSON.stringify({ success: true, version: 5 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (urlStr.includes("/api/rpc/billing/credit-balance")) {
          return new Response(
            JSON.stringify({ success: true, balanceMicro: "150000000000" }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
        if (urlStr.includes("/api/rpc/auth/sign-out")) {
          return new Response(JSON.stringify({ success: true, redirectUrl: "/" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      setRpcClientFetch(mockFetch as unknown as typeof fetch);
    });

    it("routes createFile via HTTP POST to /api/rpc/files/create", async () => {
      const result = await createFile("Network Doc.md", "fld_9", true);

      expect(result).toEqual({ success: true, data: { id: "f_http_1" } });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [reqUrl, reqInit] = mockFetch.mock.calls[0];
      expect(reqUrl.toString()).toContain("/api/rpc/files/create");
      expect(reqInit?.method).toBe("POST");

      const parsedBody = JSON.parse(reqInit?.body as string);
      expect(parsedBody).toEqual({
        title: "Network Doc.md",
        parentFolderId: "fld_9",
        isFolder: true,
      });

      // Ensure direct server actions were not called
      expect(mockServerCreateFile).not.toHaveBeenCalled();
    });

    it("routes updateFileContent via HTTP POST with options", async () => {
      const result = await updateFileContent("f_http_1", "Updated body", {
        expectedVersion: 4,
        expectedETag: '"etag-4"',
      });

      expect(result).toEqual({ success: true, version: 5 });
      const [reqUrl, reqInit] = mockFetch.mock.calls[0];
      expect(reqUrl.toString()).toContain("/api/rpc/files/update-content");
      const parsedBody = JSON.parse(reqInit?.body as string);
      expect(parsedBody.fileId).toBe("f_http_1");
      expect(parsedBody.options).toEqual({ expectedVersion: 4, expectedETag: '"etag-4"' });
    });

    it("routes getCreditBalance via HTTP GET and converts string to BigInt", async () => {
      const balance = await getCreditBalance();

      expect(balance).toBe(BigInt("150000000000"));
      const [reqUrl, reqInit] = mockFetch.mock.calls[0];
      expect(reqUrl.toString()).toContain("/api/rpc/billing/credit-balance");
      expect(reqInit?.method).toBe("GET");
    });

    it("returns 0n from getCreditBalance when HTTP request fails with 401 Unauthorized", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        })
      );

      const balance = await getCreditBalance();
      expect(balance).toBe(BigInt(0));
    });

    it("returns 0n from getCreditBalance when balanceMicro is missing or success is false", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const balance = await getCreditBalance();
      expect(balance).toBe(BigInt(0));
    });

    it("routes signOut via HTTP POST and returns redirectUrl", async () => {
      const result = await signOut();

      expect(result).toEqual({ success: true, redirectUrl: "/" });
      const [reqUrl, reqInit] = mockFetch.mock.calls[0];
      expect(reqUrl.toString()).toContain("/api/rpc/auth/sign-out");
      expect(reqInit?.method).toBe("POST");
    });

    it("handles HTTP 413 JSON errors and HTTP 500 plain-text errors gracefully without crashing JSON parsing", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: false, error: "File exceeds maximum size limit (10MB)" }),
          {
            status: 413,
            headers: { "Content-Type": "application/json" },
          }
        )
      );
      const tooLarge = await importFile("huge.txt", "x", "txt", null);
      expect(tooLarge).toEqual({
        success: false,
        error: "File exceeds maximum size limit (10MB)",
      });

      mockFetch.mockResolvedValueOnce(
        new Response("Internal Server Error", {
          status: 500,
          headers: { "Content-Type": "text/plain" },
        })
      );
      const serverErr = await getFile("f_broken");
      expect(serverErr).toEqual({
        success: false,
        error: "Internal Server Error",
      });
    });

    it("handles network failures and stream reading rejections in parseRpcResult returning statusCode: 0", async () => {
      const networkFailure = Promise.reject(new Error("Failed to fetch"));
      const result1 = await parseRpcResult(networkFailure);
      expect(result1).toEqual({
        success: false,
        error: "Failed to fetch",
        statusCode: 0,
      });

      const badResponse = {
        ok: true,
        status: 200,
        text: () => Promise.reject(new Error("Body stream corrupted")),
      };
      const result2 = await parseRpcResult(badResponse);
      expect(result2).toEqual({
        success: false,
        error: "Body stream corrupted",
        statusCode: 0,
      });
    });

    it("surfaces network disconnect cleanly through RPC facade without unhandled promise rejection", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      const result = await createFile("Offline.md", null, false);
      expect(result).toEqual({
        success: false,
        error: "Failed to fetch",
        statusCode: 0,
      });
    });

    it("routes getCreditBalanceResult and returns success: true, balanceMicro, and balance on HTTP 200", async () => {
      const result = await getCreditBalanceResult();
      expect(result).toEqual({
        success: true,
        balanceMicro: "150000000000",
        balance: BigInt("150000000000"),
      });
    });

    it("supports nested data.creditBalanceMicro in getCreditBalanceResult on HTTP 200", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            data: { creditBalanceMicro: "42000000000" },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      );

      const result = await getCreditBalanceResult();
      expect(result).toEqual({
        success: true,
        balanceMicro: "42000000000",
        balance: BigInt("42000000000"),
      });
    });

    it("returns unauthorized status from getCreditBalanceResult when response is HTTP 401", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        })
      );

      const result = await getCreditBalanceResult();
      expect(result).toEqual({
        success: false,
        status: "unauthorized",
        statusCode: 401,
        error: "Unauthorized",
      });
    });

    it("returns error status from getCreditBalanceResult when response is HTTP 500", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, error: "Database outage" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        })
      );

      const result = await getCreditBalanceResult();
      expect(result).toEqual({
        success: false,
        status: "error",
        statusCode: 500,
        error: "Database outage",
      });
    });

    it("returns error status with statusCode: 0 from getCreditBalanceResult when network request throws", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Connection reset by peer"));

      const result = await getCreditBalanceResult();
      expect(result).toEqual({
        success: false,
        status: "error",
        statusCode: 0,
        error: "Connection reset by peer",
      });
    });

    it("throws Error from getCreditBalance when server responds with HTTP >= 500", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response("Server Error", {
          status: 500,
          headers: { "Content-Type": "text/plain" },
        })
      );

      await expect(getCreditBalance()).rejects.toThrow("Server Error");
    });

    it("throws Error from getCreditBalance when network request fails", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network connection lost"));

      await expect(getCreditBalance()).rejects.toThrow("Network connection lost");
    });
  });

  // ==========================================================================
  // End-to-End Loopback Integration (In-Memory HTTP Bridge via vitestLoopbackFetch)
  // ==========================================================================

  describe("End-to-End Loopback Integration (vitestLoopbackFetch Wire)", () => {
    beforeEach(() => {
      mockServerGetUser.mockResolvedValue({ id: "usr_loopback", email: "loopback@elixent.app" });
      setRpcClientFetch(vitestLoopbackFetch);
    });

    it("executes full RPC round-trip for createFile through Hono routing and Zod validation", async () => {
      const mockResult = {
        success: true,
        data: {
          id: "f_e2e_loopback_1",
          title: "Architecture Design.md",
          version: 1,
          isFolder: false,
        },
      };
      mockServerCreateFile.mockResolvedValueOnce(mockResult);

      const result = await createFile("Architecture Design.md", null, false);

      expect(result).toEqual(mockResult);
      expect(mockServerCreateFile).toHaveBeenCalledWith("Architecture Design.md", null, false);
    });

    it("executes full RPC round-trip for vault profile through vitestLoopbackFetch", async () => {
      const mockProfile = {
        success: true,
        data: {
          id: "vp_loopback",
          userId: "usr_loopback",
          keyVersion: 1,
        },
      };
      mockServerGetUserVaultProfile.mockResolvedValueOnce(mockProfile);

      const result = await getUserVaultProfile();

      expect(result).toEqual(mockProfile);
      expect(mockServerGetUserVaultProfile).toHaveBeenCalledTimes(1);
    });

    it("executes full RPC round-trip for getCreditBalance parsing balanceMicro into BigInt", async () => {
      mockServerGetUserCreditBalance.mockResolvedValueOnce(BigInt(500000000));

      const balance = await getCreditBalance();

      expect(balance).toBe(BigInt(500000000));
      expect(mockServerGetUserCreditBalance).toHaveBeenCalledWith("usr_loopback");
    });

    it("executes full RPC round-trip for getCreditBalanceResult in loopback mode", async () => {
      mockServerGetUserCreditBalance.mockResolvedValueOnce(BigInt(990000000));

      const result = await getCreditBalanceResult();
      expect(result).toEqual({
        success: true,
        balanceMicro: "990000000",
        balance: BigInt(990000000),
      });
      expect(mockServerGetUserCreditBalance).toHaveBeenCalledWith("usr_loopback");
    });

    it("executes getCreditBalanceResult in loopback mode returning unauthorized status when unauthenticated", async () => {
      mockServerGetUser.mockResolvedValueOnce(null);

      const result = await getCreditBalanceResult();
      expect(result).toEqual({
        success: false,
        status: "unauthorized",
        statusCode: 401,
        error: "Unauthorized",
      });
      expect(mockServerGetUserCreditBalance).not.toHaveBeenCalled();
    });
  });
});
