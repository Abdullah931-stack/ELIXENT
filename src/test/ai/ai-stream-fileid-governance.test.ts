/**
 * Phase 10 Test Suite: Agent Stream targetFileIds Mandate & Encrypted Content Governance (LUGX-085)
 *
 * Verifies:
 * 1. POST /api/agent/stream strictly requires non-empty targetFileIds, rejecting missing or empty targetFileIds with HTTP 400.
 * 2. POST /api/agent/stream rejects malformed/empty strings inside targetFileIds with HTTP 400.
 * 3. CloudPostgresWorkspaceProvider rejects non-existent or foreign user file in targetFileIds with WorkspaceFileAccessDeniedError (404).
 * 4. CloudPostgresWorkspaceProvider on encrypted file fails closed with VaultAIAccessDeniedError (403 VAULT_AI_ACCESS_DENIED) if allowAIOnEncryptedFiles is false.
 * 5. CloudPostgresWorkspaceProvider on encrypted file fails closed with EncryptedPayloadMissingError (400) if decrypted entry is missing from ephemeralVaultPayloads.
 * 6. CloudPostgresWorkspaceProvider on encrypted file succeeds and redacts sections to vault_ref:// pointers when allowAIOnEncryptedFiles = true and ephemeralVaultPayloads contains the decrypted text.
 */

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleAgentStreamPost as agentStreamRoute } from "@/server/routes/agent.routes";
import { CloudPostgresWorkspaceProvider } from '@/core/workspace/cloud-provider';
import {
    WorkspaceFileAccessDeniedError,
    VaultAIAccessDeniedError,
    EncryptedPayloadMissingError,
} from '@/core/workspace/provider';
import { runWithEphemeralVaultScope } from '@/lib/vault/ephemeral-memory-map';

const {
    mockRequireAuthenticatedUser,
    mockGraphStream,
    mockGovernorSettle,
} = vi.hoisted(() => ({
    mockRequireAuthenticatedUser: vi.fn(),
    mockGraphStream: vi.fn(),
    mockGovernorSettle: vi.fn(),
}));

vi.mock('@/server/auth/session', () => ({
    requireAuthenticatedUser: mockRequireAuthenticatedUser,
}));

vi.mock('@/lib/rate-limit', () => ({
    aiStreamRateLimiter: {
        limit: vi.fn().mockResolvedValue({
            success: true,
            limit: 60,
            remaining: 59,
            reset: Date.now() + 60000,
        }),
    },
    addRateLimitHeaders: vi.fn(),
    rateLimitExceededResponse: vi.fn(),
}));

vi.mock('@/core/agent/graph', () => ({
    elixentAgentGraph: {
        stream: mockGraphStream,
    },
}));

vi.mock('@/lib/metering/stream-governor', () => ({
    StreamGovernor: class MockStreamGovernor {
        onTokenChunk = vi.fn().mockResolvedValue(true);
        settle = mockGovernorSettle.mockResolvedValue({ status: 'SETTLED' });
    },
}));

vi.mock('@/server/services/ai-settlement-service', () => ({
    flushPendingSettlementsToPostgres: vi.fn().mockResolvedValue({ flushedCount: 0, netDeltaMicro: BigInt(0) }),
}));

