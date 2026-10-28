/**
 * System-level financial metering and Redis infrastructure constants for Elixent.
 * Denominated in Micro-Credits (1 Credit = 1,000,000 Micro-Credits).
 */

/** Number of micro-credits per 1 display credit (10^6). */
export const MICRO_PER_CREDIT = BigInt(1_000_000);

/** Safety runway window in seconds to absorb network latency before slice exhaustion. */
export const T_RUNWAY_SECONDS = 3;

/** Safety runway window in milliseconds (3,000 ms). */
export const T_RUNWAY_MS = 3_000;

/** Target operational chunk duration in seconds. */
export const T_CHUNK_SECONDS = 10;

/** Standard algebraic minimum chunk floor in tokens. */
export const L_MIN_TOKENS = 500;

/** Pessimistic thinking ceiling for discrete/non-streaming steps in tokens. */
export const B_DISCRETE_DEFAULT_TOKENS = 1500;

/** Multiplier for server-side pessimistic token estimation (+15% safety margin). */
export const PESSIMISTIC_TOKEN_MARGIN = 1.15;

/** Maximum duration in milliseconds to hold local stream output while waiting for Redis extension. */
export const LOCAL_HOLD_TIMEOUT_MS = 500;

/** TTL in seconds for active streaming leases (120s). */
export const LEASE_TTL_SECONDS = 120;

/** TTL in seconds for user balance cache in Redis (24 hours = 86,400s). */
export const WALLET_TTL_SECONDS = 86400;

/** TTL in seconds for LangGraph completed step idempotency receipts (1 hour = 3,600s). */
export const STEP_DONE_TTL_SECONDS = 3600;

/** Maximum grace period in milliseconds for pending settlement records before background sweep. */
export const DIRTY_SETTLEMENT_GRACE_MS = 30_000;

/**
 * Canonical Redis key builder functions.
 */
export const REDIS_KEYS = {
  wallet: (userId: string) => `lugx:wallet:${userId}`,
  lease: (operationId: string) => `lugx:lease:${operationId}`,
  stepDone: (stepKey: string) => `lugx:step_done:${stepKey}`,
  pendingSettlements: (userId: string) => `lugx:pending_settlements:${userId}`,
  dirtyWallets: () => `lugx:dirty_wallets`,
} as const;
