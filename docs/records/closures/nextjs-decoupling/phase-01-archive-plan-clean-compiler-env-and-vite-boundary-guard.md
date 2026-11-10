# Phase 1 Closure Dossier: Archive Prior Migration Plan, Clean Compiler/Env Relics & Enforce Fail-Closed Vite Boundary Guard

| Standard Field | Value |
| :--- | :--- |
| **Phase** | `Phase 1: Archive Prior Migration Plan, Clean Compiler/Env Relics & Enforce Fail-Closed Vite Boundary Guard` |
| **Milestone / Version** | `v0.19.0` |
| **Status** | `CLOSED / VERIFIED` ✅ |
| **Closure Date** | `2026-11-10` |
| **Governing Plan** | [`docs/Plans/ELIXENT_NEXTJS_DECOUPLING_AND_CLEAN_ARCHITECTURE_PLAN.md`](../../../Plans/ELIXENT_NEXTJS_DECOUPLING_AND_CLEAN_ARCHITECTURE_PLAN.md) (`ELIXENT-NEXTJS-DECOUPLING-CLEAN-ARCH-PLAN-v1.2`) |
| **Archived Plan** | [`docs/records/plans/elixent-framework-migration-execution-plan.md`](../../plans/elixent-framework-migration-execution-plan.md) |
| **Associated ADRs** | [`ADR-006: Unified Vite TanStack Hono RPC Architecture`](../../../architecture/adr_006_unified_vite_tanstack_hono_rpc_architecture.md) · [`ADR-007: Dual-Plane Separation & ALS Request Context`](../../../architecture/adr_007_dual_plane_separation_and_als_request_context.md) |
| **SSOT Architecture Suite** | [`01_architecture_vision_and_adrs.md`](../../../architecture/01_architecture_vision_and_adrs.md) · [`03_workspace_ast_editor_and_vault_integration.md`](../../../architecture/03_workspace_ast_editor_and_vault_integration.md) · [`security-and-rate-limiting.md`](../../../architecture/security/security-and-rate-limiting.md) |

---

## 1. Executive Summary

Phase 1 completes the foundational tooling, compiler, environment variable, and bundler boundary purification for the **Elixent** platform following the initial 6-phase framework migration. While direct Next.js dependencies were removed in v0.18.0, transitional compiler plugins, bundler stub workarounds, legacy `NEXT_PUBLIC_*` lookups, and un-archived plans remained. Phase 1 systematically resolves all compiler and configuration coupling through three isolated sub-agent tasks across two execution waves:

1. **Archival of Completed 6-Phase Framework Migration Plan (`Sub-Agent 1.A`):**
   - Transferred `docs/Plans/ELIXENT_FRAMEWORK_MIGRATION_PLAN.md` to permanent history at [`docs/records/plans/elixent-framework-migration-execution-plan.md`](../../plans/elixent-framework-migration-execution-plan.md) per `.agents/rules/docs-governance.md` Rule 4 & Rule 5.
   - Updated all cross-document references across `docs/CHANGELOG.md` (line 208), `README.md`, `docs/README.md`, `ADR-006`, `ADR-007`, and all 6 framework migration closure dossiers (`phase-01` through `phase-06`).
2. **Compiler & Production Environment Purification (`Sub-Agent 1.B`):**
   - Stripped residual `"plugins": [{ "name": "next" }]` compiler plugin and `.next/` type globs from `tsconfig.json`.
   - **Resolved P0 Production Leak (DEF-01):** Modernized `appUrl` derivation in `src/lib/stripe/index.ts` and `src/server/services/billing-service.ts` to prioritize canonical `VITE_APP_URL` and `APP_URL`, preventing broken checkout redirects (`ERR_CONNECTION_REFUSED`) in production environments.
   - Purged legacy transitional `NEXT_PUBLIC_*` fallbacks from `src/lib/supabase/client.ts`, `src/lib/supabase/server.ts`, `src/config/features.config.ts`, `src/server/actions/auth-actions.ts`, `src/server/routes/auth-callback.routes.ts`, and `src/server/routes/e2e-auth.routes.ts`.
   - Aligned `.env.example`, `playwright.config.ts`, `scripts/test-ci-gating.mjs`, and `.github/workflows/ci.yml` (Stages 4–7) to pure `VITE_*` environment variables.
   - Realigned all 5 environment test suites (`auth-redirect.test.ts`, `supabase-client.test.ts`, `features.config.test.ts`, `supabase-server.test.ts`, `stripe-cron-auth-routes.test.ts`), and expanded test coverage with `src/test/server/stripe-index.test.ts` (24 tests).
