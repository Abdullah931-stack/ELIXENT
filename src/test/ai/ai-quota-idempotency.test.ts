import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    tokensToMicroCredits,
    getModelRegistryEntry,
    deriveStreamingGenerativeReservation,
    deriveModelReservationParameters,
} from '@/lib/metering/derivation';
import {
    getUserCreditBalance,
    computeRequestHash,
} from '@/server/services/ai-settlement-service';
import { StreamGovernor } from '@/lib/metering/stream-governor';
import { REDIS_KEYS } from '@/lib/metering/constants';
import {
    RESERVE_OR_EXTEND_LUA,
    SETTLE_OPERATION_LUA,
    type RedisEvalClient,
} from '@/lib/metering/lua-scripts';

class InMemoryMeteringRedis implements RedisEvalClient {
    public wallets = new Map<string, number>();
    public leases = new Map<string, Record<string, any>>();
    public stepDone = new Map<string, string>();
    public pendingSettlements = new Map<string, Map<string, string>>();
    public dirtyWallets = new Set<string>();

    public async exists(key: string): Promise<number> {
        return this.wallets.has(key) ? 1 : 0;
    }

    public async get(key: string): Promise<number | null> {
        return this.wallets.get(key) ?? null;
    }

    public async hlen(key: string): Promise<number> {
        return this.pendingSettlements.get(key)?.size ?? 0;
    }

    public async eval<T = unknown>(
        script: string,
        keys: string[],
        args: (string | number)[]
    ): Promise<T> {
        if (script === RESERVE_OR_EXTEND_LUA) {
            const [walletKey, leaseKey] = keys;
            const [reqInputStr, desOutputStr, minOutputStr, _zeroDustStr, leaseTtlStr, userId, stepKey] = args;
            const reqInput = Number(reqInputStr);
            const desOutput = Number(desOutputStr);
            const minOutput = Number(minOutputStr);
            const curBal = this.wallets.get(walletKey);

            if (curBal === undefined) {
                return JSON.stringify({ status: 'COLD_START_REQUIRED' }) as unknown as T;
            }
            if (curBal < reqInput + minOutput) {
                return JSON.stringify({
                    status: 'INSUFFICIENT_CREDITS',
                    available: curBal,
                    required: reqInput + minOutput,
                }) as unknown as T;
            }

            const grantedOutput = Math.min(desOutput, curBal - reqInput);
            const totalDelta = reqInput + grantedOutput;
            this.wallets.set(walletKey, curBal - totalDelta);

            const existing = this.leases.get(leaseKey) ?? { totalReservedMicro: 0, reservedOutputMicro: 0 };
            const totalReservedMicro = existing.totalReservedMicro + totalDelta;
            this.leases.set(leaseKey, {
                totalReservedMicro,
                reservedOutputMicro: existing.reservedOutputMicro + grantedOutput,
                userId: String(userId),
                stepKey: String(stepKey),
                ttl: Number(leaseTtlStr),
            });

            return JSON.stringify({
                status: 'SUCCESS',
                reservedInputMicro: reqInput,
                reservedOutputMicro: grantedOutput,
                totalReservedMicro,
                newBalanceMicro: curBal - totalDelta,
            }) as unknown as T;
        }

        if (script === SETTLE_OPERATION_LUA) {
            const [walletKey, leaseKey, pendingKey, _dirtyKey, stepDoneKey] = keys;
            const [operationId, actualCostStr, payloadJson, userId] = args;

            const lease = this.leases.get(leaseKey);
            const totalReserved = Number(lease?.totalReservedMicro ?? 0);
            const actualCost = Number(actualCostStr);
            const refund = Math.max(0, totalReserved - actualCost);

            const cur = this.wallets.get(walletKey) ?? 0;
            this.wallets.set(walletKey, cur + refund);
            this.leases.delete(leaseKey);

            let pending = this.pendingSettlements.get(pendingKey);
            if (!pending) {
                pending = new Map();
                this.pendingSettlements.set(pendingKey, pending);
            }
            pending.set(String(operationId), String(payloadJson));
            this.dirtyWallets.add(String(userId));
            this.stepDone.set(stepDoneKey, String(payloadJson));

            return JSON.stringify({
                status: 'SETTLED',
                refundMicro: refund,
                totalReservedMicro: totalReserved,
                actualCostMicro: actualCost,
                newBalanceMicro: cur + refund,
            }) as unknown as T;
        }

        throw new Error(`Unhandled script in InMemoryMeteringRedis: ${script}`);
    }
}

