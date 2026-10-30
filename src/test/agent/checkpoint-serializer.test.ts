/**
 * Test Suite: Encrypted Checkpoint Serializer for PostgresSaver & LangGraph Checkpoints
 *
 * Verifies authenticated AES-256-GCM encryption with HKDF key derivation,
 * LangGraph checkpoint complex type preservation (Date, Set, Map, RegExp),
 * PostgresSaver JSONB column compatibility (_dumpMetadata / _loadMetadata),
 * idempotent pass-through preventing double encryption,
 * tampering rejection (ciphertext, tag, IV, AAD/innerType),
 * and zero-knowledge active vault plaintext leak detection (CheckpointVaultLeakError).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  EncryptedCheckpointSerializer,
  CheckpointVaultLeakError,
  isEncryptedCheckpointEnvelope,
  EncryptedCheckpointEnvelope,
} from "@/core/agent/checkpoint-serializer";
import {
  runWithEphemeralVaultScope,
  storeEphemeralVaultSection,
  zeroOutEphemeralVaultMemory,
} from "@/lib/vault/ephemeral-memory-map";

describe("Encrypted Checkpoint Serializer (PostgresSaver & LangGraph)", () => {
  const TEST_SECRET = "test-agent-checkpoint-master-key-32bytes!";

  describe("1. Envelope Validation & Type Guard", () => {
    it("should return true for valid EncryptedCheckpointEnvelope objects", () => {
      const validEnvelope: EncryptedCheckpointEnvelope = {
        __elixentEncrypted: true,
        v: 1,
        alg: "AES-256-GCM",
        innerType: "json",
        iv: Buffer.alloc(12, 1).toString("base64"),
        tag: Buffer.alloc(16, 2).toString("base64"),
        ct: Buffer.from("encrypted-payload").toString("base64"),
      };
      expect(isEncryptedCheckpointEnvelope(validEnvelope)).toBe(true);
    });

    it("should return false for invalid candidates", () => {
      expect(isEncryptedCheckpointEnvelope(null)).toBe(false);
      expect(isEncryptedCheckpointEnvelope(undefined)).toBe(false);
      expect(isEncryptedCheckpointEnvelope("string")).toBe(false);
      expect(isEncryptedCheckpointEnvelope(12345)).toBe(false);
      expect(isEncryptedCheckpointEnvelope({})).toBe(false);

      // Missing or wrong properties
      expect(
        isEncryptedCheckpointEnvelope({
          __elixentEncrypted: false,
          v: 1,
          alg: "AES-256-GCM",
          innerType: "json",
          iv: "iv",
          tag: "tag",
          ct: "ct",
        })
      ).toBe(false);

      expect(
        isEncryptedCheckpointEnvelope({
          __elixentEncrypted: true,
          v: 2, // unsupported version
          alg: "AES-256-GCM",
          innerType: "json",
          iv: "iv",
          tag: "tag",
          ct: "ct",
        })
      ).toBe(false);

      expect(
        isEncryptedCheckpointEnvelope({
          __elixentEncrypted: true,
          v: 1,
          alg: "AES-128-CBC", // unsupported algorithm
          innerType: "json",
          iv: "iv",
          tag: "tag",
          ct: "ct",
        })
      ).toBe(false);
    });
  });

  describe("2. Checkpoint Serialization & Deserialization Roundtrip", () => {
    it("should roundtrip primitives and nested structures cleanly", async () => {
      const serializer = new EncryptedCheckpointSerializer({ secretKey: TEST_SECRET });

      const state = {
        step: 42,
        status: "active",
        valid: true,
        tags: ["research", "finance"],
        nested: { count: 100, active: null },
      };

      const [type, bytes] = await serializer.dumpsTyped(state);
      expect(type).toBe("encrypted_json");
      expect(bytes).toBeInstanceOf(Uint8Array);

      const deserialized = await serializer.loadsTyped(type, bytes);
      expect(deserialized).toEqual(state);
    });

    it("should preserve complex types supported by JsonPlusSerializer (Set, Map, RegExp, and ISO Dates)", async () => {
      const serializer = new EncryptedCheckpointSerializer({ secretKey: TEST_SECRET });

      const complexState = {
        timestamp: new Date("2026-10-30T12:00:00.000Z"),
        pattern: /vault_ref:\/\/([a-z0-9-]+)/i,
        rolesSet: new Set(["admin", "analyst", "reviewer"]),
        scoresMap: new Map([
          ["accuracy", 0.98],
          ["latency", 120],
        ]),
      };

      const [type, bytes] = await serializer.dumpsTyped(complexState);
      const restored = (await serializer.loadsTyped(type, bytes)) as any;

      // In JsonPlusSerializer, Date is serialized to ISO string
      expect(restored.timestamp).toBe("2026-10-30T12:00:00.000Z");

      expect(restored.pattern).toBeInstanceOf(RegExp);
      expect(restored.pattern.source).toBe("vault_ref:\\/\\/([a-z0-9-]+)");
      expect(restored.pattern.flags).toBe("i");

      expect(restored.rolesSet).toBeInstanceOf(Set);
      expect(Array.from(restored.rolesSet)).toEqual(["admin", "analyst", "reviewer"]);

      expect(restored.scoresMap).toBeInstanceOf(Map);
      expect(restored.scoresMap.get("accuracy")).toBe(0.98);
      expect(restored.scoresMap.get("latency")).toBe(120);
    });

    it("should roundtrip full LangGraph Checkpoint structures", async () => {
      const serializer = new EncryptedCheckpointSerializer({ secretKey: TEST_SECRET });

      const langgraphCheckpoint = {
        v: 1,
        id: "1ef96b44-934d-6a50-8001-c5804362145b",
        ts: "2026-10-30T15:30:00.000Z",
        channel_values: {
          messages: [
            {
              role: "user",
              content: "Synthesize section vault_ref://doc-alpha#financial-summary",
            },
            {
              role: "assistant",
              content: "I have prepared the synthesis based on pointer dereferencing.",
            },
          ],
          active_task: "document_merge",
          iteration_count: 3,
        },
        channel_versions: {
          messages: 2,
          active_task: 1,
          iteration_count: 3,
        },
        versions_seen: {
          agent: {
            messages: 2,
            active_task: 1,
            iteration_count: 3,
          },
        },
      };

      const [type, bytes] = await serializer.dumpsTyped(langgraphCheckpoint);
      const restored = await serializer.loadsTyped(type, bytes);

      expect(restored).toEqual(langgraphCheckpoint);
    });

    it("should return undefined when loadsTyped is called with 'empty' type tag", async () => {
      const serializer = new EncryptedCheckpointSerializer({ secretKey: TEST_SECRET });
      const result = await serializer.loadsTyped("empty", new Uint8Array(0));
      expect(result).toBeUndefined();
    });
  });

  describe("3. AES-256-GCM Encryption & Authenticated Cryptography Invariants", () => {
    it("should emit valid encrypted envelopes without leaking plaintext in bytes", async () => {
      const serializer = new EncryptedCheckpointSerializer({ secretKey: TEST_SECRET });
      const sensitiveSentence = "The secret recipe is 42 units of coriander.";

      const [type, bytes] = await serializer.dumpsTyped({ secret: sensitiveSentence });
      expect(type).toBe("encrypted_json");

      const payloadStr = Buffer.from(bytes).toString("utf-8");
      expect(payloadStr).not.toContain(sensitiveSentence);

      const envelope = JSON.parse(payloadStr) as EncryptedCheckpointEnvelope;
      expect(envelope.__elixentEncrypted).toBe(true);
      expect(envelope.v).toBe(1);
      expect(envelope.alg).toBe("AES-256-GCM");
      expect(typeof envelope.innerType).toBe("string");
      expect(Buffer.from(envelope.iv, "base64")).toHaveLength(12);
      expect(Buffer.from(envelope.tag, "base64")).toHaveLength(16);
      expect(Buffer.from(envelope.ct, "base64").length).toBeGreaterThan(0);
    });

    it("should generate distinct random IVs for repeated serialization of identical data", async () => {
      const serializer = new EncryptedCheckpointSerializer({ secretKey: TEST_SECRET });
      const data = { repeat: "test-data-for-iv-uniqueness" };

      const [, bytes1] = await serializer.dumpsTyped(data);
      const [, bytes2] = await serializer.dumpsTyped(data);

      const env1 = JSON.parse(Buffer.from(bytes1).toString("utf-8")) as EncryptedCheckpointEnvelope;
      const env2 = JSON.parse(Buffer.from(bytes2).toString("utf-8")) as EncryptedCheckpointEnvelope;

      expect(env1.iv).not.toBe(env2.iv);
      expect(env1.ct).not.toBe(env2.ct);
    });

    it("should throw decryption error on ciphertext tampering", async () => {
      const serializer = new EncryptedCheckpointSerializer({ secretKey: TEST_SECRET });
      const [type, bytes] = await serializer.dumpsTyped({ secure: "state" });

      const envelope = JSON.parse(Buffer.from(bytes).toString("utf-8")) as EncryptedCheckpointEnvelope;
      const ctBuffer = Buffer.from(envelope.ct, "base64");
      // Tamper with the first byte of ciphertext
      ctBuffer[0] ^= 0xff;
      envelope.ct = ctBuffer.toString("base64");

      const tamperedBytes = Buffer.from(JSON.stringify(envelope), "utf-8");
      await expect(serializer.loadsTyped(type, tamperedBytes)).rejects.toThrow();
    });

    it("should throw decryption error on authentication tag tampering", async () => {
      const serializer = new EncryptedCheckpointSerializer({ secretKey: TEST_SECRET });
      const [type, bytes] = await serializer.dumpsTyped({ secure: "state" });

      const envelope = JSON.parse(Buffer.from(bytes).toString("utf-8")) as EncryptedCheckpointEnvelope;
      const tagBuffer = Buffer.from(envelope.tag, "base64");
      // Tamper with the authentication tag
      tagBuffer[0] ^= 0xff;
      envelope.tag = tagBuffer.toString("base64");

      const tamperedBytes = Buffer.from(JSON.stringify(envelope), "utf-8");
      await expect(serializer.loadsTyped(type, tamperedBytes)).rejects.toThrow();
    });

    it("should throw decryption error on IV tampering", async () => {
      const serializer = new EncryptedCheckpointSerializer({ secretKey: TEST_SECRET });
      const [type, bytes] = await serializer.dumpsTyped({ secure: "state" });

      const envelope = JSON.parse(Buffer.from(bytes).toString("utf-8")) as EncryptedCheckpointEnvelope;
      const ivBuffer = Buffer.from(envelope.iv, "base64");
      // Tamper with the IV
      ivBuffer[0] ^= 0xff;
      envelope.iv = ivBuffer.toString("base64");

      const tamperedBytes = Buffer.from(JSON.stringify(envelope), "utf-8");
      await expect(serializer.loadsTyped(type, tamperedBytes)).rejects.toThrow();
    });

    it("should throw decryption error on AAD tampering (innerType modification)", async () => {
      const serializer = new EncryptedCheckpointSerializer({ secretKey: TEST_SECRET });
      const [type, bytes] = await serializer.dumpsTyped({ secure: "state" });

      const envelope = JSON.parse(Buffer.from(bytes).toString("utf-8")) as EncryptedCheckpointEnvelope;
      // Tamper with innerType bound to AAD
      envelope.innerType = "tampered_inner_type";

      const tamperedBytes = Buffer.from(JSON.stringify(envelope), "utf-8");
      await expect(serializer.loadsTyped(type, tamperedBytes)).rejects.toThrow();
    });

    it("should reject decryption with mismatched master secret keys", async () => {
      const serializerA = new EncryptedCheckpointSerializer({ secretKey: "key-alpha-32-bytes-long-string!!" });
      const serializerB = new EncryptedCheckpointSerializer({ secretKey: "key-bravo-32-bytes-long-string!!" });

      const [type, bytes] = await serializerA.dumpsTyped({ sensitive: "vault-data" });
      await expect(serializerB.loadsTyped(type, bytes)).rejects.toThrow();
    });
  });

  describe("4. PostgresSaver JSONB Column Compatibility & Idempotent Pass-Through", () => {
    it("should be directly parseable by PostgresSaver._dumpMetadata pattern", async () => {
      const serializer = new EncryptedCheckpointSerializer({ secretKey: TEST_SECRET });
      const metadata = {
        checkpoint_id: "chk-pg-123",
        source: "agent_node",
        writes: { count: 5 },
      };

      // In PostgresSaver._dumpMetadata:
      // const [, serializedMetadata] = await this.serde.dumpsTyped(metadata);
      // return JSON.parse(new TextDecoder().decode(serializedMetadata).replace(/\0/g, ""));
      const [, serializedMetadata] = await serializer.dumpsTyped(metadata);
      const jsonString = new TextDecoder().decode(serializedMetadata).replace(/\0/g, "");
      const parsedDumpedMetadata = JSON.parse(jsonString);

      expect(isEncryptedCheckpointEnvelope(parsedDumpedMetadata)).toBe(true);
      expect(parsedDumpedMetadata.alg).toBe("AES-256-GCM");
    });

    it("should support idempotent pass-through preventing double-encryption in _loadMetadata", async () => {
      const serializer = new EncryptedCheckpointSerializer({ secretKey: TEST_SECRET });
      const metadata = { agent_step: "synthesis", step_index: 2 };

      // 1. Initial dump (simulating PostgresSaver._dumpMetadata writing to DB)
      const [, dumpedBytes] = await serializer.dumpsTyped(metadata);
      const jsonObjectFromDb = JSON.parse(Buffer.from(dumpedBytes).toString("utf-8"));
      expect(isEncryptedCheckpointEnvelope(jsonObjectFromDb)).toBe(true);

      // 2. In PostgresSaver._loadMetadata(metadata):
      // const [type, dumpedValue] = await this.serde.dumpsTyped(metadata);
      // return this.serde.loadsTyped(type, dumpedValue);
      const [type, dumpedValue] = await serializer.dumpsTyped(jsonObjectFromDb);
      expect(type).toBe("encrypted_json");

      // Verify it did NOT double-encrypt into another envelope layer
      const passedThroughEnvelope = JSON.parse(Buffer.from(dumpedValue).toString("utf-8"));
      expect(passedThroughEnvelope.ct).toBe(jsonObjectFromDb.ct);
      expect(passedThroughEnvelope.iv).toBe(jsonObjectFromDb.iv);
      expect(passedThroughEnvelope.tag).toBe(jsonObjectFromDb.tag);

      // 3. loadsTyped successfully unpacks to the original metadata
      const loaded = await serializer.loadsTyped(type, dumpedValue);
      expect(loaded).toEqual(metadata);
    });

    it("should accept both Uint8Array and string JSON inputs in loadsTyped", async () => {
      const serializer = new EncryptedCheckpointSerializer({ secretKey: TEST_SECRET });
      const data = { user: "analyst-1", active: true };

      const [type, bytes] = await serializer.dumpsTyped(data);
      const stringData = Buffer.from(bytes).toString("utf-8");

      const fromBytes = await serializer.loadsTyped(type, bytes);
      const fromString = await serializer.loadsTyped(type, stringData);

      expect(fromBytes).toEqual(data);
      expect(fromString).toEqual(data);
    });
  });

  describe("5. Zero-Knowledge Active Vault Plaintext Leak Detection", () => {
    it("should permit checkpoints containing canonical vault_ref:// pointers", async () => {
      const serializer = new EncryptedCheckpointSerializer({ secretKey: TEST_SECRET });

      await runWithEphemeralVaultScope(async () => {
        const fileId = "doc-medical";
        const slug = "oncology-findings";
        const secretText = "CRITICAL_BIOPSY_DIAGNOSIS_CONFIDENTIAL_123";

        const ptr = storeEphemeralVaultSection(fileId, slug, secretText);

        const safeCheckpoint = {
          messages: [{ role: "user", content: `Please review section ${ptr}` }],
          context_pointer: ptr,
        };

        // Pointer-only state must serialize cleanly without throwing
        const [type, bytes] = await serializer.dumpsTyped(safeCheckpoint);
        expect(type).toBe("encrypted_json");

        const restored = (await serializer.loadsTyped(type, bytes)) as typeof safeCheckpoint;
        expect(restored.context_pointer).toBe(ptr);
      });
    });

    it("should throw CheckpointVaultLeakError when raw active vault plaintext leaks into state", async () => {
      const serializer = new EncryptedCheckpointSerializer({ secretKey: TEST_SECRET });

      await runWithEphemeralVaultScope(async () => {
        const fileId = "doc-finance";
        const slug = "q3-numbers";
        const rawSecret = "UNRELEASED_FINANCIAL_EARNINGS_LEAK_TARGET";

        storeEphemeralVaultSection(fileId, slug, rawSecret);

        const leakyCheckpoint = {
          messages: [
            {
              role: "assistant",
              content: `Here are the unreleased numbers: ${rawSecret}`,
            },
          ],
        };

        // Invariant: Serializer MUST abort before encryption and persistence
        await expect(serializer.dumpsTyped(leakyCheckpoint)).rejects.toThrow(
          CheckpointVaultLeakError
        );

        try {
          await serializer.dumpsTyped(leakyCheckpoint);
          expect.fail("Expected CheckpointVaultLeakError to be thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(CheckpointVaultLeakError);
          const leakErr = err as CheckpointVaultLeakError;
          expect(leakErr.name).toBe("CheckpointVaultLeakError");
          expect(leakErr.code).toBe("VAULT_PLAINTEXT_LEAK_DETECTED");
        }
      });
    });

    it("should detect leak even when surrounded by whitespace or trimmed", async () => {
      const serializer = new EncryptedCheckpointSerializer({ secretKey: TEST_SECRET });

      await runWithEphemeralVaultScope(async () => {
        const rawSecret = "SECRET_TOKEN_WITH_WHITESPACE";
        storeEphemeralVaultSection("doc-auth", "token", `   ${rawSecret}   `);

        const leakyState = { token: rawSecret };

        await expect(serializer.dumpsTyped(leakyState)).rejects.toThrow(
          CheckpointVaultLeakError
        );
      });
    });

    it("should detect leak in JSON-escaped strings", async () => {
      const serializer = new EncryptedCheckpointSerializer({ secretKey: TEST_SECRET });

      await runWithEphemeralVaultScope(async () => {
        const rawSecret = 'SECRET_WITH_"QUOTES"_AND_\\SLASHES';
        storeEphemeralVaultSection("doc-esc", "sec", rawSecret);

        const leakyState = { payload: rawSecret };

        await expect(serializer.dumpsTyped(leakyState)).rejects.toThrow(
          CheckpointVaultLeakError
        );
      });
    });

    it("should not falsely trigger leak detection on short strings (< 4 chars)", async () => {
      const serializer = new EncryptedCheckpointSerializer({ secretKey: TEST_SECRET });

      await runWithEphemeralVaultScope(async () => {
        // Short text < 4 chars
        storeEphemeralVaultSection("doc-short", "sec", "abc");

        const stateWithShort = { text: "abc is a normal prefix" };
        const [type] = await serializer.dumpsTyped(stateWithShort);
        expect(type).toBe("encrypted_json");
      });
    });

    it("should succeed cleanly once ephemeral vault memory is zeroed and cleared", async () => {
      const serializer = new EncryptedCheckpointSerializer({ secretKey: TEST_SECRET });
      const rawSecret = "TRANSIENT_ACTIVE_SECRET_WIPED_CLEAN";

      await runWithEphemeralVaultScope(async () => {
        storeEphemeralVaultSection("doc-wipe", "sec", rawSecret);

        const checkpoint = { data: rawSecret };

        // Fails while active
        await expect(serializer.dumpsTyped(checkpoint)).rejects.toThrow(
          CheckpointVaultLeakError
        );

        // Explicitly wipe memory
        zeroOutEphemeralVaultMemory();

        // Must now succeed cleanly because active plaintexts map is empty
        const [type, bytes] = await serializer.dumpsTyped(checkpoint);
        expect(type).toBe("encrypted_json");
        const restored = await serializer.loadsTyped(type, bytes);
        expect(restored).toEqual(checkpoint);
      });
    });
  });

  describe("6. Environment Configuration & Production Enforcement", () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("should throw error in production when no encryption key is configured", () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      delete process.env.CHECKPOINT_ENCRYPTION_KEY;
      delete process.env.AUTH_SECRET;
      delete process.env.NEXTAUTH_SECRET;

      expect(() => new EncryptedCheckpointSerializer()).toThrowError(
        /Security Violation: Missing checkpoint encryption key in production environment/
      );
    });

    it("should use CHECKPOINT_ENCRYPTION_KEY when provided in environment", async () => {
      process.env.CHECKPOINT_ENCRYPTION_KEY = "env-checkpoint-key-1234567890123456";

      const serializer = new EncryptedCheckpointSerializer();
      const [type, bytes] = await serializer.dumpsTyped({ state: "ok" });
      const restored = await serializer.loadsTyped(type, bytes);
      expect(restored).toEqual({ state: "ok" });
    });

    it("should support custom hkdfInfo and hkdfSalt", async () => {
      const salt = Buffer.alloc(32, 7);
      const serializerA = new EncryptedCheckpointSerializer({
        secretKey: TEST_SECRET,
        hkdfInfo: "custom-info-v1",
        hkdfSalt: salt,
      });

      const serializerB = new EncryptedCheckpointSerializer({
        secretKey: TEST_SECRET,
        hkdfInfo: "custom-info-v2", // different info
        hkdfSalt: salt,
      });

      const [type, bytes] = await serializerA.dumpsTyped({ message: "keyed" });
      // Serializer B with different HKDF info must fail decryption
      await expect(serializerB.loadsTyped(type, bytes)).rejects.toThrow();
    });
  });
});
