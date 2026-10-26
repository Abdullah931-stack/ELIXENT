# Changelog — Elixent Platform

All notable architectural, engineering, and governance changes to the **Elixent** platform are documented in this file.

---

## [0.0.1] - 2026-10-26 (Documentation & Governance Initialization)

### Platform Rebranding & Version Reset (`package.json`, `README.md`, `docs/README.md`)

- **Elixent Identity & Baseline Reset:** Transitioned platform package identity to `"name": "elixent"` at `"version": "0.0.1"`, establishing the clean-slate foundation for the Elixent AI-Native Workspace.
- **Unified Living Documentation Index:** Re-indexed `README.md` and `docs/README.md` around the five living architecture specifications, active reference contracts, and operational guides while preserving canonical SSOT test metrics synchronization.

### Authoritative Living Architecture Specifications (`docs/architecture/`)

- **Published 5 Core Living Architecture Specifications:**
  - `01_architecture_vision_and_adrs.md` — Architectural vision, system topology, and authoritative Architectural Decision Records (ADRs).
  - `02_data_and_storage_layer.md` — Hybrid database architecture, Drizzle ORM schema contracts, and client-side IndexedDB persistence.
  - `03_sync_and_cryptography_engine.md` — Zero-knowledge vault hierarchy, dual-try AAD envelopes, Lean CAS synchronization, and Hunt-McIlroy Diff3 conflict resolution.
  - `04_ai_and_document_pipeline.md` — Server-authoritative AI streaming, atomic quota settlement, multi-key Gemini failover, and Web Worker document ingestion/OCR.
  - `05_security_ci_and_observability.md` — Defense-in-depth security invariants, Upstash Redis rate limiting, Stripe 1:N webhook concurrency, and 7-stage CI/CD verification gates.

### Active Execution Roadmap (`docs/Plans/`)

- **Published 12-Phase Execution Plan:** Established `docs/Plans/EXECUTION_PLAN.md` defining the 12-phase engineering execution roadmap for the Elixent platform.

### Historical Baseline Archival & Governance Modernization (`docs/records/archive/lugx-v1/`, `docs/DOCUMENTATION_GUIDELINES.md`)

- **LUGX v1.0.0–v1.46.3 Baseline Archival:** Archived historical Day-0 founding records (`docs/records/archive/lugx-v1/foundation/`), previous subsystem architecture drafts (`docs/records/archive/lugx-v1/architecture/`), and historical remediation plans (`docs/records/plans/comprehensive-technical-remediation-plan-lugx-v1.md`).
- **Governance Alignment:** Updated `docs/DOCUMENTATION_GUIDELINES.md` and `scripts/sync-doc-metrics.mjs` to establish `docs/architecture/` as the authoritative living specification and ADR registry.

---

## Historical Archives

- **LUGX Legacy Baseline (v1.0.0 – v1.46.3):** For the complete historical release log prior to the Elixent v0.0.1 initialization, see [`CHANGELOG-LUGX-v1.md`](./records/archive/lugx-v1/CHANGELOG-LUGX-v1.md).
