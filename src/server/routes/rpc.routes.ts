import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { getCookie, deleteCookie } from "hono/cookie";
import {
  createFile,
  updateFileContent,
  toggleFileEncryption,
  renameFile,
  deleteFile,
  restoreFile,
  copyFile,
  getFile,
  getUserFiles,
  getRootFiles,
  getDeletedFiles,
} from "@/server/actions/files";
import { moveFile, getFolderChildren } from "@/server/actions/folders";
import { importFile } from "@/server/actions/import-file";
import {
  listUserWorkspaces,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  decryptEntireWorkspace,
} from "@/server/actions/workspaces";
import {
  getUserVaultProfile,
  createUserVaultProfile,
  updateVaultPassword,
  updateVaultRecoveryEnvelope,
  revokeAllTrustedDevices,
  updateVaultAISetting,
} from "@/server/actions/vault-actions";
import {
  signInWithGoogle,
  signOut,
  syncUserToDatabase,
  getUserProfile,
  updateUserProfile,
} from "@/server/actions/auth-actions";
import { getUserCreditBalance } from "@/server/services/ai-settlement-service";
import { getUser } from "@/lib/supabase/server";
import { getAppBaseUrl } from "@/lib/config/app-url";
import { clearPendingAuthCookieMutations } from "@/server/middleware/session-middleware";
import {
  encryptionMetadataSchema,
  updateFileOptionsSchema,
  deleteFileOptionsSchema,
  encryptedOverrideSchema,
  importEncryptionSchema,
  createVaultProfileSchema,
  updateVaultPasswordSchema,
  updateVaultRecoveryEnvelopeSchema,
  trimmedTitleSchema,
  uuidStringSchema,
  createWorkspaceSchema,
  updateWorkspaceSchema,
  deleteWorkspaceSchema,
  decryptWorkspaceAllSchema,
  restoreWorkspaceFileSchema,
  type UpdateFileOptions,
  type DeleteFileOptions,
  type ImportEncryptionOptions,
  type CreateVaultProfileInput,
  type UpdateVaultPasswordInput,
  type UpdateVaultRecoveryEnvelopeInput,
  type FileEncryptionMetadata,
} from "@/types/rpc-contracts";

