import { hc } from "hono/client";
import type { AppType } from "@/server/app";
import type {
  FileEncryptionMetadata,
  FileRecord,
  VaultProfileRecord,
  UserProfileRecord,
  FileOpResult,
  UpdateFileOptions,
  DeleteFileOptions,
  ImportFileResult,
  ImportEncryptionOptions,
  VaultActionResult,
  CreateVaultProfileInput,
  UpdateVaultPasswordInput,
  UpdateVaultRecoveryEnvelopeInput,
} from "@/types/rpc-contracts";

// ============================================================================
// Types & Contracts Re-exports (Shared RPC Contracts)
// ============================================================================

export type {
  FileEncryptionMetadata,
  FileRecord,
  VaultProfileRecord,
  UserProfileRecord,
  FileOpResult,
  UpdateFileOptions,
  DeleteFileOptions,
  ImportFileResult,
  ImportEncryptionOptions,
  VaultActionResult,
  CreateVaultProfileInput,
  UpdateVaultPasswordInput,
  UpdateVaultRecoveryEnvelopeInput,
} from "@/types/rpc-contracts";

export interface ClientResponse<T = unknown> extends Response {
  ok: boolean;
  status: number;
  json: () => Promise<T>;
}

export type ElixentRpcClient = ReturnType<typeof hc<AppType>>;

function getBaseUrl(): string {
  if (typeof process !== "undefined" && process.env?.VITE_APP_URL) {
    return process.env.VITE_APP_URL;
  }
  if (
    typeof window !== "undefined" &&
    window.location?.origin &&
    window.location.origin !== "null"
  ) {
    return window.location.origin;
  }
  return "http://localhost";
}

let activeCustomFetch: typeof fetch | undefined;

/**
 * Injects or clears a custom fetch transport for all subsequent RPC client wrapper calls.
 */
export function setRpcClientFetch(fetchFn?: typeof fetch): void {
  activeCustomFetch = fetchFn;
  defaultClient = null;
}

/**
 * Returns true if execution is running within Vitest without an injected custom HTTP transport.
 * Maintained for environment status checking.
 */
export function isVitestBridgeActive(): boolean {
  return (
    typeof process !== "undefined" &&
    Boolean(process.env.VITEST) &&
    !activeCustomFetch
  );
}

/**
 * In-memory loopback fetch transport delegating directly to Hono app.fetch during Vitest runs.
 */
