import modelsConfig from "@/config/models.config.json";
import {
  B_DISCRETE_DEFAULT_TOKENS,
  L_MIN_TOKENS,
  T_CHUNK_SECONDS,
  T_RUNWAY_SECONDS,
} from "./constants";

export type ModelExecutionMode =
  | "SINGLE_PASS_DECISION"
  | "DISCRETE_THINKING"
  | "STREAMING_GENERATIVE";

export interface CalibrationPriors {
  qHatCore05: number;
  qHatPeriph20: number;
}

export interface ModelRegistryEntry {
  modelId: string;
  executionMode: ModelExecutionMode;
  V: number;
  creditsPer1kInput: number;
  creditsPer1kCacheRead: number;
  creditsPer1kOutput: number;
  calibrationPriors: CalibrationPriors | null;
}

export interface DerivedReservationParams {
  modelId: string;
  executionMode: ModelExecutionMode;
  requiredInputMicro: bigint;
  desiredOutputMicro: bigint;
  minAllowedOutputMicro: bigint;
  isZeroDustAllowed: boolean;
  allocatedOutputTokens: number;
  triggerRemainingTokens: number;
  totalReservedMicro: bigint;
  canAfford: boolean;
}

interface ModelsRegistryContainer {
  models?: Record<string, ModelRegistryEntry>;
  [key: string]: unknown;
}

/**
 * Retrieves the model registry configuration entry for a given model identifier.
 * Throws an error if the model is not registered.
 */
export function getModelRegistryEntry(modelId: string): ModelRegistryEntry {
  const registry = (modelsConfig as unknown as ModelsRegistryContainer).models;
  const entry = registry?.[modelId];
  if (!entry) {
    throw new Error(
      `Model '${modelId}' not found in model registry (src/config/models.config.json).`
    );
  }
  return entry;
}

/**
 * Converts a token count and credits-per-1k rate into Micro-Credits (10^6 micro-credits per 1 credit).
 * Formula: ceil(tokens * creditsPer1k * 1000)
 */
export function tokensToMicroCredits(tokens: number, creditsPer1k: number): bigint {
  if (tokens <= 0 || creditsPer1k <= 0) return BigInt(0);
  return BigInt(Math.ceil(tokens * creditsPer1k * 1000));
}

/**
 * Derives reservation parameters for single-pass decision models.
 * Output rate is 0, output tokens = 0, trigger = 0.
 * Eliminates division by zero since creditsPer1kOutput is 0.
 */
export function deriveSinglePassReservation(
  pessimisticInputTokens: number,
  model: ModelRegistryEntry,
  availableBalanceMicro?: bigint
): DerivedReservationParams {
  const requiredInputMicro = tokensToMicroCredits(
    pessimisticInputTokens,
    model.creditsPer1kInput
  );
  const totalReservedMicro = requiredInputMicro;
  const canAfford =
    availableBalanceMicro !== undefined
      ? availableBalanceMicro >= totalReservedMicro
      : true;

  return {
    modelId: model.modelId,
    executionMode: "SINGLE_PASS_DECISION",
    requiredInputMicro,
    desiredOutputMicro: BigInt(0),
    minAllowedOutputMicro: BigInt(0),
    isZeroDustAllowed: false,
    allocatedOutputTokens: 0,
    triggerRemainingTokens: 0,
    totalReservedMicro,
    canAfford,
  };
}

/**
 * Derives reservation parameters for discrete thinking/closed-step models.
 * Output tokens capped at discreteCeilingTokens or B_DISCRETE_DEFAULT_TOKENS (1500).
 * Trigger = 0.
 */
export function deriveDiscreteThinkingReservation(
  pessimisticInputTokens: number,
  model: ModelRegistryEntry,
  discreteCeilingTokens?: number,
  availableBalanceMicro?: bigint
): DerivedReservationParams {
  const allocatedOutputTokens =
    discreteCeilingTokens ?? B_DISCRETE_DEFAULT_TOKENS;
  const requiredInputMicro = tokensToMicroCredits(
    pessimisticInputTokens,
    model.creditsPer1kInput
  );
  const desiredOutputMicro = tokensToMicroCredits(
    allocatedOutputTokens,
    model.creditsPer1kOutput
  );
  const minAllowedOutputMicro = desiredOutputMicro;
  const totalReservedMicro = requiredInputMicro + desiredOutputMicro;
  const canAfford =
    availableBalanceMicro !== undefined
      ? availableBalanceMicro >= totalReservedMicro
      : true;

  return {
    modelId: model.modelId,
    executionMode: "DISCRETE_THINKING",
    requiredInputMicro,
    desiredOutputMicro,
    minAllowedOutputMicro,
    isZeroDustAllowed: false,
    allocatedOutputTokens,
    triggerRemainingTokens: 0,
    totalReservedMicro,
    canAfford,
  };
}

