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
import {
  encryptionMetadataSchema,
  updateFileOptionsSchema,
  deleteFileOptionsSchema,
  encryptedOverrideSchema,
  importEncryptionSchema,
  createVaultProfileSchema,
  updateVaultPasswordSchema,
  updateVaultRecoveryEnvelopeSchema,
  type UpdateFileOptions,
  type DeleteFileOptions,
  type ImportEncryptionOptions,
  type CreateVaultProfileInput,
  type UpdateVaultPasswordInput,
  type UpdateVaultRecoveryEnvelopeInput,
  type FileEncryptionMetadata,
} from "@/types/rpc-contracts";

export const rpcRoutes = new Hono()
  // -------------------------------------------------------------
  // Files & Folders
  // -------------------------------------------------------------
  .post(
    "/files/create",
    zValidator(
      "json",
      z.object({
        title: z.string(),
        parentFolderId: z.string().nullable().optional(),
        isFolder: z.boolean().optional(),
      })
    ),
    async (c) => {
      const { title, parentFolderId, isFolder } = c.req.valid("json");
      const result = await createFile(title, parentFolderId, isFolder);
      return c.json(result);
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
    zValidator(
      "json",
      z.object({
        fileId: z.string(),
        isEncrypted: z.boolean(),
        content: z.string(),
        encryptionMetadata: encryptionMetadataSchema.nullable().optional(),
        options: updateFileOptionsSchema.optional(),
      })
    ),
    async (c) => {
      const { fileId, isEncrypted, content, encryptionMetadata, options } = c.req.valid("json");
      const result = await toggleFileEncryption(
        fileId,
        isEncrypted,
        content,
        (encryptionMetadata ?? null) as FileEncryptionMetadata | null,
        options as UpdateFileOptions
      );
      return c.json(result);
    }
  )
  .post(
    "/files/encryption",
    zValidator(
      "json",
      z.object({
        fileId: z.string(),
        isEncrypted: z.boolean(),
        content: z.string(),
        encryptionMetadata: encryptionMetadataSchema.nullable().optional(),
        options: updateFileOptionsSchema.optional(),
      })
    ),
    async (c) => {
      const { fileId, isEncrypted, content, encryptionMetadata, options } = c.req.valid("json");
      const result = await toggleFileEncryption(
        fileId,
        isEncrypted,
        content,
        (encryptionMetadata ?? null) as FileEncryptionMetadata | null,
        options as UpdateFileOptions
      );
      return c.json(result);
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
    zValidator(
      "json",
      z.object({
        fileId: z.string(),
      })
    ),
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
      })
    ),
    async (c) => {
      const { fileId, newParentFolderId, depth, encryptedOverride } = c.req.valid("json");
      const result = await copyFile(
        fileId,
        newParentFolderId,
        depth,
        encryptedOverride as {
          newFileId?: string;
          content?: string;
          encryptionMetadata?: FileEncryptionMetadata | null;
        }
      );
      return c.json(result);
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
      const result = await moveFile(fileId, newParentFolderId);
      return c.json(result);
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
      })
    ),
    async (c) => {
      const { fileName, textContent, fileType, parentFolderId, encryption } = c.req.valid("json");
      const result = await importFile(
        fileName,
        textContent,
        fileType,
        parentFolderId ?? null,
        encryption as ImportEncryptionOptions
      );
      return c.json(result);
    }
  )
  .post(
    "/files/get",
    zValidator(
      "json",
      z.object({
        fileId: z.string(),
      })
    ),
    async (c) => {
      const { fileId } = c.req.valid("json");
      const result = await getFile(fileId);
      return c.json(result);
    }
  )
  .get(
    "/files/get",
    zValidator(
      "query",
      z.object({
        fileId: z.string(),
      })
    ),
    async (c) => {
      const { fileId } = c.req.valid("query");
      const result = await getFile(fileId);
      return c.json(result);
    }
  )
  .get("/files/list", async (c) => {
    const result = await getUserFiles();
    return c.json(result);
  })
  .get("/files/list-root", async (c) => {
    const result = await getRootFiles();
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
      })
    ),
    async (c) => {
      const { folderId } = c.req.valid("json");
      const result = await getFolderChildren(folderId);
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
    const cookies = getCookie(c);
    for (const name of Object.keys(cookies)) {
      if (name.startsWith("sb-")) {
        deleteCookie(c, name, {
          path: "/",
          httpOnly: true,
          sameSite: "Lax",
          expires: new Date(0),
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
    return c.json(result);
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
  });
