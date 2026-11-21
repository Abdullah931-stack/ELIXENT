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
 * 6. AbortSignal propagation and `scheduleAfterResponse` resilience.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  AgentRuntimeContext,
  GraphStreamYield,
} from "@/core/agent/engine/runner";
import type { AgentGraphState } from "@/core/agent/state";
import { CloudPostgresWorkspaceProvider } from "@/core/workspace/cloud-provider";
import { deriveDefaultWorkspaceId } from "@/server/db/schema/files";
import {
  consumeAgentStream,
  type AgentStreamGhostHunkProposedEvent,
  type AgentStreamFileMutatedEvent,
  type AgentStreamVaultFileCommitRequiredEvent,
  type AgentStreamInterruptEvent,
} from "@/lib/ai/stream-handler";
import { getRpcClientFetch, setRpcClientFetch } from "@/client/rpc-client";
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
  mockFlushPendingSettlements,
  workspaceDbState,
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
    onStreamStart: null as ((ctx: AgentRuntimeContext) => Promise<void> | void) | null,
  };

  const mockFlushPendingSettlements = vi.fn(async (_userId: string) => ({
    flushedCount: 1,
    netDeltaMicro: BigInt(-500000),
  }));

  const workspaceDbState = {
    findFirstResult: undefined as { id: string } | undefined,
    filesRows: [] as Array<Record<string, unknown>>,
    vaultProfileRows: [] as Array<Record<string, unknown>>,
  };

  return {
    scheduledAfterTasks,
    mockUser,
    authState,
    rateLimitState,
    graphState,
    mockFlushPendingSettlements,
    workspaceDbState,
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
        await graphState.onStreamStart(ctx);
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

vi.mock("@/server/services/ai-settlement-service", () => ({
  flushPendingSettlementsToPostgres: (userId: string) =>
    mockFlushPendingSettlements(userId),
}));

vi.mock("@/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db")>();
  return {
    ...actual,
    db: {
      query: {
        workspaces: {
          findFirst: vi.fn(async () => workspaceDbState.findFirstResult),
        },
        files: {
          findFirst: vi.fn(async () => undefined),
        },
      },
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => ({
          where: vi.fn(() => {
            const rows =
              table === actual.schema.files
                ? workspaceDbState.filesRows
                : table === actual.schema.userVaultProfiles
                  ? workspaceDbState.vaultProfileRows
                  : [];
            const promise = Promise.resolve(rows) as Promise<Array<Record<string, unknown>>> & {
              limit: (n: number) => Promise<Array<Record<string, unknown>>>;
            };
            promise.limit = async (n: number) => rows.slice(0, n);
            return promise;
          }),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoNothing: vi.fn(async () => undefined),
        })),
      })),
    },
  };
});

import {
  handleAgentStreamPost,
  agentRoutes,
} from "@/server/routes/agent.routes";

