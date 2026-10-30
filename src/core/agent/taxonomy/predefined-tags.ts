/**
 * Universal, Paradigm-Agnostic Concept Taxonomy & Project Tag Registry
 *
 * Provides the immutable universal concept taxonomy across 9 engineering domains,
 * format validation, normalization, and project-scoped mutable tag registry operations.
 *
 * Architectural Invariants:
 * 1. Pure Isomorphic & Client-Safe: Zero imports of database, Redis, or Node-only modules.
 * 2. Zero Host-Project Coupling: No internal LUGX/Elixent subsystem tags. Universal taxonomy only.
 * 3. Closed-World Guard: Prevents LLM tag hallucination via strict enum generation while
 *    supporting project-level mutations via `applyProjectTagMutations`.
 * 4. Deterministic Set Math: State mutation maintains `(baseTags \ removedTags) ∪ addedTags`.
 */

// ---------------------------------------------------------------------------
// 1. Universal Concept Taxonomy Across 9 Engineering Domains
// ---------------------------------------------------------------------------

export const DEFAULT_CONCEPT_TAGS = [
  // 1. System Architecture & Design
  "system_architecture",
  "module_boundaries",
  "dependency_management",
  "state_management",
  "event_driven",
  "concurrency_model",
  "configuration_management",
  "plugin_extensibility",

  // 2. Libraries, SDKs & Public Contracts
  "public_api_design",
  "type_contracts",
  "backward_compatibility",
  "versioning_policy",
  "packaging_distribution",
  "error_taxonomy",
  "cli_interface",
  "interoperability",

  // 3. Deep Learning, ML & Scientific Computing
  "model_architecture",
  "dataset_preprocessing",
  "training_optimization",
  "loss_evaluation_metrics",
  "tensor_precision_quantization",
  "hardware_acceleration",
  "inference_serving",
  "experiment_reproducibility",

  // 4. Data Modeling, Storage & Persistence
  "data_modeling",
  "schema_evolution",
  "caching_strategy",
  "indexing_search",
  "transaction_consistency",
  "serialization_format",
  "blob_file_storage",
  "data_pipeline",

  // 5. Networking, Protocols & Distributed Sync
  "network_protocol",
  "streaming_realtime",
  "rate_limiting_backpressure",
  "fault_tolerance_retries",
  "conflict_resolution",
  "distributed_coordination",
  "external_integrations",

  // 6. Security, Cryptography & Privacy
  "authentication",
  "authorization_access_control",
  "cryptography_key_management",
  "input_validation_sanitization",
  "secret_management",
  "privacy_data_protection",
  "sandboxing_isolation",

  // 7. Performance, Runtime & Systems
  "latency_throughput",
  "memory_management",
  "batching_vectorization",
  "lazy_loading_pagination",
  "background_scheduling",
  "runtime_io_lifecycle",
  "observability_telemetry",

  // 8. Frontend, UI/UX & Client Interaction
  "component_architecture",
  "rendering_strategy",
  "form_validation",
  "accessibility_localization",
  "optimistic_updates",
  "theming_design_system",

  // 9. Quality, Testing, CI/CD & Governance
  "testing_strategy",
  "benchmarking_profiling",
  "ci_cd_deployment",
  "documentation_architecture",
  "static_analysis_linting",
  "licensing_compliance",
] as const;

/**
 * Predefined concept tags alias for backward compatibility with architectural specs.
 */
export const PREDEFINED_CONCEPT_TAGS = DEFAULT_CONCEPT_TAGS;

/**
 * Literal union type of all universal default concept tags.
 */
export type ConceptTag = (typeof DEFAULT_CONCEPT_TAGS)[number];

/**
 * Categorized mapping of universal engineering domains to default concept tags.
 */