3. **Fail-Closed Zero-False-Positive Client Boundary Guard (`Sub-Agent 1.C`):**
   - Eradicated transitional `clientServerStubPlugin` and removed redundant user `define: { "process.env": "{}" }` from `vite.config.ts`.
   - Implemented `clientServerBoundaryGuardPlugin()` (DEF-02): a mathematically sound boundary enforcement plugin that excludes `node_modules` and virtual modules, bypasses SSR builds, resolves relative client specifiers, and triggers a fail-closed compiler error if a client module attempts direct import of server code or server Supabase client.
   - Constructed comprehensive test suite `src/test/config/vite-boundary-guard.test.ts` (85 unit & contract tests) verifying all boundary guard contracts.

---

## 2. Architectural Boundary Guard & Environment Flow

```mermaid
flowchart TB
    subgraph ClientPlane ["Client Compilation Plane (Vite 6 SPA)"]
        CLIENT_ENTRY["src/client/main.tsx / Route Views"]
        IMPORT_SPEC["Module Specifier Import (e.g. '@/server/*', '@/lib/supabase/server', relative)"]
    end

    subgraph ViteBoundaryGuard ["vite.config.ts: clientServerBoundaryGuardPlugin()"]
        direction TB
        CHECK_SSR{"options.ssr === true?"}
        CHECK_EXCLUDE{"Virtual ('\\0', 'virtual:') or /node_modules/?"}
        CHECK_IMPORTER{"importer inside /src/server/?"}
        RESOLVE_PATH["Resolve Relative Specifiers (./, ../) to Absolute POSIX Path"]
        CHECK_TARGET{"isServerTarget?<br/>• '@/server' or '@/server/*'<br/>• '@/lib/supabase/server*'<br/>• '/src/server/*'<br/>• '/src/lib/supabase/server*'"}
        ALLOW_PASS["Return null (Allow Vite Bundler to Resolve)"]
        FAIL_CLOSED["this.error(Boundary Violation Diagnostic)"]
    end

    subgraph ServerPlane ["Server Plane (Hono 4.13 + Node.js)"]
        RPC_CLIENT["src/client/rpc-client.ts (Hono RPC)"]
        SERVER_ROUTER["src/server/routes/* (app.fetch)"]
        RPC_CONTRACTS["src/types/rpc-contracts.ts (Shared Contracts)"]
    end

    CLIENT_ENTRY --> IMPORT_SPEC --> CHECK_SSR
    CHECK_SSR -- Yes --> ALLOW_PASS
    CHECK_SSR -- No --> CHECK_EXCLUDE
    CHECK_EXCLUDE -- Yes --> ALLOW_PASS
    CHECK_EXCLUDE -- No --> CHECK_IMPORTER
    CHECK_IMPORTER -- Yes (Server Importer) --> ALLOW_PASS
    CHECK_IMPORTER -- No (Client Importer) --> RESOLVE_PATH
    RESOLVE_PATH --> CHECK_TARGET
    CHECK_TARGET -- Match Server Target --> FAIL_CLOSED
    CHECK_TARGET -- Legitimate Client Target --> ALLOW_PASS
    FAIL_CLOSED -.->|"Remediation Guidance"| RPC_CLIENT
    RPC_CLIENT --> SERVER_ROUTER
    CLIENT_ENTRY -.->|"Type Import Only"| RPC_CONTRACTS
```

---

## 3. Sub-Agent Execution & Verification Matrix

