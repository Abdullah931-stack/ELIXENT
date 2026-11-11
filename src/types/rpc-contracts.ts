/**
 * Shared RPC Domain Contracts & Validation Schemas
 *
 * Provides shared data transfer interfaces and Zod schemas for Hono RPC routes
 * and typed client callers with zero Node.js, database, or DOM dependencies.
 */

import { z } from "zod";

// ============================================================================
// Shared Domain & Contract Types (Zero Node/DB/DOM Dependencies)
// ============================================================================

/**
 * Wire-serialized timestamp representation.
 * Over HTTP JSON (`c.json`), PostgreSQL/Drizzle `Date` values serialize to
 * ISO 8601 strings; in-process server or test callers may still pass `Date`.
 */
export type WireTimestamp = string | Date;

export interface FileEncryptionMetadata {
  version: number;
  algorithm: string;
  keyId: string;
  salt: string;
  iv: string;
  kdfIterations?: number;
}

export interface FileRecord {
  id: string;
  userId: string;
  title: string;
  content: string | null;
  parentFolderId: string | null;
  isFolder: boolean;
  isEncrypted: boolean;
  encryptionMetadata: FileEncryptionMetadata | null;
  etag: string | null;
  version: number | null;
  deletedAt: WireTimestamp | null;
  createdAt: WireTimestamp;
  updatedAt: WireTimestamp;
}

export interface VaultProfileRecord {
  userId: string;
  encryptedMasterKey: string;
  recoveryEncryptedMasterKey: string;
  keySalt: string;
  recoverySalt: string;
  kdfIterations: number;
  keyVersion: number;
  deviceTrustEpoch?: number;
  allowAIOnEncryptedFiles?: boolean;
  createdAt: WireTimestamp;
  updatedAt: WireTimestamp;
}

export interface UserProfileRecord {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  tier: "free" | "pro" | "ultra";
  stripeCustomerId: string | null;
  /** Decimal string serialization of `bigint` micro-credits over JSON wire. */
  creditBalanceMicro: string;
  createdAt: WireTimestamp;
  updatedAt: WireTimestamp;
}

export interface FileOpResult<T = FileRecord> {
  success: boolean;
  data?: T;
  version?: number;
  error?: string;
  status?: "conflict" | "unauthorized" | "not_found" | "forbidden" | "error";
  etag?: string;
  correlationId?: string;
  operationId?: string;
  statusCode?: number;
  serverVersion?: {
    version?: number | null;
    etag?: string | null;
    updatedAt?: string;
    content?: string | null;
    isEncrypted?: boolean | null;
    encryptionMetadata?: FileEncryptionMetadata | null;
  };
  conflictDetails?: {
    type?: string;
    serverVersion?: number;
    baseVersion?: number;
    yourVersion?: number;
    serverETag?: string;
    message?: string;
    serverContent?: string;
    serverEncryptionMetadata?: FileEncryptionMetadata | null;
  };
}

export interface UpdateFileOptions {
  expectedVersion?: number;
  expectedETag?: string;
  operationId?: string;
}

export interface DeleteFileOptions {
  expectedVersion?: number;
  expectedETag?: string;
}

export interface ImportFileResult {
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
}

export interface ImportEncryptionOptions {
  isEncrypted?: boolean;
  encryptionMetadata?: FileEncryptionMetadata | null;
  fileId?: string;
}

export interface VaultActionResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  status?: "unauthorized" | "not_found" | "conflict" | "error";
}

export interface CreateVaultProfileInput {
  encryptedMasterKey: string;
  recoveryEncryptedMasterKey: string;
  keySalt: string;
  recoverySalt: string;
  kdfIterations?: number;
  keyVersion?: number;
}

export interface UpdateVaultPasswordInput {
  encryptedMasterKey: string;
  keySalt: string;
  kdfIterations?: number;
  proofOfPossession: string;
  proofNonce: string;
}

export interface UpdateVaultRecoveryEnvelopeInput {
  recoveryEncryptedMasterKey: string;
  recoverySalt?: string;
}

// ============================================================================
// Shared Zod Validation Schemas
// ============================================================================

export const uuidStringSchema = z.string().uuid();
export const trimmedTitleSchema = z.string().trim().min(1).max(500);

export const encryptionMetadataSchema = z
  .object({
    version: z.number().int().positive(),
    algorithm: z.string().min(1),
    keyId: z.string().min(1),
    salt: z.string().min(1),
    iv: z.string().min(1),
    kdfIterations: z.number().int().min(600_000).optional(),
  })
  .strict();

export const updateFileOptionsSchema = z.object({
  expectedVersion: z.number().optional(),
  expectedETag: z.string().optional(),
  operationId: z.string().optional(),
});

export const deleteFileOptionsSchema = z.object({
  expectedVersion: z.number().optional(),
  expectedETag: z.string().optional(),
});

export const encryptedOverrideSchema = z
  .object({
    newFileId: z.string().optional(),
    content: z.string().optional(),
    encryptionMetadata: encryptionMetadataSchema.nullable().optional(),
  })
  .strict()
  .pipe(
    z
      .object({
        newFileId: uuidStringSchema,
        content: z.string().min(1),
        encryptionMetadata: encryptionMetadataSchema,
      })
      .strict()
  );

export const importEncryptionSchema = z.object({
  isEncrypted: z.boolean().optional(),
  encryptionMetadata: encryptionMetadataSchema.nullable().optional(),
  fileId: z.string().optional(),
});

export const createVaultProfileSchema = z.object({
  encryptedMasterKey: z.string(),
  recoveryEncryptedMasterKey: z.string(),
  keySalt: z.string(),
  recoverySalt: z.string(),
  kdfIterations: z.number().optional(),
  keyVersion: z.number().optional(),
});

export const updateVaultPasswordSchema = z.object({
  encryptedMasterKey: z.string(),
  keySalt: z.string(),
  kdfIterations: z.number().optional(),
  proofOfPossession: z.string(),
  proofNonce: z.string(),
});

export const updateVaultRecoveryEnvelopeSchema = z.object({
  recoveryEncryptedMasterKey: z.string(),
  recoverySalt: z.string().optional(),
});
