/**
 * Server-only ETag Generator for Sync System
 *
 * Uses Node.js crypto module for synchronous SHA-256 ETag generation.
 * This module is isolated strictly to server runtimes (Next.js server actions, API routes, DB scripts)
 * and must NEVER be imported by browser/client bundles.
 */

import { createHash } from "node:crypto";
import type { EncryptedEnvelope } from "./types/vault";
import {
    normalizeMarkdownSource,
    serializeEncryptedEnvelope,
    isValidETag,
    compareETags,
    parseETagHeader,
    formatETagHeader,
    generateETag,
    generateEncryptedETag,
} from "./etag-generator";

export {
    normalizeMarkdownSource,
    serializeEncryptedEnvelope,
    isValidETag,
    compareETags,
    parseETagHeader,
    formatETagHeader,
    generateETag,
    generateEncryptedETag,
};

/**
 * Generate a Strong ETag for a serialized EncryptedEnvelope JSON synchronously using Node crypto.
 * Formula: ETag = SHA-256(Serialized EncryptedEnvelope JSON)[0..32]
 */
export function generateEncryptedETagSync(envelope: EncryptedEnvelope | string): string {
    const serialized = serializeEncryptedEnvelope(envelope);
    return createHash("sha256").update(serialized).digest("hex").substring(0, 32);
}

/**
 * Generate ETag synchronously (for server-side use with Node.js crypto)
 */
export function generateETagSync(content: {
    id: string;
    content: string;
    updatedAt: Date | number;
    isEncrypted?: boolean;
    envelope?: EncryptedEnvelope | string;
}): string {
    if (content.isEncrypted && (content.envelope || content.content)) {
        return generateEncryptedETagSync(content.envelope || content.content);
    }

    const updatedAtStr = content.updatedAt instanceof Date
        ? content.updatedAt.toISOString()
        : new Date(content.updatedAt).toISOString();

    const normalizedContent = normalizeMarkdownSource(content.content);
    const dataToHash = `${content.id}${normalizedContent}${updatedAtStr}`;

    const hash = createHash("sha256")
        .update(dataToHash)
        .digest("hex");

    return hash.substring(0, 32);
}
