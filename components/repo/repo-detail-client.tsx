"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import {
  FolderGit,
  GitBranch,
  GitFork,
  Star,
  ExternalLink,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";

import { RepoOverviewContent } from "@/components/repo/repo-overview";
import { Sidebar, SidebarContent } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";

import type { RepoRootEntry } from "@/lib/github/fetch-repo-root-contents";
import type { RepoTechStackSummary } from "@/lib/github/repo-tech-stack";

import { cn } from "@/lib/utils";

const REPO_STAT_LOCALE = "en-US";

const RepoFileExplorer = dynamic(
  () =>
    import("@/components/repo/repo-file-explorer").then(
      (m) => m.RepoFileExplorer,
    ),
  {
    loading: () => (
      <div className="p-3.5">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="mt-2 h-56 w-full" />
      </div>
    ),
  },
);

const RepoReadme = dynamic(
  () => import("@/components/repo/repo-readme").then((m) => m.RepoReadme),
  {
    loading: () => (
      <div className="space-y-3 p-1">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-10/12" />
      </div>
    ),
  },
);

const RepoRagChat = dynamic(
  () => import("@/components/repo/repo-rag-chat").then((m) => m.RepoRagChat),
  {
    loading: () => (
      <div className="space-y-2 p-3">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    ),
  },
);

function RepoDetailTabButton({
  label,
  active,
  onPick,
}: {
  label: string;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onPick}
      className={cn(
        "-mb-px shrink-0 border-transparent border-b-[1.5px] pb-2 font-medium transition-colors",
        "text-[12.5px] tracking-tight",
        active
          ? "border-foreground text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground/90",
      )}
    >
      {label}
    </button>
  );
}

export type RepoDetailClientProps = {
  routeOwner: string;
  routeRepo: string;
  displayOwner: string;
  displayRepo: string;
  htmlUrl: string | null;
  description: string | null;
  defaultBranch: string | null;
  shaShort: string | null | undefined;
  avatarUrl: string;
  stars: number | null;
  forks: number | null;
  metadataPartialNote: boolean;
  readmeMarkdown: string | null;
  initialRootEntries: RepoRootEntry[] | null;
  techStack: RepoTechStackSummary | null;
  /** Set after indexing (Phase 4); enables RAG chat in the right rail. */
  indexedCommitSha: string | null;
  /** Optional tab requested via URL query (`overview` | `code` | `readme`). */
  initialTab?: string | null;
  /** Optional path to auto-open in code explorer (URL query `path`). */
  initialCodePath?: string | null;
};

