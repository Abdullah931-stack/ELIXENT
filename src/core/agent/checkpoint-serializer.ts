/**
 * Encrypted Checkpoint Serializer for PostgresSaver & LangGraph Checkpoints
 *
 * Implements `SerializerProtocol` from `@langchain/langgraph-checkpoint` to provide
 * zero-knowledge, authenticated encryption (`AES-256-GCM`) for agent state checkpoints
 * persisted into PostgreSQL.
 *
 * Key Capabilities & Invariants:
 * 1. Authenticated Encryption: Derives a 256-bit AES key via HKDF-SHA-256 and encrypts
 *    serialized checkpoints using a 12-byte random IV, 16-byte authentication tag, and
 *    Additional Authenticated Data (AAD) bound to the inner serialization type.
 * 2. PostgresSaver JSONB Compatibility: Emits valid UTF-8 JSON representations of
 *    `EncryptedCheckpointEnvelope`, ensuring seamless parsing by `PostgresSaver._dumpMetadata`.
 * 3. Idempotent Pass-Through: Prevents double-encryption during `PostgresSaver._loadMetadata`
 *    by detecting pre-existing `EncryptedCheckpointEnvelope` objects and passing them through.
 * 4. Zero-Knowledge Leak Assertion: Inspects serialized payloads prior to encryption, verifying
 *    that no active decrypted ephemeral vault plaintexts (>= 4 characters) appear outside of
 *    opaque `vault_ref://` pointers. Violations throw `CheckpointVaultLeakError`.
 * 5. Type Preservation: Encapsulates LangGraph's internal `JsonPlusSerializer` to preserve
 *    complex types (Date, Map, Set, RegExp, DeltaSnapshot, and custom LangChain classes).
 */

import crypto from "node:crypto";
import { SerializerProtocol, MemorySaver } from "@langchain/langgraph-checkpoint";
import { getActiveEphemeralVaultPlaintexts } from "@/lib/vault/ephemeral-memory-map";

/**
 * Standard error thrown when raw vault plaintext is detected within serialized checkpoint data.
 */
export class CheckpointVaultLeakError extends Error {
  readonly code = "VAULT_PLAINTEXT_LEAK_DETECTED" as const;

  constructor(
    message = "Security Violation: Checkpoint serialization contains raw vault plaintext outside vault_ref:// pointers"
  ) {
    super(message);
    this.name = "CheckpointVaultLeakError";
    Object.setPrototypeOf(this, CheckpointVaultLeakError.prototype);
  }
}

/**
 * Serialization envelope format for AES-256-GCM encrypted checkpoints.
 * Formatted as valid JSON to support storage in PostgreSQL `JSONB` columns.
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
 * Configuration options for `EncryptedCheckpointSerializer`.
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

  /**
   * Optional custom inner serializer implementing `SerializerProtocol`.
   * Defaults to LangGraph's internal `JsonPlusSerializer` (via `MemorySaver().serde`).
   */
  innerSerde?: SerializerProtocol;
}

/**
 * Type guard validating whether a value conforms to `EncryptedCheckpointEnvelope`.
 */
