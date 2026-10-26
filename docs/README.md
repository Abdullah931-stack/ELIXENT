# Elixent Documentation — Master Structural Index

This index maps every document under `docs/`. It is a **structural map only**:
operational documentation rules live outside this file — see
[DOCUMENTATION_GUIDELINES.md](./DOCUMENTATION_GUIDELINES.md) for repository-visible
authoring standards (enforced locally via `.agents/rules/`). Source code and
automated tests remain the single source of truth for all technical claims.

---

## 1. Directory Tree Map

```
docs/
├── README.md                          ← you are here (structural master index)
├── DOCUMENTATION_GUIDELINES.md        ← repository-visible authoring standards & planning governance
├── CHANGELOG.md                       ← release history (v1.0.0 through v1.39.0)
├── TECHNICAL_DEBT_REGISTER.md         ← living technical debt & architectural decisions (TD-01 to TD-12)
├── METRICS.json                       ← automated single source of truth for test & suite metrics
│
├── architecture/                      ← subsystem designs, protocols, state machines
│   ├── 01_architecture_vision_and_adrs.md
│   ├── 02_agent_orchestration_and_decision_engine.md
│   ├── 03_workspace_ast_editor_and_vault_integration.md
│   ├── 04_credit_metering_and_settlement_architecture.md
│   ├── 05_data_contracts_and_lugx_migration_plan.md
│   ├── sync/                          ← offline-first sync engine, concurrency & storage
│   ├── ai/                            ← Gemini LLM streaming, atomic commit & quota lifecycle
│   └── security/                      ← rate limiting, edge proxy, crypto workers & ZK log masking
│
├── reference/                         ← living API contracts, hooks & testing runner specifications
│   ├── sync-api.md                    ← REST contracts for /api/files/sync & client hook contracts
│   ├── ui-streaming-readiness.md      ← G1–G11 readiness-gate compliance matrix
│   ├── test-database-isolation.md     ← isolated Neon test runner & fail-closed guard specification
│   └── ci-pipeline.md                 ← 7-stage CI workflow, progressive fail-closed release gate & summary contract
│
├── guides/                            ← operational how-to guides & feature walkthroughs
│   ├── billing/                       ← Stripe products, webhooks & checkout lifecycle
│   ├── editor/                        ← CodeMirror 6 UI enhancements, search/replace & export guide
│   └── ai/                            ← decoupled Gemini model configuration via models.config.json
│
├── specs/                             ← living technical specifications & design blueprints
│   ├── ai-key-rotation-and-resilience.md
│   ├── offline-sync-blueprint.md      ← foundational blueprint for IndexedDB offline synchronization
│   └── ui-streaming-requirements.md
│
├── Plans/                             ← active official technical execution roadmaps (English)
│   └── ELIXENT_EXECUTION_PLAN.md      ← unified Elixent multi-agent platform execution plan (Active: 12 Commit-Sized SRP Phases)
│
├── records/                           ← engineering records, incidents, audits, closures & plans archive
│   ├── incidents/                     ← root-cause post-mortems (test-database-safety.md, codemirror-syntax-tree-parse-budget-race.md)
│   ├── audits/                        ← verification audit records (W10-Final-Closure-Round.md, unified-security-and-engineering-audit.md)
│   ├── closures/                      ← official milestone & phase closure dossiers (Phases 1–20, Core Hardening)
│   │   ├── phase-01-to-06-markdown-editor/
│   │   ├── phase-11-to-15-core-infrastructure/
│   │   ├── phase-16-vault-encryption/
│   │   ├── phase-17-to-20-production-readiness/
│   │   ├── extensions/                ← pdf worker extraction, vault import, sub-line diff3 & v1.46.1 offline auto-merge closure
│   │   └── core-hardening/            ← core hardening dossiers (Phase 1–18: metrics, links, skipped tests, Redis, contracts, reducers, schema, identity, crypto hierarchy, encrypted content governance, AI settlement, Stripe 1:N, Redis fail-closed & cron overlap, local sync queue CAS, durable IDB conflict quarantine, CI dependency audit gate, thin coordinator sync-manager decomposition, use-editor-conflict extraction)
│   ├── plans/                         ← completed historical execution plans (comprehensive-technical-remediation-plan-lugx-v1, technical-execution, hybrid-vault, markdown-editor, M6)
│   └── archive/                       ← superseded, halted, or abandoned specs & LUGX v1 historical baseline (lugx-v1/foundation/, CHANGELOG-LUGX-v1.md)
│
└── .Plans/                            ← internal candidate planning incubator (Arabic, untracked via .gitignore)
```

