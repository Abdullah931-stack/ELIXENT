/**
 * Universal Prior Calibration Store for Adaptive Prediction Sets (Conformal APS)
 *
 * Implements an in-memory sliding window (capacity N = 200) per decision model with
 * optional non-blocking Upstash Redis persistence (`gemini:calibration_window:<modelId>`).
 *
 * Empirical Quantile Computation:
 * - When window size n >= 20: Computes empirical quantile at rank k = min(n, ceil((n + 1)(1 - alpha)))
 *   - Core alpha = 0.05 (coverage 0.95): rank kCore = min(n, ceil((n + 1) * 0.95))
 *   - Peripheral alpha = 0.20 (coverage 0.80): rank kPeriph = min(n, ceil((n + 1) * 0.80))
 * - When window size n < 20 or model uninitialized: Falls back to static bootstrap priors
 *   registered in `src/config/models.config.json`.
 */

import modelsConfig from "@/config/models.config.json";
import { isRedisConfigured, redis } from "@/lib/redis";

export interface CalibrationPriors {
  qHatCore05: number;
  qHatPeriph20: number;
}

export const CALIBRATION_WINDOW_CAPACITY = 200;
export const MIN_EMPIRICAL_WINDOW_SIZE = 20;

export const DEFAULT_FALLBACK_PRIORS: CalibrationPriors = {
  qHatCore05: 0.22,
  qHatPeriph20: 0.42,
};

/**
 * Retrieves static bootstrap calibration priors from models.config.json.
 */
export function getStaticPriors(modelId: string): CalibrationPriors {
  const models = modelsConfig.models as Record<
    string,
    { calibrationPriors?: CalibrationPriors | null } | undefined
  >;
  const modelEntry = models[modelId];

  if (modelEntry?.calibrationPriors) {
    return {
      qHatCore05: modelEntry.calibrationPriors.qHatCore05,
      qHatPeriph20: modelEntry.calibrationPriors.qHatPeriph20,
    };
  }

  return { ...DEFAULT_FALLBACK_PRIORS };
}

/**
 * CalibrationStore maintains the empirical nonconformity score window per model.
 */
export class CalibrationStore {
  private inMemoryWindows: Map<string, number[]> = new Map();
  private capacity: number;
  private minWindowSize: number;

  constructor(
    capacity = CALIBRATION_WINDOW_CAPACITY,
    minWindowSize = MIN_EMPIRICAL_WINDOW_SIZE
  ) {
    this.capacity = capacity;
    this.minWindowSize = minWindowSize;
  }

  private getRedisKey(modelId: string): string {
    return `gemini:calibration_window:${modelId}`;
  }

  /**
   * Records a user-feedback nonconformity score for a specific model into its sliding window.
   * Updates in-memory window immediately and attempts non-blocking Redis sync.
   */
  async recordFeedbackScore(
    modelId: string,
    nonconformityScore: number
  ): Promise<void> {
    if (typeof nonconformityScore !== "number" || Number.isNaN(nonconformityScore)) {
      return;
    }

    // Clamp score to [0, 1]
    const clampedScore = Math.max(0, Math.min(1, nonconformityScore));

    // Update in-memory sliding window
    let window = this.inMemoryWindows.get(modelId);
    if (!window) {
      window = [];
      this.inMemoryWindows.set(modelId, window);
    }
    window.push(clampedScore);
    if (window.length > this.capacity) {
      window.splice(0, window.length - this.capacity);
    }

    // Optional non-blocking Redis sync
    if (isRedisConfigured()) {
      try {
        const key = this.getRedisKey(modelId);
        await redis.rpush(key, clampedScore);
        await redis.ltrim(key, -this.capacity, -1);
      } catch {
        // Non-blocking fallback: ignore Redis failures and preserve in-memory window
      }
    }
  }

  /**
   * Retrieves the conformal quantile priors (qHatCore05, qHatPeriph20) for the given model.
   * If window size n >= 20, computes empirical quantiles.
   * Otherwise, falls back to static priors from models.config.json.
   */
  async getQuantilePriors(modelId: string): Promise<CalibrationPriors> {
    let window = this.inMemoryWindows.get(modelId);

    // If in-memory window is smaller than minWindowSize, attempt remote fetch if Redis is configured
    if ((!window || window.length < this.minWindowSize) && isRedisConfigured()) {
      try {
        const key = this.getRedisKey(modelId);
        const remoteScores = await redis.lrange<number | string>(key, 0, -1);
        if (remoteScores && Array.isArray(remoteScores) && remoteScores.length > 0) {
          const parsed = remoteScores
            .map((s) => (typeof s === "number" ? s : parseFloat(s)))
            .filter((n) => typeof n === "number" && !Number.isNaN(n));
          if (parsed.length > 0) {
            window = parsed.slice(-this.capacity);
            this.inMemoryWindows.set(modelId, window);
          }
        }
      } catch {
        // Redis read failure fallback: proceed with in-memory window
      }
    }

    const n = window ? window.length : 0;
    if (n >= this.minWindowSize && window) {
      // Sort scores ascending: s_(1) <= s_(2) <= ... <= s_(n)
      const sorted = [...window].sort((a, b) => a - b);

      // Rank k = min(n, ceil((n + 1)(1 - alpha)))
      // alpha_core = 0.05 => 1 - alpha = 0.95
      const kCore = Math.max(1, Math.min(n, Math.ceil((n + 1) * 0.95)));
      const qHatCore05 = sorted[kCore - 1];

      // alpha_periph = 0.20 => 1 - alpha = 0.80
      const kPeriph = Math.max(1, Math.min(n, Math.ceil((n + 1) * 0.80)));
      const qHatPeriph20 = sorted[kPeriph - 1];

      return {
        qHatCore05,
        qHatPeriph20,
      };
    }

    // Fall back to static priors from registry
    return getStaticPriors(modelId);
  }

  /**
   * Resets the sliding window for a specific model or all models.
   */
  resetWindow(modelId?: string): void {
    if (modelId) {
      this.inMemoryWindows.delete(modelId);
      if (isRedisConfigured()) {
        const key = this.getRedisKey(modelId);
        redis.del(key).catch(() => {});
      }
    } else {
      this.inMemoryWindows.clear();
    }
  }

  /**
   * Helper to inspect the current in-memory window size (useful for tests and telemetry).
   */
  getWindowSize(modelId: string): number {
    return this.inMemoryWindows.get(modelId)?.length ?? 0;
  }
}

export const calibrationStore = new CalibrationStore();
export default calibrationStore;
