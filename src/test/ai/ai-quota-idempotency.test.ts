import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    tokensToMicroCredits,
    getModelRegistryEntry,
    deriveStreamingGenerativeReservation,
    deriveModelReservationParameters,
} from '@/lib/metering/derivation';
import {
    reserveAIQuota,
    commitAIReservation,
    refundAIReservation,
    getAIReservationStatus,
} from '@/server/services/ai-settlement-service';

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

    describe('Idempotent Reservation, Commit & Refund Lifecycle (@/server/services/ai-settlement-service)', () => {
        it('transitions from reserved to committed and handles idempotent commit replay', async () => {
            const opId = 'op-lifecycle-1';

            mockFindFirst.mockImplementation(
                async () => ledgerStore.get(opId)
            );

            const reserveRes = await reserveAIQuota('user-101', 'agent_stream', 200, 'pro', {
                operationId: opId,
                requestHash: 'hash-lifecycle-1',
            });
            expect(reserveRes.reserved).toBe(true);

            const statusReserved = await getAIReservationStatus(opId, 'user-101');
            expect(statusReserved.found).toBe(true);
            if (statusReserved.found) {
                expect(statusReserved.status).toBe('reserved');
                expect(statusReserved.reservedUnits).toBe(200);
            }

            const commitRes = await commitAIReservation(opId, 150);
            expect(commitRes.committed).toBe(true);

            // Idempotent commit replay returns already_committed
            const replayCommit = await commitAIReservation(opId, 150);
            expect(replayCommit.committed).toBe(true);
            expect(replayCommit.reason).toBe('already_committed');

            // Conflicting refund after commit is rejected
            const illegalRefund = await refundAIReservation(opId);
            expect(illegalRefund.refunded).toBe(false);
            expect(illegalRefund.reason).toBe('already_committed');
        });

        it('transitions from reserved to refunded and rejects subsequent commit or duplicate refund', async () => {
            const opId = 'op-lifecycle-2';

            mockFindFirst.mockImplementation(
                async () => ledgerStore.get(opId)
            );

            const reserveRes = await reserveAIQuota('user-101', 'agent_stream', 180, 'pro', {
                operationId: opId,
                requestHash: 'hash-lifecycle-2',
            });
            expect(reserveRes.reserved).toBe(true);

            const refundRes = await refundAIReservation(opId, 'user_cancelled');
            expect(refundRes.refunded).toBe(true);

            // Second refund returns already_refunded without double-crediting
            const replayRefund = await refundAIReservation(opId, 'user_cancelled');
            expect(replayRefund.refunded).toBe(false);
            expect(replayRefund.reason).toBe('already_refunded');

            // Commit after refund is rejected
            const illegalCommit = await commitAIReservation(opId);
            expect(illegalCommit.committed).toBe(false);
            expect(illegalCommit.reason).toBe('already_refunded');
        });
    });
});