export const CONCEPT_TAG_DOMAINS = {
  system_architecture_and_design: [
    "system_architecture",
    "module_boundaries",
    "dependency_management",
    "state_management",
    "event_driven",
    "concurrency_model",
    "configuration_management",
    "plugin_extensibility",
  ],
  libraries_sdks_and_public_contracts: [
    "public_api_design",
    "type_contracts",
    "backward_compatibility",
    "versioning_policy",
    "packaging_distribution",
    "error_taxonomy",
    "cli_interface",
    "interoperability",
  ],
  deep_learning_ml_and_scientific_computing: [
    "model_architecture",
    "dataset_preprocessing",
    "training_optimization",
    "loss_evaluation_metrics",
    "tensor_precision_quantization",
    "hardware_acceleration",
    "inference_serving",
    "experiment_reproducibility",
  ],
  data_modeling_storage_and_persistence: [
    "data_modeling",
    "schema_evolution",
    "caching_strategy",
    "indexing_search",
    "transaction_consistency",
    "serialization_format",
    "blob_file_storage",
    "data_pipeline",
  ],
  networking_protocols_and_distributed_sync: [
    "network_protocol",
    "streaming_realtime",
    "rate_limiting_backpressure",
    "fault_tolerance_retries",
    "conflict_resolution",
    "distributed_coordination",
    "external_integrations",
  ],
  security_cryptography_and_privacy: [
    "authentication",
    "authorization_access_control",
    "cryptography_key_management",
    "input_validation_sanitization",
    "secret_management",
    "privacy_data_protection",
    "sandboxing_isolation",
  ],
  performance_runtime_and_systems: [
    "latency_throughput",
    "memory_management",
    "batching_vectorization",
    "lazy_loading_pagination",
    "background_scheduling",
    "runtime_io_lifecycle",
    "observability_telemetry",
  ],
  frontend_ui_ux_and_client_interaction: [
    "component_architecture",
    "rendering_strategy",
    "form_validation",
    "accessibility_localization",
    "optimistic_updates",
    "theming_design_system",
  ],
  quality_testing_ci_cd_and_governance: [
    "testing_strategy",
    "benchmarking_profiling",
    "ci_cd_deployment",
    "documentation_architecture",
    "static_analysis_linting",
    "licensing_compliance",
  ],
} as const satisfies Record<string, readonly ConceptTag[]>;

export type ConceptTagDomain = keyof typeof CONCEPT_TAG_DOMAINS;

// ---------------------------------------------------------------------------
// 2. Formatting & Validation Helpers
// ---------------------------------------------------------------------------

/**
 * Format regex: starts with lowercase ASCII letter, followed by 1 to 63 lowercase
 * alphanumeric characters or underscores (total length: 2 to 64 chars).
 */
export const CONCEPT_TAG_FORMAT_REGEX = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * Normalizes an arbitrary tag candidate by trimming, lowercasing, and replacing
 * whitespace, dashes, and duplicate delimiters with single underscores.
 */
