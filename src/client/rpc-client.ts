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

export interface RpcResponseLike {
  ok: boolean;
  status: number;
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
}

export type CreditBalanceResult =
  | { success: true; balanceMicro: string; balance: bigint }
  | { success: false; status: "unauthorized" | "error"; statusCode: number; error: string };

export function getBaseUrl(): string {
  if (typeof process !== "undefined" && process.env?.VITE_APP_URL) {
    return process.env.VITE_APP_URL;
  }
  if (
    typeof import.meta !== "undefined" &&
    import.meta.env &&
    import.meta.env.VITE_APP_URL
  ) {
    return import.meta.env.VITE_APP_URL;
  }
  if (
    typeof window !== "undefined" &&
    window.location?.origin &&
    window.location.origin !== "null"
  ) {
    return window.location.origin;
  }
  return "http://localhost:3000";
}

let activeCustomFetch: typeof fetch | undefined;
let cachedClient: ElixentRpcClient | null = null;
let cachedBaseUrl: string | null = null;
let cachedFetch: typeof fetch | undefined = undefined;

const defaultFetch: typeof fetch = (
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> => globalThis.fetch(input, init);

/**
 * Injects or clears a custom fetch transport for all subsequent RPC client wrapper calls.
 */
export function setRpcClientFetch(fetchFn?: typeof fetch): void {
  activeCustomFetch = fetchFn;
  cachedClient = null;
  cachedBaseUrl = null;
  cachedFetch = undefined;
}

/**
 * Returns the currently registered custom fetch transport, if any.
 */
export function getRpcClientFetch(): typeof fetch | undefined {
  return activeCustomFetch;
}

/**
 * Resolves the active fetch implementation, preferring any injected custom fetch
 * and falling back to globalThis.fetch.
 */
export function resolveRpcFetch(): typeof fetch {
  return getRpcClientFetch() ?? globalThis.fetch;
}

/**
 * Returns a cached typed Hono RPC client instance, keyed on (baseUrl, activeCustomFetch).
 */
export function getRpcClient(): ElixentRpcClient {
  const currentBaseUrl = getBaseUrl();
  const currentFetch = activeCustomFetch;

  if (
    !cachedClient ||
    cachedBaseUrl !== currentBaseUrl ||
    cachedFetch !== currentFetch
  ) {
    cachedClient = createElixentRpcClient(currentBaseUrl, currentFetch);
    cachedBaseUrl = currentBaseUrl;
    cachedFetch = currentFetch;
  }

  return cachedClient;
}

/**
 * Creates a typed Hono RPC client instance targeting the Elixent application.
 */
export function createElixentRpcClient(
  baseUrl = getBaseUrl(),
  customFetch?: typeof fetch
): ElixentRpcClient {
  const transportFetch = customFetch ?? activeCustomFetch ?? defaultFetch;

  return hc<AppType>(baseUrl, {
    fetch: transportFetch,
  });
}

export async function parseRpcResult<
  T extends { success: boolean; error?: string; statusCode?: number }
>(
  resInput:
    | RpcResponseLike
    | Promise<RpcResponseLike>
    | (() => Promise<RpcResponseLike>)
): Promise<T> {
  try {
    const res =
      typeof resInput === "function" ? await resInput() : await resInput;

    let rawText = "";
    let parsed: unknown = null;

    if (typeof res.text === "function") {
      rawText = await res.text();
      if (rawText) {
        try {
          parsed = JSON.parse(rawText);
        } catch {
          parsed = null;
        }
      }
    } else if (typeof res.json === "function") {
      try {
        parsed = await res.json();
      } catch {
        parsed = null;
      }
    }

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (!res.ok) {
        let normalizedError: string;
        if (typeof record.error === "string" && record.error.trim().length > 0) {
          normalizedError = record.error;
        } else if (
          record.error &&
          typeof record.error === "object" &&
          "issues" in record.error &&
          Array.isArray((record.error as { issues?: unknown[] }).issues) &&
          (record.error as { issues: Array<{ message?: unknown }> }).issues.length > 0 &&
          typeof (record.error as { issues: Array<{ message?: unknown }> }).issues[0]?.message ===
            "string"
        ) {
          normalizedError = (record.error as { issues: Array<{ message: string }> }).issues[0]
            .message;
        } else {
          normalizedError = `Request failed with status ${res.status}`;
        }
        return {
          ...record,
          success: false,
          error: normalizedError,
        } as T;
      }
      return record as T;
    }

    if (!res.ok) {
      return {
        success: false,
        error: rawText.trim() || `Request failed with status ${res.status}`,
      } as T;
    }

    return {
      success: false,
      error: rawText.trim() || `Invalid JSON response (status ${res.status})`,
    } as T;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: message || "Network or parsing error",
      statusCode: 0,
    } as T;
  }
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
  return parseRpcResult<FileOpResult>(
    client.api.rpc.files.create.$post({
      json: { title, parentFolderId: parentFolderId ?? null, isFolder },
    })
  );
}