---

## 2. Document Index

### 2.1. Central Registers (`docs/`)

| Document | Scope & Purpose |
| :--- | :--- |
| [README.md](./README.md) | Structural master index mapping every document in the repository |
| [DOCUMENTATION_GUIDELINES.md](./DOCUMENTATION_GUIDELINES.md) | Policy on create/update/merge, nested directories, evidence discipline, and dual-track planning governance |
| [CHANGELOG.md](./CHANGELOG.md) | Append-only chronological release notes starting at Elixent v0.0.1 (with LUGX v1.0.0–v1.46.3 archived) |
| [TECHNICAL_DEBT_REGISTER.md](./TECHNICAL_DEBT_REGISTER.md) | Living register of accepted debts, mitigations, and resolution status (TD-01 to TD-19) |
| [METRICS.json](./METRICS.json) | Centralized single source of truth for test suite counts and verification numbers |

---

### 2.2. Architecture (`architecture/`) — Living Subsystem Documentation

#### Elixent Platform Architecture Suite (`architecture/01`–`05`)

| Document | Scope |
| :--- | :--- |
| [01_architecture_vision_and_adrs.md](./architecture/01_architecture_vision_and_adrs.md) | Authoritative system vision, high-level topology, and Architectural Decision Records (ADR-001 to ADR-005) |
| [02_agent_orchestration_and_decision_engine.md](./architecture/02_agent_orchestration_and_decision_engine.md) | Multi-agent orchestration pipeline, router-critic loop, and deterministic decision engine |
| [03_workspace_ast_editor_and_vault_integration.md](./architecture/03_workspace_ast_editor_and_vault_integration.md) | CodeMirror 6 AST surgical patching, bidirectional isolation, and Zero-Knowledge vault boundary |
| [04_credit_metering_and_settlement_architecture.md](./architecture/04_credit_metering_and_settlement_architecture.md) | Token-to-credit metering, dual-phase atomic reservation leases, and financial settlement ledger |
| [05_data_contracts_and_lugx_migration_plan.md](./architecture/05_data_contracts_and_lugx_migration_plan.md) | Canonical data contracts, Drizzle PostgreSQL schema evolution, and LUGX v1 to Elixent migration blueprint |

#### Sync & Storage Engine (`architecture/sync/`)

| Document | Scope |
| :--- | :--- |
| [sync-lifecycle-architecture.md](./architecture/sync/sync-lifecycle-architecture.md) | Offline sync lifecycle, user-scoped partitioning, explicit `SyncStatus` state machine, cryptographic gateway (`SyncCryptoGateway`) |
| [queue-gc-rollback-architecture.md](./architecture/sync/queue-gc-rollback-architecture.md) | Operations queue, exponential backoff/dead-letter, state-safe GC, rollback isolation |
| [three-way-conflict-resolution.md](./architecture/sync/three-way-conflict-resolution.md) | 3-way merge engine, base snapshots, false-conflict elimination, encrypted inbound gateway, conflict dialog, and centralized syntax validation |
| [editor-sync-orchestration.md](./architecture/sync/editor-sync-orchestration.md) | Unified editor write controller: autosave gates, reconciliation, AI transaction guard, inbound remote decryption |
| [file-ownership-and-versioning.md](./architecture/sync/file-ownership-and-versioning.md) | Server-side ownership enforcement, hierarchy safety, optimistic locking (412/428) |
| [sync-architecture-overview.md](./architecture/sync/sync-architecture-overview.md) | Layered sync system overview with Mermaid architecture & sequence flows, actual `useSync` hook contract, Phase 23 quarantine backpressure & diagnostics governance |

#### AI LLM Subsystem (`architecture/ai/`)

| Document | Scope |
| :--- | :--- |
| [ai-streaming-protocol.md](./architecture/ai/ai-streaming-protocol.md) | NDJSON wire protocol, session FSM, adversarial hardening |
| [ai-quota-reservation-lifecycle.md](./architecture/ai/ai-quota-reservation-lifecycle.md) | AI quota reservations, deduplication, 24h key rotation, settlement matrix (§4-D) |
| [ai-atomic-commit-architecture.md](./architecture/ai/ai-atomic-commit-architecture.md) | Transactional AI commit binding file update + quota settlement + version guard |

