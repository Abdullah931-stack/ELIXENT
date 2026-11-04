# AI Models Configuration Guide (`models.config.json`)

This guide explains how to configure, calibrate, and update AI models in the Elixent platform without modifying core orchestration or billing code.

## File Location

```text
src/config/models.config.json
```

---

## 1. Lean Dynamic Model Registry Architecture

In Phase 12 (`v0.12.0`), the legacy 5-operation configuration (`correct`, `improve`, `summarize`, `toPrompt`, `translate`) was permanently purged. All AI models are governed by a unified **Lean Dynamic Model Registry** under the root `models` key, indexed by canonical `modelId`.

Each model entry defines:
- **`executionMode`**: The execution pipeline that invokes this model (`DECISION_GATEWAY`, `INTENT_CLASSIFICATION`, `CLARIFICATION_GATE`, `DEEP_PLANNING`, `DIRECT_EXECUTION`, `PLANNED_EXECUTION`, `HITL_REFINEMENT`, or `RETRIEVAL_SWEEP`).
- **`V`**: Credit multiplier factor used by the Micro-Credits dynamic pricing engine (`1 Credit = 1,000,000 micro-credits`).
- **`creditsPer1kInput`**: Micro-credit rate per 1,000 input tokens.
- **`creditsPer1kCacheRead`**: Micro-credit rate per 1,000 cached input tokens read (`10%` of `creditsPer1kInput` for Gemini implicit caching).
- **`creditsPer1kOutput`**: Micro-credit rate per 1,000 generated output tokens.
- **`calibrationPriors`**: Default statistical priors (`alphaMean`, `alphaM2`, `betaMean`, `betaM2`, `sampleCount`) used by Welford's online algorithm in `src/lib/metering/cost-estimator.ts` before per-model Redis telemetry accumulates.

---

## 2. Authoritative Configuration Schema (`src/config/models.config.json`)

```json
{
  "models": {
    "openai/gpt-6-luna-decisions": {
      "executionMode": "DECISION_GATEWAY",
      "V": 0.01,
      "creditsPer1kInput": 10000,
      "creditsPer1kCacheRead": 1000,
      "creditsPer1kOutput": 10000,
      "calibrationPriors": {
        "alphaMean": 0.05,
        "alphaM2": 0.001,
        "betaMean": 50,
        "betaM2": 100,
        "sampleCount": 10
      }
    },
    "microsoft/decision-1": {
      "executionMode": "DECISION_GATEWAY",
      "V": 0.01,
      "creditsPer1kInput": 10000,
      "creditsPer1kCacheRead": 1000,
      "creditsPer1kOutput": 10000,
      "calibrationPriors": {
        "alphaMean": 0.05,
        "alphaM2": 0.001,
        "betaMean": 50,
        "betaM2": 100,
        "sampleCount": 10
      }
    },
    "typesafe/jev-1.13": {
      "executionMode": "INTENT_CLASSIFICATION",
      "V": 0.02,
      "creditsPer1kInput": 20000,
      "creditsPer1kCacheRead": 2000,
      "creditsPer1kOutput": 20000,
      "calibrationPriors": {
        "alphaMean": 0.1,
        "alphaM2": 0.005,
        "betaMean": 100,
        "betaM2": 400,
        "sampleCount": 10
      }
    },
    "fastino/glide": {
      "executionMode": "CLARIFICATION_GATE",
      "V": 0.02,
      "creditsPer1kInput": 20000,
      "creditsPer1kCacheRead": 2000,
      "creditsPer1kOutput": 20000,
      "calibrationPriors": {
        "alphaMean": 0.15,
        "alphaM2": 0.01,
        "betaMean": 150,
        "betaM2": 900,
        "sampleCount": 10
      }
    },
    "google/gemini-4-argon": {
      "executionMode": "DEEP_PLANNING",
      "V": 0.25,
      "creditsPer1kInput": 250000,
      "creditsPer1kCacheRead": 25000,
      "creditsPer1kOutput": 250000,
      "calibrationPriors": {
        "alphaMean": 0.5,
        "alphaM2": 0.05,
        "betaMean": 400,
        "betaM2": 2500,
        "sampleCount": 10
      }
    },
    "google/gemini-3.8-flash": {
      "executionMode": "DIRECT_EXECUTION",
      "V": 0.15,
      "creditsPer1kInput": 150000,
      "creditsPer1kCacheRead": 15000,
      "creditsPer1kOutput": 150000,
      "calibrationPriors": {
        "alphaMean": 1.0,
        "alphaM2": 0.1,
        "betaMean": 200,
        "betaM2": 1600,
        "sampleCount": 10
      }
    },
    "google/gemini-3.1-pro": {
      "executionMode": "PLANNED_EXECUTION",
      "V": 0.85,
      "creditsPer1kInput": 850000,
      "creditsPer1kCacheRead": 85000,
      "creditsPer1kOutput": 850000,
      "calibrationPriors": {
        "alphaMean": 1.2,
        "alphaM2": 0.15,
        "betaMean": 500,
        "betaM2": 3600,
        "sampleCount": 10
      }
    }
  }
}
```

