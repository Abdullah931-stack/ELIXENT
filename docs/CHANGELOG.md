# Changelog — Elixent Platform

All notable architectural, engineering, and governance changes to the **Elixent** platform are documented in this file.

---

## [0.20.2] - 2026-11-11 (Phase 2.6: Post-Audit Architectural, Security & Contract Remediation)

### Core Server Security & URL Hardening (`FIND-01`, `FIND-04`, `FIND-08`)
- **Unified Route Navigation & Cookie Guard (`FIND-01`, `FIND-04`):** Extracted `src/lib/auth/route-guard.ts` exporting pure path normalization, protected route checking, public asset classification, and Supabase auth cookie identification. Replaced regex/substring heuristics in `session-middleware.ts` to block path traversal and case-insensitive bypasses, redirect unauthenticated `GET`/`HEAD` with `303 See Other`, return `401` JSON on mutations/API, and suppress naked cookie appending on sign-out via `clearPendingAuthCookieMutations`.
- **Fail-Safe App URL & Return URL Resolution (`FIND-08`):** Hardened `resolveAppUrl` against directory traversal escapes, added `resolveSameOriginAppUrl` to validate customer portal return URLs against canonical base URL, and enforced `APP_URL` > `VITE_APP_URL` precedence across auth callbacks and Stripe checkout.

### File API, Sync Crypto Separation & Encryption Hardening (`FIND-03`, `FIND-06`, `FIND-09`)
- **Dual-Plane Crypto Boundary Separation (`FIND-03`):** Extracted `src/lib/sync/etag-generator.server.ts` for Node `node:crypto` synchronous operations (`generateETagSync`, `generateEncryptedETagSync`), while `etag-generator.ts` and `sync/index.ts` use pure Web Crypto (`crypto.subtle`), eradicating bundler crypto leaks in client bundles.
- **Encrypted Copy & Create Invariants (`FIND-06`):** Hardened `copyFile` to require non-empty encrypted content and valid encryption metadata when copying encrypted records, and prevented empty-whitespace file titles in `createFile`.
- **REST Path Resolution & Type Coercion Hardening (`FIND-09`):** Hardened `resolveFileId` in `files-api.routes.ts` before rate limiting, rejecting null bodies, arrays, unencrypted PUT overrides without replacement content, and non-integer DELETE query parameters.

### Vite AST Bundler Boundary & Hono RPC Router (`FIND-01`, `FIND-02`, `FIND-07`, `FIND-10`)
- **AST-Based Bundler Boundary Guard (`FIND-02`):** Enhanced `clientServerBoundaryGuardPlugin` in `vite.config.ts` using Acorn AST parsing to detect all `ImportExpression` nodes and server imports in client bundles, with fail-closed load hooks.
- **Dev Proxy Navigation Guard (`FIND-01`):** Routed dev proxy navigation requests through `isGuardedPageNavigation` with preserved redirect status (303) and cookies.
- **Pure RPC Contracts & BigInt Eradication (`FIND-07`):** Aligned Zod schemas in `rpc-contracts.ts` and `rpc.routes.ts`, returning pure JSON DTOs with decimal-string balances (`creditBalanceMicro: string`) and eliminating all BigInt serialization crashes.
- **Complete Router Test Coverage (`FIND-10`):** Extended `app-dispatcher.test.ts` to test all 7 server routers (including `/api/rpc`).

### UI Resilience, Unified Transport & E2E Verification (`FIND-05`, `FIND-07`)
- **Unified RPC Client Fetch Transport (`FIND-07`):** Unified all fetch sites in `stream-handler.ts`, `upgrade-button.tsx`, `sync-pull-engine.ts`, `sync-queue-worker.ts`, and `sync-encrypted-conflict-store.ts` through `(getRpcClientFetch() ?? globalThis.fetch)`.
- **Client Route Error Resilience (`FIND-07`):** Added `getCreditBalanceResult()` in `rpc-client.ts`; protected dashboard and account pages from kicking users out on transient 5xx/network errors.
- **Real Loopback Integration Wiring (`FIND-05`):** Replaced circular mock assertions in `ui-rpc-integration.test.tsx` with genuine loopback integration testing in `ui-rpc-wiring.integration.test.ts`.
- **Playwright E2E 303 Verification (`FIND-01`):** Verified HTTP 303 redirects and session lifecycle in `e2e/specs/01-auth-session.spec.ts`.

### Baseline Verification
- **Verification Baseline:** 143 unit suites (2,937 passing tests), 21 live suites (105 passing tests on Neon branch `ep-dark-queen-ahbapy5k-pooler`), 14 E2E specs (15 journeys), 0 TS errors, 0 ESLint errors/warnings.
- **Phase Closure Dossier:** Documented in [`docs/records/closures/nextjs-decoupling/phase-02-6-remediation-of-p1-p2-p25-audit-findings.md`](./records/closures/nextjs-decoupling/phase-02-6-remediation-of-p1-p2-p25-audit-findings.md).

---

## [0.20.1] - 2026-11-11 (Phase 2.5: Purge Vitest Bridge, Fix Boundary Leaks & Harden RPC Architecture)

### Client-Server Boundary & RPC Transport Purification (`DEF-A01`, `DEF-A02`)
- **Purged In-Process Vitest Bridge from `src/client/rpc-client.ts` (`DEF-A01`):** Permanently deleted `isVitestBridgeActive()`, `vitestLoopbackFetch`, `@vite-ignore` dynamic loaders, and all 7 split dynamic path expressions (`"@" + "/server/..."`). Routed all 26 exported facades exclusively through `getRpcClient().api.rpc...` (`hc<AppType>`) with Zod/error normalization (`parseRpcResult`) and exposed `getRpcClientFetch()`.
- **Externalized Test Transport & Suite Decoupling (`DEF-A01`):** Relocated lazy `vitestLoopbackFetch` injection into `vitest.setup.ts` (`rpcMod.setRpcClientFetch(vitestLoopbackFetch)`), decoupled 7 legacy unit/integration suites onto `@/client/rpc-client`, realigned `rpc-client.test.ts` & `wave-2-2-rpc-unification.test.ts`, and pre-warmed `@/server/app` in `editor-orchestration.live.test.ts`.
- **Rebuilt Fail-Closed Vite Boundary Guard (`DEF-A02`):** Hardened `clientServerBoundaryGuardPlugin` in `vite.config.ts` with canonical `path.resolve` + lowercase normalization (`toCanonicalPosix`), query/hash & `/@fs/` stripping, alias traversal blocking, exact project-root `isWithinDirectory` anchors, and `transform`-phase `esbuild` + `scanDynamicImportsInJs` checks banning `@vite-ignore` and non-literal/dynamic server imports (zero exemptions).
- **Vite 6 Environment Isolation & Types (`DEF-A02`):** Scoped `process.env: {}` suppression strictly to `environments.client.define` and `optimizeDeps.esbuildOptions.define` (omitted under `VITEST` / `mode === "test"`, preserving SSR dev middleware), and added `"types": ["vite/client", "node"]` to `tsconfig.json`.

### Security, Authentication & URL Hardening (`DEF-A03` – `DEF-A06`, `DEF-A08`)
- **Centralized Fail-Fast URL Resolver (`DEF-A03`):** Added `src/lib/config/app-url.ts` (`getAppBaseUrl`, `resolveAppUrl`) enforcing `APP_URL` > `VITE_APP_URL` precedence, Fail-Fast production HTTPS validation, loopback-only (`localhost`, `127.0.0.1`, `[::1]`) non-prod HTTP downgrade, open-redirect blocking, and literal `{CHECKOUT_SESSION_ID}` token preservation in `src/lib/stripe/index.ts` and `src/server/services/billing-service.ts`.
- **Test-Only Supabase Placeholders (`DEF-A04`):** Restricted placeholder credentials strictly to verified test runtimes in `src/lib/supabase/client.ts`, `src/lib/supabase/server.ts`, and `src/server/middleware/session-middleware.ts`, and propagated `createClient()` configuration failures cleanly out of `getUser()` and `getSession()`.
- **RFC 9110 Middleware Gating & Static Fast-Path (`DEF-A05`):** Upgraded `session-middleware.ts` to bypass non-`/api/` static assets (`isStaticAssetPath`) before env/Supabase/cookie cloning, reject unauthenticated protected mutations (`POST`/`PUT`/`PATCH`/`DELETE`), `Accept: application/json`, and `/api/*` with `401 Unauthorized` JSON, and redirect unauthenticated safe `GET`/`HEAD` navigations with `303 See Other`.
- **RFC 6265 Dual Sign-Out Cookie Clearing (`DEF-A06`):** Hardened `POST /api/rpc/auth/sign-out` in `src/server/routes/rpc.routes.ts` to clear validated Supabase auth cookies (`isSupabaseAuthCookie`) across both `httpOnly: true` and `httpOnly: false`, host-only and valid non-localhost/non-IP domain scopes (`resolveCookieDomain`), honoring `__Host-` `Domain` omission and derived `Secure` attributes.
- **Path Validation Guard in File API (`DEF-A08`):** Hardened `resolveFileId` (`normalizeFileId`) in `src/server/routes/files-api.routes.ts` to reject empty IDs, dot segments (`.`/`..`), embedded slashes/backslashes, trailing segments, malformed `%`-encoding, and reserved route names (`api`, `files`, `sync`, `upload`) with HTTP `400`.

### Wire Contracts & Closure Verification (`DEF-A07`)
- **Wire Serialization Types (`DEF-A07`):** Added `WireTimestamp` (`string | Date`) and `UserProfileRecord.creditBalanceMicro: string` in `src/types/rpc-contracts.ts`, aligned `GET /api/rpc/auth/profile` BigInt decimal-string serialization in `rpc.routes.ts`, and updated `FileItem` types in `sidebar.tsx` and `file-tree-item.tsx`.
- **Verification Baseline:** `140` unit/contract suites (`2,745` passing tests), `21` live suites (`105` passing tests on Neon branch `ep-dark-queen-ahbapy5k-pooler`), `14` E2E specs (`15` journeys), `0` TS errors, `0` ESLint errors, Vite 6 production build green (`2,196` modules).
- **Phase Closure Dossier:** Documented in [`docs/records/closures/nextjs-decoupling/phase-02-5-purge-vitest-bridge-fix-boundary-leaks-and-harden-rpc.md`](./records/closures/nextjs-decoupling/phase-02-5-purge-vitest-bridge-fix-boundary-leaks-and-harden-rpc.md).

---

## [0.20.0] - 2026-11-10 (Phase 2: Purge Next.js Middleware Relics, Turbopack Facades & Unify Hono RPC Contracts)

### Session Middleware Purification & RFC 9110 Content Negotiation
- **Purged `next-action` Header Check:** Removed proprietary Next.js action header sniffing from `src/server/middleware/session-middleware.ts`. Protected paths (`/workspace`, `/account`, `/dashboard`) now standardly negotiate RFC 9110 content: unauthenticated requests carrying `Accept: application/json` or targeting `/api/*` return `HTTP 401 JSON` (`{ error: "Unauthorized" }`), while standard browser navigations redirect `307` to `/login?redirectTo=...`.
- **Eradicated Dead Edge Matcher:** Permanently deleted Next.js Edge Middleware matcher `export const config = { matcher: [...] }` (including `/_next/static`, `/_next/image`).
- **Removed Backward Compatibility Aliases:** Purged `export const proxy = handleSessionProxy` from `session-middleware.ts`.
- **Standardized Fallback Env Lookups:** Aligned Supabase environment variable lookups to standard `process.env.VITE_SUPABASE_URL` and `process.env.VITE_SUPABASE_ANON_KEY`.
- **Middleware Test Realignment:** Realigned `src/test/server/session-middleware.test.ts`, `src/test/auth/proxy.test.ts`, and `src/test/server/app-dispatcher.test.ts` (DEF-09) to assert standard content negotiation and purified middleware imports.

### Turbopack Facade Eradication & Server Action Purification
- **Purged `signOut(FormData)` Overload (DEF-08):** Removed Next.js `<form action={signOut}>` `FormData` overload and internal branching from `src/server/actions/auth-actions.ts`. Established a single pure signature returning `Promise<{ success: true; redirectUrl: string }>`. Aligned `auth-signout.test.ts` and `auth-actions.unit.test.ts`.
- **Permanently Deleted `file-ops.ts` Facade (DEF-07):** Removed the legacy Turbopack workaround facade `src/server/actions/file-ops.ts`.
- **Repointed All 15 Callers (erratum: 8 unit + 7 live suites):** Re-pointed all 8 unit/mock test suites and all 7 live database integration suites (`cross-user-ownership.test.ts`, `conflict-resolution.integration.test.ts`, `vault-sync.live.test.ts`, `multi-system-lifecycle.live.test.ts`, etc.) directly to `@/server/actions/files` and `@/server/actions/folders`.
- **Cleaned Residual Next.js JSDocs & Branding:** Replaced `Next.js after()` mentions with `scheduleAfterResponse() (ADR-007 ALS)` in `agent.routes.ts` and `agent-stream-route.test.ts`. Updated JSDoc headers across `import-file.ts`, `vault-actions.ts`, `webhook-dedupe.ts`, and `correlation.ts` to Hono RPC terminology. Updated server entrypoint banner branding from `LUGX` to `ELIXENT`.

### Shared RPC Contract Extraction & End-to-End Typed Client
- **Extracted Shared Zero-Dependency Contracts:** Created `src/types/rpc-contracts.ts` containing all data transfer interfaces (`FileRecord`, `VaultProfileRecord`, `UserProfileRecord`, `FileOpResult`, etc.) and Zod schemas (`fileIdSchema`, `createFileSchema`, `updateFileSchema`, `toggleEncryptionSchema`, etc.) with zero runtime dependencies.
- **Wired Strongly-Typed `hc<AppType>` Client:** Refactored `src/client/rpc-client.ts` to derive `ElixentRpcClient = ReturnType<typeof hc<AppType>>`, re-exporting shared contracts from `@/types/rpc-contracts` and eliminating untyped `hc<never>` casts.
- **Adopted `hono/cookie` with Explicit Expiration (DEF-11):** Updated `POST /api/rpc/auth/sign-out` in `src/server/routes/rpc.routes.ts` to delete all `sb-*` auth cookies via `deleteCookie(c, name, { expires: new Date(0), path: "/", httpOnly: true, sameSite: "Lax" })`.
- **Simplified File Route Params:** Cleaned `src/server/routes/files-api.routes.ts` to directly extract route parameters via `c.req.param("id")`, removing asynchronous param wrapper types.
- **New Contract & Decoupling Test Suites:** Added `src/test/contracts/rpc-contracts.test.ts`, `src/test/server/wave-2-1-decoupling-architecture.test.ts`, and `src/test/server/wave-2-2-rpc-unification.test.ts` (72 tests).
- **Verification Baseline:** 140 unit suites (2,540 passing tests), 21 live suites (105 passing tests), 14 E2E specs (15 journeys), 100% green.
- **Phase Closure Dossier:** Documented in [`docs/records/closures/nextjs-decoupling/phase-02-purge-middleware-relics-turbopack-facade-and-unify-rpc-contracts.md`](./records/closures/nextjs-decoupling/phase-02-purge-middleware-relics-turbopack-facade-and-unify-rpc-contracts.md).

---

## [0.19.0] - 2026-11-10 (Phase 1: Archive Prior Migration Plan, Clean Compiler/Env Relics & Enforce Fail-Closed Vite Boundary Guard)

### Framework Migration Plan Archival & Cross-Document Link Synchronization
- **Archived Completed Framework Migration Plan:** Transferred `docs/Plans/ELIXENT_FRAMEWORK_MIGRATION_PLAN.md` to permanent records at [`docs/records/plans/elixent-framework-migration-execution-plan.md`](./records/plans/elixent-framework-migration-execution-plan.md) per documentation governance Rule 4 & Rule 5.
- **Cross-Document Link Remediation:** Re-pointed all relative links across `docs/CHANGELOG.md` (line 208), `README.md`, `docs/README.md`, `ADR-006`, `ADR-007`, and all 6 framework migration closure dossiers (`phase-01` through `phase-06`).
- **Activated Active Decoupling Plan:** Published [`docs/Plans/ELIXENT_NEXTJS_DECOUPLING_AND_CLEAN_ARCHITECTURE_PLAN.md`](./Plans/ELIXENT_NEXTJS_DECOUPLING_AND_CLEAN_ARCHITECTURE_PLAN.md) as the authoritative active tracked execution plan.

### Compiler & Production Environment Variable Purification (DEF-01)
- **Purged Next.js Compiler Plugins:** Removed `"plugins": [{ "name": "next" }]` and `.next/` type glob inclusions from `tsconfig.json`, standardizing to `["**/*.ts", "**/*.tsx", "**/*.mts"]`.
- **Zero Production Environment Leaks (DEF-01):** Resolved legacy `NEXT_PUBLIC_APP_URL` in `src/lib/stripe/index.ts` and `src/server/services/billing-service.ts` to prioritize `VITE_APP_URL` and `APP_URL`, preventing production checkout session redirect failures.
- **Client & Server Environment Standardization:** Modernized `src/lib/supabase/client.ts`, `src/lib/supabase/server.ts`, `src/config/features.config.ts`, `src/server/actions/auth-actions.ts`, `src/server/routes/auth-callback.routes.ts`, and `src/server/routes/e2e-auth.routes.ts` to pure `VITE_*` environment variables.
- **CI Pipeline & Gating Realignment:** Aligned `.github/workflows/ci.yml` (Stages 4–7), `scripts/test-ci-gating.mjs`, `.env.example`, and `playwright.config.ts` to inject and monitor canonical `VITE_*` keys.

