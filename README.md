<p align="center">
  <a href="https://github.com/Abdullah931-stack/LUGX">
    <img src="./public/lugx-icon.svg" width="120" height="120" alt="LUGX Logo" />
  </a>
</p>

<h1 align="center">Elixent</h1>

<p align="center">
  <strong>Enterprise AI Proofreading, Linguistic Enhancement & Intelligent Translation Platform</strong><br />
  High-concurrency text editor engineered for Arabic and English with atomic quota reservation, fail-closed Stripe monetization, bidirectional typography, and a ground-up offline-first synchronization engine.
</p>

<p align="center">
  <a href="https://vite.dev"><img src="https://img.shields.io/badge/Vite-6.4.5-646CFF?style=for-the-badge&logo=vite" alt="Vite 6" /></a>
  <a href="https://hono.dev"><img src="https://img.shields.io/badge/Hono-4.13-E36002?style=for-the-badge&logo=hono" alt="Hono" /></a>
  <a href="https://react.dev"><img src="https://img.shields.io/badge/React-19.2.3-20232A?style=for-the-badge&logo=react" alt="React 19" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-22_LTS-339933?style=for-the-badge&logo=node.js" alt="Node.js 22 LTS" /></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5.0-3178C6?style=for-the-badge&logo=typescript" alt="TypeScript 5" /></a>
  <a href="https://orm.drizzle.team"><img src="https://img.shields.io/badge/Drizzle_ORM-0.45.1-C5F74F?style=for-the-badge&logo=drizzle" alt="Drizzle ORM" /></a>
  <a href="https://ai-sdk.dev"><img src="https://img.shields.io/badge/Vercel_AI_SDK-v7_(@ai--sdk/google)-8E75B2?style=for-the-badge&logo=vercel" alt="Vercel AI SDK v7" /></a>
  <a href="https://stripe.com"><img src="https://img.shields.io/badge/Stripe-Fail--Closed_Webhooks-635BFF?style=for-the-badge&logo=stripe" alt="Stripe" /></a>
  <a href="https://vitest.dev"><img src="https://img.shields.io/badge/Vitest-165%20Suites%20·%203348%2F3348%20Passing-6E9F18?style=for-the-badge&logo=vitest" alt="Vitest 3348 Passing" /></a>
  <a href="#5-automated-test-suite"><img src="https://img.shields.io/badge/Neon_Live_DB-22%20Suites%20·%20101%2F101%20Passing-00E599?style=for-the-badge&logo=postgresql" alt="Neon Live DB 101 Passing" /></a>
  <a href="#5-automated-test-suite"><img src="https://img.shields.io/badge/Playwright_E2E-18%20Specs%20·%2020%2F20%20Passing-blue?style=for-the-badge&logo=playwright" alt="Playwright E2E 20 Passing" /></a>
  <a href="#contributing--license"><img src="https://img.shields.io/badge/License-Apache_2.0-blue?style=for-the-badge&logo=apache" alt="License Apache 2.0" /></a>
</p>

---

## Table of Contents

