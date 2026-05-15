"use client";

import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  XCircle,
} from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { formatRelativeTimeEn } from "@/lib/format-relative-en";
import { cn } from "@/lib/utils";

type CommitCheckPayload = {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  state: "success" | "failure" | "pending" | "none";
};

type CommitPayload = {
  sha: string;
  shaShort: string;
  messageTitle: string;
  authorDisplay: string;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  committedAt: string;
  htmlUrl: string;
  checks: CommitCheckPayload | null;
};

function startOfLocalDayMs(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function dayLabelForCommit(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown date";
  const now = new Date();
  const today = startOfLocalDayMs(now);
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  const yesterday = startOfLocalDayMs(y);
  const c = startOfLocalDayMs(d);
  if (c === today) return "Today";
  if (c === yesterday) return "Yesterday";
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" as const } : {}),
  });
}

function groupCommitsByCalendarDay(
  list: CommitPayload[],
): { label: string; items: CommitPayload[] }[] {
  const groups: { label: string; items: CommitPayload[] }[] = [];
  for (const c of list) {
    const label = dayLabelForCommit(c.committedAt);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(c);
    else groups.push({ label, items: [c] });
  }
  return groups;
}

function ChecksBadge({ checks }: { checks: CommitCheckPayload | null }) {
  if (!checks || checks.total === 0) {
    return (
      <span className="text-[11px] tabular-nums text-muted-foreground">—</span>
    );
  }

  const label = `${checks.passed}/${checks.total}`;

  const icon =
    checks.state === "failure" ? (
      <XCircle className="size-3.5 shrink-0 text-destructive" aria-hidden />
    ) : checks.state === "pending" ? (
      <Loader2
        className="size-3.5 shrink-0 animate-spin text-muted-foreground"
        aria-hidden
      />
    ) : (
      <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500/85" aria-hidden />
    );

  return (
    <span
      className="inline-flex max-w-full items-center gap-1 text-[11px] tabular-nums text-muted-foreground"
      title={
        checks.pending > 0
          ? `${checks.passed} passed · ${checks.pending} pending · ${checks.failed} failed (${checks.total} checks)`
          : `${checks.passed} passed · ${checks.failed} failed (${checks.total} checks)`
      }
    >
      {icon}
      <span className="truncate text-foreground/90">{label}</span>
    </span>
  );
}

export type RepoCommitsTabProps = {
  routeOwner: string;
  routeRepo: string;
  defaultBranch: string | null;
};

export function RepoCommitsTab(props: RepoCommitsTabProps) {
  const [commits, setCommits] = useState<CommitPayload[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ref = props.defaultBranch?.trim() || null;

  const grouped = useMemo(() => groupCommitsByCalendarDay(commits), [commits]);

  const load = useCallback(
    async (nextPage: number, append: boolean) => {
      const base = `/api/repos/${encodeURIComponent(props.routeOwner)}/${encodeURIComponent(props.routeRepo)}/commits`;
      const q = new URLSearchParams();
      q.set("page", String(nextPage));
      q.set("per_page", "20");
      if (ref) q.set("ref", ref);

      const res = await fetch(`${base}?${q.toString()}`, { method: "GET" });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          body &&
          typeof body === "object" &&
          "error" in body &&
          typeof (body as { error: unknown }).error === "string"
            ? (body as { error: string }).error
            : "Could not load commits.";
        throw new Error(msg);
      }
      const rawCommits =
        body &&
        typeof body === "object" &&
        "commits" in body &&
        Array.isArray((body as { commits: unknown }).commits)
          ? (body as { commits: CommitPayload[] }).commits
          : null;
      if (!rawCommits) {
        throw new Error("Invalid response.");
      }
      const hm =
        body &&
        typeof body === "object" &&
        "hasMore" in body &&
        typeof (body as { hasMore: unknown }).hasMore === "boolean"
          ? (body as { hasMore: boolean }).hasMore
          : false;

      if (append) {
        setCommits((c) => [...c, ...rawCommits]);
      } else {
        setCommits(rawCommits);
      }
      setHasMore(hm);
      setPage(nextPage);
    },
    [props.routeOwner, props.routeRepo, ref],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        await load(1, false);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Could not load commits.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const onLoadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      await load(page + 1, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load more.");
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, load, loadingMore, page]);

  return (
    <div
      className={cn(
        "scrollbar-hide flex min-h-0 flex-1 flex-col overflow-y-auto bg-background",
        "px-4 py-3 md:px-6 md:py-4",
      )}
    >
      <div className="w-full min-w-0 space-y-4">
        {error ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p className="leading-snug">{error}</p>
          </div>
        ) : null}

        {loading ? (
          <div className="space-y-6">
            {Array.from({ length: 3 }).map((_, gi) => (
              <div key={gi}>
                <div className="mb-2 h-3 w-24 animate-pulse rounded bg-muted/35" />
                <div className="space-y-4">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="animate-pulse space-y-2 py-1">
                      <div className="h-3 w-[min(100%,28rem)] rounded bg-muted/35" />
                      <div className="h-2.5 w-36 rounded bg-muted/25" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : commits.length === 0 ? (
          <p className="py-10 text-center text-[13px] text-muted-foreground">
            No commits found.
          </p>
        ) : (
          <div className="space-y-6">
            {grouped.map((group, groupIndex) => (
              <section
                key={group.label}
                aria-label={group.label}
                className={cn(groupIndex > 0 && "pt-2")}
              >
                <h2 className="py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </h2>
                <ul className="mt-0">
                  {group.items.map((c) => (
                    <li key={c.sha}>
                      <a
                        href={c.htmlUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="flex flex-col gap-2 rounded-md px-3 py-3 transition-colors hover:bg-muted/15 sm:px-4 md:flex-row md:items-center md:justify-between md:gap-4 md:py-3.5"
                      >
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <p className="line-clamp-2 text-[13px] font-medium leading-snug text-foreground">
                            {c.messageTitle}
                          </p>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                            <span className="inline-flex items-center gap-1.5">
                              {c.authorAvatarUrl ? (
                                <Image
                                  src={c.authorAvatarUrl}
                                  alt=""
                                  width={18}
                                  height={18}
                                  unoptimized
                                  className="size-[18px] shrink-0 rounded-full"
                                />
                              ) : (
                                <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-muted/50 text-[9px] font-semibold text-foreground/80">
                                  {(c.authorDisplay || "?")
                                    .slice(0, 1)
                                    .toUpperCase()}
                                </span>
                              )}
                              <span className="font-medium text-foreground/90">
                                {c.authorDisplay}
                              </span>
                              {c.authorLogin &&
                              c.authorLogin !== c.authorDisplay ? (
                                <span className="opacity-75">
                                  @{c.authorLogin}
                                </span>
                              ) : null}
                            </span>
                            <span aria-hidden className="text-border">
                              ·
                            </span>
                            <span title={c.committedAt}>
                              {formatRelativeTimeEn(c.committedAt)}
                            </span>
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-row items-center gap-3 md:flex-col md:items-end md:gap-1">
                          <ChecksBadge checks={c.checks} />
                          <code className="font-mono text-[11px] text-muted-foreground tabular-nums">
                            {c.shaShort}
                          </code>
                        </div>
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        {!loading && hasMore ? (
          <div className="flex justify-center pb-2 pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 gap-1.5"
              disabled={loadingMore}
              onClick={onLoadMore}
            >
              {loadingMore ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  <span>Loading…</span>
                </>
              ) : (
                "Older commits"
              )}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
