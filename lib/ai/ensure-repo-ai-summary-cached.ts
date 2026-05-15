import "server-only";

import { getHuggingFaceChatModelId } from "@/lib/ai/config";
import {
  excerptReadme,
  generateRepoAiSummaryMarkdown,
  type RepoAiSummaryInput,
} from "@/lib/ai/generate-repo-ai-summary-markdown";
import { fetchGithubRepoReadmeMarkdown } from "@/lib/github/fetch-readme";
import { fetchGithubRepoRootContents } from "@/lib/github/fetch-repo-root-contents";
import { fetchGithubRepoInsights } from "@/lib/github/fetch-repo-insights";
import { fetchRepoTechStackSummary } from "@/lib/github/repo-tech-stack";
import type { createClient } from "@/lib/supabase/server";

type SupabaseServer = Awaited<ReturnType<typeof createClient>>;

type SummaryCacheRow = {
  summary_markdown: string;
  updated_at: string;
  source_commit_sha: string | null;
  prompt_version: number | null;
};

/** Increment when overview instructions change materially (invalidates cached Markdown). */
export const REPO_SUMMARY_PROMPT_VERSION = 6;

export function isRepoSummaryCacheStale(
  row: Pick<SummaryCacheRow, "source_commit_sha" | "prompt_version"> | null,
  lastCommitSha: string | null,
): boolean {
  if (!row) return true;
  const stalePrompt =
    row.prompt_version == null ||
    row.prompt_version < REPO_SUMMARY_PROMPT_VERSION;
  if (stalePrompt) return true;
  if (!lastCommitSha || !row.source_commit_sha) return false;
  return row.source_commit_sha !== lastCommitSha;
}

export type EnsureRepoAiSummaryParams = {
  supabase: SupabaseServer;
  githubOwner: string;
  githubRepo: string;
  lastCommitSha: string | null;
  description: string | null;
  defaultBranch: string | null;
  stars: number | null;
  forks: number | null;
};

export async function ensureRepoAiSummaryCached(
  params: EnsureRepoAiSummaryParams,
): Promise<{ markdown: string; updatedAt: string; fromCache: boolean }> {
  const ownerNorm = params.githubOwner.toLowerCase();
  const repoNorm = params.githubRepo.toLowerCase();

  const { data: existing, error: selErr } = await params.supabase
    .from("repository_ai_summaries")
    .select("summary_markdown, updated_at, source_commit_sha, prompt_version")
    .eq("github_owner_norm", ownerNorm)
    .eq("github_repo_norm", repoNorm)
    .maybeSingle();

  if (selErr) {
    console.warn("[repo-ai-summary] cache select:", selErr.message);
  }

  if (existing && !isRepoSummaryCacheStale(existing, params.lastCommitSha)) {
    return {
      markdown: existing.summary_markdown,
      updatedAt: existing.updated_at,
      fromCache: true,
    };
  }

  if (!process.env.HUGGINGFACE_API_KEY?.trim()) {
    throw new Error("AI summary requires HUGGINGFACE_API_KEY.");
  }

  const insights = await fetchGithubRepoInsights(
    params.githubOwner,
    params.githubRepo,
  );
  const gitHead = insights.defaultBranchHeadSha ?? params.lastCommitSha ?? null;

  if (existing && !isRepoSummaryCacheStale(existing, gitHead)) {
    return {
      markdown: existing.summary_markdown,
      updatedAt: existing.updated_at,
      fromCache: true,
    };
  }

  const ref =
    insights.defaultBranch?.trim() || params.defaultBranch?.trim() || "";

  const [readme, rootEntries] = await Promise.all([
    fetchGithubRepoReadmeMarkdown(
      params.githubOwner,
      params.githubRepo,
      ref || undefined,
    ),
    ref
      ? fetchGithubRepoRootContents(params.githubOwner, params.githubRepo, ref)
      : Promise.resolve(null),
  ]);

  const techStack = ref
    ? await fetchRepoTechStackSummary(
        params.githubOwner,
        params.githubRepo,
        ref,
        rootEntries,
      )
    : null;

  const languageMixLine =
    insights.languageShare.length > 0
      ? insights.languageShare.map((l) => `${l.name} ${l.percent}%`).join(", ")
      : null;

  const input: RepoAiSummaryInput = {
    owner: params.githubOwner,
    repo: params.githubRepo,
    description: insights.description ?? params.description,
    defaultBranch: insights.defaultBranch ?? params.defaultBranch,
    readmeExcerpt: excerptReadme(readme),
    techStackLabels: techStack?.ecosystems ?? [],
    languageLabels: insights.languages,
    languageMixLine,
    topics: insights.topics,
    license: insights.license,
  };

  const markdown = await generateRepoAiSummaryMarkdown(input);
  const modelId = getHuggingFaceChatModelId();
  const nowIso = new Date().toISOString();

  const { error: upErr } = await params.supabase
    .from("repository_ai_summaries")
    .upsert(
      {
        github_owner_norm: ownerNorm,
        github_repo_norm: repoNorm,
        summary_markdown: markdown,
        source_commit_sha: gitHead,
        model_id: modelId,
        updated_at: nowIso,
        prompt_version: REPO_SUMMARY_PROMPT_VERSION,
      },
      { onConflict: "github_owner_norm,github_repo_norm" },
    );

  if (upErr) {
    throw new Error(upErr.message);
  }

  return { markdown, updatedAt: nowIso, fromCache: false };
}

export async function fetchFreshRepoAiSummaryRow(
  supabase: SupabaseServer,
  ownerNorm: string,
  repoNorm: string,
): Promise<SummaryCacheRow | null> {
  const { data, error } = await supabase
    .from("repository_ai_summaries")
    .select("summary_markdown, updated_at, source_commit_sha, prompt_version")
    .eq("github_owner_norm", ownerNorm)
    .eq("github_repo_norm", repoNorm)
    .maybeSingle();

  if (error) {
    console.warn("[repo-ai-summary] cache read:", error.message);
    return null;
  }
  if (!data) {
    return null;
  }

  return data as SummaryCacheRow;
}

export function selectInitialAiSummaryPayload(
  row: SummaryCacheRow | null,
  lastCommitSha: string | null,
): { markdown: string; updatedAt: string } | null {
  if (!row) return null;
  if (isRepoSummaryCacheStale(row, lastCommitSha)) return null;
  return { markdown: row.summary_markdown, updatedAt: row.updated_at };
}