describe('Phase 10: Agent Stream targetFileIds Mandate & Zero-Knowledge Barrier (LUGX-085)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRequireAuthenticatedUser.mockResolvedValue({ id: 'user_123' });
        mockGraphStream.mockResolvedValue(
            (async function* () {
                yield { document_writer_node: { text: 'ok' } };
            })()
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('rejects requests missing targetFileIds entirely with HTTP 400', async () => {
        const req = new Request('http://localhost/api/agent/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                threadId: 'thread_1',
                projectId: 'proj_1',
                prompt: 'Summarize document text',
            }),
        });

        const res = await agentStreamRoute(req);
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.title).toBe('Invalid Request Payload');
        expect(mockGraphStream).not.toHaveBeenCalled();
    });

    it('rejects requests where targetFileIds is null with HTTP 400', async () => {
        const req = new Request('http://localhost/api/agent/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                threadId: 'thread_1',
                projectId: 'proj_1',
                targetFileIds: null,
                prompt: 'Summarize document text',
            }),
        });

        const res = await agentStreamRoute(req);
        expect(res.status).toBe(400);
        expect(mockGraphStream).not.toHaveBeenCalled();
    });

    it('rejects requests where targetFileIds contains empty whitespace string with HTTP 400', async () => {
        const req = new Request('http://localhost/api/agent/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                threadId: 'thread_1',
                projectId: 'proj_1',
                targetFileIds: ['   '],
                prompt: 'Summarize document text',
            }),
        });

        const res = await agentStreamRoute(req);
        expect(res.status).toBe(400);
        expect(mockGraphStream).not.toHaveBeenCalled();
    });

    it('throws WorkspaceFileAccessDeniedError (404) when targetFileId does not exist or belongs to another user', async () => {
        const mockDb = {
            select: vi.fn().mockReturnValue({
                from: () => ({
                    where: () => Promise.resolve([]),
                }),
            }),
        };

        const provider = new CloudPostgresWorkspaceProvider({
            userId: 'user_123',
            db: mockDb,
        });

        await expect(provider.listHeadingsTree(['non_existent_file'])).rejects.toThrow(
            WorkspaceFileAccessDeniedError
        );
    });

    it('rejects encrypted target file with VaultAIAccessDeniedError (403 VAULT_AI_ACCESS_DENIED) when allowAIOnEncryptedFiles is false', async () => {
        const mockDb = {
            select: vi.fn()
                .mockImplementationOnce(() => ({
                    from: () => ({
                        where: () =>
                            Promise.resolve([
                                {
                                    id: 'file_encrypted',
                                    userId: 'user_123',
                                    title: 'Vault Doc',
                                    isEncrypted: true,
                                    content: 'ciphertext_blob',
                                    deletedAt: null,
                                },
                            ]),
                    }),
                }))
                .mockImplementationOnce(() => ({
                    from: () => ({
                        where: () => ({
                            limit: () =>
                                Promise.resolve([
                                    {
                                        userId: 'user_123',
                                        allowAIOnEncryptedFiles: false,
                                    },
                                ]),
                        }),
                    }),
                })),
        };

        const provider = new CloudPostgresWorkspaceProvider({
            userId: 'user_123',
            ephemeralVaultPayloads: {
                file_encrypted: '# Secret Heading\nSecret body',
            },
            db: mockDb,
        });

        await expect(provider.listHeadingsTree(['file_encrypted'])).rejects.toThrow(
            VaultAIAccessDeniedError
        );
    });

    it('rejects encrypted target file with EncryptedPayloadMissingError when ephemeralVaultPayloads lacks the file entry', async () => {
        const mockDb = {
            select: vi.fn()
                .mockImplementationOnce(() => ({
                    from: () => ({
                        where: () =>
                            Promise.resolve([
                                {
                                    id: 'file_encrypted',
                                    userId: 'user_123',
                                    title: 'Vault Doc',
                                    isEncrypted: true,
                                    content: 'ciphertext_blob',
                                    deletedAt: null,
                                },
                            ]),
                    }),
                }))
                .mockImplementationOnce(() => ({
                    from: () => ({
                        where: () => ({
                            limit: () =>
                                Promise.resolve([
                                    {
                                        userId: 'user_123',
                                        allowAIOnEncryptedFiles: true,
                                    },
                                ]),
                        }),
                    }),
                })),
        };

        const provider = new CloudPostgresWorkspaceProvider({
            userId: 'user_123',
            ephemeralVaultPayloads: {},
            db: mockDb,
        });

        await expect(provider.listHeadingsTree(['file_encrypted'])).rejects.toThrow(
            EncryptedPayloadMissingError
        );
    });

    it('permits encrypted file when allowAIOnEncryptedFiles is true and ephemeralVaultPayloads provides decrypted content', async () => {
        const mockDb = {
            select: vi.fn()
                .mockImplementation(() => ({
                    from: (table: unknown) => ({
                        where: () => {
                            if ((table as { userId?: unknown }) && 'allowAIOnEncryptedFiles' in (table as object)) {
                                return {
                                    limit: () =>
                                        Promise.resolve([
                                            {
                                                userId: 'user_123',
                                                allowAIOnEncryptedFiles: true,
                                            },
                                        ]),
                                };
                            }
                            return Promise.resolve([
                                {
                                    id: 'file_encrypted',
                                    userId: 'user_123',
                                    title: 'Vault Doc',
                                    isEncrypted: true,
                                    content: 'ciphertext_blob',
                                    deletedAt: null,
                                },
                            ]);
                        },
                    }),
                })),
        };

        const provider = new CloudPostgresWorkspaceProvider({
            userId: 'user_123',
            ephemeralVaultPayloads: {
                file_encrypted: '# Secret Architecture\nZero-knowledge details.',
            },
            db: mockDb,
        });

        await runWithEphemeralVaultScope(async () => {
            const section = await provider.readSectionByHeading('file_encrypted', 'secret-architecture');
            expect(section.isVaultRef).toBe(true);
            expect(section.contentOrVaultRef).toBe('vault_ref://file_encrypted#secret-architecture');
        });
    });
});