### Fail-Closed Vite Bundler Boundary Guard (DEF-02)
- **Replaced Bundler Stubs:** Eradicated transitional `clientServerStubPlugin` and removed redundant `define: { "process.env": "{}" }` from `vite.config.ts`.
- **Enforced Boundary Guard Plugin:** Implemented `clientServerBoundaryGuardPlugin()` in `vite.config.ts`. Excludes virtual modules and `node_modules`, bypasses SSR builds, resolves relative client specifiers, and triggers a fail-closed compiler error upon direct client import of server modules (`@/server`, `@/server/*`, `@/lib/supabase/server*`, `/src/server/*`).

### Test Suite Alignment & Coverage Expansion
- **Environment Test Realignment:** Realigned 5 environment-dependent test suites (`src/test/auth/auth-redirect.test.ts`, `src/test/auth/supabase-client.test.ts`, `src/test/config/features.config.test.ts`, `src/test/server/supabase-server.test.ts`, `src/test/server/stripe-cron-auth-routes.test.ts`).
- **New Boundary Guard Test Suite:** Added `src/test/config/vite-boundary-guard.test.ts` (85 unit & contract tests) verifying bundler boundary invariants, exclusions, SSR bypass, and diagnostics.
- **Stripe Index Derivation Test Suite:** Added `src/test/server/stripe-index.test.ts` (24 unit tests) verifying production URL derivation and edge fallbacks.
- **Verification Baseline:** 137 unit & contract suites (2,468 passing tests), 21 live suites (108 tests), 14 E2E specs (15 journeys), 100% green.
- **Phase Closure Dossier:** Documented in [`docs/records/closures/nextjs-decoupling/phase-01-archive-plan-clean-compiler-env-and-vite-boundary-guard.md`](./records/closures/nextjs-decoupling/phase-01-archive-plan-clean-compiler-env-and-vite-boundary-guard.md).

---

## [0.18.0] - 2026-11-08 (Phase 6: Final Next.js Purge, Test Suite Alignment to Standard Request & Full CI/E2E Closure)

### Permanent Purge of Next.js Legacy Artifacts & Dependencies

- **Purged Next.js App Router (`src/app/**`):** Permanently deleted all 21 files under `src/app/\*\*`, including legacy route delegates (`api/agent/stream`, `api/files`, `api/folders`, `api/stripe`, `api/cron`), OAuth callback (`auth/callback`), login, dashboard, account, and editor route views, root layout, and styles.
- **Purged Next.js 16 Edge Proxy (`src/proxy.ts`):** Removed legacy Edge proxy middleware; session validation and route guarding are now handled exclusively by Web-standard Hono middleware (`src/server/middleware/session-middleware.ts`).
- **Purged Transitional Modules & Configs:** Deleted `src/server/empty.ts` and `next.config.ts`.
- **Stripped RSC Directives & Markers:** Removed `import "server-only"` markers from `src/server/services/ai-settlement-service.ts` and `src/server/services/billing-service.ts`.
- **Uninstalled Next.js Dependencies:** Removed `next` from `dependencies` and `eslint-config-next` from `devDependencies` in `package.json`. Added modern flat ESLint plugins `@eslint/js` (`^9.39.5`) and `typescript-eslint` (`^8.72.1`).
- **Updated Package Scripts:** Configured `"dev": "vite --port 3000"`, `"build": "vite build"`, and `"start": "npx tsx src/server/index.ts"`.

### Test Suite Alignment to Standard Web Primitives (22 Test Files)

- **Standard Web `Request` Adoption:** Migrated all 22 targeted test suites from proprietary `NextRequest` and `next/server` to standard global Web `Request`, `Response`, `Headers`, and `URL` objects.
- **Eliminated Proprietary Framework Mocks:** Removed all `vi.mock("next/server")`, `vi.mock("next/headers")`, `vi.mock("next/cache")`, and `vi.mock("next/navigation")` mocks across the entire test harness.
- **Unified Background Task Scheduling:** Intercepted background settlement flushes via `scheduleAfterResponse` and `onScheduleAfterResponse` from `@/server/context/request-context` instead of `after()` from `next/server` in `agent-stream-route.test.ts`, `ai-authoritative-stream-settlement.test.ts`, `ai-stream-fileid-governance.test.ts`, and `ai-stream-replay-prevention.test.ts`.
- **Server Request Context Bridge:** Updated authentication test suites (`auth-signout.test.ts`, `auth-actions-rate-limit.test.ts`) to provide mocked headers and cookies via `runWithServerRequestContext` instead of Next.js header mocks.
- **Architectural Boundary Governance:** Updated `ai-client-authority-revocation.test.ts` to assert that `src/client/rpc-client.ts` does not export financial authority functions (`reserveAIQuota`, `commitAIReservation`, `flushPendingSettlementsToPostgres`) and confirmed that `src/app/api/ai/stream/route.ts` remains permanently deleted.
- **Import Realignment:** Re-pointed all test route imports from `@/app/api/...` to `@/server/routes/...` and from `@/proxy` to `@/server/middleware/session-middleware`.

### Tooling, Bundler, CI & E2E Pipeline Alignment

- **Vitest Runners (`vitest.config.mts` & `vitest.live.config.mts`):** Removed the transitional `'server-only'` path alias pointing to `src/server/empty.ts`.
- **Playwright E2E Configuration (`playwright.config.ts`):** Updated `webServer.command` to boot the isolated test server via `npx vite --port ${PORT}` instead of `npx next dev`.
- **TypeScript Configuration (`tsconfig.json`):** Removed `"plugins": [{ "name": "next" }]` and stripped `"next-env.d.ts"` and `".next/**"` from `include`.
- **Flat ESLint Configuration (`eslint.config.mjs`):** Replaced legacy `eslint-config-next` with standard flat `@eslint/js` and `typescript-eslint` configs, preserving strict linting rules and ignoring `dist/**`.
- **GitHub Actions CI Pipeline (`.github/workflows/ci.yml`):** Aligned Stage 5 build step to cache Vite artifacts (`node_modules/.vite` and `dist/`) instead of `.next/cache`, and execute `npm run build` for the Vite 6 SPA production bundle.
- **Framework Invariant Rules (`AGENTS.md`):** Replaced legacy Next.js guidelines with pure Web-standard invariants (Dual-Plane separation, Web primitives exclusivity, zero proprietary framework leakage).

### Verification & SSOT Metrics Baseline

- **Zero-Leakage Grep Verification:** Confirmed 0 occurrences of `from 'next'` or `from "next"` across all source and test directories.
- **Unit & Contract Verification:** 134 suites, 2,348 passing tests (100% green via `vitest.config.mts`).
- **Live Multi-System Integration:** 21 suites, 108 passing tests (100% green via `vitest.live.config.mts`).
- **Browser E2E Journeys:** 14 specs, 15 user journeys (100% green via `playwright.config.ts`).
- **Phase Closure Dossier:** Documented in [`docs/records/closures/framework-migration/phase-06-final-nextjs-purge-test-suite-alignment-and-ci-e2e-closure.md`](./records/closures/framework-migration/phase-06-final-nextjs-purge-test-suite-alignment-and-ci-e2e-closure.md).

---

## [0.17.0] - 2026-11-08 (Phase 5: Build Vite 6 SPA + TanStack Router Presentation Layer & Unified Hono Server Entrypoint)

### Single-Page Application (SPA) Build & Modern Bundler Entrypoint (`index.html`, `vite.config.ts`, `src/client/main.tsx`)

- **Root HTML Shell (`index.html`):** Configured `<html lang="en" class="dark" data-scroll-behavior="smooth">` with Google Fonts preconnections (`Geist`, `Geist Mono`, and `IBM Plex Sans Arabic`), SVG favicon link, and `<div id="root"></div>` mounting `/src/client/main.tsx`.
- **Vite 6 Configuration (`vite.config.ts`):** Configured `@vitejs/plugin-react`, `@` path alias, `envPrefix` (`VITE_`, `NEXT_PUBLIC_`), explicit compile-time `define` bindings for public environment variables, and `dist/client` build output.
- **Vite Dev Server Hono Middleware (`elixentHonoDevServerPlugin`):** Embedded Hono application handling inside the Vite development server. Translates Node requests to standard Web `Request`/`Response`, routes `/api/*` and `/auth/callback` to `app.fetch()`, preserves multi-value `Set-Cookie` headers, pipes streaming response bodies (SSE) with flush support, and enforces session proxy checks (`handleSessionProxy`) on HTML routes to issue 307 redirects before serving `index.html`.
- **Client Server Stubbing (`clientServerStubPlugin`):** Enforces module boundary safety by resolving any server action or service imports to `src/server/empty.ts` during client builds.

### Unified Node.js Server Entrypoint (`src/server/index.ts`)

- **Standalone HTTP Server:** Implemented a unified Node.js server using `@hono/node-server` (`serve({ fetch: app.fetch, port })`).
- **Runtime `server-only` Resolution Hook:** Intercepts `Module._resolveFilename` in Node runtimes to safely resolve `server-only` to `src/server/empty.ts`.
- **Static Asset & SPA Route Fallback:** Mounted `@hono/node-server/serve-static` for `dist/client` and `public/`, and implemented a wildcard route handler (`app.get("*", ...)`) serving `dist/client/index.html` with session validation and diagnostic 404 messaging.

### TanStack Router Route Tree & Navigation Adapters (`src/client/router.tsx`, `src/client/navigation.ts`)

- **TanStack Router Route Tree (`src/client/router.tsx`):** Constructed the complete application route hierarchy with `defaultPreload: "intent"`:
  - `/` -> `HomeRouteView`
  - `/login` -> `LoginRouteView`
  - `/dashboard` -> `DashboardRouteView`
  - `/account` -> `AccountRouteView`
  - `/workspace` -> `WorkspaceLayoutRouteView` (with `<Outlet />`)
    - `/` (index) -> `WorkspaceRouteView`
    - `editor/$fileId` -> `EditorRouteView`
- **Universal Navigation Adapters (`src/client/navigation.ts`):** Exported `useAppParams()` with regex fallback for isolated unit testing, `useAppNavigate()` with TanStack Router and history fallbacks, and imperative `navigateTo(path)` supporting external URL assignment and internal SPA `pushState` + `PopStateEvent` dispatch.

### Migrated Application Route Views (`src/client/routes/**`, `src/client/styles/globals.css`)

- **Route Views Migration:** Migrated all 5 core views (`home-page.tsx`, `login-page.tsx`, `dashboard-page.tsx`, `account-page.tsx`, `workspace-layout.tsx`, `workspace-page.tsx`, `editor-page.tsx`) to `src/client/routes/**` with 100% behavioral parity.
- **Dual-Mode View Contract:** Enabled both client-side SPA rendering via synchronous React wrappers (`RouteView`) and async server/test data-fetching invocation.
- **Global Stylesheet (`src/client/styles/globals.css`):** Migrated Tailwind CSS v4 directives, custom properties, and dark theme palette.

### Verification & SSOT Metrics Baseline

- **Dedicated Phase 5 Test Suites:** Added 4 new suites delivering 47 passing tests (100% green):
  - `src/test/client/navigation.test.ts` (14 tests)
  - `src/test/client/route-views-parity.test.tsx` (20 tests)
  - `src/test/client/router-tree.test.tsx` (9 tests)
  - `src/test/server/node-server-entrypoint.test.ts` (4 tests)
- **Aligned Test Suite:** Updated `src/test/agent/wave-11-2-ui-and-pages.test.tsx` (47 tests) to import views from `@/client/routes/*` and mock `@/client/navigation`.
- **Synchronized SSOT Metrics:** Validated via `scripts/sync-doc-metrics.mjs`:
  - Unit & Contract: 134 suites, 2,351 passing tests (100% green).
  - Live Multi-System Integration: 21 suites, 108 passing tests (100% green).
  - Browser E2E Journeys: 14 specs, 15 user journeys (100% green).
- **Phase Closure Dossier:** Documented in [`docs/records/closures/framework-migration/phase-05-vite-spa-tanstack-router-and-unified-hono-server.md`](./records/closures/framework-migration/phase-05-vite-spa-tanstack-router-and-unified-hono-server.md).

---

## [0.16.0] - 2026-11-08 (Phase 4: Wire Client Hooks & UI Components to Hono RPC Client & Strip Next.js Directives)

### Client Hooks & Orchestration Rewiring (`src/hooks/*`)

- **Editor Orchestrator (`use-editor-orchestrator.ts`):** Removed `"use client"`. Switched all direct imports of `@/server/actions/file-ops` (`getFile`, `updateFileContent`, `toggleFileEncryption`, `renameFile`, `deleteFile`) and `@/server/actions/vault-actions` (`getUserVaultProfile`) to `@/client/rpc-client`. Added an `isProgrammaticUpdateRef.current` guard around `handleEditorChange` to suppress dirty flag flapping during remote synchronization and cross-tab broadcasts.
- **Editor Conflict Reconciler (`use-editor-conflict.ts`):** Removed `"use client"`. Switched file mutation operations (`updateFileContent`, `toggleFileEncryption`, `renameFile`, `deleteFile`) to `@/client/rpc-client`.
- **Client Synchronization & AI Stream Hooks (`use-sync.ts`, `use-ai-stream.ts`):** Stripped `"use client"` directives while preserving 100% of ghost streaming, autosave timers, and IndexedDB local document persistence.

### Router-Agnostic SPA Navigation & UI Components (`src/components/*`)

- **Accessible SPA Navigation (`src/components/ui/app-link.tsx`):** Implemented the `AppLink` component accepting standard anchor attributes and `replace` prop. Intercepts unmodified primary clicks on relative routes, executes `window.history.pushState` / `replaceState`, and dispatches synthetic `PopStateEvent` for SPA navigation, while rendering native `<a href={...}>` anchors for full Testing Library and Playwright locator support (`a[href="/workspace"]`).
- **Sidebar & File Tree Navigation:** Replaced `import Link from "next/link"` with `import { AppLink as Link } from "@/components/ui/app-link"` in `src/components/layout/sidebar.tsx` and `src/components/files/file-tree-item.tsx`.
- **File & Modal Operations:** Rewired file operations in `file-context-menu.tsx`, `folder-picker-modal.tsx`, and `sidebar.tsx` to `@/client/rpc-client`.
- **Zero-Knowledge Vault Modals:** Rewired `create-vault-modal.tsx`, `trust-device-modal.tsx`, `vault-security-card.tsx`, and `vault-unlock-modal.tsx` to invoke master key creation, recovery phrase envelope updates, device trust revocation, and AI permission toggles via `@/client/rpc-client`.

### Universal Directive Stripping & Transitional RSC Bridges

- **Global `"use client"` Purge:** Stripped `"use client"` / `'use client'` from 22 remaining component, hook, and library files (`chat-panel.tsx`, `hitl-question-card.tsx`, `ai-stream-status.tsx`, `ai-toolbar.tsx`, `direction-menu.tsx`, `export-button.tsx`, `markdown-editor.tsx`, `search-replace.tsx`, `export-warning-modal.tsx`, `ocr-settings-card.tsx`, `pdf-corrupted-font-dialog.tsx`, `pdf-import-mode-dialog.tsx`, `upgrade-button.tsx`, `conflict-dialog.tsx`, `sync-indicator.tsx`, `recovery-phrase-modal.tsx`, `stream-handler.ts`).
- **Transitional `"use server"` Purge:** Stripped `"use server"` directives from all 6 server action files (`files.ts`, `folders.ts`, `import-file.ts`, `file-ops.ts`, `vault-actions.ts`, `auth-actions.ts`), preventing server package leakage into client bundles now that zero client files import server actions directly.
- **Transitional Next.js Dev/Build Bridges:** Added `src/app/api/rpc/[[...route]]/route.ts` to route `/api/rpc/*` through Hono `sessionMiddleware` and `rpcRoutes` under Next.js App Router, and added client boundary sections `account-client-sections.tsx` and `workspace-sidebar-client.tsx` to maintain clean Next.js Webpack compilation until Phase 5 SPA migration.

### Verification & SSOT Metrics Baseline

- **Dedicated Phase 4 Test Suites:** Added 5 new suites delivering 65 passing tests (100% green):
  - `src/test/ui/app-link.test.tsx` (26 tests)
  - `src/test/files/file-tree-item.test.tsx` (11 tests)
  - `src/test/files/folder-picker-modal.test.tsx` (10 tests)
  - `src/test/files/file-context-menu-rpc.test.tsx` (9 tests)
  - `src/test/client/ui-rpc-integration.test.tsx` (9 tests)