const VALID_COOKIE_NAME_REGEX = /^[\w!#$%&'*.^`|~+-]+$/;
const IPV4_HOST_REGEX = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const DNS_HOSTNAME_REGEX =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function isSupabaseAuthCookie(name: string): boolean {
  const unprefixedName = name.replace(/^__(?:host|secure)-/i, "");
  return unprefixedName.startsWith("sb-");
}

function isSecureCookieContext(c: {
  req: { url: string; header: (name: string) => string | undefined };
}): boolean {
  if (process.env.NODE_ENV === "production") {
    return true;
  }
  const forwardedProto = c.req
    .header("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  if (forwardedProto === "https") {
    return true;
  }
  return c.req.url.trim().toLowerCase().startsWith("https://");
}

function normalizeCookieDomainCandidate(
  rawCandidate: string | undefined,
  allowLeadingDot: boolean
): string | undefined {
  if (!rawCandidate) {
    return undefined;
  }

  let host = rawCandidate.trim().toLowerCase();
  if (!host) {
    return undefined;
  }

  // RFC 6265 §5.2.3: strip optional single leading dot on configured domains
  if (allowLeadingDot && host.startsWith(".")) {
    host = host.slice(1);
  }

  // Never emit Domain attribute for IPv6 literals ([::1], [::1]:3000, ::1)
  if (host.startsWith("[") || (host.match(/:/g)?.length ?? 0) > 1) {
    return undefined;
  }

  // Strip optional port suffix cleanly (e.g. app.elixent.com:3000 -> app.elixent.com)
  const portSeparatorIdx = host.indexOf(":");
  if (portSeparatorIdx !== -1) {
    const portPart = host.slice(portSeparatorIdx + 1);
    if (!/^\d+$/.test(portPart)) {
      return undefined;
    }
    host = host.slice(0, portSeparatorIdx);
  }

  // Strip optional trailing root dot
  if (host.endsWith(".")) {
    host = host.slice(0, -1);
  }

  if (!host || host === "localhost" || host.endsWith(".localhost")) {
    return undefined;
  }

  if (IPV4_HOST_REGEX.test(host) || !DNS_HOSTNAME_REGEX.test(host)) {
    return undefined;
  }

  // Reject numeric TLD labels (e.g. non-standard IPv4 notation)
  const tld = host.slice(host.lastIndexOf(".") + 1);
  if (/^\d+$/.test(tld)) {
    return undefined;
  }

  return host;
}

function resolveCookieDomain(c: {
  req: { url: string; header: (name: string) => string | undefined };
}): string | undefined {
  const envDomain = process.env.COOKIE_DOMAIN?.trim();
  if (envDomain) {
    return normalizeCookieDomainCandidate(envDomain, true);
  }

  try {
    const appBaseUrl = getAppBaseUrl();
    const appHost = new URL(appBaseUrl).host;
    const appCandidate = normalizeCookieDomainCandidate(appHost, false);
    if (appCandidate) {
      return appCandidate;
    }
  } catch {
    // getAppBaseUrl may throw in production if unconfigured; continue fallback
  }

  const headerHost = c.req.header("host")?.trim();
  let urlHost: string | undefined;
  try {
    urlHost = new URL(c.req.url).host;
  } catch {
    urlHost = undefined;
  }

  const directCandidate = normalizeCookieDomainCandidate(
    headerHost || urlHost,
    false
  );
  if (directCandidate) {
    return directCandidate;
  }

  // Never trust arbitrary untrusted x-forwarded-host in production without validation.
  const isProduction = process.env.NODE_ENV === "production";
  const forwardedHost = c.req
    .header("x-forwarded-host")
    ?.split(",")[0]
    ?.trim();
  if (!isProduction && forwardedHost) {
    return normalizeCookieDomainCandidate(forwardedHost, false);
  }

  return undefined;
}

const toggleFileEncryptionSchema = z.object({
  fileId: z.string(),
  isEncrypted: z.boolean(),
  content: z.string(),
  encryptionMetadata: encryptionMetadataSchema.nullable().optional(),
  options: updateFileOptionsSchema.optional(),
});

type ToggleFileEncryptionInput = z.infer<typeof toggleFileEncryptionSchema>;

async function handleToggleFileEncryption(input: ToggleFileEncryptionInput) {
  return await toggleFileEncryption(
    input.fileId,
    input.isEncrypted,
    input.content,
    (input.encryptionMetadata ?? null) as FileEncryptionMetadata | null,
    input.options as UpdateFileOptions
  );
}

const fileIdQueryOrBodySchema = z.object({
  fileId: z.string(),
});

async function handleGetFile(fileId: string) {
  return await getFile(fileId);
}

function mapWorkspaceStatusCode(
  statusCode?: number
): 200 | 400 | 401 | 403 | 404 | 409 | 500 {
  switch (statusCode) {
    case 400:
    case 401:
    case 403:
    case 404:
    case 409:
    case 500:
      return statusCode;
    default:
      return 200;
  }
}

export const rpcRoutes = new Hono()
  // -------------------------------------------------------------
  // Files & Folders
  // -------------------------------------------------------------
  .post(
    "/files/create",
    zValidator(
      "json",
      z.object({
        title: trimmedTitleSchema,
        parentFolderId: z.string().nullable().optional(),
        isFolder: z.boolean().optional(),
        workspaceId: z.string().uuid().optional(),
      })
    ),
    async (c) => {
      const { title, parentFolderId, isFolder, workspaceId } = c.req.valid("json");
      const result = await createFile(title, parentFolderId, isFolder, workspaceId);
      const status = result.statusCode === 400 ? 400 : result.statusCode === 403 ? 403 : 200;
      return c.json(result, status);
    }
  )
  .post(
    "/files/update-content",
    zValidator(
      "json",
      z.object({
        fileId: z.string(),
        content: z.string(),
        options: updateFileOptionsSchema.optional(),
      })
    ),
    async (c) => {
      const { fileId, content, options } = c.req.valid("json");
      const result = await updateFileContent(fileId, content, options as UpdateFileOptions);
      return c.json(result);
    }
  )
  .post(
    "/files/toggle-encryption",
    zValidator("json", toggleFileEncryptionSchema),
    async (c) => {
      const input = c.req.valid("json");
      const result = await handleToggleFileEncryption(input);
      const status = result.statusCode === 400 ? 400 : result.statusCode === 403 ? 403 : 200;
      return c.json(result, status);
    }
  )
  .post(
    "/files/encryption",
    zValidator("json", toggleFileEncryptionSchema),
    async (c) => {
      const input = c.req.valid("json");
      const result = await handleToggleFileEncryption(input);
      const status = result.statusCode === 400 ? 400 : result.statusCode === 403 ? 403 : 200;
      return c.json(result, status);
    }
  )
  .post(
    "/files/rename",
    zValidator(
      "json",
      z.object({
        fileId: z.string(),
        newTitle: z.string(),
      })
    ),
    async (c) => {
      const { fileId, newTitle } = c.req.valid("json");
      const result = await renameFile(fileId, newTitle);
      return c.json(result);
    }
  )
  .post(
    "/files/delete",
    zValidator(
      "json",
      z.object({
        fileId: z.string(),
        options: deleteFileOptionsSchema.optional(),
      })
    ),
    async (c) => {
      const { fileId, options } = c.req.valid("json");
      const result = await deleteFile(fileId, options as DeleteFileOptions);
      return c.json(result);
    }
  )
  .post(
    "/files/restore",
    zValidator("json", restoreWorkspaceFileSchema),
    async (c) => {
      const { fileId } = c.req.valid("json");
      const result = await restoreFile(fileId);
      return c.json(result);
    }
  )
  .post(
    "/files/copy",
    zValidator(
      "json",
      z.object({
        fileId: z.string(),
        newParentFolderId: z.string().nullable().optional(),
        depth: z.number().optional(),
        encryptedOverride: encryptedOverrideSchema.optional(),
        workspaceId: z.string().uuid().optional(),
      })
    ),
    async (c) => {
      const { fileId, newParentFolderId, depth, encryptedOverride, workspaceId } = c.req.valid("json");
      const result = await copyFile(
        fileId,
        newParentFolderId,
        depth,
        encryptedOverride as {
          newFileId?: string;
          content?: string;
          encryptionMetadata?: FileEncryptionMetadata | null;
        },
        workspaceId
      );
      const status = result.statusCode === 400 ? 400 : result.statusCode === 403 ? 403 : 200;
      return c.json(result, status);
    }
  )
  .post(
    "/files/move",
    zValidator(
      "json",
      z.object({
        fileId: z.string(),
        newParentFolderId: z.string().nullable(),
      })
    ),
    async (c) => {
      const { fileId, newParentFolderId } = c.req.valid("json");
      try {
        const result = await moveFile(fileId, newParentFolderId);
        const status = result.status === "forbidden" || result.statusCode === 403 ? 403 : 200;
        return c.json(result, status);
      } catch (err) {
        const e = err as { name?: string; code?: string; message?: string };
        if (
          e?.name === "CrossWorkspaceAccessForbiddenError" ||
          e?.code === "CROSS_WORKSPACE_ACCESS_FORBIDDEN"
        ) {
          return c.json(
            {
              success: false,
              status: "forbidden" as const,
              statusCode: 403,
              error: e.message || "CROSS_WORKSPACE_ACCESS_FORBIDDEN",
            },
            403
          );
        }
        throw err;
      }
    }
  )
  .post(
    "/files/import",
    bodyLimit({
      maxSize: 10 * 1024 * 1024,
      onError: (c) => {
        return c.json(
          { success: false, error: "File exceeds maximum size limit (10MB)" },
          413
        );
      },
    }),
    zValidator(
      "json",
      z.object({
        fileName: z.string(),
        textContent: z.string(),
        fileType: z.enum(["pdf", "md", "txt"]),
        parentFolderId: z.string().nullable().optional(),
        encryption: importEncryptionSchema.optional(),
        workspaceId: z.string().uuid().optional(),
      })
    ),
    async (c) => {
      const { fileName, textContent, fileType, parentFolderId, encryption, workspaceId } = c.req.valid("json");
      const result = await importFile(
        fileName,
        textContent,
        fileType,
        parentFolderId ?? null,
        encryption as ImportEncryptionOptions,
        workspaceId
      );
      const status = result.statusCode === 400 ? 400 : result.statusCode === 403 ? 403 : 200;
      if (
        "creditBalanceMicro" in result &&
        (result as { creditBalanceMicro?: unknown }).creditBalanceMicro !== undefined
      ) {
        return c.json(
          {
            ...result,
            creditBalanceMicro: String(
              (result as { creditBalanceMicro?: unknown }).creditBalanceMicro
            ),
          },
          status
        );
      }
      return c.json(result, status);
    }
  )
  .post(
    "/files/get",
    zValidator("json", fileIdQueryOrBodySchema),
    async (c) => {
      const { fileId } = c.req.valid("json");
      const result = await handleGetFile(fileId);
      return c.json(result);
    }
  )
  .get(
    "/files/get",
    zValidator("query", fileIdQueryOrBodySchema),
    async (c) => {
      const { fileId } = c.req.valid("query");
      const result = await handleGetFile(fileId);
      return c.json(result);
    }
  )
  .get("/files/list", async (c) => {
    const rawWorkspaceId = c.req.query("workspaceId");
    let workspaceId: string | undefined;
    if (rawWorkspaceId !== undefined && rawWorkspaceId !== "") {
      const parsed = uuidStringSchema.safeParse(rawWorkspaceId);
      if (!parsed.success) {
        return c.json({ success: false, status: "error" as const, statusCode: 400, error: "Invalid workspaceId" }, 400);
      }
      workspaceId = parsed.data;
    }
    const result = await getUserFiles(workspaceId);
    return c.json(result);
  })
  .get("/files/list-root", async (c) => {
    const rawWorkspaceId = c.req.query("workspaceId");
    let workspaceId: string | undefined;
    if (rawWorkspaceId !== undefined && rawWorkspaceId !== "") {
      const parsed = uuidStringSchema.safeParse(rawWorkspaceId);
      if (!parsed.success) {
        return c.json({ success: false, status: "error" as const, statusCode: 400, error: "Invalid workspaceId" }, 400);
      }
      workspaceId = parsed.data;
    }
    const result = await getRootFiles(workspaceId);
    return c.json(result);
  })
  .get("/files/list-deleted", async (c) => {
    const result = await getDeletedFiles();
    return c.json(result);
  })
  .post(
    "/files/children",
    zValidator(
      "json",
      z.object({
        folderId: z.string().nullable(),
        workspaceId: z.string().uuid().optional(),
      })
    ),
    async (c) => {
      const { folderId, workspaceId } = c.req.valid("json");
      const result = await getFolderChildren(folderId, workspaceId);
      return c.json(result);
    }
  )

  // -------------------------------------------------------------
  // Vault
  // -------------------------------------------------------------
  .get("/vault/profile", async (c) => {
    const result = await getUserVaultProfile();
    return c.json(result);
  })
  .post(
    "/vault/create",
    zValidator("json", createVaultProfileSchema),
    async (c) => {
      const input = c.req.valid("json");
      const result = await createUserVaultProfile(input as CreateVaultProfileInput);
      return c.json(result);
    }
  )
  .post(
    "/vault/update-password",
    zValidator("json", updateVaultPasswordSchema),
    async (c) => {
      const input = c.req.valid("json");
      const result = await updateVaultPassword(input as UpdateVaultPasswordInput);
      return c.json(result);
    }
  )
  .post(
    "/vault/update-recovery",
    zValidator("json", updateVaultRecoveryEnvelopeSchema),
    async (c) => {
      const input = c.req.valid("json");
      const result = await updateVaultRecoveryEnvelope(input as UpdateVaultRecoveryEnvelopeInput);
      return c.json(result);
    }
  )
  .post("/vault/revoke-devices", async (c) => {
    const result = await revokeAllTrustedDevices();
    return c.json(result);
  })
  .post(
    "/vault/update-ai-setting",
    zValidator(
      "json",
      z.object({
        allowAI: z.boolean(),
      })
    ),
    async (c) => {
      const { allowAI } = c.req.valid("json");
      const result = await updateVaultAISetting(allowAI);
      return c.json(result);
    }
  )

  // -------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------
  .post(
    "/auth/sign-in-google",
    zValidator(
      "json",
      z.object({
        redirectTo: z.string().optional(),
      }).optional()
    ),
    async (c) => {
      const body = c.req.valid("json");
      const result = await signInWithGoogle(body?.redirectTo);
      return c.json(result);
    }
  )
  .post("/auth/sign-out", async (c) => {
    await signOut();
    clearPendingAuthCookieMutations();
    const cookies = getCookie(c);
    const secure = isSecureCookieContext(c);
    const cookieDomain = resolveCookieDomain(c);
    const expires = new Date(0);

    for (const name of Object.keys(cookies)) {
      if (!isSupabaseAuthCookie(name) || !VALID_COOKIE_NAME_REGEX.test(name)) {
        continue;
      }

      const isHostPrefixed = /^__host-/i.test(name);
      const isSecurePrefixed = /^__secure-/i.test(name);
      const effectiveSecure = secure || isHostPrefixed || isSecurePrefixed;

      // Host-only dual deletion (clears HttpOnly server cookies and JS-accessible cookies)
      deleteCookie(c, name, {
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
        secure: effectiveSecure,
        expires,
      });
      deleteCookie(c, name, {
        path: "/",
        httpOnly: false,
        sameSite: "Lax",
        secure: effectiveSecure,
        expires,
      });

      // Domain-scoped dual deletion when an eligible hostname is resolved.
      // RFC 6265 §4.1.2.5 forbids a Domain attribute on __Host- cookies.
      if (cookieDomain && !isHostPrefixed) {
        deleteCookie(c, name, {
          path: "/",
          domain: cookieDomain,
          httpOnly: true,
          sameSite: "Lax",
          secure: effectiveSecure,
          expires,
        });
        deleteCookie(c, name, {
          path: "/",
          domain: cookieDomain,
          httpOnly: false,
          sameSite: "Lax",
          secure: effectiveSecure,
          expires,
        });
      }
    }
    return c.json({ success: true as const, redirectUrl: "/" });
  })
  .post("/auth/sync-user", async (c) => {
    const result = await syncUserToDatabase();
    return c.json(result);
  })
  .get("/auth/profile", async (c) => {
    const result = await getUserProfile();
    if (result.success && result.data) {
      const { creditBalanceMicro, ...rest } = result.data;
      const serializedCreditBalance =
        creditBalanceMicro !== undefined && creditBalanceMicro !== null
          ? String(creditBalanceMicro)
          : "0";
      return c.json({
        success: true as const,
        data: {
          ...rest,
          creditBalanceMicro: serializedCreditBalance,
        },
      });
    }
    return c.json({
      success: false as const,
      error: result.error ?? "Failed to retrieve user profile",
    });
  })
  .post(
    "/auth/update-profile",
    zValidator(
      "json",
      z.object({
        displayName: z.string().optional(),
      })
    ),
    async (c) => {
      const body = c.req.valid("json");
      const result = await updateUserProfile(body);
      return c.json(result);
    }
  )

  // -------------------------------------------------------------
  // Billing
  // -------------------------------------------------------------
  .get("/billing/credit-balance", async (c) => {
    const user = await getUser();
    if (!user) {
      return c.json({ success: false as const, error: "Unauthorized" }, 401);
    }
    const balance = await getUserCreditBalance(user.id);
    return c.json({ success: true as const, balanceMicro: balance.toString() }, 200);
  })

  // -------------------------------------------------------------
  // Workspaces
  // -------------------------------------------------------------
  .get("/workspaces/list", async (c) => {
    const result = await listUserWorkspaces();
    return c.json(result, mapWorkspaceStatusCode(result.statusCode));
  })
  .post(
    "/workspaces/create",
    zValidator("json", createWorkspaceSchema),
    async (c) => {
      const input = c.req.valid("json");
      const result = await createWorkspace(input);
      return c.json(result, mapWorkspaceStatusCode(result.statusCode));
    }
  )
  .post(
    "/workspaces/update",
    zValidator("json", updateWorkspaceSchema),
    async (c) => {
      const { workspaceId, ...rest } = c.req.valid("json");
      const result = await updateWorkspace(workspaceId, rest);
      return c.json(result, mapWorkspaceStatusCode(result.statusCode));
    }
  )
  .post(
    "/workspaces/delete",
    zValidator("json", deleteWorkspaceSchema),
    async (c) => {
      const { workspaceId } = c.req.valid("json");
      const result = await deleteWorkspace(workspaceId);
      return c.json(result, mapWorkspaceStatusCode(result.statusCode));
    }
  )
  .post(
    "/workspaces/decrypt-all",
    zValidator("json", decryptWorkspaceAllSchema),
    async (c) => {
      const { workspaceId, decryptedFilesPayload } = c.req.valid("json");
      const result = await decryptEntireWorkspace(workspaceId, decryptedFilesPayload);
      return c.json(result, mapWorkspaceStatusCode(result.statusCode));
    }
  );

export type AppType = typeof rpcRoutes;
