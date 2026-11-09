import * as React from "react";
import { Link as TanStackLink, useRouter } from "@tanstack/react-router";

export type AppLinkProps = Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
    href?: string;
    to?: string;
    replace?: boolean;
};

export const AppLink = React.forwardRef<HTMLAnchorElement, AppLinkProps>(
    function AppLink({ href, to, replace, onClick, target, children, ...props }, ref) {
        const router = useRouter({ warn: false });
        const targetPath = to ?? href ?? "";

        // Determine if target should bypass TanStack client-side routing
        const isExternal =
            !targetPath.startsWith("/") ||
            targetPath.startsWith("//") ||
            Boolean(target);

        // Outside RouterProvider context or for external targets, render standard anchor
        if (!router || isExternal) {
            return (
                <a
                    ref={ref}
                    href={targetPath}
                    target={target}
                    onClick={onClick}
                    {...props}
                >
                    {children}
                </a>
            );
        }

        type TanStackLinkProps = React.ComponentProps<typeof TanStackLink>;
        const linkProps = props as unknown as Omit<TanStackLinkProps, "to" | "replace" | "target" | "onClick">;

        return (
            <TanStackLink
                ref={ref}
                to={targetPath as unknown as TanStackLinkProps["to"]}
                replace={replace}
                target={target}
                onClick={onClick}
                {...linkProps}
            >
                {children}
            </TanStackLink>
        );
    }
);

AppLink.displayName = "AppLink";
