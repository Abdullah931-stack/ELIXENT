/**
 * Comprehensive Unit & Integration Test Suite for Typed RPC Client (`src/client/rpc-client.ts`)
 *
 * Verifies:
 * 1. Factory & Transport State Management:
 *    - `createElixentRpcClient`: returns typed Hono client with custom or default fetch.
 *    - `setRpcClientFetch`: properly updates active transport and invalidates cached defaultClient.
 *    - `isVitestBridgeActive`: returns true in Vitest when no customFetch is active; returns false when customFetch is injected.
 * 2. Deterministic Vitest Action Bridge (Direct Action Invocations):
 *    - When bridge is active, all facades dynamically import and invoke the corresponding server actions directly.
 *    - Files, Folders, Import, Vault, Auth, and Billing actions verified.
 *    - `getCreditBalance`: parses BigInt, returns 0n on unauthenticated session.
 * 3. Injected Custom HTTP Transport (Hono RPC Protocol Dispatch):
 *    - When customFetch is injected, facade calls route via `client.api.rpc...` with proper HTTP methods and JSON/query payloads.
 *    - HTTP method matching: GET vs POST.
 *    - JSON serialization and deserialization.
 *    - `getCreditBalance`: converts JSON stringified balanceMicro to native BigInt; handles 401/error status by returning 0n.
 * 4. End-to-End Loopback Integration (In-Memory HTTP Bridge to Hono app):
 *    - Injects `app.fetch` as the HTTP transport and executes full typed RPC journeys through Hono middleware, routing, and validation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { app } from "@/server/app";
import {
  createElixentRpcClient,
  setRpcClientFetch,
  isVitestBridgeActive,
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
} from "@/client/rpc-client";

// ---------------------------------------------------------------------------
// Hoisted Mock State for Server Actions
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
    setRpcClientFetch(undefined);
  });

  afterEach(() => {
    setRpcClientFetch(undefined);
  });

  // ==========================================================================
  // Client Factory & Vitest Bridge Invariants
  // ==========================================================================

  describe("Factory & Bridge Invariants", () => {
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

    it("manages isVitestBridgeActive state based on activeCustomFetch", () => {
      expect(isVitestBridgeActive()).toBe(true);

      const dummyFetch = vi.fn() as unknown as typeof fetch;
      setRpcClientFetch(dummyFetch);
      expect(isVitestBridgeActive()).toBe(false);

      setRpcClientFetch(undefined);
      expect(isVitestBridgeActive()).toBe(true);
    });
  });

  // ==========================================================================
  // Deterministic Vitest Action Bridge (Direct Server Action Dispatch)
  // ==========================================================================

  describe("Deterministic Vitest Bridge Mode (Direct Server Action Execution)", () => {
    it("delegates files operations directly to server actions", async () => {
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

    it("delegates folder and import operations directly to server actions", async () => {
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

    it("delegates vault operations directly to server actions", async () => {
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

    it("delegates auth operations directly to server actions", async () => {
      mockServerSignInWithGoogle.mockResolvedValueOnce({ success: true, redirectUrl: "/auth" });
      mockServerSignOut.mockResolvedValueOnce({ success: true, redirectUrl: "/" });
      mockServerSyncUserToDatabase.mockResolvedValueOnce({ success: true });
      mockServerGetUserProfile.mockResolvedValueOnce({ success: true, data: { id: "usr_1" } });
      mockServerUpdateUserProfile.mockResolvedValueOnce({ success: true });

      await signInWithGoogle("/editor");
      expect(mockServerSignInWithGoogle).toHaveBeenCalledWith("/editor");

      const signOutResult = await signOut();
      expect(signOutResult).toEqual({ success: true, redirectUrl: "/" });
      expect(mockServerSignOut).toHaveBeenCalledTimes(1);

      await syncUserToDatabase();
      expect(mockServerSyncUserToDatabase).toHaveBeenCalledTimes(1);

      await getUserProfile();
      expect(mockServerGetUserProfile).toHaveBeenCalledTimes(1);

      await updateUserProfile({ displayName: "Elixent User" });
      expect(mockServerUpdateUserProfile).toHaveBeenCalledWith({ displayName: "Elixent User" });
    });

    it("delegates getCreditBalance to getUser + getUserCreditBalance", async () => {
      mockServerGetUser.mockResolvedValueOnce({ id: "usr_active_credit" });
      mockServerGetUserCreditBalance.mockResolvedValueOnce(BigInt(88000000));

      const balance = await getCreditBalance();
      expect(balance).toBe(BigInt(88000000));
      expect(mockServerGetUserCreditBalance).toHaveBeenCalledWith("usr_active_credit");
    });

    it("returns 0n from getCreditBalance when session is missing in bridge mode", async () => {
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
  });

  // ==========================================================================
  // End-to-End Loopback Integration (In-Memory HTTP Bridge to Hono app)
  // ==========================================================================

  describe("End-to-End Loopback Integration (app.fetch Wire)", () => {
    beforeEach(() => {
      mockServerGetUser.mockResolvedValue({ id: "usr_loopback", email: "loopback@elixent.app" });

      // Wire typed RPC client custom fetch directly to the master Hono app.fetch
      setRpcClientFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
        // Prefix with origin if relative URL
        const absoluteUrl = urlStr.startsWith("http") ? urlStr : `http://localhost${urlStr}`;
        const req = new Request(absoluteUrl, init);
        return app.fetch(req);
      });
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

    it("executes full RPC round-trip for vault profile through app.fetch", async () => {
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
  });
});