#### Security & Rate Limiting (`architecture/security/`)

| Document | Scope |
| :--- | :--- |
| [security-and-rate-limiting.md](./architecture/security/security-and-rate-limiting.md) | Edge Proxy auth gating, rate limiter tiers, Markdown normalization & XSS sanitization, Dual-Tier Hybrid Encryption (AES-GCM-256 + PBKDF2 600K worker, BIP-39 recovery, WebAuthn PRF Hardware Biometrics & 6-digit PIN, AAD integrity, RAM sanitization, device trust revocation via migration 0009, AI opt-in via migration 0010, Zero-Knowledge log hygiene & volatile RAM zeroing), cron purge |

---

### 2.3. Reference (`reference/`) — Living Technical Contracts

| Document | Scope |
| :--- | :--- |
| [sync-api.md](./reference/sync-api.md) | REST contract for `/api/files/sync` and `/api/files/:id`, client-side sync events, cryptographic interfaces, `LogSanitizer`, `SyncErrorHandler` & `SyncPerformanceMonitor` contracts |
| [ui-streaming-readiness.md](./reference/ui-streaming-readiness.md) | G1–G11 readiness-gate compliance matrix, dual atomicity model, feature flags |
| [test-database-isolation.md](./reference/test-database-isolation.md) | Phase 10: isolated Neon test branch — fail-closed guard, `test` vs `test:live` split, CI multi-stage pipeline, closure evidence |
| [ci-pipeline.md](./reference/ci-pipeline.md) | 7-stage CI workflow, progressive fail-closed release gate, and `$GITHUB_STEP_SUMMARY` reporting specification |

---

### 2.4. Guides (`guides/`) — Operational How-To Guides

#### Billing & Monetization (`guides/billing/`)

| Document | Scope |
| :--- | :--- |
| [stripe-setup.md](./guides/billing/stripe-setup.md) | Stripe products, webhooks, env vars, test cards, go-live checklist |
| [stripe-integration.md](./guides/billing/stripe-integration.md) | Payment flow, library functions, API routes, troubleshooting |

#### Markdown Editor & Ingestion (`guides/editor/`)

| Document | Scope |
| :--- | :--- |
| [editor-ui-enhancements.md](./guides/editor/editor-ui-enhancements.md) | UI restructuring, copy/move file ops, dynamic statistics, text direction management menu, code block LTR locking, unified typography |
| [search-replace-feature.md](./guides/editor/search-replace-feature.md) | Editor search/replace behavior, debounce logic, shortcuts |
| [data-export-guide.md](./guides/editor/data-export-guide.md) | Data export subsystem architecture, Zero-Knowledge plaintext governance barrier, Markdown & Plain Text strategies, factory patterns, and validation rules |

#### AI Configuration (`guides/ai/`)

| Document | Scope |
| :--- | :--- |
| [ai-models-config.md](./guides/ai/ai-models-config.md) | Decoupled Gemini model/hyperparameter configuration via `models.config.json` |

---

### 2.5. Specifications (`specs/`)

| Document | Scope |
| :--- | :--- |
| [offline-sync-blueprint.md](./specs/offline-sync-blueprint.md) | Original offline-first blueprint: storage engine, background sync, roadmap M1–M8 |
| [ai-key-rotation-and-resilience.md](./specs/ai-key-rotation-and-resilience.md) | Circuit breaker states, key lifecycle, streaming watchdogs & terminality contract |
| [ui-streaming-requirements.md](./specs/ui-streaming-requirements.md) | Requirements/invariants for ephemeral ghost preview & atomic undo |

---

### 2.6. Plans (`Plans/`) — Active Execution Plans (English)

| Document | Scope | Status |
| :--- | :--- | :--- |
| [ELIXENT_EXECUTION_PLAN.md](./Plans/ELIXENT_EXECUTION_PLAN.md) | Master architectural transition & multi-agent engineering execution plan (12 Commit-Sized SRP Phases) | 🟢 Active |

> **Dual-Track Planning Policy:** The `.Plans/` directory in the repository root is an **internal candidate planning incubator** (written in Arabic, untracked in Git via `.gitignore`). It serves as a scratchpad for drafting, evaluating, and incubating future ideas. Once an engineering plan is approved and executed, its authoritative English edition is published and tracked here under `docs/Plans/`.

