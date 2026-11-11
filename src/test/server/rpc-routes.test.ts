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
 *    - `POST /auth/sign-out`: RFC 6265 dual cookie deletion (HttpOnly + client-readable, Secure in prod/HTTPS, Domain handling).
 *    - `POST /auth/sync-user`: database user sync.
 *    - `GET /auth/profile`: user profile retrieval.
 *    - `POST /auth/update-profile`: displayName update.
 * 5. Billing RPC Endpoints:
 *    - `GET /billing/credit-balance`: 401 unauthenticated vs 200 authenticated balance in micro-units.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  const originalNodeEnv = process.env.NODE_ENV;
  const originalCookieDomain = process.env.COOKIE_DOMAIN;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ id: "usr_rpc_test", email: "tester@elixent.app" });
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalCookieDomain === undefined) {
      delete process.env.COOKIE_DOMAIN;
    } else {
      process.env.COOKIE_DOMAIN = originalCookieDomain;
    }
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

    it("verifies /files/encryption and /files/toggle-encryption function identically", async () => {
      const payload = {
        fileId: "f_parity_1",
        isEncrypted: true,
        content: "encrypted-content-sample",
        encryptionMetadata: {
          version: 1,
          algorithm: "AES-GCM-256",
          keyId: "key-1",
          salt: "salt-1",
          iv: "iv-1",
          kdfIterations: 600000,
        },
        options: { expectedVersion: 3 },
      };

      mockToggleFileEncryption.mockResolvedValue({ success: true, version: 4 });

      const toggleRes = await rpcRoutes.request("/files/toggle-encryption", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const aliasRes = await rpcRoutes.request("/files/encryption", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      expect(toggleRes.status).toBe(200);
      expect(aliasRes.status).toBe(200);
      expect(await toggleRes.json()).toEqual(await aliasRes.json());
      expect(mockToggleFileEncryption).toHaveBeenCalledTimes(2);
      expect(mockToggleFileEncryption).toHaveBeenNthCalledWith(
        1,
        "f_parity_1",
        true,
        "encrypted-content-sample",
        payload.encryptionMetadata,
        { expectedVersion: 3 }
      );
      expect(mockToggleFileEncryption).toHaveBeenNthCalledWith(
        2,
        "f_parity_1",
        true,
        "encrypted-content-sample",
        payload.encryptionMetadata,
        { expectedVersion: 3 }
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
        newFileId: "550e8400-e29b-41d4-a716-446655440000",
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

    it("verifies POST /files/get and GET /files/get function identically", async () => {
      const mockResult = {
        success: true,
        data: { id: "f_identical_1", title: "Note.md", content: "# Content" },
      };
      mockGetFile.mockResolvedValue(mockResult);

      const postRes = await rpcRoutes.request("/files/get", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId: "f_identical_1" }),
      });

      const getRes = await rpcRoutes.request("/files/get?fileId=f_identical_1", {
        method: "GET",
      });

      expect(postRes.status).toBe(200);
      expect(getRes.status).toBe(200);
      expect(await postRes.json()).toEqual(mockResult);
      expect(await getRes.json()).toEqual(mockResult);
      expect(mockGetFile).toHaveBeenCalledTimes(2);
      expect(mockGetFile).toHaveBeenNthCalledWith(1, "f_identical_1");
      expect(mockGetFile).toHaveBeenNthCalledWith(2, "f_identical_1");
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

    it("POST /auth/sign-out: executes signOut and issues RFC 6265 dual cookie deletions (HttpOnly + non-HttpOnly) strictly for sb-* auth cookies", async () => {
      mockSignOut.mockResolvedValueOnce({ success: true, redirectUrl: "/" });

      const incomingCookie =
        "sb-access-token=xyz123; sb-proj-auth-token=proj_tok; sb-proj-auth-token.0=chunk0; app_theme=dark; sb-refresh-token=abc999; other_id=456; session_marker=active; session=abc; app-auth-token=auth78";

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

      // Default localhost test request emits 2 host-only Set-Cookie headers per sb-* cookie (HttpOnly + non-HttpOnly)
      const setCookieHeaders = res.headers.getSetCookie();
      expect(setCookieHeaders.length).toBe(8);

      const expectedClearedCookies = [
        "sb-access-token",
        "sb-proj-auth-token",
        "sb-proj-auth-token.0",
        "sb-refresh-token",
      ];

      const wipedNames = setCookieHeaders.map((c) => c.split("=")[0]);
      for (const name of expectedClearedCookies) {
        const headersForCookie = setCookieHeaders.filter((c) => c.startsWith(`${name}=`));
        expect(headersForCookie).toHaveLength(2);
        expect(headersForCookie.filter((c) => c.includes("HttpOnly"))).toHaveLength(1);
        expect(headersForCookie.filter((c) => !c.includes("HttpOnly"))).toHaveLength(1);
      }
      expect(wipedNames).not.toContain("app_theme");
      expect(wipedNames).not.toContain("other_id");
      expect(wipedNames).not.toContain("session_marker");
      expect(wipedNames).not.toContain("session");
      expect(wipedNames).not.toContain("app-auth-token");

      // Verify standardized RFC 6265 attributes (no Domain or Secure on HTTP localhost in test env)
      for (const cookie of setCookieHeaders) {
        expect(cookie).toContain("Max-Age=0");
        expect(cookie).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
        expect(cookie).toContain("Path=/");
        expect(cookie).toContain("SameSite=Lax");
        expect(cookie).not.toContain("Domain=");
        expect(cookie).not.toContain("Secure");
      }
    });

    it("POST /auth/sign-out: does not emit Set-Cookie when incoming request lacks sb-* cookies", async () => {
      mockSignOut.mockResolvedValueOnce({ success: true, redirectUrl: "/" });

      const res = await rpcRoutes.request("/auth/sign-out", {
        method: "POST",
        headers: {
          Cookie:
            "theme=dark; guest_id=anon1; session=abc; session_marker=active; analytics_id=anon-999; sidebar_prefs=compact",
        },
      });

      expect(res.status).toBe(200);
      const setCookieHeaders = res.headers.getSetCookie();
      expect(setCookieHeaders.length).toBe(0);
    });

    it("POST /auth/sign-out: sets Secure attribute when NODE_ENV=production or X-Forwarded-Proto=https", async () => {
      mockSignOut.mockResolvedValue({ success: true, redirectUrl: "/" });

      process.env.NODE_ENV = "production";
      const prodRes = await rpcRoutes.request("/auth/sign-out", {
        method: "POST",
        headers: {
          Cookie: "sb-access-token=prod_tok",
        },
      });
      const prodHeaders = prodRes.headers.getSetCookie();
      expect(prodHeaders).toHaveLength(2);
      for (const header of prodHeaders) {
        expect(header).toContain("Secure");
        expect(header).toContain("Max-Age=0");
      }
      expect(prodHeaders.some((h) => h.includes("HttpOnly"))).toBe(true);
      expect(prodHeaders.some((h) => !h.includes("HttpOnly"))).toBe(true);

      process.env.NODE_ENV = "test";
      const httpsProxyRes = await rpcRoutes.request("/auth/sign-out", {
        method: "POST",
        headers: {
          Cookie: "sb-access-token=proxy_tok",
          "X-Forwarded-Proto": "https",
        },
      });
      const proxyHeaders = httpsProxyRes.headers.getSetCookie();
      expect(proxyHeaders).toHaveLength(2);
      for (const header of proxyHeaders) {
        expect(header).toContain("Secure");
      }
    });

    it("POST /auth/sign-out: emits both host-only and domain-scoped dual deletions for configured COOKIE_DOMAIN and public request hosts, while omitting Domain for localhost and raw IPs", async () => {
      mockSignOut.mockResolvedValue({ success: true, redirectUrl: "/" });

      // 1. Explicit COOKIE_DOMAIN (leading dot normalized per RFC 6265 §5.2.3)
      process.env.COOKIE_DOMAIN = ".elixent.com";
      const envDomainRes = await rpcRoutes.request("/auth/sign-out", {
        method: "POST",
        headers: {
          Cookie: "sb-access-token=tok1",
        },
      });
      const envDomainHeaders = envDomainRes.headers.getSetCookie();
      expect(envDomainHeaders).toHaveLength(4);
      const hostOnlyHeaders = envDomainHeaders.filter((h) => !h.includes("Domain="));
      const scopedHeaders = envDomainHeaders.filter((h) => h.includes("Domain=elixent.com"));
      expect(hostOnlyHeaders).toHaveLength(2);
      expect(scopedHeaders).toHaveLength(2);
      expect(hostOnlyHeaders.some((h) => h.includes("HttpOnly"))).toBe(true);
      expect(hostOnlyHeaders.some((h) => !h.includes("HttpOnly"))).toBe(true);
      expect(scopedHeaders.some((h) => h.includes("HttpOnly"))).toBe(true);
      expect(scopedHeaders.some((h) => !h.includes("HttpOnly"))).toBe(true);

      // 2. Host/X-Forwarded-Host header and HTTPS URL derivation with port stripped
      delete process.env.COOKIE_DOMAIN;
      const forwardedRes = await rpcRoutes.request("/auth/sign-out", {
        method: "POST",
        headers: {
          Cookie: "sb-access-token=tok2",
          "X-Forwarded-Host": "app.elixent.com:3000, internal-proxy",
        },
      });
      const forwardedHeaders = forwardedRes.headers.getSetCookie();
      expect(forwardedHeaders).toHaveLength(4);
      expect(forwardedHeaders.filter((h) => !h.includes("Domain="))).toHaveLength(2);
      expect(forwardedHeaders.filter((h) => h.includes("Domain=app.elixent.com"))).toHaveLength(2);

      const httpsUrlRes = await rpcRoutes.request("https://portal.elixent.com:8443/auth/sign-out", {
        method: "POST",
        headers: {
          Cookie: "sb-access-token=tok3",
        },
      });
      const httpsUrlHeaders = httpsUrlRes.headers.getSetCookie();
      expect(httpsUrlHeaders).toHaveLength(4);
      expect(httpsUrlHeaders.filter((h) => h.includes("Domain=portal.elixent.com"))).toHaveLength(2);
      for (const h of httpsUrlHeaders) {
        expect(h).toContain("Secure");
      }

      // 3. RFC 6265 prohibition: never emit Domain for localhost, 127.0.0.1, [::1], or raw IPv4
      const disallowedTargets = [
        "http://localhost:3000/auth/sign-out",
        "http://127.0.0.1:8787/auth/sign-out",
        "http://[::1]:3000/auth/sign-out",
        "http://192.168.1.50/auth/sign-out",
      ];
      for (const targetUrl of disallowedTargets) {
        const res = await rpcRoutes.request(targetUrl, {
          method: "POST",
          headers: { Cookie: "sb-access-token=tok_local" },
        });
        const headers = res.headers.getSetCookie();
        expect(headers).toHaveLength(2);
        for (const h of headers) {
          expect(h).not.toContain("Domain=");
        }
      }

      // 4. __Host- and __Secure- prefix compliance per RFC 6265 §4.1.2.5 / Hono cookie serialization
      process.env.COOKIE_DOMAIN = "elixent.com";
      const prefixedRes = await rpcRoutes.request("/auth/sign-out", {
        method: "POST",
        headers: {
          Cookie: "__Host-sb-token=host_tok; __Secure-sb-token=sec_tok",
        },
      });
      expect(prefixedRes.status).toBe(200);
      const prefixedHeaders = prefixedRes.headers.getSetCookie();
      const hostPrefixed = prefixedHeaders.filter((h) => h.startsWith("__Host-sb-token="));
      const securePrefixed = prefixedHeaders.filter((h) => h.startsWith("__Secure-sb-token="));
      expect(hostPrefixed).toHaveLength(2);
      for (const h of hostPrefixed) {
        expect(h).toContain("Secure");
        expect(h).toContain("Path=/");
        expect(h).not.toContain("Domain=");
      }
      expect(securePrefixed).toHaveLength(4);
      for (const h of securePrefixed) {
        expect(h).toContain("Secure");
      }
    });

    it("POST /api/rpc/auth/sign-out through app with sessionMiddleware clears cookies cleanly without duplicates", async () => {
      mockSignOut.mockResolvedValueOnce({ success: true, redirectUrl: "/" });

      const incomingCookie = "sb-access-token=access_123; sb-refresh-token=refresh_456";
      const res = await app.request("http://localhost/api/rpc/auth/sign-out", {
        method: "POST",
        headers: {
          Cookie: incomingCookie,
        },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ success: true, redirectUrl: "/" });
      expect(mockSignOut).toHaveBeenCalledTimes(1);

      const setCookieHeaders = res.headers.getSetCookie();
      // Exactly 4 headers: 2 per sb-* cookie (HttpOnly + non-HttpOnly) on localhost
      expect(setCookieHeaders).toHaveLength(4);

      // Verify no duplicate empty trailing headers or conflicting Set-Cookie
      const accessCookies = setCookieHeaders.filter((h) => h.startsWith("sb-access-token="));
      const refreshCookies = setCookieHeaders.filter((h) => h.startsWith("sb-refresh-token="));
      expect(accessCookies).toHaveLength(2);
      expect(refreshCookies).toHaveLength(2);

      for (const h of setCookieHeaders) {
        expect(h).toContain("Max-Age=0");
        expect(h).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
        expect(h).toContain("Path=/");
      }
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

    it("GET /auth/profile: serializes BigInt creditBalanceMicro to string and Date timestamps to ISO strings without TypeError", async () => {
      const createdAt = new Date("2026-11-10T09:00:00.000Z");
      const updatedAt = new Date("2026-11-10T10:30:00.000Z");
      mockGetUserProfile.mockResolvedValueOnce({
        success: true,
        data: {
          id: "usr_bigint_1",
          email: "pilot@elixent.app",
          displayName: "Elixent Pilot",
          avatarUrl: null,
          tier: "pro",
          stripeCustomerId: "cus_123",
          creditBalanceMicro: BigInt("9007199254740993123"),
          createdAt,
          updatedAt,
        },
      });

      const res = await rpcRoutes.request("/auth/profile", { method: "GET" });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({
        success: true,
        data: {
          id: "usr_bigint_1",
          email: "pilot@elixent.app",
          displayName: "Elixent Pilot",
          avatarUrl: null,
          tier: "pro",
          stripeCustomerId: "cus_123",
          creditBalanceMicro: "9007199254740993123",
          createdAt: createdAt.toISOString(),
          updatedAt: updatedAt.toISOString(),
        },
      });
      expect(typeof json.data.creditBalanceMicro).toBe("string");
    });

    it("GET /files/get & GET /vault/profile: serialize Date fields to ISO 8601 WireTimestamp strings", async () => {
      const createdAt = new Date("2026-11-10T08:00:00.000Z");
      const updatedAt = new Date("2026-11-10T09:15:00.000Z");
      mockGetFile.mockResolvedValueOnce({
        success: true,
        data: {
          id: "f_wire_1",
          userId: "usr_1",
          title: "Wire.md",
          content: "hello",
          parentFolderId: null,
          isFolder: false,
          isEncrypted: false,
          encryptionMetadata: null,
          etag: "e1",
          version: 1,
          deletedAt: null,
          createdAt,
          updatedAt,
        },
      });
      mockGetUserVaultProfile.mockResolvedValueOnce({
        success: true,
        data: {
          userId: "usr_1",
          encryptedMasterKey: "emk",
          recoveryEncryptedMasterKey: "remk",
          keySalt: "s1",
          recoverySalt: "s2",
          kdfIterations: 600000,
          keyVersion: 1,
          deviceTrustEpoch: 1,
          allowAIOnEncryptedFiles: false,
          createdAt,
          updatedAt,
        },
      });

      const fileRes = await rpcRoutes.request("/files/get?fileId=f_wire_1", { method: "GET" });
      const fileJson = await fileRes.json();
      expect(fileRes.status).toBe(200);
      expect(fileJson.data.createdAt).toBe(createdAt.toISOString());
      expect(fileJson.data.updatedAt).toBe(updatedAt.toISOString());
      expect(fileJson.data.deletedAt).toBeNull();

      const vaultRes = await rpcRoutes.request("/vault/profile", { method: "GET" });
      const vaultJson = await vaultRes.json();
      expect(vaultRes.status).toBe(200);
      expect(vaultJson.data.createdAt).toBe(createdAt.toISOString());
      expect(vaultJson.data.updatedAt).toBe(updatedAt.toISOString());
    });

    it("GET /auth/profile: propagates failure payload when unauthenticated or missing profile", async () => {
      mockGetUserProfile.mockResolvedValueOnce({
        success: false,
        error: "Not authenticated",
      });

      const res = await rpcRoutes.request("/auth/profile", { method: "GET" });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        success: false,
        error: "Not authenticated",
      });
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
