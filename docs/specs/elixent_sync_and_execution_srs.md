# Software Requirements Specification (SRS): Local-First Cookie Identity Verification & Conditional React State Flushing on Conflict and Server Fetch

| Standard Field | Approved Value |
| :--- | :--- |
| **Document ID** | `ELIXENT-SRS-LOCAL-FIRST-SYNC-v2.0` |
| **Classification** | `SOFTWARE REQUIREMENTS SPECIFICATION (SRS)` |
| **Reference Baseline** | `Elixent v0.20.2` (`272ffa1471ec1f7926c5128ad960087b4ee5e5d0`) |
| **Target Scope** | `src/lib/auth/client-identity.ts` · `src/client/routes/**` · `src/client/rpc-client.ts` · `src/lib/sync/**` · `src/hooks/use-sync.ts` · `src/hooks/use-editor-orchestrator.ts` · `src/hooks/use-editor-conflict.ts` |
| **Status** | `APPROVED FOR IMPLEMENTATION` |

## 1. Purpose & Scope

This Software Requirements Specification (**SRS**) defines the functional requirements, architectural constraints, TypeScript interfaces, and exact line-level modifications required to remediate the `Local-First` initialization and synchronization defects in **Elixent**.

The scope of this specification is strictly restricted to two architectural solutions:

1. **Solution 1 (`REQ-LF-AUTH`): Local-First Initial Identity Verification via Local Cookies (`Online & Offline Continuity`) with a Provider-Agnostic Client Identity Seam (`Better Auth Readiness`).**
2. **Solution 2 (`REQ-COND-FLUSH`): Conditional React State Flushing (`Conditional State Flushing`) into `IndexedDB` strictly when the server responds with a conflict OR when a file copy is fetched/pulled from the server (whether triggered by network reconnection or page reload).**

## 2. Root-Cause Problem Statement (`v0.20.2` Baseline)

### 2.1. Defect 1: Blocking `IndexedDB` Initialization and Editor Hydration on Live Network Auth Calls (`supabase.auth.getUser()`)

In `v0.20.2`, client route components resolve `userId` via an asynchronous network request (`supabase.auth.getUser()`) before opening the per-user `IndexedDB` database (`textai_db_${userId}`):

| File & Line Range | Current Behavior in `v0.20.2` | Operational & Architectural Impact |
| :--- | :--- | :--- |
| `src/client/routes/workspace-layout.tsx`<br>Lines `10–37` | Awaits `supabase.auth.getUser()` over the network and blocks `<Outlet />` while `isLoading === true`. When offline, `getUser()` returns `null` and line `28` redirects to `/login`. | Prevents opening the workspace or editor while offline (`Offline Mode`) and delays initial mount when online. |
| `src/client/routes/editor-page.tsx`<br>Lines `28`, `153–165`, `419` | Initializes `userId = null`, renders `<MarkdownEditor />` immediately, and calls network `supabase.auth.getUser()` inside `useEffect` (line `160`). | When offline, `userId` remains `null` permanently, `IndexedDB` never opens (`use-sync.ts:75`), and all edits remain trapped in React memory until lost on navigation or browser close. |
| `src/hooks/use-editor-orchestrator.ts`<br>Lines `1114–1128`, `1180`, `1205–1215` | `loadInitialFile()` executes as soon as `fileId` and `currentAdapter` exist while `userId === null` and `sh.isInitialized === false`. `getFile(fileId)` fetches `Version 1`, `persistClean()` (line `1115`) silently skips writing to `IndexedDB`, and `loadedFileIdRef.current = fileId` (line `1180`) locks out re-execution. | The editor displays `Version 1`, but `IndexedDB` lacks both the initial file record and the `Version 1` `baseSnapshot`. |

### 2.2. Defect 2: `baseSnapshot` Corruption During the `1,000ms` React Debounce Window and on Page Reload

`useEditorAutosave` (`src/hooks/use-editor-autosave.ts:24`) buffers user edits in React state for `1,000ms` before persisting them to `IndexedDB`. This creates two data-loss vectors during synchronization:

1. **Network Reconnection Pull (`SyncPullEngine.pullFile`) & Push Conflict (`412` / `status: "conflict"`):**
   - While offline, the user edits the document in the editor (`isDirtyRef.current === true`), starting the `1,000ms` debounce timer before `IndexedDB` is marked `isDirty: true`.
   - When connectivity is restored before the `1,000ms` window elapses, `SyncPullEngine.pullUpdates()` invokes `pullFile(serverFile)` (`src/lib/sync/sync-pull-engine.ts:167`).
   - `pullFile` reads `localFile` from `IndexedDB` (line `222` and line `301`), sees either a missing record or `localFile.isDirty === false`, and writes the server's `Version 2` into `IndexedDB` as a clean record—overwriting `baseSnapshot` with `Version 2` (lines `261` and `358`).
   - When the `1,000ms` timer expires and `executeServerWrite` sends `expectedVersion: 1`, the server responds with `status: "conflict"` (`serverVersion: Version 2`).
   - `handle412Conflict` (`src/hooks/use-editor-conflict.ts:474`) reads `baseSnapshot` from `IndexedDB`, receives `Version 2`, and runs `Diff3` with `Base (Version 2) == Remote (Version 2)`, resulting in a false `merged_clean` that silently overwrites the server's `Version 2` edit without opening `ConflictDialog`.
2. **Page Reload / Initial Server Fetch (`loadInitialFile`):**
   - Reloading the browser within the `1,000ms` debounce window does not flush React state because `flushOnUnmount` is only bound to React component unmount rather than browser `pagehide` / `beforeunload`.
   - Furthermore, when `IndexedDB` already holds dirty offline edits (`localFile.isDirty === true`) and the user reloads the page while online, `loadInitialFile()` (`src/hooks/use-editor-orchestrator.ts:897`) paints `localFile` in Step 1 without setting `isDirtyRef.current = true`. When Step 2 (`getFile(fileId)` at line `1000`) returns `Version 2` from the server, `classifyRemoteUpdate` (line `1091`) receives `isDirty: false`, returns `action: "apply"`, and overwrites the user's unsaved local edits in both the editor and `IndexedDB`.

## 3. Solution 1 Specification (`REQ-LF-AUTH`): Local-First Cookie Identity Verification & Provider Seam

### 3.1. Functional & Security Requirements

1. **Online Mode Behavior:**
   - Initial user identity (`userId`) is verified synchronously (`0ms`) from local browser cookies to mount the editor, render content, and initialize `IndexedDB` (`textai_db_${userId}`) on the first render pass.
   - Server-side session verification proceeds asynchronously in the background on mount and on every data or sync request.
   - If the server explicitly reports that the session is expired or revoked (`401 Unauthorized` / `403`), local identity cookies are cleared and the user is redirected to `/login`.
2. **Offline Mode Behavior:**
   - Initial verification relies solely on local cookies to resolve `userId`, open `IndexedDB`, and enable full offline editing without network blocking.
   - Server-side identity verification is deferred until network connectivity is restored and server communication is required.
3. **Provider-Agnostic Client Identity Seam (`Better Auth` Readiness):**
   - All client identity resolution is encapsulated inside `src/lib/auth/client-identity.ts`, maintaining a readable first-party identity cookie (`elixent_uid`, `SameSite=Lax; Path=/`) alongside session cookie parsing so that migrating from `Supabase Auth` to `Better Auth` (`HttpOnly` `better-auth.session_token` with `Neon` or `Docker PostgreSQL`) requires zero changes to editor or sync modules.

### 3.2. Client Identity Module (`src/lib/auth/client-identity.ts` — NEW)

```typescript
export interface LocalClientUserIdentity {
    id: string;
    source: "cookie" | "storage" | "server";
}

/**
 * Synchronously extracts the user ID (0ms) from local cookies
 * (elixent_uid or sb-*-auth-token including chunked .0/.1 cookies).
 */
export function resolveInitialClientUserIdSync(): string | null;

/**
 * Persists the verified user ID in a readable first-party cookie (elixent_uid)
 * for offline cold starts and Better Auth HttpOnly compatibility.
 */
export function persistLocalClientUserId(userId: string): void;

/**
 * Clears local identity artifacts upon sign-out or explicit server session expiration.
 */
export function clearLocalClientUserId(): void;

/**
 * Executes dual-mode Local-First identity verification:
 * - Returns local cookie identity immediately when present.
 * - When online, verifies the session against the server in the background and invokes
 *   onSessionExpired only on explicit server auth rejection (never on network errors).
 * - When offline, trusts the local cookie identity and defers server verification until online.
 */
export async function resolveLocalFirstAuthUser(options?: {
    onSessionExpired?: () => void;
}): Promise<{ id: string } | null>;
```

