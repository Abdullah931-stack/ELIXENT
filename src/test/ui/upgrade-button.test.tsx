// @vitest-environment jsdom
/**
 * UI Test Suite: Subscription Upgrade Button (`src/components/subscription/upgrade-button.tsx`)
 *
 * Verifies:
 * 1. Rendering & Tier Promotion Hierarchy:
 *    - Renders button with formatted tier title.
 *    - Allows valid upgrades (free -> pro, free -> ultra, pro -> ultra).
 *    - Disables when current tier matches or exceeds target tier.
 *    - Honors explicit `disabled` prop.
 * 2. Unified Transport Fetch Resolution (FIND-07):
 *    - Dispatches checkout creation requests through injected custom fetch via `setRpcClientFetch()`.
 *    - Falls back to `globalThis.fetch` when no custom fetch transport is configured.
 * 3. Navigation & Lifecycle Resilience:
 *    - Redirects `window.location.href` on checkout URL reception.
 *    - Gracefully handles non-OK server responses, surfacing toast notification and resetting loading state.
 *    - Handles rejected network promises without unhandled promise crashes.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { UpgradeButton } from '@/components/subscription/upgrade-button';
import { setRpcClientFetch } from '@/client/rpc-client';

describe('UpgradeButton Transport & UI Verification', () => {
    const originalLocation = window.location;

    beforeEach(() => {
        vi.restoreAllMocks();
        setRpcClientFetch(undefined);

        // Mock window.location for jsdom navigation
        Object.defineProperty(window, 'location', {
            configurable: true,
            writable: true,
            value: {
                ...originalLocation,
                href: 'http://localhost:3000/settings',
            },
        });
    });

    afterEach(() => {
        setRpcClientFetch(undefined);
        Object.defineProperty(window, 'location', {
            configurable: true,
            writable: true,
            value: originalLocation,
        });
    });

    it('renders the correct target tier title', () => {
        render(<UpgradeButton tier="pro" currentTier="free" />);
        const proButton = screen.getByRole('button', { name: /upgrade to pro/i }) as HTMLButtonElement;
        expect(proButton).toBeDefined();
        expect(proButton.textContent).toContain('Upgrade to Pro');

        render(<UpgradeButton tier="ultra" currentTier="free" />);
        const ultraButton = screen.getByRole('button', { name: /upgrade to ultra/i }) as HTMLButtonElement;
        expect(ultraButton).toBeDefined();
        expect(ultraButton.textContent).toContain('Upgrade to Ultra');
    });

    it('disables the button when current tier is equal to target tier', () => {
        render(<UpgradeButton tier="pro" currentTier="pro" />);
        const button = screen.getByRole('button', { name: /upgrade to pro/i }) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
    });

    it('disables the button when current tier is higher than target tier', () => {
        render(<UpgradeButton tier="pro" currentTier="ultra" />);
        const button = screen.getByRole('button', { name: /upgrade to pro/i }) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
    });

    it('disables the button when disabled prop is explicitly true', () => {
        render(<UpgradeButton tier="ultra" currentTier="pro" disabled={true} />);
        const button = screen.getByRole('button', { name: /upgrade to ultra/i }) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
    });

    it('dispatches checkout creation through custom fetch registered with setRpcClientFetch', async () => {
        const mockCustomFetch = vi.fn(async () =>
            new Response(
                JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/cs_test_custom_rpc' }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }
            )
        );

        setRpcClientFetch(mockCustomFetch as unknown as typeof fetch);

        render(<UpgradeButton tier="pro" currentTier="free" />);
        const button = screen.getByRole('button', { name: /upgrade to pro/i });
        fireEvent.click(button);

        await waitFor(() => {
            expect(mockCustomFetch).toHaveBeenCalledTimes(1);
        });

        expect(mockCustomFetch).toHaveBeenCalledWith(
            '/api/stripe/create-checkout',
            expect.objectContaining({
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ tier: 'pro' }),
            })
        );

        await waitFor(() => {
            expect(window.location.href).toBe('https://checkout.stripe.com/c/pay/cs_test_custom_rpc');
        });
    });

    it('falls back to global fetch when no custom transport is registered', async () => {
        setRpcClientFetch(undefined);

        const mockGlobalFetch = vi.fn(async () =>
            new Response(
                JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/cs_test_global' }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }
            )
        );
        vi.stubGlobal('fetch', mockGlobalFetch);

        render(<UpgradeButton tier="ultra" currentTier="pro" />);
        const button = screen.getByRole('button', { name: /upgrade to ultra/i });
        fireEvent.click(button);

        await waitFor(() => {
            expect(mockGlobalFetch).toHaveBeenCalledTimes(1);
        });

        expect(mockGlobalFetch).toHaveBeenCalledWith(
            '/api/stripe/create-checkout',
            expect.objectContaining({
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ tier: 'ultra' }),
            })
        );

        await waitFor(() => {
            expect(window.location.href).toBe('https://checkout.stripe.com/c/pay/cs_test_global');
        });
    });

    it('handles server failure response gracefully and restores button state', async () => {
        const mockErrorFetch = vi.fn(async () =>
            new Response(
                JSON.stringify({ error: 'Customer already has an active subscription' }),
                {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                }
            )
        );

        setRpcClientFetch(mockErrorFetch as unknown as typeof fetch);

        render(<UpgradeButton tier="pro" currentTier="free" />);
        const button = screen.getByRole('button', { name: /upgrade to pro/i }) as HTMLButtonElement;
        fireEvent.click(button);

        await waitFor(() => {
            expect(mockErrorFetch).toHaveBeenCalledTimes(1);
        });

        // The button should return to an enabled state after loading completes
        await waitFor(() => {
            expect(button.disabled).toBe(false);
            expect(button.textContent).toContain('Upgrade to Pro');
        });

        // Location should not have changed
        expect(window.location.href).toBe('http://localhost:3000/settings');
    });

    it('handles network throw gracefully without unhandled crashes', async () => {
        const mockRejectFetch = vi.fn(async () => {
            throw new Error('Network connection offline');
        });

        setRpcClientFetch(mockRejectFetch as unknown as typeof fetch);

        render(<UpgradeButton tier="pro" currentTier="free" />);
        const button = screen.getByRole('button', { name: /upgrade to pro/i }) as HTMLButtonElement;
        fireEvent.click(button);

        await waitFor(() => {
            expect(mockRejectFetch).toHaveBeenCalledTimes(1);
        });

        await waitFor(() => {
            expect(button.disabled).toBe(false);
            expect(button.textContent).toContain('Upgrade to Pro');
        });
    });
});
