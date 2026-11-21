/**
 * Test Suite: Elixent Native Graph Engine Runner & Cross-Contract Checkpointing (Wave 3.1)
 *
 * Verifies ADR-009 & SRS-01 §2.3 contracts across real internal seams:
 * - `ElixentNativeGraphRunner` (.invoke / .stream / loadLatestCheckpoint)
 * - Real `createInitialAgentGraphState` & `applyStateDelta` pure reducers
 * - Real AES-256-GCM `encryptAgentGraphState` / `decryptAgentGraphState`
 * - Real `ephemeral-memory-map` zero-knowledge leak enforcement
 * - Cross-contract `withMeteredNodeGate` INSUFFICIENT_CREDITS interruption inside runner
 *
 * Only true external I/O boundaries (`@/server/db` Postgres pool, `@/lib/redis`,
 * and `@/server/services/ai-settlement-service`) are stubbed in memory.
 */

import { describe, it, expect, expectTypeOf, vi, beforeEach } from "vitest";
import {
  ElixentNativeGraphRunner,
  MaxSuperStepsExceededError,
  GraphExecutionAbortedError,
  type AgentRuntimeContext,
  type AgentStreamEvent,
  type AgentGraphNodeFn,
  type GraphStreamYield,
} from "@/core/agent/engine/runner";
import {
  createInitialAgentGraphState,
  type AgentGraphState,
} from "@/core/agent/state";
import {
  CheckpointVaultLeakError,
  isEncryptedCheckpointEnvelope,
} from "@/core/agent/checkpoint-serializer";
import {
  runWithEphemeralVaultScope,
  storeEphemeralVaultSection,
} from "@/lib/vault/ephemeral-memory-map";
import { withMeteredNodeGate } from "@/lib/metering/node-gate";
import { REDIS_KEYS } from "@/lib/metering/constants";
import {
  RESERVE_OR_EXTEND_LUA,
  SETTLE_OPERATION_LUA,
  type RedisEvalClient,
} from "@/lib/metering/lua-scripts";
import type { IWorkspaceProvider } from "@/core/workspace/provider";

interface PersistedCheckpointRow {
  threadId: string;
  stepIndex: number;
  workspaceId: string;
  userId: string;
  nodeId: string;
  status: "RUNNING" | "INTERRUPTED" | "COMPLETED" | "FAILED";
  nextNodeId: string | null;
  interruptReason:
    | "HITL_CLARIFICATION_REQUIRED"
    | "FILE_DELETION_APPROVAL_REQUIRED"
    | "ANTI_DOMINO_CONFIRMATION_REQUIRED"
    | "INSUFFICIENT_CREDITS"
    | null;
  encryptedStateBlob: Buffer;
}

const checkpointStore = vi.hoisted(() => {
  const rows = new Map<string, PersistedCheckpointRow>();
  return {
    rows,
    clear: () => rows.clear(),
    key: (threadId: string, stepIndex: number) => `${threadId}::${stepIndex}`,
    listAll: () => Array.from(rows.values()),
    latestForThread: (threadId: string) => {
      const matching = Array.from(rows.values())
        .filter((r) => r.threadId === threadId)
        .sort((a, b) => b.stepIndex - a.stepIndex);
      return matching.slice(0, 1);
    },
  };
});

// Capture query parameter values when runner invokes db.select()...where(...)
// Drizzle `eq(col, val)` produces SQL chunks; we track active thread filter via a lightweight store.
const dbSelectThreadHint = vi.hoisted(() => ({ currentThreadId: "" }));

vi.mock("@/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db")>();

  const mockDb = {
    insert: vi.fn(() => ({
      values: (row: PersistedCheckpointRow) => ({
        onConflictDoUpdate: async (conflictOpts: {
          set: Partial<PersistedCheckpointRow>;
        }) => {
          const compositeKey = checkpointStore.key(row.threadId, row.stepIndex);
          const existing = checkpointStore.rows.get(compositeKey);
          if (existing) {
            checkpointStore.rows.set(compositeKey, {
              ...existing,
              ...conflictOpts.set,
            });
          } else {
            checkpointStore.rows.set(compositeKey, { ...row });
          }
        },
      }),
    })),
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async (limitCount: number) => {
              const all = checkpointStore.latestForThread(
                dbSelectThreadHint.currentThreadId,
              );
              return all.slice(0, limitCount);
            },
          }),
        }),
      }),
    })),
  };

  return {
    ...actual,
    db: mockDb,
  };
});