- **Synchronized SSOT Metrics:** Validated via `scripts/sync-doc-metrics.mjs`:
  - Unit & Contract: 130 suites, 2,304 passing tests (100% green).
  - Live Multi-System Integration: 21 suites, 108 passing tests (100% green).
  - Browser E2E Journeys: 14 specs, 15 user journeys (100% green).
- **Phase Closure Dossier:** Documented in [`docs/records/closures/framework-migration/phase-04-wire-client-hooks-and-ui-to-hono-rpc-and-strip-directives.md`](./records/closures/framework-migration/phase-04-wire-client-hooks-and-ui-to-hono-rpc-and-strip-directives.md).

---

## [0.15.0] - 2026-11-07 (Phase 3: Decouple Server Actions from Next.js Runtime & Mount Typed Hono RPC)

### Server Action Decoupling from Next.js Runtime (`src/server/actions/*`)

- **Files & Folders Subsystem (`files.ts`, `folders.ts`, `import-file.ts`, `file-ops.ts`):** Removed `"use server"` directives and eliminated all eight calls to Next.js `revalidatePath("/workspace")` (7 in `files.ts`, 1 in `folders.ts`). SPA state invalidation is now managed on the client without Next.js React Server Components cache churn, while preserving 100% of function signatures, return shapes (`FileOpResult<T>`), database queries, and cryptographic preconditions.
- **Authentication Actions (`auth-actions.ts`):** Removed `"use server"`, `redirect`, `revalidatePath`, `cookies`, and `headers`. Replaced Next.js header and cookie access with `resolveCookiesAndHeaders()` from `@/server/context/request-context`. Ported `signInWithGoogle` to return structured `{ success: true, redirectUrl: data.url }` (or `{ success: false, error }`) instead of throwing Next.js `NEXT_REDIRECT`. Ported `signOut` to clear `sb-*` cookies by iterating `getAll()` and returning `{ success: true, redirectUrl: "/" }`, while preserving a transitional `FormData` overload for legacy Server Component action callers.
- **Vault & Subscription Actions (`vault-actions.ts`, `subscription-actions.ts`):** Removed `"use server"` directives while keeping 100% of cryptographic envelope operations, master key derivations, recovery rotations, device trust epoch increments, and Stripe customer query routines intact.

### Typed Hono RPC Subsystem & Master Application Mount (`src/server/routes/rpc.routes.ts`, `src/server/app.ts`)

- **Chained RPC Router (`src/server/routes/rpc.routes.ts`):** Constructed a strongly-typed Hono sub-app using method chaining (`new Hono().post(...).get(...)`) and `@hono/zod-validator` (`zValidator('json', ...)`). Mounted 27 distinct RPC endpoints covering all workspace file mutations, folder operations, bulk imports (with `bodyLimit({ maxSize: 10 * 1024 * 1024 })`), zero-knowledge vault management, user profile sync, and authenticated billing credit balance retrieval (`GET /billing/credit-balance`).
- **HTTP Cookie Deletion Headers:** Mapped `/auth/sign-out` to emit explicit HTTP `Set-Cookie` headers with `Max-Age=0; Path=/` for all `sb-*` session cookies alongside JSON status responses.
- **Master Application Mount & Export (`src/server/app.ts`):** Mounted the RPC sub-router at `/api/rpc` on the root Hono application and exported `export type AppType = typeof app`, establishing the single source of truth for end-to-end type safety across client and server.

### Transport-Injectable Hono RPC Client (`src/client/rpc-client.ts`)

- **Typed Client Factory:** Instantiated `hc<AppType>(baseUrl, { fetch: customFetch ?? globalThis.fetch })` via `createElixentRpcClient`.
- **Drop-in Wrapper Functions:** Exported drop-in async wrapper functions matching the exact signatures of the original server actions (`createFile`, `updateFileContent`, `toggleFileEncryption`, `renameFile`, `deleteFile`, `restoreFile`, `copyFile`, `moveFile`, `importFile`, `getUserVaultProfile`, `createUserVaultProfile`, `updateVaultPassword`, `updateVaultRecoveryEnvelope`, `revokeAllTrustedDevices`, `updateVaultAISetting`, `signInWithGoogle`, `signOut`, `syncUserToDatabase`, `getUserProfile`, `updateUserProfile`, plus `getCreditBalance(): Promise<bigint>`).
- **Deterministic In-Memory Test Bridge:** Implemented `isVitestBridgeActive()`: when running inside Vitest without an injected custom HTTP transport, wrapper functions delegate directly to `@/server/actions/*` (and `@/server/services/ai-settlement-service`), enabling existing hermetic integration tests to execute with 100% fidelity without running a live HTTP network server, while browser runtimes and Playwright E2E execute over standard HTTP RPC.

### Verification & SSOT Metrics Baseline

- **Dedicated Phase 3 Test Suites:** Added 4 new suites delivering 126 passing tests (100% green):
  - `src/test/server/files-actions.unit.test.ts` (45 tests)
  - `src/test/server/rpc-routes.test.ts` (37 tests)
  - `src/test/auth/auth-actions.unit.test.ts` (26 tests)
  - `src/test/client/rpc-client.test.ts` (18 tests)
- **Synchronized SSOT Metrics:** Validated via `scripts/sync-doc-metrics.mjs`:
  - Unit & Contract: 125 suites, 2,239 passing tests (100% green).
  - Live Multi-System Integration: 21 suites, 108 passing tests (100% green).
  - Browser E2E Journeys: 14 specs, 15 user journeys (100% green).
- **Phase Closure Dossier:** Documented in [`docs/records/closures/framework-migration/phase-03-decouple-server-actions-and-mount-typed-hono-rpc.md`](./records/closures/framework-migration/phase-03-decouple-server-actions-and-mount-typed-hono-rpc.md).

---

## [0.14.0] - 2026-11-07 (Phase 2: Migrate All 8 API Routes & OAuth Callback to Web-Standard Hono Routers)

### Modular Web-Standard Hono Route Migration (`src/server/routes/*`)

- **Agent SSE Stream Router (`src/server/routes/agent.routes.ts`):** Extracted `POST /api/agent/stream` into `agentRoutes` mounted at `/stream`. Replaced `NextResponse` and Next.js `after()` with standard `Response` and `scheduleAfterResponse()` from `@/server/context/request-context`. Preserved full SSE framing (`start`, `update`, `interrupt`, `error`, `done`), LangGraph execution, ephemeral vault memory hydration, and fail-closed dynamic credit metering via `StreamGovernor`.
- **Files & Sync API Router (`src/server/routes/files-api.routes.ts`):** Extracted `GET /sync`, `GET /:id`, `PUT /:id`, and `DELETE /:id` into `filesApiRoutes`. Migrated parameter resolution, ETag conditional matching (`If-None-Match`, `If-Match`), optimistic concurrency locks (HTTP 412 / 428), soft-delete cascading, and RFC 7807 problem details to standard `Request`/`Response` APIs.
- **Stripe Monetization & Webhooks Router (`src/server/routes/stripe.routes.ts`):** Extracted `POST /create-checkout` and `POST /webhook` into `stripeRoutes`. Preserved multi-tier webhook idempotency (L1 in-memory -> L1.5 Redis dedup/lock -> L2 PostgreSQL ledger), signature verification with timestamp tolerance, and atomic ACID subscription transitions.
- **Cron Maintenance Router (`src/server/routes/cron.routes.ts`):** Extracted `GET|POST /expire-reservations` and `GET|POST /purge-deleted` into `cronRoutes`. Preserved constant-time `Bearer ${CRON_SECRET}` verification (`timingSafeEqual`), distributed Redis lock guards (`acquireCronLock`), batch draining, and bounded CTE soft-delete purges.
- **OAuth Callback Router (`src/server/routes/auth-callback.routes.ts`):** Extracted `GET /auth/callback` into `authCallbackRoutes`. Implemented standalone request-context bridging (`runWithServerRequestContext`), Supabase authorization code exchange, PostgreSQL user synchronization, and secure redirect emission with cookie preservation.
- **E2E Authentication Test Router (`src/server/routes/e2e-auth.routes.ts`):** Extracted `POST` and `DELETE` on `/api/test/e2e-auth` into `e2eAuthRoutes`. Maintained environment gates (`isAllowedEnvironment`), Supabase admin creation/sign-in, SSR cookie serialization, and isolated test database synchronization.

### Central Hono Application Assembly (`src/server/app.ts`)

- **Root Application & Middleware:** Assembled the root Hono application instance `app = new Hono()`, registered global `sessionMiddleware` for all paths, and mounted all sub-routers: `/api/agent`, `/api/files`, `/api/stripe`, `/api/cron`, `/api/test/e2e-auth`, and `/auth/callback`.
- **Type-Safe RPC Foundation:** Exported `export type AppType = typeof app` establishing the foundational type contract for typed RPC clients in Phase 3.

### Thin Next.js Delegation Bridges (`src/app/api/**`, `src/app/auth/callback/**`)

- **Transitional Delegation Forwarders:** Converted all nine legacy App Router route files into minimal, type-safe forwarders delegating directly to the underlying Hono handlers.
- **Zero Breaking Changes:** Maintained 100% operational compatibility for all existing test suites and external callers without code duplication.

### Verification & SSOT Metrics Baseline

- **Dedicated Phase 2 Server Router Test Suites:** Added 4 new suites delivering 120 passing tests (100% green):
  - `src/test/server/agent-routes.test.ts` (14 tests)
  - `src/test/server/app-dispatcher.test.ts` (19 tests)
  - `src/test/server/files-api-routes.test.ts` (36 tests)
  - `src/test/server/stripe-cron-auth-routes.test.ts` (51 tests)
- **Synchronized SSOT Metrics:** Validated via `scripts/sync-doc-metrics.mjs`:
  - Unit & Contract: 121 suites, 2,112 passing tests (100% green).
  - Live Multi-System Integration: 21 suites, 108 passing tests (100% green).
  - Browser E2E Journeys: 14 specs, 15 user journeys (100% green).
- **Phase Closure Dossier:** Documented in [`docs/records/closures/framework-migration/phase-02-migrate-all-8-api-routes-and-oauth-callback-to-web-standard-hono-routers.md`](./records/closures/framework-migration/phase-02-migrate-all-8-api-routes-and-oauth-callback-to-web-standard-hono-routers.md).

---

## [0.13.0] - 2026-11-07 (Phase 1: Archive Prior Plan, Install Target Packages & Build Request-Scoped Session Middleware)

### Prior Execution Plan Archival & Active Migration Plan Inception

- **Prior Plan Archival:** Moved completed 12-phase plan from `docs/Plans/ELIXENT_EXECUTION_PLAN.md` to [`docs/records/plans/elixent-agentic-architecture-execution-plan.md`](./records/plans/elixent-agentic-architecture-execution-plan.md), marked completed phases, and updated 21 internal relative links.
- **Migration Plan Inception:** Adopted the 6-phase framework migration plan at [`docs/records/plans/elixent-framework-migration-execution-plan.md`](./records/plans/elixent-framework-migration-execution-plan.md) governing the decoupling of the platform from Next.js 16 into a Vite 6 SPA, TanStack Router, and Web-standard Hono RPC architecture.
- **Cross-Document Link Synchronization:** Aligned links in `README.md`, `docs/README.md`, and past closure records (`phase-10`, `phase-11`, `phase-12`), with zero broken markdown links across 123 repository documents.

### Target Framework Dependencies Installation

- **Core Dependencies:** Installed `hono` (`^4.13.17`), `@hono/node-server` (`^2.1.6`), `@hono/zod-validator` (`^0.9.1`), and `@tanstack/react-router` (`^1.170.46`).
- **Dev Dependencies:** Installed `vite` (`^6.4.5`), `@vitejs/plugin-react` (`^5.2.0`), and `tsx` (`^4.23.15`).
- **Transitional Retention:** Retained `next` (`^16.3.8`) temporarily across Phases 1–5 to maintain 100% green test execution until the Phase 6 purge.

### Request-Scoped AsyncLocalStorage Context & Decoupled Supabase Resolvers (`src/server/context/*`, `src/lib/supabase/*`)

- **AsyncLocalStorage Context (`src/server/context/request-context.ts`):** Created `ServerRequestContext` store binding `ServerCookieStore` and standard `Headers` per request via `runWithServerRequestContext` and `getActiveRequestContext`.
- **Three-Tier Context Resolution:** Built `resolveCookiesAndHeaders()` that checks active `AsyncLocalStorage` context first, falls back gracefully to `next/headers` during transitional testing, and provides an ephemeral in-memory store outside request lifecycles.
- **Deterministic Background Scheduler:** Created `scheduleAfterResponse(task)` ensuring non-blocking post-response execution without dropping background token settlement flushes.
- **Decoupled Server Supabase Client (`src/lib/supabase/server.ts`):** Removed static `import { cookies } from "next/headers"`, adopting `resolveCookiesAndHeaders()`.
- **Isomorphic Environment Resolution (`src/lib/supabase/client.ts` & `src/config/features.config.ts`):** Guarded `process.env` access and unified resolution across `process.env` and `import.meta.env` for Vite and Node.js test runtimes.

### Web-Standard Hono Session Middleware (`src/server/middleware/session-middleware.ts`)

- **Standard Hono Middleware & Session Proxy:** Created `sessionMiddleware` for Hono and standalone `handleSessionProxy` porting all routing security invariants from `src/proxy.ts`.
- **Preserved Security Invariants:** Maintained OAuth callback code redirection (`/?code=...` / `/login?code=...` -> `/auth/callback`), Fast-Path cookie gating (`TD-12`), `AbortSignal.timeout(2500)` watchdog, protected page navigation gating, and standard `Set-Cookie` response serialization.
- **Response Compatibility Helper:** Provided non-enumerable `cookies` helper property on standard `Response` objects to support Next.js test assertion contracts seamlessly.

### Verification & SSOT Metrics Baseline

- **Dedicated Phase 1 Test Suites:** Added 5 new suites delivering 100 passing tests (100% green):
  - `src/test/server/request-context.test.ts` (26 tests)
  - `src/test/server/session-middleware.test.ts` (45 tests)
  - `src/test/server/supabase-server.test.ts` (14 tests)
  - `src/test/config/features.config.test.ts` (11 tests)
  - `src/test/auth/supabase-client.test.ts` (4 tests)
- **Synchronized SSOT Metrics:** Validated via `scripts/sync-doc-metrics.mjs`:
  - Unit & Contract: 117 suites, 1,992 passing tests (100% green).
  - Live Multi-System Integration: 21 suites, 108 passing tests (100% green).
  - Browser E2E Journeys: 14 specs, 15 user journeys (100% green).
- **Phase Closure Dossier:** Documented in [`docs/records/closures/framework-migration/phase-01-archive-prior-plan-target-packages-and-session-middleware.md`](./records/closures/framework-migration/phase-01-archive-prior-plan-target-packages-and-session-middleware.md).

---

## [0.12.0] - 2026-11-04 (Phase 12: Final Purge of Legacy 5-Operation Modules, Test Suite Migration & Living Documentation Sync)

### Permanent Purge of Legacy 5-Operation Modules (`src/app/api/ai/stream/route.ts`, `src/lib/ai/*`, `src/server/actions/*`)

- **Permanent Deletion of 7 Legacy Modules:** Permanently deleted the seven unreferenced legacy 5-operation modules (`src/app/api/ai/stream/route.ts`, `src/lib/ai/pending-operation-store.ts`, `src/lib/ai/preview-buffer.ts`, `src/lib/ai/prompts.ts`, `src/lib/ai/quota-settlement-reducer.ts`, `src/server/actions/ai-commit.ts`, and `src/server/actions/ai-ops.ts`), completing the transition to `/api/agent/stream` and `src/server/services/ai-settlement-service.ts`.
- **Lean Dynamic Model Registry & Tier Limits Cleanup (`src/config/models.config.json`, `src/config/tiers.config.ts`, `src/lib/ai/client.ts`, `src/types/ai-contracts.ts`):**
  - Removed legacy 5-operation keys (`correct`, `improve`, `summarize`, `translate`, `toPrompt`) from `src/config/models.config.json`, retaining exclusively the Lean Dynamic Model Registry (`models` indexed by `modelId` with `executionMode`, `V`, `creditsPer1kInput`, `creditsPer1kCacheRead`, `creditsPer1kOutput`, and `calibrationPriors`).
  - Removed temporary 5-operation word-quota fields (`correctImproveTranslate`, `summarize`, `toPrompt`, `isToPromptEnabled`) from `TierLimits` and `TIER_LIMITS` in `src/config/tiers.config.ts`, retaining exclusively `creditAllocationMicro`, `creditsDisplay`, and `price`.
  - Cleaned `src/lib/ai/client.ts` to retain exclusively the Vercel AI SDK v7 gateway functions (`getGoogleModel`, `executeStructuredGeneration`, `executeToolAgentGeneration`, `executeStreamingGeneration`).
  - Consolidated server-only micro-credit reservation, commit, refund, status inspection, stale reservation sweeping, and Redis-to-PostgreSQL settlement flushing inside `src/server/services/ai-settlement-service.ts`.
  - Updated `src/types/ai-contracts.ts` (`AIRequestContract`, `AIReservationContract`, `AICommitReservationContract`, `AIRefundReservationContract`, `AIQuotaStatusContract`) to represent micro-credits and `/api/agent/stream` execution modes.