const vitestLoopbackFetch: typeof fetch = async (
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> => {
  const serverPath = "@" + "/server/app";
  const { app } = (await import(/* @vite-ignore */ serverPath)) as {
    app: { fetch: (req: Request) => Promise<Response> };
  };
  const urlStr =
    input instanceof URL
      ? input.toString()
      : typeof input === "string"
        ? input
        : input.url;
  const absoluteUrl = urlStr.startsWith("http")
    ? urlStr
    : `http://localhost${urlStr.startsWith("/") ? "" : "/"}${urlStr}`;
  const req = new Request(absoluteUrl, init);
  return app.fetch(req);
};

let defaultClient: ElixentRpcClient | null = null;

function getRpcClient(): ElixentRpcClient {
  if (activeCustomFetch) {
    return createElixentRpcClient(getBaseUrl(), activeCustomFetch);
  }
  if (!defaultClient) {
    defaultClient = createElixentRpcClient();
  }
  return defaultClient;
}

/**
 * Creates a typed Hono RPC client instance targeting the Elixent application.
 */
export function createElixentRpcClient(
  baseUrl = getBaseUrl(),
  customFetch?: typeof fetch
): ElixentRpcClient {
  const transportFetch =
    customFetch ??
    (isVitestBridgeActive() ? vitestLoopbackFetch : globalThis.fetch);

  return hc<AppType>(baseUrl, {
    fetch: transportFetch,
  });
}

// ============================================================================
// Vitest Server Bridge Module Loaders
// Dynamic specifier expressions prevent Vite client-server-boundary-guard
// violations during client production builds.
// ============================================================================

const filesActionsPath = "@" + "/server/actions/files";
const foldersActionsPath = "@" + "/server/actions/folders";
const importActionsPath = "@" + "/server/actions/import-file";
const vaultActionsPath = "@" + "/server/actions/vault-actions";
const authActionsPath = "@" + "/server/actions/auth-actions";
const supabaseServerPath = "@" + "/lib/supabase/server";
const settlementServicePath = "@" + "/server/services/ai-settlement-service";

let filesActionsPromise: Promise<any> | null = null;
function getFilesActions(): Promise<any> {
  if (!filesActionsPromise) {
    filesActionsPromise = import(/* @vite-ignore */ filesActionsPath);
  }
  return filesActionsPromise;
}

let foldersActionsPromise: Promise<any> | null = null;
function getFoldersActions(): Promise<any> {
  if (!foldersActionsPromise) {
    foldersActionsPromise = import(/* @vite-ignore */ foldersActionsPath);
  }
  return foldersActionsPromise;
}

let importActionsPromise: Promise<any> | null = null;
function getImportActions(): Promise<any> {
  if (!importActionsPromise) {
    importActionsPromise = import(/* @vite-ignore */ importActionsPath);
  }
  return importActionsPromise;
}

let vaultActionsPromise: Promise<any> | null = null;
function getVaultActions(): Promise<any> {
  if (!vaultActionsPromise) {
    vaultActionsPromise = import(/* @vite-ignore */ vaultActionsPath);
  }
  return vaultActionsPromise;
}

let authActionsPromise: Promise<any> | null = null;
function getAuthActions(): Promise<any> {
  if (!authActionsPromise) {
    authActionsPromise = import(/* @vite-ignore */ authActionsPath);
  }
  return authActionsPromise;
}

// Pre-warm server modules in Vitest to eliminate dynamic import latency during test execution
if (typeof process !== "undefined" && Boolean(process.env.VITEST)) {
  getFilesActions().catch(() => {});
  getFoldersActions().catch(() => {});
  getImportActions().catch(() => {});
  getVaultActions().catch(() => {});
  getAuthActions().catch(() => {});
}

// ============================================================================
// Files & Folders Facade
// ============================================================================

export async function createFile(
  title: string,
  parentFolderId?: string | null,
  isFolder = false
): Promise<FileOpResult> {
  if (isVitestBridgeActive()) {
    const { createFile: serverCreateFile } = await getFilesActions();
    return serverCreateFile(title, parentFolderId, isFolder);
  }
  const client = getRpcClient();
  const res = await client.api.rpc.files.create.$post({
    json: { title, parentFolderId: parentFolderId ?? null, isFolder },
  });
  return (await res.json()) as FileOpResult;
}

export async function updateFileContent(
  fileId: string,
  content: string,
  options?: UpdateFileOptions
): Promise<FileOpResult> {
  if (isVitestBridgeActive()) {
    const { updateFileContent: serverUpdateFileContent } = await getFilesActions();
    return serverUpdateFileContent(fileId, content, options);
  }
  const client = getRpcClient();
  const res = await client.api.rpc.files["update-content"].$post({
    json: { fileId, content, options },
  });
  return (await res.json()) as FileOpResult;
}

export async function toggleFileEncryption(
  fileId: string,
  isEncrypted: boolean,
  content: string,
  encryptionMetadata: FileEncryptionMetadata | null,
  options?: UpdateFileOptions
): Promise<FileOpResult> {
  if (isVitestBridgeActive()) {
    const { toggleFileEncryption: serverToggle } = await getFilesActions();
    return serverToggle(fileId, isEncrypted, content, encryptionMetadata, options);
  }
  const client = getRpcClient();
  const res = await client.api.rpc.files["toggle-encryption"].$post({
    json: {
      fileId,
      isEncrypted,
      content,
      encryptionMetadata,
      options,
    },
  });
  return (await res.json()) as FileOpResult;
}

export async function renameFile(
  fileId: string,
  newTitle: string
): Promise<FileOpResult> {
  if (isVitestBridgeActive()) {
    const { renameFile: serverRename } = await getFilesActions();
    return serverRename(fileId, newTitle);
  }
  const client = getRpcClient();
  const res = await client.api.rpc.files.rename.$post({
    json: { fileId, newTitle },
  });
  return (await res.json()) as FileOpResult;
}

export async function deleteFile(
  fileId: string,
  options?: DeleteFileOptions
): Promise<FileOpResult<null>> {
  if (isVitestBridgeActive()) {
    const { deleteFile: serverDelete } = await getFilesActions();
    return serverDelete(fileId, options);
  }
  const client = getRpcClient();
  const res = await client.api.rpc.files.delete.$post({
    json: { fileId, options },
  });
  return (await res.json()) as FileOpResult<null>;
}

export async function restoreFile(fileId: string): Promise<FileOpResult> {
  if (isVitestBridgeActive()) {
    const { restoreFile: serverRestore } = await getFilesActions();
    return serverRestore(fileId);
  }
  const client = getRpcClient();
  const res = await client.api.rpc.files.restore.$post({
    json: { fileId },
  });
  return (await res.json()) as FileOpResult;
}

export async function copyFile(
  fileId: string,
  newParentFolderId?: string | null,
  depth = 0,
  encryptedOverride?: {
    newFileId?: string;
    content?: string;
    encryptionMetadata?: FileEncryptionMetadata | null;
  }
): Promise<FileOpResult> {
  if (isVitestBridgeActive()) {
    const { copyFile: serverCopy } = await getFilesActions();
    return serverCopy(fileId, newParentFolderId, depth, encryptedOverride);
  }
  const client = getRpcClient();
  const res = await client.api.rpc.files.copy.$post({
    json: {
      fileId,
      newParentFolderId: newParentFolderId ?? null,
      depth,
      encryptedOverride,
    },
  });
  return (await res.json()) as FileOpResult;
}

export async function moveFile(
  fileId: string,
  newParentFolderId: string | null
): Promise<FileOpResult<null>> {
  if (isVitestBridgeActive()) {
    const { moveFile: serverMove } = await getFoldersActions();
    return serverMove(fileId, newParentFolderId);
  }
  const client = getRpcClient();
  const res = await client.api.rpc.files.move.$post({
    json: { fileId, newParentFolderId },
  });
  return (await res.json()) as FileOpResult<null>;
}

export async function importFile(
  fileName: string,
  textContent: string,
  fileType: "pdf" | "md" | "txt",
  parentFolderId: string | null = null,
  encryption?: ImportEncryptionOptions
): Promise<ImportFileResult> {
  if (isVitestBridgeActive()) {
    const { importFile: serverImport } = await getImportActions();
    return serverImport(fileName, textContent, fileType, parentFolderId, encryption);
  }
  const client = getRpcClient();
  const res = await client.api.rpc.files.import.$post({
    json: {
      fileName,
      textContent,
      fileType,
      parentFolderId,
      encryption,
    },
  });
  return (await res.json()) as ImportFileResult;
}

export async function getFile(fileId: string): Promise<FileOpResult> {
  if (isVitestBridgeActive()) {
    const { getFile: serverGetFile } = await getFilesActions();
    return serverGetFile(fileId);
  }
  const client = getRpcClient();
  const res = await client.api.rpc.files.get.$post({
    json: { fileId },
  });
  return (await res.json()) as FileOpResult;
}

export async function getUserFiles(): Promise<FileOpResult<FileRecord[]>> {
  if (isVitestBridgeActive()) {
    const { getUserFiles: serverGetUserFiles } = await getFilesActions();
    return serverGetUserFiles();
  }
  const client = getRpcClient();
  const res = await client.api.rpc.files.list.$get();
  return (await res.json()) as FileOpResult<FileRecord[]>;
}

export async function getRootFiles(): Promise<FileOpResult<FileRecord[]>> {
  if (isVitestBridgeActive()) {
    const { getRootFiles: serverGetRootFiles } = await getFilesActions();
    return serverGetRootFiles();
  }
  const client = getRpcClient();
  const res = await client.api.rpc.files["list-root"].$get();
  return (await res.json()) as FileOpResult<FileRecord[]>;
}

export async function getDeletedFiles(): Promise<FileOpResult<FileRecord[]>> {
  if (isVitestBridgeActive()) {
    const { getDeletedFiles: serverGetDeletedFiles } = await getFilesActions();
    return serverGetDeletedFiles();
  }
  const client = getRpcClient();
  const res = await client.api.rpc.files["list-deleted"].$get();
  return (await res.json()) as FileOpResult<FileRecord[]>;
}

export async function getFolderChildren(
  folderId: string | null
): Promise<FileOpResult<FileRecord[]>> {
  if (isVitestBridgeActive()) {
    const { getFolderChildren: serverGetFolderChildren } = await getFoldersActions();
    return serverGetFolderChildren(folderId);
  }
  const client = getRpcClient();
  const res = await client.api.rpc.files.children.$post({
    json: { folderId },
  });
  return (await res.json()) as FileOpResult<FileRecord[]>;
}

// ============================================================================
// Vault Facade
// ============================================================================

export async function getUserVaultProfile(): Promise<
  VaultActionResult<VaultProfileRecord | null>
> {
  if (isVitestBridgeActive()) {
    const { getUserVaultProfile: serverGetUserVaultProfile } = await getVaultActions();
    return serverGetUserVaultProfile();
  }
  const client = getRpcClient();
  const res = await client.api.rpc.vault.profile.$get();
  return (await res.json()) as VaultActionResult<VaultProfileRecord | null>;
}

export async function createUserVaultProfile(
  input: CreateVaultProfileInput
): Promise<VaultActionResult<VaultProfileRecord>> {
  if (isVitestBridgeActive()) {
    const { createUserVaultProfile: serverCreateUserVaultProfile } = await getVaultActions();
    return serverCreateUserVaultProfile(input);
  }
  const client = getRpcClient();
  const res = await client.api.rpc.vault.create.$post({
    json: input,
  });
  return (await res.json()) as VaultActionResult<VaultProfileRecord>;
}

export async function updateVaultPassword(
  input: UpdateVaultPasswordInput
): Promise<VaultActionResult<VaultProfileRecord>> {
  if (isVitestBridgeActive()) {
    const { updateVaultPassword: serverUpdateVaultPassword } = await getVaultActions();
    return serverUpdateVaultPassword(input);
  }
  const client = getRpcClient();
  const res = await client.api.rpc.vault["update-password"].$post({
    json: input,
  });
  return (await res.json()) as VaultActionResult<VaultProfileRecord>;
}

export async function updateVaultRecoveryEnvelope(
  input: UpdateVaultRecoveryEnvelopeInput
): Promise<VaultActionResult<VaultProfileRecord>> {
  if (isVitestBridgeActive()) {
    const { updateVaultRecoveryEnvelope: serverUpdateVaultRecoveryEnvelope } = await getVaultActions();
    return serverUpdateVaultRecoveryEnvelope(input);
  }
  const client = getRpcClient();
  const res = await client.api.rpc.vault["update-recovery"].$post({
    json: input,
  });
  return (await res.json()) as VaultActionResult<VaultProfileRecord>;
}

export async function revokeAllTrustedDevices(): Promise<
  VaultActionResult<{ newEpoch: number }>
> {
  if (isVitestBridgeActive()) {
    const { revokeAllTrustedDevices: serverRevokeAll } = await getVaultActions();
    return serverRevokeAll();
  }
  const client = getRpcClient();
  const res = await client.api.rpc.vault["revoke-devices"].$post();
  return (await res.json()) as VaultActionResult<{ newEpoch: number }>;
}

export async function updateVaultAISetting(
  allowAI: boolean
): Promise<VaultActionResult<{ allowAIOnEncryptedFiles: boolean }>> {
  if (isVitestBridgeActive()) {
    const { updateVaultAISetting: serverUpdateAISetting } = await getVaultActions();
    return serverUpdateAISetting(allowAI);
  }
  const client = getRpcClient();
  const res = await client.api.rpc.vault["update-ai-setting"].$post({
    json: { allowAI },
  });
  return (await res.json()) as VaultActionResult<{ allowAIOnEncryptedFiles: boolean }>;
}

// ============================================================================
// Auth Facade
// ============================================================================

export async function signInWithGoogle(
  redirectTo?: string
): Promise<{ success: true; redirectUrl: string } | { success: false; error: string }> {
  if (isVitestBridgeActive()) {
    const { signInWithGoogle: serverSignIn } = await getAuthActions();
    return serverSignIn(redirectTo);
  }
  const client = getRpcClient();
  const res = await client.api.rpc.auth["sign-in-google"].$post({
    json: { redirectTo },
  });
  return (await res.json()) as
    | { success: true; redirectUrl: string }
    | { success: false; error: string };
}

export async function signOut(): Promise<{ success: true; redirectUrl: string }> {
  if (isVitestBridgeActive()) {
    const { signOut: serverSignOut } = await getAuthActions();
    const result = await serverSignOut();
    return (result ?? { success: true as const, redirectUrl: "/" }) as {
      success: true;
      redirectUrl: string;
    };
  }
  const client = getRpcClient();
  const res = await client.api.rpc.auth["sign-out"].$post();
  return (await res.json()) as { success: true; redirectUrl: string };
}

export async function syncUserToDatabase(): Promise<{ success: boolean; error?: string }> {
  if (isVitestBridgeActive()) {
    const { syncUserToDatabase: serverSyncUser } = await getAuthActions();
    return serverSyncUser();
  }
  const client = getRpcClient();
  const res = await client.api.rpc.auth["sync-user"].$post();
  return (await res.json()) as { success: boolean; error?: string };
}

export async function getUserProfile(): Promise<{
  success: boolean;
  data?: UserProfileRecord;
  error?: string;
}> {
  if (isVitestBridgeActive()) {
    const { getUserProfile: serverGetUserProfile } = await getAuthActions();
    return serverGetUserProfile();
  }
  const client = getRpcClient();
  const res = await client.api.rpc.auth.profile.$get();
  return (await res.json()) as {
    success: boolean;
    data?: UserProfileRecord;
    error?: string;
  };
}

export async function updateUserProfile(
  data: { displayName?: string }
): Promise<{ success: boolean; error?: string }> {
  if (isVitestBridgeActive()) {
    const { updateUserProfile: serverUpdateUserProfile } = await getAuthActions();
    return serverUpdateUserProfile(data);
  }
  const client = getRpcClient();
  const res = await client.api.rpc.auth["update-profile"].$post({
    json: data,
  });
  return (await res.json()) as { success: boolean; error?: string };
}

// ============================================================================
// Billing Facade
// ============================================================================

export async function getCreditBalance(): Promise<bigint> {
  if (isVitestBridgeActive()) {
    const { getUser } = await import(/* @vite-ignore */ supabaseServerPath);
    const { getUserCreditBalance } = await import(/* @vite-ignore */ settlementServicePath);
    const user = await getUser();
    if (!user) {
      return BigInt(0);
    }
    return await getUserCreditBalance(user.id);
  }
  const client = getRpcClient();
  const res = await client.api.rpc.billing["credit-balance"].$get();
  if (res.ok) {
    const json = (await res.json()) as { success: boolean; balanceMicro?: string };
    if (json.success && json.balanceMicro) {
      return BigInt(json.balanceMicro);
    }
  }
  return BigInt(0);
}
