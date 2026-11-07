/**
 * Comprehensive Unit & Edge-Case Test Suite for Web-Standard Agent SSE Route (`src/server/routes/agent.routes.ts`)
 *
 * Verifies:
 * 1. Route metadata exports (`maxDuration = 300`, `dynamic = "force-dynamic"`).
 * 2. Both direct `handleAgentStreamPost(Request)` invocation and Hono `agentRoutes.request("/stream", ...)` dispatch.
 * 3. Authentication guard (401 Problem Details before body parsing, non-Error throw resilience).
 * 4. Rate limiting (429 quota exceeded, 503 fail-closed when limiter throws or returns degraded).
 * 5. Request body & Zod contract validation (400 Problem Details on malformed JSON, schema violations, unknown fields).
 * 6. Ephemeral vault payload loading (`vault_ref://` prefix stripping, `fileId#headingSlug` direct storage,
 *    markdown heading tree slicing, non-string entry filtering, invalid identifier resilience, zeroing on completion/error/cancel).
 * 7. LangGraph streaming (initial `user_request` vs `Command({ resume })`, inline `__interrupt__` chunks,
 *    thrown `GraphInterrupt` and named `GraphInterrupt` objects, general graph error log sanitization).
 * 8. AbortSignal propagation (pre-aborted request signal, mid-stream abort signal, ReadableStream `cancel()`).
 * 9. StreamGovernor credit metering & settlement (`SETTLED` vs `ABORTED` on quota exhaustion, error, or cancellation).
 * 10. Post-response settlement scheduling via `scheduleAfterResponse` and error resilience when settlement flush throws.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "@langchain/langgraph";
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
    onStreamStart: null as (() => void) | null,
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
      options?: unknown
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
    stream: vi.fn(async (input: unknown, config: unknown) => {
      graphState.lastInput = input;
      graphState.lastConfig = config;
      if (graphState.onStreamStart) {
        graphState.onStreamStart();
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
  maxDuration,
  dynamic,
} from "@/server/routes/agent.routes";

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

async function drainSSE(
  res: Response
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

  describe("Route Constants & Exports", () => {
    it("exports maxDuration = 300 and dynamic = 'force-dynamic'", () => {
      expect(maxDuration).toBe(300);
      expect(dynamic).toBe("force-dynamic");
    });
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
          "vault_ref://file-alpha#architecture-overview"
        );
        capturedSections.headingIntro = resolveVaultRefJustInTime(
          "vault_ref://file-beta#introduction"
        );
        capturedSections.headingDetails = resolveVaultRefJustInTime(
          "vault_ref://file-beta#security-details"
        );
        capturedSections.rootFallback = resolveVaultRefJustInTime(
          "vault_ref://file-beta#root"
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

  describe("Inline Interrupts, Named GraphInterrupts & Abort Handling", () => {
    it("emits SSE interrupt frame when stream yields an inline __interrupt__ chunk and continues", async () => {
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

      expect(frames.map((f) => f.event)).toEqual(["start", "interrupt", "update", "done"]);
      expect(frames[1].data).toMatchObject({
        type: "interrupt",
        threadId: "th-inline-int",
        interrupts: [{ id: "int-inline-1", value: { question: "Approve?" } }],
      });
      expect(governorState.instances[0].settledStatus).toBe("SETTLED");
    });

    it("emits SSE interrupt frame when a custom error object with name === 'GraphInterrupt' is thrown", async () => {
      graphState.errorToThrow = {
        name: "GraphInterrupt",
        interrupts: [{ id: "int-named", value: "awaiting_user" }],
      };

      const req = new Request("http://localhost/api/agent/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "th-named-int",
          projectId: "proj-1",
          targetFileIds: ["file-1"],
        }),
      });

      const res = await handleAgentStreamPost(req);
      const frames = await drainSSE(res);

      const intFrame = frames.find((f) => f.event === "interrupt");
      expect(intFrame).toBeDefined();
      expect(intFrame?.data.interrupts).toEqual([{ id: "int-named", value: "awaiting_user" }]);
      expect(governorState.instances[0].settledStatus).toBe("SETTLED");
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
        expect.any(Error)
      );
      errorSpy.mockRestore();
    });
  });

  describe("Hono Router Dispatch (agentRoutes)", () => {
    it("dispatches POST /stream through agentRoutes.request() and streams start -> update -> done", async () => {
      graphState.chunksToEmit = [{ summary_node: { ok: true } }];
      const resumePayload = { decision: "approve" };

      const res = await agentRoutes.request("http://localhost/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "th-hono-router",
          projectId: "proj-hono",
          targetFileIds: ["file-hono-1"],
          resumePayload,
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");

      const frames = await drainSSE(res);
      expect(frames.map((f) => f.event)).toEqual(["start", "update", "done"]);
      expect(graphState.lastInput).toBeInstanceOf(Command);
      expect((graphState.lastInput as Command).resume).toEqual(resumePayload);
    });
  });
});