### 3.3. Route & Orchestrator Wiring

1. **`src/client/routes/workspace-layout.tsx` (Lines `10–45`):**
   - Initialize `userId` and `isLoading` synchronously from `resolveInitialClientUserIdSync()`.
   - Replace `resolveAuthUser` with `resolveLocalFirstAuthUser({ onSessionExpired: () => navigateTo("/login") })`.
2. **`src/client/routes/editor-page.tsx` (Lines `28`, `153–165`):**
   - Initialize `const [userId, setUserId] = useState<string | null>(() => resolveInitialClientUserIdSync());`.
   - Use `resolveLocalFirstAuthUser({ onSessionExpired: () => navigate("/login") })` in `useEffect`.
3. **`src/client/routes/workspace-page.tsx`, `dashboard-page.tsx`, `account-page.tsx`, `src/components/layout/sidebar.tsx`, `src/components/files/file-context-menu.tsx`, and `src/client/rpc-client.ts`:**
   - Replace direct client `supabase.auth.getUser()` calls with `resolveLocalFirstAuthUser`, and invoke `clearLocalClientUserId()` inside `signOut()` (`src/client/rpc-client.ts:413`).
4. **Initial Baseline Persistence Guard (`src/hooks/use-editor-orchestrator.ts`):**
   - Track `initialBaselinePersistedRef = useRef<boolean>(false)`. If `loadInitialFile()` completes before `syncHook.isInitialized` becomes `true`, a dedicated `useEffect` observing `syncHook.isInitialized` writes the clean baseline (`baseSnapshot`) to `IndexedDB` as soon as `syncHook.isInitialized` transitions to `true`.

## 4. Solution 2 Specification (`REQ-COND-FLUSH`): Conditional React State Flushing on Conflict or Server Fetch

### 4.1. Governing Design Rule

React editor state is **never** flushed unconditionally on every routine sync cycle; during continuous typing, `useEditorAutosave`'s `1,000ms` debounce operates without interference. Mandatory flushing of dirty React state into `IndexedDB` (`flushDirtyEditorStateToIDB`) and immediate cancellation of the `1,000ms` debounce timer (`cancelAutosave()`) are triggered **strictly in the following two cases**:

1. **Case 1 — Server Responds with a Conflict (`Server Conflict Response`):**
   When a client write (`updateFileContent`) receives a conflict response from the server (`status: "conflict"` / `412 Precondition Failed`).
2. **Case 2 — A Copy of the File is Requested/Received from the Server (`Server Copy Fetch / Pull`):**
   Whether triggered by:
   - **a. Network Reconnection / Background Server Pull (`SyncPullEngine.pullFile`):** When `pullFile(serverFile)` receives a server copy of the active file whose ETag/version diverges from `localFile` (`!localFile || !compareETags(localFile.etag, serverFile.etag)`).
   - **b. Page Reload / Initial Server Fetch (`loadInitialFile`):** Upon browser reload (`pagehide` / `beforeunload`) and when `loadInitialFile()` fetches the authoritative server copy (`getFile(fileId)`) while local unsaved edits exist.

### 4.2. Exact File & Line Modifications

1. **Conditional Flush Implementation in `src/hooks/use-editor-orchestrator.ts`:**
   - Maintain `baseContentRef = useRef<string>("")` storing the last confirmed clean server content (`Version 1`).
   - Implement `flushDirtyEditorStateToIDB(targetFileId?: string): Promise<boolean>`:
     - Checks `if (!isDirtyRef.current || !hydratedRef.current || (targetFileId && targetFileId !== fileIdRef.current)) return false;`.
     - Calls `autosaveRef.current?.cancelAutosave()` to stop the `1,000ms` timer.
     - Reads live content from `adapterRef.current?.getValue()`, encrypts via `SyncCryptoGateway.encryptOutbound` if `isEncryptedRef.current === true`, and calls `sh.saveLocal({ ..., isDirty: true, baseSnapshot: { content: baseContentRef.current, version: fileVersionRef.current, etag: fileEtagRef.current || "" } })`.
