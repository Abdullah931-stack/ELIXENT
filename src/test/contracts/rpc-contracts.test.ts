/**
 * Contract & Schema Invariant Test Suite for Shared RPC Contracts (`src/types/rpc-contracts.ts`)
 *
 * Verifies:
 * 1. Zero-Dependency Architectural Invariant:
 *    - `src/types/rpc-contracts.ts` imports exclusively from "zod".
 *    - Zero runtime or compile-time dependencies on Node.js built-ins, `@/server/db`, Drizzle ORM, or DOM.
 * 2. Client Facade Re-Export Parity:
 *    - `src/client/rpc-client.ts` re-exports shared contract types from `src/types/rpc-contracts.ts`.
 * 3. Zod Schema Validation & Boundary Enforcement:
 *    - `encryptionMetadataSchema`: validates complete metadata, allows optional kdfIterations, rejects invalid types and missing required fields.
 *    - `updateFileOptionsSchema`: validates expectedVersion, expectedETag, operationId; allows empty object; rejects invalid types.
 *    - `deleteFileOptionsSchema`: validates expectedVersion, expectedETag; allows empty object; rejects invalid types.
 *    - `encryptedOverrideSchema`: validates newFileId, content, optional encryptionMetadata; rejects malformed metadata.
 *    - `importEncryptionSchema`: validates isEncrypted, fileId, nullable encryptionMetadata; allows empty object.
 *    - `createVaultProfileSchema`: strictly enforces all 4 required keys/salts; accepts optional kdfIterations and keyVersion.
 *    - `updateVaultPasswordSchema`: strictly enforces proofOfPossession, proofNonce, encryptedMasterKey, keySalt.
 *    - `updateVaultRecoveryEnvelopeSchema`: strictly enforces recoveryEncryptedMasterKey; accepts optional recoverySalt.
 */

import { describe, it, expect, expectTypeOf } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { InferResponseType } from "hono";
import { hc } from "hono/client";
import {
  encryptionMetadataSchema,
  updateFileOptionsSchema,
  deleteFileOptionsSchema,
  encryptedOverrideSchema,
  importEncryptionSchema,
  createVaultProfileSchema,
  updateVaultPasswordSchema,
  updateVaultRecoveryEnvelopeSchema,
  uuidStringSchema,
  trimmedTitleSchema,
  type WireTimestamp,
  type FileRecord,
  type VaultProfileRecord,
  type UserProfileRecord,
  type ImportFileResult,
} from "@/types/rpc-contracts";
import type { AppType } from "@/server/app";
import type { AppType as RpcAppType } from "@/server/routes/rpc.routes";

