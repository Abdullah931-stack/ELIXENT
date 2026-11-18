# Software Requirements Specification (SRS-04): Multi-Provider AI Gateway Routing and Open-Ceiling Wallet-Bounded Credit Metering

| Standard Field              | Approved Value                                                                                                                                                                                                                                                                                                                 |
| :-------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Document ID**             | `ELIXENT-SRS-04-AI-GATEWAY-METERING-v1.1`                                                                                                                                                                                                                                                                                      |
| **Classification**          | `SOFTWARE REQUIREMENTS SPECIFICATION (SUBSYSTEM 4 OF 4)`                                                                                                                                                                                                                                                                       |
| **Governing ADRs**          | [`ADR-004`](../architecture/01_architecture_vision_and_adrs.md), [`ADR-007`](../architecture/adrs/adr_007_dual_plane_separation_and_als_request_context.md), [`ADR-009`](../architecture/adrs/adr_009_native_graph_orchestration_engine.md)                                                                                    |
| **Reference Baseline**      | `Elixent v0.22.0` (`Vite 6 SPA + TanStack Router + Hono RPC`)                                                                                                                                                                                                                                                                  |
| **Target Repository Scope** | `../../src/config/models.config.json`, `../../src/lib/ai/client.ts`, `../../src/lib/metering/constants.ts`, `../../src/lib/metering/derivation.ts`, `../../src/lib/metering/node-gate.ts`, `../../src/lib/metering/stream-governor.ts`, `../../src/server/routes/agent.routes.ts`, `../../src/components/agent/chat-panel.tsx` |
| **Status**                  | `APPROVED FOR IMPLEMENTATION (v1.1 Audited)`                                                                                                                                                                                                                                                                                   |

## 1. Purpose, Scope & Architectural Traceability

This Software Requirements Specification (**SRS-04**) defines the multi-provider model identifier routing contract (`google/`, `openai/`, `microsoft/`, `typesafe/`, `fastino/`), manual `System 2` model selection in `AgentChatPanel`, open-ceiling wallet-bounded credit metering (`Zero Per-Task Credit Ceiling`), single-layer node/stream accounting invariants, and brand-agnostic Redis metering key prefixes (`credit:*`).

| Requirement Group         | Target Source Modules                                                                                                                                                 | Core Engineering Objective                                                                                                                                                                                                                                                                                |
| :------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`REQ-MODEL-01 .. 04`**  | `../../src/config/models.config.json`, `../../src/lib/ai/client.ts`, `../../src/components/agent/chat-panel.tsx`                                                      | Preserve existing provider-prefixed model IDs in `models.config.json`, resolve provider prefixes cleanly at the SDK call boundary (`parseQualifiedModelId` / `resolveLanguageModel`), and enable manual `System 2` model selection in `AgentChatPanel`.                                                   |
| **`REQ-METER-01 .. 05`**  | `../../src/lib/metering/derivation.ts`, `../../src/lib/metering/node-gate.ts`, `../../src/lib/metering/stream-governor.ts`, `../../src/server/routes/agent.routes.ts` | Enforce zero per-task credit ceiling (halting strictly on user wallet exhaustion `creditBalanceMicro`), eliminate double metering between `withMeteredNodeGate` and `StreamGovernor`, execute initial Redis lease reservation prior to streaming, and emit first-class `INSUFFICIENT_CREDITS` interrupts. |
| **`REQ-REDIS-PREFIX-01`** | `../../src/lib/metering/constants.ts`, `../../src/lib/jev/calibration-store.ts`                                                                                       | Replace legacy `lugx:*` and `gemini:*` Redis prefixes with domain-neutral `credit:*` and `calibration:*` prefixes.                                                                                                                                                                                        |

## 2. Multi-Provider Model Registry & Prefix Routing (`REQ-MODEL-01 .. 04`)

### 2.1. Preservation of Canonical Provider-Prefixed Model Registry (`REQ-MODEL-01`)

File: `../../src/config/models.config.json`

All registered model identifiers MUST retain their canonical `<provider>/<model-slug>` format verbatim:

- **System 1 (`SINGLE_PASS_DECISION` & `DISCRETE_THINKING`):**
  - `"openai/gpt-6-luna-decisions"`
  - `"microsoft/decision-1"`
  - `"typesafe/jev-1.13"`
  - `"fastino/glide"`
- **System 2 (`STREAMING_GENERATIVE` — Selectable in UI):**
  - `"google/gemini-4-argon"` (`V = 100`, `creditsPer1kInput = 1.25`, `creditsPer1kOutput = 5.00`)
  - `"google/gemini-3.8-flash"` (`V = 120`, `creditsPer1kInput = 0.15`, `creditsPer1kOutput = 0.60`)
  - `"google/gemini-3.1-pro"` (`V = 95`, `creditsPer1kInput = 1.25`, `creditsPer1kOutput = 5.00`)