const { ledgerStore, userStore, mockFindFirst } = vi.hoisted(() => ({
    ledgerStore: new Map<string, Record<string, any>>(),
    userStore: new Map<string, { id: string; creditBalanceMicro: bigint; tier: string }>(),
    mockFindFirst: vi.fn(),
}));

vi.mock('@/server/db/transactional', () => ({
    txDb: null,
}));

vi.mock('@/server/db', () => ({
    db: {
        query: {
            creditLedgerTransactions: {
                findFirst: mockFindFirst,
            },
            users: {
                findFirst: vi.fn(),
            },
        },
        insert: vi.fn(() => ({
            values: vi.fn((val: Record<string, any>) => {
                const row = Array.isArray(val) ? val[0] : val;
                const storedRow = { createdAt: new Date(), ...row };
                if (storedRow?.operationId) {
                    ledgerStore.set(storedRow.operationId, storedRow);
                }
                return {
                    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
                    returning: vi.fn().mockResolvedValue([storedRow]),
                };
            }),
        })),
        update: vi.fn(() => ({
            set: vi.fn((updates: Record<string, any>) => {
                if (updates && ('nodeName' in updates || 'status' in updates)) {
                    for (const [key, existing] of ledgerStore.entries()) {
                        ledgerStore.set(key, { ...existing, ...updates });
                    }
                }
                return {
                    where: vi.fn(() => {
                        const promise = Promise.resolve([{ id: 'user-101', ...updates }]);
                        return Object.assign(promise, {
                            returning: vi.fn().mockResolvedValue([{ id: 'user-101', ...updates }]),
                        });
                    }),
                };
            }),
        })),
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
        users: {
            id: 'id',
            creditBalanceMicro: 'credit_balance_micro',
            tier: 'tier',
        },
    },
}));

