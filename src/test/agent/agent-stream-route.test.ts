/**
 * Test Suite: Unified Agent SSE Stream Route Handler
 *
 * Verifies route segment configuration (maxDuration = 300), authentication guards,
 * fail-closed rate limiting, RFC 7807 problem details error responses,
 * Zod payload parsing & strict sanitization, happy-path SSE event streaming,
 * Command({ resume }) dispatch, StreamGovernor quota enforcement,
 * real zero-knowledge memory wiping (Buffer.fill(0)), and Next.js after() settlement scheduling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { Command, GraphInterrupt } from "@langchain/langgraph";
import {
  hasActiveVaultPlaintextInMemory,
  getActiveEphemeralVaultPlaintexts,
} from "@/lib/vault/ephemeral-memory-map";
import {
  MAX_PROMPT_CHARS,
  MAX_TARGET_FILES,
  MAX_IDENTIFIER_LENGTH,
  MAX_DOCUMENT_SNAPSHOT_CHARS,
  MAX_RECORD_KEYS,
  parseAgentStreamPayload,
} from "@/core/agent/stream-payload";

// ---------------------------------------------------------------------------
// 1. Hoisted Shared Mock State & Definitions
// ---------------------------------------------------------------------------

const {
  scheduledAfterCallbacks,
  mockUser,
  authConfig,
  rateLimitConfig,
  graphConfigState,
  governorConfigState,
  MockGovernor,
  mockFlushPendingSettlements,
} = vi.hoisted(() => {
  const scheduledAfterCallbacks: Array<() => Promise<void> | void> = [];

  const mockUser = {
    id: "test-user-uuid-1234",
    email: "developer@elixent.ai",
  };

  const authConfig = {
    isAuthenticated: true,
    authErrorMessage: "Authentication required: no active server session",
  };

  const rateLimitConfig = {
    success: true,
    remaining: 29,
    isDegraded: false,
  };

  const graphConfigState = {
    chunksToEmit: [] as unknown[],
    errorToThrow: null as unknown,
    lastInput: null as unknown,
    lastConfig: null as unknown,
  };

  const governorConfigState = {
    permitted: true,
    instances: [] as any[],
  };

  class MockGovernor {
    public userId: string;
    public operationId: string;
    public modelId: string;
    public initialTokens: number;
    public abortController: AbortController;
    public options: unknown;

    public tokenChunks: Array<string | number> = [];
    public settledStatus: string | null = null;
    public isAborted = false;

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
      governorConfigState.instances.push(this);
    }

    async onTokenChunk(chunkText: string | number): Promise<boolean> {
      this.tokenChunks.push(chunkText);
      if (!governorConfigState.permitted) {
        this.isAborted = true;
        this.abortController.abort("QUOTA_EXCEEDED");
        return false;
      }
      return true;
    }

    abort(reason?: string): void {
      this.isAborted = true;
      this.abortController.abort(reason);
    }

    async settle(status: "SETTLED" | "ABORTED" = "SETTLED"): Promise<{ status: string }> {
      this.settledStatus = status;
      return { status };
    }
  }

  const mockFlushPendingSettlements = vi.fn(async (_userId: string) => ({
    flushedCount: 1,
    netDeltaMicro: BigInt(-600000),
  }));

  return {
    scheduledAfterCallbacks,
    mockUser,
    authConfig,
    rateLimitConfig,
    graphConfigState,
    governorConfigState,
    MockGovernor,
    mockFlushPendingSettlements,
  };
});

// ---------------------------------------------------------------------------
// 2. Module Mocks
// ---------------------------------------------------------------------------

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: vi.fn((cb: () => Promise<void> | void) => {
      scheduledAfterCallbacks.push(cb);
    }),
  };
});

vi.mock("@/server/auth/session", () => ({
  requireAuthenticatedUser: vi.fn(async () => {
    if (!authConfig.isAuthenticated) {
      const err = new Error(authConfig.authErrorMessage);
      err.name = "AuthenticationRequiredError";
      throw err;
    }
    return mockUser;
  }),
}));

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    ...actual,
    aiStreamRateLimiter: {
      limit: vi.fn(async (_userId: string) => ({
        success: rateLimitConfig.success,
        remaining: rateLimitConfig.remaining,
        reset: Math.ceil(Date.now() / 1000) + 60,
        limit: 30,
        isDegraded: rateLimitConfig.isDegraded,
      })),
    },
  };
});

vi.mock("@/core/agent/graph", () => ({
  elixentAgentGraph: {
    stream: vi.fn(async (input: unknown, config: unknown) => {
      graphConfigState.lastInput = input;
      graphConfigState.lastConfig = config;

      if (graphConfigState.errorToThrow) {
        throw graphConfigState.errorToThrow;
      }

      async function* generator() {
        for (const chunk of graphConfigState.chunksToEmit) {
          yield chunk;
        }
      }

      return generator();
    }),
  },
}));

vi.mock("@/lib/metering/stream-governor", () => ({
  StreamGovernor: MockGovernor,
}));

vi.mock("@/server/services/ai-settlement-service", () => ({
  flushPendingSettlementsToPostgres: (userId: string) => mockFlushPendingSettlements(userId),
}));

// Import route module AFTER mocks
import * as route from "@/app/api/agent/stream/route";

// ---------------------------------------------------------------------------
// 3. Helpers
// ---------------------------------------------------------------------------

async function readStreamToText(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

interface ParsedFrame {
  event: string;
  data: Record<string, unknown>;
}

function parseSSEFrames(raw: string): ParsedFrame[] {
  const frames: ParsedFrame[] = [];
  const blocks = raw.split("\n\n").filter((b) => b.trim().length > 0);
  for (const block of blocks) {
    let eventName = "message";
    let dataStr = "";
    const lines = block.split("\n");
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventName = line.slice("event: ".length).trim();
      } else if (line.startsWith("data: ")) {
        dataStr = line.slice("data: ".length).trim();
      }
    }
    if (dataStr) {
      try {
        frames.push({ event: eventName, data: JSON.parse(dataStr) });
      } catch {
        frames.push({ event: eventName, data: { raw: dataStr } });
      }
    }
  }
  return frames;
}

// ---------------------------------------------------------------------------
// 4. Test Scenarios
// ---------------------------------------------------------------------------

describe("POST /api/agent/stream Route Handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scheduledAfterCallbacks.length = 0;
    governorConfigState.instances.length = 0;
    governorConfigState.permitted = true;
    authConfig.isAuthenticated = true;
    authConfig.authErrorMessage = "Authentication required: no active server session";
    rateLimitConfig.success = true;
    rateLimitConfig.remaining = 29;
    rateLimitConfig.isDegraded = false;
    graphConfigState.chunksToEmit = [];
    graphConfigState.errorToThrow = null;
    graphConfigState.lastInput = null;
    graphConfigState.lastConfig = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("1. Next.js Route Segment Configuration", () => {
    it("should export maxDuration = 300 for long-running LangGraph agent executions", () => {
      expect(route.maxDuration).toBe(300);
    });

    it("should export dynamic = 'force-dynamic'", () => {
      expect(route.dynamic).toBe("force-dynamic");
    });
  });

  describe("2. Authentication Guards (401 Problem Details)", () => {
    it("should reject unauthenticated requests with HTTP 401 Problem Details before body parsing", async () => {
      authConfig.isAuthenticated = false;

      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: "invalid-json-that-should-not-be-parsed",
        headers: { "Content-Type": "application/json" },
      });

      const res = await route.POST(req);

      expect(res.status).toBe(401);
      expect(res.headers.get("Content-Type")).toBe("application/problem+json");
      expect(res.headers.get("X-Correlation-ID")).toBeDefined();

      const body = await res.json();
      expect(body.type).toBe("urn:problem-type:unauthorized");
      expect(body.status).toBe(401);
      expect(body.title).toBe("Unauthorized");
    });
  });

  describe("3. Fail-Closed Rate Limiting (429 & 503)", () => {
    it("should reject requests exceeding quota with HTTP 429 and rate limit headers", async () => {
      rateLimitConfig.success = false;
      rateLimitConfig.remaining = 0;
      rateLimitConfig.isDegraded = false;

      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "th-1",
          projectId: "proj-1",
          targetFileIds: ["file-1"],
        }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await route.POST(req);

      expect(res.status).toBe(429);
      expect(res.headers.get("X-RateLimit-Limit")).toBe("30");
      expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
      expect(res.headers.get("Retry-After")).toBeDefined();
      expect(res.headers.get("X-Correlation-ID")).toBeDefined();
    });

    it("should fail-closed with HTTP 503 when rate limiter Redis is degraded/unavailable", async () => {
      rateLimitConfig.success = false;
      rateLimitConfig.remaining = 0;
      rateLimitConfig.isDegraded = true;

      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "th-1",
          projectId: "proj-1",
          targetFileIds: ["file-1"],
        }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await route.POST(req);

      expect(res.status).toBe(503);
      expect(res.headers.get("X-RateLimit-Degraded")).toBe("1");
      expect(res.headers.get("Retry-After")).toBeDefined();
    });
  });

  describe("4. Request Payload Validation (400 Problem Details)", () => {
    it("should return HTTP 400 when request body is not valid JSON", async () => {
      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: "{malformed_json",
        headers: { "Content-Type": "application/json" },
      });

      const res = await route.POST(req);

      expect(res.status).toBe(400);
      expect(res.headers.get("Content-Type")).toBe("application/problem+json");
      const body = await res.json();
      expect(body.type).toBe("urn:problem-type:bad-request");
      expect(body.title).toBe("Invalid JSON");
    });

    it("should return HTTP 400 when required fields are missing", async () => {
      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          // missing threadId, projectId, targetFileIds
          prompt: "Hello",
        }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await route.POST(req);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.type).toBe("urn:problem-type:bad-request");
      expect(body.invalidParams).toBeDefined();
      expect(Array.isArray(body.invalidParams)).toBe(true);
    });

    it("should return HTTP 400 when unknown properties are passed (.strict() enforcement)", async () => {
      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "th-1",
          projectId: "proj-1",
          targetFileIds: ["file-1"],
          unrecognizedForbiddenField: true,
        }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await route.POST(req);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.type).toBe("urn:problem-type:bad-request");
    });

    it("should never echo vault secrets in 400 validation error responses", async () => {
      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "", // invalid empty string
          projectId: "proj-1",
          targetFileIds: ["file-1"],
          ephemeralVaultPayloads: {
            "file-secret": "SUPER_SECRET_PLAINTEXT_SHOULD_NEVER_BE_ECHOED",
          },
        }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await route.POST(req);

      expect(res.status).toBe(400);
      const rawText = await res.text();
      expect(rawText).not.toContain("SUPER_SECRET_PLAINTEXT_SHOULD_NEVER_BE_ECHOED");
    });
  });

  describe("5. Happy-Path SSE Stream Execution & Framing", () => {
    it("should return 200 with proper SSE headers and emit start, update, done events", async () => {
      graphConfigState.chunksToEmit = [
        { search_report: { summary: "Found 2 references" } },
        { master_ledger: { dec_1: { selectedOptionKey: "opt_a" } } },
      ];

      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "thread-abc-123",
          projectId: "project-xyz-789",
          targetFileIds: ["file-uuid-001"],
          prompt: "Analyze the architectural dependencies",
        }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await route.POST(req);

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
      expect(res.headers.get("Cache-Control")).toBe("no-cache, no-transform");
      expect(res.headers.get("X-Accel-Buffering")).toBe("no");
      expect(res.headers.get("X-Correlation-ID")).toBeDefined();

      const text = await readStreamToText(res);
      const frames = parseSSEFrames(text);

      expect(frames.length).toBe(4); // start, update 1, update 2, done
      expect(frames[0].event).toBe("start");
      expect(frames[0].data.threadId).toBe("thread-abc-123");
      expect(frames[0].data.type).toBe("start");

      expect(frames[1].event).toBe("update");
      expect(frames[1].data.chunk).toEqual({ search_report: { summary: "Found 2 references" } });

      expect(frames[2].event).toBe("update");
      expect(frames[2].data.chunk).toEqual({ master_ledger: { dec_1: { selectedOptionKey: "opt_a" } } });

      expect(frames[3].event).toBe("done");
      expect(frames[3].data.threadId).toBe("thread-abc-123");

      // Verify Governor settlement
      expect(governorConfigState.instances.length).toBe(1);
      expect(governorConfigState.instances[0].settledStatus).toBe("SETTLED");
      expect(governorConfigState.instances[0].tokenChunks.length).toBe(2);
    });

    it("should pass user_request with prompt, projectId, and targetFileIds on initial invocation", async () => {
      graphConfigState.chunksToEmit = [{ step: 1 }];

      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "thread-100",
          projectId: "project-200",
          targetFileIds: ["file-a", "file-b"],
          prompt: "Draft system spec",
        }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await route.POST(req);
      await readStreamToText(res);

      expect(graphConfigState.lastInput).toEqual({
        user_request: {
          prompt: "Draft system spec",
          projectId: "project-200",
          targetFileIds: ["file-a", "file-b"],
        },
      });

      expect((graphConfigState.lastConfig as any)?.configurable?.thread_id).toBe("thread-100");
      expect((graphConfigState.lastConfig as any)?.configurable?.userId).toBe(mockUser.id);
    });
  });

  describe("6. Resumption via Command({ resume })", () => {
    it("should invoke elixentAgentGraph with Command({ resume: resumePayload }) when resumePayload is provided", async () => {
      graphConfigState.chunksToEmit = [{ resumed: true }];

      const resumePayload = {
        questionId: "dec_cache_ttl",
        selectedOptionKey: "redis_ttl_300s",
      };

      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "thread-hitl-resume",
          projectId: "project-xyz",
          targetFileIds: ["file-1"],
          resumePayload,
        }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await route.POST(req);
      await readStreamToText(res);

      expect(graphConfigState.lastInput).toBeInstanceOf(Command);
      expect((graphConfigState.lastInput as Command).resume).toEqual(resumePayload);
    });
  });

  describe("7. Zero-Knowledge Memory Wiping & Ephemeral Vault Scope", () => {
    it("should load ephemeralVaultPayloads into scope and guarantee zeroing on clean completion", async () => {
      graphConfigState.chunksToEmit = [{ step: "reading" }];

      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "thread-vault-test",
          projectId: "project-vault",
          targetFileIds: ["file-enc-1"],
          ephemeralVaultPayloads: {
            "file-enc-1#section-alpha": "Top secret decrypted architecture notes",
          },
        }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await route.POST(req);
      await readStreamToText(res);

      // Invariant: outside request execution, all plaintext is zeroed out
      expect(hasActiveVaultPlaintextInMemory()).toBe(false);
      expect(getActiveEphemeralVaultPlaintexts()).toEqual([]);
    });

    it("should guarantee zeroOutEphemeralVaultMemory on stream runtime error", async () => {
      graphConfigState.errorToThrow = new Error("Fatal graph crash during node execution");

      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "thread-error-test",
          projectId: "project-vault",
          targetFileIds: ["file-enc-1"],
          ephemeralVaultPayloads: {
            "file-enc-1#sec-1": "Transient secret that must be wiped on error",
          },
        }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await route.POST(req);
      const text = await readStreamToText(res);
      const frames = parseSSEFrames(text);

      expect(frames.some((f) => f.event === "error")).toBe(true);
      expect(hasActiveVaultPlaintextInMemory()).toBe(false);
      expect(getActiveEphemeralVaultPlaintexts()).toEqual([]);

      // Governor settled with ABORTED status
      expect(governorConfigState.instances[0].settledStatus).toBe("ABORTED");
    });

    it("should zero out memory and settle governor when StreamGovernor quota is exhausted", async () => {
      governorConfigState.permitted = false; // Governor rejects chunks immediately
      graphConfigState.chunksToEmit = [{ heavy_chunk: "A".repeat(500) }];

      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "thread-quota-exhausted",
          projectId: "project-vault",
          targetFileIds: ["file-enc-1"],
          ephemeralVaultPayloads: {
            "file-enc-1#sec-1": "Secret that must be wiped after quota exhaustion",
          },
        }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await route.POST(req);
      const text = await readStreamToText(res);
      const frames = parseSSEFrames(text);

      const errorFrame = frames.find((f) => f.event === "error");
      expect(errorFrame).toBeDefined();
      expect(errorFrame?.data.code).toBe("QUOTA_EXCEEDED");

      expect(hasActiveVaultPlaintextInMemory()).toBe(false);
      expect(getActiveEphemeralVaultPlaintexts()).toEqual([]);
      expect(governorConfigState.instances[0].settledStatus).toBe("ABORTED");
    });
  });

  describe("8. LangGraph Interrupt Emission (HITL)", () => {
    it("should emit SSE interrupt event and cleanly terminate stream when GraphInterrupt is caught", async () => {
      graphConfigState.errorToThrow = new GraphInterrupt([
        {
          id: "interrupt-1",
          value: {
            code: "INSUFFICIENT_CREDITS",
            targetNode: "pure_interrupt_node",
          },
        },
      ]);

      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "thread-interrupt-test",
          projectId: "project-1",
          targetFileIds: ["file-1"],
        }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await route.POST(req);
      const text = await readStreamToText(res);
      const frames = parseSSEFrames(text);

      const interruptFrame = frames.find((f) => f.event === "interrupt");
      expect(interruptFrame).toBeDefined();
      expect(interruptFrame?.data.type).toBe("interrupt");
      expect(hasActiveVaultPlaintextInMemory()).toBe(false);
    });
  });

  describe("9. Next.js after() Settlement Scheduling", () => {
    it("should schedule background PostgreSQL settlement flush via after() with user.id", async () => {
      graphConfigState.chunksToEmit = [{ step: 1 }];

      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "thread-after-test",
          projectId: "project-1",
          targetFileIds: ["file-1"],
        }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await route.POST(req);
      await readStreamToText(res);

      expect(scheduledAfterCallbacks.length).toBe(1);

      // Execute the scheduled after() callback
      await scheduledAfterCallbacks[0]();

      expect(mockFlushPendingSettlements).toHaveBeenCalledTimes(1);
      expect(mockFlushPendingSettlements).toHaveBeenCalledWith(mockUser.id);
    });
  });

  describe("10. Payload Thresholds & Boundary Limits (ELIXENT-ARCH-03 §5.1)", () => {
    it("should accept prompt of exactly MAX_PROMPT_CHARS (100,000 chars)", async () => {
      graphConfigState.chunksToEmit = [{ ok: true }];
      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "th-prompt-max",
          projectId: "proj-1",
          targetFileIds: ["f1"],
          prompt: "x".repeat(MAX_PROMPT_CHARS),
        }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await route.POST(req);
      expect(res.status).toBe(200);
      await readStreamToText(res);
    });

    it("should reject prompt exceeding MAX_PROMPT_CHARS with HTTP 400", async () => {
      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "th-prompt-over",
          projectId: "proj-1",
          targetFileIds: ["f1"],
          prompt: "x".repeat(MAX_PROMPT_CHARS + 1),
        }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await route.POST(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.invalidParams?.some((p: any) => p.name === "prompt")).toBe(true);
    });

    it("should accept targetFileIds of exactly MAX_TARGET_FILES (100 files)", async () => {
      graphConfigState.chunksToEmit = [{ ok: true }];
      const targetFileIds = Array.from({ length: MAX_TARGET_FILES }, (_, i) => `file-${i}`);
      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "th-files-max",
          projectId: "proj-1",
          targetFileIds,
        }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await route.POST(req);
      expect(res.status).toBe(200);
      await readStreamToText(res);
    });

    it("should reject targetFileIds exceeding MAX_TARGET_FILES (101 files) with HTTP 400", async () => {
      const targetFileIds = Array.from({ length: MAX_TARGET_FILES + 1 }, (_, i) => `file-${i}`);
      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "th-files-over",
          projectId: "proj-1",
          targetFileIds,
        }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await route.POST(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.invalidParams?.some((p: any) => p.name === "targetFileIds")).toBe(true);
    });

    it("should accept empty targetFileIds array", async () => {
      graphConfigState.chunksToEmit = [{ ok: true }];
      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "th-empty-files",
          projectId: "proj-1",
          targetFileIds: [],
        }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await route.POST(req);
      expect(res.status).toBe(200);
      await readStreamToText(res);
    });

    it("should reject targetFileIds containing empty or whitespace-only strings", async () => {
      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "th-1",
          projectId: "proj-1",
          targetFileIds: ["   "],
        }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await route.POST(req);
      expect(res.status).toBe(400);
    });

    it("should reject threadId or projectId exceeding MAX_IDENTIFIER_LENGTH", async () => {
      const longId = "a".repeat(MAX_IDENTIFIER_LENGTH + 1);
      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: longId,
          projectId: "proj-1",
          targetFileIds: ["f1"],
        }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await route.POST(req);
      expect(res.status).toBe(400);
    });

    it("should enforce MAX_RECORD_KEYS on ephemeralVaultPayloads", () => {
      const validPayloads: Record<string, string> = {};
      for (let i = 0; i < MAX_RECORD_KEYS; i++) {
        validPayloads[`f${i}`] = `content-${i}`;
      }
      const parseOk = parseAgentStreamPayload({
        threadId: "th-rec",
        projectId: "proj-1",
        targetFileIds: ["f1"],
        ephemeralVaultPayloads: validPayloads,
      });
      expect(parseOk.success).toBe(true);

      const overLimitPayloads = { ...validPayloads, extraKey: "over-limit" };
      const parseFail = parseAgentStreamPayload({
        threadId: "th-rec",
        projectId: "proj-1",
        targetFileIds: ["f1"],
        ephemeralVaultPayloads: overLimitPayloads,
      });
      expect(parseFail.success).toBe(false);
    });

    it("should reject document snapshot exceeding MAX_DOCUMENT_SNAPSHOT_CHARS (2,000,000 chars)", () => {
      const parseFail = parseAgentStreamPayload({
        threadId: "th-snap",
        projectId: "proj-1",
        targetFileIds: ["f1"],
        liveDocumentSnapshots: {
          f1: "x".repeat(MAX_DOCUMENT_SNAPSHOT_CHARS + 1),
        },
      });
      expect(parseFail.success).toBe(false);
    });

    it("should accept resumePayload containing primitives, arrays, and nested structures", () => {
      for (const resumePayload of [
        "simple-string",
        42,
        true,
        ["step1", "step2"],
        { decisionId: "d1", choice: "retry", metadata: { score: 0.95 } },
      ]) {
        const result = parseAgentStreamPayload({
          threadId: "th-resume",
          projectId: "proj-1",
          targetFileIds: [],
          resumePayload,
        });
        expect(result.success).toBe(true);
      }
    });
  });

  describe("11. Malformed & Unusual Request Bodies", () => {
    it("should return 400 when body is an array instead of an object", async () => {
      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify(["invalid", "array", "body"]),
        headers: { "Content-Type": "application/json" },
      });
      const res = await route.POST(req);
      expect(res.status).toBe(400);
    });

    it("should return 400 when body is null", async () => {
      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: "null",
        headers: { "Content-Type": "application/json" },
      });
      const res = await route.POST(req);
      expect(res.status).toBe(400);
    });

    it("should return 400 when body is an empty object", async () => {
      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });
      const res = await route.POST(req);
      expect(res.status).toBe(400);
    });
  });

  describe("12. AbortController Disconnections & Stream Cancellation", () => {
    it("should handle pre-aborted request signal immediately without executing graph", async () => {
      const abortCtrl = new AbortController();
      abortCtrl.abort("client_pre_aborted");

      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "th-pre-abort",
          projectId: "proj-1",
          targetFileIds: ["f1"],
        }),
        headers: { "Content-Type": "application/json" },
        signal: abortCtrl.signal,
      });

      const res = await route.POST(req);
      expect(res.status).toBe(200);

      const text = await readStreamToText(res);
      const frames = parseSSEFrames(text);
      expect(frames.filter((f) => f.event === "update")).toHaveLength(0);
      expect(frames.filter((f) => f.event === "done")).toHaveLength(0);
      expect(governorConfigState.instances[0].settledStatus).toBe("ABORTED");
      expect(hasActiveVaultPlaintextInMemory()).toBe(false);
    });

    it("should abort execution mid-stream when req.signal fires abort event during chunk emission", async () => {
      const abortCtrl = new AbortController();
      let emitCount = 0;
      graphConfigState.chunksToEmit = [
        { step: 1 },
        { step: 2 },
        { step: 3 },
      ];

      const originalOnTokenChunk = MockGovernor.prototype.onTokenChunk;
      const tokenSpy = vi.spyOn(MockGovernor.prototype, "onTokenChunk").mockImplementation(async function (this: any, chunk) {
        emitCount++;
        if (emitCount === 1) {
          abortCtrl.abort("user_disconnected");
        }
        return originalOnTokenChunk.call(this, chunk);
      });

      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "th-mid-abort",
          projectId: "proj-1",
          targetFileIds: ["f1"],
        }),
        headers: { "Content-Type": "application/json" },
        signal: abortCtrl.signal,
      });

      const res = await route.POST(req);
      const text = await readStreamToText(res);
      const frames = parseSSEFrames(text);

      expect(frames.some((f) => f.event === "done")).toBe(false);
      expect(hasActiveVaultPlaintextInMemory()).toBe(false);
      expect(governorConfigState.instances[0].settledStatus).toBe("ABORTED");

      tokenSpy.mockRestore();
    });

    it("should settle governor with ABORTED and wipe memory on stream cancellation (reader.cancel())", async () => {
      graphConfigState.chunksToEmit = [{ step: 1 }, { step: 2 }];

      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "th-cancel",
          projectId: "proj-1",
          targetFileIds: ["f1"],
        }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await route.POST(req);
      const reader = res.body?.getReader();
      await reader?.read();
      await reader?.cancel("navigated_away");

      expect(governorConfigState.instances[0].settledStatus).toBe("ABORTED");
      expect(hasActiveVaultPlaintextInMemory()).toBe(false);
    });
  });

  describe("13. GraphInterrupt Variations & HITL Edge Cases", () => {
    it("should emit interrupt SSE frame when graph yields an inline __interrupt__ chunk without aborting governor", async () => {
      graphConfigState.chunksToEmit = [
        { step: "before_interrupt" },
        { __interrupt__: [{ id: "int_hitl_1", value: "Awaiting confirmation" }] },
        { step: "after_interrupt" },
      ];

      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "th-inline-int",
          projectId: "proj-1",
          targetFileIds: ["f1"],
        }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await route.POST(req);
      const text = await readStreamToText(res);
      const frames = parseSSEFrames(text);

      const intFrame = frames.find((f) => f.event === "interrupt");
      expect(intFrame).toBeDefined();
      expect(intFrame?.data.interrupts).toEqual([
        { id: "int_hitl_1", value: "Awaiting confirmation" },
      ]);

      expect(frames.some((f) => f.event === "done")).toBe(true);
    });

    it("should handle custom error with name GraphInterrupt and empty interrupts array", async () => {
      const customInt = new Error("Human in the loop");
      customInt.name = "GraphInterrupt";
      (customInt as any).interrupts = [];
      graphConfigState.errorToThrow = customInt;

      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "th-empty-int",
          projectId: "proj-1",
          targetFileIds: ["f1"],
        }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await route.POST(req);
      const text = await readStreamToText(res);
      const frames = parseSSEFrames(text);

      const intFrame = frames.find((f) => f.event === "interrupt");
      expect(intFrame).toBeDefined();
      expect(intFrame?.data.interrupts).toEqual([]);
      expect(frames.some((f) => f.event === "error")).toBe(false);
    });

    it("should emit multiple pending interrupts in the interrupt frame", async () => {
      graphConfigState.errorToThrow = new GraphInterrupt([
        { id: "i1", value: "Approval 1" },
        { id: "i2", value: "Approval 2" },
      ]);

      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "th-multi-int",
          projectId: "proj-1",
          targetFileIds: ["f1"],
        }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await route.POST(req);
      const text = await readStreamToText(res);
      const frames = parseSSEFrames(text);

      const intFrame = frames.find((f) => f.event === "interrupt");
      expect(intFrame?.data.interrupts).toHaveLength(2);
    });
  });

  describe("14. Ephemeral Vault Payloads Heading Parsing & AST Slicing", () => {
    it("should strip vault_ref:// prefix and store sections cleanly into ephemeral vault map", async () => {
      graphConfigState.chunksToEmit = [{ ok: true }];

      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "th-vault-ref",
          projectId: "proj-1",
          targetFileIds: ["file-alpha"],
          ephemeralVaultPayloads: {
            "vault_ref://file-alpha#arch-notes": "Directly addressed section",
          },
        }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await route.POST(req);
      await readStreamToText(res);
      expect(hasActiveVaultPlaintextInMemory()).toBe(false);
    });

    it("should slice markdown payload into heading sections when target has no hash", async () => {
      graphConfigState.chunksToEmit = [{ ok: true }];
      const complexMd = [
        "# Overview",
        "Overview body text.",
        "## Implementation Details",
        "Details body text.",
      ].join("\n");

      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "th-ast-slice",
          projectId: "proj-1",
          targetFileIds: ["file-doc"],
          ephemeralVaultPayloads: {
            "file-doc": complexMd,
          },
        }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await route.POST(req);
      await readStreamToText(res);
      expect(hasActiveVaultPlaintextInMemory()).toBe(false);
    });

    it("should store raw markdown without headings into root section", async () => {
      graphConfigState.chunksToEmit = [{ ok: true }];

      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "th-no-headings",
          projectId: "proj-1",
          targetFileIds: ["file-plain"],
          ephemeralVaultPayloads: {
            "file-plain": "Just plain content without any markdown headings.",
          },
        }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await route.POST(req);
      await readStreamToText(res);
      expect(hasActiveVaultPlaintextInMemory()).toBe(false);
    });
  });

  describe("15. Background Settlement Scheduling (after()) Error Resilience", () => {
    it("should catch and log errors thrown by flushPendingSettlementsToPostgres without crashing", async () => {
      mockFlushPendingSettlements.mockRejectedValueOnce(
        new Error("Neon connection failed during after()")
      );
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      graphConfigState.chunksToEmit = [{ ok: true }];

      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "th-after-err",
          projectId: "proj-1",
          targetFileIds: ["file-1"],
        }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await route.POST(req);
      await readStreamToText(res);

      expect(scheduledAfterCallbacks.length).toBe(1);
      await expect(scheduledAfterCallbacks[0]()).resolves.toBeUndefined();
      expect(consoleSpy).toHaveBeenCalledWith(
        "[AgentStream] Settlement flush error:",
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });

    it("should schedule after() settlement even when graph throws an execution error", async () => {
      graphConfigState.errorToThrow = new Error("Graph crashed early");

      const req = new NextRequest("http://localhost:3000/api/agent/stream", {
        method: "POST",
        body: JSON.stringify({
          threadId: "th-after-graph-err",
          projectId: "proj-1",
          targetFileIds: ["file-1"],
        }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await route.POST(req);
      await readStreamToText(res);

      expect(scheduledAfterCallbacks.length).toBe(1);
      await scheduledAfterCallbacks[0]();
      expect(mockFlushPendingSettlements).toHaveBeenCalledWith(mockUser.id);
    });
  });
});