- [Overview](#overview)
- [Architectural Statement: Custom Ground-Up Synchronization Engine](#architectural-statement-custom-ground-up-synchronization-engine)
- [Engineering Methodology](#engineering-methodology)
- [Architecture & Tech Stack](#architecture--tech-stack)
- [Project Structure](#project-structure)
- [Quickstart & Setup](#quickstart--setup)
  - [1. Prerequisites](#1-prerequisites)
  - [2. Environment Configuration](#2-environment-configuration)
  - [3. Database Migrations](#3-database-migrations)
  - [4. Running Development & Production](#4-running-development--production)
  - [5. Automated Test Suite](#5-automated-test-suite)
- [Core Engineering Subsystems](#core-engineering-subsystems)
  - [1. Standalone Markdown Editor & Bidirectional (Bidi) Engine](#1-standalone-markdown-editor--bidirectional-bidi-engine)
  - [2. Offline-First Synchronization & 3-Way Merge Engine](#2-offline-first-synchronization--3-way-merge-engine)
  - [3. Real-Time AI Streaming & Dual-Phase Atomic Quota Lifecycle](#3-real-time-ai-streaming--dual-phase-atomic-quota-lifecycle)
  - [4. Smart Hybrid Database Client & Neon Isolated Test Infrastructure](#4-smart-hybrid-database-client--neon-isolated-test-infrastructure)
  - [5. Fail-Closed Stripe Subscription Lifecycle & State Machine](#5-fail-closed-stripe-subscription-lifecycle--state-machine)
  - [6. Scheduled Maintenance & Cron Automation](#6-scheduled-maintenance--cron-automation)
  - [7. Zero-Knowledge Cloud Vault & Client-Side Hybrid Encryption Subsystem](#7-zero-knowledge-cloud-vault--client-side-hybrid-encryption-subsystem)
  - [8. Client-Side Document Ingestion, Spatial Table Extractor & Arabic Normalization Pipeline](#8-client-side-document-ingestion-spatial-table-extractor--arabic-normalization-pipeline)
  - [9. Dual-Mode Rate Limiting, Log Sanitization & Distributed Correlation Tracing](#9-dual-mode-rate-limiting-log-sanitization--distributed-correlation-tracing)
  - [10. Live Multi-System Integration & Isolated Database Test Infrastructure](#10-live-multi-system-integration--isolated-database-test-infrastructure)
  - [11. Browser-Driven End-to-End (E2E) Testing with Playwright](#11-browser-driven-end-to-end-e2e-testing-with-playwright)
  - [12. Fence-Aware AST Heading Slicer, Section-Scoped Diff3 & Hybrid BM25 Search Engine](#12-fence-aware-ast-heading-slicer-section-scoped-diff3--hybrid-bm25-search-engine)
  - [13. Zero-Knowledge Vault Boundary, Encrypted Checkpoints & Cloud Workspace Provider](#13-zero-knowledge-vault-boundary-encrypted-checkpoints--cloud-workspace-provider)
  - [14. Universal Concept Taxonomy, Unified Decision Client & Conformal APS Classifier](#14-universal-concept-taxonomy-unified-decision-client--conformal-aps-classifier)
  - [15. Justification-Driven ATMS DAG, Deterministic Candidate Retriever & Relational Linker](#15-justification-driven-atms-dag-deterministic-candidate-retriever--relational-linker)
  - [16. Elixent Native Graph Engine, 18-Channel AgentGraphState & 9 Replay-Safe Canonical Nodes](#16-elixent-native-graph-engine-18-channel-agentgraphstate--9-replay-safe-canonical-nodes)
  - [17. Agent Chat Panel, Multi-Tab Ghost Review, Decision Graph UI & Two-Tier Undo](#17-agent-chat-panel-multi-tab-ghost-review-decision-graph-ui--two-tier-undo)
- [Security Architecture](#security-architecture)
- [Documentation Index](#documentation-index)
- [Deployment Blueprints](#deployment-blueprints)
- [Contributing & License](#contributing--license)

---

## Overview

**LUGX** is an enterprise-grade cloud text editing and linguistic intelligence workstation designed specifically for bilingual Arabic and English content. It combines real-time AI assistance (grammar correction, style enhancement, translation, summarization, and prompt engineering) with a native, distraction-free Markdown editor, deterministic offline-first synchronization, resilient concurrency control, and a rock-solid subscription engine.

### Key Capabilities

- ✍️ **Native Markdown Editor & Bidi Engine:** Built on CodeMirror 6 with live AST token decorations, line-level bidirectional isolation (`bidiLinePlugin`), three direction modes (`auto`, `rtl`, `ltr`), and code block LTR locking.
- 📴 **Custom Offline-First Synchronization:** User-partitioned IndexedDB storage (`textai_db_${userId}`), deterministic 3-way linear diff merge, SHA-256 ETag verification, bounded worker queues, automatic GC compaction, root-move null preservation (`saveLocal`), atomic soft-delete folder cascade restoration (`restoreFile`), and atomic rollback snapshots.
- ⚡ **Micro-Credit Ledger & Dual-Phase Quota Settlement:** Eliminates TOCTOU race conditions with database-level conditional transactions (`credit_ledger_transactions`), non-negative balance constraints (`users.credit_balance_micro >= 0`), 5-minute TTL safety, and zero-bounded atomic refunds.
- 🤖 **Resilient AI NDJSON Streaming:** High-performance inline preview card (`CMStreamingGhostWidget`) positioned at exact document offsets with 60fps in-place DOM updates, 3-state decision triggers (`Accept`, `Reject`, `Retry`), and a distributed 3-state circuit breaker with multi-key API rotation.
- 💳 **Fail-Closed Stripe Subscriptions:** 8-state exhaustive webhook state machine with database-level uniqueness constraints preventing duplicate entitlements.
- 🛡️ **Smart Hybrid Database Client:** Dual-protocol architecture supporting `@neondatabase/serverless` (HTTP/WebSocket) for Neon Cloud PostgreSQL and `pg.Pool` (TCP) for local Docker, CI, and development environments.
- 🔒 **Zero-Knowledge Cloud Vault & Hybrid Encryption:** Client-side end-to-end encryption (`AES-GCM-256` with canonical AAD via `AAD.file(userId, fileId)` emitting `zk:v1:file:${userId}:${fileId}` and WebAuthn PRF `AAD.deviceWrap(userId, epoch)` emitting `zk:v1:device:${userId}:${epoch}` under clean-cut `zk:v1:*` enforcement), Web Worker-isolated key derivation (`PBKDF2-SHA256` with 600K iterations), WebAuthn PRF hardware biometrics, 6-digit Quick PIN, 12-word BIP-39 recovery seed, client-server encrypted import ETag parity, transparent local IndexedDB encryption, and dual-layer AI safety gatekeepers.
- 📄 **Client-Side PDF & Multi-Modal Document Extraction:** 100% in-browser Web Worker text extraction (`pdfjs-dist`), 2D spatial clustering algorithm for automatic GitHub-Flavored Markdown tables, pure TypeScript Arabic Unicode normalization (de-spacing, un-shaping, BiDi correction), embedded font corruption detection (PUA range analysis), and on-demand bilingual OCR (`tesseract.js`).
- 📡 **Dual-Mode Rate Limiting & Distributed Tracing:** Redis sliding-window limiters with Fail-Open resilience on public and file-sync operations, Fail-Closed protection on authentication RPC endpoints (`signInWithGoogle` by IP, `syncUserToDatabase` by user ID) and AI streaming quotas, distributed `X-Correlation-ID` context propagation across Hono RPC and REST Route Handlers with CRLF injection sanitization, and Zero-Knowledge log masking with token-boundary isolation.
- ⏱️ **Automated Quota & Maintenance Sweepers:** Scheduled crons for 30-day soft-delete purges (`/api/cron/purge-deleted`) and automated reclamation of expired AI quota leases (`/api/cron/expire-reservations`), resolving orphaned pending leases without manual intervention.
- 📑 **Fence-Aware AST Heading Slicer & Path-Coupled BM25 Search Engine:** CommonMark §4.2 ATX and §4.5 code-fence tracking parser (`src/core/ast/heading-slicer.ts`) with pure TypeScript FIPS 180-4 SHA-256 (zero `node:crypto` imports), section-scoped 3-way merge (`diff3MergeSection` in `src/lib/sync/diff3.ts`), and path-coupled Okapi BM25 search engine (`src/core/workspace/lexical-bm25.ts`) featuring Arabic/Latin normalization, compound subword extraction, and ReDoS protection.
- 🛡️ **Zero-Knowledge Vault Boundary & Authenticated Checkpoints:** Ephemeral in-memory section map (`EphemeralVaultMemoryMap`) backed by Node.js `AsyncLocalStorage` and `vault_ref://` pointers, `AES-256-GCM` authenticated native checkpoint serializer (`encryptAgentGraphState` / `decryptAgentGraphState` into single-table `agent_checkpoints`) with type-bound AAD and active plaintext leak prevention (`assertNoVaultPlaintextLeak`), and unified server-side workspace provider (`CloudPostgresWorkspaceProvider`) enforcing tenant isolation and user-consent AI gates.
- 🏷️ **Universal Concept Taxonomy & Conformal APS Classifier:** 9 orthogonal predefined knowledge domains (`DEFAULT_CONCEPT_TAGS`), project-scoped dynamic tag registry algebra, Adaptive Prediction Sets (APS) multi-label conformal classification with distribution-free coverage guarantee ($1 - \alpha$), neutral pre-scoring options (`NeutralOptionSchema` + post-adjudication rationale synthesis), and unified `/v1/decisions` client.
- ⚖️ **Justification-Driven ATMS DAG, Change Weight $W(d)$ & Anti-Domino Gate:** Workspace-native causal dependency graph (`decisions.ledger.json` `DecisionLedgerDocument v2.0`) with 4 deterministic graph-exploration tools (`searchDecisionLedger`, `getDecisionNodeDetails`, `traverseDecisionDependencies`, `getSectionGoverningDecisions`), multi-signal candidate retrieval, batched relational adjudication (`POST /v1/decisions`), 4-source Change Weight $W(d) \in [10, 100]$, and Intent-Aware Anti-Domino Override Gate (`CONSTRAINED_BY_PRIOR`, `ESCALATE_TO_HITL`, `LOCALIZED_OVERRIDE`).
- 🧠 **Elixent Native Graph Engine, 18-Channel AgentGraphState & 9 Canonical Nodes:** Zero-dependency TypeScript state-machine runtime (`ElixentNativeGraphRunner` in `src/core/agent/engine/runner.ts` and `src/core/agent/graph.ts`) with zero `@langchain/*` dependencies, featuring strict `(state, ctx)` separation (`AgentGraphState` vs. `AgentRuntimeContext`), 18 JSON-serializable state channels, pure synchronous reducers (`applyStateDelta`), 9 Replay-Safe Canonical Nodes governed by 6 deterministic state-predicate gates (`G-01..G-06`), replay-safe stateless HITL interrupts (`hitl_clarification_node`), and single-table AES-256-GCM checkpoint persistence (`agent_checkpoints`).

---

## Architectural Statement: Custom Ground-Up Synchronization Engine

> [!IMPORTANT]
>
> ### Design Rationale & Concurrency Problem-Solving Mastery
>
> A defining engineering pillar of LUGX is its **custom, zero-dependency offline-first synchronization and concurrency engine** (`src/lib/sync/*`), designed and built entirely from scratch without relying on third-party synchronization frameworks or reference projects.

### 1. The Engineering Intent

The decision to build a ground-up synchronization engine was driven by the desire to demonstrate **deep algorithmic mastery over distributed state, optimistic updates, and concurrency conflict resolution** in web applications. The resulting engine implements:

- A linear **3-Way Line-Based Merge Algorithm** (`src/lib/sync/conflict-resolver.ts`) that cleanly reconciles concurrent non-overlapping local and remote edits without data loss.
- An **Append-Only Operation Log** tracking granular mutations (`insert`, `delete`, `update`, `create`, `rename`, `move`).
- A **Bounded Worker Queue** with concurrency throttles (4 workers) and exponential backoff with jitter to protect backend connection pools.
- An **Automated Garbage Collection & Compaction Subsystem** with a 7-day TTL window (`src/lib/sync/operations-gc.ts`).
- **Dead-Letter Queue (DLQ)** isolation and **Pre-Operation Rollback Snapshots** ensuring that failed sync operations never corrupt local document state.
- **Cross-Tab Synchronization** orchestrated via native `BroadcastChannel` APIs and centralized write controller guards (`src/hooks/use-editor-orchestrator.ts`).

### 2. Acknowledgment of Standard Solutions (e.g., Yjs)

We are fully aware of industry-standard collaborative editing and CRDT frameworks—most notably **Yjs**—which provide robust real-time shared editing capabilities, have first-class CodeMirror 6 bindings, and were evaluated during early architecture reviews.

The decision to implement a custom engine rather than adopting Yjs was a **deliberate and conscious design choice** grounded in four core factors:

1. **Project Scope & Focused Personal Utility:** In its current phase, LUGX is engineered as a high-caliber showcase for engineering mastery and as a dedicated tool solving a specific personal bilingual writing workflow. There is no immediate commercial or multi-user collaborative editing requirement that mandates full CRDT state vectors.
2. **Performance & Extreme Lightweight Footprint:** The custom sync engine is lean, purpose-built, and tightly coupled to raw Markdown text. It avoids the significant memory overhead, complex state vector serialization, and heavy bundle weight associated with general-purpose CRDT frameworks.
3. **Zero-Knowledge Cryptographic Incompatibility & Complexity:** Following the implementation of the Zero-Knowledge Cloud Vault, integrating CRDT state vectors would introduce immense cryptographic complexity. Reconciling decentralized encrypted CRDT updates across untrusted server infrastructure requires either complex peer-to-peer session key distribution or homomorphic operational convergence. In a single-user workstation, this imposes heavy memory overhead (tombstones) and device battery drain without functional ROI.
4. **Future Architectural Flexibility:** Clean abstraction boundaries were intentionally established across the system (`EditorAdapter` in `src/components/editor/markdown/editor-adapter.ts`, `useSync` in `src/hooks/use-sync.ts`, and `SyncManager` in `src/lib/sync/sync-manager.ts`). If the platform transitions to a commercial product requiring real-time multi-user live collaboration, the architecture is designed so that the sync layer can either be extended or seamlessly swapped for Yjs without requiring radical structural changes to the editor components, database schema, or UI.

_For the full comparative trade-off matrix, complexity analysis, and quantitative migration thresholds, see the canonical specification in [`docs/architecture/sync/three-way-conflict-resolution.md`](docs/architecture/sync/three-way-conflict-resolution.md)._

---

## Engineering Methodology

> **Deliberate Architecture & AI Orchestration**
>
> LUGX is designed, architected, and directed entirely by Abdullah through deliberate AI orchestration — every technical decision (data model, concurrency strategy, security posture, and trade-off analyses such as the Yjs evaluation in the [Architectural Statement](#architectural-statement-custom-ground-up-synchronization-engine)) originates from human judgment, domain expertise, and rigorous feasibility studies.
>
> Code implementation itself is delegated to and coordinated across advanced AI models under structured, specification-driven direction, with correctness enforced through systematic review gates (type-checking, linting, and 100% passing automated test suites) backed by targeted manual review of critical logic paths — rather than manual line-by-line authorship. This is a conscious engineering methodology choice: the discipline demonstrated throughout [`docs/`](./docs) — the phased execution protocol, the living technical debt register, and the design-vs-reality divergence log — reflects the same rigor a hands-on implementation requires, combined with the proven capability to orchestrate, audit, and systematically steer LLMs to produce robust, rigorously tested software.

---

## Architecture & Tech Stack

| Domain                        | Technology / Specification                                   | Purpose / Implementation Highlights                                                                          |
| ----------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| **Runtime & Framework**       | Vite 6 SPA · TanStack Router · Hono Node.js Server · React 19 · Node.js 22 LTS | Pure Web-standard Hono backend server, typed TanStack client routing, Vite 6 build pipeline                     |
| **Language & Typings**        | TypeScript 5 (Strict Mode)                                   | Full type-safety across client hooks, Hono RPC actions, and DB schemas                                       |
| **Styling & Design System**   | Tailwind CSS 4 · Radix UI Primitives · Lucide Icons          | Dark Glassmorphism, tailored typography, and accessible UI controls                                          |
| **Markdown Editor & Bidi**    | Standalone CodeMirror 6 (`MarkdownEditor` & `EditorAdapter`) | Live AST preview decorations, line-level Bidi isolation, LTR code block lock                                 |
| **Database & ORM**            | PostgreSQL (Neon Cloud / Local) · Drizzle ORM                | Smart Hybrid DB Client (`neon-http` / `pg.Pool`), Migrations 0001–0014 (`src/server/db/migrations/`)         |
| **Authentication & Proxy**    | Supabase Auth SSR · Hono Session Middleware (`src/server/middleware/session-middleware.ts`) | Static fast-path bypass, test-only placeholders, `401` mutations / `303` navs, RFC 6265 dual sign-out clear, 2500ms watchdog |
| **Offline Synchronization**   | Custom Engine · IndexedDB (`textai_db_${userId}`)            | 3-Way Merge, ETag optimistic locks (HTTP 412), Bounded Queue, GC, DLQ                                        |
| **AI LLM Engine**             | Vercel AI SDK v7 (`ai` + `@ai-sdk/google`)                   | NDJSON/SSE streaming, `parseQualifiedModelId`, `StreamGovernor` credit leases, 3-state circuit breaker |
| **Client-Side Cryptography**  | Web Crypto API · Web Workers · BIP-39 · WebAuthn PRF         | PBKDF2-SHA256 600K worker, AES-GCM-256, hardware biometric trust, memory wiping                              |
| **Payment & Billing**         | Stripe SDK · Webhook Signature Verification                  | 8-state fail-closed state machine, partial unique constraint idempotency                                     |
| **Rate Limiting & Telemetry** | Upstash Redis · Sliding Window · Distributed Tracing         | Dual-mode rate limiting (Fail-Open sync, Fail-Closed AI), X-Correlation-ID tracking, ZK log masking          |
| **Testing Harness**           | Vitest · Neon Isolated Branch Integration Runner             | Multi-tier automated verification harness passing 100% (see [Automated Test Suite](#5-automated-test-suite)) |

---

## Project Structure

```
lugx/
├── .github/
│   └── workflows/
│       ├── ci.yml                 # 7-stage CI/CD pipeline (Quality gate, unit, migration, db isolation, build, Playwright E2E, live smoke)
│       └── cron.yml               # Scheduled maintenance workflow (Daily 03:00 UTC & Quota sweepers)
├── docs/                          # Comprehensive technical documentation & governance
│   ├── README.md                  # Master structural map and documentation index
│   ├── CHANGELOG.md               # Versioned engineering changelog (Elixent v0.1.0 to v0.29.0; archived LUGX v1.0.0–v1.46.3)
│   ├── TECHNICAL_DEBT_REGISTER.md # Living register of accepted debts and resolution history
│   ├── DOCUMENTATION_GUIDELINES.md# Rules for authoring, linking, and updating documentation
│   ├── Plans/                     # Active official execution plans (empty — completed plans archived under records/plans/)
│   ├── architecture/              # Elixent architecture suite (01–05), standalone ADRs (adrs/) & subsystem designs (sync/, ai/, security/)
│   ├── reference/                 # Living API contracts (sync-api.md, ui-streaming, test-db isolation)
│   ├── guides/                    # Operational how-tos partitioned by domain (billing/, editor/, ai/)
│   ├── specs/                     # Living technical specifications and architectural blueprints
│   ├── records/                   # Engineering records (incidents/, audits/, closures/, plans/, archive/lugx-v1/)
│   └── .Plans/                    # Internal candidate planning incubator (Arabic, untracked)
├── public/                        # Static brand assets (lugx-icon.svg, icon.svg)
├── src/
│   ├── client/                    # Vite 6 SPA presentation layer & typed TanStack router
│   │   ├── routes/                # 5 canonical route views (home, login, dashboard, editor, account) + workspace layout
│   │   ├── main.tsx               # Client DOM entrypoint (StrictMode mount, QueryClient, TanStack RouterProvider)
│   │   ├── navigation.ts          # Unified navigation adapter (SPA router vs window.location fallback)
│   │   ├── router.tsx             # Type-safe TanStack route tree, validateSearch schemas, 404 boundary & registerRouter(router)
│   │   ├── rpc-client.ts          # Transport-injectable typed Hono RPC client (hc<AppType>; zero server imports)
│   │   └── styles/globals.css     # Client design tokens, Dark Glassmorphism, and Tailwind utilities
│   ├── components/                # Modular React UI components
│   │   ├── agent/                 # AgentChatPanel, HITLQuestionCard & pure Native SVG DecisionGraphExplorer
│   │   ├── editor/                # WorkspaceTabBar, UnresolvedEditsTracker, PendingEditsExitModal, toolbar, search-replace, ghost widget
│   │   │   └── markdown/          # Standalone CodeMirror 6 editor, adapter, and Bidi plugins
│   │   ├── sync/                  # Conflict resolution split-diff dialog and sync status indicators
│   │   ├── ui/                    # Base Radix UI primitives and modal dialogs
│   │   └── vault/                 # Zero-Knowledge vault unlock, setup, PIN, trust & WorkspaceDecryptionWarningModal
│   ├── config/                    # Static configuration (models.config.json, tiers.config.ts)
│   ├── hooks/                     # Custom React hooks (useSync, useEditorOrchestrator, useAIStream, useVault)
│   ├── lib/
│   │   ├── ai/                    # Vercel AI SDK v7 gateway client, stream handler, and key rotation
│   │   ├── config/                # Centralized fail-fast app URL resolution & SSRF/redirect guards (app-url.ts)
│   │   ├── db/                    # Drizzle schema, Smart Hybrid Client, and transactional runner
│   │   │   └── migrations/        # Versioned Drizzle SQL migrations (0001–0014)
│   │   ├── exporters/             # Pure Markdown and Plain Text file export strategies
│   │   ├── parsers/               # File import validators, stream parsers, and PDF/Text extractors
│   │   ├── rate-limit.ts          # Dual-mode Redis sliding window limiter (Fail-Open sync, Fail-Closed AI)
│   │   ├── stripe/                # Stripe client initialization and webhook handlers
│   │   ├── sync/                  # IndexedDB manager, 3-way merge, GC, rollback, log-sanitizer, and ETag engine
│   │   ├── utils/                 # Utility modules (correlation.ts for X-Correlation-ID tracing)
│   │   ├── vault/                 # Vault schemas, key derivation, and local cache helpers
│   │   └── workers/               # Isolated Crypto Web Worker (PBKDF2 600K & AES-GCM)
│   ├── server/                    # Web-Standard Hono app (app.ts), routers, actions, services & node entrypoint (index.ts)
│   │   ├── routes/                # Modular Hono route handlers (files, folders, agent, stripe, cron, health)
│   │   ├── middleware/            # Session validation, correlation ID, rate limiting, and error handling
│   │   ├── actions/               # Domain-level operations (file ops, document ingestion, sync, vault, auth)
│   │   └── services/              # AI settlement, credit metering, and background sweepers
│   ├── test/                      # Centralized test suite partitioned into domain subdirectories
│   │   ├── ai/                    # Gemini AI client, NDJSON streaming, and quota settlement tests
│   │   ├── client/                # TanStack router tree, validateSearch, navigation adapter & SPA hardening tests
│   │   ├── sync/                  # Offline-first sync, conflict resolution, and IndexedDB tests
│   │   ├── vault/                 # Zero-Knowledge vault crypto, WebAuthn PRF, and recovery tests
│   │   ├── parsers/               # PDF worker bridge, spatial table extractor, and Arabic normalizer tests
│   │   ├── editor/                # Standalone CodeMirror 6 editor, toolbar, and autosave tests
│   │   ├── server/                # Node server entrypoint, domain operations, and file operations tests
│   │   ├── auth/                  # Authentication, session guard, and correlation tests
│   │   ├── infrastructure/        # Rate limiting, cron jobs, log sanitizer, and DB health tests
│   │   ├── api/                   # REST route handlers and Stripe webhook live tests
│   │   ├── workspace/             # Multi-workspace isolation, ledger, ZK governance & ZIP export tests
│   │   └── ...                    # Root harness (test-db.ts, test-db-guard.ts, db.setup.ts, load-test-env.ts)
│   └── types/                     # Shared zero-dependency RPC wire DTOs (rpc-contracts.ts) and ambient declarations
├── index.html                     # Vite 6 SPA HTML entrypoint
├── vite.config.ts                 # Vite 6 Environments config, fail-closed client/server boundary guard & Hono dev proxy
├── vitest.config.mts              # Default unit/contract test runner (isolated, fast feedback)
├── vitest.constants.mts           # Single source of truth for LIVE test suite registration
├── vitest.live.config.mts         # LIVE integration test runner (isolated Neon test branch)
└── package.json
```

---

## Quickstart & Setup

### 1. Prerequisites

- **Node.js**: `v22.x LTS` (enforced via `.nvmrc` and `package.json` engines)
- **Package Manager**: `npm` (or `pnpm` / `yarn`)
- **Database**: PostgreSQL 14+ instance (Neon Cloud, local Docker, or Supabase)

```bash
# Clone the repository
git clone https://github.com/Abdullah931-stack/ELIXENT.git
cd ELIXENT

# Install project dependencies
npm install
```

### 2. Environment Configuration

Copy the documented `.env.example` template:

```bash
cp .env.example .env
```

Configure the necessary credentials in `.env`:

```ini
# Database Connection (Neon Cloud or standard PostgreSQL)
DATABASE_URL="postgresql://user:password@ep-sample-pooler.region.neon.tech/neondb?sslmode=require"

# Supabase Authentication
VITE_SUPABASE_URL="https://your-project.supabase.co"
VITE_SUPABASE_ANON_KEY="your-anon-key"
SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"

# Upstash Redis (Rate limiting and key rotation circuit breaker)
UPSTASH_REDIS_REST_URL="https://your-redis.upstash.io"
UPSTASH_REDIS_REST_TOKEN="your-redis-token"

# Google Gemini AI (Supports multi-key pool with automated fallback)
GEMINI_API_KEY="AIzaSyYourPrimaryApiKey"
GEMINI_API_KEY_FALLBACK_1="AIzaSyYourFallbackKey1"

# Stripe Monetization
STRIPE_SECRET_KEY="sk_test_..."
STRIPE_WEBHOOK_SECRET="whsec_..."
STRIPE_PRO_MONTHLY_PRICE_ID="price_..."
STRIPE_ULTRA_MONTHLY_PRICE_ID="price_..."

# Maintenance Security Secret
CRON_SECRET="your-32-byte-random-secret"
```

### 3. Database Migrations

Deploy the Drizzle schema and database constraints:

```bash
npx drizzle-kit push
```

### 4. Running Development & Production

```bash
# Run local development server (Vite 6 SPA + Hono dev server on port 3000)
npm run dev

# Compile production build
npm run build

# Start production server
npm run start
```

### 5. Automated Test Suite

<!-- BEGIN:SSOT_TEST_METRICS_TABLE -->
| Test Category | Engine / Configuration | Target Environment | Suites / Specs | Passing Tests | Pass Rate |
| :--- | :--- | :--- | :---: | :---: | :---: |
| **Unit & Contract** | Vitest (`vitest.config.mts`) | Pure In-Memory / Zero Network | 165 | 3348 | 100% ✅ |
| **Live Multi-System** | Vitest (`vitest.live.config.mts`) | Isolated Neon PostgreSQL Branch | 22 | 101 | 100% ✅ |
| **E2E Browser Journeys** | Playwright (`playwright.config.ts`) | Headless Chromium / Full App | 18 | 20 | 100% ✅ |
<!-- END:SSOT_TEST_METRICS_TABLE -->

The test suite is partitioned into three isolated tiers to ensure comprehensive verification from pure algorithms to real-browser interactions:

| Command             | Scope                        | Characteristics                                                        |
| ------------------- | ---------------------------- | ---------------------------------------------------------------------- |
| `npm run test`      | Unit & Contract test suites  | Zero external dependencies; runs in ~10–25s.                           |
| `npm run test:live` | LIVE Integration test suites | Executes against an isolated Neon test branch with fail-closed guards. |
| `npm run test:e2e`  | Browser E2E User Journeys    | Headless Chromium Playwright journeys covering auth, sync, AI, vault & workspaces (see SSOT table above). |
| `npm run test:all`  | Full Test Verification       | Comprehensive pre-deployment verification (unit + live).               |

```bash
# Execute unit/contract test suites (165 test files, 3348 tests)
npm run test

# Execute live database integration test suites on isolated Neon branch (22 test files, 101 tests)
npm run test:live

# Execute browser-driven Playwright E2E tests (18 spec files, 20 user journeys)
npm run test:e2e

# Run Playwright E2E tests in interactive UI mode
npm run test:e2e:ui

# Verify strict TypeScript typing
npx tsc --noEmit

# Execute ESLint verification
npm run lint

# Verify documentation internal links (deterministic offline checker)
npm run lint:links
```

---

## Core Engineering Subsystems

### 1. Standalone Markdown Editor & Bidirectional (Bidi) Engine

LUGX operates exclusively on pure **UTF-8 Markdown strings** (normalized via Unicode NFC and LF line endings), completely eliminating intermediate HTML parsing, serialization, and sanitization.

- **Engine-Agnostic EditorAdapter (`src/components/editor/markdown/editor-adapter.ts`):** Encapsulates the underlying CodeMirror 6 instance, exposing clean transactional methods (`getValue`, `setValue`, `replaceRange`, `getSelection`, `setSelection`).
- **Live Preview Decorations:** Markdown syntax tokens are dynamically hidden or styled using non-destructive CodeMirror 6 `Decoration.mark` overlays without mutating the underlying document buffer.
- **Bidirectional (Bidi) Engine (`src/components/editor/markdown/bidi-line-plugin.ts`):**
  - Implements line-level text direction analysis with 3 selectable modes: `auto` (auto-detects first strong RTL/LTR character per paragraph), `rtl`, and `ltr`.
  - Enforces **Code Block LTR Locking** (`lockCodeBlocksLTR`): Fenced code blocks (` ``` `) and inline code segments are strictly locked to LTR rendering regardless of surrounding Arabic text.
  - Direction controls integrated seamlessly via `DirectionMenu` in the editor toolbar.
- **Multi-Range Atomic Transactions in Search & Replace (`src/components/editor/search-replace.tsx`):**
  - Searches operate over UTF-16 document offsets.
  - `Replace All` batches all mutation targets into a single CodeMirror `ChangeSpec[]` transaction, preventing offset shifting and preserving complete undo/redo history.

### 2. Offline-First Synchronization & 3-Way Merge Engine

```mermaid
flowchart TD
    A["Local Edit in Editor"] --> B["Save to IndexedDB<br/>(textai_db_${userId})"]
    B --> C["Append to Operation Log"]
    C --> D["Background Sync Queue<br/>(Max 4 Workers)"]
    D --> E["Push to Server:<br/>PUT /api/files/:id (If-Match: local.etag)"]
    E -->|200 OK| F["Update Local ETag & Advance Monotonic Version"]
    E -->|412 Conflict| G["Fetch serverVersion & Execute 3-Way Line Merge"]
    G -->|Non-Overlapping| H["Auto-Commit Merged State"]
    G -->|Overlapping| I["Interactive Visual Split-Diff Dialog"]

    style A fill:#E3F2FD,stroke:#1565C0,stroke-width:2px
    style B fill:#EDE7F6,stroke:#512DA8,stroke-width:1.5px
    style C fill:#F1F8E9,stroke:#558B2F,stroke-width:1.5px
    style D fill:#FFF3E0,stroke:#E65100,stroke-width:1.5px
    style E fill:#E1F5FE,stroke:#0288D1,stroke-width:1.5px
    style F fill:#E8F5E9,stroke:#2E7D32,stroke-width:2px
    style G fill:#FFEBEE,stroke:#C62828,stroke-width:1.5px
    style H fill:#E8F5E9,stroke:#2E7D32,stroke-width:1.5px
    style I fill:#FFF9C4,stroke:#FBC02D,stroke-width:1.5px
```

- **User-Partitioned IndexedDB (`src/lib/sync/indexeddb.ts`):** Client state is isolated per user (`textai_db_${userId}`), storing `files`, `operations`, and `sync_metadata`.
- **Deterministic 3-Way Merge Engine (`src/lib/sync/conflict-resolver.ts`):**
  - Compares Base Ancestor, Local Dirty State, and Server Remote State.
  - Non-overlapping line modifications are automatically merged and committed without user disruption.
  - Overlapping conflicts trigger the interactive visual split-diff dialog (`src/components/sync/conflict-dialog.tsx`).
- **Bounded Worker Queue & Resilience (`src/lib/sync/sync-manager.ts`):**
  - Concurrency is throttled to 4 parallel workers with adaptive exponential backoff and jitter.
  - Unrecoverable failures are isolated to the Dead-Letter Queue (DLQ).
  - Pre-operation rollback snapshots (`snapshot`) ensure that failed synchronization attempts safely restore previous document state.
- **Automatic Garbage Collection (`src/lib/sync/operations-gc.ts`):** Prunes synced operation logs older than 7 days and compacts historical edits into clean baseline snapshots.

### 3. Real-Time AI Streaming & Dual-Phase Atomic Quota Lifecycle

```mermaid
flowchart TD
    A["User AI Request"] --> B["1. Reserve Credits<br/>(credit_ledger_transactions Lease in PostgreSQL)"]
    B -->|Insufficient Quota| C["Return HTTP 429 Rate Limit"]
    B -->|Quota Reserved| D["2. Stream Agent SSE via /api/agent/stream"]
    D -->|Stream / Provider Failure| E["Atomic Quota Refund<br/>GREATEST(usage - n, 0)"]
    D -->|Stream Success| F["Inline Ghost Preview Card<br/>(CMStreamingGhostWidget)"]
    F --> G{"User Decision Trigger"}
    G -->|Accept / Apply| H["Atomic Commit Server Transaction & Local Replace"]
    G -->|Reject| I["Discard Preview (No Document Mutation)"]
    G -->|Retry| J["Release Lease & Re-trigger Stream"]

    style A fill:#E3F2FD,stroke:#1565C0,stroke-width:2px
    style B fill:#EDE7F6,stroke:#512DA8,stroke-width:1.5px
    style C fill:#FFEBEE,stroke:#C62828,stroke-width:1.5px
    style D fill:#E1F5FE,stroke:#0288D1,stroke-width:1.5px
    style E fill:#FFEBEE,stroke:#C62828,stroke-width:1.5px
    style F fill:#E8F5E9,stroke:#2E7D32,stroke-width:2px
    style G fill:#FFF3E0,stroke:#E65100,stroke-width:1.5px
    style H fill:#E8F5E9,stroke:#2E7D32,stroke-width:1.5px
    style I fill:#ECEFF1,stroke:#455A64,stroke-width:1.5px
    style J fill:#FFF9C4,stroke:#FBC02D,stroke-width:1.5px
```

- **Micro-Credit Dual-Phase Settlement (`src/server/services/ai-settlement-service.ts`, `src/lib/metering/stream-governor.ts`, `src/lib/metering/lua-scripts.ts`, & `src/lib/metering/cold-start.ts`):**
  - Credits are reserved prior to generation by creating an active lease in `credit_ledger_transactions` with a 5-minute TTL and debiting `users.credit_balance_micro`.
  - Eliminates TOCTOU race conditions across concurrent requests in the Web-standard Hono runtime.
  - Downstream system stream failures, timeouts, or pre-TTFT client aborts immediately trigger atomic, zero-bounded refunds (`GREATEST(column - n, 0)`). User-initiated aborts (`stopStream`) execute instantaneously (< 50ms) without blocking network calls, dismantling ghost decorations immediately while the server autonomously commits post-TTFT consumption per the Dual-Side Inversion Protocol (TD-05 & Explicit Settlement Policy §4-D).
- **Unified Inline Interactive Preview Card (`src/components/editor/markdown/streaming-ghost.ts`):**
  - Eliminates static top preview panels in favor of an inline CodeMirror 6 `WidgetType` positioned at the exact document mutation point.
  - Dynamic coordinate mapping via `tr.changes.mapPos` ensures preview decorations adjust smoothly to concurrent user edits.
  - Real-time action controls: `Stop Generation` during active streaming, followed by explicit decision buttons (`Accept`, `Reject`, `Retry`) upon stream completion.
- **Distributed Circuit Breaker & Key Pool (`src/lib/ai/key-rotation.ts`):**
  - 3-state circuit breaker (`CLOSED`, `OPEN`, `HALF-OPEN`) tracking failures in Upstash Redis.
  - Multi-key rotation pool with automated 4-tier model cascade: `gemini-3.8-flash` (primary) → `gemini-3.6-flash` (fallback) → `gemini-3.5-flash-lite` (secondary) → `gemini-3.1-flash-lite` (tertiary).
- **Dual-Layer Quota Guard & Information Shielding (`src/lib/rate-limit.ts` & `src/server/routes/agent.routes.ts`):**
  - Strict 30 requests / 60 seconds rate limiting via `aiStreamRateLimiter` failing closed upon Redis outages with `Retry-After >= 1`.
  - Information disclosure protection: Unhandled upstream model errors are shielded behind safe, standardized HTTP 500 envelopes containing the request's tracking `correlationId`, preventing internal provider stack leakage.

### 4. Smart Hybrid Database Client & Neon Isolated Test Infrastructure

- **Dual-Protocol Database Client (`src/server/db/index.ts` & `src/server/db/transactional.ts`):**
  - **Neon Serverless Protocol:** Uses `@neondatabase/serverless` over HTTP/WebSocket for ultra-low latency query execution in cloud and Web-standard Hono runtimes.
  - **Node-Postgres Protocol:** Automatically falls back to standard `pg.Pool` over TCP when running in local Docker containers, CI pipelines, or non-Neon PostgreSQL environments, eliminating SSL connection pool mismatches.
- **Isolated Branching for Integration Tests (`src/test/test-db-guard.ts`):**
  - Live integration suites execute exclusively against a dedicated, isolated Neon test branch (`TEST_DATABASE_URL`).
  - Fail-closed runtime guards verify branch identity and refuse to boot against production databases.

### 5. Fail-Closed Stripe Subscription Lifecycle & State Machine

- **Exhaustive 8-State Mapping (`src/server/routes/stripe.routes.ts`):** Handles `active`, `trialing`, `past_due`, `canceled`, `unpaid`, `incomplete`, `incomplete_expired`, and `paused`.
- **Zero False Entitlements:** Unrecognized webhook payloads fail closed, aborting transaction execution rather than granting unwarranted tier upgrades.
- **Database-Level Idempotency (`src/server/db/migrations/0004_stripe_constraints.sql`):** Partial unique index `idx_subscriptions_stripe_id_unique` guarantees that duplicate webhook deliveries cannot create duplicate active subscriptions for a single customer.
- **Atomic Audit Trail:** Webhook transactions record state transitions in `subscription_events` alongside user tier updates.

### 6. Scheduled Maintenance & Cron Automation

LUGX features fully automated, cryptographically secured background maintenance routines:

- **Automated Soft-Delete Purge (`src/server/routes/cron.routes.ts`):** Permanently purges documents and folders marked as deleted (`deletedAt`) beyond the 30-day retention window.
- **Automated Expired Quota Reservation Sweeper (`src/server/routes/cron.routes.ts`):** Continuously scans and expires orphaned `credit_ledger_transactions` held for longer than 5 minutes (resolving **TD-02**), releasing held credits back to `users.credit_balance_micro` without manual intervention.
- **Secure Dual-Verb Dispatch:** Both endpoints in `src/server/routes/cron.routes.ts` support dual HTTP methods (`GET` for HTTP cron schedulers, `POST` with Bearer token authentication against `CRON_SECRET` for GitHub Actions and external cron monitors) and are dispatched via `.github/workflows/cron.yml`.

### 7. Zero-Knowledge Cloud Vault & Client-Side Hybrid Encryption Subsystem

LUGX delivers a dual-tier client-side Zero-Knowledge encryption engine that keeps sensitive documents end-to-end encrypted at rest and in transit while maintaining full offline productivity.

```mermaid
flowchart TD
    Editor["Editor Surface (CodeMirror 6)<br/>Plaintext Markdown in volatile RAM"]

    Standard["Standard File (isEncrypted: false)"]
    Vault["Vault File (isEncrypted: true)"]

    Editor --> Standard
    Editor --> Vault

    Standard --> SyncPlain["TLS Sync to PostgreSQL"]
    Vault --> Worker["Crypto Web Worker (PBKDF2 600K / AES-GCM-256)<br/>Non-Extractable Keys · Buffer Zeroing (.fill(0))"]

    Worker --> IDBLocal["Encrypted Local IndexedDB (LocalDeviceKey)"]
    Worker --> CloudCipher["Encrypted Envelope over TLS (AES-GCM-256)<br/>AAD: zk:v1:file:${userId}:${fileId}"]

    Vault -.-> AIGate["AI Gatekeeper: HTTP 403 & UI Suppression<br/>Prevents Plaintext Leakage to AI Models"]

    style Editor fill:#E3F2FD,stroke:#1565C0,stroke-width:2px
    style Standard fill:#F1F8E9,stroke:#558B2F,stroke-width:1.5px
    style Vault fill:#FFF3E0,stroke:#E65100,stroke-width:1.5px
    style Worker fill:#FFF9C4,stroke:#FBC02D,stroke-width:2px
    style IDBLocal fill:#EDE7F6,stroke:#512DA8,stroke-width:1.5px
    style CloudCipher fill:#ECEFF1,stroke:#37474F,stroke-width:2px
    style AIGate fill:#FFEBEE,stroke:#C62828,stroke-width:1.5px
```

- **Dual-Tier Encryption Architecture:**
  - **Always-On Local At-Rest:** Transparent local encryption of IndexedDB tables using an ephemeral `LocalDeviceKey` generated on device.
  - **Zero-Knowledge Cloud Vault:** Sensitive documents are encrypted client-side using `AES-GCM-256` before hitting any network socket. PostgreSQL stores only ciphertext envelopes; the server possesses zero knowledge of the encryption keys.
- **Crypto Web Worker Isolation (`src/lib/workers/crypto.worker.ts`):**
  - CPU-intensive `PBKDF2-SHA256` derivation (600,000 rounds) is offloaded to a background worker to eliminate UI thread latency.
  - Cryptographic keys use non-extractable WebCrypto handles (`extractable: false`).
  - Temporary memory buffers are proactively wiped via `.fill(0)` in `finally` blocks across all key accessors.
- **Hardware Biometrics & 12-Word BIP-39 Recovery:**
  - **WebAuthn PRF & 6-Digit PIN:** Users can register trusted hardware authenticators (Touch ID, Windows Hello, Face ID) or use a 6-digit Quick PIN for instant unlock.
  - **BIP-39 Recovery Seed:** The Master Key is dual-wrapped with both the password and a 12-word mnemonic phrase, allowing account recovery without re-encrypting existing files.
- **Non-Blocking Sync & Conflict Isolation:**
  - Cloud conflicts on encrypted files while the vault is locked enter a safe `CONFLICT_LOCKED` state without blocking unencrypted file synchronization.
  - Once unlocked, a 3-way Diff3 merge executes with structural syntax integrity checks (`syntax-validator.ts`) before re-encrypting with a fresh CSPRNG IV.
- **Dual-Layer AI Safety Gatekeepers:**
  - Strict UI badge suppression and server-side HTTP 403 rejection on `/api/agent/stream` for encrypted files prevent accidental plaintext leaks to external model providers.

### 8. Client-Side Document Ingestion, Spatial Table Extractor & Arabic Normalization Pipeline

LUGX eliminates server-side PDF processing entirely, purging all legacy `pdf-parse` dependencies and heavy binary uploads. Document ingestion executes 100% inside the browser via isolated Web Workers, translating unstructured binary documents into structured, clean GitHub-Flavored Markdown.

```mermaid
flowchart TD
    File["PDF / MD / TXT Upload"] --> Detector{"Document Format?"}

    Detector -->|MD / TXT| PlainText["Read UTF-8 Plaintext via FileReader"]
    Detector -->|PDF| Worker["Web Worker: pdf.worker.ts (pdfjs-dist)<br/>Page Memory Cleanup (page.cleanup / destroy)"]

    Worker --> SpatialEngine["2D Spatial Clustering Engine (pdf-table-extractor.ts)<br/>Y-Tolerance: 3.5pt · X-Gap: 25pt · RTL Column Alignment"]
    SpatialEngine --> Normalizer["Arabic Unicode Normalizer (arabic-normalizer.ts)<br/>De-spacing · NFKC Un-shaping · BiDi Preservation"]
    Normalizer --> PUAFilter{"Font PUA Scan (pdf-corruption-detector.ts)"}

    PUAFilter -->|Clean| CanonicalMD["Structured GFM Markdown"]
    PUAFilter -->|Corrupted (>15% PUA)| PromptModal["PdfCorruptedFontDialog<br/>Prompt User for On-Demand OCR"]

    PromptModal -->|Run OCR| OCREngine["On-Demand Bilingual OCR (pdf-ocr-engine.ts)<br/>tesseract.js (ara+eng) · Offscreen Canvas"]
    OCREngine --> CanonicalMD
    PlainText --> CanonicalMD

    CanonicalMD --> VaultOption{"Destination Vault?"}
    VaultOption -->|Standard| ServerImport["importFile(textContent: string)<br/>10MB Payload Limit · Null-Byte Scrubbing"]
    VaultOption -->|Encrypted Vault| VaultCrypto["cryptoWorkerBridge.encryptAESGCM()<br/>Deterministic AAD: vault:file:${userId}:${fileId}"]
    VaultCrypto --> ServerImport
```

- **Web Worker PDF Parsing (`src/lib/workers/pdf.worker.ts` & `src/lib/parsers/pdf-worker-bridge.ts`):** Offloads `pdfjs-dist` to an isolated worker thread. Per-page garbage collection (`page.cleanup()`) and document destruction (`pdfDoc.destroy()`) prevent V8 heap accumulation. Supports dual-mode execution (browser Web Worker vs. headless Node.js runner).
- **2D Spatial Markdown Table Extractor (`src/lib/parsers/pdf-table-extractor.ts`):** Detects multi-column tabular data using 2D geometric clustering (`Y_TOLERANCE = 3.5pt`, `COLUMN_GAP_THRESHOLD = 25pt`), handles RTL column reordering for Arabic tables, and produces standard GFM table markup (`| Col 1 | Col 2 |`). Configurable and toggleable via user settings (`pdf-settings.ts`) and dialog quick-actions.
- **Arabic Unicode Normalizer (`src/lib/parsers/arabic-normalizer.ts`):** Pure TypeScript normalizer that resolves disjointed Arabic glyphs via lookahead de-spacing (`\u0600-\u06FF`), normalizes presentation forms (NFKC), and preserves BiDi directionality across mixed English words, numbers, and dates.
- **Embedded Font Corruption Detection (`src/lib/parsers/pdf-corruption-detector.ts`):** Analyzes extracted characters against Unicode Private Use Area (PUA) ranges (`0xE000-0xF8FF`, `0xF0000-0x10FFFD`). Proactively alerts users when non-standard font encodings corrupt text and suggests visual OCR.
- **On-Demand Bilingual OCR Engine (`src/lib/parsers/pdf-ocr-engine.ts`):** Integrates dynamic `tesseract.js` with `ara+eng` trained data cached in Cache Storage. Renders PDF canvases at 2.0x scale with zero initial bundle bloat.
- **Direct Vault Encrypted Import:** Enables direct one-click ingestion into encrypted vaults. Files are encrypted client-side using `AES-GCM-256` with deterministic domain AAD (`vault:file:${userId}:${fileId}`) before leaving the browser.

### 9. Dual-Mode Rate Limiting, Log Sanitization & Distributed Correlation Tracing

To ensure enterprise-grade resilience under load and protect sensitive user secrets in distributed environments, LUGX implements a comprehensive telemetry, isolation, and throttling subsystem.

```mermaid
flowchart TD
    Req["Incoming Request / Hono RPC"] --> CID["Correlation Engine (correlation.ts)<br/>Extract / Generate X-Correlation-ID · Strip CRLF ([^\\w-])"]
    CID --> Limiter{"Dual-Mode Rate Limiter (rate-limit.ts)"}

    Limiter -->|Public / Sync Route| R1["Fail-Open Strategy (onRateLimitError: 'allow')<br/>Upstash Redis Sliding Window · Unhindered Local/Sync Access"]
    Limiter -->|AI Stream Route| R2["Fail-Closed Strategy (onRateLimitError: 'deny')<br/>30 req / 60s · Retry-After >= 1 · Zero Quota Drain"]

    R1 --> ActionExec["Execute Business Logic"]
    R2 --> ActionExec

    ActionExec --> Sanitizer["ZK Log Sanitizer (log-sanitizer.ts)<br/>Token-Boundary Regex ((^|[^a-zA-Z0-9_]))<br/>Redact: vaultKey, privateKey, seedPhrase, auth tokens"]
    Sanitizer --> Telemetry["Sanitized Structured Output (X-Correlation-ID)"]

    ActionExec -->|Catch 500| SafeErr["Opaque 500 Response<br/>Shield internal provider details · Return correlationId"]

    style Req fill:#E3F2FD,stroke:#1565C0,stroke-width:2px
    style CID fill:#EDE7F6,stroke:#512DA8,stroke-width:1.5px
    style Limiter fill:#FFF3E0,stroke:#E65100,stroke-width:2px
    style R1 fill:#E8F5E9,stroke:#2E7D32,stroke-width:1.5px
    style R2 fill:#FFEBEE,stroke:#C62828,stroke-width:1.5px
    style ActionExec fill:#E1F5FE,stroke:#0288D1,stroke-width:1.5px
    style Sanitizer fill:#FFF9C4,stroke:#FBC02D,stroke-width:2px
    style Telemetry fill:#E8F5E9,stroke:#2E7D32,stroke-width:1.5px
    style SafeErr fill:#FFEBEE,stroke:#C62828,stroke-width:1.5px
```

- **Distributed Correlation Tracing (`src/lib/utils/correlation.ts`):**
  - Generates RFC 4122 UUID v4 correlation identifiers when absent, extracts incoming `X-Correlation-ID` headers, and sanitizes characters against CRLF injection (`[^\w-]`).
  - Threaded through Hono RPC & Hono route handlers via `operationId` in `FileOpResult` and propagated across downstream Route Handlers (`/api/files/sync`, `/api/agent/stream`).
  - Included in error responses to enable instant end-to-end incident debugging across client logs, server logs, and Redis monitors.
- **Dual-Mode Rate Limiting Engine (`src/lib/rate-limit.ts`):**
  - **Public & Synchronization APIs:** Operates in **Fail-Open** mode (`onRateLimitError: 'allow'`). If Upstash Redis experiences network latency or downtime, document reads and offline-sync operations proceed uninterrupted.
  - **AI Streaming APIs (`aiStreamRateLimiter`):** Operates in **Fail-Closed** mode (`onRateLimitError: 'deny'`) with a strict 30 requests / 60 seconds limit. If the Redis rate limiter is unreachable, AI requests are rejected with a standardized `Retry-After: 60` response to prevent runaway LLM provider costs.
- **Zero-Knowledge Token-Boundary Log Sanitization (`src/lib/sync/log-sanitizer.ts`):**
  - Implements word-boundary denylist regex matching (`(^|[^a-zA-Z0-9_])`) to redact sensitive cryptographic tokens (`vaultKey`, `privateKey`, `seedPhrase`, `kek`, `salt`, `authorization`).
  - Eliminates false positives on benign identifiers (such as `key: value` or `keyboard`), guaranteeing that zero plaintext encryption secrets or session tokens leak into Web-standard Hono runtime stdout or external observability drains.

### 10. Live Multi-System Integration & Isolated Database Test Infrastructure

To ensure platform-wide stability across complex asynchronous boundaries, LUGX deploys a dedicated, fail-closed integration tier executing against a real isolated Neon PostgreSQL database branch (`ep-dry-rain-b1kfmpgk-pooler`) and Upstash Redis instances with zero persistence-layer mocks.

- **Serialized Execution Invariant (`vitest.live.config.mts`):** Integration suites execute under `singleFork: true` serialization to prevent concurrent database teardown races and connection pool starvation across suites.
- **Fail-Closed Database Guard (`src/test/test-db-guard.ts`):** Enforces strict endpoint inspection before connection pool creation, terminating execution immediately if credentials point to main production branches or non-test hosts.
- **Seven Core Multi-System Integration Axes Verified:**
  1. _Files & Sync Lifecycle:_ Real row initialization, debounced auto-save persistence, 3-way Diff3 merge resolution, and deterministic ETag generation.
  2. _AI Happy Path & Atomic Commit:_ Quota reservation leases, streaming NDJSON with correlation tracing, and atomic ACID commits (file version bump + quota settlement + usage advancement) in a single database transaction.
  3. _AI Failure & Quota Sweeper (TD-02):_ Upstream provider error handling, client abort propagation, single-refund idempotency, and automated cron sweepers (`/api/cron/expire-reservations`) with bounded 100-row batch execution.
  4. _Stripe Billing & Event Ledger:_ Live HMAC signature verification, ACID event deduplication in `subscription_events`, and terminal state protection.
  5. _Zero-Knowledge Encrypted Vault:_ Client-side AES-GCM-256 encryption, deterministic AAD context binding `vault:file:${userId}:${fileId}`, optimistic concurrency control on ciphertext versions, and HTTP 403 AI shielding.
  6. _Document Ingestion Pipeline:_ Disguised binary rejection (PE/ELF/ZIP magic bytes), PostgreSQL null-byte scrubbing, and 100% round-trip fidelity.
  7. _Tenant Isolation & Security Boundary:_ 404 Anti-Enumeration masking across unauthorized files, folders, and stream operations.
- **Consolidated 8-Stage Lifecycle Scenario (`src/test/infrastructure/multi-system-lifecycle.live.test.ts`):** Validates all platform subsystems combined in an end-to-end sequential scenario under live transactional conditions.

### 11. Browser-Driven End-to-End (E2E) Testing with Playwright

To validate full platform functionality under real user conditions, LUGX implements an automated browser test harness built on **Playwright v1.63.0** executing in headless Chromium against an isolated Vite preview / Hono web server (`port: 3001`) and the dedicated Neon PostgreSQL test branch (`TEST_DATABASE_URL`).

- **Deterministic User Journey Execution:** Specification suites under `e2e/specs/` (see the [Automated Test Suite](#5-automated-test-suite) SSOT baseline above) execute with `workers: 1` across SSR cookie authentication, nested folder operations, CodeMirror 6 BiDi typography, offline-first sync with conflict dialogs, client-side PDF extraction, AI streaming and atomic commit, user aborts/rejections (no refund), system AI failures (full refund), 412 collisions, zero-knowledge vault setup and auto-lock, AI shield HTTP 403 gating, Stripe billing ledger updates, 404 anti-enumeration tenant isolation, multi-workspace isolation & `.zip` archive export (`multi-workspace-and-zip-export.spec.ts`), permission mode toggles & persistent multi-tab `GhostHunk` review with `PendingEditsExitModal` (`multi-tab-ghost-and-exit-modal.spec.ts`), interactive Native SVG `DecisionGraphExplorer` & Two-Tier Undo (`decision-graph-and-two-tier-undo.spec.ts`), and workspace-wide ZK encryption governance & all-or-nothing decryption (`workspace-zk-encryption-governance.spec.ts`).
- **Hermetic Isolation & Teardown Invariant:** Every E2E test runs with timestamped test user credentials (`9999...`), followed by explicit teardown via `cleanupE2EUser()` ensuring zero persistent database pollution and zero cross-test interference.
- **Deterministic Release Gating:** Resolves technical debt item **TD-07** with progressive fail-closed CI Stage 6 gating (`scripts/test-ci-gating.mjs`).

### 12. Fence-Aware AST Heading Slicer, Section-Scoped Diff3 & Hybrid BM25 Search Engine

To enable high-precision agentic Markdown manipulation without full-document re-renders or cross-section conflict bleed, Elixent introduces a pure in-memory AST slicing, section-targeted 3-way merge, and path-coupled lexical information retrieval subsystem.

```mermaid
flowchart LR
    MD["Markdown Document"] --> AST["Fence-Aware AST Slicer<br/>CommonMark §4.2 / §4.5 Tracking"]
    AST --> Tree["Heading Tree & Slugs<br/>Breadcrumb Hierarchy & Pure TS SHA-256"]

    Tree --> Slicer["extractSectionBySlug()"]
    Tree --> BM25["Hybrid BM25 Search Engine<br/>Okapi BM25 (k1=1.5, b=0.75) + RSJ IDF"]

    Slicer --> Diff3["diff3MergeSection()<br/>Isolated Section 3-Way Merge"]
    Diff3 --> SyntaxGate["validateMarkdownSyntaxIntegrity()<br/>Algebraic Replacement Invariant"]

    BM25 --> ReDoS["ReDoS Protection & Arabic Normalizer"]
    ReDoS --> Match["LexicalMatchResult[]<br/>Annotated with Heading Breadcrumb & LineRange"]
```

- **Fence-Aware AST Heading Slicer (`src/core/ast/heading-slicer.ts`):** CommonMark §4.2 ATX heading parser and §4.5 code-fence state machine (` ``` ` or `~~~`), ignoring `#` comment lines within code blocks and YAML frontmatter. Computes section spans ($L_{\text{next}} \le L$), hierarchical breadcrumbs (`"Parent > Child"`), Unicode heading slugs with collision resolution, and pure bitwise FIPS 180-4 SHA-256 digests (`computeSectionHash`) with zero `node:crypto` imports.
- **Section-Scoped 3-Way Merge Engine (`src/lib/sync/diff3.ts`):** `diff3MergeSection` executes localized 3-way merges on targeted sections extracted via `extractSectionBySlug`. Quarantines conflicts within section boundaries (`conflict_quarantined`), validates syntax integrity (`validateMarkdownSyntaxIntegrity`), and enforces the algebraic replacement invariant: `live.slice(0, from) + replacementText + live.slice(to) === merged`.
- **Path-Coupled Hybrid BM25 Search Engine (`src/core/workspace/lexical-bm25.ts`):** Okapi BM25 engine with Robertson-Spärck Jones non-negative IDF, coupled with CommonMark AST headings. Features multilingual text normalization (Arabic diacritics/variants, Persian/Arabic-Indic digits to ASCII, Latin case-folding), compound subword tokenization (`camelCase`, `snake_case`, `kebab-case`), and 3-layer ReDoS protection (100-character cap, nested quantifier static guard, try/catch literal fallback).

### 13. Zero-Knowledge Vault Boundary, Encrypted Checkpoints & Cloud Workspace Provider

To enable intelligent agentic synthesis and multi-file reasoning over sensitive encrypted documents without violating zero-knowledge guarantees, Elixent introduces a request-scoped ephemeral pointer dereferencer, authenticated checkpoint encryption serializer, and tenant-isolated PostgreSQL workspace provider.

```mermaid
flowchart TD
    ClientReq["Client Request (/api/agent/stream)<br/>ephemeralVaultPayloads: { [fileId]: plaintext }"] --> Scope["runWithEphemeralVaultScope<br/>Node.js AsyncLocalStorage Scope"]

    Scope --> Prov["CloudPostgresWorkspaceProvider<br/>Tenant & Workspace Check: files.workspaceId & files.userId<br/>Consent Gate: userVaultProfiles.allowAIOnEncryptedFiles"]

    Prov -->|readSectionByHeading| EphemMap["EphemeralVaultMemoryMap (ALS)<br/>Store Uint8Array Plaintexts"]
    EphemMap -->|Emit Pointers| Ptr["vault_ref://${fileId}#${headingSlug}"]
    Ptr --> State["AgentGraphState Channels<br/>Strictly Zero Plaintext in State Channels"]

    State --> Checkpoint["encryptAgentGraphState (checkpoint-serializer.ts)<br/>assertNoVaultPlaintextLeak() (>= 4 chars guard)"]
    Checkpoint -->|Pass| HKDF["HKDF-SHA-256 Key Derivation"]
    HKDF --> AES["AES-256-GCM Cipher (AAD: elixent:v1:checkpoint:json)"]
    AES --> Saver["agent_checkpoints Table (BYTEA Envelope)"]

    State -->|Prompt Compile / Diff3| Resolve["resolveVaultRefJustInTime()<br/>Dereference Pointers strictly at Call Site"]
    Resolve --> PromptExec["LLM Dispatch / Section Diff3 Merge"]

    Scope -->|Finally Block| Wipe["zeroOutEphemeralVaultMemory()<br/>buffer.fill(0) & map.clear()"]
```

- **Ephemeral Vault Memory Map (`src/lib/vault/ephemeral-memory-map.ts`):** Request-scoped in-memory storage using Node.js `AsyncLocalStorage` (`runWithEphemeralVaultScope`). Decrypted vault sections are sliced in memory and substituted with opaque reference pointers formatted as `vault_ref://${fileId}#${headingSlug}` (`formatVaultRef`, `isVaultRef`). Pointers are dereferenced just-in-time (`resolveVaultRefJustInTime`) at prompt dispatch or 3-way merge time without mutating `AgentGraphState`. Memory buffers are guaranteed to be zeroed out (`buffer.fill(0)`) in a `finally` block upon request termination or error unwinding.
- **Native Authenticated Checkpoint Serializer (`src/core/agent/checkpoint-serializer.ts`):** Pure native serializer (`encryptAgentGraphState`, `decryptAgentGraphState`) with zero `@langchain/*` dependencies, persisting encrypted state snapshots into the single-table `agent_checkpoints` store (`src/server/db/schema/agent-checkpoints.ts`). Derives a 256-bit encryption key via `HKDF-SHA-256` and encrypts checkpoint states using authenticated `AES-256-GCM` with a 12-byte random IV, 16-byte authentication tag, and Additional Authenticated Data (AAD) bound to `elixent:v1:checkpoint:${innerType}`. Emits UTF-8 JSON `Buffer` representations of `EncryptedCheckpointEnvelope` stored in `agent_checkpoints.encrypted_state_blob`, provides idempotent pass-through preventing double-encryption, and enforces active vault plaintext leak assertions (`assertNoVaultPlaintextLeak`) throwing `CheckpointVaultLeakError` (`VAULT_PLAINTEXT_LEAK_DETECTED`).
- **Cloud PostgreSQL Workspace Provider (`src/core/workspace/cloud-provider.ts`):** Implements `IWorkspaceProvider` backed by server-side PostgreSQL storage (`schema.files`, `schema.workspaces`). Enforces multi-workspace tenant isolation (`files.workspaceId === this.workspaceId`, `files.userId === session.userId`, `deletedAt IS NULL`, `isAiExcluded === false`, throwing HTTP `403 CrossWorkspaceAccessForbiddenError` on cross-workspace access), checks `userVaultProfiles.allowAIOnEncryptedFiles` (default `true`; rejecting encrypted AI operations with HTTP `403 VaultAIAccessDeniedError` when disabled), exposes `listWorkspaceTree`, `createWorkspaceFile`, `deleteWorkspaceFile`, and `readDecisionLedger`/`writeDecisionLedger` (`decisions.ledger.json` with `DecisionLedgerConflictError` `409` OCC), redacts BM25 match excerpts on encrypted files into `vault_ref://` pointers, returns `SectionReadResult` structural hashes (`sectionHash`, `fileEtag`, `fileVersion`), and executes section-scoped 3-way merges (`diff3MergeSection`) with closed-file optimistic persistence (`409 FILE_VERSION_CONFLICT` on concurrent edits) and syntax integrity validation (`validateMarkdownSyntaxIntegrity`).
- **Full-Workspace ZIP Exporter (`src/lib/export/workspace-zip-exporter.ts`):** Builds deterministic binary `.zip` archives (`exportWorkspaceAsZip`, `buildZipArchive`, `computeCrc32`) reconstructing workspace folder hierarchies, failing closed with `ENCRYPTED_EXPORT_UNCONFIRMED` unless `confirmedPlaintextExport === true`, decrypting encrypted files locally when the vault is unlocked, and packaging `decisions.ledger.json` with enriched `affectedSections[].relativePath` mappings.

### 14. Universal Concept Taxonomy, Unified Decision Client & Conformal APS Classifier

To eliminate static enum rigidity and provide mathematically rigorous uncertainty bounds for extracted architectural assertions without System 2 persuasive framing bias, Elixent combines a 9-domain extensible taxonomy, neutral option schema factories, Adaptive Prediction Sets (APS) multi-label conformal classification, and post-adjudication rationale synthesis.

```mermaid
flowchart TD
    Raw["Raw Text / Document Input"] --> Extr["Node 3: assumption_extractor_node<br/>createAssumptionExtractionBatchSchema(projectTags)<br/>NeutralOptionSchema (technicalConstraints only)"]
    Extr --> Scorer["Node 5: jev_conformal_scorer_node<br/>evaluateDecisionBatch (/v1/decisions)<br/>Grounded in workspaceEvidence & governingPriorDecisions"]
    Scorer --> Calib["Conformal APS Classifier<br/>Temperature Scaling & Softmax Scoring"]
    Calib --> APS["Adaptive Prediction Sets (APS)<br/>Marginal Coverage Guarantee (1 - α)"]
    APS --> PostSynth["synthesizePostAdjudicationRationales()<br/>Cites fileId#headingSlug & Dominance Margin m(x)"]
    PostSynth --> Persist["Workspace Artifact: decisions.ledger.json<br/>DecisionLedgerDocument v2.0 (nodes, edges, taxonomy)"]
```

- **Universal Concept Taxonomy & Project Registry (`src/core/agent/taxonomy/predefined-tags.ts` & `src/core/agent/schemas/decision-schemas.ts`):** Establishes 9 predefined knowledge domains (`architecture`, `concurrency`, `cryptography`, `database`, `governance`, `performance`, `resilience`, `security`, `testing`), slug format validation regex (`^[a-z][a-z0-9_]{1,63}$`), project-scoped mutation algebra (`applyProjectTagMutations`, `resolveProjectConceptTags`), empty set invariant protection (`EmptyProjectTaxonomyError`), and dynamic Zod schema factories (`createConceptTagEnum`, `createAssumptionExtractionBatchSchema`, `createCanonicalDecisionBatchSchema`).
- **Epistemic Decoupling & Neutral Option Framing (`src/core/agent/schemas/decision-schemas.ts` & `src/lib/jev/client.ts`):** Pre-scoring options adhere to `NeutralOptionSchema` (`optionKey`, `neutralSummary` $\le 220$ chars, `technicalConstraints: string[]` $1..4$), prohibiting pre-scoring persuasive `rationaleAndPremises`. `evaluateDecisionBatch` passes verbatim `workspaceEvidence` excerpts and `governingPriorDecisions` into `POST /v1/decisions`, while `synthesizePostAdjudicationRationales` deterministically constructs `selectionRationale` and `evaluatedAlternatives` after conformal classification concludes.
- **Conformal APS Multi-Label Classifier (`src/lib/jev/conformal-classifier.ts`):** Adaptive Prediction Sets (APS) multi-label conformal classification providing distribution-free finite-sample marginal coverage guarantees $P(Y \subseteq C(X)) \ge 1 - \alpha$. Features Platt temperature calibration, deterministic cumulative mass ranking, top-1 fallback against empty sets, and calibrated non-conformity quantile thresholds ($q^*$).

### 15. Justification-Driven ATMS DAG, Deterministic Candidate Retriever & Relational Linker

To manage architectural assertions as a workspace-native causal dependency graph (`decisions.ledger.json`) and protect high-inertia foundational decisions against collateral domino overrides, Elixent implements `DecisionLedgerDocument v2.0`, 4 deterministic graph-exploration tools, the 4-source Change Weight $W(d) \in [10, 100]$, and the Intent-Aware Anti-Domino Override Gate.

```mermaid
flowchart TD
    Assump["Extracted Assumptions<br/>(intentType: DIRECT_USER_INSTRUCTION | INFERRED_COLLATERAL_ASSUMPTION)"] --> Retriever["Deterministic Candidate Retriever<br/>(candidate-retriever.ts) + Node 2 Graph Tool Discoveries"]

    Ledger[("Workspace Decision Graph<br/>(decisions.ledger.json v2.0)<br/>DecisionGraphNode & DirectedDecisionEdge[]")] --> Retriever

    Retriever --> Linker["Batched Relational Linker (relational-linker.ts)<br/>evaluateRelationalLinksBatch (POST /v1/decisions)"]

    Linker --> Relations{"Relation Classification<br/>(INDEPENDENT | DEPENDS_ON | REOPENS_OR_OVERRIDES | REFINES)"}

    Relations -->|INDEPENDENT| Stable["Zero Modification<br/>Sibling sub-decisions stably coexist"]
    Relations -->|DEPENDS_ON / REFINES| Upward["Upward BFS Promotion<br/>Promote APPROVED_CONSERVATIVE to CORE"]
    Relations -->|REOPENS_OR_OVERRIDES| AntiDomino{"Anti-Domino Gate (invalidation.ts)<br/>4-Source Change Weight W(d) in [10, 100]"}

    AntiDomino -->|CONSTRAINED_BY_PRIOR| Shield["Auto-Shield Prior Decision<br/>Drop assumption & inject prior into governing_constraints"]
    AntiDomino -->|ESCALATE_TO_HITL| Escalate["Route via G-04 to Node 6<br/>HITL Confirmation with Blast-Radius Preview"]
    AntiDomino -->|LOCALIZED_OVERRIDE| Downward["Downward BFS Invalidation<br/>resolveATMSCascadeBFS & computeMinimalSectionInvalidationMap"]
```

- **Canonical `decisions.ledger.json` Graph & 4 Traversal Tools (`src/core/agent/atms/dag.ts` & `src/core/agent/tools/decision-graph-tools.ts`):** Isomorphic pure TypeScript graph module (`0` `@/server/db` imports) defining `DecisionLedgerDocument` (`schemaVersion: "2.0.0"`, `workspaceId`, `taxonomy`, `nodes: Record<string, DecisionGraphNode>`, `edges: DirectedDecisionEdge[]`), cycle validation (`assertAcyclicDecisionGraph`), and 4 deterministic agent exploration tools (`searchDecisionLedger`, `getDecisionNodeDetails`, `traverseDecisionDependencies` supporting `maxDepth: 1 | 2 | "all"`, and `getSectionGoverningDecisions`).
- **Deterministic Multi-Signal Candidate Retriever (`src/core/agent/atms/candidate-retriever.ts`):** Local candidate retrieval (`retrieveCandidatePriorDecisions`) combining AST section proximity (exact = 1.0, prefix = 0.5, disjoint = 0.0), concept tag Jaccard similarity, and Okapi BM25 lexical similarity across decision prompts and rationales.
- **Waterfall-Free Relational Linker (`src/core/agent/atms/relational-linker.ts`):** Batch adjudicates assumption-candidate pairs across all assumptions in a single call to `POST /v1/decisions` (`evaluateRelationalLinksBatch`), classifying links into `INDEPENDENT`, `DEPENDS_ON`, `REOPENS_OR_OVERRIDES`, and `REFINES`.
- **4-Source Change Weight $W(d)$ & Anti-Domino Override Gate (`src/core/agent/atms/invalidation.ts`):** Computes deterministic inertia weights $W(d) \in [10, 100]$ (`computeDecisionChangeWeight`) combining $W_{\text{structural}} \in [10, 45]$, $W_{\text{provenance}} \in [0, 25]$, $W_{\text{topology}} \in [0, 20]$, and $W_{\text{surface}} \in [0, 10]$. Evaluates `REOPENS_OR_OVERRIDES` conflicts via `evaluateAntiDominoGate` (`CONSTRAINED_BY_PRIOR`, `ESCALATE_TO_HITL`, `LOCALIZED_OVERRIDE`) prior to executing `resolveATMSCascadeBFS` and `computeMinimalSectionInvalidationMap`.

### 16. Elixent Native Graph Engine, 18-Channel AgentGraphState & 9 Replay-Safe Canonical Nodes

To execute autonomous multi-turn reasoning and surgical workspace mutations without `@langchain/*` overhead, silent channel dropping, or 3-table checkpoint fragmentation, Elixent implements the zero-dependency `Elixent Native Graph Engine` (`ElixentNativeGraphRunner`), 18-channel `AgentGraphState`, pure synchronous reducers, and 9 Replay-Safe Canonical Nodes governed by 6 deterministic state-predicate gates (`G-01..G-06`).

```mermaid
flowchart TD
    START(["User Request + AgentRuntimeContext"]) --> N1["1. intent_and_scope_router_node<br/>(Load Workspace Tree & decisions.ledger.json · Classify 9 Intents)"]
    N1 --> G1{"G-01: Intent Gate"}

    G1 -->|CHAT_ONLY| N9["9. direct_response_node<br/>(Stream Conversational / Analytical Response)"]
    G1 -->|All Other Intents| N2["2. search_discovery_node<br/>(8-Tool Dual Toolset · maxSteps=6 · Deterministic toolCallId Synthesis)"]

    N2 --> G2{"G-02: Discovery Gate"}
    G2 -->|WORKSPACE_READ_SEARCH / DECISION_LEDGER_QUERY| N9
    G2 -->|FAST_LOCAL_EDIT| N8["8. workspace_mutator_node<br/>(Generative Section/File Authoring · 3-Way Diff3 · File Create/Delete)"]
    G2 -->|Architectural / Multi-Section Impact| N3["3. assumption_extractor_node<br/>(Extract Assumptions + NeutralOptionSchema Candidates)"]

    N3 --> G3{"G-03: Extraction Gate"}
    G3 -->|0 Assumptions & 0 Invalidations| N8
    G3 -->|Assumptions > 0| N4["4. conflict_and_weight_gate_node<br/>(Relational Linker + 4-Source W(d) + Anti-Domino Gate)"]

    N4 --> G4{"G-04: Anti-Domino & Gap Gate"}
    G4 -->|Evidence Gap & search_loop_count < 3| N2
    G4 -->|ESCALATE_TO_HITL| N6["6. hitl_clarification_node<br/>(Stateless Interrupt & Calibration Feedback)"]
    G4 -->|Ready for Scoring| N5["5. jev_conformal_scorer_node<br/>(Evidence-Grounded POST /v1/decisions + Conformal APS + Post-Hoc Rationale)"]

    N5 --> G5{"G-05: Triage Gate"}
    G5 -->|Unresolved Decisions or Unapproved DELETE_FILE| N6
    G5 -->|All Approved| N7["7. ledger_commit_node<br/>(DAG Cycle Check + Recompute W(d) + Write decisions.ledger.json)"]

    N6 -->|Resumed with User Answers| N7

    N7 --> G6{"G-06: Mutation Gate"}
    G6 -->|No Document/File Mutations| N9
    G6 -->|Document or File Mutations Pending| N8

    N8 --> END(["SSE Stream Complete + Settlement Flush"])
    N9 --> END
```

- **Elixent Native Graph Engine (`src/core/agent/engine/runner.ts`):** Zero-dependency TypeScript state-machine runner (`ElixentNativeGraphRunner`) enforcing strict separation between serializable `AgentGraphState` and request-scoped `AgentRuntimeContext` (`(state, ctx) => Promise<NodeExecutionResult>`). Executes bounded super-step loops (`maxSuperSteps = 25`), persists one atomic AES-256-GCM encrypted checkpoint row per step into `agent_checkpoints` (`src/server/db/schema/agent-checkpoints.ts`), handles first-class `INTERRUPTED` outcomes (`HITL_CLARIFICATION_REQUIRED`, `FILE_DELETION_APPROVAL_REQUIRED`, `ANTI_DOMINO_CONFIRMATION_REQUIRED`, `INSUFFICIENT_CREDITS`), and resumes deterministically from the interrupted checkpoint step without re-running completed upstream nodes.
- **18-Channel Typed `AgentGraphState` & Pure Reducers (`src/core/agent/state.ts` & `src/core/agent/reducers.ts`):** Pure TypeScript interface covering 18 JSON-serializable channels (`messages`, `user_request`, `classified_intent`, `search_report`, `local_inspection_state`, `assumptions`, `governing_constraints`, `scored_decisions`, `master_ledger`, `ledger_edges`, `project_taxonomy`, `unresolved_ledger`, `invalidation_map`, `pending_file_actions`, `question_queue`, `clarification_answers`, `budget_tracking`, `search_loop_count`). Reducers (`applyStateDelta`) enforce immutability, explicit `clearInvalidationMap` resets after `workspace_mutator_node`, `replaceMasterLedger` support for decision eviction, and monotonic loop clamping (`MAX_SEARCH_LOOPS = 3`).
- **9 Replay-Safe Canonical Nodes & 6 State-Predicate Gates (`src/core/agent/nodes/*` & `src/core/agent/graph.ts`):** Replaces the legacy 14-node topology with 9 canonical nodes wired via `createElixentAgentGraph` and 6 pure routing gates (`gateG01..gateG06` + `gateAfterHitlClarification`), wrapped by the native `(state, ctx)` `withMeteredNodeGate` (`src/lib/metering/node-gate.ts`).

### 17. Agent Chat Panel, Multi-Tab Ghost Review, Decision Graph UI & Two-Tier Undo

To connect the autonomous agent core with the multi-file editor workspace, Elixent combines the interactive `AgentChatPanel`, `HITLQuestionCard`, multi-tab persistent ghost review, Native SVG `DecisionGraphExplorer`, workspace Zero-Knowledge decryption governance, and Two-Tier Undo:

- **Architectural Agent Chat Panel (`src/components/agent/chat-panel.tsx`):** Slide-out workspace drawer displaying graph execution progress, ATMS master decision ledger cards (`selectionRationale`, `evaluatedAlternatives`), active ghost hunk review controls, manual `System 2` model selection (`agent-system2-model-select`, populated from `src/config/models.config.json` `STREAMING_GENERATIVE` models with credit rates), 3-mode permission toggles (`safe`, `semi_auto`, `full_auto`), a recoverable `INSUFFICIENT_CREDITS` checkpoint resume card (`paused_insufficient_credits` -> `resumeInsufficientCreditsTask`), one-time `zkAiNotice` (`elixent_zk_ai_notice_shown`), and **`Revert Turn`** / **`Revert Session`** controls (`mutatedTurns`).
- **Multi-Tab Workspace Shell, Persistent Ghost Review & 3-Choice Exit Guard (`src/components/editor/workspace-tab-bar.tsx`, `unresolved-edits-tracker.tsx`, `pending-edits-exit-modal.tsx`, `src/client/routes/workspace-layout.tsx`):** Renders `WorkspaceTabBar` directly above `<Outlet />` with active highlight, encrypted badge, dirty dot, and `pendingGhostCount` pill; closing a tab retains unresolved hunks in `ghostHunksByFileId` (persisted encrypted at rest in IndexedDB `sync_metadata` as `pending_ghost_hunks_${workspaceId}`); surfaces `UnresolvedEditsTracker` (`"N Unresolved Edits in M Files"`) in both `WorkspaceTabBar` and `Sidebar`; and intercepts workspace exits via TanStack Router `useBlocker` (zero `router.tsx` import per `DEF-13`) and `beforeunload` with `Save & Leave`, `Discard & Leave` (`registerDiscardFlushHandler`), and `Stay`.
- **Pure Native SVG Decision Graph Explorer & Workspace Sidebar (`src/components/agent/decision-graph-explorer.tsx`, `src/components/layout/sidebar.tsx`):** Zero-library SVG directed graph using Kahn topological column layering (`computeTopologicalLayers`) and clickable Bézier edges (`DEPENDS_ON`, `REFINES`, `OVERRIDES`), paired with an Inspector Drawer (`selectionRationale`, 4-source `changeWeight` breakdown, upstream/downstream links, `evaluatedAlternatives`, `1 Hop` / `2 Hops` / `Full Chain` depth filter, `Download JSON`, and clickable `affectedSections` `#headingSlug` jump via `CodeMirrorEditorAdapter.scrollToHeading`). `Sidebar` hides `artifactRole === "decision_ledger"` from the Markdown tree and provides the workspace switcher, `Decision Graph` header button, and `Export Workspace (.zip)`.
- **All-or-Nothing Encrypted Workspace Decryption & Pre-Stream ZK Bridge (`src/components/vault/workspace-decryption-warning-modal.tsx`, `src/components/files/file-context-menu.tsx`, `src/hooks/use-ai-stream.ts`):** Intercepts single-file decryption inside encrypted workspaces to enforce explicit full-workspace confirmation (`decryptEntireWorkspaceRpc`), hydrates workspace-scoped non-excluded encrypted files transiently into `ephemeralVaultPayloads` before `/api/agent/stream` (`hydrateWorkspaceVaultPayloads`), and handles `vault_file_commit_required` frames via client-side `SyncCryptoGateway.encryptOutbound` + `toggleFileEncryption`.
- **Two-Tier Undo & `INV-UNDO-SYNC` (`src/components/editor/markdown/editor-adapter.ts`, `src/lib/sync/indexeddb.ts`, `src/lib/sync/rollback.ts`, `src/hooks/use-editor-orchestrator.ts`):** Tier 1 coalesces multi-range edits in `replaceRanges` (`Transaction.userEvent.of("agent.mutation")` + `isolateHistory.of("full")`) and `acceptAllGhostHunks` (`"ai.accept.all"`) for single-step `Ctrl + Z`; Tier 2 queries IndexedDB v2 composite index `idx_operations_workspace_turn` (`['workspaceId', 'turnId']`) via `SyncRollback.rollbackAgentTurn` (restoring `update` files in IDB and pushing to server via `updateFileContent`/`toggleFileEncryption`, soft-deleting `create` files via `deleteFile`, and restoring `delete` files via `restoreWorkspaceFileRpc`), while `handleRevertTurn`/`handleRevertSession` enforce `INV-UNDO-SYNC` (cancelling autosave, pushing restored content via `adapter.setValue(..., "rollback")`, and clearing dirty/ghost state).
- **Single-Layer SSE Transport, Multi-File Decoder & Workspace Hono RPC (`src/server/routes/agent.routes.ts`, `src/lib/ai/stream-handler.ts`, `src/server/routes/rpc.routes.ts`, `src/client/rpc-client.ts`):** Eliminates outer route-level `StreamGovernor` double-billing (`withMeteredNodeGate` meters strictly inside graph nodes), decodes typed `ghost_hunk_proposed`, `file_mutated`, `vault_file_commit_required`, and enriched `interrupt` frames in `consumeAgentStream`, and exposes typed workspace CRUD / all-or-nothing decryption / file-restore RPC facades (`listWorkspacesRpc`, `createWorkspaceRpc`, `updateWorkspaceRpc`, `deleteWorkspaceRpc`, `decryptEntireWorkspaceRpc`, `restoreWorkspaceFileRpc`).
- **Human-in-the-Loop Clarification Gate (`src/components/agent/hitl-question-card.tsx`):** Renders diagnostic question batches emitted by `hitl_clarification_node` with real-time `ClarificationResponseSchema` validation before stateless graph resumption via `POST /api/agent/stream`.
- **Incremental Sync Contract & Real-Time Credit Balance (`src/hooks/use-editor-orchestrator.ts`, `src/client/routes/dashboard-page.tsx`, `src/client/routes/account-page.tsx`):** Coalesces rapid ghost hunk acceptances via immediate local IndexedDB writes (`localRevision += 1`) and debounced server autosave (`useEditorAutosave`, 800ms–1000ms), and surfaces server-authoritative micro-credit balances via `getCreditBalance()`.

---

## Security Architecture

| Security Domain                  | Technical Implementation                                                        | Security Property Enforced                                                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Content Model Security**       | Pure UTF-8 Markdown strings & AST token decorations                             | Zero HTML storage, zero `dangerouslySetInnerHTML`, total elimination of stored XSS vectors.                                                                                                                      |
| **Authentication & Proxy**       | Hono Session Middleware (`src/server/middleware/session-middleware.ts`) with Supabase SSR | Protected routes (`/workspace`, `/dashboard`, `/account`), non-`/api/` static fast-path, test-only placeholders, `401` mutations / `303` navs, RFC 6265 dual `sb-*` sign-out clearing, 2500ms AbortSignal watchdog |
| **Brute-Force & Rate Limiting**  | Sliding window rate limiting on Upstash Redis                                   | Per-user and per-endpoint sliding window limits on Auth, Sync, and AI routes.                                                                                                                                    |
| **Distributed Tracing**          | `X-Correlation-ID` UUID v4 header propagation with CRLF sanitization (`[^\w-]`) | Eliminates HTTP response splitting, header injection, and isolates distributed incidents.                                                                                                                        |
| **Telemetry & Log Sanitization** | Denylist pattern masking with token-boundary regex (`(^                         | [^a-zA-Z0-9_])`)                                                                                                                                                                                                 | Eliminates false positives while guaranteeing zero plaintext secret, PIN, or seed leakage. |
| **Tenant Resource Isolation**    | SQL ownership predicates (`WHERE id = :id AND user_id = :userId`)               | Prevents IDOR and resource enumeration by returning uniform `404 Not Found` for foreign IDs.                                                                                                                     |
| **Financial Webhook Security**   | Cryptographic HMAC signature verification (`stripe.webhooks.constructEvent`)    | Mitigates replay attacks and validates webhook payload authenticity before DB mutation.                                                                                                                          |
| **Database Injection Safety**    | Drizzle ORM parameterized SQL queries                                           | Eliminates SQL injection across all dynamic query and transaction paths.                                                                                                                                         |
| **Zero-Knowledge Encryption**    | AES-GCM-256 · PBKDF2 600K Web Worker · WebAuthn PRF · BIP-39                    | End-to-end Zero-Knowledge storage, domain AAD (`zk:v1:file:${userId}:${fileId}`), RAM zeroing.                                                                                                                   |
| **Fail-Closed AI Protection**    | Upstash Redis fail-closed rate limiting on `/api/agent/stream` (30 req / 60s)   | Prevents unauthorized LLM credit consumption and protects infrastructure during Redis outages.                                                                                                                   |
| **Secure Document Ingestion**    | Web Worker client-side extraction · 10MB text limit · Null-byte stripping       | Zero binary server processing, eliminates server-side PDF attack surface, protects DB.                                                                                                                           |

---

## Documentation Index

Comprehensive architectural designs, specifications, guides, and engineering records are maintained under [`docs/`](./docs). The complete map lives in the **[Documentation Master Index](./docs/README.md)**:

| Directory                                                          | Content Scope                                                                            | Key Documents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| :----------------------------------------------------------------- | :--------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`docs/architecture/`](./docs/architecture/)                       | Elixent architecture suite (`01`–`05`), standalone ADRs (`ADR-006`, `ADR-007`, `ADR-009`–`ADR-016`) & subsystem designs (`sync/`, `ai/`, `security/`) | [`01_architecture_vision_and_adrs.md`](./docs/architecture/01_architecture_vision_and_adrs.md), [`adr_006_unified_vite_tanstack_hono_rpc_architecture.md`](./docs/architecture/adrs/adr_006_unified_vite_tanstack_hono_rpc_architecture.md), [`adr_007_dual_plane_separation_and_als_request_context.md`](./docs/architecture/adrs/adr_007_dual_plane_separation_and_als_request_context.md), [`adr_009`–`adr_016`](./docs/architecture/adrs/), [`02_agent_orchestration_and_decision_engine.md`](./docs/architecture/02_agent_orchestration_and_decision_engine.md), [`03_workspace_ast_editor_and_vault_integration.md`](./docs/architecture/03_workspace_ast_editor_and_vault_integration.md), [`04_credit_metering_and_settlement_architecture.md`](./docs/architecture/04_credit_metering_and_settlement_architecture.md), [`05_data_contracts_and_lugx_migration_plan.md`](./docs/architecture/05_data_contracts_and_lugx_migration_plan.md), [`sync-lifecycle-architecture.md`](./docs/architecture/sync/sync-lifecycle-architecture.md), [`sync-architecture-overview.md`](./docs/architecture/sync/sync-architecture-overview.md), [`editor-sync-orchestration.md`](./docs/architecture/sync/editor-sync-orchestration.md), [`ai-atomic-commit-architecture.md`](./docs/architecture/ai/ai-atomic-commit-architecture.md), [`ai-quota-reservation-lifecycle.md`](./docs/architecture/ai/ai-quota-reservation-lifecycle.md), [`ai-streaming-protocol.md`](./docs/architecture/ai/ai-streaming-protocol.md), [`three-way-conflict-resolution.md`](./docs/architecture/sync/three-way-conflict-resolution.md), [`security-and-rate-limiting.md`](./docs/architecture/security/security-and-rate-limiting.md) |
| `docs/Plans/`                                                      | Active official technical execution roadmaps (English)                                   | *(No active plans — latest completed roadmap archived under [`docs/records/plans/`](./docs/records/plans/) at [`elixent-architectural-evolution-execution-plan.md`](./docs/records/plans/elixent-architectural-evolution-execution-plan.md))* |
| [`docs/reference/`](./docs/reference/)                             | Living API contracts & test runner specifications                                        | [`sync-api.md`](./docs/reference/sync-api.md), [`test-database-isolation.md`](./docs/reference/test-database-isolation.md), [`ui-streaming-readiness.md`](./docs/reference/ui-streaming-readiness.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| [`docs/records/`](./docs/records/)                                 | Engineering records, incident post-mortems, completed plans & closures                   | [`test-database-safety.md`](./docs/records/incidents/test-database-safety.md), [`unified-security-and-engineering-audit.md`](./docs/records/audits/unified-security-and-engineering-audit.md), [`Completed Plans`](./docs/records/plans/elixent-architectural-evolution-execution-plan.md), [`Phase Closures`](./docs/records/closures/), [`Archive`](./docs/records/archive/)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [`docs/specs/`](./docs/specs/)                                     | Living technical specifications & blueprints                                             | [`srs_01`](./docs/specs/srs_01_agent_orchestration_decision_graph_and_weight_engine.md)–[`srs_04`](./docs/specs/srs_04_multi_provider_ai_gateway_and_wallet_metering.md), [`elixent_sync_and_execution_srs.md`](./docs/specs/elixent_sync_and_execution_srs.md), [`offline-sync-blueprint.md`](./docs/specs/offline-sync-blueprint.md), [`ai-key-rotation-and-resilience.md`](./docs/specs/ai-key-rotation-and-resilience.md), [`ui-streaming-requirements.md`](./docs/specs/ui-streaming-requirements.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| [`docs/guides/`](./docs/guides/)                                   | Developer & operational how-tos (`billing/`, `editor/`, `ai/`)                           | [`stripe-integration.md`](./docs/guides/billing/stripe-integration.md), [`stripe-setup.md`](./docs/guides/billing/stripe-setup.md), [`ai-models-config.md`](./docs/guides/ai/ai-models-config.md), [`editor-ui-enhancements.md`](./docs/guides/editor/editor-ui-enhancements.md), [`search-replace-feature.md`](./docs/guides/editor/search-replace-feature.md), [`data-export-guide.md`](./docs/guides/editor/data-export-guide.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| [`docs/records/archive/lugx-v1/`](./docs/records/archive/lugx-v1/) | Historical LUGX v1 baseline archive & living architecture baseline                       | [`01_architecture_vision_and_adrs.md`](./docs/architecture/01_architecture_vision_and_adrs.md), [`DESIGN_VS_REALITY.md`](./docs/records/archive/lugx-v1/foundation/DESIGN_VS_REALITY.md), [`CHANGELOG-LUGX-v1.md`](./docs/records/archive/lugx-v1/CHANGELOG-LUGX-v1.md), [`LUGX platform subscription plans.md`](<./docs/records/archive/lugx-v1/foundation/LUGX platform subscription plans.md>)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Root Registers                                                     | Release history & debt tracking                                                          | [`CHANGELOG.md`](./docs/CHANGELOG.md), [`TECHNICAL_DEBT_REGISTER.md`](./docs/TECHNICAL_DEBT_REGISTER.md), [`DOCUMENTATION_GUIDELINES.md`](./docs/DOCUMENTATION_GUIDELINES.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

---

## Deployment Blueprints

### Standalone Node.js & Vite Static Hosting (Recommended)

Deploy the server as a standalone Node.js process (`node dist/server/index.mjs` via `@hono/node-server`) and serve the Vite SPA bundle (`dist/client/`) statically or behind a reverse proxy (e.g., Nginx, Cloudflare, or standard cloud CDN hosting).

### GitHub Actions Scheduled Cron

Ensure `CRON_SECRET` and `DEPLOY_URL` are added to your repository's **Settings > Secrets and variables > Actions**. The `.github/workflows/cron.yml` workflow triggers daily soft-delete purging (03:00 UTC) and expired quota reservation sweeps automatically.

### Self-Hosted Docker / Linux Server

Schedule maintenance with system cron jobs:

```bash
# Daily 03:00 UTC - Soft-delete purge
0 3 * * * curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://your-domain.com/api/cron/purge-deleted

# Every 10 minutes - Orphaned AI reservation sweeper
*/10 * * * * curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://your-domain.com/api/cron/expire-reservations
```

---

## Contributing & License

Contributions are welcome! Please ensure all submissions maintain 100% test coverage and pass `tsc --noEmit` checks.

Licensed under the [Apache License 2.0](./LICENSE). All reproductions, modifications, and derivative distributions must retain the explicit attribution terms specified in the [NOTICE](./NOTICE) file.

---

<p align="center">
  <sub>Built with precision for high-performance linguistic workflows. © 2026 LUGX.</sub>
</p>
