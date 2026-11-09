// @vitest-environment jsdom
/**
 * Exhaustive Unit & Integration Test Suite for AppLink (`src/components/ui/app-link.tsx`)
 *
 * Verifies:
 * 1. TanStack Router Delegation:
 *    - Delegates to TanStack Router Link component when router context is present.
 *    - Maps `href` to `to` prop on TanStack Link.
 *    - Maps `to` prop directly to `to` on TanStack Link.
 *    - Forwards `replace={true}` to TanStack Link.
 * 2. URL Scheme & Route Isolation:
 *    - Internal routes (starting with "/"): delegates to TanStack Link.
 *    - External HTTP/HTTPS URLs ("https://..."): renders native anchor, bypasses TanStack Link.
 *    - Mailto URLs ("mailto:..."): renders native anchor, bypasses TanStack Link.
 *    - Telephone URLs ("tel:..."): renders native anchor, bypasses TanStack Link.
 *    - Hash fragments ("#section"): renders native anchor, bypasses TanStack Link.
 *    - Relative paths without leading slash ("workspace/relative"): renders native anchor, bypasses TanStack Link.
 *    - Empty string (""): renders native anchor, bypasses TanStack Link.
 * 3. Target Attribute Bypass:
 *    - target="_blank": renders native anchor, bypasses TanStack Link.
 *    - target="_self": renders native anchor, bypasses TanStack Link.
 *    - target="_parent" / "_top": renders native anchor, bypasses TanStack Link.
 *    - target="custom-frame": renders native anchor, bypasses TanStack Link.
 * 4. Event Interception & Click Handling:
 *    - Invokes custom onClick handler when link is clicked.
 *    - Allows e.preventDefault() to abort downstream handling.
 * 5. Standalone & Resilient Fallback (Outside RouterProvider):
 *    - Renders cleanly as standard HTML anchor when outside router context without throwing.
 *    - Preserves attributes, children, and onClick handling in standalone mode.
 * 6. HTML Element Forwarding & Accessibility (DOM Invariants):
 *    - Forwards React ref to underlying HTMLAnchorElement.
 *    - Forwards standard attributes (className, id, aria-label, aria-current, title, rel, data-*).
 *    - Renders text children and nested JSX elements cleanly.
 */

