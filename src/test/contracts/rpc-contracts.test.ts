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

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  encryptionMetadataSchema,
  updateFileOptionsSchema,
  deleteFileOptionsSchema,
  encryptedOverrideSchema,
  importEncryptionSchema,
  createVaultProfileSchema,
  updateVaultPasswordSchema,
  updateVaultRecoveryEnvelopeSchema,
} from "@/types/rpc-contracts";

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
      const { kdfIterations, ...withoutKdf } = validMetadata;
      const result = encryptionMetadataSchema.safeParse(withoutKdf);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.kdfIterations).toBeUndefined();
      }
    });

    it.each([
      ["missing version", { ...validMetadata, version: undefined }],
      ["string version", { ...validMetadata, version: "1" }],
      ["missing algorithm", { ...validMetadata, algorithm: undefined }],
      ["missing keyId", { ...validMetadata, keyId: undefined }],
      ["missing salt", { ...validMetadata, salt: undefined }],
      ["missing iv", { ...validMetadata, iv: undefined }],
      ["string kdfIterations", { ...validMetadata, kdfIterations: "600000" }],
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
    };

    describe("encryptedOverrideSchema", () => {
      it("accepts empty object", () => {
        const result = encryptedOverrideSchema.safeParse({});
        expect(result.success).toBe(true);
      });

      it("accepts complete override payload with metadata", () => {
        const payload = {
          newFileId: "file-new-123",
          content: "encrypted-ciphertext-blob",
          encryptionMetadata: validMeta,
        };
        const result = encryptedOverrideSchema.safeParse(payload);
        expect(result.success).toBe(true);
      });

      it("accepts null encryptionMetadata", () => {
        const payload = {
          newFileId: "file-new-123",
          content: "plain-content",
          encryptionMetadata: null,
        };
        const result = encryptedOverrideSchema.safeParse(payload);
        expect(result.success).toBe(true);
      });

      it("rejects malformed nested encryptionMetadata", () => {
        const payload = {
          encryptionMetadata: { version: "not-a-number" },
        };
        const result = encryptedOverrideSchema.safeParse(payload);
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
        const { kdfIterations, keyVersion, ...minimal } = validCreate;
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
        const { kdfIterations, ...withoutKdf } = validUpdate;
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
});