2. **Divergence-Gated Flush in `SyncPullEngine.pullFile` (`src/lib/sync/sync-pull-engine.ts:222`):**
   - Add `onBeforePullConflictCheck?: (fileId: string) => Promise<boolean> | boolean` to `SyncPullEngine`, `SyncManager`, and `useSync`.
   - Inside `pullFile(serverFile)`:
     - First check `if (localFile && compareETags(localFile.etag, serverFile.etag)) return { fileId: serverFile.id, success: true, action: 'skipped' };`.
     - Only when `!localFile || !compareETags(localFile.etag, serverFile.etag)` (i.e., the server copy differs from the local copy), invoke `const flushed = await this.onBeforePullConflictCheck?.(serverFile.id);` and, if `flushed === true`, re-read `localFile = await this.idb.getFile(serverFile.id);` before evaluating `if (!localFile)` and `if (localFile.isDirty)` (line `301`).
3. **Push-Conflict Flush in `executeServerWrite` & `handle412Conflict` (`src/hooks/use-editor-orchestrator.ts:801` & `src/hooks/use-editor-conflict.ts:402`):**
   - When `updateFileContent` returns `status: "conflict"`, cancel any active debounce timer (`autosaveRef.current?.cancelAutosave()`) and ensure the dirty local state and original `baseSnapshot` (`baseContentRef.current` at `fileVersionRef.current`) are persisted in `IndexedDB` before `handle412Conflict` reads `localFile.baseSnapshot`.
4. **Page Reload Flush & Reconciliation in `src/hooks/use-editor-autosave.ts` and `src/hooks/use-editor-orchestrator.ts`:**
   - Attach `pagehide` and `beforeunload` listeners to invoke `flushOnUnmount` when `isDirtyRef.current === true` so edits buffered in the `1,000ms` window are persisted to `IndexedDB` before reload.
   - In `loadInitialFile()` Step 1 (line `897`), when `localFile.isDirty === true`, set `isDirtyRef.current = true`, call `autosave.markDirty()`, and initialize `baseContentRef.current = localFile.baseSnapshot?.content ?? initialContent`.
   - In `loadInitialFile()` Step 2 (line `1012`), when `getFile(fileId)` returns from the server:
     - If `isDirtyRef.current === true`, invoke `await flushDirtyEditorStateToIDB(fileId)`.
     - Compute `const effectiveIsDirty = isDirtyRef.current || Boolean(localFile?.isDirty);` and pass `isDirty: effectiveIsDirty` to `classifyRemoteUpdate`.
     - When `decision.action === "keep_local"` with `decision.reason === "dirty_local_divergent"` (or `adopt_metadata_keep_edits` over an existing baseline), invoke `await conflictHook.handleRemoteUpdate(...)` so `Diff3` merges non-overlapping edits or opens `ConflictDialog` on overlapping edits.
5. **Explicit `baseSnapshot` Preservation in `src/hooks/use-sync.ts` (`saveLocal`, lines `241–271`):**
   - When `isTargetDirty === true`, use `file.baseSnapshot ?? existingFile?.baseSnapshot` so an explicit `baseSnapshot` passed by `flushDirtyEditorStateToIDB` is preserved even if `existingFile` was not yet written to `IndexedDB`.

## 5. Verification & Acceptance Criteria

1. **Offline Cold Start & Local Cookie Identity Verification:**
   - Mounting `/workspace/editor/:id` resolves `userId` in `0ms` from local cookies, initializes `IndexedDB`, and persists `baseSnapshot = Version 1`.
   - Opening or reloading the editor while offline (`context.setOffline(true)`) loads the document from `IndexedDB` and persists edits locally without redirecting to `/login`.
   - Explicit server session expiration (`401`) while online clears local identity cookies and redirects to `/login`.
2. **1-Second Window & Page Reload Conflict Resolution (`e2e/specs/04-offline-sync-conflict.spec.ts`):**
   - Concurrent edits to Line 1 on the server (`Version 2`) and Line 1 locally followed by immediate reconnection (`< 1,000ms`) or page reload preserve `baseSnapshot = Version 1`, execute `Diff3` with `(Base = V1, Local = Edit, Remote = V2)`, and open `ConflictDialog` (`تعارض في التزامن`) with zero silent data loss.
3. **Verification Commands:**
   ```bash
   npx tsc --noEmit
   npm test
   npx playwright test e2e/specs/01-auth-session.spec.ts e2e/specs/04-offline-sync-conflict.spec.ts
   ```