---

### 2.7. Records (`records/`) — Engineering Records, Audits & Milestone Closures

#### Incidents (`records/incidents/`)

| Document | Scope / Date |
| :--- | :--- |
| [test-database-safety.md](./records/incidents/test-database-safety.md) | Unscoped test delete incident record, root cause, placeholder UUID architecture & cleanup guards — closed 2026-08-23 |
| [codemirror-syntax-tree-parse-budget-race.md](./records/incidents/codemirror-syntax-tree-parse-budget-race.md) | Lezer parser incremental parse-budget race under test concurrency, ensureSyntaxTree AST synchronization — closed 2026-10-02 |

#### Audits (`records/audits/`)

| Document | Scope / Date |
| :--- | :--- |
| [unified-security-and-engineering-audit.md](./records/audits/unified-security-and-engineering-audit.md) | Comprehensive 7-module security, reliability & architectural audit (183 consolidated findings, v1.32.4 / commit `d2d60a7`) |
| [W10-Final-Closure-Round.md](./records/audits/W10-Final-Closure-Round.md) | Concurrency-window closure F1 (SQL optimistic locking on `PUT /api/files/:id`) & Vitest `singleFork` serialization — 2026-08-16 |

#### Milestone Closures (`records/closures/`)

| Directory | Scope |
| :--- | :--- |
| [phase-01-to-06-markdown-editor/](./records/closures/phase-01-to-06-markdown-editor/) | Phase 1 to Phase 6 closure dossiers: standalone CodeMirror 6 editor, adapter, Diff3 merge, streaming export, and TipTap purge |
| [phase-11-to-15-core-infrastructure/](./records/closures/phase-11-to-15-core-infrastructure/) | Phase 11 to Phase 15 closure dossiers: editor orchestration, auth ownership, Stripe webhooks, Supabase storage purge, and file sanitization |
| [phase-16-vault-encryption/](./records/closures/phase-16-vault-encryption/) | Phase 16 closure dossiers: isolated Crypto Worker, schemas, UI conversion engine, AI safety gates, and 10-point test matrix |
| [phase-17-to-20-production-readiness/](./records/closures/phase-17-to-20-production-readiness/) | Phase 17 to Phase 20 closure dossiers: dual-mode rate limiting, live multi-system integration, Playwright E2E testing, and production readiness dossier |
| [extensions/](./records/closures/extensions/) | PDF Worker extraction, spatial table reconstruction, Arabic normalizer, and vault import closure report; [ad-hoc automated test & CI ecosystem harmonization closure](./records/closures/extensions/ad-hoc-test-and-ci-ecosystem-alignment-closure.md); [Intra-Line Word-Level Diff & Sub-Line 3-Way Merge Upgrade closure](./records/closures/extensions/intra-line-word-diff-and-sub-line-3way-merge-closure.md); [Release v1.46.1 Offline Auto-Merge & Cross-Tab Sync closure](./records/closures/extensions/release-1-46-1-offline-automerge-and-crosstab-sync-closure.md); [Release v1.46.2 Architectural Remediation & Complete Lifecycle Hardening closure](./records/closures/extensions/release-1-46-2-architectural-remediation-and-lifecycle-hardening-closure.md) |
| [core-hardening/](./records/closures/core-hardening/) | Core Hardening dossiers: Phase 1 (metrics & SSOT sync), Phase 2 (internal link audit & CI link checker), Phase 3 (skipped tests & release gate), Phase 4 (Redis REST emulator, lock contention & fail-open), Phase 5 (contracts dictionary & discriminated storage), Phase 6 (pure state reducers & contractual safety nets), Phase 7 (PostgreSQL schema hardening, migrations & atomic interactive transactions), Phase 8 (server-authoritative identity, resource ownership guards, cycle detection & optimistic concurrency on deletions: [phase-08 closure dossier](./records/closures/core-hardening/phase-08-identity-ownership-and-cycle-detection-closure.md)), Phase 9 (cryptographic key hierarchy, standard AAD contexts & adaptive dual-try recovery migration: [phase-09 closure dossier](./records/closures/core-hardening/phase-09-crypto-hierarchy-and-adaptive-migration-closure.md)), Phase 10 (encrypted content governance, mandatory fileId & export warning modal: [phase-10 closure dossier](./records/closures/core-hardening/phase-10-encrypted-content-governance-closure.md)), Phase 11 (AI service, server-authoritative settlement, replay defense & decoupled commit: [phase-11 closure dossier](./records/closures/core-hardening/phase-11-ai-service-and-server-settlement-closure.md)), Phase 13 (Redis fail-closed policies, conditional ZADD, Upstash REST CI proxy, distributed cron locking & hermetic test isolation: [phase-13 closure dossier](./records/closures/core-hardening/phase-13-redis-fail-closed-and-cron-overlap-closure.md)), Phase 14 (local sync queue, monotonic localRevision, Lean CAS & pure queued-only coalescing: [phase-14 closure dossier](./records/closures/core-hardening/phase-14-local-sync-queue-and-atomic-cas-closure.md)), Phase 15 (durable IDB conflict quarantine, pull protection, deterministic Hunt-McIlroy Diff3 engine & user-scoped cross-tab isolation: [phase-15 closure dossier](./records/closures/core-hardening/phase-15-durable-idb-conflict-quarantine-diff3-and-tab-isolation-closure.md)), Phase 15.1 (deterministic dependency security audit gate with production fail-closed policy & TD-15 dev allowlist: [phase-15.1 closure dossier](./records/closures/core-hardening/phase-15-1-ci-dependency-security-audit-gate-closure.md)), Phase 16 (thin coordinator sync-manager decomposition, sub-engine extraction & SyncRollback preservation: [phase-16 closure dossier](./records/closures/core-hardening/phase-16-sync-manager-decomposition-and-thin-coordinator-closure.md)), and Phase 17 (standalone useEditorAutosave hook extraction, React 19 ref discipline, fail-closed vault unmount flush & security hardening: [phase-17 closure dossier](./records/closures/core-hardening/phase17-editor-autosave-react19.md)) |