/**
 * Derives dynamic reservation chunk parameters for generative streaming models,
 * enforcing the Zero-Dust Drain rule when user capacity is 0 < capacity < L_min.
 */
export function deriveStreamingGenerativeReservation(
  pessimisticInputTokens: number,
  model: ModelRegistryEntry,
  availableBalanceMicro: bigint
): DerivedReservationParams {
  const triggerRemainingTokens = Math.ceil(model.V * T_RUNWAY_SECONDS);
  const requiredInputMicro = tokensToMicroCredits(
    pessimisticInputTokens,
    model.creditsPer1kInput
  );
  const remainingAfterInputMicro = availableBalanceMicro - requiredInputMicro;

  if (remainingAfterInputMicro <= BigInt(0)) {
    return {
      modelId: model.modelId,
      executionMode: "STREAMING_GENERATIVE",
      requiredInputMicro,
      desiredOutputMicro: BigInt(0),
      minAllowedOutputMicro: BigInt(0),
      isZeroDustAllowed: false,
      allocatedOutputTokens: 0,
      triggerRemainingTokens,
      totalReservedMicro: requiredInputMicro,
      canAfford: false,
    };
  }

  const L_calc = Math.max(
    L_MIN_TOKENS,
    Math.ceil(model.V * T_CHUNK_SECONDS)
  );

  const microPerOutputToken = model.creditsPer1kOutput * 1000;
  const userAvailableTokensCapacity =
    microPerOutputToken > 0
      ? Math.floor(Number(remainingAfterInputMicro) / microPerOutputToken)
      : 0;

  if (userAvailableTokensCapacity <= 0) {
    return {
      modelId: model.modelId,
      executionMode: "STREAMING_GENERATIVE",
      requiredInputMicro,
      desiredOutputMicro: BigInt(0),
      minAllowedOutputMicro: BigInt(0),
      isZeroDustAllowed: false,
      allocatedOutputTokens: 0,
      triggerRemainingTokens,
      totalReservedMicro: requiredInputMicro,
      canAfford: false,
    };
  }

  if (userAvailableTokensCapacity < L_MIN_TOKENS) {
    // Zero-Dust Drain: Waive L_min floor constraint and drain to exactly 0 micro-credits
    const allocatedOutputTokens = userAvailableTokensCapacity;
    const desiredOutputMicro = remainingAfterInputMicro;
    const minAllowedOutputMicro = remainingAfterInputMicro;
    const isZeroDustAllowed = true;
    const totalReservedMicro = requiredInputMicro + desiredOutputMicro;

    return {
      modelId: model.modelId,
      executionMode: "STREAMING_GENERATIVE",
      requiredInputMicro,
      desiredOutputMicro,
      minAllowedOutputMicro,
      isZeroDustAllowed,
      allocatedOutputTokens,
      triggerRemainingTokens,
      totalReservedMicro,
      canAfford: true,
    };
  }

  const allocatedOutputTokens = Math.min(
    L_calc,
    userAvailableTokensCapacity
  );
  const desiredOutputMicro = tokensToMicroCredits(
    allocatedOutputTokens,
    model.creditsPer1kOutput
  );
  const minAllowedOutputMicro = tokensToMicroCredits(
    L_MIN_TOKENS,
    model.creditsPer1kOutput
  );
  const isZeroDustAllowed = false;
  const totalReservedMicro = requiredInputMicro + desiredOutputMicro;

  return {
    modelId: model.modelId,
    executionMode: "STREAMING_GENERATIVE",
    requiredInputMicro,
    desiredOutputMicro,
    minAllowedOutputMicro,
    isZeroDustAllowed,
    allocatedOutputTokens,
    triggerRemainingTokens,
    totalReservedMicro,
    canAfford: true,
  };
}

/**
 * Dispatches and derives reservation parameters for any supported execution mode.
 */
export function deriveModelReservationParameters(
  modelId: string,
  pessimisticInputTokens: number,
  availableBalanceMicro: bigint,
  discreteCeilingTokens?: number
): DerivedReservationParams {
  const model = getModelRegistryEntry(modelId);

  switch (model.executionMode) {
    case "SINGLE_PASS_DECISION": {
      return deriveSinglePassReservation(
        pessimisticInputTokens,
        model,
        availableBalanceMicro
      );
    }
    case "DISCRETE_THINKING": {
      return deriveDiscreteThinkingReservation(
        pessimisticInputTokens,
        model,
        discreteCeilingTokens,
        availableBalanceMicro
      );
    }
    case "STREAMING_GENERATIVE": {
      return deriveStreamingGenerativeReservation(
        pessimisticInputTokens,
        model,
        availableBalanceMicro
      );
    }
    default: {
      const exhaustiveCheck: never = model.executionMode;
      throw new Error(`Unsupported model execution mode: ${exhaustiveCheck}`);
    }
  }
}
