/**
 * Framework-Agnostic Agent Stream Request Payload Contract
 *
 * Defines the isomorphic schema, types, and parsing utilities for requests to the
 * unified agent stream endpoint (/api/agent/stream) per ELIXENT-ARCH-03 §5.1.
 *
 * Architectural Invariants:
 * 1. Framework-Agnostic: Zero imports from Next.js (next/*), React, or server-only runtimes.
 * 2. Closed & Bounded: Strict object validation (.strict()) with sane upper bounds on string
 *    lengths, record entries, and array item counts to prevent resource exhaustion.
 * 3. Ephemeral Isolation: Validates the transient fields `ephemeralVaultPayloads` and
 *    `liveDocumentSnapshots` without persisting or leaking plaintexts.
 */

import { z } from "zod";

/**
 * Maximum character limit for initial prompt string (100,000 characters).
 */
export const MAX_PROMPT_CHARS = 100_000;

/**
 * Maximum number of target files permitted in a single stream invocation.
 */
export const MAX_TARGET_FILES = 100;

/**
 * Maximum length for individual identifiers (threadId, projectId, fileId).
 */
export const MAX_IDENTIFIER_LENGTH = 256;

/**
 * Maximum character limit for a single ephemeral plaintext or live snapshot (2,000,000 characters).
 */
export const MAX_DOCUMENT_SNAPSHOT_CHARS = 2_000_000;

/**
 * Maximum number of keys allowed in ephemeral payload or snapshot records.
 */
export const MAX_RECORD_KEYS = 100;

/**
 * Strict Zod schema validating agent stream request payloads.
 */
export const AgentStreamRequestPayloadSchema = z
  .object({
    /** Unique conversation thread identifier */
    threadId: z
      .string()
      .trim()
      .min(1, "threadId must be a non-empty string")
      .max(MAX_IDENTIFIER_LENGTH, `threadId cannot exceed ${MAX_IDENTIFIER_LENGTH} characters`),

    /** Owning project identifier */
    projectId: z
      .string()
      .trim()
      .min(1, "projectId must be a non-empty string")
      .max(MAX_IDENTIFIER_LENGTH, `projectId cannot exceed ${MAX_IDENTIFIER_LENGTH} characters`),

    /** Optional user prompt when starting or extending an agent task */
    prompt: z
      .string()
      .max(MAX_PROMPT_CHARS, `prompt cannot exceed ${MAX_PROMPT_CHARS} characters`)
      .optional(),

    /** Array of target workspace file IDs */
    targetFileIds: z
      .array(
        z
          .string()
          .trim()
          .min(1, "targetFileId must be a non-empty string")
          .max(MAX_IDENTIFIER_LENGTH, `targetFileId cannot exceed ${MAX_IDENTIFIER_LENGTH} characters`)
      )
      .max(MAX_TARGET_FILES, `Cannot target more than ${MAX_TARGET_FILES} files simultaneously`),

    /** Optional resume payload passed when resuming execution after an interrupt() */
    resumePayload: z.unknown().optional(),

    /**
     * Plaintext of encrypted files decrypted locally in the client browser.
     * Used exclusively to populate EphemeralVaultMemoryMap within request scope.
     */
    ephemeralVaultPayloads: z
      .record(
        z.string().trim().min(1).max(MAX_IDENTIFIER_LENGTH),
        z.string().max(MAX_DOCUMENT_SNAPSHOT_CHARS)
      )
      .refine(
        (rec) => Object.keys(rec).length <= MAX_RECORD_KEYS,
        `ephemeralVaultPayloads cannot exceed ${MAX_RECORD_KEYS} entries`
      )
      .optional(),

    /**
     * Latest live snapshots of open editor documents for three-way Diff3 merge computation.
     */
    liveDocumentSnapshots: z
      .record(
        z.string().trim().min(1).max(MAX_IDENTIFIER_LENGTH),
        z.string().max(MAX_DOCUMENT_SNAPSHOT_CHARS)
      )
      .refine(
        (rec) => Object.keys(rec).length <= MAX_RECORD_KEYS,
        `liveDocumentSnapshots cannot exceed ${MAX_RECORD_KEYS} entries`
      )
      .optional(),
  })
  .strict();

/**
 * Inferred TypeScript type representing a validated agent stream request payload.
 */
export type AgentStreamRequestPayload = z.infer<typeof AgentStreamRequestPayloadSchema>;

/**
 * Discriminated result type returned by `parseAgentStreamPayload`.
 */
export type ParseAgentStreamPayloadResult =
  | { readonly success: true; readonly data: AgentStreamRequestPayload }
  | { readonly success: false; readonly error: z.ZodError };

/**
 * Pure, side-effect-free helper that parses and validates an unknown input
 * against `AgentStreamRequestPayloadSchema`, returning a typed discriminated union.
 *
 * @param input - Unknown candidate request body to validate.
 * @returns Discriminated union indicating validation success or failure.
 */
export function parseAgentStreamPayload(input: unknown): ParseAgentStreamPayloadResult {
  const result = AgentStreamRequestPayloadSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
