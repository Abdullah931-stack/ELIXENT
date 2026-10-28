import {
  L_MIN_TOKENS,
  LEASE_TTL_SECONDS,
  LOCAL_HOLD_TIMEOUT_MS,
  T_CHUNK_SECONDS,
  T_RUNWAY_SECONDS,
} from "./constants";
import {
  getModelRegistryEntry,
  tokensToMicroCredits,
  type ModelRegistryEntry,
} from "./derivation";
import {
  executeReserveOrExtend,
  executeSettleOperation,
  type RedisEvalClient,
  type SettleOperationResult,
} from "./lua-scripts";
import { countRawTokens } from "./tokenizer";

export interface StreamGovernorOptions {
  customRedis?: RedisEvalClient;
  threadId?: string;
  nodeName?: string;
  stepKey?: string;
  inputTokens?: number;
  inputCostMicro?: bigint | number;
}

/**
 * Real-time streaming credit governor for extended generative AI generation.
 * Enforces dynamic multi-slice reservation, proactive runway renewal,
 * 500ms local hold gate upon slice exhaustion, and hard abort termination.
 */
export class StreamGovernor {
  private readonly userId: string;
  private readonly operationId: string;
  private readonly modelId: string;
  private readonly abortController: AbortController;
  private readonly options: StreamGovernorOptions;
  private readonly modelEntry: ModelRegistryEntry;

  private readonly velocity: number;
  private readonly triggerRemainingTokens: number;
  private readonly extensionChunkTokens: number;
  private readonly stepKey: string;

  private totalTokensProduced: number = 0;
  private totalTokensReserved: number;
  private coveredTokens: number;

  private isAbortedFlag: boolean = false;
  private isInHoldFlag: boolean = false;
  private inFlightExtensionPromise: Promise<boolean> | null = null;
  private settleResult: SettleOperationResult | null = null;

  constructor(
    userId: string,
    operationId: string,
    modelId: string,
    initialReservationTokens: number,
    abortController: AbortController,
    options?: StreamGovernorOptions
  ) {
    this.userId = userId;
    this.operationId = operationId;
    this.modelId = modelId;
    this.abortController = abortController;
    this.options = options ?? {};
    this.stepKey = this.options.stepKey ?? operationId;

    this.modelEntry = getModelRegistryEntry(modelId);
    this.velocity = Math.max(0, this.modelEntry.V);
    this.triggerRemainingTokens = Math.ceil(this.velocity * T_RUNWAY_SECONDS);
    this.extensionChunkTokens = Math.max(
      L_MIN_TOKENS,
      Math.ceil(this.velocity * T_CHUNK_SECONDS)
    );

    const safeInitialTokens = Math.max(
      0,
      isNaN(initialReservationTokens) ? 0 : Math.floor(initialReservationTokens)
    );
    this.totalTokensReserved = safeInitialTokens;
    this.coveredTokens = safeInitialTokens;

    if (this.abortController.signal.aborted) {
      this.isAbortedFlag = true;
    } else {
      this.abortController.signal.addEventListener(
        "abort",
        () => {
          this.isAbortedFlag = true;
        },
        { once: true }
      );
    }
  }

  /**
   * Triggers an asynchronous, non-blocking extension request via executeReserveOrExtend.
   * Dedupes in-flight requests and safely expands reservation leases.
   */
  private triggerExtension(): Promise<boolean> {
    if (this.inFlightExtensionPromise) {
      return this.inFlightExtensionPromise;
    }
    if (this.isAborted() || this.settleResult !== null) {
      return Promise.resolve(false);
    }

    if (this.modelEntry.creditsPer1kOutput <= 0) {
      this.totalTokensReserved += this.extensionChunkTokens;
      this.coveredTokens += this.extensionChunkTokens;
      return Promise.resolve(true);
    }

    const promise = (async (): Promise<boolean> => {
      try {
        const desiredOutputMicro = tokensToMicroCredits(
          this.extensionChunkTokens,
          this.modelEntry.creditsPer1kOutput
        );
        const minAllowedOutputMicro = tokensToMicroCredits(
          1,
          this.modelEntry.creditsPer1kOutput
        );

        const res = await executeReserveOrExtend(
          {
            userId: this.userId,
            operationId: this.operationId,
            stepKey: this.stepKey,
            requiredInputMicro: 0,
            desiredOutputMicro,
            minAllowedOutputMicro,
            isZeroDustAllowed: true,
            leaseTtlSeconds: LEASE_TTL_SECONDS,
          },
          this.options.customRedis
        );

        if (res.status === "SUCCESS") {
          const microPerToken = this.modelEntry.creditsPer1kOutput * 1000;
          let grantedTokens = 0;

          if (res.reservedOutputMicro >= desiredOutputMicro) {
            grantedTokens = this.extensionChunkTokens;
          } else if (microPerToken > 0) {
            grantedTokens = Math.floor(res.reservedOutputMicro / microPerToken);
          }

          if (grantedTokens > 0) {
            this.totalTokensReserved += grantedTokens;
            this.coveredTokens += grantedTokens;
            return true;
          }
          return false;
        }

        return false;
      } catch {
        return false;
      } finally {
        this.inFlightExtensionPromise = null;
      }
    })();

    this.inFlightExtensionPromise = promise;
    return promise;
  }

