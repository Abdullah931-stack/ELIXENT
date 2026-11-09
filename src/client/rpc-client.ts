import { hc } from "hono/client";

// ============================================================================
// Types & Contracts (Dual-Plane Client Contracts)
// ============================================================================

export interface FileEncryptionMetadata {
  version: number;
  algorithm: string;
  keyId: string;
  salt: string;
  iv: string;
  kdfIterations?: number;
}

export interface FileRecord {
  id: string;
  userId: string;
  title: string;
  content: string | null;
  parentFolderId: string | null;
  isFolder: boolean;
  isEncrypted: boolean;
  encryptionMetadata: FileEncryptionMetadata | null;
  etag: string | null;
  version: number | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface VaultProfileRecord {
  userId: string;
  encryptedMasterKey: string;
  recoveryEncryptedMasterKey: string;
  keySalt: string;
  recoverySalt: string;
  kdfIterations: number;
  keyVersion: number;
  deviceTrustEpoch: number;
  allowAIOnEncryptedFiles: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserProfileRecord {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  tier: "free" | "pro" | "ultra";
  stripeCustomerId: string | null;
  creditBalanceMicro: bigint;
  createdAt: Date;
  updatedAt: Date;
}

export interface FileOpResult<T = FileRecord> {
  success: boolean;
  data?: T;
  version?: number;
  error?: string;
  status?: "conflict" | "unauthorized" | "not_found" | "forbidden" | "error";
  etag?: string;
  correlationId?: string;
  operationId?: string;
  statusCode?: number;
  serverVersion?: {
    version?: number | null;
    etag?: string | null;
    updatedAt?: string;
    content?: string | null;
    isEncrypted?: boolean | null;
    encryptionMetadata?: FileEncryptionMetadata | null;
  };
  conflictDetails?: {
    type?: string;
    serverVersion?: number;
    baseVersion?: number;
    yourVersion?: number;
    serverETag?: string;
    message?: string;
    serverContent?: string;
    serverEncryptionMetadata?: FileEncryptionMetadata | null;
  };
}

export interface UpdateFileOptions {
  expectedVersion?: number;
  expectedETag?: string;
  operationId?: string;
}

export interface DeleteFileOptions {
  expectedVersion?: number;
  expectedETag?: string;
}

export interface ImportFileResult {
  success: boolean;
  data?: {
    id: string;
    title: string;
    content: string;
    wordCount: number;
    version: number;
    etag: string;
  };
  fileId?: string;
  file?: FileRecord;
  error?: string;
}

export interface ImportEncryptionOptions {
  isEncrypted?: boolean;
  encryptionMetadata?: FileEncryptionMetadata | null;
  fileId?: string;
}

export interface VaultActionResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  status?: "unauthorized" | "not_found" | "conflict" | "error";
}

export interface CreateVaultProfileInput {
  encryptedMasterKey: string;
  recoveryEncryptedMasterKey: string;
  keySalt: string;
  recoverySalt: string;
  kdfIterations?: number;
  keyVersion?: number;
}

export interface UpdateVaultPasswordInput {
  encryptedMasterKey: string;
  keySalt: string;
  kdfIterations?: number;
  proofOfPossession: string;
  proofNonce: string;
}

export interface UpdateVaultRecoveryEnvelopeInput {
  recoveryEncryptedMasterKey: string;
  recoverySalt?: string;
}

export interface ClientResponse<T = unknown> extends Response {
  ok: boolean;
  status: number;
  json: () => Promise<T>;
}

export type ElixentRpcClient = {
  api: {
    rpc: {
      files: {
        create: {
          $post: (args: {
            json: {
              title: string;
              parentFolderId?: string | null;
              isFolder?: boolean;
            };
          }) => Promise<ClientResponse<FileOpResult>>;
        };
        "update-content": {
          $post: (args: {
            json: {
              fileId: string;
              content: string;
              options?: UpdateFileOptions;
            };
          }) => Promise<ClientResponse<FileOpResult>>;
        };
        "toggle-encryption": {
          $post: (args: {
            json: {
              fileId: string;
              isEncrypted: boolean;
              content: string;
              encryptionMetadata: FileEncryptionMetadata | null;
              options?: UpdateFileOptions;
            };
          }) => Promise<ClientResponse<FileOpResult>>;
        };
        rename: {
          $post: (args: {
            json: { fileId: string; newTitle: string };
          }) => Promise<ClientResponse<FileOpResult>>;
        };
        delete: {
          $post: (args: {
            json: { fileId: string; options?: DeleteFileOptions };
          }) => Promise<ClientResponse<FileOpResult<null>>>;
        };
        restore: {
          $post: (args: {
            json: { fileId: string };
          }) => Promise<ClientResponse<FileOpResult>>;
        };
        copy: {
          $post: (args: {
            json: {
              fileId: string;
              newParentFolderId?: string | null;
              depth?: number;
              encryptedOverride?: {
                newFileId?: string;
                content?: string;
                encryptionMetadata?: FileEncryptionMetadata | null;
              };
            };
          }) => Promise<ClientResponse<FileOpResult>>;
        };
        move: {
          $post: (args: {
            json: { fileId: string; newParentFolderId: string | null };
          }) => Promise<ClientResponse<FileOpResult<null>>>;
        };
        import: {
          $post: (args: {
            json: {
              fileName: string;
              textContent: string;
              fileType: "pdf" | "md" | "txt";
              parentFolderId?: string | null;
              encryption?: ImportEncryptionOptions;
            };
          }) => Promise<ClientResponse<ImportFileResult>>;
        };
        get: {
          $post: (args: {
            json: { fileId: string };
          }) => Promise<ClientResponse<FileOpResult>>;
        };
        list: {
          $get: () => Promise<ClientResponse<FileOpResult<FileRecord[]>>>;
        };
        "list-root": {
          $get: () => Promise<ClientResponse<FileOpResult<FileRecord[]>>>;
        };
        "list-deleted": {
          $get: () => Promise<ClientResponse<FileOpResult<FileRecord[]>>>;
        };
        children: {
          $post: (args: {
            json: { folderId: string | null };
          }) => Promise<ClientResponse<FileOpResult<FileRecord[]>>>;
        };
      };
      vault: {
        profile: {
          $get: () => Promise<ClientResponse<VaultActionResult<VaultProfileRecord | null>>>;
        };
        create: {
          $post: (args: {
            json: CreateVaultProfileInput;
          }) => Promise<ClientResponse<VaultActionResult<VaultProfileRecord>>>;
        };
        "update-password": {
          $post: (args: {
            json: UpdateVaultPasswordInput;
          }) => Promise<ClientResponse<VaultActionResult<VaultProfileRecord>>>;
        };
        "update-recovery": {
          $post: (args: {
            json: UpdateVaultRecoveryEnvelopeInput;
          }) => Promise<ClientResponse<VaultActionResult<VaultProfileRecord>>>;
        };
        "revoke-devices": {
          $post: () => Promise<ClientResponse<VaultActionResult<{ newEpoch: number }>>>;
        };
        "update-ai-setting": {
          $post: (args: {
            json: { allowAI: boolean };
          }) => Promise<ClientResponse<VaultActionResult<{ allowAIOnEncryptedFiles: boolean }>>>;
        };
      };
      auth: {
        "sign-in-google": {
          $post: (args: {
            json: { redirectTo?: string };
          }) => Promise<
            ClientResponse<
              | { success: true; redirectUrl: string }
              | { success: false; error: string }
            >
          >;
        };
        "sign-out": {
          $post: () => Promise<ClientResponse<{ success: true; redirectUrl: string }>>;
        };
        "sync-user": {
          $post: () => Promise<ClientResponse<{ success: boolean; error?: string }>>;
        };
        profile: {
          $get: () => Promise<
            ClientResponse<{
              success: boolean;
              data?: UserProfileRecord;
              error?: string;
            }>
          >;
        };
        "update-profile": {
          $post: (args: {
            json: { displayName?: string };
          }) => Promise<ClientResponse<{ success: boolean; error?: string }>>;
        };
      };
      billing: {
        "credit-balance": {
          $get: () => Promise<
            ClientResponse<{ success: boolean; balanceMicro?: string }>
          >;
        };
      };
    };
  };
};

function getBaseUrl(): string {
  if (typeof window !== "undefined") {
    return "";
  }
  return "http://localhost";
}

/**
 * Creates a typed Hono RPC client instance targeting the Elixent application.
 */
export function createElixentRpcClient(
  baseUrl = getBaseUrl(),
  customFetch?: typeof fetch
): ElixentRpcClient {
  return hc<never>(baseUrl, {
    fetch: customFetch ?? globalThis.fetch,
  }) as unknown as ElixentRpcClient;
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

// ============================================================================
// Files & Folders Facade
// ============================================================================

export async function createFile(
  title: string,
  parentFolderId?: string | null,
  isFolder = false
): Promise<FileOpResult> {
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
  const client = getRpcClient();
  const res = await client.api.rpc.files.delete.$post({
    json: { fileId, options },
  });
  return (await res.json()) as FileOpResult<null>;
}

export async function restoreFile(fileId: string): Promise<FileOpResult> {
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
  const client = getRpcClient();
  const res = await client.api.rpc.files.get.$post({
    json: { fileId },
  });
  return (await res.json()) as FileOpResult;
}

export async function getUserFiles(): Promise<FileOpResult<FileRecord[]>> {
  const client = getRpcClient();
  const res = await client.api.rpc.files.list.$get();
  return (await res.json()) as FileOpResult<FileRecord[]>;
}

export async function getRootFiles(): Promise<FileOpResult<FileRecord[]>> {
  const client = getRpcClient();
  const res = await client.api.rpc.files["list-root"].$get();
  return (await res.json()) as FileOpResult<FileRecord[]>;
}

export async function getDeletedFiles(): Promise<FileOpResult<FileRecord[]>> {
  const client = getRpcClient();
  const res = await client.api.rpc.files["list-deleted"].$get();
  return (await res.json()) as FileOpResult<FileRecord[]>;
}

export async function getFolderChildren(
  folderId: string | null
): Promise<FileOpResult<FileRecord[]>> {
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
  const client = getRpcClient();
  const res = await client.api.rpc.vault.profile.$get();
  return (await res.json()) as VaultActionResult<VaultProfileRecord | null>;
}

export async function createUserVaultProfile(
  input: CreateVaultProfileInput
): Promise<VaultActionResult<VaultProfileRecord>> {
  const client = getRpcClient();
  const res = await client.api.rpc.vault.create.$post({
    json: input,
  });
  return (await res.json()) as VaultActionResult<VaultProfileRecord>;
}

export async function updateVaultPassword(
  input: UpdateVaultPasswordInput
): Promise<VaultActionResult<VaultProfileRecord>> {
  const client = getRpcClient();
  const res = await client.api.rpc.vault["update-password"].$post({
    json: input,
  });
  return (await res.json()) as VaultActionResult<VaultProfileRecord>;
}

export async function updateVaultRecoveryEnvelope(
  input: UpdateVaultRecoveryEnvelopeInput
): Promise<VaultActionResult<VaultProfileRecord>> {
  const client = getRpcClient();
  const res = await client.api.rpc.vault["update-recovery"].$post({
    json: input,
  });
  return (await res.json()) as VaultActionResult<VaultProfileRecord>;
}

export async function revokeAllTrustedDevices(): Promise<
  VaultActionResult<{ newEpoch: number }>
> {
  const client = getRpcClient();
  const res = await client.api.rpc.vault["revoke-devices"].$post();
  return (await res.json()) as VaultActionResult<{ newEpoch: number }>;
}

export async function updateVaultAISetting(
  allowAI: boolean
): Promise<VaultActionResult<{ allowAIOnEncryptedFiles: boolean }>> {
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
  const client = getRpcClient();
  const res = await client.api.rpc.auth["sign-in-google"].$post({
    json: { redirectTo },
  });
  return (await res.json()) as
    | { success: true; redirectUrl: string }
    | { success: false; error: string };
}

export async function signOut(): Promise<{ success: true; redirectUrl: string }> {
  const client = getRpcClient();
  const res = await client.api.rpc.auth["sign-out"].$post();
  return (await res.json()) as { success: true; redirectUrl: string };
}

export async function syncUserToDatabase(): Promise<{ success: boolean; error?: string }> {
  const client = getRpcClient();
  const res = await client.api.rpc.auth["sync-user"].$post();
  return (await res.json()) as { success: boolean; error?: string };
}

export async function getUserProfile(): Promise<{
  success: boolean;
  data?: UserProfileRecord;
  error?: string;
}> {
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
