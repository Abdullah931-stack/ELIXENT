/**
 * Loopback Integration Test Suite: Real Hono RPC Wiring
 * (`src/test/client/ui-rpc-wiring.integration.test.ts`)
 *
 * Verifies end-to-end client-to-server roundtrips without mocking `@/client/rpc-client`:
 * 1. Auth routes (`/api/rpc/auth/profile`, `/api/rpc/auth/sign-out`).
 * 2. Files routes (`/api/rpc/files/get`, `/api/rpc/files/create`, `/api/rpc/files/encryption`).
 * 3. Vault profile routes (`/api/rpc/vault/profile`).
 * 4. Error shapes, HTTP status codes, Zod schema validation boundaries, and JSON wire serialization.
 * 5. Full client-to-server roundtrips through typed RPC facades using active vitestLoopbackFetch.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { hc } from "hono/client";
import type { AppType } from "@/server/app";
import { vitestLoopbackFetch } from "../../../vitest.setup";
import {
  getUserProfile,
  signOut,
  getFile,
  createFile,
  toggleFileEncryption,
  getUserVaultProfile,
  setRpcClientFetch,
  createElixentRpcClient,
} from "@/client/rpc-client";
import type {
  FileRecord,
  FileOpResult,
  VaultProfileRecord,
  VaultActionResult,
  UserProfileRecord,
} from "@/types/rpc-contracts";

// ---------------------------------------------------------------------------
// Server Action & Dependency Boundary Mocks (Behind Hono app.fetch)
// ---------------------------------------------------------------------------

const {
  mockServerGetUserProfile,
  mockServerSignOut,
  mockServerGetFile,
  mockServerCreateFile,
  mockServerToggleFileEncryption,
  mockServerGetUserVaultProfile,
  mockServerGetUser,
} = vi.hoisted(() => ({
  mockServerGetUserProfile: vi.fn(),
  mockServerSignOut: vi.fn(),
  mockServerGetFile: vi.fn(),
  mockServerCreateFile: vi.fn(),
  mockServerToggleFileEncryption: vi.fn(),
  mockServerGetUserVaultProfile: vi.fn(),
  mockServerGetUser: vi.fn(),
}));

vi.mock("@/server/actions/auth-actions", () => ({
  getUserProfile: () => mockServerGetUserProfile(),
  signOut: () => mockServerSignOut(),
  signInWithGoogle: vi.fn(),
  syncUserToDatabase: vi.fn(),
  updateUserProfile: vi.fn(),
}));

vi.mock("@/server/actions/files", () => ({
  getFile: (...args: unknown[]) => mockServerGetFile(...args),
  createFile: (...args: unknown[]) => mockServerCreateFile(...args),
  toggleFileEncryption: (...args: unknown[]) => mockServerToggleFileEncryption(...args),
  updateFileContent: vi.fn(),
  renameFile: vi.fn(),
  deleteFile: vi.fn(),
  restoreFile: vi.fn(),
  copyFile: vi.fn(),
  getUserFiles: vi.fn(),
  getRootFiles: vi.fn(),
  getDeletedFiles: vi.fn(),
}));

vi.mock("@/server/actions/vault-actions", () => ({
  getUserVaultProfile: () => mockServerGetUserVaultProfile(),
  createUserVaultProfile: vi.fn(),
  updateVaultPassword: vi.fn(),
  updateVaultRecoveryEnvelope: vi.fn(),
  revokeAllTrustedDevices: vi.fn(),
  updateVaultAISetting: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  getUser: () => mockServerGetUser(),
  createClient: vi.fn(async () => ({
    auth: {
      getUser: () => mockServerGetUser(),
    },
  })),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(
    (
      _url: string,
      _key: string,
      options: {
        cookies: {
          getAll: () => Array<{ name: string; value: string }>;
          setAll: (
            c: Array<{
              name: string;
              value: string;
              options?: Record<string, unknown>;
            }>
          ) => void;
        };
      }
    ) => ({
      auth: {
        getUser: async () => {
          options?.cookies?.getAll?.();
          return { data: { user: await mockServerGetUser() }, error: null };
        },
        signOut: async () => {
          options?.cookies?.getAll?.();
          return { error: null };
        },
      },
    })
  ),
}));

describe("Real Loopback Hono RPC Client Wiring (hc<AppType> -> master app.fetch)", () => {
  const client = hc<AppType>("http://localhost", { fetch: vitestLoopbackFetch });
  const fixedIso = "2026-01-01T00:00:00.000Z";

  beforeAll(async () => {
    // Pre-warm master Hono app to absorb module graph compilation overhead on Windows
    await import("@/server/app");
  }, 60000);

  beforeEach(() => {
    vi.clearAllMocks();
    setRpcClientFetch(vitestLoopbackFetch);
    mockServerGetUser.mockResolvedValue({ id: "user-wire-test", email: "wire@elixent.ai" });
  });

  // ==========================================================================
  // 1. Auth routes round-trip
  // ==========================================================================

  describe("1. Auth Routes (/api/rpc/auth/*)", () => {
    it("round-trips GET /api/rpc/auth/profile and serializes decimal credit balance", async () => {
      mockServerGetUserProfile.mockResolvedValueOnce({
        success: true,
        data: {
          id: "user-wire-test",
          email: "wire@elixent.ai",
          displayName: "Wire Tester",
          avatarUrl: null,
          tier: "pro",
          stripeCustomerId: "cus_wire_123",
          creditBalanceMicro: "750000000",
          createdAt: fixedIso,
          updatedAt: fixedIso,
        },
      } satisfies { success: true; data: UserProfileRecord });

      const res = await client.api.rpc.auth.profile.$get();
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: true; data: UserProfileRecord } | { success: false; error: string };
      expect(json.success).toBe(true);
      if (!json.success) throw new Error("Expected success: true");
      expect(json.data.id).toBe("user-wire-test");
      expect(json.data.email).toBe("wire@elixent.ai");
      expect(json.data.creditBalanceMicro).toBe("750000000");

      // Verify facade layer parity
      mockServerGetUserProfile.mockResolvedValueOnce({
        success: true,
        data: {
          id: "user-wire-test",
          email: "wire@elixent.ai",
          displayName: "Wire Tester",
          avatarUrl: null,
          tier: "pro",
          stripeCustomerId: "cus_wire_123",
          creditBalanceMicro: "750000000",
          createdAt: fixedIso,
          updatedAt: fixedIso,
        },
      });
      const facadeResult = await getUserProfile();
      expect(facadeResult.success).toBe(true);
      expect(facadeResult.data?.creditBalanceMicro).toBe("750000000");
    });

    it("round-trips POST /api/rpc/auth/sign-out and processes RFC 6265 cookie invalidation", async () => {
      mockServerSignOut.mockResolvedValueOnce({
        success: true,
        redirectUrl: "/",
      });

      const res = await client.api.rpc.auth["sign-out"].$post(
        {},
        {
          headers: {
            Cookie: "sb-access-token=jwt-wire-token; app-theme=dark",
          },
        }
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ success: true, redirectUrl: "/" });

      const setCookies = res.headers.getSetCookie();
      expect(setCookies.length).toBeGreaterThanOrEqual(1);
      expect(setCookies.some((c) => c.startsWith("sb-access-token="))).toBe(true);
      expect(setCookies.some((c) => c.includes("Max-Age=0"))).toBe(true);

      // Verify facade layer parity
      mockServerSignOut.mockResolvedValueOnce({ success: true, redirectUrl: "/" });
      const facadeSignOut = await signOut();
      expect(facadeSignOut).toEqual({ success: true, redirectUrl: "/" });
    });
  });

  // ==========================================================================
  // 2. Files routes round-trip
  // ==========================================================================

  describe("2. Files Routes (/api/rpc/files/*)", () => {
    const mockFile: FileRecord = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      userId: "user-wire-test",
      title: "Architecture.md",
      content: "# System Architecture",
      parentFolderId: null,
      isFolder: false,
      isEncrypted: false,
      encryptionMetadata: null,
      etag: "w-etag-wire-1",
      version: 1,
      deletedAt: null,
      createdAt: fixedIso,
      updatedAt: fixedIso,
    };

    it("round-trips POST /api/rpc/files/get and handles missing file with contract error shape", async () => {
      mockServerGetFile.mockResolvedValueOnce({
        success: true,
        data: mockFile,
      } satisfies FileOpResult<FileRecord>);

      const res = await client.api.rpc.files.get.$post({
        json: { fileId: mockFile.id },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileOpResult<FileRecord>;
      expect(json.success).toBe(true);
      expect(json.data?.id).toBe(mockFile.id);
      expect(json.data?.title).toBe("Architecture.md");

      // Verify not found error contract round-trip
      mockServerGetFile.mockResolvedValueOnce({
        success: false,
        status: "not_found",
        error: "File not found",
      } satisfies FileOpResult);

      const notFoundRes = await client.api.rpc.files.get.$post({
        json: { fileId: "non-existent-id" },
      });
      expect(notFoundRes.status).toBe(200);
      const notFoundJson = (await notFoundRes.json()) as FileOpResult;
      expect(notFoundJson.success).toBe(false);
      expect(notFoundJson.status).toBe("not_found");
      expect(notFoundJson.error).toBe("File not found");

      // Verify facade layer parity
      mockServerGetFile.mockResolvedValueOnce({ success: true, data: mockFile });
      const facadeFile = await getFile(mockFile.id);
      expect(facadeFile.success).toBe(true);
      expect(facadeFile.data?.title).toBe("Architecture.md");
    });

    it("enforces HTTP 400 validation error on malformed payload for POST /api/rpc/files/get", async () => {
      const badRes = await client.api.rpc.files.get.$post({
        json: { fileId: 12345 as unknown as string },
      });

      expect(badRes.status).toBe(400);
      const errJson = await badRes.json();
      expect(errJson.success).toBe(false);
      expect(errJson.error).toBeDefined();
    });

    it("round-trips POST /api/rpc/files/create with title and folder parameters", async () => {
      mockServerCreateFile.mockResolvedValueOnce({
        success: true,
        data: {
          ...mockFile,
          title: "New Specification",
        },
      } satisfies FileOpResult<FileRecord>);

      const res = await client.api.rpc.files.create.$post({
        json: {
          title: "New Specification",
          parentFolderId: null,
          isFolder: false,
        },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileOpResult<FileRecord>;
      expect(json.success).toBe(true);
      expect(json.data?.title).toBe("New Specification");

      // Verify facade layer parity
      mockServerCreateFile.mockResolvedValueOnce({
        success: true,
        data: { ...mockFile, title: "New Specification" },
      });
      const facadeCreated = await createFile("New Specification", null, false);
      expect(facadeCreated.success).toBe(true);
      expect(facadeCreated.data?.title).toBe("New Specification");
    });

    it("enforces HTTP 400 validation error when creating file with blank/empty title", async () => {
      const badCreate = await client.api.rpc.files.create.$post({
        json: {
          title: "   ",
        },
      });

      expect(badCreate.status).toBe(400);
      const json = await badCreate.json();
      expect(json.success).toBe(false);
    });

    it("round-trips POST /api/rpc/files/encryption with rigorous encryption metadata contract", async () => {
      mockServerToggleFileEncryption.mockResolvedValueOnce({
        success: true,
        version: 2,
        etag: "w-etag-enc-2",
      } satisfies FileOpResult);

      const res = await client.api.rpc.files.encryption.$post({
        json: {
          fileId: mockFile.id,
          isEncrypted: true,
          content: "base64-ciphertext-payload",
          encryptionMetadata: {
            version: 1,
            algorithm: "AES-GCM-256",
            keyId: "key-master-1",
            salt: "salt-hex-abc",
            iv: "iv-base64-xyz",
            kdfIterations: 600000,
          },
          options: {
            expectedVersion: 1,
            expectedETag: "w-etag-wire-1",
          },
        },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as FileOpResult;
      expect(json.success).toBe(true);
      expect(json.version).toBe(2);
      expect(json.etag).toBe("w-etag-enc-2");

      // Verify facade layer parity
      mockServerToggleFileEncryption.mockResolvedValueOnce({
        success: true,
        version: 2,
        etag: "w-etag-enc-2",
      });
      const facadeToggle = await toggleFileEncryption(
        mockFile.id,
        true,
        "base64-ciphertext-payload",
        {
          version: 1,
          algorithm: "AES-GCM-256",
          keyId: "key-master-1",
          salt: "salt-hex-abc",
          iv: "iv-base64-xyz",
          kdfIterations: 600000,
        },
        { expectedVersion: 1, expectedETag: "w-etag-wire-1" }
      );
      expect(facadeToggle.success).toBe(true);
      expect(facadeToggle.version).toBe(2);
    });

    it("enforces HTTP 400 validation error when kdfIterations is below security threshold", async () => {
      const badEnc = await client.api.rpc.files.encryption.$post({
        json: {
          fileId: mockFile.id,
          isEncrypted: true,
          content: "ciphertext",
          encryptionMetadata: {
            version: 1,
            algorithm: "AES-GCM-256",
            keyId: "key-1",
            salt: "salt",
            iv: "iv",
            kdfIterations: 1000, // Violates min(600_000)
          },
        },
      });

      expect(badEnc.status).toBe(400);
      const json = await badEnc.json();
      expect(json.success).toBe(false);
    });
  });

  // ==========================================================================
  // 3. Vault profile routes round-trip
  // ==========================================================================

  describe("3. Vault Profile Routes (/api/rpc/vault/*)", () => {
    it("round-trips GET /api/rpc/vault/profile and preserves deviceTrustEpoch and AI flag", async () => {
      mockServerGetUserVaultProfile.mockResolvedValueOnce({
        success: true,
        data: {
          userId: "user-wire-test",
          encryptedMasterKey: "vault-master-key",
          recoveryEncryptedMasterKey: "recovery-envelope",
          keySalt: "salt-vault",
          recoverySalt: "salt-rec",
          kdfIterations: 600000,
          keyVersion: 1,
          deviceTrustEpoch: 5,
          allowAIOnEncryptedFiles: true,
          createdAt: fixedIso,
          updatedAt: fixedIso,
        },
      } satisfies VaultActionResult<VaultProfileRecord>);

      const res = await client.api.rpc.vault.profile.$get();
      expect(res.status).toBe(200);

      const json = (await res.json()) as VaultActionResult<VaultProfileRecord>;
      expect(json.success).toBe(true);
      if (!json.success || !json.data) throw new Error("Expected successful vault profile data");
      expect(json.data.deviceTrustEpoch).toBe(5);
      expect(json.data.allowAIOnEncryptedFiles).toBe(true);

      // Verify facade layer parity
      mockServerGetUserVaultProfile.mockResolvedValueOnce({
        success: true,
        data: {
          userId: "user-wire-test",
          encryptedMasterKey: "vault-master-key",
          recoveryEncryptedMasterKey: "recovery-envelope",
          keySalt: "salt-vault",
          recoverySalt: "salt-rec",
          kdfIterations: 600000,
          keyVersion: 1,
          deviceTrustEpoch: 5,
          allowAIOnEncryptedFiles: true,
          createdAt: fixedIso,
          updatedAt: fixedIso,
        },
      });
      const facadeVault = await getUserVaultProfile();
      expect(facadeVault.success).toBe(true);
      expect(facadeVault.data?.deviceTrustEpoch).toBe(5);
    });

    it("round-trips unauthorized error shape for GET /api/rpc/vault/profile", async () => {
      mockServerGetUserVaultProfile.mockResolvedValueOnce({
        success: false,
        status: "unauthorized",
        error: "Session expired or missing",
      } satisfies VaultActionResult);

      const res = await client.api.rpc.vault.profile.$get();
      expect(res.status).toBe(200);

      const json = (await res.json()) as VaultActionResult;
      expect(json.success).toBe(false);
      expect(json.status).toBe("unauthorized");
      expect(json.error).toBe("Session expired or missing");
    });
  });

  // ==========================================================================
  // 4. Factory and Custom Fetch Binding Integrity
  // ==========================================================================

  describe("4. Factory & Direct Transport Binding", () => {
    it("creates custom RPC client instance bound to vitestLoopbackFetch transport", async () => {
      const customClient = createElixentRpcClient("http://localhost", vitestLoopbackFetch);

      mockServerGetUserProfile.mockResolvedValueOnce({
        success: true,
        data: {
          id: "user-factory-test",
          email: "factory@elixent.ai",
          displayName: "Factory Tester",
          avatarUrl: null,
          tier: "free",
          stripeCustomerId: null,
          creditBalanceMicro: "0",
          createdAt: fixedIso,
          updatedAt: fixedIso,
        },
      });

      const res = await customClient.api.rpc.auth.profile.$get();
      expect(res.status).toBe(200);
      const json = (await res.json()) as { success: true; data: UserProfileRecord } | { success: false; error: string };
      expect(json.success).toBe(true);
      if (!json.success) throw new Error("Expected success: true");
      expect(json.data.email).toBe("factory@elixent.ai");
    });
  });
});
