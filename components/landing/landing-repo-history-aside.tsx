"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { SidebarRepoVisit } from "@/lib/supabase/repo-visit-history";
import { cn } from "@/lib/utils";
import { History } from "lucide-react";

type LandingRepoHistoryAsideProps = {
  authSignedIn: boolean;
  /** Layout SSR bootstrap — refreshed on pathname change. */
  initialVisits: SidebarRepoVisit[];
};

export function LandingRepoHistoryAside({
  authSignedIn,
  initialVisits,
}: LandingRepoHistoryAsideProps) {
  const pathname = usePathname();
  const [visits, setVisits] = useState(initialVisits);
  const { state, isMobile } = useSidebar();
  /** Desktop collapsed icon rail — never compact layout inside the mobile sheet. */
  const compactRail = !isMobile && state === "collapsed";

  useEffect(() => {
    if (!authSignedIn) return;

    let cancelled = false;
    void fetch("/api/repos/history", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { visits?: SidebarRepoVisit[] } | null) => {
        if (cancelled || !body?.visits) return;
        setVisits(body.visits);
      })
      .catch(() => null);

    return () => {
      cancelled = true;
    };
  }, [authSignedIn, pathname]);

  const repoTooltip = (v: SidebarRepoVisit) =>
    v.starsLabel === "—"
      ? `${v.ownerDisplay}/${v.repoDisplay}`
      : `${v.ownerDisplay}/${v.repoDisplay} · ${v.starsLabel} stars`;

  return (
    <>
      {!compactRail ? (
        <p className="px-3 pt-2 pb-1.75 text-sidebar-foreground/50 text-[10px]">
          History
        </p>
      ) : null}
      {compactRail ? (
        <div className="flex w-full justify-center px-0 pb-2">
          <Tooltip delayDuration={200}>
            <TooltipTrigger asChild>
              <div
                className="flex size-8 items-center justify-center rounded-md text-sidebar-foreground/65"
                aria-label="History"
              >
                <History className="size-4" strokeWidth={2} aria-hidden />
              </div>
            </TooltipTrigger>
            <TooltipContent side="right" align="center">
              History
            </TooltipContent>
          </Tooltip>
        </div>
      ) : null}

      {authSignedIn && visits.length > 0 ? (
        <nav
          aria-label="Recently viewed repositories"
          className="scrollbar-hide min-h-0 flex-1 overflow-y-auto"
        >
          <SidebarMenu
            className={cn(
              "gap-0.5",
              compactRail ? "w-full items-center px-0" : "px-1",
            )}
          >
            {visits.map((v) => (
              <SidebarMenuItem
                key={v.id}
                className={cn(compactRail && "flex w-full justify-center")}
              >
                <SidebarMenuButton
                  size="sm"
                  asChild
                  tooltip={repoTooltip(v)}
                  className={cn(
                    "size-auto h-auto min-h-10 max-w-none gap-2 py-1.5 text-left text-[12px] leading-snug",
                    compactRail
                      ? // Sidebar sets `group-data-[collapsible=icon]:p-2!` — must override or 24px images crush inside size-8
                        "size-8! min-h-8! min-w-8! max-h-8! max-w-8! justify-center overflow-visible rounded-md border-0 bg-transparent shadow-none ring-0 group-data-[collapsible=icon]:p-0! group-data-[collapsible=icon]:gap-0!"
                      : "w-full px-2",
                    "transition-colors duration-150",
                    "hover:bg-sidebar-accent/50 active:bg-sidebar-accent/70 dark:hover:bg-sidebar-accent/40 dark:active:bg-sidebar-accent/55 data-[active=true]:bg-sidebar-accent",
                  )}
                >
                  <Link
                    href={v.href}
                    prefetch={false}
                    className={cn(
                      "flex min-w-0 items-center gap-2",
                      compactRail
                        ? "size-8 min-h-8 min-w-8 items-center justify-center overflow-visible rounded-md p-0"
                        : "w-full",
                    )}
                  >
                    <Image
                      src={v.avatarUrl}
                      alt=""
                      width={24}
                      height={24}
                      unoptimized
                      className="size-6 min-h-6 min-w-6 shrink-0 rounded-md border border-sidebar-border bg-sidebar object-cover"
                    />
                    {!compactRail ? (
                      <>
                        <span className="min-w-0 flex-1 truncate leading-snug">
                          <span className="text-[12px]">
                            <span className="text-muted-foreground">
                              {`${v.ownerDisplay}/`}
                            </span>
                            <span className="font-medium text-sidebar-foreground">
                              {v.repoDisplay}
                            </span>
                          </span>
                        </span>
                        <span
                          className="shrink-0 font-mono text-[10.5px] text-sidebar-foreground/60 tabular-nums"
                          title={
                            v.starsLabel === "—"
                              ? undefined
                              : `Stars · ${v.starsLabel}`
                          }
                        >
                          {v.starsLabel}
                        </span>
                      </>
                    ) : null}
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </nav>
      ) : authSignedIn ? (
        !compactRail ? (
          <p className="px-3 py-2 text-sidebar-foreground/55 text-[11px] leading-snug">
            Open a repository page to build your recent list.
          </p>
        ) : null
      ) : !compactRail ? (
        <p className="px-3 py-2 text-sidebar-foreground/45 text-[11px] leading-snug">
          Sign in to track repos you browse.
        </p>
      ) : null}
    </>
  );
}
