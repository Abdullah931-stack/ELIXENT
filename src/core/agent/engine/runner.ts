/**
 * Elixent Native Graph Engine Runner (ADR-009 & SRS-01 §2.3)
 *
 * Deterministic, zero-LangGraph state-machine execution engine with:
 * - Pure `(state, ctx) => Promise<NodeExecutionResult>` node contracts
 * - Conditional routing gates (`G-01..G-06`) returning `nextNodeId | null` (`null` = END)
 * - Bounded super-step execution (`maxSuperSteps = 25`) & AbortSignal cancellation
 * - AES-256-GCM encrypted checkpoint persistence per node into `agent_checkpoints`
 * - Dual SSE event emission (`ctx.emitSseEvent`) and `AsyncIterable` streaming
 */

import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import {
  encryptAgentGraphState,
  decryptAgentGraphState,
} from "@/core/agent/checkpoint-serializer";
import {
  applyStateDelta,
  type AgentGraphState,
  type AgentGraphStateDelta,
  type AgentPermissionMode,
} from "@/core/agent/state";
import type { IWorkspaceProvider } from "@/core/workspace/provider";

/**
 * Interrupt reasons supported by the Elixent Native Graph Engine and `agent_checkpoints`.
 */
export type AgentInterruptReason =
  | "HITL_CLARIFICATION_REQUIRED"
  | "FILE_DELETION_APPROVAL_REQUIRED"
  | "ANTI_DOMINO_CONFIRMATION_REQUIRED"
  | "INSUFFICIENT_CREDITS";

/**
 * Discriminated union of Server-Sent Events emitted during graph execution.
 */
export type AgentStreamEvent =
  | {
      readonly type: "start";
      readonly threadId: string;
      readonly turnId: string;
      readonly workspaceId: string;
    }
  | {
      readonly type: "update";
      readonly nodeId: string;
      readonly stepIndex: number;
      readonly stateDelta: AgentGraphStateDelta;
    }
  | {
      readonly type: "ghost_hunk_proposed";
      readonly fileId: string;
      readonly headingSlug: string;
      readonly hunks: ReadonlyArray<Record<string, unknown>>;
    }
  | {
      readonly type: "file_mutated";
      readonly fileId: string;
      readonly relativePath: string;
      readonly action: "created" | "deleted" | "updated";
    }
  | {
      readonly type: "vault_file_commit_required";
      readonly fileId: string;
      readonly relativePath: string;
      readonly mergedContent: string;
    }
  | {
      readonly type: "interrupt";
      readonly threadId: string;
      readonly stepIndex: number;
      readonly nodeId: string;
      readonly interruptReason: AgentInterruptReason;
      readonly interruptPayload: Record<string, unknown>;
    }
  | {
      readonly type: "done";
      readonly threadId: string;
      readonly stepIndex: number;
      readonly state: AgentGraphState;
    }
  | {
      readonly type: "error";
      readonly threadId: string;
      readonly message: string;
      readonly code?: string;
    };

/**
 * Immutable per-turn runtime context passed to every graph node.
 */
export interface AgentRuntimeContext {
  readonly userId: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly permissionMode: AgentPermissionMode;
  readonly selectedSystem2ModelId: string;
  readonly workspaceProvider: IWorkspaceProvider;
  readonly ephemeralVaultPayloads: ReadonlyMap<string, string>;
  readonly liveDocumentSnapshots: ReadonlyMap<string, string>;
  readonly emitSseEvent: (event: AgentStreamEvent) => void;
  readonly abortSignal: AbortSignal;
  readonly currentStepIndex?: number;
}

/**
 * Execution outcome returned by every native graph node.
 */
export type NodeExecutionResult =
  | {
      readonly status: "COMPLETED";
      readonly stateDelta: AgentGraphStateDelta;
    }
  | {
      readonly status: "INTERRUPTED";
      readonly interruptReason: AgentInterruptReason;
      readonly stateDelta: AgentGraphStateDelta;
      readonly interruptPayload: Record<string, unknown>;
    };

/**
 * Canonical signature for all Elixent Native Graph Engine nodes.
 */
export type AgentGraphNodeFn = (
  state: Readonly<AgentGraphState>,
  ctx: AgentRuntimeContext,
) => Promise<NodeExecutionResult>;

/**
 * Conditional routing gate function (`G-01..G-06`).
 * Returns the next node ID to execute, or `null` to terminate at `END`.
 */
export type AgentGraphGateFn = (
  state: Readonly<AgentGraphState>,
) => string | null;

/**
 * Declarative graph topology consumed by `ElixentNativeGraphRunner`.
 */
export interface ElixentGraphDefinition {
  readonly entryNodeId: string;
  readonly nodes: Record<string, AgentGraphNodeFn>;
  readonly edges: Record<string, string | AgentGraphGateFn | null>;
  readonly maxSuperSteps?: number;
}

/**
 * Input to `.stream()` and `.invoke()`, supporting fresh runs or checkpoint resumption.
 */
export type GraphExecutionInput =
  | AgentGraphState
  | {
      readonly resumeFromCheckpoint: true;
      readonly stateOverrides?: AgentGraphStateDelta;
    };