export async function updateFileContent(
  fileId: string,
  content: string,
  options?: UpdateFileOptions
): Promise<FileOpResult> {
  const client = getRpcClient();
  return parseRpcResult<FileOpResult>(
    client.api.rpc.files["update-content"].$post({
      json: { fileId, content, options },
    })
  );
}

export async function toggleFileEncryption(
  fileId: string,
  isEncrypted: boolean,
  content: string,
  encryptionMetadata: FileEncryptionMetadata | null,
  options?: UpdateFileOptions
): Promise<FileOpResult> {
  const client = getRpcClient();
  return parseRpcResult<FileOpResult>(
    client.api.rpc.files["toggle-encryption"].$post({
      json: {
        fileId,
        isEncrypted,
        content,
        encryptionMetadata,
        options,
      },
    })
  );
}

export async function renameFile(
  fileId: string,
  newTitle: string
): Promise<FileOpResult> {
  const client = getRpcClient();
  return parseRpcResult<FileOpResult>(
    client.api.rpc.files.rename.$post({
      json: { fileId, newTitle },
    })
  );
}

export async function deleteFile(
  fileId: string,
  options?: DeleteFileOptions
): Promise<FileOpResult<null>> {
  const client = getRpcClient();
  return parseRpcResult<FileOpResult<null>>(
    client.api.rpc.files.delete.$post({
      json: { fileId, options },
    })
  );
}

export async function restoreFile(fileId: string): Promise<FileOpResult> {
  const client = getRpcClient();
  return parseRpcResult<FileOpResult>(
    client.api.rpc.files.restore.$post({
      json: { fileId },
    })
  );
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
  return parseRpcResult<FileOpResult>(
    client.api.rpc.files.copy.$post({
      json: {
        fileId,
        newParentFolderId: newParentFolderId ?? null,
        depth,
        encryptedOverride,
      },
    })
  );
}

export async function moveFile(
  fileId: string,
  newParentFolderId: string | null
): Promise<FileOpResult<null>> {
  const client = getRpcClient();
  return parseRpcResult<FileOpResult<null>>(
    client.api.rpc.files.move.$post({
      json: { fileId, newParentFolderId },
    })
  );
}

export async function importFile(
  fileName: string,
  textContent: string,
  fileType: "pdf" | "md" | "txt",
  parentFolderId: string | null = null,
  encryption?: ImportEncryptionOptions
): Promise<ImportFileResult> {
  const client = getRpcClient();
  return parseRpcResult<ImportFileResult>(
    client.api.rpc.files.import.$post({
      json: {
        fileName,
        textContent,
        fileType,
        parentFolderId,
        encryption,
      },
    })
  );
}

export async function getFile(fileId: string): Promise<FileOpResult> {
  const client = getRpcClient();
  return parseRpcResult<FileOpResult>(
    client.api.rpc.files.get.$post({
      json: { fileId },
    })
  );
}

export async function getUserFiles(): Promise<FileOpResult<FileRecord[]>> {
  const client = getRpcClient();
  return parseRpcResult<FileOpResult<FileRecord[]>>(client.api.rpc.files.list.$get());
}

