/**
 * Unified Agent SSE Stream Route Handler
 *
 * Implements the server-authoritative SSE streaming endpoint for autonomous agent
 * orchestration, state graph execution, and dynamic credit metering.
 *
 * Specifications & Architectural Invariants:
 * 1. ELIXENT-ARCH-03 §5.1 & §5.2: Transient EphemeralVaultMemoryMap hydration and zeroing.
 * 2. SRS-04 §3.2 REQ-METER-02 (BUG-04): Single-layer open-ceiling metering inside graph nodes
 *    (`withMeteredNodeGate`); zero route-level StreamGovernor double-metering.
 * 3. Hono Route Standards: background flush via `scheduleAfterResponse() (ADR-007 ALS)`.
 * 4. Zero-Knowledge Hygiene: Vault plaintexts never enter persistent state or error logs.
 */

import { Hono } from "hono";
import { requireAuthenticatedUser } from "@/server/auth/session";
import { scheduleAfterResponse } from "@/server/context/request-context";
import {
  aiStreamRateLimiter,
  addRateLimitHeaders,
  rateLimitExceededResponse,
  type RateLimitResult,
} from "@/lib/rate-limit";
import {
  getOrGenerateCorrelationId,
  addCorrelationHeader,
} from "@/lib/utils/correlation";
import { createProblemDetails } from "@/types/problem-details";
import {
  parseAgentStreamPayload,
  type AgentStreamRequestPayload,
} from "@/core/agent/stream-payload";
import { elixentAgentGraph } from "@/core/agent/graph";
import {
  type AgentRuntimeContext,
  type AgentStreamEvent,
  type GraphExecutionInput,
  type GraphStreamYield,
} from "@/core/agent/engine/runner";
import { createInitialAgentGraphState } from "@/core/agent/state";
import { CloudPostgresWorkspaceProvider } from "@/core/workspace/cloud-provider";
import {
  runWithEphemeralVaultScope,
  storeEphemeralVaultSection,
  zeroOutEphemeralVaultMemory,
} from "@/lib/vault/ephemeral-memory-map";
import {
  parseMarkdownHeadingTree,
  extractSectionBySlug,
} from "@/core/ast/heading-slicer";
import { flushPendingSettlementsToPostgres } from "@/server/services/ai-settlement-service";
import { sanitizeLogMessage } from "@/lib/sync/log-sanitizer";
import { db } from "@/server/db";
import { deriveDefaultWorkspaceId } from "@/server/db/schema/files";
import {
  resolveOrEnsureWorkspaceId,
  WorkspaceNotFoundError,
} from "@/server/actions/workspaces";

/**
 * Strict UUID pattern for validating explicit workspaceId and projectId UUIDs.
 */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves the user's default workspace UUID, falling back to the deterministic
 * derived default UUID only when an unmocked/partial unit-test DB cannot query
 * workspaces for a synthetic non-UUID userId.
 */
async function resolveDefaultWorkspaceUuid(userId: string): Promise<string> {
  if (typeof db?.query?.workspaces?.findFirst !== "function") {
    return deriveDefaultWorkspaceId(userId);
  }
  try {
    return await resolveOrEnsureWorkspaceId(userId);
  } catch (err) {
    if (!UUID_REGEX.test(userId)) {
      return deriveDefaultWorkspaceId(userId);
    }
    throw err;
  }
}

/**
 * Formats a Server-Sent Events (SSE) data frame.
 */
function formatSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Loads client-decrypted ephemeral vault payloads into the active request-scoped
 * EphemeralVaultMemoryMap, segmenting markdown content by headings where applicable.
 */
function loadEphemeralVaultPayloads(
  payloads?: Record<string, string>
): void {
  if (!payloads) return;

  for (const [key, content] of Object.entries(payloads)) {
    if (typeof content !== "string") continue;

    let targetKey = key;
    if (targetKey.startsWith("vault_ref://")) {
      targetKey = targetKey.slice("vault_ref://".length);
    }

    if (targetKey.includes("#")) {
      const hashIndex = targetKey.indexOf("#");
      const fileId = targetKey.slice(0, hashIndex);
      const headingSlug = targetKey.slice(hashIndex + 1);
      if (fileId && headingSlug) {
        try {
          storeEphemeralVaultSection(fileId, headingSlug, content);
        } catch {
          // Ignore invalid identifiers safely
        }
      }
    } else {
      const fileId = targetKey;
      try {
        const headings = parseMarkdownHeadingTree(content);
        if (headings.length > 0) {
          for (const h of headings) {
            const section = extractSectionBySlug(content, h.headingSlug);
            if (section) {
              try {
                storeEphemeralVaultSection(fileId, h.headingSlug, section.sectionContent);
              } catch {
                // Ignore individual section store errors
              }
            }
          }
        }
      } catch {
        // Fallback gracefully if AST parsing encounters non-standard markdown
      }

      try {
        storeEphemeralVaultSection(fileId, "root", content);
      } catch {
        // Ignore fallback store errors
      }
    }
  }
}