  /**
   * Processes an incoming streaming token chunk.
   * Returns true if chunk is financially permitted, false if blocked/aborted.
   */
  async onTokenChunk(chunkText: string | number): Promise<boolean> {
    if (this.isAborted() || this.settleResult !== null) {
      return false;
    }

    const chunkTokens =
      typeof chunkText === "number"
        ? Math.max(0, isNaN(chunkText) ? 0 : Math.floor(chunkText))
        : countRawTokens(chunkText);

    this.totalTokensProduced += chunkTokens;

    if (this.modelEntry.creditsPer1kOutput <= 0) {
      this.totalTokensReserved = Math.max(
        this.totalTokensReserved,
        this.totalTokensProduced
      );
      this.coveredTokens = Math.max(
        this.coveredTokens,
        this.totalTokensProduced
      );
      return true;
    }

    // Check runway condition: trigger async non-blocking extension if remaining <= trigger
    const remainingTokens = this.totalTokensReserved - this.totalTokensProduced;
    if (
      remainingTokens <= this.triggerRemainingTokens &&
      !this.inFlightExtensionPromise &&
      !this.isAborted()
    ) {
      this.triggerExtension();
    }

    // Check slice exhaustion: consumed tokens exceed confirmed reservation
    if (this.totalTokensProduced > this.totalTokensReserved) {
      if (!this.inFlightExtensionPromise && !this.isAborted()) {
        this.triggerExtension();
      }

      this.isInHoldFlag = true;
      let timeoutId: NodeJS.Timeout | null = null;

      try {
        const timeoutPromise = new Promise<boolean>((resolve) => {
          timeoutId = setTimeout(() => resolve(false), LOCAL_HOLD_TIMEOUT_MS);
        });

        const abortPromise = new Promise<boolean>((resolve) => {
          if (this.abortController.signal.aborted) {
            resolve(false);
          } else {
            this.abortController.signal.addEventListener(
              "abort",
              () => resolve(false),
              { once: true }
            );
          }
        });

        const extensionPromise =
          this.inFlightExtensionPromise ?? Promise.resolve(false);

        const success = await Promise.race([
          extensionPromise,
          timeoutPromise,
          abortPromise,
        ]);

        if (
          success &&
          this.totalTokensProduced <= this.totalTokensReserved &&
          !this.isAborted()
        ) {
          return true;
        }
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        this.isInHoldFlag = false;
      }

      // If 500ms expires OR extension fails / returns INSUFFICIENT_CREDITS
      this.abort("SLICE_EXHAUSTED");
      try {
        await this.settle("ABORTED");
      } catch {
        // Enforce fail-closed stream termination
      }
      return false;
    }

    return true;
  }

  /**
   * Aborts the active generation stream and marks state as aborted.
   */
  public abort(reason?: string): void {
    this.isAbortedFlag = true;
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(reason);
    }
  }

  /**
   * Computes final cost for actually consumed tokens up to coveredTokens,
   * releases unused reserved credit surplus back to Redis, and registers pending settlement.
   */
  async settle(
    status: "SETTLED" | "ABORTED" = "SETTLED"
  ): Promise<SettleOperationResult> {
    if (this.settleResult) {
      return this.settleResult;
    }

    const finalStatus: "SETTLED" | "ABORTED" =
      this.isAborted() || status === "ABORTED" ? "ABORTED" : "SETTLED";

    // Await in-flight extension only for clean settlement, never block an aborted stream
    if (finalStatus === "SETTLED" && this.inFlightExtensionPromise) {
      try {
        await this.inFlightExtensionPromise;
      } catch {
        // Ignore extension failure during settlement
      }
    }

    const consumedOutputTokens = Math.min(
      this.totalTokensProduced,
      this.coveredTokens
    );

    const outputCostMicro = tokensToMicroCredits(
      consumedOutputTokens,
      this.modelEntry.creditsPer1kOutput
    );

    const inputCostMicro =
      this.options.inputCostMicro !== undefined
        ? BigInt(this.options.inputCostMicro)
        : tokensToMicroCredits(
            this.options.inputTokens ?? 0,
            this.modelEntry.creditsPer1kInput
          );

    const actualTotalCostMicro = inputCostMicro + outputCostMicro;

    const settlementPayload = {
      operationId: this.operationId,
      userId: this.userId,
      threadId: this.options.threadId ?? null,
      nodeName: this.options.nodeName ?? null,
      stepKey: this.stepKey,
      modelId: this.modelId,
      executionMode: this.modelEntry.executionMode,
      inputTokens: this.options.inputTokens ?? 0,
      cachedInputTokens: 0,
      outputTokens: consumedOutputTokens,
      reasoningTokens: 0,
      deltaMicro: -Number(actualTotalCostMicro),
      actualTotalCostMicro: Number(actualTotalCostMicro),
      status: finalStatus,
      created_at_ms: Date.now(),
    };

    const result = await executeSettleOperation(
      {
        userId: this.userId,
        operationId: this.operationId,
        stepKey: this.stepKey,
        actualTotalCostMicro,
        settlementPayload,
      },
      this.options.customRedis
    );

    this.settleResult = result;
    return result;
  }

  /**
   * Returns the highest token count financially covered by confirmed reservations.
   */
  getCoveredTokens(): number {
    return this.coveredTokens;
  }

  /**
   * Returns the cumulative total tokens produced across all chunks.
   */
  getTotalProducedTokens(): number {
    return this.totalTokensProduced;
  }

  /**
   * Returns the total output tokens confirmed and reserved in Redis.
   */
  getTotalReservedTokens(): number {
    return this.totalTokensReserved;
  }

  /**
   * Returns whether the stream governor or underlying AbortController is aborted.
   */
  isAborted(): boolean {
    return this.isAbortedFlag || this.abortController.signal.aborted;
  }

  /**
   * Returns whether the governor is currently holding chunk delivery pending Redis extension.
   */
  isInHold(): boolean {
    return this.isInHoldFlag;
  }

  /**
   * Returns whether the operation has already been settled.
   */
  isSettled(): boolean {
    return this.settleResult !== null;
  }
}