export async function getRootFiles(): Promise<FileOpResult<FileRecord[]>> {
  const client = getRpcClient();
  return parseRpcResult<FileOpResult<FileRecord[]>>(client.api.rpc.files["list-root"].$get());
}

export async function getDeletedFiles(): Promise<FileOpResult<FileRecord[]>> {
  const client = getRpcClient();
  return parseRpcResult<FileOpResult<FileRecord[]>>(client.api.rpc.files["list-deleted"].$get());
}

export async function getFolderChildren(
  folderId: string | null
): Promise<FileOpResult<FileRecord[]>> {
  const client = getRpcClient();
  return parseRpcResult<FileOpResult<FileRecord[]>>(
    client.api.rpc.files.children.$post({
      json: { folderId },
    })
  );
}

// ============================================================================
// Vault Facade
// ============================================================================

export async function getUserVaultProfile(): Promise<
  VaultActionResult<VaultProfileRecord | null>
> {
  const client = getRpcClient();
  return parseRpcResult<VaultActionResult<VaultProfileRecord | null>>(
    client.api.rpc.vault.profile.$get()
  );
}

export async function createUserVaultProfile(
  input: CreateVaultProfileInput
): Promise<VaultActionResult<VaultProfileRecord>> {
  const client = getRpcClient();
  return parseRpcResult<VaultActionResult<VaultProfileRecord>>(
    client.api.rpc.vault.create.$post({
      json: input,
    })
  );
}

export async function updateVaultPassword(
  input: UpdateVaultPasswordInput
): Promise<VaultActionResult<VaultProfileRecord>> {
  const client = getRpcClient();
  return parseRpcResult<VaultActionResult<VaultProfileRecord>>(
    client.api.rpc.vault["update-password"].$post({
      json: input,
    })
  );
}

export async function updateVaultRecoveryEnvelope(
  input: UpdateVaultRecoveryEnvelopeInput
): Promise<VaultActionResult<VaultProfileRecord>> {
  const client = getRpcClient();
  return parseRpcResult<VaultActionResult<VaultProfileRecord>>(
    client.api.rpc.vault["update-recovery"].$post({
      json: input,
    })
  );
}

export async function revokeAllTrustedDevices(): Promise<
  VaultActionResult<{ newEpoch: number }>
> {
  const client = getRpcClient();
  return parseRpcResult<VaultActionResult<{ newEpoch: number }>>(
    client.api.rpc.vault["revoke-devices"].$post()
  );
}

export async function updateVaultAISetting(
  allowAI: boolean
): Promise<VaultActionResult<{ allowAIOnEncryptedFiles: boolean }>> {
  const client = getRpcClient();
  return parseRpcResult<VaultActionResult<{ allowAIOnEncryptedFiles: boolean }>>(
    client.api.rpc.vault["update-ai-setting"].$post({
      json: { allowAI },
    })
  );
}

// ============================================================================
// Auth Facade
// ============================================================================

export async function signInWithGoogle(
  redirectTo?: string
): Promise<{ success: true; redirectUrl: string } | { success: false; error: string }> {
  const client = getRpcClient();
  return parseRpcResult<{ success: true; redirectUrl: string } | { success: false; error: string }>(
    client.api.rpc.auth["sign-in-google"].$post({
      json: { redirectTo },
    })
  );
}

export async function signOut(): Promise<{ success: true; redirectUrl: string }> {
  const client = getRpcClient();
  const res = await client.api.rpc.auth["sign-out"].$post();
  if (!res.ok) {
    const rawText = typeof res.text === "function" ? await res.text() : "";
    throw new Error(rawText.trim() || `Sign out failed with status ${res.status}`);
  }
  return (await res.json()) as { success: true; redirectUrl: string };
}

export async function syncUserToDatabase(): Promise<{ success: boolean; error?: string }> {
  const client = getRpcClient();
  return parseRpcResult<{ success: boolean; error?: string }>(
    client.api.rpc.auth["sync-user"].$post()
  );
}

