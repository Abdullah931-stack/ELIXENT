/**
 * Test Suite: Ephemeral Vault Memory Map & Zero-Knowledge Pointer Dereferencer
 *
 * Verifies request-scoped AsyncLocalStorage isolation, canonical vault_ref://
 * pointer formatting and structural validation, zero-knowledge memory zeroing
 * (buffer.fill(0)), just-in-time dereferencing with Unicode/Arabic support,
 * and error handling invariants.
 */

import { describe, it, expect, vi } from "vitest";
import {
  formatVaultRef,
  isVaultRef,
  runWithEphemeralVaultScope,
  storeEphemeralVaultSection,
  resolveVaultRefJustInTime,
  zeroOutEphemeralVaultMemory,
  getActiveEphemeralVaultPlaintexts,
  hasActiveVaultPlaintextInMemory,
  EphemeralVaultScopeError,
  EphemeralVaultResolutionError,
} from "@/lib/vault/ephemeral-memory-map";

describe("Ephemeral Vault Memory Map & Pointer Dereferencer", () => {
  describe("1. Pointer Formatting & Structural Validation", () => {
    it("should format valid canonical vault reference pointers", () => {
      const ref1 = formatVaultRef("file-abc-123", "executive-summary");
      expect(ref1).toBe("vault_ref://file-abc-123#executive-summary");
      expect(isVaultRef(ref1)).toBe(true);

      const ref2 = formatVaultRef("550e8400-e29b-41d4-a716-446655440000", "sec_01");
      expect(ref2).toBe("vault_ref://550e8400-e29b-41d4-a716-446655440000#sec_01");
      expect(isVaultRef(ref2)).toBe(true);
    });

    it("should support Unicode and non-ASCII heading slugs in formatVaultRef", () => {
      const arabicRef = formatVaultRef("doc-99", "المقدمة-التنفيذية");
      expect(arabicRef).toBe("vault_ref://doc-99#المقدمة-التنفيذية");
      expect(isVaultRef(arabicRef)).toBe(true);

      const cjkRef = formatVaultRef("doc-jp", "要約セクション");
      expect(cjkRef).toBe("vault_ref://doc-jp#要約セクション");
      expect(isVaultRef(cjkRef)).toBe(true);
    });

    it("should reject empty or non-string inputs in formatVaultRef", () => {
      expect(() => formatVaultRef("", "heading")).toThrow(TypeError);
      expect(() => formatVaultRef("   ", "heading")).toThrow(TypeError);
      expect(() => formatVaultRef("file-1", "")).toThrow(TypeError);
      expect(() => formatVaultRef("file-1", "   ")).toThrow(TypeError);
      // @ts-expect-error - testing invalid runtime types
      expect(() => formatVaultRef(null, "heading")).toThrow(TypeError);
      // @ts-expect-error - testing invalid runtime types
      expect(() => formatVaultRef("file-1", undefined)).toThrow(TypeError);
      // @ts-expect-error - testing invalid runtime types
      expect(() => formatVaultRef(123, "heading")).toThrow(TypeError);
    });

    it("should reject inputs containing '#' delimiter in formatVaultRef", () => {
      expect(() => formatVaultRef("file#1", "heading")).toThrowError(
        /fileId cannot contain '#' delimiter/
      );
      expect(() => formatVaultRef("file-1", "head#ing")).toThrowError(
        /headingSlug cannot contain '#' delimiter/
      );
    });

    it("should reject inputs containing whitespace in formatVaultRef", () => {
      expect(() => formatVaultRef("file 1", "heading")).toThrowError(
        /fileId cannot contain whitespace/
      );
      expect(() => formatVaultRef("file-1", "head ing")).toThrowError(
        /headingSlug cannot contain whitespace/
      );
      expect(() => formatVaultRef("file-1\n", "heading")).toThrowError(
        /fileId cannot contain whitespace/
      );
      expect(() => formatVaultRef("file-1", "heading\t")).toThrowError(
        /headingSlug cannot contain whitespace/
      );
    });

    it("should correctly evaluate isVaultRef across valid and invalid candidates", () => {
      expect(isVaultRef("vault_ref://file1#head1")).toBe(true);
      expect(isVaultRef("vault_ref://uuid-1234-5678#sub-section-99")).toBe(true);
      expect(isVaultRef("vault_ref://doc#التقرير")).toBe(true);

      // Invalid candidates
      expect(isVaultRef("")).toBe(false);
      // @ts-expect-error - testing invalid runtime types
      expect(isVaultRef(null)).toBe(false);
      // @ts-expect-error - testing invalid runtime types
      expect(isVaultRef(undefined)).toBe(false);
      // @ts-expect-error - testing invalid runtime types
      expect(isVaultRef(12345)).toBe(false);
      expect(isVaultRef("http://file1#head1")).toBe(false);
      expect(isVaultRef("vault_ref://")).toBe(false);
      expect(isVaultRef("vault_ref://file1")).toBe(false); // missing hash
      expect(isVaultRef("vault_ref://#head1")).toBe(false); // missing fileId
      expect(isVaultRef("vault_ref://file1#")).toBe(false); // missing headingSlug
      expect(isVaultRef("vault_ref://file1#head1#sub")).toBe(false); // multiple hashes
      expect(isVaultRef("vault_ref://file 1#head1")).toBe(false); // space in fileId
      expect(isVaultRef("vault_ref://file1#head 1")).toBe(false); // space in headingSlug
    });
  });

  describe("2. Scope Lifecycle & AsyncLocalStorage Isolation", () => {
    it("should reject storing ephemeral sections outside an active scope", () => {
      expect(() => {
        storeEphemeralVaultSection("file-1", "sec-1", "unscoped confidential data");
      }).toThrow(EphemeralVaultScopeError);
    });

    it("should report hasActiveVaultPlaintextInMemory as false outside scope", () => {
      expect(hasActiveVaultPlaintextInMemory()).toBe(false);
      expect(getActiveEphemeralVaultPlaintexts()).toEqual([]);
    });

    it("should maintain strict isolation across concurrent asynchronous scopes", async () => {
      const taskCount = 8;
      const results = await Promise.all(
        Array.from({ length: taskCount }, async (_, index) => {
          return runWithEphemeralVaultScope(async () => {
            const fileId = `concurrent-file-${index}`;
            const headingSlug = `section-${index}`;
            const secretData = `CONFIDENTIAL_PAYLOAD_TASK_${index}_${Date.now()}`;

            const ptr = storeEphemeralVaultSection(fileId, headingSlug, secretData);

            // Simulate non-trivial asynchronous interleaving
            await new Promise((resolve) => setTimeout(resolve, 15 + (index % 3) * 10));

            // Verify our active scope only contains our own data
            const plaintexts = getActiveEphemeralVaultPlaintexts();
            expect(plaintexts).toEqual([secretData]);
            expect(hasActiveVaultPlaintextInMemory()).toBe(true);

            // Resolve pointer
            const resolved = resolveVaultRefJustInTime(`Section: ${ptr}`);
            expect(resolved).toBe(`Section: ${secretData}`);

            return { index, secretData, ptr };
          });
        })
      );

      // Verify each task executed with independent payloads
      expect(results).toHaveLength(taskCount);
      const uniquePayloads = new Set(results.map((r) => r.secretData));
      expect(uniquePayloads.size).toBe(taskCount);

      // Verify after all scopes resolve, global state remains clean
      expect(hasActiveVaultPlaintextInMemory()).toBe(false);
      expect(getActiveEphemeralVaultPlaintexts()).toEqual([]);
    });

    it("should isolate scopes even when using identical fileId and headingSlug", async () => {
      const sharedFileId = "shared-file";
      const sharedSlug = "shared-heading";

      const [resA, resB] = await Promise.all([
        runWithEphemeralVaultScope(async () => {
          storeEphemeralVaultSection(sharedFileId, sharedSlug, "PAYLOAD_ALPHA");
          await new Promise((r) => setTimeout(r, 20));
          return resolveVaultRefJustInTime(`Doc: ${formatVaultRef(sharedFileId, sharedSlug)}`);
        }),
        runWithEphemeralVaultScope(async () => {
          storeEphemeralVaultSection(sharedFileId, sharedSlug, "PAYLOAD_BETA");
          await new Promise((r) => setTimeout(r, 10));
          return resolveVaultRefJustInTime(`Doc: ${formatVaultRef(sharedFileId, sharedSlug)}`);
        }),
      ]);

      expect(resA).toBe("Doc: PAYLOAD_ALPHA");
      expect(resB).toBe("Doc: PAYLOAD_BETA");
    });
  });

  describe("3. Storage, Overwrites & Zero-Knowledge Defensive Memory Wiping", () => {
    it("should overwrite an existing section pointer while zeroing out previous buffer", async () => {
      await runWithEphemeralVaultScope(async () => {
        const fileId = "doc-1";
        const slug = "sec-overwrite";

        // Store initial payload
        const ptr1 = storeEphemeralVaultSection(fileId, slug, "INITIAL_SECRET_DATA_123");
        expect(ptr1).toBe("vault_ref://doc-1#sec-overwrite");
        expect(getActiveEphemeralVaultPlaintexts()).toEqual(["INITIAL_SECRET_DATA_123"]);

        // Overwrite with new payload
        const ptr2 = storeEphemeralVaultSection(fileId, slug, "UPDATED_SECRET_DATA_456");
        expect(ptr2).toBe(ptr1);
        expect(getActiveEphemeralVaultPlaintexts()).toEqual(["UPDATED_SECRET_DATA_456"]);

        const resolved = resolveVaultRefJustInTime(`Data: ${ptr2}`);
        expect(resolved).toBe("Data: UPDATED_SECRET_DATA_456");
      });
    });

    it("should immediately zero out memory buffers when zeroOutEphemeralVaultMemory is invoked", async () => {
      let retainedBuffer: Buffer | null = null;
      const originalFrom = Buffer.from;
      const fromSpy = vi.spyOn(Buffer, "from").mockImplementation((...args: any[]) => {
        const buf = (originalFrom as any).apply(Buffer, args);
        if (typeof args[0] === "string" && args[0].includes("SECRET_BYTE_WIPE_TEST")) {
          retainedBuffer = buf;
        }
        return buf;
      });

      try {
        await runWithEphemeralVaultScope(async () => {
          const ptr = storeEphemeralVaultSection(
            "file-1",
            "sec-1",
            "SECRET_BYTE_WIPE_TEST_TOP_SECRET"
          );
          expect(hasActiveVaultPlaintextInMemory()).toBe(true);
          expect(retainedBuffer).not.toBeNull();
          // Initially, retainedBuffer contains non-zero ASCII characters
          expect(retainedBuffer!.every((b: number) => b === 0)).toBe(false);

          // Wipe memory
          zeroOutEphemeralVaultMemory();

          expect(hasActiveVaultPlaintextInMemory()).toBe(false);
          expect(getActiveEphemeralVaultPlaintexts()).toEqual([]);

          // Invariant: retained buffer memory was physically wiped with zeroes
          expect(retainedBuffer!.every((b: number) => b === 0)).toBe(true);

          // Pointer resolution must now fail
          expect(() => {
            resolveVaultRefJustInTime(`Reading ${ptr}`);
          }).toThrow(EphemeralVaultResolutionError);
        });
      } finally {
        fromSpy.mockRestore();
      }
    });

    it("should physically wipe replaced buffer with zeroes on pointer overwrite", async () => {
      let firstBuffer: Buffer | null = null;
      const originalFrom = Buffer.from;
      let callCount = 0;
      const fromSpy = vi.spyOn(Buffer, "from").mockImplementation((...args: any[]) => {
        const buf = (originalFrom as any).apply(Buffer, args);
        if (typeof args[0] === "string" && args[0].includes("OVERWRITE_TEST_PAYLOAD")) {
          callCount++;
          if (callCount === 1) {
            firstBuffer = buf;
          }
        }
        return buf;
      });

      try {
        await runWithEphemeralVaultScope(async () => {
          storeEphemeralVaultSection("doc-ov", "sec-1", "OVERWRITE_TEST_PAYLOAD_V1");
          expect(firstBuffer).not.toBeNull();
          expect(firstBuffer!.every((b: number) => b === 0)).toBe(false);

          // Overwrite with V2
          storeEphemeralVaultSection("doc-ov", "sec-1", "OVERWRITE_TEST_PAYLOAD_V2");

          // Invariant: firstBuffer must now be zeroed out
          expect(firstBuffer!.every((b: number) => b === 0)).toBe(true);
        });
      } finally {
        fromSpy.mockRestore();
      }
    });

    it("should throw EphemeralVaultResolutionError when a pointer points to zeroed-out memory", async () => {
      await runWithEphemeralVaultScope(async () => {
        // Plaintext consisting only of null bytes simulates zeroed memory
        const ptr = storeEphemeralVaultSection("file-zero", "sec-zero", "\0\0\0\0\0\0\0\0");

        expect(() => {
          resolveVaultRefJustInTime(`Accessing ${ptr}`);
        }).toThrowError(/points to zeroed-out memory/);
      });
    });

    it("should guarantee memory zeroing in finally block even when callback throws", async () => {
      class TestExplosionError extends Error {}

      let capturedError: unknown;
      try {
        await runWithEphemeralVaultScope(async () => {
          storeEphemeralVaultSection("file-err", "sec-err", "VOLATILE_SECRET_CONTENT");
          expect(hasActiveVaultPlaintextInMemory()).toBe(true);
          throw new TestExplosionError("Uncaught pipeline explosion");
        });
      } catch (err) {
        capturedError = err;
      }

      expect(capturedError).toBeInstanceOf(TestExplosionError);
      // Verify scope is completely purged and zeroed outside
      expect(hasActiveVaultPlaintextInMemory()).toBe(false);
      expect(getActiveEphemeralVaultPlaintexts()).toEqual([]);
    });

    it("should be safe and idempotent to call zeroOutEphemeralVaultMemory outside active scope", () => {
      expect(() => zeroOutEphemeralVaultMemory()).not.toThrow();
      expect(hasActiveVaultPlaintextInMemory()).toBe(false);
    });
  });

  describe("4. Just-In-Time Pointer Dereferencing (resolveVaultRefJustInTime)", () => {
    it("should quickly return text unchanged when no vault_ref:// prefix exists (fast path)", () => {
      // Even outside an active scope, plain text without pointers should pass through cleanly
      const plain = "This is a regular markdown document with # headings and code.";
      expect(resolveVaultRefJustInTime(plain)).toBe(plain);
      expect(resolveVaultRefJustInTime("")).toBe("");
      // @ts-expect-error - testing invalid runtime types
      expect(resolveVaultRefJustInTime(null)).toBe(null);
      // @ts-expect-error - testing invalid runtime types
      expect(resolveVaultRefJustInTime(undefined)).toBe(undefined);
    });

    it("should throw EphemeralVaultResolutionError if pointers exist but outside active scope", () => {
      const textWithRef = "Confidential section: vault_ref://doc-1#sec-1 here.";
      expect(() => {
        resolveVaultRefJustInTime(textWithRef);
      }).toThrow(EphemeralVaultResolutionError);
    });

    it("should replace single and multiple pointers within rich markdown content", async () => {
      await runWithEphemeralVaultScope(async () => {
        const ptr1 = storeEphemeralVaultSection(
          "report",
          "intro",
          "### 1. Introduction\nDecrypted briefing content."
        );
        const ptr2 = storeEphemeralVaultSection(
          "report",
          "financials",
          "| Revenue | Profit |\n| $1.2M | $400K |"
        );

        const markdownTemplate = [
          "# Global Strategy Document",
          "",
          ptr1,
          "",
          "## Financial Performance",
          ptr2,
          "",
          "End of report.",
        ].join("\n");

        const resolved = resolveVaultRefJustInTime(markdownTemplate);

        expect(resolved).toContain("### 1. Introduction\nDecrypted briefing content.");
        expect(resolved).toContain("| Revenue | Profit |\n| $1.2M | $400K |");
        expect(resolved).not.toContain(ptr1);
        expect(resolved).not.toContain(ptr2);
        expect(resolved.startsWith("# Global Strategy Document")).toBe(true);
        expect(resolved.endsWith("End of report.")).toBe(true);
      });
    });

    it("should handle trailing punctuation after pointers seamlessly", async () => {
      await runWithEphemeralVaultScope(async () => {
        storeEphemeralVaultSection("guide", "step1", "Review the cryptographic key");

        const sentence = `Please execute vault_ref://guide#step1. Then proceed to vault_ref://guide#step1!`;
        const resolved = resolveVaultRefJustInTime(sentence);

        expect(resolved).toBe(
          "Please execute Review the cryptographic key. Then proceed to Review the cryptographic key!"
        );
      });
    });

    it("should dereference Unicode and Arabic heading slugs accurately", async () => {
      await runWithEphemeralVaultScope(async () => {
        const arabicPtr = storeEphemeralVaultSection(
          "doc-ar",
          "المقدمة-التنفيذية",
          "هذا النص السري المشفر تم فكه بنجاح داخل الذاكرة المؤقتة."
        );

        const text = `ملخص التقرير:\n${arabicPtr}\nتمت القراءة بنجاح.`;
        const resolved = resolveVaultRefJustInTime(text);

        expect(resolved).toContain("هذا النص السري المشفر تم فكه بنجاح داخل الذاكرة المؤقتة.");
        expect(resolved).not.toContain("vault_ref://");
      });
    });

    it("should throw EphemeralVaultResolutionError when a pointer is not in the scope map", async () => {
      await runWithEphemeralVaultScope(async () => {
        storeEphemeralVaultSection("doc-1", "sec-1", "Known section");

        const textWithMissingRef = "Valid: vault_ref://doc-1#sec-1, Missing: vault_ref://doc-1#missing-sec";
        expect(() => {
          resolveVaultRefJustInTime(textWithMissingRef);
        }).toThrow(EphemeralVaultResolutionError);
      });
    });
  });

  describe("5. Error Hierarchy & Protocol Integrity", () => {
    it("should instantiate EphemeralVaultScopeError with proper name and prototype", () => {
      const err = new EphemeralVaultScopeError("Custom scope failure");
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(EphemeralVaultScopeError);
      expect(err.name).toBe("EphemeralVaultScopeError");
      expect(err.message).toBe("Custom scope failure");
    });

    it("should instantiate EphemeralVaultResolutionError with proper name and prototype", () => {
      const err = new EphemeralVaultResolutionError("Custom resolution failure");
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(EphemeralVaultResolutionError);
      expect(err.name).toBe("EphemeralVaultResolutionError");
      expect(err.message).toBe("Custom resolution failure");
    });
  });
});
