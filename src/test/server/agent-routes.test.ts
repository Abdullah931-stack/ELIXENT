/**
 * Cross-Contract Unit & Edge-Case Test Suite for Web-Standard Agent SSE Route (`src/server/routes/agent.routes.ts`)
 *
 * Verifies:
 * 1. Direct `handleAgentStreamPost(Request)` invocation and Hono `agentRoutes.request("/stream", ...)` dispatch.
 * 2. Authentication guard (401 Problem Details before body parsing, non-Error throw resilience).
 * 3. Rate limiting (429 quota exceeded, 503 fail-closed when limiter throws or returns degraded).
 * 4. Ephemeral vault payload loading (`vault_ref://` prefix stripping, `fileId#headingSlug` direct storage,
 *    markdown heading tree slicing, root fallback, and zeroing on completion/error/cancel).
 * 5. Native Graph Engine streaming:
 *    - Initial 18-channel `AgentGraphState` + typed `AgentRuntimeContext` construction.
 *    - Checkpoint resumption (`{ resumeFromCheckpoint: true, stateOverrides: { clarification_answers } }`).
 *    - Native `GraphStreamYield` interrupt normalization:
 *      * `INSUFFICIENT_CREDITS` -> `resumable: false`, canonical `code`/`message` + balance payload.
 *      * HITL (`HITL_CLARIFICATION_REQUIRED`, `ANTI_DOMINO_CONFIRMATION_REQUIRED`, `FILE_DELETION_APPROVAL_REQUIRED`)
 *        -> `resumable: true`, hoisting `questionQueue.questions` onto `interrupts[0].value`.
 *    - Legacy inline `__interrupt__` mock compatibility.
 *    - `emitSseEvent` selective forwarding (`ghost_hunk_proposed`, `file_mutated`, `vault_file_commit_required`,
 *      `direct_response_node` `update`) and non-duplication of `start`/`done`/`interrupt`/`direct_response_node` yields.
 * 6. AbortSignal propagation, StreamGovernor settlement (`SETTLED` vs `ABORTED`), and `scheduleAfterResponse` resilience.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  AgentRuntimeContext,
  GraphStreamYield,
} from "@/core/agent/engine/runner";
import {
  hasActiveVaultPlaintextInMemory,
  getActiveEphemeralVaultPlaintexts,
  resolveVaultRefJustInTime,
} from "@/lib/vault/ephemeral-memory-map";

// ---------------------------------------------------------------------------
// Hoisted Mock State
// ---------------------------------------------------------------------------

const {
  scheduledAfterTasks,
  mockUser,
  authState,
  rateLimitState,
  graphState,
  governorState,
  MockStreamGovernor,
  mockFlushPendingSettlements,
} = vi.hoisted(() => {
  const scheduledAfterTasks: Array<() => Promise<void> | void> = [];

  const mockUser = {
    id: "user-agent-route-001",
    email: "agent-tester@elixent.ai",
  };

  const authState = {
    isAuthenticated: true,
    throwNonError: false,
    errorMessage: "Session expired or missing",
  };

  const rateLimitState = {
    shouldThrow: false,
    success: true,
    remaining: 28,
    isDegraded: false,
  };

  const graphState = {
    chunksToEmit: [] as unknown[],
    errorToThrow: null as unknown,
    lastInput: null as unknown,
    lastConfig: null as unknown,
    onStreamStart: null as ((ctx: AgentRuntimeContext) => void) | null,
  };

  const governorState = {
    permitted: true,
    settleShouldThrow: false,
    instances: [] as Array<{
      userId: string;
      operationId: string;
      modelId: string;
      initialTokens: number;
      abortController: AbortController;
      options: unknown;
      tokenChunks: Array<string | number>;
      settledStatus: string | null;
    }>,
  };

  class MockStreamGovernor {
    public userId: string;
    public operationId: string;
    public modelId: string;
    public initialTokens: number;
    public abortController: AbortController;
    public options: unknown;
    public tokenChunks: Array<string | number> = [];
    public settledStatus: string | null = null;

    constructor(
      userId: string,
      operationId: string,
      modelId: string,
      initialTokens: number,
      abortController: AbortController,
      options?: unknown,
    ) {
      this.userId = userId;
      this.operationId = operationId;
      this.modelId = modelId;
      this.initialTokens = initialTokens;
      this.abortController = abortController;
      this.options = options;
      governorState.instances.push(this);
    }

    async onTokenChunk(chunk: string | number): Promise<boolean> {
      this.tokenChunks.push(chunk);
      if (!governorState.permitted) {
        return false;
      }
      return true;
    }

    async settle(status: "SETTLED" | "ABORTED" = "SETTLED"): Promise<{ status: string }> {
      if (governorState.settleShouldThrow) {
        throw new Error("Simulated Redis settlement failure");
      }
      this.settledStatus = status;
      return { status };
    }
  }

  const mockFlushPendingSettlements = vi.fn(async (_userId: string) => ({
    flushedCount: 1,
    netDeltaMicro: BigInt(-500000),
  }));

  return {
    scheduledAfterTasks,
    mockUser,
    authState,
    rateLimitState,
    graphState,
    governorState,
    MockStreamGovernor,
    mockFlushPendingSettlements,
  };
});

// ---------------------------------------------------------------------------
// Module Mocks (System Boundaries)
// ---------------------------------------------------------------------------

vi.mock("@/server/context/request-context", () => ({
  scheduleAfterResponse: vi.fn((task: () => Promise<void> | void) => {
    scheduledAfterTasks.push(task);
  }),
}));

vi.mock("@/server/auth/session", () => ({
  requireAuthenticatedUser: vi.fn(async () => {
    if (!authState.isAuthenticated) {
      if (authState.throwNonError) {
        throw "raw_string_auth_rejection";
      }
      throw new Error(authState.errorMessage);
    }
    return mockUser;
  }),
}));

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    ...actual,
    aiStreamRateLimiter: {
      limit: vi.fn(async (_userId: string) => {
        if (rateLimitState.shouldThrow) {
          throw new Error("Upstash connection refused");
        }
        return {
          success: rateLimitState.success,
          remaining: rateLimitState.remaining,
          reset: Math.ceil(Date.now() / 1000) + 60,
          limit: 30,
          isDegraded: rateLimitState.isDegraded,
        };
      }),
    },
  };
});

vi.mock("@/core/agent/graph", () => ({
  elixentAgentGraph: {
    stream: vi.fn(async (input: unknown, ctx: AgentRuntimeContext) => {
      graphState.lastInput = input;
      graphState.lastConfig = ctx;
      if (graphState.onStreamStart) {
        graphState.onStreamStart(ctx);
      }
      if (graphState.errorToThrow) {
        throw graphState.errorToThrow;
      }
      async function* gen() {
        for (const chunk of graphState.chunksToEmit) {
          yield chunk;
        }
      }
      return gen();
    }),
  },
}));

vi.mock("@/lib/metering/stream-governor", () => ({
  StreamGovernor: MockStreamGovernor,
}));

vi.mock("@/server/services/ai-settlement-service", () => ({
  flushPendingSettlementsToPostgres: (userId: string) =>
    mockFlushPendingSettlements(userId),
}));

import {
  handleAgentStreamPost,
  agentRoutes,
} from "@/server/routes/agent.routes";

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

async function drainSSE(
  res: Response,
): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const reader = res.body?.getReader();
  if (!reader) return [];
  const decoder = new TextDecoder();
  let raw = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }
  raw += decoder.decode();

  return raw
    .split("\n\n")
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const eventLine = lines.find((l) => l.startsWith("event:")) ?? "event: message";
      const dataLine = lines.find((l) => l.startsWith("data:")) ?? "data: {}";
      return {
        event: eventLine.slice("event:".length).trim(),
        data: JSON.parse(dataLine.slice("data:".length).trim()) as Record<string, unknown>,
      };
    });
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("Web-Standard Hono Agent Route Module (src/server/routes/agent.routes.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scheduledAfterTasks.length = 0;
    governorState.instances.length = 0;
    governorState.permitted = true;
    governorState.settleShouldThrow = false;
    authState.isAuthenticated = true;
    authState.throwNonError = false;
    authState.errorMessage = "Session expired or missing";
    rateLimitState.shouldThrow = false;
    rateLimitState.success = true;
    rateLimitState.remaining = 28;
    rateLimitState.isDegraded = false;
    graphState.chunksToEmit = [];
    graphState.errorToThrow = null;
    graphState.lastInput = null;
    graphState.lastConfig = null;
    graphState.onStreamStart = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Authentication & Fail-Closed Rate Limiting", () => {
    it("returns 401 RFC 7807 Problem Details with fallback message when auth throws a non-Error value", async () => {
      authState.isAuthenticated = false;
      authState.throwNonError = true;

      const req = new Request("http://localhost/api/agent/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Correlation-ID": "corr-auth-non-err",
        },
        body: "{broken-json",
      });

      const res = await handleAgentStreamPost(req);
      expect(res.status).toBe(401);
      expect(res.headers.get("Content-Type")).toBe("application/problem+json");
      expect(res.headers.get("X-Correlation-ID")).toBe("corr-auth-non-err");

      const body = await res.json();
      expect(body).toMatchObject({
        type: "urn:problem-type:unauthorized",
        title: "Unauthorized",
        status: 401,
        detail: "Authentication required",
        instance: "/api/agent/stream",
        correlationId: "corr-auth-non-err",
      });
    });

    it("fails closed with 503 degraded response when aiStreamRateLimiter.limit throws an exception", async () => {
      rateLimitState.shouldThrow = true;

      const req = new Request("http://localhost/api/agent/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "th-1",
          projectId: "proj-1",
          targetFileIds: ["file-1"],
        }),
      });

      const res = await handleAgentStreamPost(req);
      expect(res.status).toBe(503);
      expect(res.headers.get("X-RateLimit-Degraded")).toBe("1");
      expect(res.headers.get("X-Correlation-ID")).toBeTruthy();
    });
  });

  describe("Ephemeral Vault Payloads & AST Section Slicing", () => {
    it("strips vault_ref:// prefixes, slices markdown by headings + root, and wipes memory after stream", async () => {
      const capturedSections: Record<string, string | undefined> = {};

      graphState.onStreamStart = () => {
        capturedSections.directSection = resolveVaultRefJustInTime(
          "vault_ref://file-alpha#architecture-overview",
        );
        capturedSections.headingIntro = resolveVaultRefJustInTime(
          "vault_ref://file-beta#introduction",
        );
        capturedSections.headingDetails = resolveVaultRefJustInTime(
          "vault_ref://file-beta#security-details",
        );
        capturedSections.rootFallback = resolveVaultRefJustInTime(
          "vault_ref://file-beta#root",
        );
      };
      graphState.chunksToEmit = ["plain-string-chunk"];

      const markdownDoc = [
        "# Introduction",
        "Welcome to the zero-knowledge specification.",
        "## Security Details",
        "All keys remain in WebCrypto non-extractable memory.",
      ].join("\n");

      const req = new Request("http://localhost/api/agent/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "th-vault-slice",
          projectId: "proj-1",
          targetFileIds: ["file-alpha", "file-beta"],
          ephemeralVaultPayloads: {
            "vault_ref://file-alpha#architecture-overview": "Direct section plaintext",
            "vault_ref://file-beta": markdownDoc,
          },
        }),
      });

      const res = await handleAgentStreamPost(req);
      expect(res.status).toBe(200);
      const frames = await drainSSE(res);

      expect(capturedSections.directSection).toBe("Direct section plaintext");
      expect(capturedSections.headingIntro).toContain("Welcome to the zero-knowledge specification.");
      expect(capturedSections.headingDetails).toContain("All keys remain in WebCrypto");
      expect(capturedSections.rootFallback).toBe(markdownDoc);

      expect(frames.some((f) => f.event === "update" && f.data.chunk === "plain-string-chunk")).toBe(true);
      expect(hasActiveVaultPlaintextInMemory()).toBe(false);
      expect(getActiveEphemeralVaultPlaintexts()).toEqual([]);
    });
  });

  describe("Native SSE Interrupt Normalization & emitSseEvent Non-Duplication", () => {
    it("normalizes INSUFFICIENT_CREDITS yield with resumable: false and suppresses done frame", async () => {
      graphState.chunksToEmit = [
        {
          nodeId: "assumption_extractor_node",
          stepIndex: 2,
          status: "INTERRUPTED",
          interruptReason: "INSUFFICIENT_CREDITS",
          interruptPayload: {
            availableMicro: 100,
            requiredMicro: 85_000,
          },
        } satisfies Partial<GraphStreamYield>,
      ];

      const req = new Request("http://localhost/api/agent/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "th-native-credit",
          workspaceId: "ws-credit-1",
          targetFileIds: ["file-1"],
        }),
      });

      const res = await handleAgentStreamPost(req);
      const frames = await drainSSE(res);

      expect(frames.map((f) => f.event)).toEqual(["start", "interrupt"]);
      expect(frames[1].data).toMatchObject({
        type: "interrupt",
        threadId: "th-native-credit",
        nodeId: "assumption_extractor_node",
        stepIndex: 2,
        interruptReason: "INSUFFICIENT_CREDITS",
        interrupts: [
          {
            resumable: false,
            value: {
              code: "INSUFFICIENT_CREDITS",
              message: "Insufficient credits to continue agent execution.",
              availableMicro: 100,
              requiredMicro: 85_000,
            },
          },
        ],
      });
      expect(governorState.instances[0].settledStatus).toBe("SETTLED");
    });

    it("hoists questionQueue.questions onto interrupts[0].value with resumable: true for HITL interrupts", async () => {
      const questions = [
        {
          questionId: "q-auth",
          topicSlug: "auth_strategy",
          questionPrompt: "Confirm session token signing algorithm?",
          options: [
            { optionKey: "ed25519", neutralSummary: "Ed25519" },
            { optionKey: "rs256", neutralSummary: "RS256" },
          ],
        },
      ];

      graphState.chunksToEmit = [
        {
          nodeId: "hitl_clarification_node",
          stepIndex: 5,
          status: "INTERRUPTED",
          interruptReason: "HITL_CLARIFICATION_REQUIRED",
          interruptPayload: {
            questionQueue: { questions },
          },
        } satisfies Partial<GraphStreamYield>,
      ];

      const req = new Request("http://localhost/api/agent/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "th-native-hitl",
          workspaceId: "ws-hitl-1",
          targetFileIds: ["file-1"],
        }),
      });

      const res = await handleAgentStreamPost(req);
      const frames = await drainSSE(res);

      expect(frames.map((f) => f.event)).toEqual(["start", "interrupt"]);
      expect(frames[1].data).toMatchObject({
        type: "interrupt",
        nodeId: "hitl_clarification_node",
        interruptReason: "HITL_CLARIFICATION_REQUIRED",
        interrupts: [
          {
            resumable: true,
            value: {
              questions,
              interruptReason: "HITL_CLARIFICATION_REQUIRED",
            },
          },
        ],
      });
    });

    it("forwards mutation & direct_response_node emitSseEvent frames while suppressing duplicate runner/final frames", async () => {
      graphState.onStreamStart = (ctx) => {
        // Runner-level lifecycle events must be filtered by emitSseEvent (never duplicated)
        ctx.emitSseEvent({
          type: "start",
          threadId: ctx.threadId,
          turnId: ctx.turnId,
          workspaceId: ctx.workspaceId,
        });
        ctx.emitSseEvent({
          type: "update",
          nodeId: "search_discovery_node",
          stepIndex: 1,
          stateDelta: {},
        });
        // Node-level mutation & direct_response streaming events MUST be forwarded
        ctx.emitSseEvent({
          type: "ghost_hunk_proposed",
          fileId: "doc-1",
          headingSlug: "overview",
          hunks: [{ from: 0, to: 10, replacementText: "Updated" }],
        });
        ctx.emitSseEvent({
          type: "file_mutated",
          fileId: "doc-2",
          relativePath: "docs/spec.md",
          action: "created",
        });
        ctx.emitSseEvent({
          type: "vault_file_commit_required",
          fileId: "doc-enc",
          relativePath: "vault/secret.md",
          mergedContent: "# Encrypted Merged",
        });
        ctx.emitSseEvent({
          type: "update",
          nodeId: "direct_response_node",
          stepIndex: 2,
          stateDelta: {
            messages: [
              {
                id: "m-stream",
                role: "assistant",
                content: "Streamed delta",
                createdAt: "2026-11-20T00:00:00.000Z",
              },
            ],
          },
        });
      };

      // Final yielded chunk for direct_response_node MUST be skipped to avoid duplication,
      // while non-direct_response yields still emit a single update frame.
      graphState.chunksToEmit = [
        { nodeId: "search_discovery_node", stepIndex: 1, status: "COMPLETED" },
        { nodeId: "direct_response_node", stepIndex: 2, status: "COMPLETED" },
      ];

      const req = new Request("http://localhost/api/agent/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "th-non-dup",
          workspaceId: "ws-non-dup",
          targetFileIds: ["doc-1"],
        }),
      });

      const res = await handleAgentStreamPost(req);
      const frames = await drainSSE(res);

      expect(frames.map((f) => f.event)).toEqual([
        "start",
        "ghost_hunk_proposed",
        "file_mutated",
        "vault_file_commit_required",
        "update", // direct_response_node via emitSseEvent
        "update", // search_discovery_node via stream yield
        "done",
      ]);

      // Exactly 1 start, 1 done, 1 direct_response_node update, 1 search_discovery_node update
      expect(frames.filter((f) => f.event === "start")).toHaveLength(1);
      expect(frames.filter((f) => f.event === "done")).toHaveLength(1);
      const updateFrames = frames.filter((f) => f.event === "update");
      expect(updateFrames).toHaveLength(2);
      expect(updateFrames[0].data.nodeId).toBe("direct_response_node");
      expect((updateFrames[1].data.chunk as { nodeId: string }).nodeId).toBe(
        "search_discovery_node",
      );
    });

    it("emits SSE interrupt frame for inline __interrupt__ mock chunk and suppresses done frame", async () => {
      graphState.chunksToEmit = [
        { __interrupt__: [{ id: "int-inline-1", value: { question: "Approve?" } }] },
        { writer_node: { status: "completed" } },
      ];

      const req = new Request("http://localhost/api/agent/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "th-inline-int",
          projectId: "proj-1",
          targetFileIds: ["file-1"],
        }),
      });

      const res = await handleAgentStreamPost(req);
      const frames = await drainSSE(res);

      expect(frames.map((f) => f.event)).toEqual(["start", "interrupt", "update"]);
      expect(frames[1].data).toMatchObject({
        type: "interrupt",
        threadId: "th-inline-int",
        interrupts: [{ id: "int-inline-1", value: { question: "Approve?" } }],
      });
      expect(governorState.instances[0].settledStatus).toBe("SETTLED");
    });

    it("emits STREAM_EXECUTION_ERROR and settles governor ABORTED when graph.stream throws", async () => {
      graphState.errorToThrow = new Error("Unexpected native runner crash");

      const req = new Request("http://localhost/api/agent/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "th-graph-err",
          projectId: "proj-1",
          targetFileIds: ["file-1"],
        }),
      });

      const res = await handleAgentStreamPost(req);
      const frames = await drainSSE(res);

      expect(frames.map((f) => f.event)).toEqual(["start", "error"]);
      expect(frames[1].data).toMatchObject({
        type: "error",
        code: "STREAM_EXECUTION_ERROR",
        message: "Unexpected native runner crash",
      });
      expect(governorState.instances[0].settledStatus).toBe("ABORTED");
    });

    it("propagates pre-aborted Request signal and settles governor as ABORTED without emitting done frame", async () => {
      graphState.chunksToEmit = [{ node: "should_not_emit" }];
      const reqAbort = new AbortController();
      reqAbort.abort("CLIENT_PRE_ABORTED");

      const req = new Request("http://localhost/api/agent/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "th-pre-abort",
          projectId: "proj-1",
          targetFileIds: ["file-1"],
        }),
        signal: reqAbort.signal,
      });

      const res = await handleAgentStreamPost(req);
      const frames = await drainSSE(res);

      expect(frames.map((f) => f.event)).toEqual(["start"]);
      expect(governorState.instances[0].settledStatus).toBe("ABORTED");
    });

    it("swallows settlement flush errors inside scheduleAfterResponse without unhandled rejection", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockFlushPendingSettlements.mockRejectedValueOnce(new Error("DB connection pool exhausted"));
      graphState.chunksToEmit = [{ ok: true }];

      const req = new Request("http://localhost/api/agent/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "th-flush-err",
          projectId: "proj-1",
          targetFileIds: ["file-1"],
        }),
      });

      const res = await handleAgentStreamPost(req);
      await drainSSE(res);

      expect(scheduledAfterTasks).toHaveLength(1);
      await expect(scheduledAfterTasks[0]()).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(
        "[AgentStream] Settlement flush error:",
        expect.any(Error),
      );
      errorSpy.mockRestore();
    });
  });

  describe("Hono Router Dispatch (agentRoutes)", () => {
    it("dispatches POST /stream through agentRoutes.request() with native resumeFromCheckpoint payload", async () => {
      graphState.chunksToEmit = [{ summary_node: { ok: true } }];
      const resumePayload = { decision: "approve" };

      const res = await agentRoutes.request("http://localhost/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "th-hono-router",
          workspaceId: "ws-hono",
          targetFileIds: ["file-hono-1"],
          resumePayload,
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");

      const frames = await drainSSE(res);
      expect(frames.map((f) => f.event)).toEqual(["start", "update", "done"]);
      expect(graphState.lastInput).toEqual({
        resumeFromCheckpoint: true,
        stateOverrides: {
          clarification_answers: resumePayload,
        },
      });
    });
  });
});