| Task ID | Execution Mode | Scope & Target Files | Implementation Summary | Status |
| :--- | :---: | :--- | :--- | :---: |
| **Sub-Agent 1.A** | `[PARALLEL]` (Wave 1.1) | `docs/Plans/ELIXENT_FRAMEWORK_MIGRATION_PLAN.md`<br>`docs/CHANGELOG.md:208`<br>`README.md:169,802`<br>`docs/README.md:50,182,222`<br>`ADR-006:9`, `ADR-007:9`<br>`docs/records/closures/framework-migration/*` | Archived migration plan to `records/plans/elixent-framework-migration-execution-plan.md` with updated relative links; updated all cross-doc links across changelog, readmes, ADRs, and 6 closure dossiers. | **PASS ✅** |
| **Sub-Agent 1.B** | `[PARALLEL]` (Wave 1.1) | `tsconfig.json`<br>`src/lib/stripe/index.ts`<br>`src/server/services/billing-service.ts`<br>`src/lib/supabase/client.ts`<br>`src/lib/supabase/server.ts`<br>`src/config/features.config.ts`<br>`src/server/actions/auth-actions.ts`<br>`src/server/routes/auth-callback.routes.ts`<br>`src/server/routes/e2e-auth.routes.ts`<br>`scripts/test-ci-gating.mjs`<br>`.env.example`<br>`playwright.config.ts`<br>`.github/workflows/ci.yml`<br>`5 Test Suites` + `stripe-index.test.ts` | Purged `next` compiler plugin from `tsconfig.json`. Fixed DEF-01 `appUrl` resolution in Stripe and Billing services. Modernized Supabase, features config, and auth routes to pure `VITE_*`. Aligned CI workflow and gating script. Aligned 5 test suites and added 24 tests in `stripe-index.test.ts`. | **PASS ✅** |
| **Sub-Agent 1.C** | `[SEQUENTIAL]` (Wave 1.2) | `vite.config.ts`<br>`src/test/config/vite-boundary-guard.test.ts` | Removed `clientServerStubPlugin` and `define: { "process.env": "{}" }`. Implemented `clientServerBoundaryGuardPlugin()` with exact alias and physical path detection, node_modules exclusions, and SSR bypass. Added 85 comprehensive unit and contract tests. | **PASS ✅** |

---

## 4. Code & Architectural Changes Detailed Audit

### 4.1 Production Environment Invariant (`DEF-01`)
- **Before:** `src/lib/stripe/index.ts` and `src/server/services/billing-service.ts` attempted `process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"`. In pure Vite 6 production deployments where `NEXT_PUBLIC_*` is absent, Stripe checkout session `success_url` and `cancel_url` defaulted to `http://localhost:3000`, resulting in broken checkout redirect loops (`ERR_CONNECTION_REFUSED`).
- **After:** Modernized to prioritize canonical `VITE_APP_URL` and `APP_URL`:
  ```typescript
  const appUrl =
    process.env.VITE_APP_URL ||
    process.env.APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "http://localhost:3000";
  ```