### Integration, Live & E2E Test Suite Migration & Living Documentation Sync

- **Full Test Suite Migration (`src/test/**`, `e2e/specs/**`):** Migrated 28 unit, integration, and live test files and 5 Playwright E2E specs (`06-ai-streaming-commit.spec.ts`, `07-ai-abort-reject.spec.ts`, `08-ai-failure-refund.spec.ts`, `09-ai-conflict-412.spec.ts`, `12-vault-ai-shield.spec.ts`) from the deleted 5-operation modules to `/api/agent/stream`, `src/server/services/ai-settlement-service.ts`, `MultiHunkGhostState`, and `elixentAgentGraph`.
- **Living Documentation & SSOT Metrics Synchronization:** Updated `docs/METRICS.json` (`112` unit suites / `1892` passing tests, `21` live suites / `108` passing tests, `14` E2E specs / `15` journeys) and synchronized all monitored living documentation files (`README.md`, `docs/README.md`, `docs/guides/ai/ai-models-config.md`, `docs/guides/billing/stripe-setup.md`, `docs/reference/ui-streaming-readiness.md`, `docs/reference/sync-api.md`, `docs/architecture/security/security-and-rate-limiting.md`, `docs/architecture/sync/editor-sync-orchestration.md`, `docs/architecture/ai/*`, and `docs/Plans/ELIXENT_EXECUTION_PLAN.md`). Recorded Phase 12 closure dossier in [phase-12-final-legacy-purge-test-suite-migration-and-living-docs-sync.md](./records/closures/elixent-execution/phase-12-final-legacy-purge-test-suite-migration-and-living-docs-sync.md).

---

## [0.11.0] - 2026-11-03 (Phase 11: Agent Chat Panel, HITL Question Cards, Credit Balance Views & Incremental Editor Sync)

### Architectural Agent Chat Panel & HITL Clarification Cards (`src/components/agent/*`)

- **Interactive Agent Chat Panel (`chat-panel.tsx`):** Built the primary control surface for the 7-stage architectural agent (`AgentChatPanel`), featuring real-time stage progress indicators, an accordion-based ATMS master decision ledger viewer with selection rationales and evaluated alternatives, multi-hunk review counters with batch action triggers, and session lifecycle controls with Zero-Knowledge vault lock awareness.
- **Human-in-the-Loop Clarification Gate (`hitl-question-card.tsx`):** Implemented `HITLQuestionCard` rendering structured clarifying question batches from Stage 6 (`pure_interrupt_node`), with option selection, custom notes (max 500 chars), and real-time schema validation via `ClarificationResponseSchema` before stateless resumption dispatch.
- **Editor Toolbar Upgrade (`src/components/editor/ai-toolbar.tsx`):** Added agent chat panel drawer toggle and multi-hunk ghost preview action bar (`activeGhostHunksCount`, `onAcceptAllGhostHunks`, `onRejectAllGhostHunks`) while preserving legacy callback interfaces for backward compatibility.

### Incremental Multi-Hunk Sync & 412 Conflict Elimination (`src/hooks/use-editor-orchestrator.ts` & `src/hooks/use-ai-stream.ts`)

- **Immediate Local Persistence + Debounced Server Autosave:** Replaced client-driven `commitAIFileOperation` with an incremental sync pipeline: accepting a ghost hunk applies the replacement in CodeMirror 6 with `isolateHistory.of("full")`, writes immediately to IndexedDB (`localRevision += 1`), and notifies `useEditorAutosave` to coalesce rapid acceptances into a single debounced server save (800ms–1000ms), permanently eliminating racing parallel PUT requests and self-inflicted `412 Precondition Failed` conflicts.
- **Programmatic Transaction Isolation:** Routed all ghost hunk replacements through `onProgrammaticTransaction`, raising `isProgrammaticUpdateRef` in `useEditorOrchestrator` to prevent editor changes from being misclassified as manual user typing.
- **Agent Session FSM Evolution (`src/lib/ai/stream-session.ts`):** Transitioned `AIStreamStatus` to an 8-state finite state machine (`idle`, `running_graph`, `awaiting_hitl`, `streaming_hunks`, `preview_ready`, `completed`, `aborted`, `failed`) and updated `src/components/editor/ai-stream-status.tsx` to reflect active graph stages.

### Real-Time Micro-Credit Balance Views (`src/app/dashboard/page.tsx` & `src/app/account/page.tsx`)

- **Micro-Credit Architecture Integration:** Removed legacy word-count quota calls (`getRemainingQuota`), wiring dashboard and account pages to `getUserCreditBalance(user.id)` from `src/server/services/ai-settlement-service.ts`.
- **Visual Progress & Tier Allocations:** Rendered available credit balances alongside percentage progress bars derived from `TIER_LIMITS[tier].creditsDisplay` and provided direct links to Stripe upgrade flows.

### Legacy 5-Operation UI Triggers & Reference Purge

- **Commit Gate 11 Compliance:** Verified via strict repository grep that zero references to `ai-ops.ts`, `ai-commit.ts`, `pending-operation-store.ts`, or `/api/ai/stream` remain in `src/app`, `src/components`, or `src/hooks`.
- **Editor Workspace Page Integration (`src/app/workspace/editor/[fileId]/page.tsx`):** Fully integrated `AgentChatPanel`, `AIToolbar`, and `AIStreamStatus` with `useEditorOrchestrator` outputs and keyboard shortcuts.

### Verification & Metrics Baseline

- **Dedicated Phase 11 Test Suites:** 2 new test suites delivering 79 passing tests:
  - `src/test/agent/wave-11-1-ui-and-sync.test.tsx` (32 tests)
  - `src/test/agent/wave-11-2-ui-and-pages.test.tsx` (47 tests)
- **Synchronized SSOT Metrics:** Validated via `scripts/sync-doc-metrics.mjs`:
  - Unit & Contract: 112 suites, 1,899 tests (100% green).
  - Live Multi-System Integration: 21 suites, 108 tests (100% green).
  - Browser E2E Journeys: 14 specs, 15 user journeys (100% green).
- **Phase Closure Dossier:** Documented in [`docs/records/closures/elixent-execution/phase-11-agent-chat-panel-hitl-question-cards-credit-balance-views-and-incremental-editor-sync.md`](records/closures/elixent-execution/phase-11-agent-chat-panel-hitl-question-cards-credit-balance-views-and-incremental-editor-sync.md).

---

## [0.10.0] - 2026-10-31 (Phase 10: CodeMirror 6 Multi-Hunk Ghost Upgrade & Unified Agent SSE Stream Route)

### CodeMirror 6 Multi-Hunk Ghost Preview Engine (`src/components/editor/markdown/streaming-ghost.ts` & `types.ts`)

- **`MultiHunkGhostState` Architecture:** Upgraded the native CodeMirror 6 markdown editor extension from single-range preview to an array of concurrent ghost hunks (`sessionId: string | null`, `hunks: GhostHunk[]`), retaining legacy single-range properties for seamless backward compatibility.
- **Dynamic Coordinate Remapping (`tr.changes.mapPos`):** Implemented linear coordinate shifting inside `codeMirrorStreamingGhostField.update` using `hunk.from = tr.changes.mapPos(hunk.from, 1)` and `hunk.to = tr.changes.mapPos(hunk.to, -1)`, preventing offset drift when non-overlapping text is edited elsewhere in the active document.
- **Granular Collision Invalidation:** Added intelligent collision detection that evicts only the directly intersecting ghost hunk (firing its `onStop` callback) when user typing overlaps with a hunk's range, preserving all independent non-overlapping ghost hunks.
- **Atomic Undo History Isolation:**
  - `acceptGhostHunk`: Dispatches range replacement annotated with `Transaction.userEvent.of("ai.accept.hunk")` and `isolateHistory.of("full")`, enabling single-step `Ctrl+Z` undo for individual accepted hunks.
  - `rejectGhostHunk`: Removes the hunk via `removeGhostHunkEffect` without modifying document content or adding undo history steps, invoking `onReject?.()`.
  - `acceptAllGhostHunks`: Atomically combines sorted, non-overlapping changes across all remaining hunks into a single transaction annotated with `Transaction.userEvent.of("ai.accept.all")` and `isolateHistory.of("full")`, allowing a single `Ctrl+Z` to revert the entire batch.
- **Glassmorphism Interactive Preview Card (`CMStreamingGhostWidget`):** Rendered dark glassmorphism preview cards above target ranges featuring operation/heading badges, streaming pulsating indicators, and inline action buttons ("إيقاف التوليد", "رفض", "إعادة المحاولة", "تطبيق") with dynamic text direction evaluation (`detectTextDirection`).
- **Engine-Agnostic Adapter Methods (`EditorAdapter`):** Exposed multi-hunk operations through `CodeMirrorEditorAdapter` (`editor-adapter.ts`) and `MarkdownEditor` (`markdown-editor.tsx`): `startGhostSession`, `upsertGhostHunk`, `acceptGhostHunk`, `rejectGhostHunk`, `acceptAllGhostHunks`, `getGhostHunks`, and `clearGhostSession`.

### Framework-Agnostic Stream Request Contract (`src/core/agent/stream-payload.ts`)

- **Strict Bounded Schema (`AgentStreamRequestPayloadSchema`):** Defined isomorphic Zod schema with zero external Next.js or React runtime dependencies, enforcing strict bounds (`MAX_PROMPT_CHARS = 100_000`, `MAX_TARGET_FILES = 100`, `MAX_IDENTIFIER_LENGTH = 256`, `MAX_DOCUMENT_SNAPSHOT_CHARS = 2_000_000`, `MAX_RECORD_KEYS = 100`) and `.strict()` validation to prevent resource exhaustion attacks.
- **Pure Parsing Helper (`parseAgentStreamPayload`):** Provided side-effect-free parsing function returning typed discriminated union results (`{ success: true, data } | { success: false, error }`).

### Unified Server SSE Stream Route (`src/app/api/agent/stream/route.ts`)

- **Server-Authoritative LangGraph Streaming:** Created the primary SSE endpoint (`POST /api/agent/stream`) executing `elixentAgentGraph` with `export const maxDuration = 300;` and `export const dynamic = "force-dynamic";`.
- **Pre-Execution Security & Rate Limiting:** Enforced strict session authentication via `requireAuthenticatedUser()` (failing closed with RFC 7807 `401 Unauthorized`) and per-user streaming rate limiting via `aiStreamRateLimiter.limit(user.id)` (failing closed with RFC 7807 `429 Too Many Requests`).
- **Transient Ephemeral Vault Hydration:** Slices client-decrypted file plaintexts by heading slugs via AST slicer (`loadEphemeralVaultPayloads`) and populates `EphemeralVaultMemoryMap` scoped to the request via `runWithEphemeralVaultScope`.
- **Dynamic Token Runway Metering (`StreamGovernor`):** Metered intermediate token chunks via `StreamGovernor` (`INITIAL_RESERVATION_TOKENS = 1200`, model `google/gemini-3.8-flash`), monitoring token velocity and aborting streams with `GOVERNOR_QUOTA_EXHAUSTED` upon quota depletion.
- **Asynchronous Settlement Flush via Next.js `after()`:** Queued non-blocking background credit settlement persistence to PostgreSQL via `after(async () => { await flushPendingSettlementsToPostgres(user.id); })`.
- **Zero-Knowledge Memory Cleansing:** Enforced unconditional zeroing of decrypted buffers via `zeroOutEphemeralVaultMemory()` (`Buffer.fill(0)`) in both normal completion and stream abort/cancel handlers.
- **Standardized SSE Framing:** Emitted framed events (`start`, `update`, `interrupt`, `error`, `done`) over `text/event-stream; charset=utf-8` with `X-Accel-Buffering: no`.

### Verification & Metrics Baseline

- **Dedicated Phase 10 Test Suites:** 2 new test suites delivering 73 passing tests:
  - `src/test/editor/multi-hunk-ghost.test.ts` (32 tests)
  - `src/test/agent/agent-stream-route.test.ts` (41 tests)
- **Synchronized SSOT Metrics:** Validated via `scripts/sync-doc-metrics.mjs`:
  - Unit & Contract: 110 suites, 1,815 tests (100% green).
  - Live Multi-System Integration: 21 suites, 108 tests (100% green).
  - Browser E2E Journeys: 14 specs, 15 user journeys (100% green).
- **Phase Closure Dossier:** Documented in [`docs/records/closures/elixent-execution/phase-10-codemirror-6-multi-hunk-ghost-upgrade-and-unified-agent-sse-stream-route.md`](records/closures/elixent-execution/phase-10-codemirror-6-multi-hunk-ghost-upgrade-and-unified-agent-sse-stream-route.md).

---

## [0.9.0] - 2026-10-31 (Phase 9: AgentGraphState Channels, Pure Reducers, 7-Stage Nodes & Compiled LangGraph StateGraph)

### 12-Channel LangGraph State Annotation & Pure Reducers (`src/core/agent/state.ts` & `src/core/agent/reducers.ts`)

- **Canonical 12-Channel Root Annotation (`AgentGraphAnnotation`):** Defined the root state annotation using `@langchain/langgraph` `Annotation.Root`, strictly enforcing JSON-serializable plain records, arrays, and decimal strings (avoiding non-serializable `Map`, `Set`, or `BigInt` at channel boundaries):
  - `messages`: Merges conversation history using LangGraph's native `messagesStateReducer`.
  - `user_request`: Encapsulates immutable `prompt`, `projectId`, and `targetFileIds` via last-write replacement.
  - `search_report`: Merges evidence items deduplicated by composite key `(fileId, headingSlug)` with pointer preservation.
  - `local_inspection_state`: Produces deduplicated set union of visited Markdown AST paths.
  - `assumptions`: Upserts `AssumptionItem` records keyed by `assumptionId`.
  - `master_ledger`: Deep-merges ATMS DAG nodes, filtering system-reserved sentinels (`isSystemReservedDecisionId`).
  - `project_taxonomy`: Null-coalescing last-write replacement (`update ?? current`).
  - `unresolved_ledger`: Last-write replacement for decisions failing conformal prediction criteria.
  - `invalidation_map`: Aggregates affected section targets deduplicated by `(fileId, headingSlug)` per decision ID.
  - `question_queue`: Structured `ClarifyingQuestionBatch` for HITL interrupts; resets to `null` on session resumption.
  - `budget_tracking`: Arbitrary-precision micro-credit arithmetic (`reservedMicro`, `spentMicro`) using decimal strings and internal `BigInt` addition.
  - `search_loop_count`: Monotonically incrementing loop counter clamped at `MAX_SEARCH_LOOPS = 3`.
- **Pure & Synchronous Reducer Functions:** Implemented 8 deterministic pure reducer functions (`reduceSearchReport`, `reduceLocalInspectionState`, `reduceAssumptions`, `reduceMasterLedger`, `reduceProjectTaxonomy`, `reduceInvalidationMap`, `reduceBudgetTracking`, `reduceSearchLoopCount`) with zero I/O, zero async, and zero input argument mutation (verified under strict `Object.freeze` test assertions).

### 14 Canonical Stage Nodes Across Stages 0 to 7 (`src/core/agent/nodes/*`)

- **Stage 0 Master Orchestrator (`orchestratorNode`):** Validates user request, seeds initial `HumanMessage`, initializes inspection paths, and loads persistent project decision ledgers from `project_decision_ledger` with sentinel isolation.
- **Stage 1 Hybrid Inspection & Synthesis Subgraph (`searchAgentNode`, `workspaceToolNode`, `searchSynthesizerNode`):** Implements metered inspection loop bounded by `stepCountIs(6)` executing `listHeadingsTree`, `readSectionByHeading`, and `searchLexicalWithASTBreadcrumb` against `IWorkspaceProvider`, synthesizing evidence items into `search_report`.
- **Stage 2 Assumption Analysis & Relational Linker (`assumptionAnalyzerNode`, `atmsRelationalLinkerNode`):** Extracts architectural assumptions bounded by project taxonomy (`resolveProjectConceptTags`), retrieves top-$K$ candidate prior decisions, and executes batched relational adjudication with ATMS cascade BFS.
- **Stage 3 Architectural Auditing & Decision Scoring (`jevStructuringNode`, `decisionScorerNode`):** Structurally neutralizes candidate options into 3–4 mutually exclusive alternatives, re-injecting historical alternatives upon re-evaluation, and executes four-dimensional single-pass decision scoring via `POST /v1/decisions`.
- **Stages 4 & 5 Deterministic Triage, Ledger Commit & Gap Planner (`confidenceClassifierNode`, `ledgerCommitNode`, `internalGapPlannerNode`):** Executes pure mathematical conformal prediction classification (APS margin, zero LLM calls), commits approved decisions to ATMS DAG with minimal section invalidation, and plans supplementary search for unresolved decisions.
- **Stage 6 Replay-Safe Stateless HITL Protocol (`questionOrganizerNode`, `pureInterruptNode`):** Structures clarifying question batches into `question_queue` prior to checkpoint persistence. Guarantees zero model calls or external writes before `interrupt()`, typed resumption validation via `ClarificationResponseSchema`, and clean re-entry via `new Command({ goto: 'assumption_analyzer_node' })`.
- **Stage 7 Document Writer & Structural Merge (`documentWriterNode`):** Section-targeted three-way document surgery (`diff3MergeSection`, `synthesizeAgentSectionContent`) merging agent updates into live user documents while quarantining true overlaps.

