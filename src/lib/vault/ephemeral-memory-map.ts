/**
 * Ephemeral Vault Memory Map & Zero-Knowledge Pointer Dereferencer
 *
 * Provides request-scoped, isolated in-memory storage for transient decrypted
 * vault section plaintexts using Node.js `AsyncLocalStorage`. Decrypted sections
 * are replaced by opaque pointers (`vault_ref://${fileId}#${headingSlug}`) within
 * the agent graph state. Pointers are resolved just-in-time strictly during prompt
 * compilation or 3-way merge, and memory buffers are guaranteed to be zeroed out
 * (`Buffer.fill(0)`) upon request termination or scope exit.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Canonical prefix identifying ephemeral vault pointers.
 */
export const VAULT_REF_PREFIX = "vault_ref://";

/**
 * In-memory map type holding transient section buffers indexed by vault reference pointer.
 */
export type EphemeralVaultMemoryMap = Map<string, Uint8Array>;

/**
 * Request-scoped AsyncLocalStorage instance managing isolated ephemeral vault maps.
 */
const storage = new AsyncLocalStorage<EphemeralVaultMemoryMap>();

/**
 * Thrown when attempting to store or access ephemeral vault memory
 * outside an active `runWithEphemeralVaultScope` execution context.
 */
export class EphemeralVaultScopeError extends Error {
  constructor(message = "Operation failed: outside active ephemeral vault scope") {
    super(message);
    this.name = "EphemeralVaultScopeError";
    Object.setPrototypeOf(this, EphemeralVaultScopeError.prototype);
  }
}

/**
 * Thrown when resolving an ephemeral vault reference pointer that is missing,
 * points to zeroed-out memory, or was accessed in an invalid execution state.
 */
export class EphemeralVaultResolutionError extends Error {
  constructor(message = "Failed to resolve ephemeral vault reference") {
    super(message);
    this.name = "EphemeralVaultResolutionError";
    Object.setPrototypeOf(this, EphemeralVaultResolutionError.prototype);
  }
}

/**
 * Formats a canonical vault reference pointer from a file ID and heading slug.
 *
 * @param fileId - Non-empty unique identifier of the file.
 * @param headingSlug - Non-empty unique slug of the section heading.
 * @returns Canonical pointer string: `vault_ref://${fileId}#${headingSlug}`
 * @throws {TypeError} If either argument is not a non-empty string.
 * @throws {Error} If arguments contain invalid characters (e.g. '#' or whitespace).
 */
export function formatVaultRef(fileId: string, headingSlug: string): string {
  if (typeof fileId !== "string" || fileId.trim().length === 0) {
    throw new TypeError("formatVaultRef: fileId must be a non-empty string");
  }
  if (typeof headingSlug !== "string" || headingSlug.trim().length === 0) {
    throw new TypeError("formatVaultRef: headingSlug must be a non-empty string");
  }
  if (fileId.includes("#")) {
    throw new Error(`formatVaultRef: fileId cannot contain '#' delimiter: "${fileId}"`);
  }
  if (headingSlug.includes("#")) {
    throw new Error(`formatVaultRef: headingSlug cannot contain '#' delimiter: "${headingSlug}"`);
  }
  if (/\s/.test(fileId)) {
    throw new Error(`formatVaultRef: fileId cannot contain whitespace: "${fileId}"`);
  }
  if (/\s/.test(headingSlug)) {
    throw new Error(`formatVaultRef: headingSlug cannot contain whitespace: "${headingSlug}"`);
  }
  return `${VAULT_REF_PREFIX}${fileId}#${headingSlug}`;
}

/**
 * Evaluates whether a given string is a well-formed canonical vault reference pointer.
 *
 * Must strictly adhere to `vault_ref://${fileId}#${headingSlug}` with non-empty,
 * single-hash delimited identifiers and no whitespace.
 *
 * @param value - Candidate string to inspect.
 * @returns True if value conforms to the canonical vault reference format.
 */
export function isVaultRef(value: string): boolean {
  if (typeof value !== "string" || !value.startsWith(VAULT_REF_PREFIX)) {
    return false;
  }
  const withoutPrefix = value.slice(VAULT_REF_PREFIX.length);
  const hashIndex = withoutPrefix.indexOf("#");
  if (hashIndex <= 0 || hashIndex === withoutPrefix.length - 1) {
    return false;
  }
  if (withoutPrefix.indexOf("#", hashIndex + 1) !== -1) {
    return false;
  }
  if (/\s/.test(withoutPrefix)) {
    return false;
  }
  return true;
}

/**
 * Executes an asynchronous or synchronous operation within an isolated ephemeral
 * vault memory scope using Node.js `AsyncLocalStorage`.
 *
 * Guarantees zero-knowledge hygiene: all in-memory buffers stored during the callback
 * are automatically zeroed out (`buffer.fill(0)`) and the map cleared in a `finally` block,
 * ensuring no plaintext lingers across requests or unhandled error unwinding.
 *
 * @param callback - Operation to execute within the isolated ephemeral scope.
 * @returns Promise resolving to the result of the callback operation.
 */
export async function runWithEphemeralVaultScope<T>(
  callback: () => Promise<T> | T
): Promise<T> {
  const map: EphemeralVaultMemoryMap = new Map();
  return storage.run(map, async () => {
    try {
      return await callback();
    } finally {
      zeroOutEphemeralVaultMemory();
    }
  });
}

