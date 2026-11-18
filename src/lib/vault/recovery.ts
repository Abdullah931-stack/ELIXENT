/**
 * Vault Recovery Service
 *
 * Unwraps the recovery-encrypted master key using the canonical AAD context
 * (zk:v1:recovery:<userId>).
 */

import { AAD } from '../crypto/aad';
import { cryptoWorkerBridge, wipeBuffer, base64ToUint8Array } from '../sync/crypto-worker-bridge';
import { InvalidCiphertextOrKeyError } from '../sync/types/vault';

export interface AdaptiveRecoveryResult {
  /**
   * The recovered 32-byte raw master key
   */
  masterKey: Uint8Array;
  /**
   * True if the vault was unwrapped via legacy context and needs migration persistence
   */
  wasMigrated: boolean;
  /**
   * The newly re-wrapped envelope under canonical AAD, populated if wasMigrated is true
   */
  reWrappedEnvelope?: {
    ciphertext: string;
    iv: string;
  };
}

export interface AdaptiveRecoveryOptions {
  seedMnemonic: string;
  recoveryEncryptedMasterKey: string;
  recoverySaltBytes: Uint8Array;
  userId: string;
  kdfIterations?: number;
}

/**
 * Executes the Adaptive Dual-Try Recovery algorithm with zero-knowledge key isolation.
 */
export async function adaptiveUnwrapRecoverySeed(
  options: AdaptiveRecoveryOptions
): Promise<AdaptiveRecoveryResult> {
  const {
    seedMnemonic,
    recoveryEncryptedMasterKey,
    recoverySaltBytes,
    userId,
    kdfIterations = 600000
  } = options;

  const cleanSeed = seedMnemonic?.trim();
  const cleanUserId = userId?.trim();

  if (!cleanSeed) {
    throw new InvalidCiphertextOrKeyError('Recovery seed phrase cannot be empty');
  }
  if (!cleanUserId) {
    throw new InvalidCiphertextOrKeyError('User ID is required for recovery AAD');
  }

  let kekSeed: Uint8Array | null = null;
  let ivBytes: Uint8Array | null = null;

  try {
    // 1. Derive KEK-Seed from 12-word recovery mnemonic
    const seedBytes = await cryptoWorkerBridge.mnemonicToSeed(
      cleanSeed,
      recoverySaltBytes,
      kdfIterations
    );
    kekSeed = seedBytes.slice(0, 32);
    wipeBuffer(seedBytes);

    // 2. Parse wrapped recovery envelope
    let wrappedObj: { ciphertext: string; iv: string };
    try {
      wrappedObj = JSON.parse(recoveryEncryptedMasterKey);
      if (!wrappedObj.ciphertext || !wrappedObj.iv) {
        throw new Error('Missing ciphertext or iv in recovery envelope payload');
      }
    } catch {
      throw new InvalidCiphertextOrKeyError('Malformed recovery encrypted envelope payload');
    }

    ivBytes = base64ToUint8Array(wrappedObj.iv);

    // 3. Unwrap using canonical AAD (zk:v1:recovery:<userId>)
    const canonicalAAD = AAD.recoveryWrap(cleanUserId);
    try {
      const masterKey = await cryptoWorkerBridge.unwrapKeyRaw(
        kekSeed,
        wrappedObj.ciphertext,
        ivBytes,
        canonicalAAD
      );

      return {
        masterKey,
        wasMigrated: false
      };
    } catch (_canonicalErr: unknown) {
      throw new InvalidCiphertextOrKeyError(
        'Recovery seed phrase is incorrect, invalid, or does not match this vault.'
      );
    }
  } finally {
    if (kekSeed) wipeBuffer(kekSeed);
    if (ivBytes) wipeBuffer(ivBytes);
  }
}