### StateGraph Assembly, Conditional Routers & Authenticated Checkpointer (`src/core/agent/graph.ts`)

- **StateGraph Workflow Assembly (`buildAgentWorkflow`):** Assembles and wires all 14 canonical nodes and 3 conditional edge routers (`toolsCondition`, `routeAfterAssumptions`, `resolutionGateRouter`).
- **Production Checkpointer (`getProductionCheckpointer`):** Configures `PostgresSaver` backed by the global PostgreSQL pool (`getPgPool()`) and authenticated `EncryptedCheckpointSerializer` (AES-256-GCM) with `elixent:v1:checkpoint:${innerType}` AAD and active plaintext leak assertions.
- **Factory & Singleton Architecture:** Implemented `createElixentAgentGraph(options)` supporting custom savers (`MemorySaver` for unit/integration testing) and exported `elixentAgentGraph` lazy Proxy to eliminate eager database connection attempts during test initialization.

### Verification & Metrics Baseline

- **Dedicated Phase 9 Test Suites:** 3 new test suites delivering 122 passing tests:
  - `src/test/agent/reducers-and-state.test.ts` (59 tests)
  - `src/test/agent/stage-nodes-wave9-2.test.ts` (51 tests)
  - `src/test/agent/langgraph-orchestration.test.ts` (12 tests)
- **Synchronized SSOT Metrics:** Validated via `scripts/sync-doc-metrics.mjs`:
  - Unit & Contract: 108 suites, 1,742 tests (100% green).
  - Live Multi-System Integration: 21 suites, 108 tests (100% green).
  - Browser E2E Journeys: 14 specs, 15 user journeys (100% green).
- **Phase Closure Dossier:** Documented in [`docs/records/closures/elixent-execution/phase-09-agent-graph-state-channels-pure-reducers-7-stage-nodes-and-compiled-langgraph-stategraph.md`](records/closures/elixent-execution/phase-09-agent-graph-state-channels-pure-reducers-7-stage-nodes-and-compiled-langgraph-stategraph.md).

---

## [0.8.0] - 2026-10-31 (Phase 8: Justification-Driven ATMS DAG, Deterministic Candidate Retriever & Relational Linker)

### Justification-Driven ATMS DAG & Project Ledger Store (`src/core/agent/atms/dag.ts`)

- **JSON-Serializable Node Structure (`ATMSDecisionNode`):** Defined canonical plain-record state structures avoiding non-serializable JavaScript types (`Map`, `Set`, `BigInt`) for lossless LangGraph checkpointer persistence.
- **Justification & Alternative Tracking:** Every decision node authoritatively stores its `selectionRationale`, `conceptTags: string[]`, `dependsOn`, `dependedBy`, `affectedSections`, and all non-selected options in `evaluatedAlternatives` paired with contextual exclusion rationales and normalized probabilities.
- **System-Reserved Sentinel Isolation:** Strictly isolates metadata sentinels (`isSystemReservedDecisionId`, e.g. `__PROJECT_TAXONOMY__`) from DAG causal edges and eviction pruning, persisting project taxonomy states transparently via `toTaxonomyLedgerPayload` and `fromTaxonomyLedgerPayload`.
- **Multi-Tenant Persistence Synchronization:** Built `loadProjectDecisionLedger` and `syncMasterLedgerToProjectStore` enforcing `userId` ownership checks across composite key `(project_id, decision_id)` queries, conflict-update clauses (`setWhere`), and eviction deletions. Deep-cloning utilities (`cloneATMSDecisionNode`, `cloneMasterLedger`) enforce immutability across state transitions.

### Deterministic Local Candidate Retriever (`src/core/agent/atms/candidate-retriever.ts`)

- **Multi-Signal Candidate Retrieval:** Implemented `retrieveCandidatePriorDecisions` evaluating candidate decisions across three orthogonal signals prior to relational adjudication:
  - _AST Section Proximity:_ Computes structural proximity ($1.0$ for exact `fileId` and `headingSlug` match, $0.5$ for hierarchical ancestor/child prefixes, $0.0$ for disjoint sections). Strictly enforces that heading proximity is a retrieval comparison signal, never an automatic dependency edge.
  - _Concept Tags Jaccard Overlap:_ Computes normalized Jaccard similarity across active project-scoped concept tags without static tag constraints.
  - _Okapi BM25 Lexical Match:_ Scores assumption statements against prior decision questions, rationales, and evaluated alternatives using path-coupled lexical information retrieval.
- **Composite Scoring & Deterministic Tie-Breaking:** Combines signals using weighted formula (Proximity: 3.0, Concept Tags: 2.0, BM25: 1.5) with strict alphabetical tie-breaking by `decisionId` and configurable candidate bounds (`DEFAULT_MAX_CANDIDATE_DECISIONS = 8`).

### Waterfall-Free Relational Linker (`src/core/agent/atms/relational-linker.ts`)

- **Batched Adjudication (`evaluateRelationalLinksBatch`):** Flattens all assumption-candidate comparison pairs across all newly extracted assumptions into a single batch call to `POST /v1/decisions`, eliminating $N+1$ serial network waterfalls.
- **Deterministic Relation Reconstruction:** Reconstitutes linked assumption groups (`LinkedAssumptionGroup`) keyed by `(assumptionId, targetDecisionId)` classified into `INDEPENDENT`, `DEPENDS_ON`, `REOPENS_OR_OVERRIDES`, or `REFINES`, preserving input ordering, confidence scores, and rationales.
- **Closed-World Taxonomic Intersection:** Normalizes taxonomic tag comparisons using `normalizeConceptTag` while safely handling empty candidate sets and uninitialized ledgers.

### Contagious Cascade BFS & Differential Section Invalidation (`src/core/agent/atms/invalidation.ts`)

- **Bidirectional Cascade Algorithm (`resolveATMSCascadeBFS`):**
  - _Upward Promotion Path:_ Traverses `dependsOn` edges via BFS. If a new assumption depends on a provisional peripheral decision (`APPROVED_CONSERVATIVE`), the target is promoted to `CORE_ARCHITECTURAL` (`isLoadBearing: true`), pulled with its preserved alternatives, and evicted from the working ledger for formal re-evaluation under new evidence.
  - _Downward Invalidation Path:_ When a relation is classified as `REOPENS_OR_OVERRIDES`, reopens the root decision and traverses all downstream dependents via BFS over `dependedBy`, pulling them for parallel update.
  - _Cycle-Safe Invariant:_ Enforces dedicated visited sets (`upwardVisited`, `downwardVisited`) preventing infinite traversal loops on cyclic graphs.
  - _Sibling Independence:_ Guarantees that sibling sub-decisions under the same heading classified as `INDEPENDENT` remain completely untouched.
- **Differential Section Invalidation (`computeMinimalSectionInvalidationMap`):** Traverses downward dependents to aggregate the exact `(fileId, headingSlug)` section targets impacted by an override, enabling surgical document updates without invalidating unrelated document sections.

### Verification & Metrics Baseline

- **Dedicated Phase 8 Test Suite:** 1 new test suite delivering 63 passing tests:
  - `src/test/agent/atms-dag-and-cascade.test.ts` (63 tests)
- **Synchronized SSOT Metrics:** Validated via `scripts/sync-doc-metrics.mjs`:
  - Unit & Contract: 105 suites, 1,620 tests (100% green).
  - Live Multi-System Integration: 21 suites, 108 tests (100% green).
  - Browser E2E Journeys: 14 specs, 15 user journeys (100% green).
- **Phase Closure Dossier:** Documented in [`docs/records/closures/elixent-execution/phase-08-justification-driven-atms-dag-candidate-retriever-and-relational-linker.md`](records/closures/elixent-execution/phase-08-justification-driven-atms-dag-candidate-retriever-and-relational-linker.md).

---

## [0.7.0] - 2026-10-30 (Phase 7: Comprehensive PREDEFINED_CONCEPT_TAGS Taxonomy, Unified /v1/decisions Client, Conformal APS Classifier & AI SDK v6 Bridge)

### Universal Concept Taxonomy & Project Tag Registry (`src/core/agent/taxonomy/predefined-tags.ts`)

- **Universal Engineering Taxonomy Across 9 Domains:** Implemented `DEFAULT_CONCEPT_TAGS` (aliased to `PREDEFINED_CONCEPT_TAGS`) spanning System Architecture & Design; Libraries, SDKs & Public Contracts; Deep Learning, ML & Scientific Computing; Data Modeling, Storage & Persistence; Networking, Protocols & Distributed Sync; Security, Cryptography & Privacy; Performance, Runtime & Systems; Frontend, UI/UX & Client Interaction; and Quality, Testing, CI/CD & Governance.
- **Zero Host-Subsystem Coupling:** Purged all internal LUGX- or Elixent-specific tokens from the taxonomy, guaranteeing a paradigm-agnostic dictionary suitable for arbitrary technical documentation domains.
- **Strict Format Regex & Normalization:** Validates tags via `CONCEPT_TAG_FORMAT_REGEX = /^[a-z][a-z0-9_]{1,63}$/` and normalizes arbitrary tag candidates using `normalizeConceptTag` (lowercasing, trimming, converting whitespace and hyphens to underscores, and collapsing consecutive delimiters).
- **Project-Scoped Mutation Algebra:** Implemented `applyProjectTagMutations` enforcing deterministic set algebra `(baseTags \ removedTags) ∪ addedTags`. Resolves active tag tuples via `resolveProjectConceptTags`, throwing `EmptyProjectTaxonomyError` if an operation would leave a project with zero active concept tags.
- **System-Reserved Decision Sentinel:** Authoritative metadata helpers (`PROJECT_TAXONOMY_SENTINEL_ID = "__PROJECT_TAXONOMY__"`, `isSystemReservedDecisionId`, `toTaxonomyLedgerPayload`, `fromTaxonomyLedgerPayload`) enabling lossless storage and reconstitution of project taxonomy configurations in `project_decision_ledger`.

### Universal Decision & Agent State Zod Schemas (`src/core/agent/schemas/decision-schemas.ts`)

- **Closed-World Dynamic Schema Factories:** Implemented dynamic Zod schema factories parameterized by active project tags:
  - `createConceptTagEnum(activeTags?)`: Constructs a closed-world enum preventing LLM tag hallucination while honoring project-level custom tags.
  - `createDecisionEvaluationItemSchema(activeTags?)`: Bounds options to $3\text{–}4$ mutually exclusive alternatives and concept tags to $1\text{–}6$ active tags.
  - `createCanonicalDecisionBatchSchema(activeTags?)`: Enforces batches of $1\text{–}12$ canonical decision items.
  - `createAssumptionItemSchema(activeTags?)` and `createAssumptionExtractionBatchSchema(activeTags?)`: Binds assumption extraction to authorized project tags.
- **Pre-instantiated Default Schemas:** Exports `ConceptTagEnum`, `DecisionEvaluationItemSchema`, `CanonicalDecisionBatchSchema`, `AssumptionItemSchema`, and `AssumptionExtractionBatchSchema` pre-bound to `DEFAULT_CONCEPT_TAGS`.
- **Static Structural Contracts:** Exports validated schemas for `CanonicalOptionSchema`, `SearchReportSchema`, `RelationalLinkPairInputSchema`, `RelationalAdjudicationBatchSchema`, `QuestionQueueSchema`, and `ClarificationResponseSchema`.

### Unified Decisions API Client & Two-Tier Cascade (`src/lib/jev/client.ts`)

- **POST /v1/decisions Unified Client:** Implemented decision client evaluating four orthogonal dimensions in parallel within a single forward pass: `evidence_grounding` ($[0, 1]$), `coupling_level` ($[0, 2]$), `rollback_cost` ($[0, 2]$), and `probabilities` across options plus canonical abstention `"insufficient_evidence"`.
- **Two-Tier Decision Cascade:** Dispatches fast single-pass evaluation to `typesafe/jev-1.13` (Tier 1), automatically escalating ambiguous core architectural decisions (`CORE_ARCHITECTURAL` with $|C_{\alpha_{\text{core}}}| \ne 1$) to analytical thinking model `fastino/glide` (Tier 2) before interrupting the user.
- **Deterministic Mock Generator:** Built deterministic offline mock generator ensuring seamless local development and automated CI testing when `JEV_API_KEY` is unconfigured.
- **Batched Relational Adjudication:** Implemented `evaluateRelationalLinksBatch` classifying logical relationships (`INDEPENDENT`, `DEPENDS_ON`, `REOPENS_OR_OVERRIDES`, `REFINES`) between new assumptions and prior ledger candidates.

### Conformal Adaptive Prediction Sets (APS) Classifier & Calibration Store (`src/lib/jev/conformal-classifier.ts` & `src/lib/jev/calibration-store.ts`)

- **5-Step Deterministic Conformal APS Algorithm:** Implemented `classifyDecisionConformalAPS` executing pure mathematical classification with zero LLM involvement:
  1. _Abstention Gate:_ Rejects with `UNRESOLVED` if $p_{\text{abstain}} \ge 0.25$ or $\text{evidenceGrounding} < 0.50$; otherwise normalizes valid options $\tilde{p}(a_k) = p(a_k) / (1 - p_{\text{abstain}})$.
  2. _Structural Impact Index:_ $\text{ImpactIndex}(x) = \text{CORE\_ARCHITECTURAL}$ if $C \ge 1.5 \lor R \ge 1.5$ else $\text{PERIPHERAL}$.
  3. _Top-2 Dominance Margin:_ $m(x) = \tilde{p}_{(1)} - \tilde{p}_{(2)}$.
  4. _Conformal Prediction Sets:_ $\mathcal{C}_{\alpha}(x) = \{ a_k : (1 - \tilde{p}(a_k)) \le \hat{q}_{1-\alpha} \}$.
  5. _Classification Rules:_ `APPROVED_DIRECT` ($|\mathcal{C}_{\alpha_{\text{core}}}| == 1 \land m(x) \ge 0.25$); `APPROVED_CONSERVATIVE` ($\text{PERIPHERAL} \land 1 \le |\mathcal{C}_{\alpha_{\text{periph}}}| \le 2 \land m(x) \ge 0.15$); `UNRESOLVED` otherwise.
- **Strict Conservative Approval Invariant:** Enforced strict invariant categorically forbidding `APPROVED_CONSERVATIVE` classification when $\text{ImpactIndex}(x) == \text{CORE\_ARCHITECTURAL}$.
- **Sliding-Window Calibration Store:** Built `CalibrationStore` maintaining an in-memory sliding window ($N = 200$) with non-blocking Upstash Redis sync (`gemini:calibration_window:<modelId>`). Computes empirical quantiles at rank $k = \min(n, \lceil(n+1)(1-\alpha)\rceil)$ when $n \ge 20$ with fallback to static bootstrap priors registered in `models.config.json`.

### Modern AI SDK v7 Gateway Bridge (`src/lib/ai/client.ts` & `src/lib/ai/key-rotation.ts`)

- **Modern Structured Generation:** Implemented `executeStructuredGeneration` using `generateText` with `Output.object({ schema })`, adhering to Vercel AI SDK v7 deprecation policy.
- **Multi-Step Tool Agent Generation:** Implemented `executeToolAgentGeneration` using `generateText` with `stopWhen: stepCountIs(...)`.
- **Streaming Text Generation:** Implemented `executeStreamingGeneration` using `streamText` with key rotation usage confirmation in `onFinish` and circuit-breaker recording in `onError`.
- **Rotated Google Provider Instances:** Implemented `getGoogleModel` returning initialized `@ai-sdk/google` instances backed by rotated API keys and half-open probe locks.
- **Single GEMINI_API_KEY Fallback:** Hardened `getApiKeys()` in `src/lib/ai/key-rotation.ts` to automatically read `process.env.GEMINI_API_KEY` when numbered keys `GEMINI_KEY_1..20` are unconfigured.

### Verification & Metrics Baseline

- **Dedicated Phase 7 Suites:** 3 new test suites delivering 84 passing tests:
  - `src/test/jev/conformal-classifier.test.ts` (55 tests)
  - `src/test/ai/ai-sdk-v7-gateway.test.ts` (21 tests)
  - `src/test/agent/taxonomy-and-schemas.test.ts` (8 tests)
- **Synchronized SSOT Metrics:** Validated via `scripts/sync-doc-metrics.mjs`:
  - Unit & Contract: 104 suites, 1,557 tests (100% green).
  - Live Multi-System Integration: 21 suites, 117 tests (100% green).
  - Browser E2E Journeys: 14 specs, 15 user journeys (100% green).
