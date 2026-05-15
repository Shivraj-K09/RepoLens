"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { SidebarRepoVisit } from "@/lib/supabase/repo-visit-history";
import { cn } from "@/lib/utils";
import { History, Trash2 } from "lucide-react";

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
  const { replace, refresh } = useRouter();
  const queryClient = useQueryClient();
  const historyQueryKey = useMemo(
    () => ["sidebar-repo-history", pathname] as const,
    [pathname],
  );

  const {
    data: visits = initialVisits,
    isFetching: historyLoading,
    error: historyQueryError,
  } = useQuery({
    queryKey: historyQueryKey,
    enabled: authSignedIn,
    placeholderData: (previousData) => previousData ?? initialVisits,
    queryFn: async () => {
      const res = await fetch("/api/repos/history", { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? "Failed to load history");
      }
      const body = (await res.json()) as { visits?: SidebarRepoVisit[] };
      if (!body?.visits) throw new Error("Failed to load history");
      return body.visits;
    },
  });

  const fetchError =
    historyQueryError instanceof Error
      ? historyQueryError.message
      : historyQueryError
        ? String(historyQueryError)
        : null;

  const [deleteError, setDeleteError] = useState<string | null>(null);
  const historyError = fetchError ?? deleteError;
  const [deletingRepoId, setDeletingRepoId] = useState<string | null>(null);
  const [confirmDeleteVisit, setConfirmDeleteVisit] =
    useState<SidebarRepoVisit | null>(null);
  const { state, isMobile } = useSidebar();
  /** Desktop collapsed icon rail — never compact layout inside the mobile sheet. */
  const compactRail = !isMobile && state === "collapsed";

  const repoTooltip = (v: SidebarRepoVisit) =>
    v.starsLabel === "—"
      ? `${v.ownerDisplay}/${v.repoDisplay}`
      : `${v.ownerDisplay}/${v.repoDisplay} · ${v.starsLabel} stars`;

  const deleteHistoryVisit = useCallback(
    async (visit: SidebarRepoVisit) => {
      if (deletingRepoId === visit.id) return;
      const snapshot =
        queryClient.getQueryData<SidebarRepoVisit[]>(historyQueryKey) ??
        visits;
      const isCurrentRepoRoute =
        pathname === visit.href || pathname.startsWith(`${visit.href}/`);

      setDeletingRepoId(visit.id);
      setDeleteError(null);
      queryClient.setQueryData<SidebarRepoVisit[]>(
        historyQueryKey,
        (old) => (old ?? initialVisits).filter((row) => row.id !== visit.id),
      );

      try {
        const response = await fetch("/api/repos/history", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repository_id: visit.id }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(body?.error ?? "Failed to delete history entry");
        }

        if (isCurrentRepoRoute) {
          replace("/");
          refresh();
        }
      } catch (error) {
        queryClient.setQueryData(historyQueryKey, snapshot);
        const message =
          error instanceof Error ? error.message : "Failed to delete history";
        setDeleteError(message);
      } finally {
        setDeletingRepoId(null);
      }
    },
    [
      deletingRepoId,
      pathname,
      refresh,
      replace,
      queryClient,
      historyQueryKey,
      visits,
      initialVisits,
    ],
  );

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

      {authSignedIn && historyLoading && visits.length === 0 ? (
        !compactRail ? (
          <div className="space-y-1 px-2 py-1.5">
            {Array.from({ length: 4 }).map((_, idx) => (
              <div
                key={`history-skeleton-${idx}`}
                className="flex items-center gap-2 rounded-md px-2 py-1.5"
              >
                <Skeleton className="size-6 rounded-md" />
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="ml-auto h-3 w-8" />
              </div>
            ))}
          </div>
        ) : null
      ) : authSignedIn && visits.length > 0 ? (
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
                className={cn(
                  compactRail
                    ? "flex w-full justify-center"
                    : "group/history-row",
                )}
              >
                {!compactRail ? (
                  <div className="flex items-center gap-1 pr-1">
                    <SidebarMenuButton
                      size="sm"
                      asChild
                      tooltip={repoTooltip(v)}
                      className={cn(
                        "size-auto h-auto min-h-10 max-w-none gap-2 py-1.5 text-left text-[12px] leading-snug",
                        "w-full px-2",
                        "transition-colors duration-150",
                        "hover:bg-sidebar-accent/50 active:bg-sidebar-accent/70 dark:hover:bg-sidebar-accent/40 dark:active:bg-sidebar-accent/55 data-[active=true]:bg-sidebar-accent",
                      )}
                    >
                      <Link
                        href={v.href}
                        prefetch={false}
                        className="flex min-w-0 items-center gap-2"
                      >
                        <Image
                          src={v.avatarUrl}
                          alt=""
                          width={24}
                          height={24}
                          unoptimized
                          className="size-6 min-h-6 min-w-6 shrink-0 rounded-md border border-sidebar-border bg-sidebar object-cover"
                        />
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
                      </Link>
                    </SidebarMenuButton>
                    <button
                      type="button"
                      className={cn(
                        "inline-flex size-7 items-center justify-center rounded-md text-destructive/80 transition-colors",
                        "hover:bg-destructive/10 hover:text-destructive",
                        "opacity-0 group-hover/history-row:opacity-100 focus-visible:opacity-100",
                      )}
                      aria-label={`Remove ${v.ownerDisplay}/${v.repoDisplay} from history`}
                      title="Remove from history"
                      onClick={() => {
                        setConfirmDeleteVisit(v);
                      }}
                      disabled={deletingRepoId === v.id}
                    >
                      <Trash2
                        className="size-3.5 text-destructive"
                        aria-hidden
                      />
                    </button>
                  </div>
                ) : (
                  <SidebarMenuButton
                    size="sm"
                    asChild
                    tooltip={repoTooltip(v)}
                    className={cn(
                      "size-auto h-auto min-h-10 max-w-none gap-2 py-1.5 text-left text-[12px] leading-snug",
                      // Sidebar sets `group-data-[collapsible=icon]:p-2!` — must override or 24px images crush inside size-8
                      "size-8! min-h-8! min-w-8! max-h-8! max-w-8! justify-center overflow-visible rounded-md border-0 bg-transparent shadow-none ring-0 group-data-[collapsible=icon]:p-0! group-data-[collapsible=icon]:gap-0!",
                      "transition-colors duration-150",
                      "hover:bg-sidebar-accent/50 active:bg-sidebar-accent/70 dark:hover:bg-sidebar-accent/40 dark:active:bg-sidebar-accent/55 data-[active=true]:bg-sidebar-accent",
                    )}
                  >
                    <Link
                      href={v.href}
                      prefetch={false}
                      className="flex size-8 min-h-8 min-w-8 items-center justify-center overflow-visible rounded-md p-0"
                    >
                      <Image
                        src={v.avatarUrl}
                        alt=""
                        width={24}
                        height={24}
                        unoptimized
                        className="size-6 min-h-6 min-w-6 shrink-0 rounded-md border border-sidebar-border bg-sidebar object-cover"
                      />
                    </Link>
                  </SidebarMenuButton>
                )}
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
      {!compactRail && historyError ? (
        <p className="px-3 py-1 text-[11px] text-destructive leading-snug">
          {historyError}
        </p>
      ) : null}
      <AlertDialog
        open={confirmDeleteVisit !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDeleteVisit(null);
        }}
      >
        <AlertDialogContent className="max-w-104! gap-0! overflow-hidden! rounded-2xl! border-border/60! p-0! shadow-2xl!">
          <AlertDialogHeader className="gap-2! px-6! pt-6! pb-4! text-left! place-items-start!">
            <AlertDialogTitle className="text-[1.05rem]! font-semibold! tracking-tight!">
              Delete history item?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm! leading-relaxed! text-muted-foreground!">
              {confirmDeleteVisit
                ? `This will remove ${confirmDeleteVisit.ownerDisplay}/${confirmDeleteVisit.repoDisplay} from your recent history.`
                : "This will remove the repository from your recent history."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mx-0! mb-0! rounded-b-2xl! border-t! border-border/60! bg-background! px-6! py-4! sm:justify-end!">
            <AlertDialogCancel
              className="min-w-24! h-10"
              disabled={
                !!confirmDeleteVisit && deletingRepoId === confirmDeleteVisit.id
              }
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="min-w-24! h-10"
              disabled={
                !confirmDeleteVisit || deletingRepoId === confirmDeleteVisit.id
              }
              onClick={(event) => {
                event.preventDefault();
                if (!confirmDeleteVisit) return;
                void deleteHistoryVisit(confirmDeleteVisit).finally(() => {
                  setConfirmDeleteVisit(null);
                });
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