describe('AI Quota Derivation & Idempotent Settlement State Machine (Elixent Metering)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        ledgerStore.clear();
        userStore.clear();
        userStore.set('user-101', {
            id: 'user-101',
            creditBalanceMicro: BigInt(5_000_000),
            tier: 'pro',
        });
    });

    describe('Pure Micro-Credit Reservation Derivation (@/lib/metering/derivation)', () => {
        it('converts token counts and creditsPer1k rates into exact integer Micro-Credits', () => {
            expect(tokensToMicroCredits(0, 0.6)).toBe(BigInt(0));
            expect(tokensToMicroCredits(-50, 0.6)).toBe(BigInt(0));
            expect(tokensToMicroCredits(1000, 0.15)).toBe(BigInt(150_000));
            expect(tokensToMicroCredits(1200, 0.6)).toBe(BigInt(720_000));
        });

        it('derives SINGLE_PASS_DECISION reservation with zero output micro-credits', () => {
            const derived = deriveModelReservationParameters(
                'openai/gpt-6-luna-decisions',
                500,
                BigInt(1_000_000)
            );

            expect(derived.executionMode).toBe('SINGLE_PASS_DECISION');
            expect(derived.requiredInputMicro).toBe(BigInt(100_000));
            expect(derived.desiredOutputMicro).toBe(BigInt(0));
            expect(derived.allocatedOutputTokens).toBe(0);
            expect(derived.totalReservedMicro).toBe(BigInt(100_000));
            expect(derived.canAfford).toBe(true);
        });

        it('derives DISCRETE_THINKING reservation with bounded discrete output ceiling', () => {
            const derived = deriveModelReservationParameters(
                'fastino/glide',
                1000,
                BigInt(2_000_000),
                1000
            );

            expect(derived.executionMode).toBe('DISCRETE_THINKING');
            expect(derived.requiredInputMicro).toBe(BigInt(250_000));
            expect(derived.desiredOutputMicro).toBe(BigInt(800_000));
            expect(derived.totalReservedMicro).toBe(BigInt(1_050_000));
            expect(derived.canAfford).toBe(true);
        });

        it('derives STREAMING_GENERATIVE reservation and enforces Zero-Dust Drain when capacity < L_min', () => {
            const model = getModelRegistryEntry('google/gemini-3.8-flash');
            // 1000 input tokens @ 0.15 = 150,000 micro. Remaining = 60,000 micro = 100 output tokens (< L_min = 250)
            const zeroDust = deriveStreamingGenerativeReservation(
                1000,
                model,
                BigInt(210_000)
            );

            expect(zeroDust.executionMode).toBe('STREAMING_GENERATIVE');
            expect(zeroDust.isZeroDustAllowed).toBe(true);
            expect(zeroDust.allocatedOutputTokens).toBe(100);
            expect(zeroDust.totalReservedMicro).toBe(BigInt(210_000));
            expect(zeroDust.canAfford).toBe(true);

            // Insufficient balance even for input tokens
            const unaffordable = deriveStreamingGenerativeReservation(
                1000,
                model,
                BigInt(100_000)
            );
            expect(unaffordable.canAfford).toBe(false);
            expect(unaffordable.allocatedOutputTokens).toBe(0);
        });
    });

    describe('StreamGovernor Lease Initialization & Idempotent Settlement State Machine (SRS-04)', () => {
        it('initializes lease in Redis, settles idempotently with surplus refund, and rejects post-settle lease init', async () => {
            const redis = new InMemoryMeteringRedis();
            redis.wallets.set(REDIS_KEYS.wallet('user-101'), 5_000_000);

            const abortController = new AbortController();
            const governor = new StreamGovernor(
                'user-101',
                'op-lifecycle-1',
                'google/gemini-3.8-flash',
                0,
                abortController,
                { customRedis: redis, inputTokens: 100 }
            );

            const lease = await governor.initializeLease(100);
            expect(lease.canAfford).toBe(true);
            expect(lease.reservedTokens).toBe(1200);
            expect(governor.getTotalReservedTokens()).toBe(1200);
            expect(redis.wallets.get(REDIS_KEYS.wallet('user-101'))).toBe(
                5_000_000 - Number(lease.reservedMicro)
            );

            await governor.onTokenChunk(150);

            const settle1 = await governor.settle('SETTLED');
            const settle2 = await governor.settle('SETTLED');
            expect(settle1).toBe(settle2);
            expect(settle1.status).toBe('SETTLED');
            expect(settle1.refundMicro).toBeGreaterThan(0);
            expect(settle1.actualCostMicro + settle1.refundMicro).toBe(Number(lease.reservedMicro));
            expect(governor.isSettled()).toBe(true);

            const pending = redis.pendingSettlements.get(REDIS_KEYS.pendingSettlements('user-101'));
            expect(pending?.size).toBe(1);
            expect(pending?.has('op-lifecycle-1')).toBe(true);

            // Post-settlement initializeLease is rejected
            const postSettleLease = await governor.initializeLease(100);
            expect(postSettleLease).toEqual({
                canAfford: false,
                reservedTokens: 0,
                reservedMicro: BigInt(0),
            });
        });

        it('computes deterministic request hashes and reads user credit balance safely', async () => {
            const h1 = computeRequestHash('user-101', 'agent_stream', 'file-1', 'hello');
            const h2 = computeRequestHash('user-101', 'agent_stream', 'file-1', 'hello');
            expect(h1).toBe(h2);
            expect(h1).toHaveLength(64);

            const missingBalance = await getUserCreditBalance('user-missing');
            expect(missingBalance).toBe(BigInt(0));
        });
    });
});
