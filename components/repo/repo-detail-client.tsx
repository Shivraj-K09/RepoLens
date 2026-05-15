"use client";

import {
  Code2,
  Clock3,
  GitBranch,
  GitFork,
  Layers3,
  Scale,
  Star,
  Users,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { RepoAiSidebar } from "@/components/repo/repo-ai-sidebar";
import { RepoCodeExplorer } from "@/components/repo/repo-code-explorer";
import { RepoCommitsTab } from "@/components/repo/repo-commits-tab";
import { RepoNotesTab } from "@/components/repo/repo-notes-tab";
import { RepoSummaryTab } from "@/components/repo/repo-summary-tab";
import {
  iconSlugForLabel,
  StatTile,
  TechChip,
} from "@/components/repo/repo-detail-ui";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import type { RepoRootEntry } from "@/lib/github/fetch-repo-root-contents";
import type { GithubRepoInsights } from "@/lib/github/fetch-repo-insights";
import type { RepoTechStackSummary } from "@/lib/github/repo-tech-stack";
import { cn } from "@/lib/utils";

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
  repoInsights: GithubRepoInsights;
  /** Set after indexing (Phase 4); enables RAG chat in the right rail. */
  indexedCommitSha: string | null;
  /** Optional tab requested via URL query (`summary` | `code` | `commits` | `notes` | legacy `overview` | `readme`). */
  initialTab?: string | null;
  /** Optional path to auto-open in code explorer (URL query `path`). */
  initialCodePath?: string | null;
  /** Cached AI Markdown summary when present and not stale. */
  initialAiSummary?: { markdown: string; updatedAt: string } | null;
  canGenerateAiSummary?: boolean;
};

type RepoSectionTab = "summary" | "code" | "commits" | "notes";

function repoSectionTabTriggerClass(tab: RepoSectionTab, activeTab: string) {
  return cn(
    "box-border flex h-10 flex-none! basis-auto! items-center justify-center rounded-none bg-transparent! min-w-0 px-4 py-0! text-[13px] leading-none tracking-tight shadow-none transition-colors",
    "!border-0",
    "after:absolute after:inset-x-4 after:bottom-0 after:z-10 after:h-0.5 after:translate-y-[-1px] after:rounded-none after:transition-opacity",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
    activeTab === tab
      ? "cursor-default font-semibold text-foreground after:bg-foreground after:opacity-100"
      : "cursor-pointer font-medium text-muted-foreground after:bg-transparent after:opacity-0 hover:text-foreground/90",
  );
}

