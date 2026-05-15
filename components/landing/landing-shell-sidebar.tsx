"use client";

import { GitHubMark } from "@/components/icons/github-mark";
import { LandingAccountMenu } from "@/components/landing/landing-account-menu";
import { LandingRepoHistoryAside } from "@/components/landing/landing-repo-history-aside";
import type { LandingAuthorLinks } from "@/components/landing/landing-shell-types";
import type { LandingAuthSnapshot } from "@/lib/auth/landing-auth";
import type { SidebarRepoVisit } from "@/lib/supabase/repo-visit-history";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { FolderGit } from "lucide-react";

export type LandingShellSidebarProps = {
  auth: LandingAuthSnapshot | null;
  author: LandingAuthorLinks;
  repoVisitHistory: SidebarRepoVisit[];
};

function startGithubOAuth() {
  window.location.assign("/api/auth/github");
}

export function LandingShellSidebar({
  auth,
  author,
  repoVisitHistory,
}: LandingShellSidebarProps) {
  const { state, isMobile } = useSidebar();
  const compactRail = !isMobile && state === "collapsed";
  const hasAuthor = Boolean(author.github || author.linkedIn);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="flex h-auto min-h-0 shrink-0 flex-col gap-0 py-1.5">
        <div
          className={cn(
            "flex w-full items-center py-1",
            compactRail ? "justify-center px-0" : "justify-center px-2",
          )}
        >
          <SidebarMenu className={cn("w-full", compactRail && "max-w-8")}>
            <SidebarMenuItem
              className={cn("w-full", compactRail && "flex justify-center")}
            >
              <SidebarMenuButton
                size="default"
                asChild
                tooltip="RepoLens — Home"
                className={cn(
                  "h-9 min-h-9 cursor-pointer text-[13px] leading-snug",
                  compactRail
                    ? "w-8 min-w-8 justify-center px-0"
                    : "w-full px-2",
                  "transition-colors duration-150",
                  "hover:bg-sidebar-accent/50 active:bg-sidebar-accent/70 dark:hover:bg-sidebar-accent/40 dark:active:bg-sidebar-accent/55",
                )}
              >
                <Link
                  href="/"
                  className={cn(
                    "flex size-full items-center gap-2 [&_svg]:size-3.5",
                    compactRail ? "justify-center gap-0" : "min-w-0",
                  )}
                >
                  <FolderGit
                    aria-hidden
                    className="shrink-0 text-sidebar-foreground"
                    strokeWidth={2}
                  />
                  {!compactRail ? (
                    <span className="min-w-0 truncate text-sidebar-foreground">
                      <span className="font-semibold">Repo</span>
                      <span className="font-semibold text-sidebar-foreground/70">
                        Lens
                      </span>
                    </span>
                  ) : null}
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </div>
      </SidebarHeader>

      <SidebarContent className="flex min-h-0 flex-1 flex-col overflow-hidden px-2">
        <div className="flex min-h-0 flex-1 flex-col pb-1">
          <LandingRepoHistoryAside
            authSignedIn={Boolean(auth)}
            initialVisits={repoVisitHistory}
          />
        </div>
        {hasAuthor ? (
          <div
            className={cn(
              "shrink-0 border-sidebar-border border-t p-3",
              compactRail &&
                "pointer-events-none invisible select-none border-transparent",
            )}
            aria-hidden={compactRail ? true : undefined}
          >
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

      <SidebarFooter className="flex h-auto min-h-0 shrink-0 flex-col gap-0 p-0 px-3 pt-1 pb-1.5">
        <div
          className={cn(
            "flex h-11 min-h-11 w-full shrink-0 items-center",
            compactRail && "justify-center",
          )}
        >
          {auth ? (
            <LandingAccountMenu auth={auth} compactRail={compactRail} />
          ) : (
            <SidebarMenu className={cn("w-full", compactRail && "max-w-8")}>
              <SidebarMenuItem
                className={cn("w-full", compactRail && "flex justify-center")}
              >
                <SidebarMenuButton
                  size="default"
                  tooltip="Log in with GitHub"
                  className={cn(
                    "cursor-pointer rounded-md text-[13px] leading-snug transition-colors duration-150",
                    "hover:bg-sidebar-accent/50 active:bg-sidebar-accent/70 dark:hover:bg-sidebar-accent/40 dark:active:bg-sidebar-accent/55",
                    compactRail
                      ? "h-8! min-h-8! w-8! min-w-8! max-h-8! max-w-8! justify-center gap-0! p-0! group-data-[collapsible=icon]:p-0!"
                      : "flex! h-9! min-h-9! w-full! items-center! gap-2! px-2! py-1.5!",
                  )}
                  type="button"
                  onClick={startGithubOAuth}
                >
                  <GitHubMark className="shrink-0 opacity-90" />
                  {!compactRail ? <span>Log in</span> : null}
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          )}
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
