"use client";

import { GitHubMark } from "@/components/icons/github-mark";
import { LandingAccountMenu } from "@/components/landing/landing-account-menu";
import type { LandingAuthSnapshot } from "@/lib/auth/landing-auth";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { FolderGit } from "lucide-react";
import Link from "next/link";

/** Matches inset outer spacing: mobile `m-2` (8px), md `mt-3 mb-3` — applied to sidebar top/bottom only. */
const SIDEBAR_VIEWPORT_PAD_Y = "py-2 md:py-3";

function startGithubOAuth() {
  window.location.assign("/api/auth/github");
}

export type LandingAuthorLinks = {
  github: string;
  linkedIn: string;
};

type LandingShellProps = {
  auth: LandingAuthSnapshot | null;
  author: LandingAuthorLinks;
  children: React.ReactNode;
};

export function LandingShell({ auth, author, children }: LandingShellProps) {
  const hasAuthor = Boolean(author.github || author.linkedIn);

  return (
    <SidebarProvider defaultOpen>
      <Sidebar collapsible="offcanvas" className={SIDEBAR_VIEWPORT_PAD_Y}>
        <SidebarHeader className="flex h-auto min-h-0 shrink-0 flex-col gap-0 py-2">
          <div className="flex w-full items-center justify-center px-3 py-1">
            <SidebarMenu className="w-full">
              <SidebarMenuItem className="w-full">
                <SidebarMenuButton
                  size="sm"
                  asChild
                  className={cn(
                    "size-auto h-8 min-h-8 w-full max-w-none cursor-pointer px-2 text-[13px] leading-snug",
                    "transition-colors duration-150",
                    "hover:bg-sidebar-accent/50 active:bg-sidebar-accent/70 dark:hover:bg-sidebar-accent/40 dark:active:bg-sidebar-accent/55",
                  )}
                >
                  <Link href="/" className="flex size-full items-center gap-2 [&_svg]:size-3.5">
                    <FolderGit
                      aria-hidden
                      className="text-sidebar-foreground"
                      strokeWidth={2}
                    />
                    <span className="truncate text-sidebar-foreground">
                      <span className="font-semibold">Repo</span>
                      <span className="font-semibold text-sidebar-foreground/70">
                        Lens
                      </span>
                    </span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </div>
        </SidebarHeader>

        <SidebarContent className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="min-h-0 flex-1" />
          {hasAuthor ? (
            <div className="shrink-0 border-sidebar-border border-t px-3 py-3">
              <p className="mb-1.5 text-[10px] text-sidebar-foreground/50">
                Author
              </p>
              <div className="flex flex-col gap-1.5 text-xs">
                {author.github ? (
                  <Link
                    href={author.github}
                    prefetch={false}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="truncate text-sidebar-foreground/80 underline-offset-2 hover:text-sidebar-foreground hover:underline"
                  >
                    GitHub profile
                  </Link>
                ) : null}
                {author.linkedIn ? (
                  <Link
                    href={author.linkedIn}
                    prefetch={false}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="truncate text-sidebar-foreground/80 underline-offset-2 hover:text-sidebar-foreground hover:underline"
                  >
                    LinkedIn
                  </Link>
                ) : null}
              </div>
            </div>
          ) : null}
        </SidebarContent>

        <SidebarFooter className="mt-auto flex h-auto min-h-0 shrink-0 flex-col gap-0 py-2 p-0">
          <div className="flex w-full items-center px-3 py-1">
            {auth ? (
              <LandingAccountMenu auth={auth} className="w-full" />
            ) : (
              <SidebarMenu className="w-full">
                <SidebarMenuItem className="w-full">
                  <SidebarMenuButton
                    size="sm"
                    asChild
                    className={cn(
                      "size-auto h-8 min-h-8 w-full max-w-none cursor-pointer px-2 text-[13px] leading-snug",
                      "transition-colors duration-150",
                      "hover:bg-sidebar-accent/50 active:bg-sidebar-accent/70 dark:hover:bg-sidebar-accent/40 dark:active:bg-sidebar-accent/55",
                    )}
                  >
                    <button
                      type="button"
                      className="flex size-full cursor-pointer items-center gap-2 text-left [&_svg]:size-3.5"
                      onClick={startGithubOAuth}
                    >
                      <GitHubMark className="opacity-90" />
                      <span>Log in</span>
                    </button>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            )}
          </div>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background",
          "m-2 md:mr-3 md:mt-3 md:mb-3 md:ml-0 md:peer-data-[state=collapsed]:ml-3",
        )}
      >
        <header className="flex shrink-0 items-center gap-2 bg-background px-3 py-2 md:hidden">
          <SidebarTrigger className="text-foreground" />
          <span className="text-sm font-semibold tracking-tight">
            <span className="text-foreground">Repo</span>
            <span className="text-muted-foreground">Lens</span>
          </span>
        </header>
        <div className="flex flex-1 flex-col justify-center px-5 py-10 md:px-8 md:py-14">
          <div className="-translate-y-5 mx-auto flex w-full max-w-3xl flex-col items-center gap-3 md:-translate-y-8 md:gap-4">
            {children}
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
