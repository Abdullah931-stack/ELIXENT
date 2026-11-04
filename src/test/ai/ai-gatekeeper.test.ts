/**
 * Phase 5 Closure: AI Gatekeeper (Matrix #6) + Log Sanitation (Matrix #10).
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { AIToolbar } from '@/components/editor/ai-toolbar';
import { SyncErrorHandler, SyncErrorType } from '@/lib/sync/error-handler';
import { SyncPerformanceMonitor } from '@/lib/sync/performance-monitor';
import { CloudPostgresWorkspaceProvider } from '@/core/workspace/cloud-provider';
import {
    VaultAIAccessDeniedError,
    EncryptedPayloadMissingError,
} from '@/core/workspace/provider';
import { parseHttpStreamError } from '@/lib/ai/stream-handler';
import { updateFileContent, toggleFileEncryption } from '@/server/actions/files';

const mockGetUser = vi.hoisted(() => vi.fn());
const mockDb = vi.hoisted(() => ({
    query: {
        files: { findFirst: vi.fn() },
        userVaultProfiles: { findFirst: vi.fn() },
    },
    update: vi.fn(() => ({
        set: vi.fn(() => ({
            where: vi.fn(() => ({
                returning: vi.fn().mockResolvedValue([{ id: 'u' }]),
            })),
        })),
    })),
}));

vi.mock('@/lib/supabase/server', () => ({ getUser: mockGetUser }));
vi.mock('@/server/db', () => ({
    db: mockDb,
    schema: {
        files: {
            id: 'id',
            userId: 'user_id',
            version: 'version',
            etag: 'etag',
            deletedAt: 'deleted_at',
            isEncrypted: 'is_encrypted',
            encryptionMetadata: 'encryption_metadata',
            content: 'content',
            title: 'title',
        },
        userVaultProfiles: {
            userId: 'user_id',
            allowAIOnEncryptedFiles: 'allow_ai_on_encrypted_files',
            updatedAt: 'updated_at',
        },
    },
}));

const noop = () => undefined;
const SECRET_DOC = 'CLOSURE_SECRET_DOC_ALPHA_9f8e7d6c5b4a';

describe('Phase 5 Closure: AI Hard Block + Log Sanitation (Matrix #6/#10)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('#6 UI shows encrypted shield badge on encrypted files when allowAIOnEncrypted is false', () => {
        render(
            React.createElement(AIToolbar, {
                onUndo: noop,
                onRedo: noop,
                onExport: noop,
                onCopy: noop,
                onSearch: noop,
                canUndo: true,
                canRedo: false,
                isLoading: false,
                isEncrypted: true,
                allowAIOnEncrypted: false,
            })
        );
        expect(screen.getByTestId('ai-encrypted-badge')).toBeTruthy();
    });

    it('#6 WorkspaceProvider & stream error parser reject encrypted file with 403 VAULT_AI_ACCESS_DENIED when vault AI is disabled or payload missing', async () => {
        const providerMockDb = {
            select: vi.fn().mockImplementationOnce(() => ({
                from: () => ({
                    where: () =>
                        Promise.resolve([
                            {
                                id: 'f1',
                                userId: 'u1',
                                title: 'Encrypted Doc',
                                isEncrypted: true,
                                content: 'ciphertext',
                                deletedAt: null,
                            },
                        ]),
                }),
            })).mockImplementationOnce(() => ({
                from: () => ({
                    where: () => ({
                        limit: () =>
                            Promise.resolve([
                                {
                                    userId: 'u1',
                                    allowAIOnEncryptedFiles: false,
                                },
                            ]),
                    }),
                }),
            })),
        };

        const provider = new CloudPostgresWorkspaceProvider({
            userId: 'u1',
            db: providerMockDb,
        });

        await expect(provider.listHeadingsTree(['f1'])).rejects.toThrow(
            VaultAIAccessDeniedError
        );

        const parsed403 = parseHttpStreamError(403, 'Forbidden', 'VAULT_AI_ACCESS_DENIED');
        expect(parsed403.code).toBe('VAULT_AI_ACCESS_DENIED');
        expect(parsed403.status).toBe(403);

        // Even when allowAIOnEncryptedFiles is true, missing ephemeralVaultPayloads is rejected
        const optedInDb = {
            select: vi.fn().mockImplementationOnce(() => ({
                from: () => ({
                    where: () =>
                        Promise.resolve([
                            {
                                id: 'f1',
                                userId: 'u1',
                                title: 'Encrypted Doc',
                                isEncrypted: true,
                                content: 'ciphertext',
                                deletedAt: null,
                            },
                        ]),
                }),
            })).mockImplementationOnce(() => ({
                from: () => ({
                    where: () => ({
                        limit: () =>
                            Promise.resolve([
                                {
                                    userId: 'u1',
                                    allowAIOnEncryptedFiles: true,
                                },
                            ]),
                    }),
                }),
            })),
        };

        const providerMissingPayload = new CloudPostgresWorkspaceProvider({
            userId: 'u1',
            ephemeralVaultPayloads: {},
            db: optedInDb,
        });

        await expect(providerMissingPayload.listHeadingsTree(['f1'])).rejects.toThrow(
            EncryptedPayloadMissingError
        );
    });

    it('#6 file save guards reject plaintext update or missing IV on encrypted files', async () => {
        mockGetUser.mockResolvedValue({ id: 'u1', email: 'u1@example.com' });
        mockDb.query.files.findFirst.mockResolvedValue({
            id: 'f1',
            userId: 'u1',
            isEncrypted: true,
            isFolder: false,
            version: 1,
            encryptionMetadata: null,
            deletedAt: null,
        });

        const plainResult = await updateFileContent('f1', 'plain', { expectedVersion: 1 });
        expect(plainResult.success).toBe(false);

        const missingIvResult = await toggleFileEncryption('f1', true, 'cipher', null, {
            expectedVersion: 1,
        });
        expect(missingIvResult.success).toBe(false);
    });

    it('#10 error-handler and performance-monitor never leak secrets', async () => {
        const handler = new SyncErrorHandler();
        const monitor = new SyncPerformanceMonitor();
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const err = handler.createError(
                SyncErrorType.ENCRYPTION_ERROR,
                `decrypt failed: content=${SECRET_DOC} ciphertext=${SECRET_DOC}`,
                {
                    metadata: {
                        fileId: 'f1',
                        content: SECRET_DOC,
                        ciphertext: SECRET_DOC,
                        masterKey: SECRET_DOC,
                        mnemonic: SECRET_DOC,
                        password: SECRET_DOC,
                        iv: SECRET_DOC,
                        salt: SECRET_DOC,
                        nested: { seed: SECRET_DOC },
                    },
                    originalError: new Error(`leak content=${SECRET_DOC}`),
                }
            );
            await handler.handle(err);
            monitor.recordMetric('sync_duration', 5, {
                fileId: 'f1',
                content: SECRET_DOC,
                ciphertext: SECRET_DOC,
            });
            monitor.recordMetric('push_duration', 3, {
                nested: { password: SECRET_DOC, plaintext: SECRET_DOC },
            });
            const logged = handler.getRecentErrors(5);
            const serialized = JSON.stringify({
                logged,
                count: monitor.getMetricsCount(),
                report: monitor.generateReport(60000),
            });
            const consoleOut = JSON.stringify(errSpy.mock.calls);
            expect(serialized).not.toContain(SECRET_DOC);
            expect(consoleOut).not.toContain(SECRET_DOC);
            expect(monitor.getMetricsCount()).toBe(2);
            expect(logged.length).toBeGreaterThan(0);
        } finally {
            errSpy.mockRestore();
        }
    });
});