/**
 * Stores a decrypted section plaintext into the active ephemeral vault memory map
 * and returns its opaque reference pointer (`vault_ref://${fileId}#${headingSlug}`).
 *
 * Invariant: If a section with the same pointer already exists in the active scope,
 * its previous buffer is zeroed out before being replaced.
 *
 * @param fileId - ID of the owning file.
 * @param headingSlug - Slug of the target heading section.
 * @param plaintext - Decrypted plaintext content to store transiently.
 * @returns Opaque canonical vault reference pointer.
 * @throws {EphemeralVaultScopeError} When invoked outside an active ephemeral vault scope.
 */
export function storeEphemeralVaultSection(
  fileId: string,
  headingSlug: string,
  plaintext: string
): string {
  const map = storage.getStore();
  if (!map) {
    throw new EphemeralVaultScopeError(
      "Cannot store ephemeral vault section: no active ephemeral vault scope"
    );
  }

  const pointer = formatVaultRef(fileId, headingSlug);
  const existing = map.get(pointer);
  if (existing) {
    try {
      existing.fill(0);
    } catch {
      // Best-effort wiping of replaced buffer
    }
  }

  const buffer = Buffer.from(plaintext, "utf-8");
  map.set(pointer, buffer);
  return pointer;
}

/**
 * Regular expression matching vault reference pointers within arbitrary text or JSON.
 * Supports Unicode identifiers, Arabic characters, digits, and hyphens.
 */
const VAULT_REF_SEARCH_REGEX = /vault_ref:\/\/([^\s#"'`<>(){}[\]\\]+)#([^\s#"'`<>(){}[\]\\]+)/gu;

/**
 * Resolves all ephemeral vault pointers embedded in the provided text just-in-time,
 * substituting each pointer with its decoded plaintext content from the active scope.
 *
 * Invariants:
 * 1. Fast return: if `text` does not include `vault_ref://`, returns `text` immediately
 *    without checking scope or allocating maps.
 * 2. Scope validation: if `text` contains pointers but no active scope exists, throws
 *    `EphemeralVaultResolutionError`.
 * 3. Integrity: if a pointer is missing or points to zeroed-out memory, throws
 *    `EphemeralVaultResolutionError`.
 * 4. Purity: does not mutate external state or stored graph structures.
 *
 * @param text - Input string potentially containing one or more vault reference pointers.
 * @returns Substituted string with all pointers dereferenced into plaintext.
 * @throws {EphemeralVaultResolutionError} When resolving an invalid, missing, or zeroed pointer.
 */
export function resolveVaultRefJustInTime(text: string): string {
  if (!text || typeof text !== "string" || !text.includes(VAULT_REF_PREFIX)) {
    return text;
  }

  const map = storage.getStore();
  if (!map) {
    throw new EphemeralVaultResolutionError(
      "Cannot resolve vault reference outside an active ephemeral vault scope"
    );
  }

  return text.replace(VAULT_REF_SEARCH_REGEX, (match) => {
    let pointer = match;
    let trailing = "";

    if (!map.has(pointer)) {
      // Check if trailing punctuation (e.g. .,;:!?) was captured as part of slug
      const trimmed = pointer.replace(/[.,;:!?]+$/, (punct) => {
        trailing = punct;
        return "";
      });
      if (map.has(trimmed)) {
        pointer = trimmed;
      }
    }

    const buffer = map.get(pointer);
    if (!buffer) {
      throw new EphemeralVaultResolutionError(
        `Vault reference "${pointer}" not found in active ephemeral vault memory map`
      );
    }

    // Verify buffer is not zeroed out
    let allZeros = buffer.length > 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] !== 0) {
        allZeros = false;
        break;
      }
    }
    if (allZeros) {
      throw new EphemeralVaultResolutionError(
        `Vault reference "${pointer}" points to zeroed-out memory`
      );
    }

    const decoded = Buffer.from(buffer).toString("utf-8");
    return decoded + trailing;
  });
}

/**
 * Wipes all stored plaintext buffers in the active ephemeral vault scope by filling
 * them with zeroes (`buffer.fill(0)`) and clearing the scope map.
 *
 * Idempotent, safe to invoke repeatedly or when outside an active scope.
 */
export function zeroOutEphemeralVaultMemory(): void {
  const map = storage.getStore();
  if (!map) {
    return;
  }

  for (const buffer of map.values()) {
    try {
      buffer.fill(0);
    } catch {
      // Best-effort wiping
    }
  }

  map.clear();
}

/**
 * Retrieves an array of all non-empty decoded plaintext strings currently
 * residing in the active ephemeral vault scope.
 *
 * Used primarily by `EncryptedCheckpointSerializer` for vault plaintext leak
 * assertions prior to checkpoint encryption and persistence.
 *
 * @returns Array of decoded plaintext strings, or empty array if outside scope or empty.
 */
export function getActiveEphemeralVaultPlaintexts(): string[] {
  const map = storage.getStore();
  if (!map || map.size === 0) {
    return [];
  }

  const plaintexts: string[] = [];
  for (const buffer of map.values()) {
    if (buffer.length === 0) {
      continue;
    }

    let allZeros = true;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] !== 0) {
        allZeros = false;
        break;
      }
    }
    if (allZeros) {
      continue;
    }

    const decoded = Buffer.from(buffer).toString("utf-8");
    if (decoded.length > 0) {
      plaintexts.push(decoded);
    }
  }

  return plaintexts;
}

/**
 * Determines whether an active ephemeral vault scope is currently present
 * and retains at least one stored plaintext section buffer.
 *
 * @returns True if active scope exists and has at least one entry, false otherwise.
 */
export function hasActiveVaultPlaintextInMemory(): boolean {
  const map = storage.getStore();
  return Boolean(map && map.size > 0);
}