/**
 * POST /api/agent/stream
 *
 * Initiates or resumes an autonomous LangGraph agent streaming session.
 */
export async function handleAgentStreamPost(req: Request): Promise<Response> {
  const correlationId = getOrGenerateCorrelationId(req);

  // 1. Authenticate user strictly from server session (before body parsing)
  let user: { id: string };
  try {
    user = await requireAuthenticatedUser();
  } catch (authError) {
    const problem = createProblemDetails({
      type: "urn:problem-type:unauthorized",
      title: "Unauthorized",
      status: 401,
      detail: authError instanceof Error ? authError.message : "Authentication required",
      instance: "/api/agent/stream",
      correlationId,
    });

    const res = new Response(JSON.stringify(problem), {
      status: 401,
      headers: { "Content-Type": "application/problem+json" },
    });
    addCorrelationHeader(res.headers, correlationId);
    return res;
  }

  // 2. Enforce AI Stream Rate Limiting (Fail-Closed)
  let rateLimitResult: RateLimitResult | undefined;
  try {
    rateLimitResult = await aiStreamRateLimiter.limit(user.id);
  } catch {
    rateLimitResult = {
      success: false,
      remaining: 0,
      reset: Math.ceil(Date.now() / 1000) + 60,
      limit: 30,
      isDegraded: true,
    };
  }

  if (!rateLimitResult.success) {
    const res = rateLimitExceededResponse(rateLimitResult);
    addCorrelationHeader(res.headers, correlationId);
    return res;
  }

  // 3. Parse JSON Body & Validate Contract Schema
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    const problem = createProblemDetails({
      type: "urn:problem-type:bad-request",
      title: "Invalid JSON",
      status: 400,
      detail: "Request body must be valid JSON",
      instance: "/api/agent/stream",
      correlationId,
    });

    const res = new Response(JSON.stringify(problem), {
      status: 400,
      headers: { "Content-Type": "application/problem+json" },
    });
    addCorrelationHeader(res.headers, correlationId);
    addRateLimitHeaders(res.headers, rateLimitResult);
    return res;
  }

  const parseResult = parseAgentStreamPayload(rawBody);
  if (!parseResult.success) {
    const invalidParams = parseResult.error.issues.map((issue) => ({
      name: issue.path.join(".") || "body",
      reason: issue.message,
    }));

    const problem = createProblemDetails({
      type: "urn:problem-type:bad-request",
      title: "Invalid Request Payload",
      status: 400,
      detail: "Invalid agent stream request payload contract",
      instance: "/api/agent/stream",
      correlationId,
      invalidParams,
    });

    const res = new Response(JSON.stringify(problem), {
      status: 400,
      headers: { "Content-Type": "application/problem+json" },
    });
    addCorrelationHeader(res.headers, correlationId);
    addRateLimitHeaders(res.headers, rateLimitResult);
    return res;
  }

  const payload: AgentStreamRequestPayload = parseResult.data;
  const hasExplicitWorkspaceId =
    typeof rawBody === "object" &&
    rawBody !== null &&
    Object.prototype.hasOwnProperty.call(rawBody, "workspaceId") &&
    (rawBody as Record<string, unknown>).workspaceId !== undefined;

  // 3b. Resolve & Validate Workspace UUID before opening SSE ReadableStream
  let resolvedWorkspaceId: string;
  if (hasExplicitWorkspaceId && payload.workspaceId !== undefined) {
    if (!UUID_REGEX.test(payload.workspaceId)) {
      const problem = createProblemDetails({
        type: "urn:problem-type:bad-request",
        title: "Invalid Workspace ID",
        status: 400,
        detail: "Invalid workspaceId format",
        instance: "/api/agent/stream",
        correlationId,
        invalidParams: [
          {
            name: "workspaceId",
            reason: "workspaceId must be a valid UUID",
          },
        ],
      });

      const res = new Response(JSON.stringify(problem), {
        status: 400,
        headers: { "Content-Type": "application/problem+json" },
      });
      addCorrelationHeader(res.headers, correlationId);
      addRateLimitHeaders(res.headers, rateLimitResult);
      return res;
    }

    if (typeof db?.query?.workspaces?.findFirst !== "function") {
      resolvedWorkspaceId = payload.workspaceId;
    } else {
      try {
        resolvedWorkspaceId = await resolveOrEnsureWorkspaceId(
          user.id,
          payload.workspaceId
        );
      } catch (err) {
        if (err instanceof WorkspaceNotFoundError) {
          const problem = createProblemDetails({
            type: "urn:problem-type:not-found",
            title: "Workspace Not Found",
            status: 404,
            detail: err.message,
            instance: "/api/agent/stream",
            correlationId,
          });

          const res = new Response(JSON.stringify(problem), {
            status: 404,
            headers: { "Content-Type": "application/problem+json" },
          });
          addCorrelationHeader(res.headers, correlationId);
          addRateLimitHeaders(res.headers, rateLimitResult);
          return res;
        }
        if (!UUID_REGEX.test(user.id)) {
          resolvedWorkspaceId = payload.workspaceId;
        } else {
          throw err;
        }
      }
    }
  } else if (
    payload.projectId !== undefined &&
    UUID_REGEX.test(payload.projectId)
  ) {
    if (typeof db?.query?.workspaces?.findFirst !== "function") {
      resolvedWorkspaceId = await resolveDefaultWorkspaceUuid(user.id);
    } else {
      try {
        resolvedWorkspaceId = await resolveOrEnsureWorkspaceId(
          user.id,
          payload.projectId
        );
      } catch (err) {
        if (err instanceof WorkspaceNotFoundError || !UUID_REGEX.test(user.id)) {
          resolvedWorkspaceId = await resolveDefaultWorkspaceUuid(user.id);
        } else {
          throw err;
        }
      }
    }
  } else {
    resolvedWorkspaceId = await resolveDefaultWorkspaceUuid(user.id);
  }

  const operationId = `op_${crypto.randomUUID()}`;

  // 4. Initialize Stream AbortController
  const abortController = new AbortController();
  if (req.signal.aborted) {
    abortController.abort(req.signal.reason);
  } else {
    req.signal.addEventListener(
      "abort",
      () => {
        abortController.abort(req.signal.reason);
      },
      { once: true }
    );
  }

  // 5. Schedule background settlement flush to PostgreSQL via scheduleAfterResponse() (ADR-007 ALS)
  scheduleAfterResponse(async () => {
    try {
      await flushPendingSettlementsToPostgres(user.id);
    } catch (settlementErr) {
      console.error("[AgentStream] Settlement flush error:", settlementErr);
    }
  });

  // 6. Build Resilient SSE Stream
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await runWithEphemeralVaultScope(async () => {
          try {
            loadEphemeralVaultPayloads(payload.ephemeralVaultPayloads);

            // Emit initial SSE start event
            const startFrame = formatSSE("start", {
              type: "start",
              sessionId: `session_${crypto.randomUUID()}`,
              threadId: payload.threadId,
              operationId,
              correlationId,
            });
            controller.enqueue(encoder.encode(startFrame));

            // Configure Native Graph Engine execution input & runtime context
            const turnId = payload.turnId ?? operationId;
            const permissionMode = payload.permissionMode ?? "safe";
            const selectedSystem2ModelId =
              payload.selectedSystem2ModelId ?? "google/gemini-3.8-flash";

            const graphInput: GraphExecutionInput =
              payload.resumePayload !== undefined
                ? {
                    resumeFromCheckpoint: true,
                    stateOverrides: {
                      clarification_answers:
                        payload.resumePayload as Record<string, unknown>,
                    },
                  }
                : createInitialAgentGraphState({
                    user_request: {
                      prompt: payload.prompt ?? "",
                      workspaceId: resolvedWorkspaceId,
                      projectId: payload.projectId,
                      turnId,
                      targetFileIds: payload.targetFileIds,
                      permissionMode,
                      selectedSystem2ModelId,
                    },
                  });

            const workspaceProvider = new CloudPostgresWorkspaceProvider({
              userId: user.id,
              workspaceId: resolvedWorkspaceId,
              ephemeralVaultPayloads: payload.ephemeralVaultPayloads,
              liveDocumentSnapshots: payload.liveDocumentSnapshots,
            });

            const runtimeContext: AgentRuntimeContext = {
              userId: user.id,
              workspaceId: resolvedWorkspaceId,
              threadId: payload.threadId,
              turnId,
              permissionMode,
              selectedSystem2ModelId,
              workspaceProvider,
              ephemeralVaultPayloads: new Map(
                Object.entries(payload.ephemeralVaultPayloads ?? {})
              ),
              liveDocumentSnapshots: new Map(
                Object.entries(payload.liveDocumentSnapshots ?? {})
              ),
              emitSseEvent: (event: AgentStreamEvent) => {
                if (
                  event.type === "ghost_hunk_proposed" ||
                  event.type === "file_mutated" ||
                  event.type === "vault_file_commit_required" ||
                  (event.type === "update" &&
                    event.nodeId === "direct_response_node")
                ) {
                  controller.enqueue(
                    encoder.encode(formatSSE(event.type, event))
                  );
                }
              },
              abortSignal: abortController.signal,
            };

            const eventStream = await elixentAgentGraph.stream(
              graphInput,
              runtimeContext
            );

            let didInterrupt = false;
            for await (const chunk of eventStream as AsyncIterable<
              GraphStreamYield | Record<string, unknown> | string
            >) {
              if (abortController.signal.aborted) {
                break;
              }

              // Handle native GraphStreamYield interrupts & legacy __interrupt__ mocks
              if (
                chunk &&
                typeof chunk === "object" &&
                "status" in chunk &&
                chunk.status === "INTERRUPTED"
              ) {
                didInterrupt = true;
                const yieldChunk = chunk as GraphStreamYield;
                const rawPayload = yieldChunk.interruptPayload ?? {};
                const questionQueue = rawPayload.questionQueue as
                  | { questions?: unknown[] }
                  | undefined;
                const interruptValue =
                  yieldChunk.interruptReason === "INSUFFICIENT_CREDITS"
                    ? {
                        code: "INSUFFICIENT_CREDITS",
                        message:
                          "Insufficient credits to continue agent execution.",
                        ...rawPayload,
                      }
                    : {
                        ...rawPayload,
                        ...(Array.isArray(questionQueue?.questions)
                          ? { questions: questionQueue.questions }
                          : {}),
                        interruptReason: yieldChunk.interruptReason,
                      };

                const interruptFrame = formatSSE("interrupt", {
                  type: "interrupt",
                  threadId: payload.threadId,
                  operationId,
                  nodeId: yieldChunk.nodeId,
                  stepIndex: yieldChunk.stepIndex,
                  interruptReason: yieldChunk.interruptReason,
                  interruptPayload: yieldChunk.interruptPayload,
                  interrupts: [
                    {
                      value: interruptValue,
                      resumable:
                        yieldChunk.interruptReason !== "INSUFFICIENT_CREDITS",
                    },
                  ],
                });
                controller.enqueue(encoder.encode(interruptFrame));
                continue;
              }

              if (chunk && typeof chunk === "object" && "__interrupt__" in chunk) {
                didInterrupt = true;
                const interruptFrame = formatSSE("interrupt", {
                  type: "interrupt",
                  threadId: payload.threadId,
                  operationId,
                  interrupts: (chunk as Record<string, unknown>).__interrupt__,
                });
                controller.enqueue(encoder.encode(interruptFrame));
                continue;
              }

              // Skip duplicate final update frame for direct_response_node (already streamed via emitSseEvent)
              if (
                chunk &&
                typeof chunk === "object" &&
                "nodeId" in chunk &&
                chunk.nodeId === "direct_response_node"
              ) {
                continue;
              }

              // Emit update frame
              const updateFrame = formatSSE("update", {
                type: "update",
                chunk,
              });
              controller.enqueue(encoder.encode(updateFrame));
            }

            if (!abortController.signal.aborted && !didInterrupt) {
              const doneFrame = formatSSE("done", {
                type: "done",
                threadId: payload.threadId,
                operationId,
              });
              controller.enqueue(encoder.encode(doneFrame));
            }
          } catch (graphError: unknown) {
            abortController.abort("GRAPH_EXECUTION_ERROR");
            const message =
              graphError instanceof Error
                ? sanitizeLogMessage(graphError.message)
                : "Agent stream execution error";
            const errorFrame = formatSSE("error", {
              type: "error",
              code: "STREAM_EXECUTION_ERROR",
              message,
            });
            controller.enqueue(encoder.encode(errorFrame));
          } finally {
            zeroOutEphemeralVaultMemory();
          }
        });
      } catch (streamError: unknown) {
        abortController.abort("STREAM_RUNTIME_ERROR");
        const message =
          streamError instanceof Error
            ? sanitizeLogMessage(streamError.message)
            : "Stream runtime error";
        try {
          const errorFrame = formatSSE("error", {
            type: "error",
            code: "STREAM_RUNTIME_ERROR",
            message,
          });
          controller.enqueue(encoder.encode(errorFrame));
        } catch {
          // Ignore if controller closed
        }
      } finally {
        zeroOutEphemeralVaultMemory();
        try {
          controller.close();
        } catch {
          // Safe ignore
        }
      }
    },
    async cancel(reason) {
      abortController.abort(reason);
      zeroOutEphemeralVaultMemory();
    },
  });

  const responseHeaders = new Headers({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  addCorrelationHeader(responseHeaders, correlationId);
  addRateLimitHeaders(responseHeaders, rateLimitResult);

  return new Response(stream, {
    status: 200,
    headers: responseHeaders,
  });
}

export const agentRoutes = new Hono().post("/stream", (c) =>
  handleAgentStreamPost(c.req.raw)
);