const mockGetUserCreditBalance = vi.hoisted(() => vi.fn());
const mockFlushPendingSettlementsToPostgres = vi.hoisted(() => vi.fn());

vi.mock("@/server/services/ai-settlement-service", () => ({
  getUserCreditBalance: mockGetUserCreditBalance,
  flushPendingSettlementsToPostgres: mockFlushPendingSettlementsToPostgres,
}));

vi.mock("@/lib/redis", () => ({
  isRedisConfigured: () => false,
  redis: null,
}));

function createTestRuntimeContext(
  overrides: Partial<AgentRuntimeContext> = {},
): {
  ctx: AgentRuntimeContext;
  events: AgentStreamEvent[];
  abortController: AbortController;
} {
  const events: AgentStreamEvent[] = [];
  const abortController = new AbortController();
  const threadId = overrides.threadId ?? "thread-native-001";
  dbSelectThreadHint.currentThreadId = threadId;

  const ctx: AgentRuntimeContext = {
    userId: "user-001",
    workspaceId: "ws-001",
    threadId,
    turnId: "turn-001",
    permissionMode: "safe",
    selectedSystem2ModelId: "google/gemini-3.8-flash",
    workspaceProvider: {} as IWorkspaceProvider,
    ephemeralVaultPayloads: new Map(),
    liveDocumentSnapshots: new Map(),
    emitSseEvent: (event) => {
      events.push(event);
    },
    abortSignal: abortController.signal,
    ...overrides,
  };

  return { ctx, events, abortController };
}

function createLowBalanceRedis(userId: string, balanceMicro: number): RedisEvalClient {
  const walletKey = REDIS_KEYS.wallet(userId);
  const wallets = new Map<string, number>([[walletKey, balanceMicro]]);
  const pendingSettlements = new Map<string, Map<string, string>>();
  return {
    wallets,
    pendingSettlements,
    async exists(key: string): Promise<number> {
      return wallets.has(key) ? 1 : 0;
    },
    async get(key: string): Promise<number | null> {
      return wallets.has(key) ? (wallets.get(key) ?? null) : null;
    },
    async eval<T = unknown>(
      script: string,
      keys: string[],
      args: (string | number)[],
    ): Promise<T> {
      if (script === RESERVE_OR_EXTEND_LUA) {
        const reqInput = Number(args[0]);
        const minOutput = Number(args[2]);
        const zeroDust = Number(args[3]);
        const needed = zeroDust === 1 ? reqInput : reqInput + minOutput;
        if (keys[0] === walletKey && balanceMicro < needed) {
          return JSON.stringify({
            status: "INSUFFICIENT_CREDITS",
            available: balanceMicro,
            required: needed,
          }) as unknown as T;
        }
        return JSON.stringify({
          status: "SUCCESS",
          reservedInputMicro: reqInput,
          reservedOutputMicro: 0,
          totalReservedMicro: reqInput,
          newBalanceMicro: balanceMicro - reqInput,
        }) as unknown as T;
      }
      if (script === SETTLE_OPERATION_LUA) {
        return JSON.stringify({ status: "SETTLED" }) as unknown as T;
      }
      throw new Error(`Unexpected script: ${script}`);
    },
  } as RedisEvalClient;
}

