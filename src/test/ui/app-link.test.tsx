// @vitest-environment jsdom
/**
 * Exhaustive Unit & Edge Case Test Suite for AppLink (`src/components/ui/app-link.tsx`)
 *
 * Verifies:
 * 1. Standard Client-Side Navigation:
 *    - Pushes state via window.history.pushState on normal left click with internal path.
 *    - Replaces state via window.history.replaceState when replace={true}.
 *    - Dispatches a standard PopStateEvent ('popstate') to window on client navigation.
 *    - Calls e.preventDefault() to suppress native browser full-page reload.
 * 2. Modifier Keys Bypass (Browser Multi-Tab / New-Window Native Behavior):
 *    - metaKey (Cmd on macOS): client navigation is bypassed (e.preventDefault NOT called, pushState NOT called).
 *    - ctrlKey (Ctrl on Windows/Linux): client navigation is bypassed.
 *    - altKey (Alt/Option): client navigation is bypassed.
 *    - shiftKey (Shift): client navigation is bypassed.
 * 3. Mouse Button Filtering:
 *    - Left click (button === 0): triggers client navigation.
 *    - Middle click (button === 1 / auxclick): bypasses client navigation.
 *    - Right click (button === 2 / contextmenu): bypasses client navigation.
 *    - Extended buttons (button === 3, 4): bypasses client navigation.
 * 4. URL Scheme & Route Isolation:
 *    - Internal routes (starting with "/"): executes client-side navigation.
 *    - External HTTP/HTTPS URLs ("https://..."): bypasses client navigation.
 *    - Mailto URLs ("mailto:..."): bypasses client navigation.
 *    - Telephone URLs ("tel:..."): bypasses client navigation.
 *    - Hash fragments ("#section"): bypasses client navigation.
 *    - Relative paths without leading slash ("workspace/doc-1"): bypasses client navigation.
 *    - Empty string (""): bypasses client navigation.
 * 5. Target Attribute Bypass:
 *    - target="_blank": bypasses client navigation.
 *    - target="_self": bypasses client navigation.
 *    - target="_parent" / "_top": bypasses client navigation.
 * 6. Event Interception & defaultPrevented Handling:
 *    - Custom onClick handler is invoked first with the React mouse event.
 *    - If onClick executes e.preventDefault(), client-side routing is aborted.
 *    - If onClick does NOT execute e.preventDefault(), client-side routing proceeds normally.
 * 7. HTML Element Forwarding & Accessibility (DOM Invariants):
 *    - Forwards ref to underlying HTMLAnchorElement.
 *    - Forwards standard attributes (className, id, aria-label, aria-current, title, rel, data-*).
 *    - Renders text children and nested JSX elements cleanly.
 */

import React, { createRef } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AppLink } from "@/components/ui/app-link";