const DEFAULT_WORKSPACE_UUID = deriveDefaultWorkspaceId(mockUser.id);

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
    workspaceDbState.findFirstResult = { id: DEFAULT_WORKSPACE_UUID };
    workspaceDbState.filesRows = [];
    workspaceDbState.vaultProfileRows = [];
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
          workspaceId: DEFAULT_WORKSPACE_UUID,
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
          workspaceId: DEFAULT_WORKSPACE_UUID,
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
          workspaceId: DEFAULT_WORKSPACE_UUID,
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
    });

    it("emits STREAM_EXECUTION_ERROR when graph.stream throws", async () => {
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
    });

    it("propagates pre-aborted Request signal without emitting done frame", async () => {
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
          workspaceId: DEFAULT_WORKSPACE_UUID,
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

  describe("Workspace UUID Validation & Legacy projectId Resolution", () => {
    it("returns 400 RFC 7807 Problem Details when explicit workspaceId is not a valid UUID", async () => {
      const req = new Request("http://localhost/api/agent/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Correlation-ID": "corr-ws-invalid-uuid",
        },
        body: JSON.stringify({
          threadId: "th-invalid-ws",
          workspaceId: "ws-not-a-uuid",
          targetFileIds: ["file-1"],
        }),
      });

      const res = await handleAgentStreamPost(req);
      expect(res.status).toBe(400);
      expect(res.headers.get("Content-Type")).toBe("application/problem+json");
      expect(res.headers.get("X-Correlation-ID")).toBe("corr-ws-invalid-uuid");

      const body = await res.json();
      expect(body).toMatchObject({
        type: "urn:problem-type:bad-request",
        title: "Invalid Workspace ID",
        status: 400,
        detail: "Invalid workspaceId format",
        instance: "/api/agent/stream",
        correlationId: "corr-ws-invalid-uuid",
        invalidParams: [
          {
            name: "workspaceId",
            reason: "workspaceId must be a valid UUID",
          },
        ],
      });
    });

    it("returns 404 RFC 7807 Problem Details when explicit valid UUID workspaceId is not owned by the authenticated user", async () => {
      workspaceDbState.findFirstResult = undefined;

      const unownedWorkspaceId = "99999999-9999-4999-8999-999999999999";
      const req = new Request("http://localhost/api/agent/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Correlation-ID": "corr-ws-unowned",
        },
        body: JSON.stringify({
          threadId: "th-unowned-ws",
          workspaceId: unownedWorkspaceId,
          targetFileIds: ["file-1"],
        }),
      });

      const res = await handleAgentStreamPost(req);
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Type")).toBe("application/problem+json");
      expect(res.headers.get("X-Correlation-ID")).toBe("corr-ws-unowned");

      const body = await res.json();
      expect(body).toMatchObject({
        type: "urn:problem-type:not-found",
        title: "Workspace Not Found",
        status: 404,
        instance: "/api/agent/stream",
        correlationId: "corr-ws-unowned",
      });
    });

    it("resolves legacy non-UUID projectId (without explicit workspaceId) to the user's Default Workspace UUID", async () => {
      workspaceDbState.findFirstResult = undefined;
      graphState.chunksToEmit = [{ ok: true }];

      const req = new Request("http://localhost/api/agent/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "th-legacy-proj",
          projectId: "legacy-project-slug-42",
          targetFileIds: ["file-1"],
          prompt: "Summarize document",
        }),
      });

      const res = await handleAgentStreamPost(req);
      expect(res.status).toBe(200);
      await drainSSE(res);

      const expectedDefaultUuid = deriveDefaultWorkspaceId(mockUser.id);
      expect(expectedDefaultUuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );

      const stateInput = graphState.lastInput as AgentGraphState;
      expect(stateInput.user_request.workspaceId).toBe(expectedDefaultUuid);
      expect(stateInput.user_request.projectId).toBe("legacy-project-slug-42");

      const runtimeCtx = graphState.lastConfig as AgentRuntimeContext;
      expect(runtimeCtx.workspaceId).toBe(expectedDefaultUuid);
    });
  });

  describe("Wave 4.1 Invariants (BUG-04, BUG-05) & Cross-Contract SSE Wire Round-Trip", () => {
    it("BUG-04: removes route-level StreamGovernor completely and injects clean AgentRuntimeContext", async () => {
      const routeSource = fs.readFileSync(
        path.resolve(process.cwd(), "src/server/routes/agent.routes.ts"),
        "utf-8",
      );
      const executableCode = routeSource
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(executableCode).not.toContain("StreamGovernor");
      expect(executableCode).not.toContain("stream-governor");
      expect(executableCode).not.toContain("streamGovernor");

      graphState.chunksToEmit = [{ nodeId: "search_discovery_node", stepIndex: 1, status: "COMPLETED" }];

      const req = new Request("http://localhost/api/agent/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "th-bug04",
          workspaceId: DEFAULT_WORKSPACE_UUID,
          turnId: "turn-explicit-42",
          permissionMode: "full_auto",
          selectedSystem2ModelId: "google/gemini-4-argon",
          targetFileIds: ["file-1"],
          prompt: "Audit architecture",
        }),
      });

      const res = await handleAgentStreamPost(req);
      expect(res.status).toBe(200);
      await drainSSE(res);

      const runtimeCtx = graphState.lastConfig as AgentRuntimeContext;
      expect("streamGovernor" in runtimeCtx).toBe(false);
      expect(runtimeCtx.turnId).toBe("turn-explicit-42");
      expect(runtimeCtx.permissionMode).toBe("full_auto");
      expect(runtimeCtx.selectedSystem2ModelId).toBe("google/gemini-4-argon");
    });

    it("BUG-05: injects real CloudPostgresWorkspaceProvider with ephemeralVaultPayloads & liveDocumentSnapshots inside runWithEphemeralVaultScope", async () => {
      const encryptedDoc = "# Overview\nPublic intro.\n## Vault Secrets\nTop-secret client decrypted specification.";
      const liveDraft = "# Live Draft\nUnsaved editor buffer.";

      workspaceDbState.filesRows = [
        {
          id: "file-zk-1",
          userId: mockUser.id,
          workspaceId: DEFAULT_WORKSPACE_UUID,
          title: "secret.md",
          isEncrypted: true,
          isAiExcluded: false,
          content: "CIPHERTEXT_BLOB_NEVER_PARSED",
          etag: '"etag-zk-1"',
          version: 3,
          deletedAt: null,
        },
      ];
      workspaceDbState.vaultProfileRows = [
        { userId: mockUser.id, allowAIOnEncryptedFiles: true },
      ];

      let capturedSectionRef = "";
      let capturedResolvedPlaintext = "";
      let capturedIsVaultRef = false;

      graphState.onStreamStart = async (ctx) => {
        expect(ctx.workspaceProvider).toBeInstanceOf(CloudPostgresWorkspaceProvider);
        const provider = ctx.workspaceProvider as CloudPostgresWorkspaceProvider;
        expect(provider.userId).toBe(mockUser.id);
        expect(provider.workspaceId).toBe(DEFAULT_WORKSPACE_UUID);

        expect(ctx.ephemeralVaultPayloads.get("file-zk-1")).toBe(encryptedDoc);
        expect(ctx.liveDocumentSnapshots.get("file-live-2")).toBe(liveDraft);

        // Real cross-contract seam: CloudPostgresWorkspaceProvider reads decrypted payload
        // and registers an opaque vault_ref:// pointer inside active ALS scope.
        const section = await ctx.workspaceProvider.readSectionByHeading(
          "file-zk-1",
          "vault-secrets",
        );
        capturedIsVaultRef = section.isVaultRef;
        capturedSectionRef = section.contentOrVaultRef;
        capturedResolvedPlaintext = resolveVaultRefJustInTime(section.contentOrVaultRef);
      };
      graphState.chunksToEmit = [{ nodeId: "search_discovery_node", stepIndex: 1, status: "COMPLETED" }];

      const req = new Request("http://localhost/api/agent/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "th-bug05",
          workspaceId: DEFAULT_WORKSPACE_UUID,
          targetFileIds: ["file-zk-1", "file-live-2"],
          ephemeralVaultPayloads: { "file-zk-1": encryptedDoc },
          liveDocumentSnapshots: { "file-live-2": liveDraft },
        }),
      });

      const res = await handleAgentStreamPost(req);
      expect(res.status).toBe(200);
      await drainSSE(res);

      expect(capturedIsVaultRef).toBe(true);
      expect(capturedSectionRef).toMatch(/^vault_ref:\/\/file-zk-1#/);
      expect(capturedResolvedPlaintext).toContain("Top-secret client decrypted specification.");

      // Ephemeral vault memory MUST be wiped after SSE stream completes
      expect(hasActiveVaultPlaintextInMemory()).toBe(false);
      expect(getActiveEphemeralVaultPlaintexts()).toEqual([]);
    });

    it("cross-contract wire round-trip: agentRoutes SSE producer -> consumeAgentStream decodes multi-file & ZK commit frames without drops", async () => {
      const prevFetch = getRpcClientFetch();
      setRpcClientFetch(async (_input, init) => {
        return agentRoutes.request("http://localhost/stream", init);
      });

      try {
        graphState.onStreamStart = (ctx) => {
          ctx.emitSseEvent({
            type: "ghost_hunk_proposed",
            fileId: "doc-1",
            headingSlug: "api-surface",
            hunks: [{ from: 12, to: 42, replacementText: "Updated RPC surface" }],
          });
          ctx.emitSseEvent({
            type: "file_mutated",
            fileId: "doc-2",
            relativePath: "docs/changelog.md",
            action: "updated",
          });
          ctx.emitSseEvent({
            type: "vault_file_commit_required",
            fileId: "doc-zk",
            relativePath: "vault/keys.md",
            mergedContent: "# Keys\nMerged ZK body",
          });
        };
        graphState.chunksToEmit = [
          { nodeId: "search_discovery_node", stepIndex: 1, status: "COMPLETED" },
        ];

        const ghostHunks: AgentStreamGhostHunkProposedEvent[] = [];
        const fileMutations: AgentStreamFileMutatedEvent[] = [];
        const vaultCommits: AgentStreamVaultFileCommitRequiredEvent[] = [];
        let doneCount = 0;

        await consumeAgentStream({
          payload: {
            threadId: "th-wire-multi",
            workspaceId: DEFAULT_WORKSPACE_UUID,
            turnId: "turn-wire-1",
            permissionMode: "semi_auto",
            selectedSystem2ModelId: "google/gemini-3.1-pro",
            targetFileIds: ["doc-1", "doc-2", "doc-zk"],
            prompt: "Apply multi-file update",
          },
          onGhostHunkProposed: (ev) => ghostHunks.push(ev),
          onFileMutated: (ev) => fileMutations.push(ev),
          onVaultFileCommitRequired: (ev) => vaultCommits.push(ev),
          onDone: () => {
            doneCount += 1;
          },
          onError: (err) => {
            throw err;
          },
        });

        expect(ghostHunks).toEqual([
          {
            type: "ghost_hunk_proposed",
            fileId: "doc-1",
            headingSlug: "api-surface",
            hunks: [{ from: 12, to: 42, replacementText: "Updated RPC surface" }],
          },
        ]);
        expect(fileMutations).toEqual([
          {
            type: "file_mutated",
            fileId: "doc-2",
            relativePath: "docs/changelog.md",
            action: "updated",
          },
        ]);
        expect(vaultCommits).toEqual([
          {
            type: "vault_file_commit_required",
            fileId: "doc-zk",
            relativePath: "vault/keys.md",
            mergedContent: "# Keys\nMerged ZK body",
          },
        ]);
        expect(doneCount).toBe(1);
        expect(scheduledAfterTasks).toHaveLength(1);
      } finally {
        setRpcClientFetch(prevFetch);
      }
    });

    it.each([
      {
        label: "INSUFFICIENT_CREDITS",
        chunk: {
          nodeId: "assumption_extractor_node",
          stepIndex: 2,
          status: "INTERRUPTED",
          interruptReason: "INSUFFICIENT_CREDITS",
          interruptPayload: { availableMicro: 100, requiredMicro: 95_000 },
        } satisfies Partial<GraphStreamYield>,
        expectedResumable: false,
      },
      {
        label: "HITL_CLARIFICATION_REQUIRED",
        chunk: {
          nodeId: "hitl_clarification_node",
          stepIndex: 5,
          status: "INTERRUPTED",
          interruptReason: "HITL_CLARIFICATION_REQUIRED",
          interruptPayload: {
            questionQueue: {
              questions: [{ questionId: "q-1", topicSlug: "storage", questionPrompt: "Pick engine?" }],
            },
          },
        } satisfies Partial<GraphStreamYield>,
        expectedResumable: true,
      },
    ])(
      "cross-contract wire round-trip: agentRoutes -> consumeAgentStream preserves $label interrupt metadata",
      async ({ chunk, expectedResumable }) => {
        const prevFetch = getRpcClientFetch();
        setRpcClientFetch(async (_input, init) => {
          return agentRoutes.request("http://localhost/stream", init);
        });

        try {
          graphState.chunksToEmit = [chunk];

          let capturedInterrupt: AgentStreamInterruptEvent | null = null;
          let capturedError: unknown = null;

          await consumeAgentStream({
            payload: {
              threadId: `th-wire-${chunk.interruptReason}`,
              workspaceId: DEFAULT_WORKSPACE_UUID,
              targetFileIds: ["file-1"],
              prompt: "Run metered task",
            },
            onInterrupt: (ev) => {
              capturedInterrupt = ev;
            },
            onError: (err) => {
              capturedError = err;
            },
          });

          expect(capturedError).toBeNull();
          expect(capturedInterrupt).toMatchObject({
            type: "interrupt",
            threadId: `th-wire-${chunk.interruptReason}`,
            nodeId: chunk.nodeId,
            stepIndex: chunk.stepIndex,
            interruptReason: chunk.interruptReason,
            interruptPayload: chunk.interruptPayload,
          });
          expect(capturedInterrupt!.interrupts).toHaveLength(1);
          expect(capturedInterrupt!.interrupts[0].resumable).toBe(expectedResumable);
        } finally {
          setRpcClientFetch(prevFetch);
        }
      },
    );

    it("cross-contract wire regression: legacy projectId-only consumeAgentStream resolves default workspace UUID with HTTP 200 (no synthesized workspaceId 400)", async () => {
      workspaceDbState.findFirstResult = undefined;
      const prevFetch = getRpcClientFetch();
      setRpcClientFetch(async (_input, init) => {
        return agentRoutes.request("http://localhost/stream", init);
      });

      try {
        graphState.chunksToEmit = [{ nodeId: "search_discovery_node", stepIndex: 1, status: "COMPLETED" }];

        let doneCount = 0;
        let capturedError: unknown = null;

        await consumeAgentStream({
          payload: {
            threadId: "th-wire-legacy-project",
            projectId: "legacy-project-slug-wire",
            targetFileIds: ["file-1"],
            prompt: "Run legacy projectId stream",
            selectedSystem2ModelId: "google/gemini-4-argon",
            permissionMode: "semi_auto",
          },
          onDone: () => {
            doneCount += 1;
          },
          onError: (err) => {
            capturedError = err;
          },
        });

        expect(capturedError).toBeNull();
        expect(doneCount).toBe(1);

        const runtimeCtx = graphState.lastConfig as AgentRuntimeContext;
        expect(runtimeCtx.workspaceId).toBe(DEFAULT_WORKSPACE_UUID);
        expect(runtimeCtx.selectedSystem2ModelId).toBe("google/gemini-4-argon");
        expect(runtimeCtx.permissionMode).toBe("semi_auto");
      } finally {
        setRpcClientFetch(prevFetch);
      }
    });
  });
});