export function normalizeConceptTag(rawTag: string): string {
  return rawTag
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Type guard verifying if a value matches the canonical concept tag format.
 */
export function isValidConceptTagFormat(tag: unknown): tag is string {
  return typeof tag === "string" && CONCEPT_TAG_FORMAT_REGEX.test(tag);
}

// ---------------------------------------------------------------------------
// 3. Project-Scoped Tag Registry & Mutation Model
// ---------------------------------------------------------------------------

/**
 * Persisted state of a project's concept taxonomy customizations.
 */
export interface ProjectTaxonomyState {
  projectId: string;
  addedTags: string[];
  removedTags: string[];
  updatedAt?: string;
}

/**
 * Thrown when an operation would leave a project with zero active concept tags.
 */
export class EmptyProjectTaxonomyError extends Error {
  constructor(projectId?: string) {
    super(
      `Active concept taxonomy for project "${projectId ?? "unknown"}" cannot be empty. At least one tag must remain active.`
    );
    this.name = "EmptyProjectTaxonomyError";
    Object.setPrototypeOf(this, EmptyProjectTaxonomyError.prototype);
  }
}

/**
 * Resolves the effective active concept tags for a project:
 * `(baseTags \ removedTags) ∪ addedTags`
 *
 * Guarantees a non-empty tuple `[string, ...string[]]` for type-safe Zod enum construction.
 */
export function resolveProjectConceptTags(
  state?: Partial<ProjectTaxonomyState> | null,
  baseTags: readonly string[] = DEFAULT_CONCEPT_TAGS
): [string, ...string[]] {
  const removedSet = new Set(state?.removedTags ?? []);
  const activeSet = new Set<string>();
  const resolved: string[] = [];

  for (const tag of baseTags) {
    if (!removedSet.has(tag) && !activeSet.has(tag)) {
      activeSet.add(tag);
      resolved.push(tag);
    }
  }

  for (const tag of state?.addedTags ?? []) {
    if (!removedSet.has(tag) && !activeSet.has(tag)) {
      activeSet.add(tag);
      resolved.push(tag);
    }
  }

  if (resolved.length === 0) {
    throw new EmptyProjectTaxonomyError(state?.projectId);
  }

  return resolved as [string, ...string[]];
}

/**
 * Symmetrically applies tag additions and removals to project taxonomy state.
 *
 * Invariants:
 * - When adding a tag: if it was in `removedTags`, remove it from `removedTags`;
 *   if not in `baseTags` and not in `addedTags`, add to `addedTags`.
 * - When removing a tag: if it was in `addedTags`, remove it from `addedTags`;
 *   if it is in `baseTags` and not in `removedTags`, add to `removedTags`.
 * - Validates tag format strictly with `CONCEPT_TAG_FORMAT_REGEX`.
 * - Guarantees active tag set is non-empty, otherwise throws `EmptyProjectTaxonomyError`.
 */
export function applyProjectTagMutations(
  current: ProjectTaxonomyState,
  mutation: { addTags?: readonly string[]; removeTags?: readonly string[] },
  baseTags: readonly string[] = DEFAULT_CONCEPT_TAGS
): ProjectTaxonomyState {
  const baseSet = new Set<string>(baseTags);
  const nextAdded = new Set<string>(current.addedTags);
  const nextRemoved = new Set<string>(current.removedTags);

  if (mutation.addTags) {
    for (const rawTag of mutation.addTags) {
      if (!isValidConceptTagFormat(rawTag)) {
        throw new Error(
          `Invalid concept tag format: "${rawTag}". Tag must match ${CONCEPT_TAG_FORMAT_REGEX.source}`
        );
      }
      if (nextRemoved.has(rawTag)) {
        nextRemoved.delete(rawTag);
      }
      if (!baseSet.has(rawTag)) {
        nextAdded.add(rawTag);
      }
    }
  }

  if (mutation.removeTags) {
    for (const rawTag of mutation.removeTags) {
      if (!isValidConceptTagFormat(rawTag)) {
        throw new Error(
          `Invalid concept tag format: "${rawTag}". Tag must match ${CONCEPT_TAG_FORMAT_REGEX.source}`
        );
      }
      if (nextAdded.has(rawTag)) {
        nextAdded.delete(rawTag);
      }
      if (baseSet.has(rawTag)) {
        nextRemoved.add(rawTag);
      }
    }
  }

  const nextState: ProjectTaxonomyState = {
    projectId: current.projectId,
    addedTags: Array.from(nextAdded),
    removedTags: Array.from(nextRemoved),
    updatedAt: new Date().toISOString(),
  };

  // Assert that at least one tag remains active
  resolveProjectConceptTags(nextState, baseTags);

  return nextState;
}

/**
 * Checks whether a given tag is active in the provided tag list or default taxonomy.
 */
export function isActiveConceptTag(tag: unknown, activeTags?: readonly string[]): boolean {
  if (typeof tag !== "string") {
    return false;
  }
  if (activeTags !== undefined) {
    return activeTags.includes(tag);
  }
  return (DEFAULT_CONCEPT_TAGS as readonly string[]).includes(tag);
}

// ---------------------------------------------------------------------------
// 4. System-Reserved Decision Sentinel for project_decision_ledger
// ---------------------------------------------------------------------------

/**
 * Reserved decision ID sentinel used to persist project taxonomy state in `project_decision_ledger`.
 */
export const PROJECT_TAXONOMY_SENTINEL_ID = "__PROJECT_TAXONOMY__";

/**
 * Checks if a given decision ID belongs to system-reserved infrastructure metadata.
 */
export function isSystemReservedDecisionId(decisionId: string): boolean {
  return decisionId.startsWith("__") && decisionId.endsWith("__");
}

/**
 * Converts a `ProjectTaxonomyState` into a compliant `project_decision_ledger` row payload.
 */
export function toTaxonomyLedgerPayload(state: ProjectTaxonomyState): {
  decisionId: string;
  topicSlug: string;
  questionPrompt: string;
  conceptTags: string[];
  selectedOptionKey: string;
  selectionRationale: string;
  evaluatedAlternatives: Array<{
    optionKey: string;
    neutralSummary: string;
    rationaleAndPremises: string;
  }>;
  status: "APPROVED_DIRECT";
  impactTier: "CORE_ARCHITECTURAL";
  isLoadBearing: true;
} {
  const activeTags = resolveProjectConceptTags(state);
  return {
    decisionId: PROJECT_TAXONOMY_SENTINEL_ID,
    topicSlug: "project_taxonomy_configuration",
    questionPrompt: "Project concept taxonomy registry state and custom tags",
    conceptTags: [...activeTags],
    selectedOptionKey: "active_taxonomy_v1",
    selectionRationale:
      "Persisted project-level concept taxonomy configuration containing added and removed tags.",
    evaluatedAlternatives: [
      {
        optionKey: "added_tags",
        neutralSummary: "Custom project-scoped tags added to the base taxonomy",
        rationaleAndPremises: JSON.stringify(state.addedTags),
      },
      {
        optionKey: "removed_tags",
        neutralSummary: "Base taxonomy tags disabled for this project",
        rationaleAndPremises: JSON.stringify(state.removedTags),
      },
    ],
    status: "APPROVED_DIRECT",
    impactTier: "CORE_ARCHITECTURAL",
    isLoadBearing: true,
  };
}

/**
 * Reconstitutes `ProjectTaxonomyState` from a persisted `project_decision_ledger` row.
 */
export function fromTaxonomyLedgerPayload(
  projectId: string,
  row: {
    conceptTags?: unknown;
    evaluatedAlternatives?: unknown;
    updatedAt?: Date | string | null;
  }
): ProjectTaxonomyState {
  let addedTags: string[] = [];
  let removedTags: string[] = [];

  if (Array.isArray(row.evaluatedAlternatives)) {
    for (const alt of row.evaluatedAlternatives) {
      if (alt && typeof alt === "object" && "optionKey" in alt && "rationaleAndPremises" in alt) {
        const item = alt as { optionKey: string; rationaleAndPremises: string };
        if (item.optionKey === "added_tags") {
          try {
            const parsed = JSON.parse(item.rationaleAndPremises);
            if (Array.isArray(parsed)) {
              addedTags = parsed.filter((t): t is string => typeof t === "string");
            }
          } catch {
            // Ignore malformed alternative payload
          }
        } else if (item.optionKey === "removed_tags") {
          try {
            const parsed = JSON.parse(item.rationaleAndPremises);
            if (Array.isArray(parsed)) {
              removedTags = parsed.filter((t): t is string => typeof t === "string");
            }
          } catch {
            // Ignore malformed alternative payload
          }
        }
      }
    }
  }

  const updatedAt =
    row.updatedAt instanceof Date
      ? row.updatedAt.toISOString()
      : typeof row.updatedAt === "string"
      ? row.updatedAt
      : undefined;

  return {
    projectId,
    addedTags,
    removedTags,
    ...(updatedAt ? { updatedAt } : {}),
  };
}