/**
 * Yielded step update from `ElixentNativeGraphRunner.stream(...)`.
 */
export interface GraphStreamYield {
  readonly nodeId: string;
  readonly stepIndex: number;
  readonly status: "COMPLETED" | "INTERRUPTED";
  readonly stateDelta: AgentGraphStateDelta;
  readonly state: AgentGraphState;
  readonly interruptReason?: AgentInterruptReason;
  readonly interruptPayload?: Record<string, unknown>;
}

/**
 * Thrown when `ElixentNativeGraphRunner` exceeds `maxSuperSteps`.
 */
export class MaxSuperStepsExceededError extends Error {
  readonly code = "MAX_SUPER_STEPS_EXCEEDED" as const;

  constructor(maxSuperSteps: number) {
    super(
      `ElixentNativeGraphRunner exceeded maximum super-steps (${maxSuperSteps})`,
    );
    this.name = "MaxSuperStepsExceededError";
    Object.setPrototypeOf(this, MaxSuperStepsExceededError.prototype);
  }
}

/**
 * Thrown when graph execution is cancelled via `ctx.abortSignal`.
 */
export class GraphExecutionAbortedError extends Error {
  readonly code = "GRAPH_EXECUTION_ABORTED" as const;

  constructor(message = "Agent graph execution aborted by caller signal") {
    super(message);
    this.name = "GraphExecutionAbortedError";
    Object.setPrototypeOf(this, GraphExecutionAbortedError.prototype);
  }
}

function isResumeInput(
  input: GraphExecutionInput,
): input is { readonly resumeFromCheckpoint: true; readonly stateOverrides?: AgentGraphStateDelta } {
  return (
    typeof input === "object" &&
    input !== null &&
    "resumeFromCheckpoint" in input &&
    input.resumeFromCheckpoint === true
  );
}

/**
 * Core deterministic execution engine for the Elixent Native Graph.
 */
export class ElixentNativeGraphRunner {
  readonly maxSuperSteps: number;
  private readonly entryNodeId: string;
  private readonly nodes: Record<string, AgentGraphNodeFn>;
  private readonly edges: Record<string, string | AgentGraphGateFn | null>;

  constructor(definition: ElixentGraphDefinition) {
    this.entryNodeId = definition.entryNodeId;
    this.nodes = definition.nodes;
    this.edges = definition.edges;
    this.maxSuperSteps = definition.maxSuperSteps ?? 25;
  }

  /**
   * Loads and decrypts the latest persisted checkpoint for `(workspaceId, threadId)`.
   */
  async loadLatestCheckpoint(
    workspaceId: string,
    threadId: string,
  ): Promise<{
    stepIndex: number;
    nodeId: string;
    nextNodeId: string | null;
    status: "RUNNING" | "INTERRUPTED" | "COMPLETED" | "FAILED";
    state: AgentGraphState;
  } | null> {
    const rows = await db
      .select()
      .from(schema.agentCheckpoints)
      .where(
        and(
          eq(schema.agentCheckpoints.workspaceId, workspaceId),
          eq(schema.agentCheckpoints.threadId, threadId),
        ),
      )
      .orderBy(desc(schema.agentCheckpoints.stepIndex))
      .limit(1);

    const latest = rows[0];
    if (!latest) {
      return null;
    }

    const decryptedState = decryptAgentGraphState(latest.encryptedStateBlob);
    return {
      stepIndex: latest.stepIndex,
      nodeId: latest.nodeId,
      nextNodeId: latest.nextNodeId,
      status: latest.status,
      state: decryptedState,
    };
  }

  /**
   * Persists an encrypted checkpoint row for a completed or interrupted node step.
   */
  private async persistCheckpoint(params: {
    ctx: AgentRuntimeContext;
    stepIndex: number;
    nodeId: string;
    status: "INTERRUPTED" | "COMPLETED";
    nextNodeId: string | null;
    interruptReason: AgentInterruptReason | null;
    state: AgentGraphState;
  }): Promise<void> {
    const encryptedStateBlob = encryptAgentGraphState(params.state);

    await db
      .insert(schema.agentCheckpoints)
      .values({
        threadId: params.ctx.threadId,
        stepIndex: params.stepIndex,
        workspaceId: params.ctx.workspaceId,
        userId: params.ctx.userId,
        nodeId: params.nodeId,
        status: params.status,
        nextNodeId: params.nextNodeId,
        interruptReason: params.interruptReason,
        encryptedStateBlob,
      })
      .onConflictDoUpdate({
        target: [
          schema.agentCheckpoints.threadId,
          schema.agentCheckpoints.stepIndex,
        ],
        set: {
          nodeId: params.nodeId,
          status: params.status,
          nextNodeId: params.nextNodeId,
          interruptReason: params.interruptReason,
          encryptedStateBlob,
        },
      });
  }

  /**
   * Resolves the next node ID from static edges or conditional gate functions (`G-01..G-06`).
   */
  private resolveNextNodeId(
    nodeId: string,
    state: Readonly<AgentGraphState>,
  ): string | null {
    const edge = this.edges[nodeId];
    if (edge === undefined || edge === null) {
      return null;
    }
    if (typeof edge === "function") {
      return edge(state);
    }
    return edge;
  }