describe("Shared RPC Domain Contracts & Validation Schemas (src/types/rpc-contracts.ts)", () => {
  const projectRoot = path.resolve(__dirname, "../../..");

  // ==========================================================================
  // 1. Architectural & Dependency Invariants
  // ==========================================================================

  describe("1. Zero-Dependency Architectural Invariants", () => {
    it("confirms src/types/rpc-contracts.ts has zero imports other than 'zod'", () => {
      const contractFilePath = path.join(
        projectRoot,
        "src",
        "types",
        "rpc-contracts.ts"
      );
      expect(fs.existsSync(contractFilePath)).toBe(true);

      const source = fs.readFileSync(contractFilePath, "utf-8");
      const importLines = source
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("import "));

      // All import statements must target only 'zod'
      for (const importLine of importLines) {
        expect(importLine).toMatch(/^import\s+.*\s+from\s+["']zod["'];?$/);
      }
      expect(importLines.length).toBe(1);
    });

    it("verifies zero forbidden imports from server db, drizzle, node built-ins, or DOM", () => {
      const contractFilePath = path.join(
        projectRoot,
        "src",
        "types",
        "rpc-contracts.ts"
      );
      const source = fs.readFileSync(contractFilePath, "utf-8");

      const forbiddenTargets = [
        "@/server/db",
        "drizzle-orm",
        "node:",
        "fs",
        "path",
        "crypto",
        "hono",
      ];

      for (const target of forbiddenTargets) {
        const pattern = new RegExp(`from\\s+["']${target}["']`);
        expect(pattern.test(source)).toBe(false);
      }
    });

    it("verifies src/client/rpc-client.ts re-exports all domain contracts from rpc-contracts", () => {
      const clientFilePath = path.join(
        projectRoot,
        "src",
        "client",
        "rpc-client.ts"
      );
      const clientSource = fs.readFileSync(clientFilePath, "utf-8");

      const expectedTypes = [
        "FileEncryptionMetadata",
        "FileRecord",
        "VaultProfileRecord",
        "UserProfileRecord",
        "FileOpResult",
        "UpdateFileOptions",
        "DeleteFileOptions",
        "ImportFileResult",
        "ImportEncryptionOptions",
        "VaultActionResult",
        "CreateVaultProfileInput",
        "UpdateVaultPasswordInput",
        "UpdateVaultRecoveryEnvelopeInput",
      ];

      for (const typeName of expectedTypes) {
        expect(clientSource).toContain(typeName);
      }
      expect(clientSource).toContain('from "@/types/rpc-contracts"');
    });
  });

  // ==========================================================================
  // 2. Encryption Metadata Schema Validation
  // ==========================================================================

  describe("2. encryptionMetadataSchema", () => {
    const validMetadata = {
      version: 1,
      algorithm: "AES-GCM-256",
      keyId: "key-uuid-1",
      salt: "hex-salt-123",
      iv: "hex-iv-456",
      kdfIterations: 600000,
    };

    it("accepts complete valid encryption metadata", () => {
      const result = encryptionMetadataSchema.safeParse(validMetadata);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(validMetadata);
      }
    });

    it("accepts valid metadata when optional kdfIterations is omitted", () => {
      const { kdfIterations: _kdfIterations, ...withoutKdf } = validMetadata;
      const result = encryptionMetadataSchema.safeParse(withoutKdf);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.kdfIterations).toBeUndefined();
      }
    });

    it.each([
      ["missing version", { ...validMetadata, version: undefined }],
      ["string version", { ...validMetadata, version: "1" }],
      ["zero version", { ...validMetadata, version: 0 }],
      ["negative version", { ...validMetadata, version: -1 }],
      ["float version", { ...validMetadata, version: 1.5 }],
      ["missing algorithm", { ...validMetadata, algorithm: undefined }],
      ["empty algorithm string", { ...validMetadata, algorithm: "" }],
      ["missing keyId", { ...validMetadata, keyId: undefined }],
      ["empty keyId string", { ...validMetadata, keyId: "" }],
      ["missing salt", { ...validMetadata, salt: undefined }],
      ["empty salt string", { ...validMetadata, salt: "" }],
      ["missing iv", { ...validMetadata, iv: undefined }],
      ["empty iv string", { ...validMetadata, iv: "" }],
      ["string kdfIterations", { ...validMetadata, kdfIterations: "600000" }],
      ["negative kdfIterations", { ...validMetadata, kdfIterations: -100 }],
      ["sub-minimum kdfIterations", { ...validMetadata, kdfIterations: 599999 }],
      ["fractional kdfIterations", { ...validMetadata, kdfIterations: 600000.5 }],
      ["unknown extra properties (strictness)", { ...validMetadata, extraField: "disallowed" }],
    ])("rejects invalid metadata (%s)", (_, invalidPayload) => {
      const result = encryptionMetadataSchema.safeParse(invalidPayload);
      expect(result.success).toBe(false);
    });
  });

  // ==========================================================================
  // 3. File Options Schemas (Update & Delete)
  // ==========================================================================

  describe("3. updateFileOptionsSchema & deleteFileOptionsSchema", () => {
    describe("updateFileOptionsSchema", () => {
      it("accepts empty object when all fields are omitted", () => {
        const result = updateFileOptionsSchema.safeParse({});
        expect(result.success).toBe(true);
      });

      it("accepts complete options object", () => {
        const payload = {
          expectedVersion: 4,
          expectedETag: 'W/"etag-4"',
          operationId: "op-uuid-888",
        };
        const result = updateFileOptionsSchema.safeParse(payload);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toEqual(payload);
        }
      });

      it.each([
        ["string expectedVersion", { expectedVersion: "4" }],
        ["numeric expectedETag", { expectedETag: 1234 }],
        ["numeric operationId", { operationId: 999 }],
      ])("rejects invalid field types (%s)", (_, invalidPayload) => {
        const result = updateFileOptionsSchema.safeParse(invalidPayload);
        expect(result.success).toBe(false);
      });
    });

    describe("deleteFileOptionsSchema", () => {
      it("accepts empty object when all fields are omitted", () => {
        const result = deleteFileOptionsSchema.safeParse({});
        expect(result.success).toBe(true);
      });

      it("accepts valid options object", () => {
        const payload = {
          expectedVersion: 10,
          expectedETag: 'W/"etag-10"',
        };
        const result = deleteFileOptionsSchema.safeParse(payload);
        expect(result.success).toBe(true);
      });

      it("rejects non-numeric expectedVersion", () => {
        const result = deleteFileOptionsSchema.safeParse({ expectedVersion: "10" });
        expect(result.success).toBe(false);
      });
    });
  });

  // ==========================================================================
  // 4. Encrypted Override & Import Schemas
  // ==========================================================================

  describe("4. encryptedOverrideSchema & importEncryptionSchema", () => {
    const validMeta = {
      version: 1,
      algorithm: "AES-GCM",
      keyId: "k-1",
      salt: "s-1",
      iv: "iv-1",
      kdfIterations: 600000,
    };
    const validUUID = "550e8400-e29b-41d4-a716-446655440000";

    describe("encryptedOverrideSchema", () => {
      it("rejects empty object", () => {
        const result = encryptedOverrideSchema.safeParse({});
        expect(result.success).toBe(false);
      });

      it("accepts complete valid override payload with metadata", () => {
        const payload = {
          newFileId: validUUID,
          content: "encrypted-ciphertext-blob",
          encryptionMetadata: validMeta,
        };
        const result = encryptedOverrideSchema.safeParse(payload);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toEqual(payload);
        }
      });

      it("rejects null encryptionMetadata", () => {
        const payload = {
          newFileId: validUUID,
          content: "plain-content",
          encryptionMetadata: null,
        };
        const result = encryptedOverrideSchema.safeParse(payload);
        expect(result.success).toBe(false);
      });

      it("rejects malformed nested encryptionMetadata", () => {
        const payload = {
          newFileId: validUUID,
          content: "encrypted-ciphertext",
          encryptionMetadata: { version: "not-a-number" },
        };
        const result = encryptedOverrideSchema.safeParse(payload);
        expect(result.success).toBe(false);
      });

      it.each([
        ["missing newFileId", { content: "blob", encryptionMetadata: validMeta }],
        ["non-UUID newFileId", { newFileId: "not-a-uuid", content: "blob", encryptionMetadata: validMeta }],
        ["missing content", { newFileId: validUUID, encryptionMetadata: validMeta }],
        ["empty content", { newFileId: validUUID, content: "", encryptionMetadata: validMeta }],
        ["missing encryptionMetadata", { newFileId: validUUID, content: "blob" }],
        ["extra properties disallowed", { newFileId: validUUID, content: "blob", encryptionMetadata: validMeta, extra: true }],
      ])("rejects partial or malformed payload (%s)", (_, invalidPayload) => {
        const result = encryptedOverrideSchema.safeParse(invalidPayload);
        expect(result.success).toBe(false);
      });
    });

    describe("importEncryptionSchema", () => {
      it("accepts empty object", () => {
        const result = importEncryptionSchema.safeParse({});
        expect(result.success).toBe(true);
      });

      it("accepts full encryption import options", () => {
        const payload = {
          isEncrypted: true,
          fileId: "custom-file-id-5",
          encryptionMetadata: validMeta,
        };
        const result = importEncryptionSchema.safeParse(payload);
        expect(result.success).toBe(true);
      });

      it("accepts null encryptionMetadata with isEncrypted false", () => {
        const payload = {
          isEncrypted: false,
          encryptionMetadata: null,
        };
        const result = importEncryptionSchema.safeParse(payload);
        expect(result.success).toBe(true);
      });

      it("rejects non-boolean isEncrypted", () => {
        const result = importEncryptionSchema.safeParse({ isEncrypted: "true" });
        expect(result.success).toBe(false);
      });
    });
  });

  // ==========================================================================
  // 5. Vault Profile & Password Schemas
  // ==========================================================================

  describe("5. Vault Action Schemas", () => {
    describe("createVaultProfileSchema", () => {
      const validCreate = {
        encryptedMasterKey: "emk_hex_data",
        recoveryEncryptedMasterKey: "remk_hex_data",
        keySalt: "salt_master",
        recoverySalt: "salt_recovery",
        kdfIterations: 600000,
        keyVersion: 1,
      };

      it("accepts valid full payload", () => {
        const result = createVaultProfileSchema.safeParse(validCreate);
        expect(result.success).toBe(true);
      });

      it("accepts payload omitting optional kdfIterations and keyVersion", () => {
        const { kdfIterations: _kdfIterations, keyVersion: _keyVersion, ...minimal } = validCreate;
        const result = createVaultProfileSchema.safeParse(minimal);
        expect(result.success).toBe(true);
      });

      it.each([
        ["missing encryptedMasterKey", { ...validCreate, encryptedMasterKey: undefined }],
        ["missing recoveryEncryptedMasterKey", { ...validCreate, recoveryEncryptedMasterKey: undefined }],
        ["missing keySalt", { ...validCreate, keySalt: undefined }],
        ["missing recoverySalt", { ...validCreate, recoverySalt: undefined }],
      ])("rejects payload when required field is missing (%s)", (_, invalidPayload) => {
        const result = createVaultProfileSchema.safeParse(invalidPayload);
        expect(result.success).toBe(false);
      });
    });

    describe("updateVaultPasswordSchema", () => {
      const validUpdate = {
        encryptedMasterKey: "new_emk",
        keySalt: "new_salt",
        kdfIterations: 600000,
        proofOfPossession: "sig_signature",
        proofNonce: "nonce_1234567890",
      };

      it("accepts complete valid password update payload", () => {
        const result = updateVaultPasswordSchema.safeParse(validUpdate);
        expect(result.success).toBe(true);
      });

      it("accepts payload omitting optional kdfIterations", () => {
        const { kdfIterations: _kdfIterations, ...withoutKdf } = validUpdate;
        const result = updateVaultPasswordSchema.safeParse(withoutKdf);
        expect(result.success).toBe(true);
      });

      it.each([
        ["missing proofOfPossession", { ...validUpdate, proofOfPossession: undefined }],
        ["missing proofNonce", { ...validUpdate, proofNonce: undefined }],
        ["missing encryptedMasterKey", { ...validUpdate, encryptedMasterKey: undefined }],
        ["missing keySalt", { ...validUpdate, keySalt: undefined }],
      ])("rejects payload when required field is missing (%s)", (_, invalidPayload) => {
        const result = updateVaultPasswordSchema.safeParse(invalidPayload);
        expect(result.success).toBe(false);
      });
    });

    describe("updateVaultRecoveryEnvelopeSchema", () => {
      it("accepts payload with recoveryEncryptedMasterKey and optional recoverySalt", () => {
        const payload = {
          recoveryEncryptedMasterKey: "new_remk",
          recoverySalt: "new_salt",
        };
        const result = updateVaultRecoveryEnvelopeSchema.safeParse(payload);
        expect(result.success).toBe(true);
      });

      it("accepts payload without optional recoverySalt", () => {
        const result = updateVaultRecoveryEnvelopeSchema.safeParse({
          recoveryEncryptedMasterKey: "new_remk_only",
        });
        expect(result.success).toBe(true);
      });

      it("rejects missing recoveryEncryptedMasterKey", () => {
        const result = updateVaultRecoveryEnvelopeSchema.safeParse({
          recoverySalt: "salt_only",
        });
        expect(result.success).toBe(false);
      });
    });
  });

  // ==========================================================================
  // 6. Wire Serialization Contracts (DEF-A07: WireTimestamp & BigInt String)
  // ==========================================================================

  describe("6. Wire Serialization Contracts (DEF-A07)", () => {
    it("accepts both ISO 8601 strings and Date instances for WireTimestamp fields", () => {
      const isoValue: WireTimestamp = "2026-11-10T10:00:00.000Z";
      const dateValue: WireTimestamp = new Date("2026-11-10T10:00:00.000Z");

      expect(typeof isoValue).toBe("string");
      expect(dateValue).toBeInstanceOf(Date);
      expectTypeOf<FileRecord["createdAt"]>().toEqualTypeOf<WireTimestamp>();
      expectTypeOf<FileRecord["updatedAt"]>().toEqualTypeOf<WireTimestamp>();
      expectTypeOf<FileRecord["deletedAt"]>().toEqualTypeOf<WireTimestamp | null>();
      expectTypeOf<VaultProfileRecord["createdAt"]>().toEqualTypeOf<WireTimestamp>();
      expectTypeOf<VaultProfileRecord["updatedAt"]>().toEqualTypeOf<WireTimestamp>();
      expectTypeOf<UserProfileRecord["createdAt"]>().toEqualTypeOf<WireTimestamp>();
      expectTypeOf<UserProfileRecord["updatedAt"]>().toEqualTypeOf<WireTimestamp>();
      expectTypeOf<UserProfileRecord["creditBalanceMicro"]>().toEqualTypeOf<string>();
    });

    it("matches FileRecord contract across JSON.parse(JSON.stringify(...)) wire roundtrip", () => {
      const createdAt = new Date("2026-11-10T08:15:00.000Z");
      const updatedAt = new Date("2026-11-10T09:30:00.000Z");
      const deletedAt = new Date("2026-11-10T10:45:00.000Z");

      const serverFile: FileRecord = {
        id: "f_wire_1",
        userId: "u_wire_1",
        title: "Wire Note.md",
        content: "# Content",
        parentFolderId: null,
        isFolder: false,
        isEncrypted: false,
        encryptionMetadata: null,
        etag: "etag-wire-1",
        version: 3,
        deletedAt,
        createdAt,
        updatedAt,
      };

      const wireFile: FileRecord = JSON.parse(JSON.stringify(serverFile));

      expect(typeof wireFile.createdAt).toBe("string");
      expect(typeof wireFile.updatedAt).toBe("string");
      expect(typeof wireFile.deletedAt).toBe("string");
      expect(wireFile.createdAt).toBe(createdAt.toISOString());
      expect(wireFile.updatedAt).toBe(updatedAt.toISOString());
      expect(wireFile.deletedAt).toBe(deletedAt.toISOString());
    });

    it("matches VaultProfileRecord contract across JSON.parse(JSON.stringify(...)) wire roundtrip", () => {
      const createdAt = new Date("2026-11-10T07:00:00.000Z");
      const updatedAt = new Date("2026-11-10T07:30:00.000Z");

      const serverProfile: VaultProfileRecord = {
        userId: "u_wire_1",
        encryptedMasterKey: "emk_wire",
        recoveryEncryptedMasterKey: "remk_wire",
        keySalt: "salt_k",
        recoverySalt: "salt_r",
        kdfIterations: 600000,
        keyVersion: 1,
        deviceTrustEpoch: 2,
        allowAIOnEncryptedFiles: false,
        createdAt,
        updatedAt,
      };

      const wireProfile: VaultProfileRecord = JSON.parse(JSON.stringify(serverProfile));

      expect(typeof wireProfile.createdAt).toBe("string");
      expect(typeof wireProfile.updatedAt).toBe("string");
      expect(wireProfile.createdAt).toBe(createdAt.toISOString());
      expect(wireProfile.updatedAt).toBe(updatedAt.toISOString());
    });

    it("matches UserProfileRecord contract with string creditBalanceMicro preserving high-precision BigInt values", () => {
      const balanceMicro = BigInt("9007199254740993123");
      const createdAt = new Date("2026-11-10T06:00:00.000Z");
      const updatedAt = new Date("2026-11-10T06:45:00.000Z");

      const serializedUser: UserProfileRecord = {
        id: "u_wire_1",
        email: "pilot@elixent.app",
        displayName: "Pilot",
        avatarUrl: null,
        tier: "pro",
        stripeCustomerId: "cus_wire_1",
        creditBalanceMicro: balanceMicro.toString(),
        createdAt,
        updatedAt,
      };

      const wireUser: UserProfileRecord = JSON.parse(JSON.stringify(serializedUser));

      expect(typeof wireUser.creditBalanceMicro).toBe("string");
      expect(wireUser.creditBalanceMicro).toBe("9007199254740993123");
      expect(typeof wireUser.createdAt).toBe("string");
      expect(typeof wireUser.updatedAt).toBe("string");
      expect(wireUser.createdAt).toBe(createdAt.toISOString());
      expect(wireUser.updatedAt).toBe(updatedAt.toISOString());
    });

    it("matches ImportFileResult wire contract shape produced by importFile action", () => {
      const importSuccess: ImportFileResult = {
        success: true,
        data: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          title: "Imported Document",
          content: "# Hello World",
          wordCount: 2,
          version: 1,
          etag: "etag-import-1",
        },
      };

      const wireImport: ImportFileResult = JSON.parse(JSON.stringify(importSuccess));

      expect(wireImport.success).toBe(true);
      expect(wireImport.data?.id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(wireImport.data?.wordCount).toBe(2);
      expectTypeOf<ImportFileResult>().toEqualTypeOf<{
        success: boolean;
        data?: {
          id: string;
          title: string;
          content: string;
          wordCount: number;
          version: number;
          etag: string;
        };
        error?: string;
      }>();
    });
  });

  // ==========================================================================
  // 7. Reusable Schemas (uuidStringSchema & trimmedTitleSchema)
  // ==========================================================================

  describe("7. Reusable Validation Schemas (uuidStringSchema & trimmedTitleSchema)", () => {
    describe("uuidStringSchema", () => {
      it("accepts valid RFC 4122 UUID v4 strings", () => {
        const valid = "550e8400-e29b-41d4-a716-446655440000";
        const result = uuidStringSchema.safeParse(valid);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBe(valid);
        }
      });

      it.each([
        ["empty string", ""],
        ["non-uuid alphanumeric", "abc-123-def"],
        ["too short", "550e8400-e29b-41d4-a716"],
        ["numeric", 12345],
        ["null", null],
        ["undefined", undefined],
      ])("rejects invalid UUID string (%s)", (_, invalidValue) => {
        const result = uuidStringSchema.safeParse(invalidValue);
        expect(result.success).toBe(false);
      });
    });

    describe("trimmedTitleSchema", () => {
      it("accepts and trims valid title", () => {
        const result = trimmedTitleSchema.safeParse("  Important Note  ");
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBe("Important Note");
        }
      });

      it("accepts single character title", () => {
        const result = trimmedTitleSchema.safeParse("A");
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBe("A");
        }
      });

      it("accepts max 500 characters title", () => {
        const maxTitle = "a".repeat(500);
        const result = trimmedTitleSchema.safeParse(maxTitle);
        expect(result.success).toBe(true);
      });

      it.each([
        ["empty string", ""],
        ["whitespace only", "     \t\n  "],
        ["exceeds 500 characters", "a".repeat(501)],
        ["numeric type", 42],
        ["null", null],
      ])("rejects invalid title (%s)", (_, invalidValue) => {
        const result = trimmedTitleSchema.safeParse(invalidValue);
        expect(result.success).toBe(false);
      });
    });
  });

  // ==========================================================================
  // 8. AppType Strict JSON Serialization & BigInt-Free Invariant (FIND-07)
  // ==========================================================================

  describe("8. AppType BigInt-Free Invariant (FIND-07)", () => {
    it("statically proves AppType contains zero bigint fields in its responses", () => {
      type RpcClient = ReturnType<typeof hc<AppType>>;

      // 1. Explicitly verify routes prone to BigInt leakage (FIND-07) serialize to string
      type ProfileResponse = InferResponseType<RpcClient["api"]["rpc"]["auth"]["profile"]["$get"], 200>;
      expectTypeOf<ProfileResponse>().not.toMatchTypeOf<{ data?: { creditBalanceMicro: bigint } }>();
      expectTypeOf<ProfileResponse>().toMatchTypeOf<{
        success: boolean;
        data?: {
          creditBalanceMicro?: string;
        };
      }>();

      type BillingResponse = InferResponseType<RpcClient["api"]["rpc"]["billing"]["credit-balance"]["$get"], 200>;
      expectTypeOf<BillingResponse>().not.toMatchTypeOf<{ balanceMicro: bigint }>();
      expectTypeOf<BillingResponse>().toMatchTypeOf<{
        success: true;
        balanceMicro: string;
      }>();

      type ImportResponse = InferResponseType<RpcClient["api"]["rpc"]["files"]["import"]["$post"], 200>;
      expectTypeOf<ImportResponse>().not.toMatchTypeOf<{ creditBalanceMicro: bigint }>();

      // 2. Direct property-level verification that route response types exclude bigint
      type Prev = [never, 0, 1, 2, 3, 4];

      type CheckPayload<T, Depth extends number = 4> = [Depth] extends [never]
        ? false
        : T extends bigint
        ? true
        : T extends (...args: unknown[]) => unknown
        ? false
        : T extends readonly (infer U)[]
        ? CheckPayload<U, Prev[Depth]>
        : T extends object
        ? true extends { [K in keyof T]: CheckPayload<T[K], Prev[Depth]> }[keyof T]
          ? true
          : false
        : false;

      type AssertNoBigInt<T> = CheckPayload<T> extends false ? true : false;

      expectTypeOf<AssertNoBigInt<ProfileResponse>>().toEqualTypeOf<true>();
      expectTypeOf<AssertNoBigInt<BillingResponse>>().toEqualTypeOf<true>();
      expectTypeOf<AssertNoBigInt<ImportResponse>>().toEqualTypeOf<true>();

      // Verify rpcRoutes export AppType alias
      expectTypeOf<RpcAppType>().toBeObject();
    });
  });
});