/** Repo surface — Overview (metadata + tech) · Code explorer · README. */
export function RepoDetailClient(props: RepoDetailClientProps) {
  const starsText =
    typeof props.stars === "number" ? props.stars.toLocaleString("en-US") : "—";
  const forksText =
    typeof props.forks === "number" ? props.forks.toLocaleString("en-US") : "—";
  const contributionsText =
    typeof props.repoInsights.contributionsTotal === "number"
      ? props.repoInsights.contributionsTotal.toLocaleString("en-US")
      : "—";
  const lastUpdatedText = props.repoInsights.lastUpdated
    ? new Date(props.repoInsights.lastUpdated).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";
  const techStackItems = useMemo(
    () =>
      props.techStack?.ecosystems.filter((label) => label.trim().length > 0) ??
      [],
    [props.techStack],
  );
  const languageItems = useMemo(
    () =>
      props.repoInsights.languages.filter((label) => label.trim().length > 0) ??
      [],
    [props.repoInsights.languages],
  );
  const hasDescription = Boolean(props.description?.trim());
  const parsedLastUpdated = useMemo(() => {
    if (!props.repoInsights.lastUpdated) return null;
    const d = new Date(props.repoInsights.lastUpdated);
    return Number.isNaN(d.getTime()) ? null : d;
  }, [props.repoInsights.lastUpdated]);
  const hasValidUpdatedAt = parsedLastUpdated != null;
  const homepageText = props.repoInsights.homepageUrl?.trim() || null;
  const techBadges = useMemo(
    () =>
      techStackItems.map((label) => ({ label, slug: iconSlugForLabel(label) })),
    [techStackItems],
  );
  const languageBadges = useMemo(
    () =>
      languageItems.map((label) => ({ label, slug: iconSlugForLabel(label) })),
    [languageItems],
  );

  const [repoViewTab, setRepoViewTab] = useState(() => {
    const t = props.initialTab?.trim().toLowerCase();
    if (t === "code") return "code";
    if (t === "commits") return "commits";
    if (t === "notes") return "notes";
    return "summary";
  });

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden text-left">
      <header className="shrink-0 border-border/65 border-b flex items-center h-14 w-full px-4 md:px-6">
        <div className="flex w-full min-w-0 items-center justify-between gap-3">
          <h1 className="min-w-0 flex-1 truncate font-medium text-[14px] text-foreground tracking-tight">
            <span className="text-muted-foreground">{props.displayOwner}</span>
            <span className="text-muted-foreground/55">/</span>
            <span>{props.displayRepo}</span>
          </h1>

          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent("repo-rag-reindex-request", {
                    detail: {
                      owner: props.routeOwner,
                      repo: props.routeRepo,
                    },
                  }),
                );
              }}
            >
              <GitBranch className="size-3.5" aria-hidden />
              <span>Re-index repo</span>
            </Button>
            {/* <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              aria-label="Bookmark repository"
            >
              <Bookmark className="size-3.5" aria-hidden />
              <span>Bookmark repo</span>
            </Button> */}
          </div>
        </div>
      </header>
      {/* Main content */}
      <div
        className={cn(
          "flex min-h-0 w-full flex-1 flex-col overflow-hidden",
          "lg:flex-row lg:items-stretch",
        )}
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <section className="w-full shrink-0 border-border/65 border-b">
            <div className="flex flex-col gap-3 px-4 py-3 md:px-6 md:py-4 xl:flex-row xl:items-stretch xl:gap-4">
              <div className="min-w-0 flex-1">
                <div className="space-y-3">
                  <div className="flex items-start gap-3 pb-2.5">
                    <Image
                      src={props.avatarUrl}
                      alt=""
                      width={64}
                      height={64}
                      unoptimized
                      className="size-16 shrink-0 rounded-md border border-border/65 object-cover"
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <p className="m-0 truncate font-semibold text-[13.5px] text-foreground leading-snug tracking-tight">
                        {props.displayOwner}/{props.displayRepo}
                      </p>
                      <p className="m-0 text-[12px] text-muted-foreground leading-snug">
                        {hasDescription
                          ? props.description!.trim()
                          : "No description available."}
                      </p>
                      {homepageText ? (
                        <Link
                          href={homepageText}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="m-0 inline-flex w-fit max-w-full truncate text-[12px] leading-snug text-sky-400 underline decoration-sky-400/70 underline-offset-2 hover:text-sky-300"
                          title={homepageText}
                        >
                          {homepageText}
                        </Link>
                      ) : null}
                    </div>
                  </div>

                  <div className="grid gap-2.5 md:grid-cols-2">
                    <div>
                      <p className="mb-1.5 inline-flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                        <Layers3 className="size-3.5" aria-hidden />
                        Tech stack
                      </p>
                      {techStackItems.length > 0 ? (
                        <div className="flex flex-wrap gap-1.25">
                          {techBadges.map((item) => (
                            <TechChip
                              key={item.label}
                              label={item.label}
                              iconSlug={item.slug}
                            />
                          ))}
                        </div>
                      ) : (
                        <p className="text-[11.5px] text-muted-foreground">
                          Not detected.
                        </p>
                      )}
                    </div>

                    <div>
                      <p className="mb-1.5 inline-flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                        <Code2 className="size-3.5" aria-hidden />
                        Languages
                      </p>
                      {languageItems.length > 0 ? (
                        <div className="flex flex-wrap gap-1.25">
                          {languageBadges.map((item) => (
                            <TechChip
                              key={item.label}
                              label={item.label}
                              iconSlug={item.slug}
                            />
                          ))}
                        </div>
                      ) : (
                        <p className="text-[11.5px] text-muted-foreground">
                          Not available.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:w-[390px]">
                <StatTile icon={Star} label="Stars" value={starsText} />
                <StatTile icon={GitFork} label="Forks" value={forksText} />
                <StatTile
                  icon={Users}
                  label="Commits"
                  value={contributionsText}
                />
                <StatTile
                  icon={Scale}
                  label="License"
                  value={props.repoInsights.license ?? "—"}
                />
                <StatTile
                  icon={Clock3}
                  label="Last updated"
                  value={hasValidUpdatedAt ? lastUpdatedText : "—"}
                  className="sm:col-span-2"
                />
              </dl>
            </div>
          </section>

          {/* Tab strip: py controls border-to-border breathing room; tab height stays fixed. */}
          <div className="shrink-0 border-border/65 border-y px-4 py-0.5 md:px-6">
            <Tabs
              value={repoViewTab}
              onValueChange={setRepoViewTab}
              aria-label="Repository sections"
              className="w-full gap-0"
            >
              <TabsList
                variant="line"
                className={cn(
                  "flex h-10 w-fit max-w-full shrink-0 items-center justify-start gap-5",
                  "rounded-none border-0 bg-transparent p-0 shadow-none ring-0",
                )}
              >
                <TabsTrigger
                  value="summary"
                  className={repoSectionTabTriggerClass("summary", repoViewTab)}
                >
                  Summary
                </TabsTrigger>
                <TabsTrigger
                  value="code"
                  className={repoSectionTabTriggerClass("code", repoViewTab)}
                >
                  Code
                </TabsTrigger>
                <TabsTrigger
                  value="commits"
                  className={repoSectionTabTriggerClass("commits", repoViewTab)}
                >
                  Commits
                </TabsTrigger>
                <TabsTrigger
                  value="notes"
                  className={repoSectionTabTriggerClass("notes", repoViewTab)}
                >
                  Notes
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            <div
              className={cn(
                "flex min-h-0 flex-1 flex-col overflow-hidden",
                repoViewTab !== "summary" && "hidden",
              )}
            >
              <RepoSummaryTab
                key={`${props.routeOwner}/${props.routeRepo}`}
                routeOwner={props.routeOwner}
                routeRepo={props.routeRepo}
                topics={props.repoInsights.topics}
                canGenerateAiSummary={props.canGenerateAiSummary ?? false}
                initialAiSummary={props.initialAiSummary ?? null}
              />
            </div>
            <div
              className={cn(
                "flex min-h-0 flex-1 flex-col overflow-hidden",
                repoViewTab !== "code" && "hidden",
              )}
            >
              <RepoCodeExplorer
                routeOwner={props.routeOwner}
                routeRepo={props.routeRepo}
                displayOwner={props.displayOwner}
                displayRepo={props.displayRepo}
                defaultBranch={props.defaultBranch}
                initialRootEntries={props.initialRootEntries}
                initialOpenPath={props.initialCodePath}
              />
            </div>
            <div
              className={cn(
                "flex min-h-0 flex-1 flex-col overflow-hidden",
                repoViewTab !== "commits" && "hidden",
              )}
            >
              <RepoCommitsTab
                routeOwner={props.routeOwner}
                routeRepo={props.routeRepo}
                defaultBranch={props.defaultBranch}
              />
            </div>
            <div
              className={cn(
                "flex min-h-0 flex-1 flex-col overflow-hidden",
                repoViewTab !== "notes" && "hidden",
              )}
            >
              <RepoNotesTab
                routeOwner={props.routeOwner}
                routeRepo={props.routeRepo}
              />
            </div>
          </div>
        </div>

        <RepoAiSidebar
          routeOwner={props.routeOwner}
          routeRepo={props.routeRepo}
          displayOwner={props.displayOwner}
          displayRepo={props.displayRepo}
          indexedCommitSha={props.indexedCommitSha}
        />
      </div>
    </div>
  );
}