describe("AppLink Component", () => {
    let pushStateSpy: ReturnType<typeof vi.spyOn>;
    let replaceStateSpy: ReturnType<typeof vi.spyOn>;
    let dispatchEventSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        pushStateSpy = vi.spyOn(window.history, "pushState").mockImplementation(() => {});
        replaceStateSpy = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
        dispatchEventSpy = vi.spyOn(window, "dispatchEvent").mockImplementation(() => true);
    });

    afterEach(() => {
        pushStateSpy.mockRestore();
        replaceStateSpy.mockRestore();
        dispatchEventSpy.mockRestore();
    });

    describe("1. Standard Client-Side Navigation", () => {
        it("triggers pushState and dispatches popstate event on primary left click for internal routes", () => {
            render(
                <AppLink href="/workspace/doc-101" data-testid="test-link">
                    Open Document
                </AppLink>
            );

            const link = screen.getByTestId("test-link");
            const clickEvent = new MouseEvent("click", {
                bubbles: true,
                cancelable: true,
                button: 0,
            });

            const defaultPrevented = !link.dispatchEvent(clickEvent);

            expect(defaultPrevented).toBe(true);
            expect(pushStateSpy).toHaveBeenCalledTimes(1);
            expect(pushStateSpy).toHaveBeenCalledWith({}, "", "/workspace/doc-101");
            expect(replaceStateSpy).not.toHaveBeenCalled();
            expect(dispatchEventSpy).toHaveBeenCalledTimes(1);
            const dispatchedEvent = dispatchEventSpy.mock.calls[0][0];
            expect(dispatchedEvent).toBeInstanceOf(PopStateEvent);
            expect(dispatchedEvent.type).toBe("popstate");
        });

        it("triggers replaceState instead of pushState when replace is true", () => {
            render(
                <AppLink href="/account" replace data-testid="replace-link">
                    Account Settings
                </AppLink>
            );

            const link = screen.getByTestId("replace-link");
            const clickEvent = new MouseEvent("click", {
                bubbles: true,
                cancelable: true,
                button: 0,
            });

            const defaultPrevented = !link.dispatchEvent(clickEvent);

            expect(defaultPrevented).toBe(true);
            expect(replaceStateSpy).toHaveBeenCalledTimes(1);
            expect(replaceStateSpy).toHaveBeenCalledWith({}, "", "/account");
            expect(pushStateSpy).not.toHaveBeenCalled();
            expect(dispatchEventSpy).toHaveBeenCalledTimes(1);
            expect(dispatchEventSpy.mock.calls[0][0].type).toBe("popstate");
        });
    });

    describe("2. Modifier Keys Bypass (Browser Native Multitasking)", () => {
        it.each([
            ["metaKey (Cmd/Command)", { metaKey: true }],
            ["ctrlKey (Control)", { ctrlKey: true }],
            ["altKey (Alt/Option)", { altKey: true }],
            ["shiftKey (Shift)", { shiftKey: true }],
        ])("bypasses client routing when %s is pressed", (_, modifier) => {
            render(
                <AppLink href="/workspace/new-tab" data-testid="mod-link">
                    Open in New Tab
                </AppLink>
            );

            const link = screen.getByTestId("mod-link");
            const clickEvent = new MouseEvent("click", {
                bubbles: true,
                cancelable: true,
                button: 0,
                ...modifier,
            });

            const defaultPrevented = !link.dispatchEvent(clickEvent);

            expect(defaultPrevented).toBe(false);
            expect(pushStateSpy).not.toHaveBeenCalled();
            expect(replaceStateSpy).not.toHaveBeenCalled();
            expect(dispatchEventSpy).not.toHaveBeenCalled();
        });
    });

    describe("3. Mouse Button Filtering", () => {
        it.each([
            ["middle click (button: 1)", 1],
            ["right click (button: 2)", 2],
            ["auxiliary button 3", 3],
            ["auxiliary button 4", 4],
        ])("bypasses client routing on non-primary button: %s", (_, button) => {
            render(
                <AppLink href="/workspace/aux" data-testid="button-link">
                    Aux Click
                </AppLink>
            );

            const link = screen.getByTestId("button-link");
            const clickEvent = new MouseEvent("click", {
                bubbles: true,
                cancelable: true,
                button,
            });

            const defaultPrevented = !link.dispatchEvent(clickEvent);

            expect(defaultPrevented).toBe(false);
            expect(pushStateSpy).not.toHaveBeenCalled();
            expect(replaceStateSpy).not.toHaveBeenCalled();
            expect(dispatchEventSpy).not.toHaveBeenCalled();
        });
    });

    describe("4. URL Scheme & Route Isolation", () => {
        it.each([
            ["external HTTPS URL", "https://elixent.dev/docs"],
            ["external HTTP URL", "http://example.com"],
            ["mailto URL", "mailto:support@elixent.com"],
            ["telephone URL", "tel:+1234567890"],
            ["hash-only anchor", "#section-anchor"],
            ["relative path without leading slash", "workspace/relative"],
            ["empty string", ""],
        ])("bypasses client routing for non-root URL: %s (%s)", (_, href) => {
            render(
                <AppLink href={href} data-testid="external-link">
                    Navigate
                </AppLink>
            );

            const link = screen.getByTestId("external-link");
            const clickEvent = new MouseEvent("click", {
                bubbles: true,
                cancelable: true,
                button: 0,
            });

            const defaultPrevented = !link.dispatchEvent(clickEvent);

            expect(defaultPrevented).toBe(false);
            expect(pushStateSpy).not.toHaveBeenCalled();
            expect(replaceStateSpy).not.toHaveBeenCalled();
            expect(dispatchEventSpy).not.toHaveBeenCalled();
        });
    });

    describe("5. Target Attribute Bypass", () => {
        it.each([
            ["target='_blank'", "_blank"],
            ["target='_self'", "_self"],
            ["target='_parent'", "_parent"],
            ["target='_top'", "_top"],
            ["target='custom-frame'", "custom-frame"],
        ])("bypasses client routing when %s is specified", (_, target) => {
            render(
                <AppLink href="/dashboard" target={target} data-testid="target-link">
                    Target Link
                </AppLink>
            );

            const link = screen.getByTestId("target-link");
            const clickEvent = new MouseEvent("click", {
                bubbles: true,
                cancelable: true,
                button: 0,
            });

            const defaultPrevented = !link.dispatchEvent(clickEvent);

            expect(defaultPrevented).toBe(false);
            expect(pushStateSpy).not.toHaveBeenCalled();
            expect(replaceStateSpy).not.toHaveBeenCalled();
            expect(dispatchEventSpy).not.toHaveBeenCalled();
        });
    });

    describe("6. Event Interception & defaultPrevented Handling", () => {
        it("invokes custom onClick handler before navigation logic", () => {
            const customOnClick = vi.fn();
            render(
                <AppLink href="/workspace/test" onClick={customOnClick} data-testid="click-link">
                    Click Me
                </AppLink>
            );

            const link = screen.getByTestId("click-link");
            fireEvent.click(link);

            expect(customOnClick).toHaveBeenCalledTimes(1);
            expect(pushStateSpy).toHaveBeenCalledTimes(1);
            expect(dispatchEventSpy).toHaveBeenCalledTimes(1);
        });

        it("aborts client-side routing if custom onClick calls e.preventDefault()", () => {
            const customOnClick = vi.fn((e: React.MouseEvent<HTMLAnchorElement>) => {
                e.preventDefault();
            });

            render(
                <AppLink href="/workspace/guarded" onClick={customOnClick} data-testid="prevent-link">
                    Guarded Link
                </AppLink>
            );

            const link = screen.getByTestId("prevent-link");
            fireEvent.click(link);

            expect(customOnClick).toHaveBeenCalledTimes(1);
            expect(pushStateSpy).not.toHaveBeenCalled();
            expect(replaceStateSpy).not.toHaveBeenCalled();
            expect(dispatchEventSpy).not.toHaveBeenCalled();
        });
    });

    describe("7. HTML Element Forwarding & Accessibility (DOM Invariants)", () => {
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