export async function getUserProfile(): Promise<{
  success: boolean;
  data?: UserProfileRecord;
  error?: string;
}> {
  const client = getRpcClient();
  return parseRpcResult<{
    success: boolean;
    data?: UserProfileRecord;
    error?: string;
  }>(client.api.rpc.auth.profile.$get());
}

export async function updateUserProfile(
  data: { displayName?: string }
): Promise<{ success: boolean; error?: string }> {
  const client = getRpcClient();
  return parseRpcResult<{ success: boolean; error?: string }>(
    client.api.rpc.auth["update-profile"].$post({
      json: data,
    })
  );
}

// ============================================================================
// Billing Facade
// ============================================================================

export async function getCreditBalanceResult(): Promise<CreditBalanceResult> {
  const client = getRpcClient();
  try {
    const rawRes = await client.api.rpc.billing["credit-balance"].$get();
    const res = rawRes as RpcResponseLike;

    if (res.status === 401) {
      return {
        success: false,
        status: "unauthorized",
        statusCode: 401,
        error: "Unauthorized",
      };
    }

    if (res.status >= 500) {
      let errorText = "Internal Server Error";
      try {
        const text = typeof res.text === "function" ? await res.text() : "";
        if (text) {
          try {
            const parsed = JSON.parse(text);
            if (typeof parsed?.error === "string") {
              errorText = parsed.error;
            } else {
              errorText = text.trim();
            }
          } catch {
            errorText = text.trim();
          }
        }
      } catch {
        // ignore parsing error
      }
      return {
        success: false,
        status: "error",
        statusCode: res.status,
        error: errorText || `HTTP ${res.status} error`,
      };
    }

    if (!res.ok) {
      let errorText = `Request failed with status ${res.status}`;
      try {
        const text = typeof res.text === "function" ? await res.text() : "";
        if (text) {
          try {
            const parsed = JSON.parse(text);
            if (typeof parsed?.error === "string") {
              errorText = parsed.error;
            } else {
              errorText = text.trim();
            }
          } catch {
            errorText = text.trim();
          }
        }
      } catch {
        // ignore parsing error
      }
      return {
        success: false,
        status: "error",
        statusCode: res.status,
        error: errorText,
      };
    }

    // Response is OK (200)
    let json: unknown = null;
    if (typeof res.json === "function") {
      try {
        json = await res.json();
      } catch (jsonErr: unknown) {
        return {
          success: false,
          status: "error",
          statusCode: res.status,
          error: jsonErr instanceof Error ? jsonErr.message : "Failed to parse JSON response",
        };
      }
    }

    const payload = json as {
      success?: boolean;
      balanceMicro?: string;
      data?: { creditBalanceMicro?: string; balanceMicro?: string };
      error?: string;
    } | null;

    if (payload && payload.success !== false) {
      const balanceMicroStr =
        payload.balanceMicro ??
        payload.data?.creditBalanceMicro ??
        payload.data?.balanceMicro;

      if (typeof balanceMicroStr === "string") {
        try {
          const balance = BigInt(balanceMicroStr);
          return {
            success: true,
            balanceMicro: balanceMicroStr,
            balance,
          };
        } catch {
          return {
            success: false,
            status: "error",
            statusCode: res.status,
            error: "Invalid BigInt balance format",
          };
        }
      }
    }

    return {
      success: false,
      status: "error",
      statusCode: res.status,
      error: payload?.error ?? "Missing balance in response",
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      status: "error",
      statusCode: 0,
      error: message || "Network failure",
    };
  }
}

export async function getCreditBalance(): Promise<bigint> {
  const result = await getCreditBalanceResult();

  if (result.success) {
    return result.balance;
  }

  // Backward compatibility: 401 returns 0n
  if (result.status === "unauthorized" || result.statusCode === 401) {
    return BigInt(0);
  }

  // Backward compatibility: 200 OK responses with success: false or missing balance
  if (result.statusCode === 200) {
    return BigInt(0);
  }

  // Fatal error (HTTP >= 500, network error statusCode: 0): throw Error
  throw new Error(result.error || `Credit balance request failed with status ${result.statusCode}`);
}