### 2.2. Provider-Prefix Parsing at the SDK Boundary (`REQ-MODEL-02`)

File: `../../src/lib/ai/client.ts`

```typescript
export interface ParsedQualifiedModelId {
  readonly qualifiedModelId: string;
  readonly providerPrefix:
    | "google"
    | "openai"
    | "microsoft"
    | "typesafe"
    | "fastino";
  readonly providerModelName: string;
}

/**
 * Parses a qualified model ID (e.g. "google/gemini-3.8-flash") into its provider
 * namespace and provider-native model slug ("gemini-3.8-flash").
 */
export function parseQualifiedModelId(
  qualifiedModelId: string,
): ParsedQualifiedModelId {
  const trimmed = qualifiedModelId.trim();
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx <= 0 || slashIdx === trimmed.length - 1) {
    return {
      qualifiedModelId: `google/${trimmed}`,
      providerPrefix: "google",
      providerModelName: trimmed,
    };
  }
  const providerPrefix = trimmed.slice(
    0,
    slashIdx,
  ) as ParsedQualifiedModelId["providerPrefix"];
  const providerModelName = trimmed.slice(slashIdx + 1);
  return {
    qualifiedModelId: trimmed,
    providerPrefix,
    providerModelName,
  };
}
```

- **SDK Invocation Boundary (`resolveLanguageModel` — Planned / New — & `getGoogleModel` in `../../src/lib/ai/client.ts`):**
  - Metering (`getModelRegistryEntry(qualifiedModelId)`), circuit-breaker tracking (`getModelCircuitState(qualifiedModelId)`), and key-rotation quota buckets (`getApiKeyForRequest(qualifiedModelId)`) continue to index by the full `qualifiedModelId` (`"google/gemini-3.8-flash"`).
  - When instantiating the provider SDK model instance (`createGoogleGenerativeAI({ apiKey })(providerModelName)`), `getGoogleModel` MUST pass `parsed.providerModelName` (`"gemini-3.8-flash"`) so the upstream provider API receives the exact bare model identifier it expects while future providers (`openai/*`, etc.) route cleanly through `switch (parsed.providerPrefix)`.
- **Removal of Unused `@google/generative-ai` Dependency (`REQ-MODEL-03`):**
  - Remove legacy `@google/generative-ai` from `../../package.json`, keeping `@ai-sdk/google` and `ai` (`Vercel AI SDK v7`) as the sole generative SDK packages.

### 2.3. Manual `System 2` Model Selector in `AgentChatPanel` (`REQ-MODEL-04`)

File: `../../src/components/agent/chat-panel.tsx`

- Renders a model selector dropdown populated from all entries in `../../src/config/models.config.json` where `executionMode === "STREAMING_GENERATIVE"` (`google/gemini-3.8-flash` default, `google/gemini-3.1-pro`, `google/gemini-4-argon`), displaying each model's display name and credit rate (`creditsPer1kInput` / `creditsPer1kOutput`).
- The selected `qualifiedModelId` is passed in `POST /api/agent/stream` as `selectedSystem2ModelId` inside `AgentStreamRequestPayload` and governs all `System 2` invocations (`search_discovery_node`, `assumption_extractor_node`, `workspace_mutator_node`, `direct_response_node`) and their associated credit reservations.

## 3. Open-Ceiling Wallet-Bounded Metering & Single-Layer Accounting (`REQ-METER-01 .. 05`)

### 3.1. Zero Per-Task Credit Ceiling (`REQ-METER-01`)

1. No node, stream governor, or graph runner may impose a synthetic per-task or per-turn credit cap.
2. Execution across multi-file searches, assumption extraction, `System 1` decision cascades, and `System 2` document streaming continues for as many slices and steps as needed, bounded strictly by the user's real-time available wallet balance (`creditBalanceMicro` in Redis / PostgreSQL).
3. If and only if the user's wallet balance cannot cover the next required reservation (after applying the **Zero-Dust Drain** rule in `deriveStreamingGenerativeReservation` at `../../src/lib/metering/derivation.ts` when $0 < \text{capacity} < L_{\min}$), execution halts cleanly with `INSUFFICIENT_CREDITS`.

### 3.2. Elimination of Double Metering & Pre-Stream Lease Initialization (`REQ-METER-02 .. 03`)

Files: `../../src/server/routes/agent.routes.ts`, `../../src/lib/metering/stream-governor.ts`, `../../src/lib/metering/node-gate.ts`