- **Phase Closure Dossier:** Documented in [`docs/records/closures/elixent-execution/phase-07-concept-taxonomy-unified-decisions-and-conformal-aps.md`](records/closures/elixent-execution/phase-07-concept-taxonomy-unified-decisions-and-conformal-aps.md).

---

## [0.6.0] - 2026-10-30 (Phase 6: Zero-Knowledge Vault Boundary, Encrypted Checkpoints & CloudPostgresWorkspaceProvider)

### Ephemeral Vault Memory Map & Pointer Dereferencer (`src/lib/vault/ephemeral-memory-map.ts`)

- **Request-Scoped AsyncLocalStorage Isolation:** Implemented `runWithEphemeralVaultScope` to isolate decrypted vault section plaintexts in transient memory (`Map<string, Uint8Array>`) per HTTP request, preventing cross-request leaks in serverless runtimes.
- **Opaque Vault Reference Pointers:** Replaced decrypted plaintexts within agent graph states with canonical pointers formatted as `vault_ref://${fileId}#${headingSlug}` (`formatVaultRef`, `isVaultRef`), eliminating plaintext from state channels.
- **Just-In-Time Pointer Dereferencing:** Implemented `resolveVaultRefJustInTime` to dereference `vault_ref://` pointers strictly during prompt construction or 3-way merge without mutating stored graph state. Fast-returns when text contains no pointers; validates pointer memory integrity before string decoding.
- **Deterministic Memory Zeroization:** Implemented `zeroOutEphemeralVaultMemory` executing `buffer.fill(0)` across all stored section buffers in a guaranteed `finally` block upon scope termination or error unwinding.
- **Plaintext Leak Query API:** Exposes `getActiveEphemeralVaultPlaintexts` and `hasActiveVaultPlaintextInMemory` for proactive leak assertions by the checkpoint serializer.
- **Domain Errors:** Introduces `EphemeralVaultScopeError` and `EphemeralVaultResolutionError`.

### Encrypted Checkpoint Serializer (`src/core/agent/checkpoint-serializer.ts`)

- **LangGraph Serializer Protocol:** Implemented `SerializerProtocol` for `PostgresSaver` checkpoint serialization, providing authenticated `AES-256-GCM` encryption for agent session checkpoints.
- **HKDF Key Derivation:** Derives a 256-bit AES key via `crypto.hkdfSync("sha256", keyMaterial, salt, info, 32)` from server secret material (`CHECKPOINT_ENCRYPTION_KEY`, `AUTH_SECRET`, or `NEXTAUTH_SECRET`).
- **Authenticated Encryption with Type-Bound AAD:** Encrypts serialized states using a 12-byte random IV, 16-byte authentication tag, and Additional Authenticated Data (AAD) bound to `elixent:v1:checkpoint:${innerType}`.
- **PostgresSaver JSONB Compatibility:** Emits valid UTF-8 JSON representations of `EncryptedCheckpointEnvelope`, ensuring seamless parsing and querying by PostgreSQL `JSONB` columns.
- **Idempotent Pass-Through Protection:** Prevents catastrophic double-encryption during `PostgresSaver._loadMetadata` by detecting pre-existing `EncryptedCheckpointEnvelope` objects.
- **Zero-Knowledge Plaintext Leak Assertion:** Implemented `assertNoVaultPlaintextLeak`, inspecting serialized payloads prior to encryption to verify that no active decrypted vault plaintexts ($\ge 4$ characters) appear outside of `vault_ref://` pointers. Throws `CheckpointVaultLeakError` (`VAULT_PLAINTEXT_LEAK_DETECTED`) upon any violation.
- **Complex Type Preservation & Legacy Fallback:** Encapsulates LangGraph's internal `JsonPlusSerializer` (via `MemorySaver().serde`) to preserve complex types (`Date`, `Map`, `Set`, `RegExp`, `DeltaSnapshot`), while supporting graceful fallback for unencrypted legacy checkpoints.

### Unified Workspace Provider Contracts & Implementation (`src/core/workspace/provider.ts` & `src/core/workspace/cloud-provider.ts`)

- **Unified IWorkspaceProvider Contract:** Defined the storage-agnostic `IWorkspaceProvider` interface (`listHeadingsTree`, `readSectionByHeading`, `searchLexicalWithASTBreadcrumb`, `mergeSectionThreeWay`), `SectionReadResult`, and `AgentStreamRequestPayload`.
- **Tenant Isolation & File Ownership:** `CloudPostgresWorkspaceProvider` queries strictly enforce `files.userId === session.userId` and exclude soft-deleted records (`deletedAt IS NULL`), throwing `WorkspaceFileAccessDeniedError` (404) upon ownership mismatch.
- **Zero-Knowledge User Consent Gate:** Checks `schema.userVaultProfiles.allowAIOnEncryptedFiles`, rejecting encrypted file operations with HTTP 403 `VaultAIAccessDeniedError` when disabled by user policy.
- **Decrypted Payload Missing Gate:** Rejects operations on encrypted files with HTTP 400 `EncryptedPayloadMissingError` if no decrypted plaintext is supplied in `ephemeralVaultPayloads` or `liveDocumentSnapshots`.
- **Automatic Vault Pointer Redaction:** In `readSectionByHeading`, stores decrypted sections in `EphemeralVaultMemoryMap` and returns opaque `vault_ref://` pointers. In `searchLexicalWithASTBreadcrumb`, intercepts BM25 lexical matches on encrypted files and redacts `matchedExcerpt` into ephemeral `vault_ref://` pointers.
- **Section-Scoped 3-Way Merge Integration:** In `mergeSectionThreeWay`, dereferences embedded `vault_ref://` pointers just-in-time across base, proposed, and live text before invoking `diff3MergeSection`, validating output with `validateMarkdownSyntaxIntegrity`.

### Verification & Metrics Baseline

- **Dedicated Phase 6 Suites:** 3 new test suites delivering 90 passing tests:
  - `src/test/vault/ephemeral-memory-map.test.ts` (24 tests)
  - `src/test/agent/checkpoint-serializer.test.ts` (25 tests)
  - `src/test/workspace/cloud-provider-and-vault.test.ts` (41 tests)
- **Synchronized SSOT Metrics:** Validated via `scripts/sync-doc-metrics.mjs`:
  - Unit & Contract: 101 suites, 1,431 tests (100% green).
  - Live Multi-System Integration: 21 suites, 108 tests (100% green).
  - Browser E2E Journeys: 14 specs, 15 user journeys (100% green).
- **Phase Closure Dossier:** Documented in [`docs/records/closures/elixent-execution/phase-06-vault-boundary-checkpoints-and-provider.md`](records/closures/elixent-execution/phase-06-vault-boundary-checkpoints-and-provider.md).

---

## [0.5.0] - 2026-10-30 (Phase 5: Fence-Aware AST Heading Slicer, Section-Scoped Diff3 & Hybrid BM25 Search Engine)

### Fence-Aware AST Heading Slicer (`src/core/ast/heading-slicer.ts`)

