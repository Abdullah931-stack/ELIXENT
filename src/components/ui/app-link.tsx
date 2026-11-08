import * as React from "react";

export type AppLinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    replace?: boolean;
};

export const AppLink = React.forwardRef<HTMLAnchorElement, AppLinkProps>(
    function AppLink({ href, replace, onClick, target, children, ...props }, ref) {
        function handleClick(e: React.MouseEvent<HTMLAnchorElement>) {
            onClick?.(e);

            if (
                !e.defaultPrevented &&
                e.button === 0 &&
                !e.metaKey &&
                !e.ctrlKey &&
                !e.altKey &&
                !e.shiftKey &&
                !target &&
                href.startsWith("/") &&
                typeof window !== "undefined"
            ) {
                e.preventDefault();
                if (replace) {
                    window.history.replaceState({}, "", href);
                } else {
                    window.history.pushState({}, "", href);
                }
                window.dispatchEvent(new PopStateEvent("popstate"));
            }
        }

        return (
            <a ref={ref} href={href} target={target} onClick={handleClick} {...props}>
                {children}
            </a>
        );
    }
);
