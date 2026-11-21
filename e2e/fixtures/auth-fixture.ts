import { test as base, expect, type APIResponse, type Page } from "@playwright/test";
import { cleanupE2EUser } from "./test-db";

export interface AuthenticatedUser {
    userId: string;
    email: string;
    displayName: string;
}

interface TestAuthCookie {
    name: string;
    value: string;
    path?: string;
}

async function assertAuthResponseOk(
    response: APIResponse,
    action: string,
    email: string
): Promise<void> {
    if (!response.ok()) {
        const status = response.status();
        const bodyText = await response.text().catch(() => "<unreadable response body>");
        throw new Error(
            `[E2E Auth Fixture] ${action} failed for ${email}: POST /api/test/e2e-auth returned HTTP ${status}. Response body: ${bodyText}`
        );
    }
}

async function hydrateWorkspaceSession(page: Page, expectedUserId: string): Promise<void> {
    await page.goto("/workspace", { waitUntil: "domcontentloaded" });

    await page.waitForFunction(
        (uid) => {
            if (window.location.pathname.startsWith("/login")) {
                return true;
            }
            const hasStorageUid = window.localStorage?.getItem("elixent_uid") === uid;
            const hasCookieUid =
                document.cookie.includes(`elixent_uid=${encodeURIComponent(uid)}`) ||
                document.cookie.includes(`elixent_uid=${uid}`);
            const hasWorkspaceMain = document.querySelector("main") !== null;
            return hasWorkspaceMain && (hasStorageUid || hasCookieUid);
        },
        expectedUserId,
        { timeout: 15000 }
    );

    expect(page.url()).not.toMatch(/\/login/);
    await expect(page).toHaveURL(/\/workspace/);
}

export const test = base.extend<{
    authSession: AuthenticatedUser;
    loginAs: (user: AuthenticatedUser) => Promise<void>;
}>({
    authSession: async ({ page, context }, provide) => {
        const timestamp = Date.now().toString().slice(-6);
        const testUser: AuthenticatedUser = {
            userId: `9999${timestamp}-9999-9999-9999-999999999999`,
            email: `e2e-${timestamp}@lugx.test`,
            displayName: `E2E User ${timestamp}`,
        };

        // Call the dedicated test authentication API using context.request
        const response = await context.request.post("/api/test/e2e-auth", {
            data: {
                email: testUser.email,
                password: "E2E_Secure_Pass_2026!",
                displayName: testUser.displayName,
            },
        });

        await assertAuthResponseOk(response, "authSession bootstrap", testUser.email);
        const json = await response.json();
        testUser.userId = json.user.id;

        // Explicitly inject returned cookies into the browser context
        if (json.cookies && Array.isArray(json.cookies)) {
            const cookiesToAdd = (json.cookies as TestAuthCookie[]).map((c) => ({
                name: c.name,
                value: c.value,
                domain: "localhost",
                path: c.path || "/",
                httpOnly: false,
                secure: false,
                sameSite: "Lax" as const,
            }));
            await context.addCookies(cookiesToAdd);
        }

        // Navigate page to load workspace and wait deterministically for auth hydration
        await hydrateWorkspaceSession(page, testUser.userId);

        await provide(testUser);

        // Teardown: clean up database records
        await cleanupE2EUser(testUser.userId);
    },

    loginAs: async ({ page, context }, provide) => {
        const loginFn = async (user: AuthenticatedUser) => {
            const response = await context.request.post("/api/test/e2e-auth", {
                data: {
                    email: user.email,
                    password: "E2E_Secure_Pass_2026!",
                    displayName: user.displayName,
                },
            });
            await assertAuthResponseOk(response, "loginAs", user.email);
            const json = await response.json();
            user.userId = json.user.id;

            if (json.cookies && Array.isArray(json.cookies)) {
                const cookiesToAdd = (json.cookies as TestAuthCookie[]).map((c) => ({
                    name: c.name,
                    value: c.value,
                    domain: "localhost",
                    path: c.path || "/",
                    httpOnly: false,
                    secure: false,
                    sameSite: "Lax" as const,
                }));
                await context.addCookies(cookiesToAdd);
            }

            await hydrateWorkspaceSession(page, user.userId);
        };

        await provide(loginFn);
    },
});

export { expect };