import React, { createRef } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const { mockUseRouter, mockLinkComponent } = vi.hoisted(() => ({
    mockUseRouter: vi.fn(),
    mockLinkComponent: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@tanstack/react-router")>();
    return {
        ...actual,
        useRouter: (...args: unknown[]) => mockUseRouter(...args),
        Link: React.forwardRef<HTMLAnchorElement, Record<string, unknown>>(function MockTanStackLink(props, ref) {
            mockLinkComponent(props);
            const { to, replace: _replace, children, ...rest } = props;
            return (
                <a ref={ref} href={typeof to === "string" ? to : undefined} {...rest}>
                    {children as React.ReactNode}
                </a>
            );
        }),
    };
});

import { AppLink } from "@/components/ui/app-link";

describe("AppLink Component", () => {
    const fakeRouter = {
        navigate: vi.fn(),
        state: { location: { pathname: "/" } },
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockUseRouter.mockReturnValue(fakeRouter);
    });

    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
    });

    describe("1. TanStack Router Delegation", () => {
        it("delegates to TanStack Link with mapped 'to' prop when 'href' is provided", () => {
            render(
                <AppLink href="/workspace/doc-101" data-testid="test-link">
                    Open Document
                </AppLink>
            );

            const link = screen.getByTestId("test-link");
            expect(link).toBeDefined();
            expect(link.getAttribute("href")).toBe("/workspace/doc-101");
            expect(mockLinkComponent).toHaveBeenCalledTimes(1);
            expect(mockLinkComponent).toHaveBeenCalledWith(
                expect.objectContaining({
                    to: "/workspace/doc-101",
                    children: "Open Document",
                })
            );
        });

        it("delegates to TanStack Link directly when 'to' prop is provided", () => {
            render(
                <AppLink to="/account" data-testid="to-link">
                    Account Settings
                </AppLink>
            );

            const link = screen.getByTestId("to-link");
            expect(link.getAttribute("href")).toBe("/account");
            expect(mockLinkComponent).toHaveBeenCalledWith(
                expect.objectContaining({
                    to: "/account",
                })
            );
        });

        it("forwards replace={true} to TanStack Link", () => {
            render(
                <AppLink href="/dashboard" replace data-testid="replace-link">
                    Dashboard
                </AppLink>
            );

            expect(mockLinkComponent).toHaveBeenCalledWith(
                expect.objectContaining({
                    to: "/dashboard",
                    replace: true,
                })
            );
        });
    });

    describe("2. URL Scheme & Route Isolation", () => {
        it.each([
            ["external HTTPS URL", "https://elixent.dev/docs"],
            ["external HTTP URL", "http://example.com"],
            ["mailto URL", "mailto:support@elixent.com"],
            ["telephone URL", "tel:+1234567890"],
            ["hash-only anchor", "#section-anchor"],
            ["relative path without leading slash", "workspace/relative"],
            ["empty string", ""],
        ])("bypasses TanStack Link for non-internal URL: %s (%s)", (_, href) => {
            render(
                <AppLink href={href} data-testid="external-link">
                    Navigate
                </AppLink>
            );

            const link = screen.getByTestId("external-link");
            expect(link.getAttribute("href")).toBe(href);
            // Must NOT delegate to TanStack Link
            expect(mockLinkComponent).not.toHaveBeenCalled();
        });
    });

    describe("3. Target Attribute Bypass", () => {
        it.each([
            ["target='_blank'", "_blank"],
            ["target='_self'", "_self"],
            ["target='_parent'", "_parent"],
            ["target='_top'", "_top"],
            ["target='custom-frame'", "custom-frame"],
        ])("bypasses TanStack Link when %s is specified", (_, target) => {
            render(
                <AppLink href="/dashboard" target={target} data-testid="target-link">
                    Target Link
                </AppLink>
            );

            const link = screen.getByTestId("target-link");
            expect(link.getAttribute("target")).toBe(target);
            // Must NOT delegate to TanStack Link
            expect(mockLinkComponent).not.toHaveBeenCalled();
        });
    });

    describe("4. Event Interception & Click Handling", () => {
        it("invokes custom onClick handler when link is clicked", () => {
            const customOnClick = vi.fn();
            render(
                <AppLink href="/workspace/test" onClick={customOnClick} data-testid="click-link">
                    Click Me
                </AppLink>
            );

            const link = screen.getByTestId("click-link");
            fireEvent.click(link);

            expect(customOnClick).toHaveBeenCalledTimes(1);
        });

        it("forwards onClick to native anchor for external URLs", () => {
            const customOnClick = vi.fn((e: React.MouseEvent<HTMLAnchorElement>) => {
                e.preventDefault();
            });

            render(
                <AppLink href="https://elixent.dev" onClick={customOnClick} data-testid="external-click">
                    External Link
                </AppLink>
            );

            const link = screen.getByTestId("external-click");
            fireEvent.click(link);

            expect(customOnClick).toHaveBeenCalledTimes(1);
            expect(mockLinkComponent).not.toHaveBeenCalled();
        });
    });

    describe("5. Standalone & Resilient Fallback (Outside RouterProvider)", () => {
        it("renders cleanly as standard HTML anchor when outside RouterProvider context", () => {
            mockUseRouter.mockReturnValue(null);

            render(
                <AppLink href="/workspace/editor/file-101" data-testid="standalone-link">
                    Standalone Link
                </AppLink>
            );

            const link = screen.getByTestId("standalone-link");
            expect(link).toBeInstanceOf(HTMLAnchorElement);
            expect(link.getAttribute("href")).toBe("/workspace/editor/file-101");
            expect(link.textContent).toBe("Standalone Link");
            expect(mockLinkComponent).not.toHaveBeenCalled();
        });

        it("invokes onClick handler in standalone mode without error", () => {
            mockUseRouter.mockReturnValue(null);
            const handleClick = vi.fn();

            render(
                <AppLink href="/dashboard" onClick={handleClick} data-testid="standalone-click">
                    Click Test
                </AppLink>
            );

            const link = screen.getByTestId("standalone-click");
            fireEvent.click(link);
            expect(handleClick).toHaveBeenCalledTimes(1);
        });
    });

    describe("6. HTML Element Forwarding & Accessibility (DOM Invariants)", () => {
        it("forwards React ref to the underlying HTMLAnchorElement", () => {
            const anchorRef = createRef<HTMLAnchorElement>();
            render(
                <AppLink ref={anchorRef} href="/workspace/ref-target" data-testid="ref-link">
                    Ref Target
                </AppLink>
            );

            expect(anchorRef.current).toBeInstanceOf(HTMLAnchorElement);
            expect(anchorRef.current?.getAttribute("href")).toBe("/workspace/ref-target");
        });

        it("forwards all standard anchor attributes and accessibility roles", () => {
            render(
                <AppLink
                    href="/workspace/a11y"
                    className="custom-nav-link text-primary"
                    id="nav-link-101"
                    aria-label="Accessible Navigation Link"
                    aria-current="page"
                    title="Tooltip Title"
                    rel="noopener noreferrer"
                    tabIndex={0}
                    data-cy="cypress-link"
                >
                    <span data-testid="child-icon">Icon</span>
                    <span>Accessible Text</span>
                </AppLink>
            );

            const link = screen.getByLabelText("Accessible Navigation Link");
            expect(link).toBeDefined();
            expect(link.className).toContain("custom-nav-link text-primary");
            expect(link.id).toBe("nav-link-101");
            expect(link.getAttribute("aria-current")).toBe("page");
            expect(link.getAttribute("title")).toBe("Tooltip Title");
            expect(link.getAttribute("rel")).toBe("noopener noreferrer");
            expect(link.getAttribute("tabindex")).toBe("0");
            expect(link.getAttribute("data-cy")).toBe("cypress-link");
            expect(screen.getByTestId("child-icon")).toBeDefined();
        });
    });
});
