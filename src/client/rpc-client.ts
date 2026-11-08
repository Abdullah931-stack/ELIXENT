import { hc } from "hono/client";
import type { AppType } from "@/server/app";
import type {
  FileOpResult,
  UpdateFileOptions,
  DeleteFileOptions,
} from "@/server/actions/files";
import type {
  ImportFileResult,
  ImportEncryptionOptions,
} from "@/server/actions/import-file";
import type {
  VaultActionResult,
  CreateVaultProfileInput,
  UpdateVaultPasswordInput,
  UpdateVaultRecoveryEnvelopeInput,
} from "@/server/actions/vault-actions";
import type {
  FileEncryptionMetadata,
  files,
  userVaultProfiles,
  users,
} from "@/server/db/schema";

// Re-export required contracts and input types
export type {
  FileOpResult,
  UpdateFileOptions,
  DeleteFileOptions,
  ImportFileResult,
  ImportEncryptionOptions,
  VaultActionResult,
  CreateVaultProfileInput,
  UpdateVaultPasswordInput,
  UpdateVaultRecoveryEnvelopeInput,
};

type FileRecord = typeof files.$inferSelect;
type VaultProfileRecord = typeof userVaultProfiles.$inferSelect;
type UserProfileRecord = typeof users.$inferSelect;

/**
 * Creates a typed Hono RPC client instance targeting the Elixent application.
 */
export function createElixentRpcClient(
  baseUrl = "",
  customFetch?: typeof fetch
) {
  return hc<AppType>(baseUrl, {
    fetch: customFetch ?? globalThis.fetch,
  });
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
 */
export function isVitestBridgeActive(): boolean {
  return (
    typeof process !== "undefined" &&
    Boolean(process.env.VITEST) &&
    !activeCustomFetch
  );
}

let defaultClient: ReturnType<typeof createElixentRpcClient> | null = null;

function getRpcClient(): ReturnType<typeof createElixentRpcClient> {
  if (activeCustomFetch) {
    return createElixentRpcClient("", activeCustomFetch);
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
  if (isVitestBridgeActive()) {
    const { createFile: serverCreateFile } = await import(
      /* webpackIgnore: true */ "@/server/actions/files"
    );
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
    const { updateFileContent: serverUpdateFileContent } = await import(
      /* webpackIgnore: true */ "@/server/actions/files"
    );
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
    const { toggleFileEncryption: serverToggle } = await import(
      /* webpackIgnore: true */ "@/server/actions/files"
    );
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
    const { renameFile: serverRename } = await import(
      /* webpackIgnore: true */ "@/server/actions/files"
    );
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
    const { deleteFile: serverDelete } = await import(
      /* webpackIgnore: true */ "@/server/actions/files"
    );
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
    const { restoreFile: serverRestore } = await import(
      /* webpackIgnore: true */ "@/server/actions/files"
    );
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
    const { copyFile: serverCopy } = await import(
      /* webpackIgnore: true */ "@/server/actions/files"
    );
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
    const { moveFile: serverMove } = await import(
      /* webpackIgnore: true */ "@/server/actions/folders"
    );
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
    const { importFile: serverImport } = await import(
      /* webpackIgnore: true */ "@/server/actions/import-file"
    );
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
    const { getFile: serverGetFile } = await import(
      /* webpackIgnore: true */ "@/server/actions/files"
    );
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
    const { getUserFiles: serverGetUserFiles } = await import(
      /* webpackIgnore: true */ "@/server/actions/files"
    );
    return serverGetUserFiles();
  }
  const client = getRpcClient();
  const res = await client.api.rpc.files.list.$get();
  return (await res.json()) as FileOpResult<FileRecord[]>;
}

export async function getRootFiles(): Promise<FileOpResult<FileRecord[]>> {
  if (isVitestBridgeActive()) {
    const { getRootFiles: serverGetRootFiles } = await import(
      /* webpackIgnore: true */ "@/server/actions/files"
    );
    return serverGetRootFiles();
  }
  const client = getRpcClient();
  const res = await client.api.rpc.files["list-root"].$get();
  return (await res.json()) as FileOpResult<FileRecord[]>;
}

export async function getDeletedFiles(): Promise<FileOpResult<FileRecord[]>> {
  if (isVitestBridgeActive()) {
    const { getDeletedFiles: serverGetDeletedFiles } = await import(
      /* webpackIgnore: true */ "@/server/actions/files"
    );
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
    const { getFolderChildren: serverGetFolderChildren } = await import(
      /* webpackIgnore: true */ "@/server/actions/folders"
    );
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
    const { getUserVaultProfile: serverGetVault } = await import(
      /* webpackIgnore: true */ "@/server/actions/vault-actions"
    );
    return serverGetVault();
  }
  const client = getRpcClient();
  const res = await client.api.rpc.vault.profile.$get();
  return (await res.json()) as VaultActionResult<VaultProfileRecord | null>;
}

export async function createUserVaultProfile(
  input: CreateVaultProfileInput
): Promise<VaultActionResult<VaultProfileRecord>> {
  if (isVitestBridgeActive()) {
    const { createUserVaultProfile: serverCreateVault } = await import(
      /* webpackIgnore: true */ "@/server/actions/vault-actions"
    );
    return serverCreateVault(input);
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
    const { updateVaultPassword: serverUpdateVaultPassword } = await import(
      /* webpackIgnore: true */ "@/server/actions/vault-actions"
    );
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
    const { updateVaultRecoveryEnvelope: serverUpdateRecovery } = await import(
      /* webpackIgnore: true */ "@/server/actions/vault-actions"
    );
    return serverUpdateRecovery(input);
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
    const { revokeAllTrustedDevices: serverRevokeAll } = await import(
      /* webpackIgnore: true */ "@/server/actions/vault-actions"
    );
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
    const { updateVaultAISetting: serverUpdateAISetting } = await import(
      /* webpackIgnore: true */ "@/server/actions/vault-actions"
    );
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
    const { signInWithGoogle: serverSignIn } = await import(
      /* webpackIgnore: true */ "@/server/actions/auth-actions"
    );
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
    const { signOut: serverSignOut } = await import(
      /* webpackIgnore: true */ "@/server/actions/auth-actions"
    );
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
    const { syncUserToDatabase: serverSyncUser } = await import(
      /* webpackIgnore: true */ "@/server/actions/auth-actions"
    );
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
    const { getUserProfile: serverGetUserProfile } = await import(
      /* webpackIgnore: true */ "@/server/actions/auth-actions"
    );
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
    const { updateUserProfile: serverUpdateUserProfile } = await import(
      /* webpackIgnore: true */ "@/server/actions/auth-actions"
    );
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
    const { getUser } = await import(
      /* webpackIgnore: true */ "@/lib/supabase/server"
    );
    const { getUserCreditBalance } = await import(
      /* webpackIgnore: true */ "@/server/services/ai-settlement-service"
    );
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