/** Repo surface — Overview (metadata + tech) · Code explorer · README. */
export function RepoDetailClient(props: RepoDetailClientProps) {
  const normalizedInitialTab: "overview" | "code" | "readme" =
    props.initialTab === "readme"
      ? "readme"
      : props.initialTab === "code" || (props.initialCodePath?.trim() ?? "") !== ""
        ? "code"
        : "overview";
  const [tab, setTab] = useState<"overview" | "code" | "readme">(
    normalizedInitialTab,
  );
  const refBranch =
    props.defaultBranch?.trim() !== "" ? props.defaultBranch!.trim() : "";
  const initialCodePath = (props.initialCodePath ?? "").trim() || null;
  const [openPathRequest, setOpenPathRequest] = useState(() => ({
    path: initialCodePath,
    requestId: 1,
  }));

  useEffect(() => {
    queueMicrotask(() => {
      setTab(normalizedInitialTab);
    });
  }, [normalizedInitialTab]);

  useEffect(() => {
    const pathFromQuery = (props.initialCodePath ?? "").trim();
    if (!pathFromQuery) return;
    queueMicrotask(() => {
      setOpenPathRequest((prev) => ({
        path: pathFromQuery,
        requestId: prev.requestId + 1,
      }));
    });
  }, [props.initialCodePath]);

  useEffect(() => {
    const onRepoOpenPath = (event: Event) => {
      const custom = event as CustomEvent<{
        owner?: string;
        repo?: string;
        path?: string;
      }>;
      const owner = custom.detail?.owner?.toLowerCase() ?? "";
      const repo = custom.detail?.repo?.toLowerCase() ?? "";
      const path = custom.detail?.path?.trim() ?? "";
      if (!owner || !repo || !path) return;
      if (
        owner !== props.routeOwner.toLowerCase() ||
        repo !== props.routeRepo.toLowerCase()
      ) {
        return;
      }
      setTab("code");
      setOpenPathRequest((prev) => ({
        path,
        requestId: prev.requestId + 1,
      }));
    };

    window.addEventListener("repo-open-path", onRepoOpenPath);
    return () => window.removeEventListener("repo-open-path", onRepoOpenPath);
  }, [props.routeOwner, props.routeRepo]);

  const stats = useMemo(() => {
    const st =
      props.stars != null ? props.stars.toLocaleString(REPO_STAT_LOCALE) : "-";
    const fk =
      props.forks != null ? props.forks.toLocaleString(REPO_STAT_LOCALE) : "-";
    return { stars: st, forks: fk };
  }, [props.forks, props.stars]);

  return (
    <div
      className={cn(
        "flex h-full min-h-0 w-full flex-col overflow-hidden text-left",
        "lg:flex-row lg:items-stretch",
      )}
    >
      <div className="scrollbar-hide flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto pb-14 lg:pb-6">
        <header className="border-border/65 border-b px-6 py-4 md:px-8 lg:py-5">
          <div className="flex items-start gap-3">
            <Image
              src={props.avatarUrl}
              alt=""
              width={32}
              height={32}
              unoptimized
              className="size-8 shrink-0 rounded-md border border-border/65 bg-muted object-cover"
            />
            <div className="min-w-0 flex-1 space-y-2.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.25">
                <div className="flex min-w-0 items-center gap-1 font-medium text-[14px] text-foreground leading-tight tracking-tight">
                  <span className="text-muted-foreground/85">
                    <FolderGit
                      aria-hidden
                      strokeWidth={1.75}
                      className="size-[14px] shrink-0"
                    />
                  </span>
                  <h1 className="wrap-break-word truncate">
                    <span className="font-normal text-muted-foreground">
                      {props.displayOwner}
                    </span>
                    <span className="text-muted-foreground/55">/</span>
                    <span>{props.displayRepo}</span>
                  </h1>
                </div>
                {props.htmlUrl ? (
                  <Link
                    href={props.htmlUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex shrink-0 items-center gap-1 text-muted-foreground text-[11.75px] underline decoration-border underline-offset-[3px] hover:text-foreground"
                  >
                    <ExternalLink
                      aria-hidden
                      strokeWidth={1.75}
                      className="size-3 opacity-85"
                    />
                    GitHub
                  </Link>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.75 text-[11.85px] text-muted-foreground">
                <div className="inline-flex items-center gap-1.25">
                  <Star
                    aria-hidden
                    strokeWidth={1.7}
                    className="size-3 shrink-0 opacity-80"
                  />
                  <span className="sr-only">Stars</span>
                  <span className="font-medium tabular-nums text-foreground">
                    {stats.stars}
                  </span>
                </div>
                <span aria-hidden className="opacity-35">
                  ·
                </span>
                <div className="inline-flex items-center gap-1.25">
                  <GitFork
                    aria-hidden
                    strokeWidth={1.7}
                    className="size-3 shrink-0 opacity-80"
                  />
                  <span className="sr-only">Forks</span>
                  <span className="font-medium tabular-nums text-foreground">
                    {stats.forks}
                  </span>
                </div>
                <span aria-hidden className="opacity-35">
                  ·
                </span>
                <div className="inline-flex items-center gap-1.25">
                  <GitBranch
                    aria-hidden
                    strokeWidth={1.7}
                    className="size-3 shrink-0 opacity-80"
                  />
                  <span className="sr-only">Default branch</span>
                  <span className="font-mono font-medium text-[11px] text-foreground opacity-92">
                    {props.defaultBranch ?? "-"}
                  </span>
                </div>
                <span aria-hidden className="opacity-35">
                  ·
                </span>
                <div className="inline-flex items-center gap-1.25 font-mono text-[11px]">
                  <span className="text-muted-foreground">HEAD</span>
                  <span className="sr-only">HEAD commit</span>
                  <span className="text-foreground/90">
                    {props.shaShort ?? "-"}
                  </span>
                </div>
              </div>

              <div
                className="-mb-[1px] mt-4 flex gap-8 border-border/65 border-t pt-3.5"
                role="tablist"
                aria-orientation="horizontal"
              >
                <RepoDetailTabButton
                  label="Overview"
                  active={tab === "overview"}
                  onPick={() => setTab("overview")}
                />
                <RepoDetailTabButton
                  label="Code"
                  active={tab === "code"}
                  onPick={() => setTab("code")}
                />
                <RepoDetailTabButton
                  label="Readme"
                  active={tab === "readme"}
                  onPick={() => setTab("readme")}
                />
              </div>
            </div>
          </div>
        </header>

        {tab === "overview" ? (
          <RepoOverviewContent
            displayOwner={props.displayOwner}
            displayRepo={props.displayRepo}
            description={props.description}
            defaultBranch={props.defaultBranch}
            shaShort={props.shaShort}
            htmlUrl={props.htmlUrl}
            starsText={stats.stars}
            forksText={stats.forks}
            metadataPartialNote={props.metadataPartialNote}
            techStack={props.techStack}
          />
        ) : null}

        {tab !== "overview" ? (
          <div className="px-6 py-5 md:px-8 lg:pb-7 lg:pt-6">
            {tab === "code" ? (
              <div className="w-full overflow-hidden rounded-lg border border-border/55 bg-background">
                {!refBranch ? (
                  <p className="px-3 py-4 text-muted-foreground text-[12px] leading-relaxed">
                    Default branch unavailable: revisit after GitHub metadata
                    loads or set{" "}
                    <code className="font-mono text-foreground">
                      GITHUB_TOKEN
                    </code>{" "}
                    for private API access.
                  </p>
                ) : (
                  <>
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-border/50 border-b bg-muted/[0.1] px-3 py-1.75 text-muted-foreground text-[11px] lg:gap-x-2.5 lg:px-3.25">
                      <GitBranch
                        aria-hidden
                        strokeWidth={1.7}
                        className="size-3"
                      />
                      <span className="font-mono text-foreground text-[11.25px]">
                        {props.defaultBranch ?? "-"}
                      </span>
                      <span aria-hidden className="opacity-45">
                        ·
                      </span>
                      <span className="font-mono text-[11px] opacity-80">
                        {props.shaShort ?? "-"}
                      </span>
                    </div>
                    <RepoFileExplorer
                      routeOwner={props.routeOwner}
                      routeRepo={props.routeRepo}
                      refBranch={refBranch}
                      initialRootEntries={props.initialRootEntries}
                      initialOpenPath={openPathRequest.path}
                      initialOpenPathRequestId={openPathRequest.requestId}
                    />
                  </>
                )}
              </div>
            ) : (
              <div className="w-full rounded-lg border border-border/55 bg-background px-3.5 pb-10 pt-4 md:px-4 lg:pb-12">
                {props.readmeMarkdown ? (
                  <RepoReadme
                    markdown={props.readmeMarkdown}
                    githubOwner={props.displayOwner}
                    githubRepo={props.displayRepo}
                    defaultBranch={props.defaultBranch}
                  />
                ) : (
                  <p className="max-w-xl text-muted-foreground text-[12px] leading-relaxed">
                    No README was returned. For private repos, configure{" "}
                    <code className="font-mono text-[11px] text-foreground">
                      GITHUB_TOKEN
                    </code>{" "}
                    on the server so Octokit can read repository content.
                  </p>
                )}
              </div>
            )}
          </div>
        ) : null}
      </div>

      {/*
        Main column scrolls; rail is sibling with fixed width so height matches the shell,
        not the active tab (Overview vs Code).
        Uses shadcn Sidebar (collapsible=none) + sidebar tokens to align with the left app rail.
      */}
      <Sidebar
        aria-label="Repository AI chat"
        data-repo-ai-rail="true"
        side="right"
        collapsible="none"
        className={cn(
          "flex min-h-0 shrink-0 flex-col overflow-hidden border-border text-foreground",
          "h-[min(22rem,52dvh)] w-full border-t",
          "lg:h-full lg:min-h-0 lg:w-[min(26.25rem,100%)] lg:border-t-0 lg:border-l",
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
    </div>
  );
}