describe("ElixentNativeGraphRunner (ADR-009 & SRS-01 §2.3)", () => {
  beforeEach(() => {
    checkpointStore.clear();
    vi.clearAllMocks();
    mockGetUserCreditBalance.mockResolvedValue(BigInt(100));
  });

  describe("Sequential Execution, Conditional Gates & Encrypted Checkpoints", () => {
    it("executes conditional gate routing to completion, streams yields, and persists encrypted checkpoints per step", async () => {
      const routerNode: AgentGraphNodeFn = async (state) => ({
        status: "COMPLETED",
        stateDelta: {
          classified_intent: state.user_request.prompt.includes("chat")
            ? "CHAT_ONLY"
            : "WORKSPACE_READ_SEARCH",
        },
      });

      const directNode: AgentGraphNodeFn = async () => ({
        status: "COMPLETED",
        stateDelta: {
          messages: [
            {
              id: "msg-assistant-1",
              role: "assistant",
              content: "Direct response completed",
              createdAt: "2026-11-20T00:00:00.000Z",
            },
          ],
        },
      });

      const searchNode: AgentGraphNodeFn = async () => ({
        status: "COMPLETED",
        stateDelta: {
          search_loop_count: 1,
          local_inspection_state: ["doc-1.md#intro"],
        },
      });

      const runner = new ElixentNativeGraphRunner({
        entryNodeId: "router",
        nodes: {
          router: routerNode,
          direct: directNode,
          search: searchNode,
        },
        edges: {
          router: (state) =>
            state.classified_intent === "CHAT_ONLY" ? "direct" : "search",
          direct: null,
          search: "direct",
        },
      });

      expect(runner.maxSuperSteps).toBe(25);

      const initialState = createInitialAgentGraphState({
        user_request: {
          prompt: "search architecture docs",
          workspaceId: "ws-001",
          turnId: "turn-001",
          targetFileIds: ["doc-1.md"],
          permissionMode: "safe",
          selectedSystem2ModelId: "google/gemini-3.8-flash",
        },
      });

      const { ctx, events } = createTestRuntimeContext();
      const yields: GraphStreamYield[] = [];

      const gen = runner.stream(initialState, ctx);
      let next = await gen.next();
      while (!next.done) {
        yields.push(next.value);
        next = await gen.next();
      }
      const finalState: AgentGraphState = next.value;

      expect(yields.map((y) => [y.nodeId, y.stepIndex, y.status])).toEqual([
        ["router", 0, "COMPLETED"],
        ["search", 1, "COMPLETED"],
        ["direct", 2, "COMPLETED"],
      ]);

      expect(finalState.classified_intent).toBe("WORKSPACE_READ_SEARCH");
      expect(finalState.search_loop_count).toBe(1);
      expect(finalState.local_inspection_state).toEqual(["doc-1.md#intro"]);
      expect(finalState.messages).toHaveLength(1);
      expect(finalState.messages[0].content).toBe("Direct response completed");

      // SSE event sequence: start -> 3 updates -> done
      expect(events.map((e) => e.type)).toEqual([
        "start",
        "update",
        "update",
        "update",
        "done",
      ]);
      const doneEvent = events[events.length - 1];
      expect(doneEvent.type).toBe("done");
      if (doneEvent.type === "done") {
        expect(doneEvent.stepIndex).toBe(2);
      }

      // 1 encrypted checkpoint persisted per completed node
      const persisted = checkpointStore.listAll();
      expect(persisted).toHaveLength(3);
      for (const row of persisted) {
        const rawText = row.encryptedStateBlob.toString("utf-8");
        expect(rawText).not.toContain("search architecture docs");
        expect(rawText).not.toContain("Direct response completed");
        expect(isEncryptedCheckpointEnvelope(JSON.parse(rawText))).toBe(true);
      }

      // Latest checkpoint decrypts back into exact final state
      const loaded = await runner.loadLatestCheckpoint(ctx.workspaceId, ctx.threadId);
      expect(loaded).not.toBeNull();
      expect(loaded?.stepIndex).toBe(2);
      expect(loaded?.nodeId).toBe("direct");
      expect(loaded?.nextNodeId).toBeNull();
      expect(loaded?.status).toBe("COMPLETED");
      expect(loaded?.state).toEqual(finalState);
    });
  });

  describe("First-Class Interrupts & Checkpoint Resumption", () => {
    it("freezes state on INTERRUPTED node and resumes execution with stateOverrides into completion", async () => {
      const hitlNode: AgentGraphNodeFn = async (state) => {
        if (!state.clarification_answers) {
          return {
            status: "INTERRUPTED",
            interruptReason: "HITL_CLARIFICATION_REQUIRED",
            stateDelta: {
              question_queue: {
                questions: [
                  {
                    questionId: "q-db",
                    topicSlug: "database_engine",
                    questionPrompt: "Select primary database engine?",
                    options: [
                      { optionKey: "postgres", neutralSummary: "PostgreSQL" },
                      { optionKey: "sqlite", neutralSummary: "SQLite" },
                    ],
                  },
                ],
              },
            },
            interruptPayload: { questionCount: 1 },
          };
        }

        return {
          status: "COMPLETED",
          stateDelta: {
            question_queue: null,
            scored_decisions: [
              {
                decisionId: "dec-db",
                selectedOptionKey: state.clarification_answers.selectedOptionKey,
              },
            ],
          },
        };
      };

      const commitNode: AgentGraphNodeFn = async () => ({
        status: "COMPLETED",
        stateDelta: {
          clearInvalidationMap: true,
        },
      });

      const runner = new ElixentNativeGraphRunner({
        entryNodeId: "hitl",
        nodes: { hitl: hitlNode, commit: commitNode },
        edges: { hitl: "commit", commit: null },
      });

      const initialState = createInitialAgentGraphState({
        invalidation_map: {
          "dec-old": [{ fileId: "f1", headingSlug: "db" }],
        },
      });

      // Phase 1: Initial invocation interrupts at `hitl`
      const run1 = createTestRuntimeContext({ threadId: "thread-hitl-1" });
      const interruptedState = await runner.invoke(initialState, run1.ctx);

      expect(interruptedState.question_queue?.questions).toHaveLength(1);
      expect(run1.events.map((e) => e.type)).toEqual(["start", "interrupt"]);
      const interruptEvent = run1.events[1];
      expect(interruptEvent.type).toBe("interrupt");
      if (interruptEvent.type === "interrupt") {
        expect(interruptEvent.interruptReason).toBe("HITL_CLARIFICATION_REQUIRED");
        expect(interruptEvent.nodeId).toBe("hitl");
        expect(interruptEvent.interruptPayload).toEqual({ questionCount: 1 });
      }

      const savedCheckpoint = await runner.loadLatestCheckpoint(
        run1.ctx.workspaceId,
        run1.ctx.threadId,
      );
      expect(savedCheckpoint?.status).toBe("INTERRUPTED");
      expect(savedCheckpoint?.nodeId).toBe("hitl");
      expect(savedCheckpoint?.nextNodeId).toBe("hitl");

      // Phase 2: Resume with user clarification answers
      const run2 = createTestRuntimeContext({ threadId: "thread-hitl-1" });
      const resumedState = await runner.invoke(
        {
          resumeFromCheckpoint: true,
          stateOverrides: {
            clarification_answers: { selectedOptionKey: "postgres" },
          },
        },
        run2.ctx,
      );

      expect(resumedState.question_queue).toBeNull();
      expect(resumedState.scored_decisions).toEqual([
        { decisionId: "dec-db", selectedOptionKey: "postgres" },
      ]);
      expect(resumedState.invalidation_map).toEqual({});
      expect(run2.events.map((e) => e.type)).toEqual([
        "start",
        "update",
        "update",
        "done",
      ]);

      // Step indices advance monotonically: 0 (interrupted hitl) -> 1 (completed hitl) -> 2 (completed commit)
      const latestAfterResume = await runner.loadLatestCheckpoint(
        run2.ctx.workspaceId,
        run2.ctx.threadId,
      );
      expect(latestAfterResume?.stepIndex).toBe(2);
      expect(latestAfterResume?.nodeId).toBe("commit");
      expect(latestAfterResume?.status).toBe("COMPLETED");
    });

    it("resumes from a COMPLETED checkpoint at checkpoint.nextNodeId", async () => {
      const executedNodes: string[] = [];
      const runner = new ElixentNativeGraphRunner({
        entryNodeId: "step_a",
        nodes: {
          step_a: async () => {
            executedNodes.push("step_a");
            return { status: "COMPLETED", stateDelta: {} };
          },
          step_b: async () => {
            executedNodes.push("step_b");
            return {
              status: "COMPLETED",
              stateDelta: { local_inspection_state: ["resumed-at-b"] },
            };
          },
        },
        edges: { step_a: "step_b", step_b: null },
      });

      const { ctx } = createTestRuntimeContext({ threadId: "thread-completed-resume" });
      // Consume only step_a via stream, then stop generator early before step_b runs
      const stream = runner.stream(createInitialAgentGraphState(), ctx);
      const first = await stream.next();
      expect(first.done).toBe(false);
      expect(executedNodes).toEqual(["step_a"]);

      // Resuming from the completed step_a checkpoint must jump directly to step_b
      const resumed = await runner.invoke({ resumeFromCheckpoint: true }, ctx);
      expect(executedNodes).toEqual(["step_a", "step_b"]);
      expect(resumed.local_inspection_state).toEqual(["resumed-at-b"]);
    });

    it("throws and emits CHECKPOINT_NOT_FOUND error when resuming a thread with no saved checkpoint", async () => {
      const runner = new ElixentNativeGraphRunner({
        entryNodeId: "only",
        nodes: {
          only: async () => ({ status: "COMPLETED", stateDelta: {} }),
        },
        edges: { only: null },
      });

      const { ctx, events } = createTestRuntimeContext({
        threadId: "thread-missing-checkpoint",
      });

      await expect(
        runner.invoke({ resumeFromCheckpoint: true }, ctx),
      ).rejects.toThrow(/No checkpoint found to resume thread/);

      expect(events.at(-1)).toMatchObject({
        type: "error",
        code: "CHECKPOINT_NOT_FOUND",
      });
    });
  });

  describe("Guardrails: maxSuperSteps, AbortSignal & Missing Node", () => {
    it("throws MaxSuperStepsExceededError and emits error event when cycle exceeds maxSuperSteps", async () => {
      const runner = new ElixentNativeGraphRunner({
        entryNodeId: "loop_a",
        maxSuperSteps: 3,
        nodes: {
          loop_a: async () => ({ status: "COMPLETED", stateDelta: {} }),
          loop_b: async () => ({ status: "COMPLETED", stateDelta: {} }),
        },
        edges: { loop_a: "loop_b", loop_b: "loop_a" },
      });

      const { ctx, events } = createTestRuntimeContext({ threadId: "thread-loop" });

      await expect(
        runner.invoke(createInitialAgentGraphState(), ctx),
      ).rejects.toThrow(MaxSuperStepsExceededError);

      expect(events.at(-1)).toMatchObject({
        type: "error",
        code: "MAX_SUPER_STEPS_EXCEEDED",
      });
      expect(checkpointStore.listAll()).toHaveLength(3);
    });

    it("throws GraphExecutionAbortedError when AbortSignal fires before or during execution", async () => {
      const { ctx, events, abortController } = createTestRuntimeContext({
        threadId: "thread-abort",
      });

      const runner = new ElixentNativeGraphRunner({
        entryNodeId: "first",
        nodes: {
          first: async () => {
            abortController.abort();
            return { status: "COMPLETED", stateDelta: {} };
          },
          second: async () => ({
            status: "COMPLETED",
            stateDelta: { local_inspection_state: ["should-not-run"] },
          }),
        },
        edges: { first: "second", second: null },
      });

      await expect(
        runner.invoke(createInitialAgentGraphState(), ctx),
      ).rejects.toThrow(GraphExecutionAbortedError);

      expect(events.at(-1)).toMatchObject({
        type: "error",
        code: "GRAPH_EXECUTION_ABORTED",
      });
      // Only `first` persisted before abort stopped `second`
      expect(checkpointStore.listAll().map((r) => r.nodeId)).toEqual(["first"]);
    });

    it("throws and emits NODE_NOT_FOUND error when a gate routes to an unregistered node", async () => {
      const runner = new ElixentNativeGraphRunner({
        entryNodeId: "start",
        nodes: {
          start: async () => ({ status: "COMPLETED", stateDelta: {} }),
        },
        edges: { start: "ghost_node" },
      });

      const { ctx, events } = createTestRuntimeContext({
        threadId: "thread-missing-node",
      });

      await expect(
        runner.invoke(createInitialAgentGraphState(), ctx),
      ).rejects.toThrow(/Graph node "ghost_node" is not registered/);

      expect(events.at(-1)).toMatchObject({
        type: "error",
        code: "NODE_NOT_FOUND",
      });
    });
  });

  describe("Cross-Contract Seams: Vault Leak Guard & Metered Node Gate", () => {
    it("aborts with CheckpointVaultLeakError BEFORE persisting any checkpoint when a node leaks active vault plaintext", async () => {
      const runner = new ElixentNativeGraphRunner({
        entryNodeId: "leaky_node",
        nodes: {
          leaky_node: async () => ({
            status: "COMPLETED",
            stateDelta: {
              messages: [
                {
                  id: "m-leak",
                  role: "assistant",
                  content: "Leaked secret: TOP_SECRET_VAULT_CONTENT_999",
                  createdAt: "2026-11-20T00:00:00.000Z",
                },
              ],
            },
          }),
        },
        edges: { leaky_node: null },
      });

      const { ctx } = createTestRuntimeContext({ threadId: "thread-zk-leak" });

      await runWithEphemeralVaultScope(async () => {
        storeEphemeralVaultSection(
          "vault-doc-1",
          "secret-section",
          "TOP_SECRET_VAULT_CONTENT_999",
        );

        await expect(
          runner.invoke(createInitialAgentGraphState(), ctx),
        ).rejects.toThrow(CheckpointVaultLeakError);
      });

      // Zero checkpoint rows may be persisted if plaintext leaked
      expect(checkpointStore.listAll()).toHaveLength(0);
    });

    it("propagates withMeteredNodeGate INSUFFICIENT_CREDITS as a persisted INTERRUPTED checkpoint without running inner node", async () => {
      const innerSpy = vi.fn<AgentGraphNodeFn>(async () => ({
        status: "COMPLETED",
        stateDelta: { local_inspection_state: ["must-not-execute"] },
      }));

      const lowBalanceRedis = createLowBalanceRedis("user-low-bal", 100);

      const meteredNode = withMeteredNodeGate(
        "expensive_system2_node",
        "system2",
        innerSpy,
        {
          customRedis: lowBalanceRedis,
          isSystem2Node: true,
          pessimisticInputTokens: 2000,
        },
      );

      const runner = new ElixentNativeGraphRunner({
        entryNodeId: "metered",
        nodes: { metered: meteredNode },
        edges: { metered: null },
      });

      const { ctx, events } = createTestRuntimeContext({
        userId: "user-low-bal",
        threadId: "thread-insufficient-credits",
        selectedSystem2ModelId: "google/gemini-4-argon",
      });

      const finalState = await runner.invoke(createInitialAgentGraphState(), ctx);

      expect(innerSpy).not.toHaveBeenCalled();
      expect(finalState.local_inspection_state).toEqual([]);
      expect(events.map((e) => e.type)).toEqual(["start", "interrupt"]);
      expect(events[1]).toMatchObject({
        type: "interrupt",
        nodeId: "metered",
        interruptReason: "INSUFFICIENT_CREDITS",
        interruptPayload: {
          availableMicro: 100,
          requiredMicro: expect.any(Number),
        },
      });

      const persisted = checkpointStore.listAll();
      expect(persisted).toHaveLength(1);
      expect(persisted[0].status).toBe("INTERRUPTED");
      expect(persisted[0].interruptReason).toBe("INSUFFICIENT_CREDITS");
    });

    it("enforces BUG-04 clean-cut removal of streamGovernor from AgentRuntimeContext and forwards node mutation SSE events", async () => {
      // Static type invariant: AgentRuntimeContext must never re-introduce streamGovernor
      expectTypeOf<AgentRuntimeContext>().not.toHaveProperty("streamGovernor");

      const mutatorNode: AgentGraphNodeFn = async (_state, ctx) => {
        expect("streamGovernor" in ctx).toBe(false);
        ctx.emitSseEvent({
          type: "ghost_hunk_proposed",
          fileId: "file-a",
          headingSlug: "overview",
          hunks: [{ from: 0, to: 5, replacementText: "Draft" }],
        });
        ctx.emitSseEvent({
          type: "file_mutated",
          fileId: "file-b",
          relativePath: "docs/new.md",
          action: "created",
        });
        ctx.emitSseEvent({
          type: "vault_file_commit_required",
          fileId: "file-enc",
          relativePath: "vault/plan.md",
          mergedContent: "# Merged ZK Content",
        });
        return {
          status: "COMPLETED",
          stateDelta: { local_inspection_state: ["file-a#overview"] },
        };
      };

      const runner = new ElixentNativeGraphRunner({
        entryNodeId: "mutator",
        nodes: { mutator: mutatorNode },
        edges: { mutator: null },
      });

      const { ctx, events } = createTestRuntimeContext({ threadId: "thread-w4-events" });
      await runner.invoke(createInitialAgentGraphState(), ctx);

      expect(events.map((e) => e.type)).toEqual([
        "start",
        "ghost_hunk_proposed",
        "file_mutated",
        "vault_file_commit_required",
        "update",
        "done",
      ]);
    });
  });
});
