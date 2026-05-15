"use client";

import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { RepoStreamdownMarkdown } from "@/components/repo/repo-streamdown-markdown";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatTimestampUtcEnUS } from "@/lib/format-utc-timestamp";
import { cn } from "@/lib/utils";

export type RepoSummaryTabProps = {
  routeOwner: string;
  routeRepo: string;
  topics: readonly string[];
  canGenerateAiSummary: boolean;
  initialAiSummary: { markdown: string; updatedAt: string } | null;
};

async function postAiSummary(
  routeOwner: string,
  routeRepo: string,
): Promise<{ markdown: string; updatedAt: string }> {
  const res = await fetch(
    `/api/repos/${encodeURIComponent(routeOwner)}/${encodeURIComponent(routeRepo)}/ai-summary`,
    { method: "POST" },
  );
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : "Could not load overview.";
    throw new Error(msg);
  }
  const raw =
    body &&
    typeof body === "object" &&
    "summary" in body &&
    (body as { summary: unknown }).summary;
  const s =
    raw &&
    typeof raw === "object" &&
    "markdown" in raw &&
    typeof (raw as { markdown: unknown }).markdown === "string" &&
    "updatedAt" in raw &&
    typeof (raw as { updatedAt: unknown }).updatedAt === "string"
      ? (raw as { markdown: string; updatedAt: string })
      : null;
  if (!s) {
    throw new Error("Invalid response.");
  }
  return s;
}

export function RepoSummaryTab(props: RepoSummaryTabProps) {
  const needsClientFetch =
    props.canGenerateAiSummary && props.initialAiSummary == null;

  const [clientSummary, setClientSummary] = useState<{
    markdown: string;
    updatedAt: string;
  } | null>(null);
  const [fetchDone, setFetchDone] = useState(() => !needsClientFetch);
  const [error, setError] = useState<string | null>(null);

  const summary = clientSummary ?? props.initialAiSummary;
  const loading = needsClientFetch && !fetchDone;

  useEffect(() => {
    if (!needsClientFetch) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const s = await postAiSummary(props.routeOwner, props.routeRepo);
        if (!cancelled) {
          setClientSummary(s);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Could not load overview.");
        }
      } finally {
        if (!cancelled) {
          setFetchDone(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [needsClientFetch, props.routeOwner, props.routeRepo]);

  const retry = useCallback(async () => {
    if (!props.canGenerateAiSummary) return;
    setError(null);
    setFetchDone(false);
    try {
      const s = await postAiSummary(props.routeOwner, props.routeRepo);
      setClientSummary(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load overview.");
    } finally {
      setFetchDone(true);
    }
  }, [props.canGenerateAiSummary, props.routeOwner, props.routeRepo]);

  const overviewUpdatedLabel = summary?.updatedAt
    ? formatTimestampUtcEnUS(summary.updatedAt)
    : null;

  const hasTopicsAbove = props.topics.length > 0;
  const mainBlockClass = cn(
    hasTopicsAbove && "border-border/20 border-t pt-3.5",
    !hasTopicsAbove && "pt-0",
  );

  return (
    <div
      className={cn(
        "scrollbar-hide flex min-h-0 flex-1 flex-col overflow-y-auto",
        "px-4 py-4 md:px-6 md:py-5",
      )}
    >
      <div className="repo-summary-overview rounded-xl bg-muted/25 px-3 py-3 md:px-4 md:py-4">
        {hasTopicsAbove ? (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {props.topics.map((t) => (
              <span
                key={t}
                className="rounded-md bg-muted/40 px-2 py-0.5 text-[10.5px] text-muted-foreground"
              >
                {t}
              </span>
            ))}
          </div>
        ) : null}

        {!props.canGenerateAiSummary ? (
          <p className="text-[13px] text-muted-foreground leading-relaxed">
            Overview is not available in this environment. Use the{" "}
            <span className="text-foreground">Code</span> tab or the header
            above for repository context.
          </p>
        ) : loading ? (
          <div className={cn("space-y-2", mainBlockClass)}>
            <Skeleton className="h-4 w-full bg-muted/50" />
            <Skeleton className="h-4 max-w-[92%] bg-muted/50" />
            <Skeleton className="h-4 w-full bg-muted/50" />
            <Skeleton className="h-20 w-full bg-muted/50" />
            <p className="flex items-center gap-1.5 pt-1 text-[12px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              Loading…
            </p>
          </div>
        ) : error ? (
          <div className={cn("space-y-2", mainBlockClass)}>
            <p className="text-[13px] text-destructive leading-relaxed">
              {error}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              onClick={retry}
            >
              Retry
            </Button>
          </div>
        ) : summary?.markdown ? (
          <div className={mainBlockClass}>
            <RepoStreamdownMarkdown markdown={summary.markdown} />
            {overviewUpdatedLabel ? (
              <p className="mt-3 text-[10.5px] text-muted-foreground">
                Last updated {overviewUpdatedLabel}{" "}
                <span className="opacity-75">(UTC)</span>
              </p>
            ) : null}
          </div>
        ) : (
          <p
            className={cn(
              "text-[13px] text-muted-foreground",
              mainBlockClass,
            )}
          >
            No overview yet.
          </p>
        )}
      </div>
    </div>
  );
}