#### Completed Plans (`records/plans/`)

| Document | Scope | Status |
| :--- | :--- | :--- |
| [comprehensive-technical-remediation-plan-lugx-v1.md](./records/plans/comprehensive-technical-remediation-plan-lugx-v1.md) | Unified technical remediation & core hardening plan for LUGX v1 (23 isolated SRP phases) | ✅ Completed |
| [technical-execution-plan.md](./records/plans/technical-execution-plan.md) | Code-based technical execution plan covering all 20 phases | ✅ Completed |
| [hybrid-encryption-and-vault-plan.md](./records/plans/hybrid-encryption-and-vault-plan.md) | Dual-tier hybrid encryption & zero-knowledge vault execution plan | ✅ Completed |
| [markdown-editor-migration-plan.md](./records/plans/markdown-editor-migration-plan.md) | Native CodeMirror 6 Markdown editor migration plan (Phases 1–6) | ✅ Completed |
| [production-hardening-and-remediation-plan-m6.md](./records/plans/production-hardening-and-remediation-plan-m6.md) | Concurrency hardening, distributed webhook locks, RAM purge & conflict quarantine | ✅ Completed |

#### Deprecated & Abandoned Archive (`records/archive/`)

| Document | Scope |
| :--- | :--- |
| [production-readiness-roadmap-m0-m5.md](./records/archive/production-readiness-roadmap-m0-m5.md) | Early milestone M0–M5 execution record (branch `production-readiness`, 2026-08-16) |
| [technical-fix-documentation-security-hardening.md](./records/archive/technical-fix-documentation-security-hardening.md) | Early W1–W8 hardening record (branch `merge`, 2026-08-16) |
| [sync-unit-tests-fixes.md](./records/archive/sync-unit-tests-fixes.md) | Early sync unit test fixes snapshot (February 2026) |
| [sync-system-legacy-snapshot.md](./records/archive/sync-system-legacy-snapshot.md) | Legacy initial sync delivery snapshot with historical deprecation banner |
| [core-hardening-pre-stage-2-plan.md](./records/archive/core-hardening-pre-stage-2-plan.md) | Pre-Stage 2 core hardening plan (Phases 1–4 closed; superseded & absorbed into comprehensive-technical-remediation-plan-lugx-v1.md) |
| [CHANGELOG-LUGX-v1.md](./records/archive/lugx-v1/CHANGELOG-LUGX-v1.md) | Historical LUGX v1 release notes archive (v1.0.0 through v1.46.3) |
| [DESIGN_VS_REALITY.md](./records/archive/lugx-v1/foundation/DESIGN_VS_REALITY.md) | Historical LUGX v1 divergence tracker between Day-0 design and implemented reality |
| [Product Requirements Document (PRD).md](<./records/archive/lugx-v1/foundation/Product Requirements Document (PRD).md>) | Founding LUGX v1 product requirements |
| [System Architecture Design.md](<./records/archive/lugx-v1/foundation/System Architecture Design.md>) | Original LUGX v1 architecture: IAM, data layer, key rotation, risk analysis |
| [Project_Structure.md](./records/archive/lugx-v1/foundation/Project_Structure.md) | Planned LUGX v1 directory tree and component responsibilities |
| [Implementation_Master_Plan.md](./records/archive/lugx-v1/foundation/Implementation_Master_Plan.md) | Founding LUGX v1 master implementation plan |
| [LUGX platform subscription plans.md](<./records/archive/lugx-v1/foundation/LUGX platform subscription plans.md>) | Original LUGX v1 tier definitions, quotas, pricing |
| [UI_UX Guidelines.md](<./records/archive/lugx-v1/foundation/UI_UX Guidelines.md>) | Original LUGX v1 visual direction, design system, components |
| [Using AI/AI Key Document.md](<./records/archive/lugx-v1/foundation/Using AI/AI Key Document.md>) | Original LUGX v1 AI model matrix & generation parameters per operation |
| [Using AI/correct.md](<./records/archive/lugx-v1/foundation/Using AI/correct.md>) · `improve` · `summarize` · `toPrompt` · `translate` | Original LUGX v1 system prompts (historical source material) |

