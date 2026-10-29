import { test, expect } from "../fixtures/auth-fixture";
import { getDbSubscriptionEvents } from "../fixtures/test-db";
import { createHmac } from "node:crypto";

test.describe("Scenario 14: Stripe Subscription Checkout & Durable Event Ledger", () => {
    test("Stripe checkout webhook should record event ledger and reflect Pro tier in account UI", async ({
        page,
        authSession,
    }) => {
        // 1. Navigate to /account
        await page.goto("/account");
        await page.waitForLoadState("domcontentloaded");

        // Verify current account tier displays Free
        const freeBadge = page.getByText("Free", { exact: true }).first();
        await expect(freeBadge).toBeVisible({ timeout: 15000 });

        // 2. Dispatch real signed HTTP POST to webhook endpoint instead of directly mutating database
        const eventId = `evt_e2e_${Date.now()}`;
        const subscriptionId = `sub_e2e_${Date.now()}`;
        const timestamp = Math.floor(Date.now() / 1000);
        const secret = process.env.STRIPE_WEBHOOK_SECRET || "whsec_test_mock_ci_secret";

        const webhookPayload = JSON.stringify({
            id: eventId,
            type: "checkout.session.completed",
            data: {
                object: {
                    id: `cs_e2e_${Date.now()}`,
                    object: "checkout.session",
                    payment_status: "paid",
                    created: timestamp,
                    subscription: subscriptionId,
                    metadata: {
                        userId: authSession.userId,
                        tier: "pro",
                    },
                },
            },
        });

        const signature = createHmac("sha256", secret)
            .update(`${timestamp}.${webhookPayload}`)
            .digest("hex");

        const stripeSignatureHeader = `t=${timestamp},v1=${signature}`;

        // Dispatch real signed HTTP POST directly to canonical /api/stripe/webhook
        const response = await page.request.post("/api/stripe/webhook", {
            headers: {
                "content-type": "application/json",
                "stripe-signature": stripeSignatureHeader,
            },
            data: webhookPayload,
        });

        expect(response.ok()).toBeTruthy();

        // 3. Verify in database: subscription_events has recorded event from webhook processing
        const events = await getDbSubscriptionEvents(authSession.userId);
        const recordedEvent = events.find((e) => e.eventId === eventId);
        expect(recordedEvent).toBeDefined();
        expect(recordedEvent?.eventType).toBe("checkout.session.completed");
        expect(recordedEvent?.status).toBe("processed");

        // 4. Reload /account and verify real-time UI tier reflection
        await page.reload();
        await page.waitForLoadState("domcontentloaded");

        const proBadge = page.getByText("Pro", { exact: true }).first();
        await expect(proBadge).toBeVisible();
    });
});
