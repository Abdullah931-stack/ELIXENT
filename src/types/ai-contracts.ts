/**
 * AI Agent & Micro-Credit Metering Data Contracts & Runtime Validation Schemas
 *
 * Enforces cryptographic request fingerprinting, idempotency keys,
 * `/api/agent/stream` session orchestration payloads, and Micro-Credit
 * lease reservation/settlement lifecycle contracts for Elixent.
 *
 * Remediates: LUGX-067, LUGX-115, LUGX-116, LUGX-119
 */

import { z } from "zod";

/**
 * Supported AI execution modes for Micro-Credit metering.
 */
export const aiExecutionModeSchema = z.enum([
  "SINGLE_PASS_DECISION",
  "DISCRETE_THINKING",
  "STREAMING_GENERATIVE",
  "CREDIT_TOPUP",
]);

export type AIExecutionMode = z.infer<typeof aiExecutionModeSchema>;

/**
 * AI Agent Stream & Operation Request Payload Contract (`/api/agent/stream`)
 * Requires operationId and requestHash for replay defense and idempotency,
 * alongside optional LangGraph thread/project/vault context fields.
 */
export interface AIRequestContract {
  /** Unique idempotent operation UUID */
  readonly operationId: string;
  /** SHA-256 fingerprint of prompt + configuration */
  readonly requestHash: string;
  /** Prompt input text */
  readonly prompt: string;
  /** Optional LangGraph conversation thread identifier */
  readonly threadId?: string;
  /** Optional owning project identifier */
  readonly projectId?: string;
  /** Optional associated file UUID */
  readonly fileId?: string;
  /** Optional list of target workspace file IDs */
  readonly targetFileIds?: readonly string[];
  /** Optional client-decrypted ephemeral vault plaintext sections */
  readonly ephemeralVaultPayloads?: Readonly<Record<string, string>>;
  /** Optional live editor snapshots for 3-way Diff3 merging */
  readonly liveDocumentSnapshots?: Readonly<Record<string, string>>;
  /** Optional HITL interrupt resumption payload */
  readonly resumePayload?: unknown;
  /** Optional system instructions */
  readonly systemPrompt?: string;
  /** Requested model identifier */
  readonly model?: string;
  /** Whether streaming response is requested */
  readonly stream?: boolean;
  /** Timestamp when request was initiated */
  readonly clientTimestamp: number;
}

export const aiRequestSchema = z
  .object({
    operationId: z.string().min(1),
    requestHash: z.string().length(64), // SHA-256 hex string
    prompt: z.string().min(1),
    threadId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    fileId: z.string().uuid().optional(),
    targetFileIds: z.array(z.string().min(1)).optional(),
    ephemeralVaultPayloads: z.record(z.string(), z.string()).optional(),
    liveDocumentSnapshots: z.record(z.string(), z.string()).optional(),
    resumePayload: z.unknown().optional(),
    systemPrompt: z.string().optional(),
    model: z.string().min(1).optional(),
    stream: z.boolean().optional(),
    clientTimestamp: z.number().int().positive(),
  })
  .strict();

/**
 * AI Micro-Credit Lease & Quota Reservation Contract
 */
export interface AIReservationContract {
  readonly reservationId: string;
  readonly operationId: string;
  readonly userId: string;
  readonly requestHash: string;
  readonly estimatedTokens: number;
  readonly creditsReserved: number;
  readonly creditsReservedMicro?: number;
  readonly reservedInputMicro?: number;
  readonly reservedOutputMicro?: number;
  readonly threadId?: string;
  readonly stepKey?: string;
  readonly modelId?: string;
  readonly executionMode?: AIExecutionMode;
  readonly expiresAt: number;
}

export const aiReservationSchema = z
  .object({
    reservationId: z.string().min(1),
    operationId: z.string().min(1),
    userId: z.string().min(1),
    requestHash: z.string().length(64),
    estimatedTokens: z.number().int().positive(),
    creditsReserved: z.number().int().positive(),
    creditsReservedMicro: z.number().int().nonnegative().optional(),
    reservedInputMicro: z.number().int().nonnegative().optional(),
    reservedOutputMicro: z.number().int().nonnegative().optional(),
    threadId: z.string().min(1).optional(),
    stepKey: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    executionMode: aiExecutionModeSchema.optional(),
    expiresAt: z.number().int().positive(),
  })
  .strict();

/**
 * AI Micro-Credit Settlement Commitment Contract
 */
export interface AICommitReservationContract {
  readonly reservationId: string;
  readonly operationId: string;
  readonly requestHash: string;
  readonly actualTokensUsed: number;
  readonly creditsDeducted: number;
  readonly creditsDeductedMicro?: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
}

export const aiCommitReservationSchema = z
  .object({
    reservationId: z.string().min(1),
    operationId: z.string().min(1),
    requestHash: z.string().length(64),
    actualTokensUsed: z.number().int().nonnegative(),
    creditsDeducted: z.number().int().nonnegative(),
    creditsDeductedMicro: z.number().int().nonnegative().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * AI Micro-Credit Lease Refund & Abort Contract
 */
export interface AIRefundReservationContract {
  readonly reservationId: string;
  readonly operationId: string;
  readonly requestHash: string;
  readonly reason: string;
  readonly refundedMicro?: number;
}

export const aiRefundReservationSchema = z
  .object({
    reservationId: z.string().min(1),
    operationId: z.string().min(1),
    requestHash: z.string().length(64),
    reason: z.string().min(1),
    refundedMicro: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * AI User Micro-Credit Balance & Quota Status Contract
 */
export interface AIQuotaStatusContract {
  readonly allowed: boolean;
  readonly remainingQuota: number;
  readonly creditBalanceMicro?: number;
  readonly creditsDisplay?: number;
  readonly tier: string;
  readonly resetAt: number;
}

export const aiQuotaStatusSchema = z
  .object({
    allowed: z.boolean(),
    remainingQuota: z.number().int().nonnegative(),
    creditBalanceMicro: z.number().int().nonnegative().optional(),
    creditsDisplay: z.number().int().nonnegative().optional(),
    tier: z.string().min(1),
    resetAt: z.number().int().positive(),
  })
  .strict();
