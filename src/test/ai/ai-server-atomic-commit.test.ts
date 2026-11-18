import { describe, it, expect, vi, beforeEach } from 'vitest';
import { updateFileContent, toggleFileEncryption } from '@/server/actions/files';
import { db } from '@/server/db';
import { getUser } from '@/lib/supabase/server';

vi.mock('@/lib/supabase/server', () => ({
    getUser: vi.fn(),
}));

vi.mock('@/server/db/transactional', () => ({
    txDb: null,
}));

vi.mock('@/server/db', () => ({
    db: {
        query: {
            creditLedgerTransactions: {
                findFirst: vi.fn(),
            },
            files: {
                findFirst: vi.fn(),
            },
        },
        update: vi.fn(),
    },
    schema: {
        creditLedgerTransactions: {
            operationId: 'operation_id',
            userId: 'user_id',
            status: 'status',
            nodeName: 'node_name',
            outputTokens: 'output_tokens',
            deltaMicro: 'delta_micro',
        },
        files: {
            id: 'id',
            userId: 'user_id',
            version: 'version',
            etag: 'etag',
            deletedAt: 'deleted_at',
            isEncrypted: 'is_encrypted',
            encryptionMetadata: 'encryption_metadata',
        },
    },
}));

describe('Server Atomic Document Save & Optimistic Version Guard (Phase 8 / Elixent)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects document update when user is not authenticated', async () => {
        vi.mocked(getUser).mockResolvedValueOnce(null);

        const res = await updateFileContent(
            '00000000-0000-0000-0000-000000000001',
            '# Updated content',
            { expectedVersion: 1 }
        );

        expect(res.success).toBe(false);
        expect(res.status).toBe('unauthorized');
    });

    it('returns not_found when file does not exist or belongs to another user', async () => {
        vi.mocked(getUser).mockResolvedValueOnce({ id: 'user-1', email: 'u1@example.com' } as any);
        vi.mocked(db.query.files.findFirst).mockResolvedValueOnce(undefined as any);

        const res = await updateFileContent(
            '00000000-0000-0000-0000-000000000002',
            '# Updated content',
            { expectedVersion: 1 }
        );

        expect(res.success).toBe(false);
        expect(res.status).toBe('not_found');
    });

    it('returns conflict when file version does not match expectedVersion', async () => {
        vi.mocked(getUser).mockResolvedValueOnce({ id: 'user-1', email: 'u1@example.com' } as any);
        vi.mocked(db.query.files.findFirst).mockResolvedValueOnce({
            id: 'file-1',
            userId: 'user-1',
            version: 3,
            etag: 'etag-v3',
            content: '# Server V3',
            isFolder: false,
            isEncrypted: false,
            encryptionMetadata: null,
            deletedAt: null,
            updatedAt: new Date(),
        } as any);

        const res = await updateFileContent('file-1', '# Stale client write', {
            expectedVersion: 2,
        });

        expect(res.success).toBe(false);
        expect(res.status).toBe('conflict');
        if (res.status === 'conflict') {
            expect(res.error).toContain('modified by another session');
            expect(res.serverVersion?.version).toBe(3);
        }
    });

    it('returns conflict when expectedETag does not match server ETag', async () => {
        vi.mocked(getUser).mockResolvedValueOnce({ id: 'user-1', email: 'u1@example.com' } as any);
        vi.mocked(db.query.files.findFirst).mockResolvedValueOnce({
            id: 'file-1',
            userId: 'user-1',
            version: 2,
            etag: 'server-etag-xyz',
            content: '# Server V2',
            isFolder: false,
            isEncrypted: false,
            encryptionMetadata: null,
            deletedAt: null,
            updatedAt: new Date(),
        } as any);

        const res = await updateFileContent('file-1', '# Client write', {
            expectedVersion: 2,
            expectedETag: 'client-expected-etag-abc',
        });

        expect(res.success).toBe(false);
        expect(res.status).toBe('conflict');
        if (res.status === 'conflict') {
            expect(res.error).toContain('ETag mismatch');
        }
    });

    it('atomically increments version and generates new ETag when expectedVersion matches', async () => {
        vi.mocked(getUser).mockResolvedValueOnce({ id: 'user-1', email: 'u1@example.com' } as any);
        vi.mocked(db.query.files.findFirst).mockResolvedValueOnce({
            id: 'file-1',
            userId: 'user-1',
            version: 2,
            etag: 'etag-v2',
            content: '# Baseline',
            isFolder: false,
            isEncrypted: false,
            encryptionMetadata: null,
            deletedAt: null,
            updatedAt: new Date(),
        } as any);

        vi.mocked(db.update).mockReturnValueOnce({
            set: vi.fn(() => ({
                where: vi.fn(() => ({
                    returning: vi.fn().mockResolvedValueOnce([
                        {
                            id: 'file-1',
                            userId: 'user-1',
                            version: 3,
                            etag: 'etag-v3',
                            content: '# Updated with accepted ghost hunks',
                            updatedAt: new Date(),
                        },
                    ]),
                })),
            })),
        } as any);

        const res = await updateFileContent(
            'file-1',
            '# Updated with accepted ghost hunks',
            { expectedVersion: 2, expectedETag: 'etag-v2', operationId: 'op-save-1' }
        );

        expect(res.success).toBe(true);
        if (res.success) {
            expect(res.version).toBe(3);
            expect(res.etag).toBe('etag-v3');
            expect(res.operationId).toBe('op-save-1');
        }
    });

    it('rejects plaintext updateFileContent on an encrypted file', async () => {
        vi.mocked(getUser).mockResolvedValueOnce({ id: 'user-1', email: 'u1@example.com' } as any);
        vi.mocked(db.query.files.findFirst).mockResolvedValueOnce({
            id: 'file-enc',
            userId: 'user-1',
            version: 1,
            etag: 'etag-v1',
            isFolder: false,
            isEncrypted: true,
            deletedAt: null,
            updatedAt: new Date(),
        } as any);

        const res = await updateFileContent(
            'file-enc',
            'Plaintext attempt on encrypted file',
            { expectedVersion: 1 }
        );

        expect(res.success).toBe(false);
        expect(res.status).toBe('error');
        if (!res.success) {
            expect(res.error).toContain('Cannot directly update encrypted file with plaintext');
        }
    });

    it('rejects toggleFileEncryption when isEncrypted is true without valid IV metadata', async () => {
        vi.mocked(getUser).mockResolvedValueOnce({ id: 'user-1', email: 'u1@example.com' } as any);
        vi.mocked(db.query.files.findFirst).mockResolvedValueOnce({
            id: 'file-enc',
            userId: 'user-1',
            version: 1,
            etag: 'etag-v1',
            isFolder: false,
            isEncrypted: true,
            encryptionMetadata: null,
            deletedAt: null,
            updatedAt: new Date(),
        } as any);

        const res = await toggleFileEncryption('file-enc', true, 'ciphertext-base64', null, {
            expectedVersion: 1,
        });

        expect(res.success).toBe(false);
        expect(res.status).toBe('error');
        if (!res.success) {
            expect(res.error).toContain('Encrypted files require valid encryptionMetadata with an IV');
        }
    });

    it('successfully commits encrypted content via toggleFileEncryption with valid encryptionMetadata', async () => {
        vi.mocked(getUser).mockResolvedValueOnce({ id: 'user-1', email: 'u1@example.com' } as any);
        const validMeta = {
            iv: 'aXYtMTIzNDU2Nzg5MA==',
            salt: 'c2FsdC0xMjM0NTY3ODkw',
            version: 1,
            algorithm: 'AES-GCM-256',
            keyId: 'master-v1',
            kdfIterations: 600000,
        };

        vi.mocked(db.query.files.findFirst).mockResolvedValueOnce({
            id: 'file-enc',
            userId: 'user-1',
            version: 1,
            etag: 'etag-v1',
            isFolder: false,
            isEncrypted: true,
            encryptionMetadata: validMeta,
            deletedAt: null,
            updatedAt: new Date(),
        } as any);

        vi.mocked(db.update).mockReturnValueOnce({
            set: vi.fn(() => ({
                where: vi.fn(() => ({
                    returning: vi.fn().mockResolvedValueOnce([
                        {
                            id: 'file-enc',
                            userId: 'user-1',
                            version: 2,
                            etag: 'etag-enc-v2',
                            content: 'new-ciphertext-base64',
                            isEncrypted: true,
                            encryptionMetadata: validMeta,
                            updatedAt: new Date(),
                        },
                    ]),
                })),
            })),
        } as any);

        const res = await toggleFileEncryption(
            'file-enc',
            true,
            'new-ciphertext-base64',
            validMeta,
            { expectedVersion: 1 }
        );

        expect(res.success).toBe(true);
        if (res.success) {
            expect(res.version).toBe(2);
            expect(res.etag).toBe('etag-enc-v2');
        }
    });
});
