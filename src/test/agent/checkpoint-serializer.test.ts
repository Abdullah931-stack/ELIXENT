/**
 * Test Suite: Native Encrypted Checkpoint Serializer (`src/core/agent/checkpoint-serializer.ts`)
 *
 * Verifies authenticated AES-256-GCM encryption with HKDF-SHA-256 key derivation for
 * `AgentGraphState` blobs persisted into `agent_checkpoints.encrypted_state_blob`:
 * 1. `isEncryptedCheckpointEnvelope` type guard validation.
 * 2. Full 18-channel `AgentGraphState` roundtrip & unique random 12-byte IVs.
 * 3. Tampering rejection (ciphertext, GCM auth tag, IV, AAD `innerType`, mismatched secret/HKDF).
 * 4. Sacred Zero-Knowledge Regression: active ephemeral vault plaintext leak detection
 *    (`CheckpointVaultLeakError` / `VAULT_PLAINTEXT_LEAK_DETECTED`).
 * 5. Environment key resolution (`CHECKPOINT_ENCRYPTION_KEY`, `AUTH_SECRET`, `NEXTAUTH_SECRET`)
 *    and fail-closed production enforcement.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  encryptAgentGraphState,
  decryptAgentGraphState,
  assertNoVaultPlaintextLeak,
  CheckpointVaultLeakError,
  isEncryptedCheckpointEnvelope,
  type EncryptedCheckpointEnvelope,
} from "@/core/agent/checkpoint-serializer";
import {
  createInitialAgentGraphState,
  type AgentGraphState,
} from "@/core/agent/state";
import {
  runWithEphemeralVaultScope,
  storeEphemeralVaultSection,
  zeroOutEphemeralVaultMemory,
} from "@/lib/vault/ephemeral-memory-map";

describe("Native Encrypted Checkpoint Serializer (AES-256-GCM & ZK Leak Guard)", () => {
  const TEST_SECRET = "test-agent-checkpoint-master-key-32bytes!";

  describe("1. Envelope Validation & Type Guard", () => {
    it("returns true for a well-formed EncryptedCheckpointEnvelope", () => {
      const validEnvelope: EncryptedCheckpointEnvelope = {
        __elixentEncrypted: true,
        v: 1,
        alg: "AES-256-GCM",
        innerType: "agent_graph_state",
        iv: Buffer.alloc(12, 1).toString("base64"),
        tag: Buffer.alloc(16, 2).toString("base64"),
        ct: Buffer.from("encrypted-payload").toString("base64"),
      };
      expect(isEncryptedCheckpointEnvelope(validEnvelope)).toBe(true);
    });

    it.each([
      { label: "null", candidate: null },
      { label: "undefined", candidate: undefined },
      { label: "primitive string", candidate: "string" },
      { label: "primitive number", candidate: 12345 },
      { label: "empty object", candidate: {} },
      {
        label: "__elixentEncrypted false",
        candidate: {
          __elixentEncrypted: false,
          v: 1,
          alg: "AES-256-GCM",
          innerType: "agent_graph_state",
          iv: "iv",
          tag: "tag",
          ct: "ct",
        },
      },
      {
        label: "unsupported version v: 2",
        candidate: {
          __elixentEncrypted: true,
          v: 2,
          alg: "AES-256-GCM",
          innerType: "agent_graph_state",
          iv: "iv",
          tag: "tag",
          ct: "ct",
        },
      },
      {
        label: "unsupported algorithm AES-128-CBC",
        candidate: {
          __elixentEncrypted: true,
          v: 1,
          alg: "AES-128-CBC",
          innerType: "agent_graph_state",
          iv: "iv",
          tag: "tag",
          ct: "ct",
        },
      },
      {
        label: "missing ct field",
        candidate: {
          __elixentEncrypted: true,
          v: 1,
          alg: "AES-256-GCM",
          innerType: "agent_graph_state",
          iv: "iv",
          tag: "tag",
        },
      },
    ])("returns false for invalid candidate: $label", ({ candidate }) => {
      expect(isEncryptedCheckpointEnvelope(candidate)).toBe(false);
    });
  });

  describe("2. AgentGraphState Roundtrip & AES-256-GCM Wire Format", () => {
    it("roundtrips a populated 18-channel AgentGraphState without leaking plaintext in wire bytes", () => {
      const sensitivePrompt = "The secret recipe is 42 units of coriander.";
      const state: AgentGraphState = createInitialAgentGraphState({
        classified_intent: "ARCHITECTURAL_MODIFICATION",
        user_request: {
          prompt: sensitivePrompt,
          workspaceId: "ws-crypto-1",
          projectId: "proj-crypto-1",
          turnId: "turn-1",
          targetFileIds: ["doc-alpha.md"],
          permissionMode: "semi_auto",
          selectedSystem2ModelId: "google/gemini-4-argon",
        },
        messages: [
          {
            id: "msg-1",
            role: "user",
            content: "Synthesize section vault_ref://doc-alpha#financial-summary",
            createdAt: "2026-11-20T12:00:00.000Z",
          },
          {
            id: "msg-2",
            role: "assistant",
            content: "Prepared synthesis from pointer dereferencing.",
            createdAt: "2026-11-20T12:00:01.000Z",
          },
        ],
        budget_tracking: { reservedMicro: "9007199254740993", spentMicro: "1500" },
        search_loop_count: 2,
      });

      const blob = encryptAgentGraphState(state, { secretKey: TEST_SECRET });
      expect(Buffer.isBuffer(blob)).toBe(true);

      const wireJson = blob.toString("utf-8");
      expect(wireJson).not.toContain(sensitivePrompt);
      expect(wireJson).not.toContain("Prepared synthesis");

      const envelope = JSON.parse(wireJson) as EncryptedCheckpointEnvelope;
      expect(isEncryptedCheckpointEnvelope(envelope)).toBe(true);
      expect(envelope.innerType).toBe("agent_graph_state");
      expect(Buffer.from(envelope.iv, "base64")).toHaveLength(12);
      expect(Buffer.from(envelope.tag, "base64")).toHaveLength(16);
      expect(Buffer.from(envelope.ct, "base64").length).toBeGreaterThan(0);

      const restored = decryptAgentGraphState(blob, { secretKey: TEST_SECRET });
      expect(restored).toEqual(state);
    });

    it("generates distinct random IVs and ciphertexts for repeated encryption of identical state", () => {
      const state = createInitialAgentGraphState({
        classified_intent: "CHAT_ONLY",
      });

      const blob1 = encryptAgentGraphState(state, { secretKey: TEST_SECRET });
      const blob2 = encryptAgentGraphState(state, { secretKey: TEST_SECRET });

      const env1 = JSON.parse(blob1.toString("utf-8")) as EncryptedCheckpointEnvelope;
      const env2 = JSON.parse(blob2.toString("utf-8")) as EncryptedCheckpointEnvelope;

      expect(env1.iv).not.toBe(env2.iv);
      expect(env1.ct).not.toBe(env2.ct);
    });
  });

  describe("3. Authenticated Cryptography Tampering Rejection", () => {
    it.each([
      {
        label: "ciphertext byte flip",
        mutate: (env: EncryptedCheckpointEnvelope) => {
          const buf = Buffer.from(env.ct, "base64");
          buf[0] ^= 0xff;
          return { ...env, ct: buf.toString("base64") };
        },
        decryptOpts: { secretKey: TEST_SECRET },
      },
      {
        label: "GCM authentication tag byte flip",
        mutate: (env: EncryptedCheckpointEnvelope) => {
          const buf = Buffer.from(env.tag, "base64");
          buf[0] ^= 0xff;
          return { ...env, tag: buf.toString("base64") };
        },
        decryptOpts: { secretKey: TEST_SECRET },
      },
      {
        label: "IV byte flip",
        mutate: (env: EncryptedCheckpointEnvelope) => {
          const buf = Buffer.from(env.iv, "base64");
          buf[0] ^= 0xff;
          return { ...env, iv: buf.toString("base64") };
        },
        decryptOpts: { secretKey: TEST_SECRET },
      },
      {
        label: "AAD innerType tampering",
        mutate: (env: EncryptedCheckpointEnvelope) => ({
          ...env,
          innerType: "tampered_inner_type",
        }),
        decryptOpts: { secretKey: TEST_SECRET },
      },
      {
        label: "mismatched master secret key",
        mutate: (env: EncryptedCheckpointEnvelope) => env,
        decryptOpts: { secretKey: "key-bravo-32-bytes-long-string!!" },
      },
      {
        label: "mismatched HKDF info context",
        mutate: (env: EncryptedCheckpointEnvelope) => env,
        decryptOpts: { secretKey: TEST_SECRET, hkdfInfo: "custom-info-v2" },
      },
      {
        label: "mismatched HKDF salt",
        mutate: (env: EncryptedCheckpointEnvelope) => env,
        decryptOpts: { secretKey: TEST_SECRET, hkdfSalt: Buffer.alloc(32, 9) },
      },
    ])("rejects decryption on $label", ({ mutate, decryptOpts }) => {
      const state = createInitialAgentGraphState({ classified_intent: "CHAT_ONLY" });
      const blob = encryptAgentGraphState(state, { secretKey: TEST_SECRET });
      const envelope = JSON.parse(blob.toString("utf-8")) as EncryptedCheckpointEnvelope;
      const tampered = Buffer.from(JSON.stringify(mutate(envelope)), "utf-8");

      expect(() => decryptAgentGraphState(tampered, decryptOpts)).toThrow();
    });

    it("rejects non-envelope JSON and malformed non-JSON buffers in decryptAgentGraphState", () => {
      const nonEnvelope = Buffer.from(JSON.stringify({ plain: true }), "utf-8");
      expect(() =>
        decryptAgentGraphState(nonEnvelope, { secretKey: TEST_SECRET }),
      ).toThrow(/Invalid encrypted checkpoint envelope format/);

      const invalidJson = Buffer.from("{not-valid-json", "utf-8");
      expect(() =>
        decryptAgentGraphState(invalidJson, { secretKey: TEST_SECRET }),
      ).toThrow();
    });
  });

  describe("4. Sacred Zero-Knowledge Regression: Active Vault Plaintext Leak Guard", () => {
    it("permits checkpoints containing canonical vault_ref:// pointers while active secrets exist", async () => {
      await runWithEphemeralVaultScope(async () => {
        const ptr = storeEphemeralVaultSection(
          "doc-medical",
          "oncology-findings",
          "CRITICAL_BIOPSY_DIAGNOSIS_CONFIDENTIAL_123",
        );

        const safeState = createInitialAgentGraphState({
          messages: [
            {
              id: "msg-safe",
              role: "user",
              content: `Please review section ${ptr}`,
              createdAt: "2026-11-20T12:00:00.000Z",
            },
          ],
        });

        const blob = encryptAgentGraphState(safeState, { secretKey: TEST_SECRET });
        const restored = decryptAgentGraphState(blob, { secretKey: TEST_SECRET });
        expect(restored.messages[0].content).toBe(`Please review section ${ptr}`);
      });
    });

    it("throws CheckpointVaultLeakError (VAULT_PLAINTEXT_LEAK_DETECTED) when raw active vault plaintext leaks into state", async () => {
      await runWithEphemeralVaultScope(async () => {
        const rawSecret = "UNRELEASED_FINANCIAL_EARNINGS_LEAK_TARGET";
        storeEphemeralVaultSection("doc-finance", "q3-numbers", rawSecret);

        const leakyState = createInitialAgentGraphState({
          messages: [
            {
              id: "msg-leak",
              role: "assistant",
              content: `Here are the unreleased numbers: ${rawSecret}`,
              createdAt: "2026-11-20T12:00:00.000Z",
            },
          ],
        });

        try {
          encryptAgentGraphState(leakyState, { secretKey: TEST_SECRET });
          expect.fail("Expected CheckpointVaultLeakError to be thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(CheckpointVaultLeakError);
          const leakErr = err as CheckpointVaultLeakError;
          expect(leakErr.name).toBe("CheckpointVaultLeakError");
          expect(leakErr.code).toBe("VAULT_PLAINTEXT_LEAK_DETECTED");
        }
      });
    });

    it("detects leaked plaintext when surrounded by whitespace or JSON-escaped", async () => {
      await runWithEphemeralVaultScope(async () => {
        const trimmedSecret = "SECRET_TOKEN_WITH_WHITESPACE";
        storeEphemeralVaultSection("doc-auth", "token", `   ${trimmedSecret}   `);
        expect(() =>
          assertNoVaultPlaintextLeak(JSON.stringify({ token: trimmedSecret })),
        ).toThrow(CheckpointVaultLeakError);

        const escapedSecret = 'SECRET_WITH_"QUOTES"_AND_\\SLASHES';
        storeEphemeralVaultSection("doc-esc", "sec", escapedSecret);
        const leakyEscaped = createInitialAgentGraphState({
          messages: [
            {
              id: "msg-esc",
              role: "assistant",
              content: escapedSecret,
              createdAt: "2026-11-20T12:00:00.000Z",
            },
          ],
        });
        expect(() =>
          encryptAgentGraphState(leakyEscaped, { secretKey: TEST_SECRET }),
        ).toThrow(CheckpointVaultLeakError);
      });
    });

    it("does not falsely trigger leak detection on short strings (< 4 chars)", async () => {
      await runWithEphemeralVaultScope(async () => {
        storeEphemeralVaultSection("doc-short", "sec", "abc");

        const stateWithShort = createInitialAgentGraphState({
          messages: [
            {
              id: "msg-short",
              role: "user",
              content: "abc is a normal prefix",
              createdAt: "2026-11-20T12:00:00.000Z",
            },
          ],
        });

        const blob = encryptAgentGraphState(stateWithShort, { secretKey: TEST_SECRET });
        expect(decryptAgentGraphState(blob, { secretKey: TEST_SECRET })).toEqual(
          stateWithShort,
        );
      });
    });

    it("succeeds cleanly once ephemeral vault memory is zeroed out", async () => {
      const rawSecret = "TRANSIENT_ACTIVE_SECRET_WIPED_CLEAN";

      await runWithEphemeralVaultScope(async () => {
        storeEphemeralVaultSection("doc-wipe", "sec", rawSecret);

        const state = createInitialAgentGraphState({
          messages: [
            {
              id: "msg-wipe",
              role: "user",
              content: rawSecret,
              createdAt: "2026-11-20T12:00:00.000Z",
            },
          ],
        });

        expect(() =>
          encryptAgentGraphState(state, { secretKey: TEST_SECRET }),
        ).toThrow(CheckpointVaultLeakError);

        zeroOutEphemeralVaultMemory();

        const blob = encryptAgentGraphState(state, { secretKey: TEST_SECRET });
        expect(decryptAgentGraphState(blob, { secretKey: TEST_SECRET })).toEqual(state);
      });
    });
  });

  describe("5. Environment Configuration & Production Key Enforcement", () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("throws a security violation in production when no encryption key env var is configured", () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      delete process.env.CHECKPOINT_ENCRYPTION_KEY;
      delete process.env.AUTH_SECRET;
      delete process.env.NEXTAUTH_SECRET;

      expect(() =>
        encryptAgentGraphState(createInitialAgentGraphState()),
      ).toThrow(
        /Security Violation: Missing checkpoint encryption key in production environment/,
      );
    });

    it.each([
      { envKey: "CHECKPOINT_ENCRYPTION_KEY", value: "env-checkpoint-key-1234567890123456" },
      { envKey: "AUTH_SECRET", value: "env-auth-secret-fallback-1234567890" },
      { envKey: "NEXTAUTH_SECRET", value: "env-nextauth-secret-fallback-123456" },
    ])("derives encryption key from $envKey when explicit secretKey is omitted", ({ envKey, value }) => {
      delete process.env.CHECKPOINT_ENCRYPTION_KEY;
      delete process.env.AUTH_SECRET;
      delete process.env.NEXTAUTH_SECRET;
      process.env[envKey] = value;

      const state = createInitialAgentGraphState({
        classified_intent: "WORKSPACE_READ_SEARCH",
      });
      const blob = encryptAgentGraphState(state);
      expect(decryptAgentGraphState(blob)).toEqual(state);
    });
  });
});
