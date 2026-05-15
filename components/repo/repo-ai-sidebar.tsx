"use client";

import dynamic from "next/dynamic";
import type { CSSProperties } from "react";

import { Sidebar, SidebarContent } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

const RepoRagChat = dynamic(
  () => import("@/components/repo/repo-rag-chat").then((m) => m.RepoRagChat),
  {
    loading: () => (
      <div className="space-y-2 p-3">
        <div className="h-8 w-full animate-pulse rounded-md bg-muted/40" />
        <div className="h-24 w-full animate-pulse rounded-md bg-muted/30" />
        <div className="h-24 w-full animate-pulse rounded-md bg-muted/30" />
      </div>
    ),
  },
);

export type RepoAiSidebarProps = {
  routeOwner: string;
  routeRepo: string;
  displayOwner: string;
  displayRepo: string;
  indexedCommitSha: string | null;
  className?: string;
};

/**
 * Right-hand repository AI rail (shadcn Sidebar + {@link RepoRagChat}).
 */
export function RepoAiSidebar(props: RepoAiSidebarProps) {
  return (
    <Sidebar
      aria-label="Repository AI chat"
      data-repo-ai-rail="true"
      side="right"
      collapsible="none"
      className={cn(
        "flex min-h-0 shrink-0 flex-col overflow-hidden border-border text-foreground",
        "h-[min(22rem,52dvh)] w-full border-t",
        "lg:h-full lg:min-h-0 lg:w-[min(26.25rem,100%)] lg:border-t-0 lg:border-l",
        props.className,
      )}
      style={
        {
          ["--sidebar-width" as string]: "min(26.25rem, 100%)",
        } as CSSProperties
      }
    >
      <SidebarContent className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden p-0">
        <RepoRagChat
          routeOwner={props.routeOwner}
          routeRepo={props.routeRepo}
          displayOwner={props.displayOwner}
          displayRepo={props.displayRepo}
          indexedCommitSha={props.indexedCommitSha}
          className="min-h-0"
        />
      </SidebarContent>
    </Sidebar>
  );
}