```mermaid
sequenceDiagram
    autonumber
    participant NODE as Graph Node (Nodes 2, 3, 4, 5, 8, 9)
    participant GATE as withMeteredNodeGate / StreamGovernor
    participant REDIS as Upstash Redis Lua (credit:wallet & credit:lease)
    participant DB as Neon PostgreSQL (credit_ledger_transactions)

    alt Discrete / Structured / Batch API Node (Nodes 2, 3, 4, 5)
        NODE->>GATE: Invoke wrapped node with ctx.selectedSystem2ModelId (or System 1 modelId)
        GATE->>REDIS: 1. executeReserveOrExtend (Pre-authorize input + discrete ceiling)
        NODE->>NODE: 2. Execute model call & capture exact token usage
        GATE->>REDIS: 3. executeSettleOperation (Refund unused delta; append credit:pending_settlements)
    else Streaming Generative Node (Nodes 8, 9)
        NODE->>GATE: 1. await streamGovernor.initializeLease(pessimisticInputTokens)
        GATE->>REDIS: 2. executeReserveOrExtend (Initial slice reserved in Redis BEFORE first token)
        loop Token Streaming
            NODE->>GATE: 3. onChunk(actualTokenDelta) — proactive runway extension at T_RUNWAY_SECONDS
        end
        NODE->>GATE: 4. await streamGovernor.settle(actualUsage)
        GATE->>REDIS: 5. executeSettleOperation
    end
    Note over REDIS,DB: On SSE Stream Close: scheduleAfterResponse() flushes credit:pending_settlements to DB
```

1. **Single-Layer Metering Invariant (`REQ-METER-02`):**
   - `../../src/server/routes/agent.routes.ts` MUST NOT wrap SSE state-update JSON frames in an outer `StreamGovernor` that counts `JSON.stringify(stateDelta)` characters as AI tokens.
   - Instead, metering occurs strictly once per model invocation:
     - Discrete and tool-loop nodes (`search_discovery_node`, `assumption_extractor_node`, `conflict_and_weight_gate_node`, `jev_conformal_scorer_node`) meter via `withMeteredNodeGate` using the exact `usage.inputTokens` and `usage.outputTokens` returned by `Vercel AI SDK v7` / `POST /v1/decisions`.
     - Streaming nodes (`workspace_mutator_node`, `direct_response_node`) meter via a per-invocation `StreamGovernor` bound to `ctx.selectedSystem2ModelId`.
2. **Mandatory Initial Redis Lease Reservation in `StreamGovernor` (`REQ-METER-03`):**
   - Before consuming any streamed chunks, `StreamGovernor.initializeLease()` (Planned / New) MUST invoke `ensureWalletLoadedFlushFirst` and `executeReserveOrExtend` in Redis to reserve the initial slice (`initialReservationTokens`). Setting `totalTokensReserved` in memory without an active Redis lease is strictly prohibited.
3. **First-Class `INSUFFICIENT_CREDITS` Interrupt Signal (`REQ-METER-04`):**
   - When `executeReserveOrExtend` returns `canAfford === false`, `withMeteredNodeGate` and `StreamGovernor` return a typed `NodeExecutionResult` with `status: "INTERRUPTED"` and `interruptReason: "INSUFFICIENT_CREDITS"`, which `Elixent Native Graph Engine` checkpoints in `agent_checkpoints` (`nextNodeId = currentNodeId`) so the user can top up their wallet and resume from the exact interrupted node.

## 4. Brand-Agnostic Redis Key Prefix Standardization (`REQ-REDIS-PREFIX-01`)

File: `../../src/lib/metering/constants.ts` & `../../src/lib/jev/calibration-store.ts`

```typescript
export const REDIS_KEYS = {
  wallet: (userId: string) => `credit:wallet:${userId}`,
  lease: (operationId: string) => `credit:lease:${operationId}`,
  stepDone: (stepKey: string) => `credit:step_done:${stepKey}`,
  pendingSettlements: (userId: string) =>
    `credit:pending_settlements:${userId}`,
  dirtyWallets: () => `credit:dirty_wallets`,
  calibrationWindow: (modelId: string) => `calibration:window:${modelId}`,
} as const;
```

## 5. Verification & Acceptance Criteria

1. **Multi-Provider Routing & Manual Selection Tests (`../../src/test/ai/`):**
   - Verify `parseQualifiedModelId("google/gemini-3.8-flash")` passes `"gemini-3.8-flash"` to `createGoogleGenerativeAI` while indexing circuit breakers and `getModelRegistryEntry` by `"google/gemini-3.8-flash"`.
   - Verify selecting `"google/gemini-4-argon"` or `"google/gemini-3.1-pro"` in `AgentChatPanel` bills at `1.25 / 5.00` credits per 1k tokens rather than the flash rate.
2. **Single-Layer & Open-Ceiling Metering Tests (`../../src/test/metering/`):**
   - Verify `StreamGovernor.initializeLease` executes `executeReserveOrExtend` in Redis under `credit:lease:<opId>` before streaming starts, that SSE state frame emission in `agent.routes.ts` triggers zero duplicate token charges, and that multi-step agent runs execute without any fixed per-task ceiling until `credit:wallet:<userId>` is exhausted.
