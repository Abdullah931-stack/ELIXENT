/**
 * Test Suite: Native 18-Channel AgentGraphState, Stream Payload Contract & AES-256-GCM Checkpoint Serializer (Wave 3.1)
 *
 * Verifies:
 * 1. `createInitialAgentGraphState`, `applyStateDelta` (including `clearInvalidationMap` & `reduceMessages`)
 * 2. `AgentStreamRequestPayloadSchema` & `parseAgentStreamPayload` (`workspaceId`/`projectId` normalization,
 *    defaults, strict mode rejection, and bounded record key guards)
 * 3. `encryptAgentGraphState` / `decryptAgentGraphState` / `assertNoVaultPlaintextLeak` /
 *    `isEncryptedCheckpointEnvelope` (AES-256-GCM, HKDF, tampering, active ephemeral vault leak guard, prod key enforcement)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createInitialAgentGraphState,
  applyStateDelta,
  type AgentGraphState,
} from "@/core/agent/state";
import {
  reduceMessages,
  type AgentConversationMessage,
} from "@/core/agent/reducers";
import {
  parseAgentStreamPayload,
  MAX_RECORD_KEYS,
} from "@/core/agent/stream-payload";
import {
  encryptAgentGraphState,
  decryptAgentGraphState,
  assertNoVaultPlaintextLeak,
  isEncryptedCheckpointEnvelope,
  CheckpointVaultLeakError,
  type EncryptedCheckpointEnvelope,
} from "@/core/agent/checkpoint-serializer";
import {
  runWithEphemeralVaultScope,
  storeEphemeralVaultSection,
  zeroOutEphemeralVaultMemory,
} from "@/lib/vault/ephemeral-memory-map";

describe("1. Native 18-Channel AgentGraphState & applyStateDelta (state.ts / reducers.ts)", () => {
  it("constructs all 18 canonical channels with isolated, JSON-serializable defaults", () => {
    const stateA = createInitialAgentGraphState();
    const stateB = createInitialAgentGraphState();

    const expectedChannels = [
      "messages",
      "user_request",
      "classified_intent",
      "search_report",
      "local_inspection_state",
      "assumptions",
      "governing_constraints",
      "scored_decisions",
      "master_ledger",
      "ledger_edges",
      "project_taxonomy",
      "unresolved_ledger",
      "invalidation_map",
      "pending_file_actions",
      "question_queue",
      "clarification_answers",
      "budget_tracking",
      "search_loop_count",
    ].sort();

    expect(Object.keys(stateA).sort()).toEqual(expectedChannels);
    expect(stateA.user_request.permissionMode).toBe("safe");
    expect(stateA.user_request.selectedSystem2ModelId).toBe(
      "google/gemini-3.8-flash",
    );

    // Mutating instance A must not bleed into instance B
    stateA.messages.push({
      id: "m1",
      role: "user",
      content: "hello",
      createdAt: "2026-11-20T00:00:00.000Z",
    });
    expect(stateB.messages).toEqual([]);
    expect(JSON.parse(JSON.stringify(stateA))).toEqual(stateA);
  });

  it("merges messages by id in insertion order and replaces existing ids in place without mutating inputs", () => {
    const m1: AgentConversationMessage = {
      id: "msg-1",
      role: "user",
      content: "Original prompt",
      createdAt: "2026-11-20T00:00:00.000Z",
    };
    const m2: AgentConversationMessage = {
      id: "msg-2",
      role: "assistant",
      content: "Draft reply",
      createdAt: "2026-11-20T00:00:01.000Z",
    };
    const m1Updated: AgentConversationMessage = {
      id: "msg-1",
      role: "user",
      content: "Updated prompt",
      createdAt: "2026-11-20T00:00:02.000Z",
    };
    const m3: AgentConversationMessage = {
      id: "msg-3",
      role: "tool",
      content: "{}",
      toolCallId: "tc-1",
      toolName: "searchDecisionLedger",
      createdAt: "2026-11-20T00:00:03.000Z",
    };

    const current = Object.freeze([m1, m2]);
    const update = Object.freeze([m1Updated, m3]);

    const merged = reduceMessages(current, update);
    expect(merged.map((m) => [m.id, m.content])).toEqual([
      ["msg-1", "Updated prompt"],
      ["msg-2", "Draft reply"],
      ["msg-3", "{}"],
    ]);
    expect(current[0].content).toBe("Original prompt");
  });

  it("preserves first-class channels (scored_decisions, clarification_answers, ledger_edges, pending_file_actions) across deltas", () => {
    const base = createInitialAgentGraphState();
    const next = applyStateDelta(base, {
      classified_intent: "ARCHITECTURAL_MODIFICATION",
      scored_decisions: [{ decisionId: "dec-1", status: "APPROVED_DIRECT" }],
      clarification_answers: { q1: "opt_a" },
      ledger_edges: [
        {
          edgeId: "e1",
          sourceDecisionId: "dec-2",
          targetDecisionId: "dec-1",
          relation: "DEPENDS_ON",
        },
      ],
      pending_file_actions: [
        {
          actionId: "act-1",
          type: "DELETE_FILE",
          relativePath: "docs/legacy.md",
          fileId: "file-9",
          rationale: "Superseded specification",
          approved: false,
        },
      ],
      budget_tracking: { reservedMicro: "5000", spentMicro: "1200" },
      search_loop_count: 1,
    });

    expect(next.classified_intent).toBe("ARCHITECTURAL_MODIFICATION");
    expect(next.scored_decisions).toEqual([
      { decisionId: "dec-1", status: "APPROVED_DIRECT" },
    ]);
    expect(next.clarification_answers).toEqual({ q1: "opt_a" });
    expect(next.ledger_edges).toHaveLength(1);
    expect(next.pending_file_actions).toHaveLength(1);
    expect(next.budget_tracking).toEqual({
      reservedMicro: "5000",
      spentMicro: "1200",
    });
    expect(next.search_loop_count).toBe(1);
  });

  it("supports merging, explicit clearing, and clear-and-replace semantics on invalidation_map", () => {
    const seeded = createInitialAgentGraphState({
      invalidation_map: {
        "dec-1": [{ fileId: "f1", headingSlug: "h1" }],
      },
    });

    // Normal delta merges new entries with existing
    const merged = applyStateDelta(seeded, {
      invalidation_map: {
        "dec-1": [
          { fileId: "f1", headingSlug: "h1" }, // duplicate
          { fileId: "f1", headingSlug: "h2" },
        ],
        "dec-2": [{ fileId: "f2", headingSlug: "intro" }],
      },
    });
    expect(merged.invalidation_map).toEqual({
      "dec-1": [
        { fileId: "f1", headingSlug: "h1" },
        { fileId: "f1", headingSlug: "h2" },
      ],
      "dec-2": [{ fileId: "f2", headingSlug: "intro" }],
    });

    // clearInvalidationMap: true without new map clears completely
    const cleared = applyStateDelta(merged, { clearInvalidationMap: true });
    expect(cleared.invalidation_map).toEqual({});

    // clearInvalidationMap: true WITH new map discards prior entries and deduplicates replacement
    const replaced = applyStateDelta(merged, {
      clearInvalidationMap: true,
      invalidation_map: {
        "dec-fresh": [
          { fileId: "f9", headingSlug: "sec" },
          { fileId: "f9", headingSlug: "sec" },
        ],
      },
    });
    expect(replaced.invalidation_map).toEqual({
      "dec-fresh": [{ fileId: "f9", headingSlug: "sec" }],
    });
  });

  it("evicts omitted master_ledger keys when replaceMasterLedger is true while still stripping system-reserved sentinels", () => {
    const makeNode = (decisionId: string) => ({
      decisionId,
      topicSlug: `topic_${decisionId}`,
      questionPrompt: `Prompt ${decisionId}`,
      conceptTags: ["system_architecture"],
      selectedOptionKey: "opt_a",
      selectionRationale: "Rationale",
      runnerUpOptionKey: null,
      evaluatedAlternatives: [],
      status: "APPROVED_DIRECT" as const,
      impactTier: "CORE_ARCHITECTURAL" as const,
      isLoadBearing: true,
      dependsOn: [],
      dependedBy: [],
      affectedSections: [],
    });

    const seeded = createInitialAgentGraphState({
      master_ledger: {
        dec_keep: makeNode("dec_keep"),
        dec_evict: makeNode("dec_evict"),
      },
    });

    // Without replaceMasterLedger, additive merge preserves existing entries
    const merged = applyStateDelta(seeded, {
      master_ledger: { dec_new: makeNode("dec_new") },
    });
    expect(Object.keys(merged.master_ledger).sort()).toEqual([
      "dec_evict",
      "dec_keep",
      "dec_new",
    ]);

    // With replaceMasterLedger: true, evicted entries are removed and sentinels remain filtered
    const replaced = applyStateDelta(merged, {
      master_ledger: {
        dec_keep: makeNode("dec_keep"),
        __PROJECT_TAXONOMY__: makeNode("__PROJECT_TAXONOMY__"),
      },
      replaceMasterLedger: true,
    });
    expect(Object.keys(replaced.master_ledger)).toEqual(["dec_keep"]);

    // With replaceMasterLedger: true and omitted master_ledger, resets to empty {}
    const emptied = applyStateDelta(replaced, { replaceMasterLedger: true });
    expect(emptied.master_ledger).toEqual({});
  });
});

describe("2. AgentStreamRequestPayload Contract & Normalization (stream-payload.ts)", () => {
  it.each([
    {
      name: "workspaceId provided directly",
      input: { threadId: "th-1", workspaceId: "ws-primary", targetFileIds: [] },
      expectedWorkspaceId: "ws-primary",
    },
    {
      name: "legacy projectId alias normalized to workspaceId",
      input: { threadId: "th-1", projectId: "proj-legacy", targetFileIds: [] },
      expectedWorkspaceId: "proj-legacy",
    },
    {
      name: "both workspaceId and projectId provided prefers workspaceId",
      input: {
        threadId: "th-1",
        workspaceId: "ws-canonical",
        projectId: "proj-legacy",
        targetFileIds: ["f-1"],
      },
      expectedWorkspaceId: "ws-canonical",
    },
  ])(
    "normalizes workspaceId when $name and applies defaults",
    ({ input, expectedWorkspaceId }) => {
      const parsed = parseAgentStreamPayload(input);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.workspaceId).toBe(expectedWorkspaceId);
        expect(parsed.data.permissionMode).toBe("safe");
        expect(parsed.data.selectedSystem2ModelId).toBe(
          "google/gemini-3.8-flash",
        );
      }
    },
  );

  it("preserves explicit turnId, permissionMode, and selectedSystem2ModelId", () => {
    const parsed = parseAgentStreamPayload({
      threadId: "th-2",
      workspaceId: "ws-2",
      turnId: "turn-abc",
      permissionMode: "full_auto",
      selectedSystem2ModelId: "google/gemini-4-argon",
      targetFileIds: ["doc-1"],
      prompt: "Refactor architecture",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.turnId).toBe("turn-abc");
      expect(parsed.data.permissionMode).toBe("full_auto");
      expect(parsed.data.selectedSystem2ModelId).toBe("google/gemini-4-argon");
    }
  });

  it.each([
    {
      name: "neither workspaceId nor projectId is provided",
      payload: { threadId: "th-1", targetFileIds: [] },
      expectedIssueMessage: /Either workspaceId or projectId must be provided/,
    },
    {
      name: "unknown extra property violates .strict() contract",
      payload: {
        threadId: "th-1",
        workspaceId: "ws-1",
        targetFileIds: [],
        injectedAdminFlag: true,
      },
      expectedIssueMessage: /Unrecognized key/i,
    },
    {
      name: "invalid permissionMode enum value",
      payload: {
        threadId: "th-1",
        workspaceId: "ws-1",
        targetFileIds: [],
        permissionMode: "yolo_mode",
      },
      expectedIssueMessage: /safe|semi_auto|full_auto/i,
    },
    {
      name: "ephemeralVaultPayloads exceeds MAX_RECORD_KEYS",
      payload: {
        threadId: "th-1",
        workspaceId: "ws-1",
        targetFileIds: [],
        ephemeralVaultPayloads: Object.fromEntries(
          Array.from({ length: MAX_RECORD_KEYS + 1 }, (_, i) => [
            `file-${i}`,
            "content",
          ]),
        ),
      },
      expectedIssueMessage: /ephemeralVaultPayloads cannot exceed/,
    },
    {
      name: "liveDocumentSnapshots exceeds MAX_RECORD_KEYS",
      payload: {
        threadId: "th-1",
        workspaceId: "ws-1",
        targetFileIds: [],
        liveDocumentSnapshots: Object.fromEntries(
          Array.from({ length: MAX_RECORD_KEYS + 1 }, (_, i) => [
            `doc-${i}`,
            "snapshot",
          ]),
        ),
      },
      expectedIssueMessage: /liveDocumentSnapshots cannot exceed/,
    },
  ])("rejects payload when $name", ({ payload, expectedIssueMessage }) => {
    const result = parseAgentStreamPayload(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      const combinedMessages = result.error.issues
        .map((i) => i.message)
        .join(" | ");
      expect(combinedMessages).toMatch(expectedIssueMessage);
    }
  });
});

describe("3. AES-256-GCM Checkpoint Serializer & Zero-Knowledge Vault Guard (checkpoint-serializer.ts)", () => {
  const TEST_SECRET = "wave3-1-native-checkpoint-secret-key!!";

  it("encrypts and decrypts a full 18-channel AgentGraphState with unique random IVs and zero plaintext exposure", () => {
    const state: AgentGraphState = createInitialAgentGraphState({
      classified_intent: "NEW_DOC_DRAFTING",
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: "Draft zero-knowledge vault protocol specification",
          createdAt: "2026-11-20T00:00:00.000Z",
        },
      ],
      budget_tracking: { reservedMicro: "9007199254740993", spentMicro: "420" },
    });

    const blob1 = encryptAgentGraphState(state, { secretKey: TEST_SECRET });
    const blob2 = encryptAgentGraphState(state, { secretKey: TEST_SECRET });

    expect(Buffer.isBuffer(blob1)).toBe(true);
    expect(blob1.toString("utf-8")).not.toContain(
      "Draft zero-knowledge vault protocol specification",
    );

    const env1 = JSON.parse(blob1.toString("utf-8")) as EncryptedCheckpointEnvelope;
    const env2 = JSON.parse(blob2.toString("utf-8")) as EncryptedCheckpointEnvelope;

    expect(isEncryptedCheckpointEnvelope(env1)).toBe(true);
    expect(env1.alg).toBe("AES-256-GCM");
    expect(env1.innerType).toBe("agent_graph_state");
    expect(Buffer.from(env1.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(env1.tag, "base64")).toHaveLength(16);
    expect(env1.iv).not.toBe(env2.iv);
    expect(env1.ct).not.toBe(env2.ct);

    const restored = decryptAgentGraphState(blob1, { secretKey: TEST_SECRET });
    expect(restored).toEqual(state);
  });

  it.each([
    {
      name: "ciphertext bit-flip",
      tamper: (env: EncryptedCheckpointEnvelope) => {
        const buf = Buffer.from(env.ct, "base64");
        buf[0] ^= 0xff;
        return { ...env, ct: buf.toString("base64") };
      },
      decryptOptions: { secretKey: TEST_SECRET },
    },
    {
      name: "GCM authentication tag bit-flip",
      tamper: (env: EncryptedCheckpointEnvelope) => {
        const buf = Buffer.from(env.tag, "base64");
        buf[0] ^= 0xff;
        return { ...env, tag: buf.toString("base64") };
      },
      decryptOptions: { secretKey: TEST_SECRET },
    },
    {
      name: "IV bit-flip",
      tamper: (env: EncryptedCheckpointEnvelope) => {
        const buf = Buffer.from(env.iv, "base64");
        buf[0] ^= 0xff;
        return { ...env, iv: buf.toString("base64") };
      },
      decryptOptions: { secretKey: TEST_SECRET },
    },
    {
      name: "AAD innerType modification",
      tamper: (env: EncryptedCheckpointEnvelope) => ({
        ...env,
        innerType: "forged_inner_type",
      }),
      decryptOptions: { secretKey: TEST_SECRET },
    },
    {
      name: "mismatched master secretKey",
      tamper: (env: EncryptedCheckpointEnvelope) => env,
      decryptOptions: { secretKey: "different-master-secret-key-32bytes!!" },
    },
    {
      name: "mismatched HKDF info string",
      tamper: (env: EncryptedCheckpointEnvelope) => env,
      decryptOptions: {
        secretKey: TEST_SECRET,
        hkdfInfo: "elixent:v2:different-info",
      },
    },
  ])("rejects decryption on $name", ({ tamper, decryptOptions }) => {
    const blob = encryptAgentGraphState(createInitialAgentGraphState(), {
      secretKey: TEST_SECRET,
    });
    const env = JSON.parse(blob.toString("utf-8")) as EncryptedCheckpointEnvelope;
    const tamperedBlob = Buffer.from(JSON.stringify(tamper(env)), "utf-8");

    expect(() =>
      decryptAgentGraphState(tamperedBlob, decryptOptions),
    ).toThrow();
  });

  it("rejects non-envelope JSON blobs in decryptAgentGraphState", () => {
    const plainBlob = Buffer.from(JSON.stringify({ plain: true }), "utf-8");
    expect(() =>
      decryptAgentGraphState(plainBlob, { secretKey: TEST_SECRET }),
    ).toThrow(/Invalid encrypted checkpoint envelope format/);
  });

  describe("Zero-Knowledge Active Ephemeral Vault Plaintext Leak Guard", () => {
    it("blocks raw, whitespace-trimmed, and JSON-escaped active vault plaintexts while permitting vault_ref:// pointers and short strings", async () => {
      await runWithEphemeralVaultScope(async () => {
        const ptr = storeEphemeralVaultSection(
          "doc-zk",
          "sec-1",
          "CONFIDENTIAL_MERGER_VALUATION_8842",
        );
        storeEphemeralVaultSection("doc-ws", "sec-2", "   TRIMMED_SECRET_TOKEN   ");
        storeEphemeralVaultSection(
          "doc-esc",
          "sec-3",
          'ESCAPED_"QUOTED"_\\PATH_SECRET',
        );
        storeEphemeralVaultSection("doc-short", "sec-4", "xyz");

        // Safe pointer-only + short string state encrypts cleanly
        const safeState = createInitialAgentGraphState({
          messages: [
            {
              id: "m-safe",
              role: "user",
              content: `Analyze ${ptr} with xyz prefix`,
              createdAt: "2026-11-20T00:00:00.000Z",
            },
          ],
        });
        const safeBlob = encryptAgentGraphState(safeState, {
          secretKey: TEST_SECRET,
        });
        expect(
          decryptAgentGraphState(safeBlob, { secretKey: TEST_SECRET }).messages[0]
            .content,
        ).toContain(ptr);

        // Raw secret leak throws CheckpointVaultLeakError with canonical error code
        const leakyRaw = createInitialAgentGraphState({
          messages: [
            {
              id: "m-raw",
              role: "assistant",
              content: "Summary: CONFIDENTIAL_MERGER_VALUATION_8842",
              createdAt: "2026-11-20T00:00:00.000Z",
            },
          ],
        });
        try {
          encryptAgentGraphState(leakyRaw, { secretKey: TEST_SECRET });
          expect.fail("Expected CheckpointVaultLeakError");
        } catch (err) {
          expect(err).toBeInstanceOf(CheckpointVaultLeakError);
          expect((err as CheckpointVaultLeakError).code).toBe(
            "VAULT_PLAINTEXT_LEAK_DETECTED",
          );
        }

        // Trimmed leak throws
        expect(() =>
          assertNoVaultPlaintextLeak('{"note":"TRIMMED_SECRET_TOKEN"}'),
        ).toThrow(CheckpointVaultLeakError);

        // JSON-escaped leak throws
        const leakyEscaped = createInitialAgentGraphState({
          messages: [
            {
              id: "m-esc",
              role: "assistant",
              content: 'ESCAPED_"QUOTED"_\\PATH_SECRET',
              createdAt: "2026-11-20T00:00:00.000Z",
            },
          ],
        });
        expect(() =>
          encryptAgentGraphState(leakyEscaped, { secretKey: TEST_SECRET }),
        ).toThrow(CheckpointVaultLeakError);

        // After explicit zero-out, encryption succeeds cleanly
        zeroOutEphemeralVaultMemory();
        expect(() =>
          encryptAgentGraphState(leakyRaw, { secretKey: TEST_SECRET }),
        ).not.toThrow();
      });
    });
  });

  describe("Production Key Configuration Enforcement", () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("throws a security violation in production when no checkpoint secret is configured", () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      delete process.env.CHECKPOINT_ENCRYPTION_KEY;
      delete process.env.AUTH_SECRET;
      delete process.env.NEXTAUTH_SECRET;

      expect(() =>
        encryptAgentGraphState(createInitialAgentGraphState()),
      ).toThrow(/Missing checkpoint encryption key in production environment/);
    });

    it("derives key from CHECKPOINT_ENCRYPTION_KEY environment variable when options.secretKey is omitted", () => {
      process.env.CHECKPOINT_ENCRYPTION_KEY = "env-derived-wave3-secret-key!";
      const state = createInitialAgentGraphState({ classified_intent: "CHAT_ONLY" });

      const blob = encryptAgentGraphState(state);
      expect(decryptAgentGraphState(blob)).toEqual(state);
    });
  });
});