  /**
   * Streams graph execution step-by-step as an `AsyncIterable` while emitting
   * typed `AgentStreamEvent` frames through `ctx.emitSseEvent`.
   */
  async *stream(
    initialState: GraphExecutionInput,
    ctx: AgentRuntimeContext,
  ): AsyncGenerator<GraphStreamYield, AgentGraphState, void> {
    ctx.emitSseEvent({
      type: "start",
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      workspaceId: ctx.workspaceId,
    });

    let currentState: AgentGraphState;
    let currentNodeId: string | null = this.entryNodeId;
    let stepIndex = 0;

    if (isResumeInput(initialState)) {
      const checkpoint = await this.loadLatestCheckpoint(
        ctx.workspaceId,
        ctx.threadId,
      );
      if (!checkpoint) {
        const message = `No checkpoint found to resume thread "${ctx.threadId}"`;
        ctx.emitSseEvent({
          type: "error",
          threadId: ctx.threadId,
          message,
          code: "CHECKPOINT_NOT_FOUND",
        });
        throw new Error(message);
      }

      currentState = initialState.stateOverrides
        ? applyStateDelta(checkpoint.state, initialState.stateOverrides)
        : checkpoint.state;
      currentNodeId =
        checkpoint.status === "INTERRUPTED"
          ? checkpoint.nodeId
          : checkpoint.nextNodeId;
      stepIndex = checkpoint.stepIndex + 1;
    } else {
      currentState = initialState;
    }

    let stepsExecuted = 0;

    while (currentNodeId !== null && stepsExecuted < this.maxSuperSteps) {
      if (ctx.abortSignal.aborted) {
        const abortErr = new GraphExecutionAbortedError();
        ctx.emitSseEvent({
          type: "error",
          threadId: ctx.threadId,
          message: abortErr.message,
          code: abortErr.code,
        });
        throw abortErr;
      }

      const nodeFn = this.nodes[currentNodeId];
      if (!nodeFn) {
        const message = `Graph node "${currentNodeId}" is not registered`;
        ctx.emitSseEvent({
          type: "error",
          threadId: ctx.threadId,
          message,
          code: "NODE_NOT_FOUND",
        });
        throw new Error(message);
      }

      const nodeCtx: AgentRuntimeContext = {
        ...ctx,
        currentStepIndex: stepIndex,
      };
      const result = await nodeFn(currentState, nodeCtx);
      currentState = applyStateDelta(currentState, result.stateDelta);

      if (result.status === "INTERRUPTED") {
        await this.persistCheckpoint({
          ctx,
          stepIndex,
          nodeId: currentNodeId,
          status: "INTERRUPTED",
          nextNodeId: currentNodeId,
          interruptReason: result.interruptReason,
          state: currentState,
        });

        ctx.emitSseEvent({
          type: "interrupt",
          threadId: ctx.threadId,
          stepIndex,
          nodeId: currentNodeId,
          interruptReason: result.interruptReason,
          interruptPayload: result.interruptPayload,
        });

        yield {
          nodeId: currentNodeId,
          stepIndex,
          status: "INTERRUPTED",
          stateDelta: result.stateDelta,
          state: currentState,
          interruptReason: result.interruptReason,
          interruptPayload: result.interruptPayload,
        };

        return currentState;
      }

      const nextNodeId = this.resolveNextNodeId(currentNodeId, currentState);

      await this.persistCheckpoint({
        ctx,
        stepIndex,
        nodeId: currentNodeId,
        status: "COMPLETED",
        nextNodeId,
        interruptReason: null,
        state: currentState,
      });

      ctx.emitSseEvent({
        type: "update",
        nodeId: currentNodeId,
        stepIndex,
        stateDelta: result.stateDelta,
      });

      yield {
        nodeId: currentNodeId,
        stepIndex,
        status: "COMPLETED",
        stateDelta: result.stateDelta,
        state: currentState,
      };

      currentNodeId = nextNodeId;
      stepIndex += 1;
      stepsExecuted += 1;
    }

    if (stepsExecuted >= this.maxSuperSteps && currentNodeId !== null) {
      const maxStepsErr = new MaxSuperStepsExceededError(this.maxSuperSteps);
      ctx.emitSseEvent({
        type: "error",
        threadId: ctx.threadId,
        message: maxStepsErr.message,
        code: maxStepsErr.code,
      });
      throw maxStepsErr;
    }

    ctx.emitSseEvent({
      type: "done",
      threadId: ctx.threadId,
      stepIndex: Math.max(0, stepIndex - 1),
      state: currentState,
    });

    return currentState;
  }

  /**
   * Executes the graph to completion or interrupt and returns the final `AgentGraphState`.
   */
  async invoke(
    initialState: GraphExecutionInput,
    ctx: AgentRuntimeContext,
  ): Promise<AgentGraphState> {
    const iterator = this.stream(initialState, ctx);
    let next = await iterator.next();
    while (!next.done) {
      next = await iterator.next();
    }
    return next.value;
  }
}