---

## 3. Model Roles in the Elixent Agentic Pipeline

| Model ID | Pipeline Stage / Node | Execution Mode | Credit Multiplier (`V`) | Primary Responsibility |
| :--- | :--- | :--- | :---: | :--- |
| `openai/gpt-6-luna-decisions` | `nodeDecisionGateway` (Primary) | `DECISION_GATEWAY` | `0.01` | Evaluates whether incoming user prompt is clear (`CLEAR`) or requires HITL clarification (`AMBIGUOUS`). |
| `microsoft/decision-1` | `nodeDecisionGateway` (Fallback) | `DECISION_GATEWAY` | `0.01` | Automatic fallback classifier if `openai/gpt-6-luna-decisions` is unavailable. |
| `typesafe/jev-1.13` | `nodeIntentResolver` | `INTENT_CLASSIFICATION` | `0.02` | Classifies prompt into `DIRECT_ACTION`, `COMPLEX_PLANNING`, or `CONVERSATIONAL_QA` and determines `requiresFullDocSweep`. |
| `fastino/glide` | `nodeClarificationGate` | `CLARIFICATION_GATE` | `0.02` | Generates structured HITL clarifying questions (`hitlQuestionPayloadSchema`) before suspending the LangGraph thread. |
| `google/gemini-4-argon` | `nodeDeepPlanner` | `DEEP_PLANNING` | `0.25` | Synthesizes structured execution blueprints (`executionBlueprintSchema`) for complex multi-step edits. |
| `google/gemini-3.8-flash` | `nodeExecutor` (Fast Path) & `extractRelevantExcerpts` | `DIRECT_EXECUTION` | `0.15` | Executes single-step `DIRECT_ACTION` edits, `CONVERSATIONAL_QA`, and parallel chunk sweep extraction. |
| `google/gemini-3.1-pro` | `nodeExecutor` (Planned Path) | `PLANNED_EXECUTION` | `0.85` | Executes multi-step `COMPLEX_PLANNING` blueprints using `propose_document_replacements` and `answer_directly` tools. |

---

## 4. Vercel AI SDK v7 Gateway Integration (`src/lib/ai/client.ts`)

All Gemini and gateway model invocations execute through `src/lib/ai/client.ts`, which integrates `@ai-sdk/google` and `ai` (Vercel AI SDK v7) with the Redis-backed API key rotation pool (`src/lib/ai/key-rotation.ts`) and distributed circuit breaker:

- **`getGoogleModel(modelId, apiKey)`**: Normalizes provider prefixes (e.g., stripping `google/` for `@ai-sdk/google` instantiation) and binds the rotated API key.
- **`executeStructuredGeneration<T>(options)`**: Executes `generateObject` with a Zod schema, automatic key rotation on HTTP 429/401, and distributed circuit breaker protection.
- **`executeToolAgentGeneration(options)`**: Executes `generateText` with tool definitions (`propose_document_replacements`, `answer_directly`), extracting tool calls and exact `AgentTokenUsage` (`inputTokens`, `cachedInputTokens`, `outputTokens`).
- **`executeStreamingGeneration(options)`**: Executes `streamText` with `AbortSignal` propagation and key rotation resilience.

---

## 5. How to Add or Update a Model

1. **Add or update the entry in `src/config/models.config.json`** under `"models"`:
   - Ensure `creditsPer1kInput`, `creditsPer1kCacheRead`, and `creditsPer1kOutput` are integer micro-credit amounts (`1 Credit = 1,000,000 micro-credits`).
   - Provide positive `calibrationPriors` (`sampleCount >= 1`).
2. **Verify against the Cost Estimator & Schema Tests**:
   ```bash
   npx vitest run src/test/metering/cost-estimator.unit.test.ts src/test/ai/ai-client.test.ts
   ```