- **CommonMark §4.2 & §4.5 Compliant Parsing:** Implemented `parseMarkdownHeadingTree` with state-machine code fence tracking (` ``` ` and `~~~`), strictly ignoring `#` comment lines inside code blocks. Skips YAML frontmatter delimiters (`---` and `...`) at document start.
- **Section Span Calculation:** Computes deterministic section boundaries where a section for heading $H_k$ (level $L \in [1, 6]$) extends up to the line immediately preceding the next heading with level $L_{\text{next}} \le L$.
- **Hierarchical Breadcrumbs & Unicode Slugs:** Maintains an active heading stack to generate ancestor breadcrumb strings (`"Parent > Child"`) and emits URL-friendly, Unicode-aware heading slugs with collision resolution (`slug`, `slug-1`, `slug-2`).
- **Pure TypeScript SHA-256 (Zero `node:crypto` Imports):** Built bitwise FIPS 180-4 SHA-256 implementation (`computeSectionHash`) to hash normalized section contents (`\0` removed, CRLF/CR to LF, Unicode NFC), guaranteeing 100% Next.js client-side bundle safety without polyfills.
- **Section Body Slicing:** Exposes `extractSectionBySlug` extracting `heading`, `sectionContent`, and subordinate `sectionBody` excluding the heading line.

### Section-Scoped 3-Way Merge Engine (`src/lib/sync/diff3.ts`)

- **Section-Targeted Conflict Containment (`diff3MergeSection`):** Resolves targeted sections via `extractSectionBySlug`, executes 3-way merge via `diff3MergeText(liveSectionContent, baseSectionContent, agentProposedSectionContent)` with exact `(local, base, remote)` parameter ordering, and quaranitines conflicts strictly within section boundaries (`status: "conflict_quarantined"`).
- **Algebraic Splicing Invariant:** Enforces the replacement guarantee:
  $$\text{liveDoc.slice}(0, \text{from}) + \text{replacementText} + \text{liveDoc.slice}(\text{to}) \equiv \text{mergedDoc}$$
- **Post-Merge Markdown Syntax Integrity Gate:** Validates merged output using `validateMarkdownSyntaxIntegrity`, catching unclosed code blocks or broken tables and returning `status: "syntax_invalid"` with diagnostics.

### Path-Coupled Hybrid BM25 Search Engine (`src/core/workspace/lexical-bm25.ts`)

- **Okapi BM25 with Robertson-Spärck Jones IDF:** Implemented `LexicalBM25SearchEngine` with $k_1 = 1.5, b = 0.75$ and non-negative IDF:
  $$\text{IDF}(q_i) = \ln\left(1 + \frac{N - n(q_i) + 0.5}{n(q_i) + 0.5}\right)$$
  guarded against division by zero on empty indexes.
- **Arabic & Latin Normalization (`normalizeLexicalText`):** Strips BiDi control characters, Tashkeel diacritics, and Tatweel/Kashida; unifies Alef variants (`[إأآٱ] -> ا`), Teh Marbuta (`ة -> ه`), Yeh/Alef Maksura (`[ىئ] -> ي`), and Waw with Hamza (`ؤ -> و`); converts Persian and Arabic-Indic numerals (`[٠-٩۰-۹]`) to ASCII `0-9`; applies Latin case-folding and punctuation normalization.
- **Compound Identifier Subword Tokenization (`tokenizeLexicalText`):** Splits `camelCase`, `snake_case`, and `kebab-case` into unified tokens and constituent subwords, enabling code and technical term discovery.
- **ReDoS Resilience & Security Guards:** Enforces query length cap ($\le 100$), nested quantifier static analysis rejection, and safe regex evaluation inside try/catch with literal substring fallback.
- **AST Heading Coupling:** Partitions documents into atomic semantic chunks (`partitionDocumentIntoChunks`) across GFM tables, code blocks, and paragraphs, associating each chunk with its nearest enclosing `HeadingNode` (`headingSlug`, `headingBreadcrumb`, 1-based `lineRange`).
- **High-Level Search Orchestrator:** Implemented `searchLexicalWithASTBreadcrumb` supporting multi-document corpus searches with deterministic tie-breaking (`bm25Score` desc, `fileId` asc, `lineRange[0]` asc).

### Verification & Metrics Baseline

- **Dedicated Workspace Suites:** Authoritative coverage across 3 new unit test suites (107 tests):
  - `src/test/workspace/ast-heading-slicer.test.ts` (40 tests)
  - `src/test/workspace/ast-slicer-and-diff3.test.ts` (30 tests)
  - `src/test/workspace/lexical-bm25.test.ts` (37 tests)
- **Synchronized SSOT Metrics:** Validated via `scripts/sync-doc-metrics.mjs`:
  - Unit & Contract: 98 suites, 1,341 tests (100% green).
  - Live Multi-System Integration: 21 suites, 108 tests (100% green).
  - Browser E2E Journeys: 14 specs, 15 user journeys (100% green).
- **Phase Closure Dossier:** Documented in [`docs/records/closures/elixent-execution/phase-05-ast-slicer-diff3-and-bm25.md`](records/closures/elixent-execution/phase-05-ast-slicer-diff3-and-bm25.md).

---

## [0.4.6] - 2026-10-30 (Playwright E2E CI/CD Stability & Stripe Webhook Secret Hermeticity)

### Playwright E2E Stream Lifecycle & CI Secret Hermeticity

- **Route Callback Lifecycle Teardown (`07-ai-abort-reject.spec.ts`):** Eradicated `page.waitForTimeout` crash during route handler interception by decoupling stream simulation delay to standard promise timers, backed by explicit `unrouteAll({ behavior: "ignoreErrors" })` in `test.afterEach`.
- **Stripe Webhook Signature CI Disparity (`13-stripe-billing.spec.ts`):** Resolved signature verification failure in CI Stage 6 by injecting default mock credentials (`STRIPE_WEBHOOK_SECRET` and `STRIPE_SECRET_KEY`) into `.env.test`, `.github/workflows/ci.yml`, and `playwright.config.ts` `webServer.env`.
- **Defensive Webhook Test Fallback:** Hardened `src/app/api/stripe/webhook/route.ts` and `src/lib/stripe/index.ts` with explicit test-environment secret fallbacks when `NODE_ENV === "test"` or `PLAYWRIGHT === "1"`.
- **Verification:** 100% green execution across targeted user journeys (`Scenario 7`, `Scenario 8`, and `Scenario 14`).

---

## [0.4.5] - 2026-10-29 (Comprehensive Test Engineering Refactor, Anti-Pattern Eradication & Playwright E2E Hardening)

### Repository-Wide Anti-Pattern Eradication & Test Modernization

- **Systemic Anti-Pattern Remediation:** Systematically audited 134 test files (1,364 tests) and eradicated 5 major anti-pattern clusters: In-Test Surrogates, Tautological Assertions, Massive Copy-Paste Duplication, Hand-Rolled ORM Mocks, and Phantom E2E component tests.
- **Net LOC Reduction & Maintainability:** Pruned 5,011 lines of fragile, duplicated, and unmaintainable test code while introducing 2,558 lines of high-fidelity contract assertions, achieving a net repository reduction of 2,453 LOC.
- **Parametrized Vitest Compression:** Refactored bloated repetitive test blocks across auth, sync, parsers, and editor suites into declarative `test.each` tables with typed row schemas, improving maintainability and debugging clarity without reducing scenario breadth.
- **Surrogate Purge & Production Import Alignment:** Eradicated in-test reimplementation of algorithms (such as custom token derivation math or byte parsers), replacing them with direct imports from canonical production modules (`src/lib/metering/derivation-and-lua.ts`, `src/lib/parsers/`, and `src/server/services/`).

### Sacred Incident Regression Protection

- **Historical Regression Defense:** Verified and defended all 89 sacred incident regressions (covering `INC-01` through `INC-12`, `LUGX-001` through `LUGX-065`, and `TD-01` through `TD-20`), ensuring zero regressions were lost or compromised during the refactor.
- **Contract-Bound Assertions:** Elevated fragile surrogate mocks in incident tests to robust contract assertions validating real side effects, ACID rollbacks, Redis TTL expirations, and RFC 7807 problem details.

### Test Suite Modularization & Dead Code Purge

- **Decomposition of Monolithic Metering Suite:** Decomposed the 914-line `src/test/metering/credit-metering-suite.test.ts` into 5 cohesive, single-responsibility unit suites under `src/test/metering/`:
  - `cold-start.unit.test.ts`: Flush-First cold-start protocol and wallet hydration locks.
  - `stream-governor.unit.test.ts`: Real-time streaming governor, 500ms local hold, and abort propagation.
  - `node-gate.unit.test.ts`: LangGraph higher-order metered node gate and step idempotency.
  - `ai-settlement-service.unit.test.ts`: PostgreSQL batch draining and credit ledger transaction settlement.
  - `derivation-and-lua.unit.test.ts`: Model reservation token cost derivation and atomic Lua script execution.
- **Dead Legacy Mock Purge:** Permanently deleted obsolete and dead mock test files (`src/test/ai/ai-provider-smoke.test.ts` and `src/test/server/subscription-actions.test.ts`), whose coverage is now natively provided by `ai-client.test.ts`, `stripe-webhook.test.ts`, and `billing-service.test.ts`.
- **Live Cloud Smoke Isolation:** Renamed `src/test/ai/ai-live-e2e.test.ts` to `src/test/ai/ai-live-e2e.live.test.ts` and formally registered it in `vitest.constants.mts` (`CLOUD_E2E_FILES`), guaranteeing pure unit suites (`npm run test`) remain 100% hermetic with zero external cloud network calls.

### Playwright E2E Browser Journey Hardening & 100% Green Verification

- **Full Suite Remediation:** Diagnosed and remediated all 8 failing specs across 14 spec files and 15 user journeys, achieving 100% pass rate in headless Chromium (`15 passed out of 15 in 4.0m`):
  - **CodeMirror 6 Navigation Invariant (`03-codemirror-bidi.spec.ts`):** Replaced coordinate clicks with `page.keyboard.press("Control+End")` to ensure cursor placement at absolute document EOF outside code blocks.
  - **Remote Hydration Barrier & Ghost Widget Locator (`06-ai-streaming-commit.spec.ts`, `07-ai-abort-reject.spec.ts`):** Introduced explicit remote Neon DB hydration barriers (`await expect(cmContent).toContainText(...)`) before executing AI actions, preventing premature empty-buffer rejections. Switched ghost preview assertions to CodeMirror's dedicated `.cm-ai-ghost-text` DOM widget.
  - **Strict Locator Resolution (`08-ai-failure-refund.spec.ts`):** Resolved multi-element strict mode ambiguity by targeting the primary error notification via `.first()`.
  - **Dynamic Remote Version for HTTP 412 Conflict Testing (`09-ai-conflict-412.spec.ts`):** Calculated the conflicting remote server version dynamically `(preDoc.version ?? 1) + 1` from the active document state, eliminating race conditions caused by autosave debouncing.
  - **Encrypted Vault Lifecycle Modal Alignment (`10-vault-lifecycle.spec.ts`):** Aligned locators with the canonical `VaultUnlockModal` heading and password input, dismissing automatic unlock prompts before asserting toolbar controls.
  - **Tenant Isolation Error Banner Handling (`14-tenant-isolation.spec.ts`):** Updated assertions to verify the fatal error banner on unauthorized access and interactively click the return-to-workspace action.

### Authoritative SSOT Metrics Baseline

- **Synchronized Documentation Metrics:** Validated via `scripts/sync-doc-metrics.mjs --check`:
  - **Unit & Contract:** 95 test suites, 1,234 passing tests (100% green).
  - **Live Multi-System Integration:** 21 test suites, 108 passing tests (100% green).
  - **Browser E2E Journeys:** 14 spec files, 15 passing user journeys (100% green).
  - **Total Repository Passing Tests:** 1,357 tests passing across all three tiers.
- **Phase Closure Dossier:** Documented in [`docs/records/closures/extensions/comprehensive-test-engineering-refactor-and-e2e-hardening-closure.md`](records/closures/extensions/comprehensive-test-engineering-refactor-and-e2e-hardening-closure.md).

---

## [0.4.1] - 2026-10-28 (Repository Code Hygiene, Strict Typing Hardening & Full ESLint Remediation)

### Full ESLint Zero-Defect Remediation

- **Repository-Wide Lint Cleanliness:** Remediated all 62 ESLint failures (5 errors and 57 warnings) across 14 files under strict engineering discipline, achieving 0 errors and 0 warnings with zero suppression comments (`eslint-disable`).
- **Critical Gate Inspection:** Validated that none of the lint failures represented underlying business logic defects or regressions.

### Type Safety Hardening & Redis Client Contracts

- **Redis Multi-Backend Abstractions:** Introduced strongly-typed client interfaces (`ColdStartRedisClient`, `NodeGateRedisClient`, `SettlementRedisClient`) supporting Upstash Redis, in-memory Map clients, and Lua script fallback runners without requiring `client: any` parameters (`src/lib/metering/cold-start.ts`, `src/lib/metering/node-gate.ts`, `src/server/services/ai-settlement-service.ts`).
- **Canonical Drizzle Enum Typing:** Replaced loose casts in PostgreSQL batch draining with canonical Drizzle schema enum types `schema.executionModeEnum.enumValues[number]` and `schema.ledgerSettlementStatusEnum.enumValues[number]` (`src/server/services/ai-settlement-service.ts`).
- **Stripe Webhook Typing Hardening:** Strongly typed invoice subscription details metadata and line-item extraction in `src/app/api/stripe/webhook/route.ts`, eliminating `as any` casts.
- **Drizzle Client Query Typing:** Typed database instances in `src/server/services/billing-service.ts` (`const dbInstance = targetDb as unknown as typeof db`), removing `(targetDb as any)` assertions during dual-write top-ups.
- **LangGraph Metered Node Wrapper Typing:** Replaced loose `any` signatures in `withMeteredNodeGate` with generic type-safe `unknown` / `TResult` parameters and runtime object narrowing for token usage metrics (`src/lib/metering/node-gate.ts`).

### Test Suite Hygiene & Modern Standards

- **ESM Dynamic Imports for Route Deletion Invariants:** Replaced forbidden CommonJS `require()` calls in `src/test/api/stripe-webhook.test.ts` with dynamic `await expect(import(/* @vite-ignore */ ... as string)).rejects.toThrow()` to comply with `@typescript-eslint/no-require-imports`.
- **Safe Optional Chain Assertions:** Refactored fragile non-null asserted optional chains (`?.get()!`) into explicit two-step assertions in `src/test/metering/stream-governor.unit.test.ts`.
- **Unused Import & Variable Pruning:** Cleaned up unused imports, dead mock counters, and unreferenced parameters across all 8 affected test files (`src/test/api/stripe-webhook.test.ts`, `src/test/infrastructure/cron-overlap.test.ts`, `src/test/metering/ai-settlement-service.unit.test.ts`, `src/test/metering/cold-start.unit.test.ts`, `src/test/metering/credit-metering-suite.test.ts`, `src/test/metering/node-gate.unit.test.ts`, `src/test/metering/stream-governor.unit.test.ts`, `src/test/server/subscription-actions.test.ts`).

### Verification & Stability

- **Automated Verification:** Verified with 0 errors and 0 warnings via `npm run lint`, 0 type errors via `npx tsc --noEmit`, and 100% test pass rate (145/145 tests passing across all 9 affected suites).

---

## [0.4.0] - 2026-10-28 (Phase 4: Flush-First Cold Start, Settlement Service, StreamGovernor & Stripe/Cron Adaptation)

### Flush-First Cold Start Protocol (`src/lib/metering/cold-start.ts`)

- **Race-Free Wallet Hydration (`ensureWalletLoadedFlushFirst`):** Implemented cold-start protocol preventing double deductions when `lugx:wallet:${userId}` expires from Redis. Checks `HLEN lugx:pending_settlements:${userId}`; if pending entries exist, flushes them to PostgreSQL first via `flushPendingSettlementsToPostgres` with `HDEL`, then queries authoritative `users.creditBalanceMicro` and populates Redis via `SETNX` with a 24-hour TTL (`WALLET_TTL_SECONDS = 86400`).
- **Fail-Closed Resilience:** Enforced fail-closed behavior throwing `MeteringServiceUnavailableError` (HTTP 503) whenever Redis is unconfigured or unreachable.

### PostgreSQL Settlement Draining Service (`src/server/services/ai-settlement-service.ts`)

- **Batch Draining Engine (`flushPendingSettlementsToPostgres`):** Implemented atomic draining of pending settlement hashes from Redis into PostgreSQL `credit_ledger_transactions` using `INSERT ... ON CONFLICT (operation_id) DO NOTHING RETURNING *`. Calculates the exact net delta micro of newly inserted rows and updates `users.creditBalanceMicro` inside a single ACID transaction. Deletes drained keys via `HDEL` and removes the user from `lugx:dirty_wallets` via `SREM` when the pending hash is empty.
- **Authoritative Balance Query (`getUserCreditBalance`):** Exposed direct query for `users.creditBalanceMicro`, returning `BigInt` with safe default of `0n` for non-existent users.

### LangGraph Higher-Order Metered Node Gate (`src/lib/metering/node-gate.ts`)

- **Idempotent Pre-Node Wrapper (`withMeteredNodeGate`):** Higher-order wrapper wrapping LangGraph nodes to enforce financial gating. Computes deterministic `StepKey = sha256(threadId:checkpointId:nodeName:stepAttempt)` and checks `lugx:step_done:${stepKey}` to prevent double-billing upon graph resumption after human-in-the-loop interruptions.
- **Cold-Start Race Recovery & Zero-Dust Drain:** Automatically reloads the wallet once if a cold-start race occurs during reservation (`COLD_START_REQUIRED`). Derives parameters via `deriveModelReservationParameters` with Zero-Dust Drain support.
- **Interruption Routing:** Returns structured `MeteredGateInterrupt` (`code: "INSUFFICIENT_CREDITS"`, `targetNode: "pure_interrupt_node"`) when credit balance is insufficient.
- **Execution Failure Rollback:** Automatically refunds reservations via `executeSettleOperation` (`status: "ABORTED"`, `actualTotalCostMicro: 0`) if the wrapped node throws an exception, then re-throws the error.

### Real-Time Stream Governor (`src/lib/metering/stream-governor.ts`)

- **Proactive Runway Extension:** Tracks output tokens on incoming streaming deltas (`onTokenChunk`). Automatically triggers non-blocking asynchronous reservation extension (`executeReserveOrExtend`) when remaining tokens fall below the velocity runway threshold ($\text{Remaining} \le V \times 3\text{s}$).
- **500ms Local Hold Gate:** When consumed tokens exceed confirmed reservation slices, temporarily pauses chunk delivery to client browsers for up to 500ms (`LOCAL_HOLD_TIMEOUT_MS`) to await in-flight Redis extension confirmations.
- **Hard Abort & Exact Covered Token Settlement:** If the 500ms timeout expires or an extension is rejected, immediately triggers `abortController.abort("SLICE_EXHAUSTED")` and settles the operation at the last financially covered token (`getCoveredTokens()`), releasing unconsumed reserved credits back to the wallet.

### Stripe Billing Adaptation & Dual-Write Protocol (`src/config/tiers.config.ts`, `src/server/services/billing-service.ts`, `src/app/api/stripe/webhook/route.ts`)

- **Micro-Credit Tier Allocations (`src/config/tiers.config.ts`):** Added `creditAllocationMicro` and `creditsDisplay` to `TierLimits`: Free (50M µcredits / 50 credits), Pro (1,000M µcredits / 1,000 credits), Ultra (3,500M µcredits / 3,500 credits), while preserving legacy word fields for backward compatibility.
- **Stripe Webhook Dual-Write (`src/server/services/billing-service.ts`):** Implemented `recordCreditTopup` (Step 1: PostgreSQL atomic transaction inserting `stripe_topup_${eventId}` into `credit_ledger_transactions` and incrementing `users.creditBalanceMicro`) and `executeRedisDualWrite` (Step 2: Upstash Redis `INCRBY` via `executeStripeDualWrite` if wallet is live).
- **Subscription Renewal Top-Up (`invoice.paid`):** Implemented `handleInvoicePaid` in `src/app/api/stripe/webhook/route.ts` to automatically renew subscription periods and allocate recurring monthly credits.
- **Duplicate Route Pruning:** Permanently deleted redundant duplicate webhook routes `src/app/api/billing/webhook/route.ts` and `src/app/api/webhooks/stripe/route.ts`, consolidating 100% of webhook ingestion under `src/app/api/stripe/webhook/route.ts`.

### Periodic Batch Draining Cron Job (`src/app/api/cron/expire-reservations/route.ts`)

- **Dirty Wallet Draining Loop:** Refactored cron route to acquire distributed lock via `acquireCronLock`, iterate over `lugx:dirty_wallets`, and drain pending records into PostgreSQL via `flushPendingSettlementsToPostgres`.
- **30-Second Grace Guard:** Enforced `onlyOlderThanMs: 30_000` (`DIRTY_SETTLEMENT_GRACE_MS`) to bypass young settlements and eliminate race conditions with active Next.js `after()` callbacks.

### Comprehensive Test Verification Baseline

- **Acceptance Test Suite (`src/test/metering/credit-metering-suite.test.ts`):** 100% pass rate across all six canonical acceptance criteria (`MTR-01` through `MTR-06`).
- **Repository Verification Baseline:** 98 unit suites (1221 tests) passing 100%, 21 live suites (119 tests) passing 100%, 14 E2E specs (15 journeys), zero TypeScript errors (`tsc --noEmit`), and zero broken markdown links (`check-markdown-links.mjs`).

---

## [0.3.0] - 2026-10-28 (Phase 3: Lean Dynamic Model Registry, Derivation Math & Atomic Redis Lua Scripts)

### Lean Dynamic Model Registry (`src/config/models.config.json`)

- **Configured 7 Canonical Models:** Transformed `models.config.json` into a lean registry under `"models"` indexing 7 models with canonical parameters (`executionMode`, velocity $V$, `creditsPer1kInput`, `creditsPer1kCacheRead`, `creditsPer1kOutput`, and `calibrationPriors`):
  - `openai/gpt-6-luna-decisions` (`SINGLE_PASS_DECISION`, $V = 0$, priors $\{0.22, 0.42\}$)
  - `microsoft/decision-1` (`SINGLE_PASS_DECISION`, $V = 0$, priors $\{0.22, 0.42\}$)
  - `typesafe/jev-1.13` (`SINGLE_PASS_DECISION`, $V = 0$, priors $\{0.08, 0.22\}$)
  - `fastino/glide` (`DISCRETE_THINKING`, $V = 85$, priors $\{0.09, 0.24\}$)
  - `google/gemini-4-argon` (`STREAMING_GENERATIVE`, $V = 100$)
  - `google/gemini-3.8-flash` (`STREAMING_GENERATIVE`, $V = 120$)
  - `google/gemini-3.1-pro` (`STREAMING_GENERATIVE`, $V = 95$)
- **Legacy AI Client Compatibility:** Preserved all existing legacy operation blocks (`correct`, `improve`, `translate`, `summarize`, `toPrompt`, fallbacks, and temperature settings) ensuring 100% backward compatibility for `src/lib/ai/client.ts` (24/24 tests passing).

### Pure Micro-Credit Derivation Math (`src/lib/metering/derivation.ts`)

- **Micro-Credit Scale & Conversion:** Implemented `tokensToMicroCredits(tokens, creditsPer1k)` calculating $\lceil \text{Tokens} \times \text{CreditsPer1k} \times 1,000 \rceil$ in integer Micro-Credits ($10^6\text{ micro-credits} = 1\text{ credit}$).
- **Three-Mode Reservation Derivation:**
  - `SINGLE_PASS_DECISION`: Input tokens reserved only, $L_{\text{allocated}} = 0$, $\text{Trigger} = 0$, `creditsPer1kOutput = 0`, eliminating division-by-zero risks.
  - `DISCRETE_THINKING`: Reserves input plus discrete thinking ceiling ($B_{\text{discrete}} = 1500\text{ tokens}$ or node override), $\text{Trigger} = 0$.
  - `STREAMING_GENERATIVE`: Computes operational chunk $L_{\text{calc}} = \max(L_{\min}, \lceil V \times T_{\text{chunk}} \rceil)$ and runway trigger $\lceil V \times T_{\text{runway}} \rceil$.
- **Zero-Dust Drain Rule:** Waives the $L_{\min} = 500$ floor constraint when user token capacity is within $0 < \text{capacity} < L_{\min}$, setting `isZeroDustAllowed = true` and reserving the exact remaining micro-credit balance to drain user wallets down to precisely $0$ without stranding fractional dust.

### Pessimistic Tokenization Foundation (`src/lib/metering/tokenizer.ts`)

- **`js-tiktoken` Singleton:** Lazily instantiates `cl100k_base` tokenizer singleton for fast in-process token counting.
- **Pessimistic Safety Margin:** Multiplies raw token counts by $+15\%$ (`PESSIMISTIC_TOKEN_MARGIN = 1.15`) with ceiling rounding to absorb cross-provider tokenization divergence and multilingual token expansions.

### Metering Constants & Redis Key Builders (`src/lib/metering/constants.ts`)

- **Financial & Timing Constants:** Defined `MICRO_PER_CREDIT = 1_000_000n`, $T_{\text{runway}} = 3\text{s}$ ($3,000\text{ms}$), $T_{\text{chunk}} = 10\text{s}$, $L_{\min} = 500\text{ tokens}$, $B_{\text{discrete}} = 1500\text{ tokens}$, `LOCAL_HOLD_TIMEOUT_MS = 500ms`, `DIRTY_SETTLEMENT_GRACE_MS = 30_000ms`.
- **Key Lifecycles & TTLs:** `LEASE_TTL_SECONDS = 120s`, `WALLET_TTL_SECONDS = 86400s` ($24\text{h}$), `STEP_DONE_TTL_SECONDS = 3600s` ($1\text{h}$).
- **Canonical Redis Key Builders (`REDIS_KEYS`):** Centralized builders for `lugx:wallet:${userId}`, `lugx:lease:${operationId}`, `lugx:step_done:${stepKey}`, `lugx:pending_settlements:${userId}`, and `lugx:dirty_wallets`.

### Atomic Upstash Redis Lua Scripts & Execution Wrappers (`src/lib/metering/lua-scripts.ts`)

- **Pre-Flight Reservation & Chunk Extension (`RESERVE_OR_EXTEND_LUA`):** Atomic script checking idempotency via `lugx:step_done`, detecting cold wallets via `EXISTS lugx:wallet` (returning `COLD_START_REQUIRED`), applying Zero-Dust Drain logic, atomically debiting balance, and refreshing `lugx:lease:${operationId}` with 120s TTL.
- **Operation Settlement & Durability Staging (`SETTLE_OPERATION_LUA`):** Atomically refunds surplus $\max(0, \text{Reserved} - \text{Actual})$ to wallet, deletes active lease, stages pending settlement record in hash `lugx:pending_settlements:${userId}` via `HSET`, registers user in `lugx:dirty_wallets` via `SADD`, and stamps completed step receipt in `lugx:step_done:${stepKey}` with 3600s TTL.
- **Stripe Webhook Dual-Write (`STRIPE_DUAL_WRITE_LUA`):** Atomically increments live balance via `INCRBY` strictly when the wallet key exists in Redis (`EXISTS == 1`), returning `{ applied: boolean, newBalanceMicro }`.
- **Fail-Closed Policy Enforcement:** Wrapped all Lua execution in try/catch throwing `MeteringServiceUnavailableError` (`status: 503`, `code: "METERING_SERVICE_UNAVAILABLE"`) upon Redis timeout or connection failure, guaranteeing zero unmetered model execution during outages.

### Isolated Acceptance & Unit Test Verification (`src/test/metering/derivation-and-lua.unit.test.ts`)

- **High-Fidelity In-Memory Test Harness:** Authored `InMemoryRedisEvalClient` simulating Redis key mutations, multi-key TTLs, and atomic Lua execution with zero external network dependencies.
- **Verified Acceptance Criteria (22 Tests, 100% Passing):**
  - `MTR-01`: Single-pass decision input-only reservation, zero output tokens, zero trigger, boundary affordability checking.
  - `MTR-02`: Concurrency & overdraft prevention (10 concurrent requests on 3-slice balance -> exactly 3 accepted, 7 rejected, final balance precisely 0).
  - `MTR-03`: Fail-Closed policy enforcement throwing HTTP 503 `MeteringServiceUnavailableError` on connection drops or unconfigured runtime.
  - `MTR-04`: Generative streaming slice allocation and Zero-Dust Drain wallet clearing.
- **Repository Verification Baseline:** 91 unit suites (1103 tests) passing 100%, 21 live suites (118 tests), 14 E2E specs (15 journeys), clean TypeScript (`tsc --noEmit`), and synchronized SSOT documentation metrics.

---

## [0.2.0] - 2026-10-27 (Phase 2: NPM Dependencies, Database Schema Migration & Pool Export)

### Agentic & AI Orchestration Dependencies (`package.json`, `package-lock.json`)

- **Installed 7 Modern Multi-Agent & LLM Packages:** Added `@langchain/langgraph` (agent graph orchestration), `@langchain/core` (LangChain base interfaces), `@langchain/langgraph-checkpoint-postgres` (PostgreSQL state persistence for agent graphs), `ai` (Vercel AI SDK core runtime), `@ai-sdk/google` (Google Gemini provider adapter), `@ai-sdk/openai` (OpenAI provider adapter), and `js-tiktoken` (tokenization and token counting foundation).

### Database Connection Pool Reuse & Export (`src/server/db/transactional.ts`, `src/server/db/index.ts`)

- **Direct Export of `getPgPool()`:** Exported `getPgPool(): pg.Pool` from both `src/server/db/transactional.ts` and `src/server/db/index.ts`. Retained the existing `activePool` singleton instance, guaranteeing zero connection pool proliferation when instantiating `PostgresSaver` in LangGraph agent workflows while preserving strict test database isolation across TCP and Neon WebSocket protocols.

### Database Schema Evolution & Migration `0013` (`src/server/db/migrations/0013_migrate_to_credit_ledger.sql`, `src/server/db/schema/*`)

- **Micro-Credit Balance (`users.credit_balance_micro`):** Added `credit_balance_micro` (`BIGINT NOT NULL DEFAULT 0`) to `users` table protected by a database check constraint (`users_credit_balance_non_negative`: `credit_balance_micro >= 0`). Initialized existing user balances by subscription tier (`ultra`: 3,500,000,000 micro-credits, `pro`: 1,000,000,000 micro-credits, `free`/`starter`: 50,000,000 micro-credits).
- **Credit Ledger Transactions (`credit_ledger_transactions`):** Established immutable double-entry credit ledger schema (`src/server/db/schema/credit-ledger.ts`) with enums `ai_execution_mode` (`SINGLE_PASS_DECISION`, `DISCRETE_THINKING`, `STREAMING_GENERATIVE`, `CREDIT_TOPUP`) and `ledger_settlement_status` (`SETTLED`, `ABORTED`, `TOPUP_APPLIED`), indexed by `(user_id, created_at)` and `thread_id`.
- **Project Decision Architecture Ledger (`project_decision_ledger`):** Added schema (`src/server/db/schema/project-decision-ledger.ts`) recording agentic architectural decisions, evaluated alternatives, rationale, and concept tags, indexed by `(user_id, project_id)`.
- **PostgresSaver Checkpointing Tables:** Added four dedicated LangGraph persistence tables (`checkpoint_migrations`, `checkpoints`, `checkpoint_blobs`, `checkpoint_writes`) matching `@langchain/langgraph-checkpoint-postgres` requirements for multi-turn graph checkpoints.
- **Dropped Legacy Quota Tables:** Formally dropped obsolete `usage` and `ai_reservations` tables (`CASCADE`) via migration `0013` and deleted legacy schema files (`src/server/db/schema/usage.ts`, `src/server/db/schema/ai-reservations.ts`).

### Callers, Verification Script & Transitional Compatibility Bridge

- **Zero-Breakage Compatibility Bridge (`src/server/services/ai-settlement-service.ts`):** Refactored settlement and reservation services to debit, commit, and refund against `users.creditBalanceMicro` and `creditLedgerTransactions`, preserving existing function signatures (`reserveAndUpdateUsage`, `commitAIReservation`, `refundAIReservation`, `expireStaleReservations`, `getTodayUsage`) while eliminating all dependencies on dropped legacy tables.
- **Server Actions & Test Fixtures Alignment:** Removed legacy `schema.usage` and `schema.aiReservations` inserts and queries from `auth-actions.ts`, `e2e-auth/route.ts`, `src/test/test-db.ts`, and `e2e/fixtures/test-db.ts`. Initialized `creditBalanceMicro: 50_000_000n` for newly registered users on the starter tier.
- **Migration Verification Hardening (`scripts/verify-migrations.mjs`):** Updated migration integrity assertions to check all 9 active tables, 14 canonical indexes, and verify `users.credit_balance_micro` column existence, ensuring CI Stages 3 and 4 remain fully gated.
- **Comprehensive Verification Baseline:** Verified 90 unit suites (1081 tests), 21 live database integration suites (118 tests), and 14 Playwright E2E specs (15 journeys) passing 100%, with clean TypeScript (`npx tsc --noEmit`) and ESLint checks.

---

## [0.1.0] - 2026-10-27 (Phase 1: Core Cryptographic, Sync & Server Actions Hardening)

### Cryptographic Context & AAD Standardization (`src/lib/sync/webauthn-prf.ts`, `src/hooks/*`)

- **Canonical Device Wrap AAD:** Standardized WebAuthn PRF master key envelope wrapping on `AAD.deviceWrap(userId, deviceTrustEpoch)` from `@/lib/crypto/aad` (generating `lugx:v1:device:${userId}:${epoch}`), replacing ad-hoc string formatting.
- **Dual-Try Fallback Unwrapping:** Implemented fail-safe Dual-Try unwrapping in `unwrapMasterKeyWithWebAuthnPrf` (trying `canonicalAad` first, falling back to `legacyAad`) to ensure existing trusted devices unwrap transparently without user re-authentication or data loss.
- **Centralized File AAD Standardization:** Pruned legacy uninvoked `buildFileAAD` helpers in `src/hooks/use-editor-orchestrator.ts` and `src/hooks/use-editor-conflict.ts`. Standardized all file AAD construction strictly on `@/lib/crypto/aad` via `AAD.file(userId, fileId)` (`lugx:v1:file:${userId}:${fileId}`).
- **Client-Server Encrypted ETag Parity (`src/server/actions/import-file.ts`):** Passed the structured `envelope` into `generateETagSync` on encrypted file import (`isEncrypted === true`), achieving exact parity with client-side `generateEncryptedETagSync` and eliminating spurious HTTP 412 Precondition Failed conflicts on subsequent sync polling.

### Offline-First Sync & Conflict Resolution Pruning (`src/hooks/use-sync.ts`, `src/lib/sync/conflict-resolver.ts`)

- **Root Move Null-Preservation (`src/hooks/use-sync.ts`):** Replaced falsy fallback `file.parentFolderId || existingFile?.parentFolderId || null` with explicit `file.parentFolderId !== undefined ? file.parentFolderId : (existingFile?.parentFolderId ?? null)`, strictly preserving explicit `null` moves to the root folder in local IndexedDB persistence (`saveLocal`).
- **Pruned Dead Merge Methods (`src/lib/sync/conflict-resolver.ts`):** Deleted unreferenced private merge methods (`diff2Way`, `diff3Merge`, `extractSliceForRange`) from `ConflictResolver`, consolidating Diff3 logic around `src/lib/sync/diff3.ts` while strictly preserving `computeLCS`, `areArraysEqual`, and `computeWordSpans` for visual diff rendering.

### Server Actions Hardening & Rate Limiting (`src/server/actions/*`)

- **Recursive Soft-Deleted Folder Cascade (`src/server/actions/folders.ts`, `files.ts`):** Extended `getDescendantIds` signature to accept `includeDeleted: boolean = false` and pass `includeDeleted = true` inside `restoreFile`, ensuring soft-deleted subfolders and documents are revived in an atomic transaction without leaving orphaned descendant records.
- **Fail-Closed Auth Rate Limiting (`src/server/actions/auth-actions.ts`):** Wired `authRateLimiter` (`src/lib/rate-limit.ts`) to Next.js Server Actions `signInWithGoogle` (keyed by client IP address extracted from headers) and `syncUserToDatabase` (keyed by authenticated `user.id`), enforcing fail-closed protection against brute-force attacks and abuse.

### Verification & Metrics Synchronization

- **Dedicated Rate Limit Test Suite (`src/test/auth/auth-actions-rate-limit.test.ts`):** Created 6 automated tests validating IP and user-based rate limiting, fail-closed handling, and client IP fallback behavior for authentication Server Actions.
- **Core Hardening Test Verification:** Executed full Vitest verification across `src/test/sync`, `src/test/vault`, `src/test/server`, `src/test/auth`, and `src/test/editor` with 52 test files (739 tests) passing 100%.
- **Doc Metrics Synchronization:** Confirmed full compliance with canonical SSOT test metrics via `node scripts/sync-doc-metrics.mjs --check` across living documentation.

---

## [0.0.3] - 2026-10-26 (CI Stage 7 Gating & Non-Runnable Cloud Provider Smoke Bypass)

### CI Pipeline Stage 7 Gating (`.github/workflows/ci.yml`)

- **Bypassed Stage 7 Cloud Provider Smoke from Inside CI:** Replaced the live execution of `src/test/ai/ai-live-e2e.test.ts` in Stage 7 (`live-provider-smoke`) with an explicit notice (`::notice::`) and graceful zero exit (`TEST_EXIT_CODE=0`).
- **Preserved Credential Security & Fail-Closed Gate:** Retained the mandatory fail-closed credentials verification gate in Stage 7 (`TEST_DATABASE_URL` and `GEMINI_KEY_1`) so unauthenticated releases remain strictly blocked.
- **Synchronized Tag Trigger Contract:** Normalized release tag matching syntax in `ci.yml` from double quotes to single quotes (`tags: ['v*']`), bringing static CI gating simulation (`scripts/test-ci-gating.mjs`) to 100% compliance (30/30 checks green).
- **Non-Runnable Tests Protocol Compliance:** Formally recorded `src/test/ai/ai-live-e2e.test.ts` under the repository Non-Runnable Tests Protocol due to persistent upstream Google Gemini API Free Tier 503 Overload and quota instability, pending full architectural overhaul of the AI model fallback hierarchy.

---

## [0.0.2] - 2026-10-26 (CI Stabilization & Live Provider Failover Resiliency)

### CI Multi-Key Exposure & Pool Rotation (`.github/workflows/ci.yml`)

- **Exposed Full Gemini API Key Pool to CI:** Configured the runner environment across Stage 6 (Playwright E2E) and Stage 7 (Live Provider Smoke) to pass all available keys (`GEMINI_KEY_2` through `GEMINI_KEY_8`).
- **Eliminated Rate-Limit Flakiness:** Resolved intermittent `AllKeysExhaustedError` in CI pipelines where the environment had previously been artificially constrained to only `GEMINI_KEY_1`, unblocking automatic key rotation and quota exhaustion failover in CI runs.

### Per-Attempt Timeout Watchdog & Rapid Failover (`src/lib/ai/client.ts`)

- **Watchdog Controller (`ATTEMPT_TIMEOUT_MS = 15000`):** Implemented an attempt-scoped abort controller for Google Generative AI SDK calls (`processWithAI` and `streamWithAI`) when no external `AbortSignal` is supplied by the caller.
- **Provider Stall Protection:** Automatically terminates stalled socket connections when upstream Google Gemini API hangs under 503 overload, immediately tripping the overloaded model circuit breaker in Upstash Redis and falling over to the next configured fallback model (`gemini-3.8-flash` -> `3.6-flash` -> `3.5-flash-lite` -> `3.1-flash-lite`).
- **Referential Signal Contract Preservation:** Preserved exact `{ signal: callerSignal }` propagation when an explicit `AbortSignal` is supplied by the consumer, ensuring full backward compatibility and zero unit test regressions.

### Cloud Provider Smoke Gating & Resilience (`vitest.live.config.mts`, `src/test/ai/ai-live-e2e.test.ts`)

- **Standardized Timeout Inheritance:** Removed hardcoded 30-second local timeout arguments from `src/test/ai/ai-live-e2e.test.ts`, allowing tests to inherit the canonical 60-second allowance configured in `vitest.live.config.mts`.
- **Transient Spike Absorption:** Added `retry: 1` to `vitest.live.config.mts` to prevent transient cloud provider 503 hiccups from failing gated release smoke jobs.
- **Verified Local CI Execution:** Validated end-to-end execution of Stage 1 (Quality Gate) and Stage 7 (Live Provider Smoke) inside local Docker containers via the `act` CLI runner.

---

## [0.0.1] - 2026-10-26 (Documentation & Governance Initialization)

### Platform Rebranding & Version Reset (`package.json`, `README.md`, `docs/README.md`)

- **Elixent Identity & Baseline Reset:** Transitioned platform package identity to `"name": "elixent"` at `"version": "0.0.1"`, establishing the clean-slate foundation for the Elixent Agentic Architecture & Documentation Engine.
- **Unified Living Documentation Index:** Re-indexed `README.md` and `docs/README.md` around the five living architecture specifications (`01`–`05`), active reference contracts, and operational guides while preserving canonical SSOT test metrics synchronization.

### Authoritative Living Architecture Specifications (`docs/architecture/`)

- **Published 5 Core Living Architecture Specifications:**
  - `01_architecture_vision_and_adrs.md` — Architectural vision, C4 container topology, and authoritative Architectural Decision Records (`ADR-001` to `ADR-005`).
  - `02_agent_orchestration_and_decision_engine.md` — `@langchain/langgraph` 7-stage state machine, `AgentGraphState` pure reducers, Unified Decisions API (`POST /v1/decisions`), `Conformal APS` classifier, and Justification-Driven `ATMS DAG`.
  - `03_workspace_ast_editor_and_vault_integration.md` — `IWorkspaceProvider` contract, Fence-Aware Heading Slicer, hybrid `AST + BM25` lexical search, `Multi-Hunk Ghost` CodeMirror 6 overlay, and Zero-Knowledge `vault_ref://` memory isolation.
  - `04_credit_metering_and_settlement_architecture.md` — Micro-credit (`BigInt`) token metering, atomic Upstash Redis Lua scripts, `StreamGovernor` (`500ms` hold & abort), `Flush-First Cold Start`, and asynchronous PostgreSQL settlement via `after()`.
  - `05_data_contracts_and_lugx_migration_plan.md` — Drizzle ORM schema contracts (`users`, `credit_ledger_transactions`, `project_decision_ledger`, `langgraph-checkpoints`), `getPgPool()` export, Redis keyspace contracts, and codebase transformation matrix.

### Active Execution Roadmap (`docs/Plans/`)

- **Published 12-Phase Execution Plan:** Established `docs/Plans/ELIXENT_EXECUTION_PLAN.md` defining the 12 commit-sized SRP phases and intra-phase sub-agent execution waves.

### Historical Baseline Archival & Governance Modernization (`docs/records/archive/lugx-v1/`, `docs/DOCUMENTATION_GUIDELINES.md`)

- **LUGX v1.0.0–v1.46.3 Baseline Archival:** Archived historical Day-0 founding records (`docs/records/archive/lugx-v1/foundation/`), historical release notes (`docs/records/archive/lugx-v1/CHANGELOG-LUGX-v1.md`), and historical remediation plans (`docs/records/plans/comprehensive-technical-remediation-plan-lugx-v1.md`).
- **Governance Alignment:** Updated `docs/DOCUMENTATION_GUIDELINES.md` and `scripts/sync-doc-metrics.mjs` to establish `docs/architecture/` as the authoritative living specification and ADR registry.

---

## Historical Archives

- **LUGX Legacy Baseline (v1.0.0 – v1.46.3):** For the complete historical release log prior to the Elixent v0.0.1 initialization, see [`CHANGELOG-LUGX-v1.md`](./records/archive/lugx-v1/CHANGELOG-LUGX-v1.md).