---

## 3. Suggested Reading Paths

- **Onboarding:** repo-root `README.md` → this index → [sync-architecture-overview.md](./architecture/sync/sync-architecture-overview.md) → [stripe-setup.md](./guides/billing/stripe-setup.md)
- **Sync deep-dive:** `sync-lifecycle-architecture` → `queue-gc-rollback-architecture` → `three-way-conflict-resolution` → [sync-api.md](./reference/sync-api.md) → `editor-sync-orchestration`
- **AI deep-dive:** `ai-streaming-protocol` → `ai-quota-reservation-lifecycle` → `ai-atomic-commit-architecture` → [ai-key-rotation-and-resilience.md](./specs/ai-key-rotation-and-resilience.md)
- **Security review:** [security-and-rate-limiting.md](./architecture/security/security-and-rate-limiting.md) → `file-ownership-and-versioning` → [test-database-safety.md](./records/incidents/test-database-safety.md)

---

## 4. Verification Commands

<!-- BEGIN:SSOT_TEST_METRICS_INLINE -->
**Active Verification Baseline:** 89 unit suites (1077 tests) · 21 live suites (117 tests) · 14 E2E specs (15 journeys) — 100% Passing.
<!-- END:SSOT_TEST_METRICS_INLINE -->

```bash
npm run lint            # static analysis & ESLint 9 code quality gate
npm run lint:links      # deterministic markdown internal link verification (zero broken links)
npm run test:ci-gate    # deterministic CI gating simulation matrix (30 assertions, zero broken contracts)
npx tsc --noEmit        # strict TypeScript type-checking (0 errors)
npm run audit:ci        # dependency security gate: production fail-closed (0 vulnerabilities) + dev allowlist (TD-15)
npm run test            # pure unit, contract, and vault cryptographic test suites (89 files, 1077 tests via vitest.config.mts)
npm run test:live       # live database integration suites against isolated test PostgreSQL/Neon (21 files, 117 tests via vitest.live.config.mts)
npm run test:e2e        # browser-driven E2E user journeys (14 specs, 15 scenarios via Playwright / Chromium)
npm run test:all        # full suite execution (unit + live)
npm run build           # Next.js 16 production bundle compilation
act push --pull=false   # local containerized execution of the 7-stage CI workflow
node scripts/verify-migrations.mjs     # test database migration & schema verification
```

When citing results anywhere under `docs/`, follow the Evidence Discipline rules
in [DOCUMENTATION_GUIDELINES.md §4](./DOCUMENTATION_GUIDELINES.md#4-evidence-discipline-mandatory).
