/**
 * Encrypted Checkpoint Serializer for Elixent Native Graph Engine Checkpoints
 *
 * Provides zero-knowledge, authenticated encryption (`AES-256-GCM`) for
 * `AgentGraphState` checkpoints persisted into PostgreSQL `agent_checkpoints.encrypted_state_blob`.
 *
 * Key Capabilities & Invariants:
 * 1. Authenticated Encryption: Derives a 256-bit AES key via HKDF-SHA-256 and encrypts
 *    serialized checkpoints using a 12-byte random IV, 16-byte authentication tag, and
 *    Additional Authenticated Data (AAD) bound to the inner serialization type.
 * 2. Zero-Knowledge Leak Assertion: Inspects serialized payloads prior to encryption, verifying
 *    that no active decrypted ephemeral vault plaintexts (>= 4 characters) appear outside of
 *    opaque `vault_ref://` pointers. Violations throw `CheckpointVaultLeakError`.
 */

import crypto from "node:crypto";
import type { AgentGraphState } from "@/core/agent/state";
import { getActiveEphemeralVaultPlaintexts } from "@/lib/vault/ephemeral-memory-map";

/**
 * Standard error thrown when raw vault plaintext is detected within serialized checkpoint data.
 */
export class CheckpointVaultLeakError extends Error {
  readonly code = "VAULT_PLAINTEXT_LEAK_DETECTED" as const;

  constructor(
    message = "Security Violation: Checkpoint serialization contains raw vault plaintext outside vault_ref:// pointers",
  ) {
    super(message);
    this.name = "CheckpointVaultLeakError";
    Object.setPrototypeOf(this, CheckpointVaultLeakError.prototype);
  }
}

/**
 * Serialization envelope format for AES-256-GCM encrypted checkpoints.
 */
export interface EncryptedCheckpointEnvelope {
  __elixentEncrypted: true;
  v: 1;
  alg: "AES-256-GCM";
  innerType: string;
  iv: string; // Base64 encoded 12-byte initialization vector
  tag: string; // Base64 encoded 16-byte GCM authentication tag
  ct: string; // Base64 encoded ciphertext
}

/**
 * Configuration options for checkpoint encryption and decryption.
 */
export interface EncryptedCheckpointSerializerOptions {
  /**
   * Master secret key material used for HKDF key derivation.
   * If omitted, falls back to environment variables (`CHECKPOINT_ENCRYPTION_KEY`, `AUTH_SECRET`, or `NEXTAUTH_SECRET`).
   */
  secretKey?: string | Uint8Array;

  /**
   * HKDF info context string. Defaults to `"elixent:v1:checkpoint-encryption"`.
   */
  hkdfInfo?: string;

  /**
   * HKDF salt. Defaults to 32 bytes of zeros per RFC 5869.
   */
  hkdfSalt?: Uint8Array;
}

/**
 * Type guard validating whether a value conforms to `EncryptedCheckpointEnvelope`.
 */
export function isEncryptedCheckpointEnvelope(
  value: unknown,
): value is EncryptedCheckpointEnvelope {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.__elixentEncrypted === true &&
    candidate.v === 1 &&
    candidate.alg === "AES-256-GCM" &&
    typeof candidate.innerType === "string" &&
    typeof candidate.iv === "string" &&
    typeof candidate.tag === "string" &&
    typeof candidate.ct === "string"
  );
}

/**
 * Derives a 256-bit AES key using HKDF-SHA-256 from options or environment secrets.
 */
function deriveCheckpointKey(
  options?: EncryptedCheckpointSerializerOptions,
): Buffer {
  let rawKey: string | Uint8Array;
  if (options?.secretKey) {
    rawKey = options.secretKey;
  } else {
    const envSecret =
      process.env.CHECKPOINT_ENCRYPTION_KEY ||
      process.env.AUTH_SECRET ||
      process.env.NEXTAUTH_SECRET;

    if (envSecret) {
      rawKey = envSecret;
    } else if (process.env.NODE_ENV === "production") {
      throw new Error(
        "Security Violation: Missing checkpoint encryption key in production environment. CHECKPOINT_ENCRYPTION_KEY, AUTH_SECRET, or NEXTAUTH_SECRET must be configured.",
      );
    } else {
      rawKey = "elixent-checkpoint-test-master-key";
    }
  }

  const keyMaterial =
    typeof rawKey === "string" ? Buffer.from(rawKey, "utf-8") : rawKey;
  const salt = options?.hkdfSalt
    ? Buffer.from(options.hkdfSalt)
    : Buffer.alloc(32, 0);
  const info = options?.hkdfInfo ?? "elixent:v1:checkpoint-encryption";

  return Buffer.from(crypto.hkdfSync("sha256", keyMaterial, salt, info, 32));
}

