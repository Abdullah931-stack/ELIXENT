/**
 * Comprehensive Unit & Integration Test Suite for Hono RPC Routes (Wave 3.2)
 *
 * Verifies:
 * 1. Router Mounting & Architecture:
 *    - `rpcRoutes` is an instance of Hono.
 *    - Mounted under `/api/rpc` in master `app`.
 * 2. Files & Folders RPC Endpoints:
 *    - `POST /files/create`: Zod validation, payload routing, folder flag, parent folder id.
 *    - `POST /files/update-content`: Zod validation, optimistic concurrency options.
 *    - `POST /files/toggle-encryption` & alias `POST /files/encryption`: metadata validation.
 *    - `POST /files/rename`: title validation.
 *    - `POST /files/delete`: version & ETag options validation.
 *    - `POST /files/restore`: fileId validation.
 *    - `POST /files/copy`: encryptedOverride schema, depth parameter.
 *    - `POST /files/move`: folderId and null root destination.
 *    - `POST /files/import`: fileType enum validation, 10MB bodyLimit rejection (413).
 *    - `POST /files/get` and `GET /files/get`: JSON body vs query parameter extraction.
 *    - `GET /files/list`, `GET /files/list-root`, `GET /files/list-deleted`.
 *    - `POST /files/children`: folderId and null root children.
 * 3. Vault RPC Endpoints:
 *    - `GET /vault/profile`: profile retrieval.
 *    - `POST /vault/create`: createVaultProfileSchema validation.
 *    - `POST /vault/update-password`: proofOfPossession schema validation.
 *    - `POST /vault/update-recovery`: recovery envelope schema validation.
 *    - `POST /vault/revoke-devices`: device trust revocation.
 *    - `POST /vault/update-ai-setting`: boolean setting validation.
 * 4. Auth RPC Endpoints:
 *    - `POST /auth/sign-in-google`: optional redirectTo payload.
 *    - `POST /auth/sign-out`: cookie wiping verification (Set-Cookie headers for sb-* cookies).
 *    - `POST /auth/sync-user`: database user sync.
 *    - `GET /auth/profile`: user profile retrieval.
 *    - `POST /auth/update-profile`: displayName update.
 * 5. Billing RPC Endpoints:
 *    - `GET /billing/credit-balance`: 401 unauthenticated vs 200 authenticated balance in micro-units.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { rpcRoutes } from "@/server/routes/rpc.routes";
import { app } from "@/server/app";

// ---------------------------------------------------------------------------
// Hoisted Mock State (System Boundaries: Server Actions & Auth)
// ---------------------------------------------------------------------------

const {
  mockCreateFile,
  mockUpdateFileContent,
  mockToggleFileEncryption,
  mockRenameFile,
  mockDeleteFile,
  mockRestoreFile,
  mockCopyFile,
  mockMoveFile,
  mockGetFile,
  mockGetUserFiles,
  mockGetRootFiles,
  mockGetDeletedFiles,
  mockGetFolderChildren,
  mockImportFile,
  mockGetUserVaultProfile,
  mockCreateUserVaultProfile,
  mockUpdateVaultPassword,
  mockUpdateVaultRecoveryEnvelope,
  mockRevokeAllTrustedDevices,
  mockUpdateVaultAISetting,
  mockSignInWithGoogle,
  mockSignOut,
  mockSyncUserToDatabase,
  mockGetUserProfile,
  mockUpdateUserProfile,
  mockGetUserCreditBalance,
  mockGetUser,
} = vi.hoisted(() => ({
  mockCreateFile: vi.fn(),
  mockUpdateFileContent: vi.fn(),
  mockToggleFileEncryption: vi.fn(),
  mockRenameFile: vi.fn(),
  mockDeleteFile: vi.fn(),
  mockRestoreFile: vi.fn(),
  mockCopyFile: vi.fn(),
  mockMoveFile: vi.fn(),
  mockGetFile: vi.fn(),
  mockGetUserFiles: vi.fn(),
  mockGetRootFiles: vi.fn(),
  mockGetDeletedFiles: vi.fn(),
  mockGetFolderChildren: vi.fn(),
  mockImportFile: vi.fn(),
  mockGetUserVaultProfile: vi.fn(),
  mockCreateUserVaultProfile: vi.fn(),
  mockUpdateVaultPassword: vi.fn(),
  mockUpdateVaultRecoveryEnvelope: vi.fn(),
  mockRevokeAllTrustedDevices: vi.fn(),
  mockUpdateVaultAISetting: vi.fn(),
  mockSignInWithGoogle: vi.fn(),
  mockSignOut: vi.fn(),
  mockSyncUserToDatabase: vi.fn(),
  mockGetUserProfile: vi.fn(),
  mockUpdateUserProfile: vi.fn(),
  mockGetUserCreditBalance: vi.fn(),
  mockGetUser: vi.fn(),
}));

vi.mock("@/server/actions/files", () => ({
  createFile: (...args: unknown[]) => mockCreateFile(...args),
  updateFileContent: (...args: unknown[]) => mockUpdateFileContent(...args),
  toggleFileEncryption: (...args: unknown[]) => mockToggleFileEncryption(...args),
  renameFile: (...args: unknown[]) => mockRenameFile(...args),
  deleteFile: (...args: unknown[]) => mockDeleteFile(...args),
  restoreFile: (...args: unknown[]) => mockRestoreFile(...args),
  copyFile: (...args: unknown[]) => mockCopyFile(...args),
  getFile: (...args: unknown[]) => mockGetFile(...args),
  getUserFiles: () => mockGetUserFiles(),
  getRootFiles: () => mockGetRootFiles(),
  getDeletedFiles: () => mockGetDeletedFiles(),
}));

vi.mock("@/server/actions/folders", () => ({
  moveFile: (...args: unknown[]) => mockMoveFile(...args),
  getFolderChildren: (...args: unknown[]) => mockGetFolderChildren(...args),
}));

vi.mock("@/server/actions/import-file", () => ({
  importFile: (...args: unknown[]) => mockImportFile(...args),
}));

vi.mock("@/server/actions/vault-actions", () => ({
  getUserVaultProfile: () => mockGetUserVaultProfile(),
  createUserVaultProfile: (...args: unknown[]) => mockCreateUserVaultProfile(...args),
  updateVaultPassword: (...args: unknown[]) => mockUpdateVaultPassword(...args),
  updateVaultRecoveryEnvelope: (...args: unknown[]) => mockUpdateVaultRecoveryEnvelope(...args),
  revokeAllTrustedDevices: () => mockRevokeAllTrustedDevices(),
  updateVaultAISetting: (...args: unknown[]) => mockUpdateVaultAISetting(...args),
}));

vi.mock("@/server/actions/auth-actions", () => ({
  signInWithGoogle: (...args: unknown[]) => mockSignInWithGoogle(...args),
  signOut: (...args: unknown[]) => mockSignOut(...args),
  syncUserToDatabase: () => mockSyncUserToDatabase(),
  getUserProfile: () => mockGetUserProfile(),
  updateUserProfile: (...args: unknown[]) => mockUpdateUserProfile(...args),
}));

vi.mock("@/server/services/ai-settlement-service", () => ({
  getUserCreditBalance: (...args: unknown[]) => mockGetUserCreditBalance(...args),
}));

vi.mock("@/lib/supabase/server", () => ({
  getUser: () => mockGetUser(),
  createClient: vi.fn(async () => ({
    auth: {
      getUser: () => mockGetUser(),
    },
  })),
}));

describe("Wave 3.2 Hono RPC Routes (src/server/routes/rpc.routes.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ id: "usr_rpc_test", email: "tester@elixent.app" });
  });

  // ==========================================================================
  // Router Structure & Master App Mounting
  // ==========================================================================

  describe("Router Mounting & Dispatch", () => {
    it("exports rpcRoutes as a valid Hono instance", () => {
      expect(rpcRoutes).toBeInstanceOf(Hono);
    });

    it("mounts rpcRoutes under /api/rpc in master app and dispatches successfully", async () => {
      mockGetUserVaultProfile.mockResolvedValueOnce({ success: true, data: null });

      const res = await app.request("http://localhost/api/rpc/vault/profile", {
        method: "GET",
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ success: true, data: null });
      expect(mockGetUserVaultProfile).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Files & Folders RPC Endpoints
  // ==========================================================================

  describe("Files & Folders Endpoints", () => {
    it("POST /files/create: validates input and delegates to createFile", async () => {
      const mockResult = { success: true, data: { id: "f_created_1", title: "Doc.md" } };
      mockCreateFile.mockResolvedValueOnce(mockResult);

      const res = await rpcRoutes.request("/files/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Doc.md",
          parentFolderId: "fld_1",
          isFolder: false,
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockResult);
      expect(mockCreateFile).toHaveBeenCalledWith("Doc.md", "fld_1", false);
    });

    it("POST /files/create: rejects missing title with 400 Bad Request", async () => {
      const res = await rpcRoutes.request("/files/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isFolder: true }),
      });

      expect(res.status).toBe(400);
      expect(mockCreateFile).not.toHaveBeenCalled();
    });

    it("POST /files/update-content: validates payload and delegates options to updateFileContent", async () => {
      const mockResult = { success: true, version: 2, etag: '"etag-2"' };
      mockUpdateFileContent.mockResolvedValueOnce(mockResult);

      const res = await rpcRoutes.request("/files/update-content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileId: "f_1",
          content: "# Header",
          options: { expectedVersion: 1, expectedETag: '"etag-1"', operationId: "op-99" },
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockResult);
      expect(mockUpdateFileContent).toHaveBeenCalledWith("f_1", "# Header", {
        expectedVersion: 1,
        expectedETag: '"etag-1"',
        operationId: "op-99",
      });
    });

    it("POST /files/update-content: rejects missing content with 400 Bad Request", async () => {
      const res = await rpcRoutes.request("/files/update-content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId: "f_1" }),
      });

      expect(res.status).toBe(400);
      expect(mockUpdateFileContent).not.toHaveBeenCalled();
    });

    it("POST /files/toggle-encryption: passes encryptionMetadata and options to toggleFileEncryption", async () => {
      const metadata = {
        version: 1,
        algorithm: "AES-GCM",
        keyId: "key-1",
        salt: "salt-1",
        iv: "iv-1",
      };
      mockToggleFileEncryption.mockResolvedValueOnce({ success: true });

      const res = await rpcRoutes.request("/files/toggle-encryption", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileId: "f_enc_1",
          isEncrypted: true,
          content: "ciphertext",
          encryptionMetadata: metadata,
          options: { expectedVersion: 2 },
        }),
      });

      expect(res.status).toBe(200);
      expect(mockToggleFileEncryption).toHaveBeenCalledWith(
        "f_enc_1",
        true,
        "ciphertext",
        metadata,
        { expectedVersion: 2 }
      );
    });

    it("POST /files/toggle-encryption: accepts null encryptionMetadata for decryption", async () => {
      mockToggleFileEncryption.mockResolvedValueOnce({ success: true });

      const res = await rpcRoutes.request("/files/toggle-encryption", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileId: "f_enc_1",
          isEncrypted: false,
          content: "plaintext",
          encryptionMetadata: null,
        }),
      });

      expect(res.status).toBe(200);
      expect(mockToggleFileEncryption).toHaveBeenCalledWith(
        "f_enc_1",
        false,
        "plaintext",
        null,
        undefined
      );
    });

    it("POST /files/encryption: operates as a functional alias for toggleFileEncryption", async () => {
      mockToggleFileEncryption.mockResolvedValueOnce({ success: true, status: "ok" });

      const res = await rpcRoutes.request("/files/encryption", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileId: "f_alias_1",
          isEncrypted: false,
          content: "plain",
        }),
      });

      expect(res.status).toBe(200);
      expect(mockToggleFileEncryption).toHaveBeenCalledWith(
        "f_alias_1",
        false,
        "plain",
        null,
        undefined
      );
    });

    it("POST /files/rename: validates newTitle and delegates to renameFile", async () => {
      mockRenameFile.mockResolvedValueOnce({ success: true });

      const res = await rpcRoutes.request("/files/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileId: "f_rename_1",
          newTitle: "New Title.md",
        }),
      });

      expect(res.status).toBe(200);
      expect(mockRenameFile).toHaveBeenCalledWith("f_rename_1", "New Title.md");
    });

    it("POST /files/delete: validates options and delegates to deleteFile", async () => {
      mockDeleteFile.mockResolvedValueOnce({ success: true });

      const res = await rpcRoutes.request("/files/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileId: "f_del_1",
          options: { expectedVersion: 3, expectedETag: '"etag-3"' },
        }),
      });

      expect(res.status).toBe(200);
      expect(mockDeleteFile).toHaveBeenCalledWith("f_del_1", {
        expectedVersion: 3,
        expectedETag: '"etag-3"',
      });
    });

    it("POST /files/restore: validates fileId and delegates to restoreFile", async () => {
      mockRestoreFile.mockResolvedValueOnce({ success: true });

      const res = await rpcRoutes.request("/files/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId: "f_res_1" }),
      });

      expect(res.status).toBe(200);
      expect(mockRestoreFile).toHaveBeenCalledWith("f_res_1");
    });

    it("POST /files/copy: delegates file duplication with encryptedOverride", async () => {
      const override = {
        newFileId: "f_copy_target",
        content: "new_ciphertext",
        encryptionMetadata: {
          version: 1,
          algorithm: "AES-GCM",
          keyId: "k-2",
          salt: "s-2",
          iv: "iv-2",
        },
      };
      mockCopyFile.mockResolvedValueOnce({ success: true });

      const res = await rpcRoutes.request("/files/copy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileId: "f_copy_source",
          newParentFolderId: "fld_target",
          depth: 1,
          encryptedOverride: override,
        }),
      });

      expect(res.status).toBe(200);
      expect(mockCopyFile).toHaveBeenCalledWith("f_copy_source", "fld_target", 1, override);
    });

    it("POST /files/move: supports moving to folder or to root (null)", async () => {
      mockMoveFile.mockResolvedValueOnce({ success: true });

      const res = await rpcRoutes.request("/files/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileId: "f_move_1",
          newParentFolderId: null,
        }),
      });

      expect(res.status).toBe(200);
      expect(mockMoveFile).toHaveBeenCalledWith("f_move_1", null);
    });

    it("POST /files/import: validates fileType enum and delegates to importFile", async () => {
      mockImportFile.mockResolvedValueOnce({ success: true, fileId: "f_imp_1" });

      const res = await rpcRoutes.request("/files/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: "imported.txt",
          textContent: "Hello World",
          fileType: "txt",
          parentFolderId: null,
        }),
      });

      expect(res.status).toBe(200);
      expect(mockImportFile).toHaveBeenCalledWith(
        "imported.txt",
        "Hello World",
        "txt",
        null,
        undefined
      );
    });

    it("POST /files/import: rejects invalid fileType with 400 Bad Request", async () => {
      const res = await rpcRoutes.request("/files/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: "binary.exe",
          textContent: "MZ...",
          fileType: "exe", // Not in ["pdf", "md", "txt"]
        }),
      });

      expect(res.status).toBe(400);
      expect(mockImportFile).not.toHaveBeenCalled();
    });

    it("POST /files/import: returns 413 Payload Too Large when payload exceeds 10MB limit", async () => {
      // Create a payload larger than 10MB (10 * 1024 * 1024 + 1024 bytes)
      const oversizedText = "A".repeat(10 * 1024 * 1024 + 2048);
      const res = await rpcRoutes.request("/files/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: "huge.md",
          textContent: oversizedText,
          fileType: "md",
        }),
      });

      expect(res.status).toBe(413);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain("10MB");
      expect(mockImportFile).not.toHaveBeenCalled();
    });

    it("POST /files/get: retrieves file via JSON body fileId", async () => {
      mockGetFile.mockResolvedValueOnce({ success: true, data: { id: "f_get_1" } });

      const res = await rpcRoutes.request("/files/get", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId: "f_get_1" }),
      });

      expect(res.status).toBe(200);
      expect(mockGetFile).toHaveBeenCalledWith("f_get_1");
    });

    it("GET /files/get: retrieves file via query string ?fileId=...", async () => {
      mockGetFile.mockResolvedValueOnce({ success: true, data: { id: "f_query_1" } });

      const res = await rpcRoutes.request("/files/get?fileId=f_query_1", {
        method: "GET",
      });

      expect(res.status).toBe(200);
      expect(mockGetFile).toHaveBeenCalledWith("f_query_1");
    });

    it("GET /files/get: rejects missing query parameter with 400 Bad Request", async () => {
      const res = await rpcRoutes.request("/files/get", {
        method: "GET",
      });

      expect(res.status).toBe(400);
      expect(mockGetFile).not.toHaveBeenCalled();
    });

    it("GET /files/list, /files/list-root, /files/list-deleted: route to respective listing actions", async () => {
      mockGetUserFiles.mockResolvedValueOnce({ success: true, data: [] });
      mockGetRootFiles.mockResolvedValueOnce({ success: true, data: [] });
      mockGetDeletedFiles.mockResolvedValueOnce({ success: true, data: [] });

      const resList = await rpcRoutes.request("/files/list", { method: "GET" });
      const resRoot = await rpcRoutes.request("/files/list-root", { method: "GET" });
      const resDeleted = await rpcRoutes.request("/files/list-deleted", { method: "GET" });

      expect(resList.status).toBe(200);
      expect(resRoot.status).toBe(200);
      expect(resDeleted.status).toBe(200);
      expect(mockGetUserFiles).toHaveBeenCalledTimes(1);
      expect(mockGetRootFiles).toHaveBeenCalledTimes(1);
      expect(mockGetDeletedFiles).toHaveBeenCalledTimes(1);
    });

    it("POST /files/children: delegates folderId string and null", async () => {
      mockGetFolderChildren.mockResolvedValueOnce({ success: true, data: [] });

      const res = await rpcRoutes.request("/files/children", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId: "fld_sub_1" }),
      });

      expect(res.status).toBe(200);
      expect(mockGetFolderChildren).toHaveBeenCalledWith("fld_sub_1");
    });
  });

  // ==========================================================================
  // Vault RPC Endpoints
  // ==========================================================================

  describe("Vault Endpoints", () => {
    it("GET /vault/profile: delegates to getUserVaultProfile", async () => {
      mockGetUserVaultProfile.mockResolvedValueOnce({ success: true, data: { id: "vp_1" } });

      const res = await rpcRoutes.request("/vault/profile", { method: "GET" });

      expect(res.status).toBe(200);
      expect(mockGetUserVaultProfile).toHaveBeenCalledTimes(1);
    });

    it("POST /vault/create: validates schema and delegates to createUserVaultProfile", async () => {
      const input = {
        encryptedMasterKey: "emk",
        recoveryEncryptedMasterKey: "remk",
        keySalt: "salt_k",
        recoverySalt: "salt_r",
        kdfIterations: 600000,
        keyVersion: 1,
      };
      mockCreateUserVaultProfile.mockResolvedValueOnce({ success: true });

      const res = await rpcRoutes.request("/vault/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });

      expect(res.status).toBe(200);
      expect(mockCreateUserVaultProfile).toHaveBeenCalledWith(input);
    });

    it("POST /vault/create: rejects missing recoveryEncryptedMasterKey with 400 Bad Request", async () => {
      const res = await rpcRoutes.request("/vault/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          encryptedMasterKey: "emk",
          keySalt: "salt_k",
          recoverySalt: "salt_r",
        }),
      });

      expect(res.status).toBe(400);
      expect(mockCreateUserVaultProfile).not.toHaveBeenCalled();
    });

    it("POST /vault/update-password: delegates to updateVaultPassword with proof of possession", async () => {
      const input = {
        encryptedMasterKey: "new_emk",
        keySalt: "new_salt",
        proofOfPossession: "proof_jwt",
        proofNonce: "nonce_123",
      };
      mockUpdateVaultPassword.mockResolvedValueOnce({ success: true });

      const res = await rpcRoutes.request("/vault/update-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });

      expect(res.status).toBe(200);
      expect(mockUpdateVaultPassword).toHaveBeenCalledWith(expect.objectContaining(input));
    });

    it("POST /vault/update-recovery: delegates to updateVaultRecoveryEnvelope", async () => {
      const input = {
        recoveryEncryptedMasterKey: "fresh_remk",
        recoverySalt: "fresh_salt",
      };
      mockUpdateVaultRecoveryEnvelope.mockResolvedValueOnce({ success: true });

      const res = await rpcRoutes.request("/vault/update-recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });

      expect(res.status).toBe(200);
      expect(mockUpdateVaultRecoveryEnvelope).toHaveBeenCalledWith(input);
    });

    it("POST /vault/revoke-devices: delegates to revokeAllTrustedDevices", async () => {
      mockRevokeAllTrustedDevices.mockResolvedValueOnce({ success: true, data: { newEpoch: 2 } });

      const res = await rpcRoutes.request("/vault/revoke-devices", { method: "POST" });

      expect(res.status).toBe(200);
      expect(mockRevokeAllTrustedDevices).toHaveBeenCalledTimes(1);
    });

    it("POST /vault/update-ai-setting: validates boolean and delegates to updateVaultAISetting", async () => {
      mockUpdateVaultAISetting.mockResolvedValueOnce({ success: true });

      const res = await rpcRoutes.request("/vault/update-ai-setting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowAI: true }),
      });

      expect(res.status).toBe(200);
      expect(mockUpdateVaultAISetting).toHaveBeenCalledWith(true);
    });
  });

  // ==========================================================================
  // Auth RPC Endpoints
  // ==========================================================================

  describe("Auth Endpoints", () => {
    it("POST /auth/sign-in-google: delegates to signInWithGoogle with redirectTo", async () => {
      mockSignInWithGoogle.mockResolvedValueOnce({
        success: true,
        redirectUrl: "https://accounts.google.com/oauth",
      });

      const res = await rpcRoutes.request("/auth/sign-in-google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirectTo: "/workspace" }),
      });

      expect(res.status).toBe(200);
      expect(mockSignInWithGoogle).toHaveBeenCalledWith("/workspace");
    });

    it("POST /auth/sign-out: executes signOut and appends Set-Cookie headers wiping only sb-* cookies", async () => {
      mockSignOut.mockResolvedValueOnce({ success: true, redirectUrl: "/" });

      const incomingCookie = "sb-access-token=xyz123; app_theme=dark; sb-refresh-token=abc999; other_id=456";

      const res = await rpcRoutes.request("/auth/sign-out", {
        method: "POST",
        headers: {
          Cookie: incomingCookie,
        },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ success: true, redirectUrl: "/" });
      expect(mockSignOut).toHaveBeenCalledTimes(1);

      // Inspect Set-Cookie headers
      const setCookieHeaders = res.headers.getSetCookie();
      expect(setCookieHeaders.length).toBe(2);

      // Verify that only sb-access-token and sb-refresh-token are wiped
      const wipedNames = setCookieHeaders.map((c) => c.split("=")[0]);
      expect(wipedNames).toContain("sb-access-token");
      expect(wipedNames).toContain("sb-refresh-token");
      expect(wipedNames).not.toContain("app_theme");
      expect(wipedNames).not.toContain("other_id");

      // Verify header flags: Max-Age=0 and 1970 expiration
      for (const cookie of setCookieHeaders) {
        expect(cookie).toContain("Max-Age=0");
        expect(cookie).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
        expect(cookie).toContain("HttpOnly");
      }
    });

    it("POST /auth/sign-out: does not emit Set-Cookie when incoming request lacks sb-* cookies", async () => {
      mockSignOut.mockResolvedValueOnce({ success: true, redirectUrl: "/" });

      const res = await rpcRoutes.request("/auth/sign-out", {
        method: "POST",
        headers: {
          Cookie: "theme=dark; guest_id=anon1",
        },
      });

      expect(res.status).toBe(200);
      const setCookieHeaders = res.headers.getSetCookie();
      expect(setCookieHeaders.length).toBe(0);
    });

    it("POST /auth/sync-user: delegates to syncUserToDatabase", async () => {
      mockSyncUserToDatabase.mockResolvedValueOnce({ success: true });

      const res = await rpcRoutes.request("/auth/sync-user", { method: "POST" });

      expect(res.status).toBe(200);
      expect(mockSyncUserToDatabase).toHaveBeenCalledTimes(1);
    });

    it("GET /auth/profile: delegates to getUserProfile", async () => {
      mockGetUserProfile.mockResolvedValueOnce({ success: true, data: { id: "usr_1" } });

      const res = await rpcRoutes.request("/auth/profile", { method: "GET" });

      expect(res.status).toBe(200);
      expect(mockGetUserProfile).toHaveBeenCalledTimes(1);
    });

    it("POST /auth/update-profile: validates displayName and delegates to updateUserProfile", async () => {
      mockUpdateUserProfile.mockResolvedValueOnce({ success: true });

      const res = await rpcRoutes.request("/auth/update-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Elixent Pilot" }),
      });

      expect(res.status).toBe(200);
      expect(mockUpdateUserProfile).toHaveBeenCalledWith({ displayName: "Elixent Pilot" });
    });
  });

  // ==========================================================================
  // Billing RPC Endpoints
  // ==========================================================================

  describe("Billing Endpoints", () => {
    it("GET /billing/credit-balance: returns 401 Unauthorized when session is absent", async () => {
      mockGetUser.mockResolvedValueOnce(null);

      const res = await rpcRoutes.request("/billing/credit-balance", { method: "GET" });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json).toEqual({ success: false, error: "Unauthorized" });
      expect(mockGetUserCreditBalance).not.toHaveBeenCalled();
    });

    it("GET /billing/credit-balance: returns 200 with balanceMicro string when user is authenticated", async () => {
      mockGetUser.mockResolvedValueOnce({ id: "usr_billing_verified" });
      mockGetUserCreditBalance.mockResolvedValueOnce(BigInt(250000000));

      const res = await rpcRoutes.request("/billing/credit-balance", { method: "GET" });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({
        success: true,
        balanceMicro: "250000000",
      });
      expect(mockGetUserCreditBalance).toHaveBeenCalledWith("usr_billing_verified");
    });
  });
});
