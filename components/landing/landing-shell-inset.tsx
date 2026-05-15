"use client";

import { GitHubMark } from "@/components/icons/github-mark";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { Copyright } from "lucide-react";
import { usePathname } from "next/navigation";

import type { ReactNode, SVGProps } from "react";

export type LandingShellInsetProps = {
  children: ReactNode;
};

function LinkedInMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M4.98 3.5C4.98 4.88 3.87 6 2.5 6S0 4.88 0 3.5 1.12 1 2.5 1 4.98 2.12 4.98 3.5zM.5 8h4V23h-4V8zm7 0h3.84v2.05h.05c.53-1 1.84-2.05 3.8-2.05 4.06 0 4.81 2.67 4.81 6.14V23h-4v-6.69c0-1.6-.03-3.66-2.23-3.66-2.24 0-2.58 1.74-2.58 3.55V23h-3.89V8z" />
    </svg>
  );
}

export function LandingShellInset({ children }: LandingShellInsetProps) {
  const pathname = usePathname();
  const author = {
    name: process.env.NEXT_PUBLIC_AUTHOR_NAME?.trim() ?? "",
    github: process.env.NEXT_PUBLIC_AUTHOR_GITHUB_URL?.trim() ?? "",
    linkedIn: process.env.NEXT_PUBLIC_AUTHOR_LINKEDIN_URL?.trim() ?? "",
  };
  const ownerLabel = author.name.trim();
  const currentYear = new Date().getFullYear();
  const showFooter = pathname === "/";

  return (
    <SidebarInset
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-hidden bg-background",
      )}
    >
      <header className="flex shrink-0 items-center gap-2 bg-background px-3 py-2 md:hidden">
        <SidebarTrigger className="text-foreground" />
        <span className="text-sm font-semibold tracking-tight">
          <span className="text-foreground">Repo</span>
          <span className="text-muted-foreground">Lens</span>
        </span>
      </header>
      <div className="scrollbar-hide flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
      {showFooter ? (
        <footer className="shrink-0 px-4 py-3 text-[11.5px] text-muted-foreground md:px-6">
          <div className="mx-auto flex max-w-3xl items-center justify-center gap-2 whitespace-nowrap text-center">
            <span className="inline-flex items-center gap-1.5 text-foreground/90">
              <Copyright className="size-3.5 opacity-80" aria-hidden />
              <span>
                {currentYear} RepoLens
                {ownerLabel ? ` by ${ownerLabel}` : ""}
              </span>
            </span>
            {author.github.trim() ? (
              <>
                <span className="text-muted-foreground/60" aria-hidden>
                  •
                </span>
                <a
                  href={author.github}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <GitHubMark className="size-3.5" />
                  <span>GitHub</span>
                </a>
              </>
            ) : null}
            {author.linkedIn.trim() ? (
              <>
                <span className="text-muted-foreground/60" aria-hidden>
                  •
                </span>
                <a
                  href={author.linkedIn}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <LinkedInMark className="size-3.5" />
                  <span>LinkedIn</span>
                </a>
              </>
            ) : null}
          </div>
        </footer>
      ) : null}
    </SidebarInset>
  );
}
