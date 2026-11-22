import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SyncCryptoGateway } from '@/lib/sync/sync-crypto-gateway';
import { sessionKeyStore } from '@/lib/sync/session-key-store';
import { base64ToUint8Array, cryptoWorkerBridge } from '@/lib/sync/crypto-worker-bridge';
import { encryptionMetadataSchema } from '@/types/rpc-contracts';
import {
    fileEncryptionMetadataSchema,
    encryptedStoragePayloadSchema,
} from '@/types/storage-payload';

describe('SyncCryptoGateway', () => {
    const testUserId = 'user-test-uuid-123';
    const testFileId = 'file-test-uuid-456';
    const rawMasterKey = new Uint8Array(32).fill(7);

    beforeEach(() => {
        sessionKeyStore.purgeKeys();
    });

    afterEach(() => {
        sessionKeyStore.purgeKeys();
    });

    it('should transparently pass-through unencrypted plaintext payloads', async () => {
        const result = await SyncCryptoGateway.decryptInbound({
            fileId: testFileId,
            content: '# Plaintext Document\nHello world',
            isEncrypted: false,
            userId: testUserId,
        });

        expect(result.status).toBe('plaintext');
        expect(result.isEncrypted).toBe(false);
        expect(result.isVaultLocked).toBe(false);
        expect(result.content).toBe('# Plaintext Document\nHello world');
        expect(result.encryptionMetadata).toBeNull();
    });

    it('should return locked status when vault is locked for encrypted payload', async () => {
        const result = await SyncCryptoGateway.decryptInbound({
            fileId: testFileId,
            content: 'encrypted-base64-payload',
            isEncrypted: true,
            encryptionMetadata: {
                version: 1,
                algorithm: 'AES-GCM-256',
                keyId: 'master-v1',
                salt: '',
                iv: 'test-iv-base64',
            },
            userId: testUserId,
        });

        expect(result.status).toBe('locked');
        expect(result.isEncrypted).toBe(true);
        expect(result.isVaultLocked).toBe(true);
        expect(result.content).toBe('encrypted-base64-payload');
        expect(result.encryptionMetadata?.iv).toBe('test-iv-base64');
    });

    it('should fail gracefully if encryptionMetadata or IV is missing for encrypted file', async () => {
        sessionKeyStore.storeMasterKeyRaw(rawMasterKey, 3600);

        const result = await SyncCryptoGateway.decryptInbound({
            fileId: testFileId,
            content: 'some-ciphertext',
            isEncrypted: true,
            encryptionMetadata: null,
            userId: testUserId,
        });

        expect(result.status).toBe('error');
        expect(result.error).toContain('Missing IV');
    });

    it('should correctly encrypt outbound and decrypt inbound symmetrically', async () => {
        sessionKeyStore.storeMasterKeyRaw(rawMasterKey, 3600);

        const originalText = '# Confidential Vault Document\nTop secret content.';
        const encrypted = await SyncCryptoGateway.encryptOutbound(
            testFileId,
            originalText,
            testUserId
        );

        expect(encrypted.ciphertextBase64).toBeDefined();
        expect(encrypted.ciphertextBase64.length).toBeGreaterThan(10);
        expect(encrypted.ciphertextBase64).not.toBe(originalText);
        expect(encrypted.encryptionMetadata.iv).toBeDefined();
        expect(encrypted.encryptionMetadata.algorithm).toBe('AES-GCM-256');

        // Now decrypt with Inbound Gateway
        const decrypted = await SyncCryptoGateway.decryptInbound({
            fileId: testFileId,
            content: encrypted.ciphertextBase64,
            isEncrypted: true,
            encryptionMetadata: encrypted.encryptionMetadata,
            userId: testUserId,
        });

        expect(decrypted.status).toBe('decrypted');
        expect(decrypted.isEncrypted).toBe(true);
        expect(decrypted.isVaultLocked).toBe(false);
        expect(decrypted.content).toBe(originalText);
        expect(decrypted.encryptionMetadata?.iv).toBe(encrypted.encryptionMetadata.iv);
    });

    it('should fail with error if ciphertext is tampered or AAD mismatch occurs', async () => {
        sessionKeyStore.storeMasterKeyRaw(rawMasterKey, 3600);

        const originalText = 'Secret data';
        const encrypted = await SyncCryptoGateway.encryptOutbound(
            testFileId,
            originalText,
            testUserId
        );

        // Tamper with userId (AAD mismatch)
        const tamperedDecryption = await SyncCryptoGateway.decryptInbound({
            fileId: testFileId,
            content: encrypted.ciphertextBase64,
            isEncrypted: true,
            encryptionMetadata: encrypted.encryptionMetadata,
            userId: 'foreign-user-id',
        });

        expect(tamperedDecryption.status).toBe('error');
        expect(tamperedDecryption.error).toBeDefined();
    });

    it('Phase 6 regression: encryptOutbound emits unique 16-byte CSPRNG base64 salt passing encryptionMetadataSchema and fileEncryptionMetadataSchema', async () => {
        sessionKeyStore.storeMasterKeyRaw(rawMasterKey, 3600);

        const plaintext = '# Zero-Knowledge Architecture Blueprint\nSensitive content.';
        const enc1 = await SyncCryptoGateway.encryptOutbound(testFileId, plaintext, testUserId);
        const enc2 = await SyncCryptoGateway.encryptOutbound(testFileId, plaintext, testUserId);

        // Cross-contract schema compliance: both RPC and storage payload schemas enforce non-empty salt
        expect(encryptionMetadataSchema.safeParse(enc1.encryptionMetadata).success).toBe(true);
        expect(fileEncryptionMetadataSchema.safeParse(enc1.encryptionMetadata).success).toBe(true);
        expect(
            encryptedStoragePayloadSchema.safeParse({
                type: 'encrypted',
                ciphertextBase64: enc1.ciphertextBase64,
                isEncrypted: true,
                encryptionMetadata: enc1.encryptionMetadata,
            }).success
        ).toBe(true);

        // Decoded salt is 16 CSPRNG bytes (128-bit) and decoded IV is 12 CSPRNG bytes (96-bit)
        const saltBytes1 = base64ToUint8Array(enc1.encryptionMetadata.salt);
        const ivBytes1 = base64ToUint8Array(enc1.encryptionMetadata.iv);
        expect(saltBytes1.byteLength).toBe(16);
        expect(ivBytes1.byteLength).toBe(12);
        expect(saltBytes1.some((b) => b !== 0)).toBe(true);

        // Consecutive encryptions must generate fresh salt & IV entropy
        expect(enc1.encryptionMetadata.salt).not.toBe(enc2.encryptionMetadata.salt);
        expect(enc1.encryptionMetadata.iv).not.toBe(enc2.encryptionMetadata.iv);

        // Inbound decryption preserves non-empty salt metadata
        const decrypted = await SyncCryptoGateway.decryptInbound({
            fileId: testFileId,
            content: enc1.ciphertextBase64,
            isEncrypted: true,
            encryptionMetadata: enc1.encryptionMetadata,
            userId: testUserId,
        });
        expect(decrypted.status).toBe('decrypted');
        expect(decrypted.content).toBe(plaintext);
        expect(decrypted.encryptionMetadata?.salt).toBe(enc1.encryptionMetadata.salt);
    });

    it('fails closed when vault is locked and zeroes allocated IV and salt buffers on both success and encryption failure', async () => {
        // Locked vault must reject outbound encryption before allocating crypto material
        await expect(
            SyncCryptoGateway.encryptOutbound(testFileId, 'secret', testUserId)
        ).rejects.toThrow(/Vault is locked/i);

        sessionKeyStore.storeMasterKeyRaw(rawMasterKey, 3600);

        const realGenerateRandomBytes = cryptoWorkerBridge.generateRandomBytes.bind(cryptoWorkerBridge);
        const allocatedBuffers: Uint8Array[] = [];
        const rngSpy = vi
            .spyOn(cryptoWorkerBridge, 'generateRandomBytes')
            .mockImplementation(async (length: number) => {
                const buf = await realGenerateRandomBytes(length);
                allocatedBuffers.push(buf);
                return buf;
            });

        try {
            // 1. Happy path: both IV (12B) and salt (16B) buffers must be zeroed in-place in finally
            await SyncCryptoGateway.encryptOutbound(testFileId, 'secret', testUserId);
            expect(allocatedBuffers.map((b) => b.byteLength)).toEqual([12, 16]);
            for (const buf of allocatedBuffers) {
                expect(buf.every((byte) => byte === 0)).toBe(true);
            }

            // 2. Failure path: WebCrypto failure must still zero both buffers in finally
            allocatedBuffers.length = 0;
            const encryptSpy = vi
                .spyOn(cryptoWorkerBridge, 'encryptAESGCM')
                .mockRejectedValueOnce(new Error('Simulated WebCrypto failure'));

            try {
                await expect(
                    SyncCryptoGateway.encryptOutbound(testFileId, 'secret', testUserId)
                ).rejects.toThrow('Simulated WebCrypto failure');
                expect(allocatedBuffers.map((b) => b.byteLength)).toEqual([12, 16]);
                for (const buf of allocatedBuffers) {
                    expect(buf.every((byte) => byte === 0)).toBe(true);
                }
            } finally {
                encryptSpy.mockRestore();
            }
        } finally {
            rngSpy.mockRestore();
        }
    });
});
