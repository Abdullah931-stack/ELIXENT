import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb, getDbFile } from "../fixtures/test-db";
import * as schema from "../../src/server/db/schema";

test.describe("Scenario 3: Native CodeMirror 6 Markdown & BiDi RTL", () => {
    test("CodeMirror 6 editor should detect Arabic direction, lock code blocks LTR, and persist content via debounced autosave", async ({
        page,
        authSession,
    }) => {
        // 1. Create a document in database
        const [doc] = await e2eDb
            .insert(schema.files)
            .values({
                userId: authSession.userId,
                title: "Arabic BiDi Test Document",
                isFolder: false,
                content: "# مرحبا بكم في محرر ماركداون\n\nهذا نص تجريبي باللغة العربية لاختبار الاتجاه التلقائي.\n\n```typescript\nconst message = 'LTR Code Block';\nconsole.log(message);\n```",
            })
            .returning();

        // 2. Open document in editor
        await page.goto(`/workspace/editor/${doc.id}`);
        await page.waitForLoadState("domcontentloaded");

        // 3. Verify CodeMirror 6 is initialized and visible
        const cmEditor = page.locator(".cm-editor");
        await expect(cmEditor).toBeVisible({ timeout: 15000 });

        // 4. Verify text content rendered in editor
        const cmContent = page.locator(".cm-content");
        await expect(cmContent).toBeVisible();
        await expect(cmContent).toContainText("مرحبا بكم في محرر ماركداون");

        // 5. Verify BiDi auto-detection / RTL attribute on Arabic text lines
        const arabicLine = page.locator('.cm-line[dir="auto"], .cm-line[dir="rtl"], .cm-line.cm-bidi-rtl').first();
        await expect(arabicLine).toBeVisible();

        // 6. Verify Code Block is locked LTR
        const codeBlockLine = page.locator('.cm-line[dir="ltr"], .cm-line.cm-bidi-ltr').first();
        await expect(codeBlockLine).toBeVisible();
        await expect(page.locator('.cm-line[dir="ltr"]:has-text("const message"), .cm-line.cm-bidi-ltr:has-text("const message")')).toBeVisible();

        // 7. Drive actual keyboard input into .cm-content and verify RTL / BiDi direction markers in the DOM
        await cmContent.click();
        await page.keyboard.press("Control+End");
        await page.keyboard.press("Enter");
        await page.keyboard.type("سطر جديد مدخل بواسطة لوحة المفاتيح");

        const typedArabicLine = page.locator('.cm-line:has-text("سطر جديد مدخل بواسطة لوحة المفاتيح")');
        await expect(typedArabicLine).toBeVisible();
        await expect(typedArabicLine).toHaveAttribute("dir", "auto");

        // Drive keyboard input for code block and verify LTR locked markers
        await page.keyboard.press("Enter");
        await page.keyboard.type("```typescript");
        await page.keyboard.press("Enter");
        await page.keyboard.type("const dynamicallyTyped = true;");
        await page.keyboard.press("Enter");
        await page.keyboard.type("```");

        const typedCodeLine = page.locator('.cm-line:has-text("const dynamicallyTyped")');
        await expect(typedCodeLine).toBeVisible();
        await expect(typedCodeLine).toHaveAttribute("dir", "ltr");
        await expect(typedCodeLine).toHaveClass(/cm-bidi-ltr/);

        // 8. Verify Bottom Status Bar stats
        const statusBar = page.getByText(/words/i);
        await expect(statusBar).toBeVisible();

        // 9. Drive editor typing via Playwright locators and verify debounced autosave persistence
        await cmContent.click();
        await page.keyboard.press("Control+End");
        await page.keyboard.press("Enter");
        const autosaveText = "نص إضافي لاختبار الحفظ التلقائي في قاعدة البيانات";
        await page.keyboard.type(autosaveText);

        // Wait for debounced autosave status indicator
        const savedIndicator = page.getByTitle("Saved").or(page.getByText(/متزامن|محفوظ/));
        await expect(savedIndicator.first()).toBeVisible({ timeout: 15000 });

        // Assert database persistence matches typed text
        await expect.poll(async () => {
            const persisted = await getDbFile(doc.id);
            return persisted?.content;
        }, { timeout: 10000 }).toContain(autosaveText);

        // Reload page to verify exact Markdown recovery in editor
        await page.reload();
        await page.waitForLoadState("domcontentloaded");
        await expect(cmContent).toContainText(autosaveText);
    });
});