/**
 * Asserts that no active ephemeral vault plaintext appears in the serialized payload string.
 *
 * @param content - Serialized string to inspect for plaintext leakage.
 * @throws {CheckpointVaultLeakError} When a leak of active vault plaintext is detected.
 */
export function assertNoVaultPlaintextLeak(content: string): void {
  let activePlaintexts: string[] = [];
  try {
    activePlaintexts = getActiveEphemeralVaultPlaintexts();
  } catch {
    activePlaintexts = [];
  }

  if (!activePlaintexts || activePlaintexts.length === 0) {
    return;
  }

  for (const rawText of activePlaintexts) {
    if (!rawText || typeof rawText !== "string") {
      continue;
    }

    // Vault reference pointers themselves are permitted in checkpoint state
    if (rawText.startsWith("vault_ref://")) {
      continue;
    }

    // Check untrimmed raw text (minimum 4 characters)
    if (rawText.length >= 4) {
      if (content.includes(rawText)) {
        throw new CheckpointVaultLeakError();
      }
      const escapedRaw = JSON.stringify(rawText).slice(1, -1);
      if (escapedRaw.length >= 4 && content.includes(escapedRaw)) {
        throw new CheckpointVaultLeakError();
      }
    }

    // Check trimmed text if differing from raw text
    const trimmed = rawText.trim();
    if (
      trimmed.length >= 4 &&
      !trimmed.startsWith("vault_ref://") &&
      trimmed !== rawText
    ) {
      if (content.includes(trimmed)) {
        throw new CheckpointVaultLeakError();
      }
      const escapedTrimmed = JSON.stringify(trimmed).slice(1, -1);
      if (escapedTrimmed.length >= 4 && content.includes(escapedTrimmed)) {
        throw new CheckpointVaultLeakError();
      }
    }
  }
}

const DEFAULT_INNER_TYPE = "agent_graph_state";

/**
 * Serializes and encrypts an `AgentGraphState` into an AES-256-GCM `Buffer`
 * suitable for storage in `agent_checkpoints.encrypted_state_blob`.
 *
 * @throws {CheckpointVaultLeakError} If raw vault plaintexts appear in the serialized state.
 */
export function encryptAgentGraphState(
  state: AgentGraphState,
  options?: EncryptedCheckpointSerializerOptions,
): Buffer {
  const serializedStr = JSON.stringify(state);
  assertNoVaultPlaintextLeak(serializedStr);

  const derivedKey = deriveCheckpointKey(options);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", derivedKey, iv);
  const aad = Buffer.from(`elixent:v1:checkpoint:${DEFAULT_INNER_TYPE}`, "utf-8");
  cipher.setAAD(aad);

  const plaintextBytes = Buffer.from(serializedStr, "utf-8");
  const ciphertext = Buffer.concat([
    cipher.update(plaintextBytes),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  const envelope: EncryptedCheckpointEnvelope = {
    __elixentEncrypted: true,
    v: 1,
    alg: "AES-256-GCM",
    innerType: DEFAULT_INNER_TYPE,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ciphertext.toString("base64"),
  };

  return Buffer.from(JSON.stringify(envelope), "utf-8");
}

/**
 * Decrypts and parses an AES-256-GCM checkpoint `Buffer` back into `AgentGraphState`.
 */
export function decryptAgentGraphState(
  blob: Buffer,
  options?: EncryptedCheckpointSerializerOptions,
): AgentGraphState {
  const jsonString = blob.toString("utf-8");
  const parsed: unknown = JSON.parse(jsonString);
  if (!isEncryptedCheckpointEnvelope(parsed)) {
    throw new Error("Invalid encrypted checkpoint envelope format");
  }

  const derivedKey = deriveCheckpointKey(options);
  const iv = Buffer.from(parsed.iv, "base64");
  const tag = Buffer.from(parsed.tag, "base64");
  const ciphertext = Buffer.from(parsed.ct, "base64");
  const aad = Buffer.from(`elixent:v1:checkpoint:${parsed.innerType}`, "utf-8");

  const decipher = crypto.createDecipheriv("aes-256-gcm", derivedKey, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);

  const decryptedBuffer = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return JSON.parse(decryptedBuffer.toString("utf-8")) as AgentGraphState;
}