export function isEncryptedCheckpointEnvelope(
  value: unknown
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
 * Encrypted Checkpoint Serializer implementing LangGraph's `SerializerProtocol`.
 */
export class EncryptedCheckpointSerializer implements SerializerProtocol {
  private readonly derivedKey: Buffer;
  private readonly innerSerde: SerializerProtocol;

  /**
   * Constructs an instance of `EncryptedCheckpointSerializer`.
   *
   * @param options - Configuration options for key derivation and inner serializer.
   * @throws {Error} If no secret key is provided or found in environment variables in production.
   */
  constructor(options?: EncryptedCheckpointSerializerOptions) {
    // 1. Resolve master secret key material
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
          "Security Violation: Missing checkpoint encryption key in production environment. CHECKPOINT_ENCRYPTION_KEY, AUTH_SECRET, or NEXTAUTH_SECRET must be configured."
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

    // 2. Derive 32-byte (256-bit) encryption key using HKDF-SHA-256
    this.derivedKey = Buffer.from(
      crypto.hkdfSync("sha256", keyMaterial, salt, info, 32)
    );

    // 3. Encapsulate LangGraph's internal JsonPlusSerializer
    this.innerSerde = options?.innerSerde ?? new MemorySaver().serde;
  }

  /**
   * Serializes and encrypts checkpoint data using AES-256-GCM.
   *
   * @param data - The checkpoint state, channel value, or metadata object to serialize.
   * @returns A promise resolving to `["encrypted_json", Uint8Array]` containing the JSON-encoded envelope.
   * @throws {CheckpointVaultLeakError} If raw vault plaintexts appear in the serialized payload.
   */
  async dumpsTyped(data: unknown): Promise<[string, Uint8Array]> {
    // 1. Idempotent Pass-Through:
    // If data is already an EncryptedCheckpointEnvelope (e.g. during PostgresSaver._loadMetadata),
    // re-encode directly without double-encrypting.
    if (isEncryptedCheckpointEnvelope(data)) {
      return ["encrypted_json", Buffer.from(JSON.stringify(data), "utf-8")];
    }

    // 2. Delegate to inner serializer (JsonPlusSerializer) to handle complex LangGraph types
    const [innerType, innerBytes] = await this.innerSerde.dumpsTyped(data);

    // 3. Vault Plaintext Leak Assertion:
    // Ensure no active ephemeral vault plaintext (>= 4 chars, non-pointer) has leaked into the payload
    const serializedStr = Buffer.from(innerBytes).toString("utf-8");
    this.assertNoVaultPlaintextLeak(serializedStr);

    // 4. Authenticated Encryption via AES-256-GCM
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.derivedKey, iv);

    // Bind inner serialization type to Additional Authenticated Data (AAD)
    const aad = Buffer.from("elixent:v1:checkpoint:" + innerType, "utf-8");
    cipher.setAAD(aad);

    const ciphertext = Buffer.concat([
      cipher.update(innerBytes),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    // 5. Construct envelope
    const envelope: EncryptedCheckpointEnvelope = {
      __elixentEncrypted: true,
      v: 1,
      alg: "AES-256-GCM",
      innerType,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ct: ciphertext.toString("base64"),
    };

    // Return valid UTF-8 JSON bytes for PostgresSaver JSONB column compatibility
    return ["encrypted_json", Buffer.from(JSON.stringify(envelope), "utf-8")];
  }

  /**
   * Deserializes and decrypts checkpoint data.
   *
   * @param type - Serialization type tag (e.g. `"encrypted_json"`).
   * @param data - Raw byte payload or JSON string representation of the envelope.
   * @returns A promise resolving to the deserialized, decrypted checkpoint object or state.
   */
  async loadsTyped(type: string, data: Uint8Array | string): Promise<unknown> {
    // Handle empty type gracefully
    if (type === "empty") {
      return undefined;
    }

    let envelope: EncryptedCheckpointEnvelope | null = null;

    // 1. Direct type match for "encrypted_json"
    if (type === "encrypted_json") {
      const jsonString =
        typeof data === "string"
          ? data
          : Buffer.from(data).toString("utf-8");
      try {
        const parsed = JSON.parse(jsonString);
        if (isEncryptedCheckpointEnvelope(parsed)) {
          envelope = parsed;
        }
      } catch {
        // Fall through to unencrypted fallback if JSON parsing fails
      }
    } else {
      // 2. Structural detection if type tag differs but payload is an envelope
      try {
        const jsonString =
          typeof data === "string"
            ? data
            : Buffer.from(data).toString("utf-8");
        const parsed = JSON.parse(jsonString);
        if (isEncryptedCheckpointEnvelope(parsed)) {
          envelope = parsed;
        }
      } catch {
        // Not a JSON envelope, proceed to unencrypted fallback
      }
    }

    // 3. If envelope found, decrypt and delegate to inner serializer
    if (envelope) {
      const iv = Buffer.from(envelope.iv, "base64");
      const tag = Buffer.from(envelope.tag, "base64");
      const ciphertext = Buffer.from(envelope.ct, "base64");
      const aad = Buffer.from(
        "elixent:v1:checkpoint:" + envelope.innerType,
        "utf-8"
      );

      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        this.derivedKey,
        iv
      );
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);

      const decryptedBuffer = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);

      return this.innerSerde.loadsTyped(envelope.innerType, decryptedBuffer);
    }

    // 4. Unencrypted fallback (e.g. raw types or legacy unencrypted checkpoints)
    return this.innerSerde.loadsTyped(type, data);
  }

  /**
   * Asserts that no active ephemeral vault plaintext appears in the serialized payload string.
   *
   * @param content - Serialized string to inspect for plaintext leakage.
   * @throws {CheckpointVaultLeakError} When a leak of active vault plaintext is detected.
   */
  private assertNoVaultPlaintextLeak(content: string): void {
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
}