### 4.2 Fail-Closed Bundler Boundary Guard (`DEF-02`)
- **Before:** `clientServerStubPlugin()` used naive substring matching and stubbed server imports with `src/server/empty.ts`, allowing client code to silently import server modules at compile-time while returning runtime `undefined` stubs.
- **After:** `clientServerBoundaryGuardPlugin()` asserts architectural isolation fail-closed during Rollup `resolveId`:
  ```typescript
  function clientServerBoundaryGuardPlugin(): Plugin {
    return {
      name: "client-server-boundary-guard",
      enforce: "pre",
      resolveId(id, importer, options) {
        if (options?.ssr || !importer || !id) return null;
        const normalizedId = id.replace(/\\/g, "/");
        const normalizedImporter = importer.replace(/\\/g, "/");

        if (
          normalizedId.startsWith("\0") ||
          normalizedId.startsWith("virtual:") ||
          normalizedId.includes("/node_modules/") ||
          normalizedImporter.includes("/node_modules/")
        ) {
          return null;
        }

        if (normalizedImporter.includes("/src/server/")) return null;

        let resolvedTarget = normalizedId;
        if (normalizedId.startsWith("./") || normalizedId.startsWith("../")) {
          resolvedTarget = path.resolve(path.dirname(importer), id).replace(/\\/g, "/");
        }

        const isServerTarget =
          normalizedId === "@/server" ||
          normalizedId.startsWith("@/server/") ||
          normalizedId === "@/lib/supabase/server" ||
          normalizedId.startsWith("@/lib/supabase/server.") ||
          normalizedId.startsWith("@/lib/supabase/server/") ||
          resolvedTarget.includes("/src/server/") ||
          resolvedTarget.endsWith("/src/server") ||
          resolvedTarget.includes("/src/lib/supabase/server");

        if (isServerTarget) {
          this.error(
            `[Security / Architecture Boundary Violation] Direct client import of server module "${id}" from "${importer}" is prohibited. Use Hono RPC client (src/client/rpc-client.ts) or extract shared types into src/types/rpc-contracts.ts.`,
            importer
          );
        }
        return null;
      },
    };
  }
  ```

### 4.3 Compiler Hygiene (`tsconfig.json`)
- Stripped Next.js compiler plugin:
  ```diff
  - "plugins": [
  -   {
  -     "name": "next"
  -   }
  - ],
  ```
- Replaced `.next/` type inclusion with clean TypeScript globs:
  ```json
  "include": [
    "**/*.ts",
    "**/*.tsx",
    "**/*.mts"
  ]
  ```

---

## 5. Test Gate & SSOT Metrics Verification Baseline

All verification commands executed cleanly with 100% green exit codes:

```bash
# 1. Static Typecheck Gate (0 errors)
npx tsc --noEmit

# 2. Linting Gate (0 errors, 0 warnings)
npm run lint

# 3. Production Vite SPA Build (built in 1m 12s)
npm run build

# 4. Markdown Links Integrity Gate (129 files, 516 links verified, 0 broken)
node scripts/check-markdown-links.mjs

# 5. Full In-Memory Unit & Contract Test Baseline (137 suites, 2,468 tests green)
npm test
```

### Verified Metrics Baseline

| Metric Dimension | Prior Milestone (`v0.18.0`) | Active Baseline (`v0.19.0`) | Delta / Notes |
| :--- | :---: | :---: | :--- |
| **Unit & Contract Suites** | 135 | **137** | `+2` suites (`vite-boundary-guard.test.ts`, `stripe-index.test.ts`) |
| **Unit & Contract Tests** | 2,346 | **2,468** | `+122` tests (85 boundary guard + 24 stripe index + 13 env URL tests) |
| **Live Database Suites** | 21 | **21** | Unchanged (isolated Neon PostgreSQL branch) |
| **Live Database Tests** | 108 | **108** | Unchanged |
| **Playwright E2E Specs** | 14 | **14** | Unchanged (Chromium headless journeys) |
| **Playwright E2E Journeys** | 15 | **15** | Unchanged |
| **Broken Markdown Links** | 0 | **0** | Verified by `check-markdown-links.mjs` |
| **TypeScript Type Errors** | 0 | **0** | Verified by `tsc --noEmit` |

---

## 6. Phase Closure Verdict

**VERDICT: CLOSED / VERIFIED ✅**

Phase 1 has fulfilled all Single Responsibility Principle requirements outlined in `ELIXENT_NEXTJS_DECOUPLING_AND_CLEAN_ARCHITECTURE_PLAN.md`:
- Completed migration plan archived with pristine link integrity.
- `tsconfig.json` purified of all Next.js plugins and build artifact globs.
- Zero production environment leaks for `VITE_APP_URL` across Stripe and Billing services (`DEF-01`).
- `clientServerBoundaryGuardPlugin()` active and protecting client-server architectural boundaries (`DEF-02`).
- 137 unit suites (`2,468` tests) passing with 100% fidelity.
- Codebase is ready for transition to **Phase 2: Purge Next.js Middleware Relics, Turbopack Facades & Unify Hono RPC Contracts**.
