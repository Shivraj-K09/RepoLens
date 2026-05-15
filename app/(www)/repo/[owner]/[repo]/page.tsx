import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { RepoDetailClient } from "@/components/repo/repo-detail-client";
import {
  fetchFreshRepoAiSummaryRow,
  selectInitialAiSummaryPayload,
} from "@/lib/ai/ensure-repo-ai-summary-cached";
import { fetchGithubRepoInsights } from "@/lib/github/fetch-repo-insights";
import { fetchGithubRepoMetadataPatch } from "@/lib/github/fetch-repo-metadata";
import { fetchGithubRepoReadmeMarkdown } from "@/lib/github/fetch-readme";
import { fetchGithubRepoRootContents } from "@/lib/github/fetch-repo-root-contents";
import { fetchRepoTechStackSummary } from "@/lib/github/repo-tech-stack";
import { recordRepositoryVisit } from "@/lib/supabase/repo-visit-history";
import { createClient } from "@/lib/supabase/server";

type RepoDetailPageProps = {
  params: Promise<{ owner: string; repo: string }>;
  searchParams?: Promise<{ tab?: string; path?: string }>;
};

function normalizeRepoTab(tab: string | undefined): string | undefined {
  const t = tab?.trim().toLowerCase();
  if (!t) return undefined;
  if (t === "overview" || t === "readme") return "summary";
  return t;
}

export async function generateMetadata({
  params,
}: RepoDetailPageProps): Promise<Metadata> {
  const { owner, repo } = await params;
  const title = `${owner}/${repo}`;
  return {
    title,
    description: `Repository overview and chat for ${owner}/${repo}.`,
  };
}

export default async function RepoDetailPage({
  params,
  searchParams,
}: RepoDetailPageProps) {
  const { owner: routeOwner, repo: routeRepo } = await params;
  const ownerSlug = routeOwner.toLowerCase();
  const repoSlug = routeRepo.toLowerCase();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <div className="px-6 py-8 md:px-10">
        <p className="max-w-md text-muted-foreground text-[13px] leading-relaxed">
          Sign in to open repositories here.
        </p>
      </div>
    );
  }

  const query = searchParams !== undefined ? (await searchParams) ?? {} : {};

  let { data: repoRow } = await supabase
    .from("repositories")
    .select(
      "id, github_owner, github_repo, html_url, description, default_branch, stars_count, forks_count, last_commit_sha, indexed_commit_sha",
    )
    .eq("user_id", user.id)
    .eq("github_owner_norm", ownerSlug)
    .eq("github_repo_norm", repoSlug)
    .maybeSingle();

  if (!repoRow) {
    notFound();
  }

  const incomplete =
    !repoRow.description ||
    !repoRow.html_url ||
    repoRow.stars_count === null ||
    repoRow.forks_count === null ||
    !repoRow.default_branch?.trim();

  if (incomplete) {
    const patch = await fetchGithubRepoMetadataPatch(
      repoRow.github_owner,
      repoRow.github_repo,
    );
    if (patch) {
      const { data: refreshed } = await supabase
        .from("repositories")
        .update(patch)
        .eq("id", repoRow.id)
        .select(
          "id, github_owner, github_repo, html_url, description, default_branch, stars_count, forks_count, last_commit_sha, indexed_commit_sha",
        )
        .single();
      if (refreshed) {
        repoRow = refreshed;
      }
    }
  }

  const dbDefaultBranch = repoRow.default_branch?.trim() || null;

  const shaShort =
    repoRow.last_commit_sha && repoRow.last_commit_sha.length > 7
      ? repoRow.last_commit_sha.slice(0, 7)
      : repoRow.last_commit_sha;

  const [readmeMarkdown, rootEntries, repoInsights] = await Promise.all([
    fetchGithubRepoReadmeMarkdown(repoRow.github_owner, repoRow.github_repo),
    fetchGithubRepoRootContents(
      repoRow.github_owner,
      repoRow.github_repo,
      dbDefaultBranch,
    ),
    fetchGithubRepoInsights(repoRow.github_owner, repoRow.github_repo),
  ]);

  const resolvedDefaultBranch =
    dbDefaultBranch || repoInsights.defaultBranch?.trim() || null;

  let finalRootEntries = rootEntries;
  if (!dbDefaultBranch && resolvedDefaultBranch) {
    finalRootEntries = await fetchGithubRepoRootContents(
      repoRow.github_owner,
      repoRow.github_repo,
      resolvedDefaultBranch,
    );
  }

  const starsDisplay =
    typeof repoRow.stars_count === "number"
      ? repoRow.stars_count
      : repoInsights.stars;
  const forksDisplay =
    typeof repoRow.forks_count === "number"
      ? repoRow.forks_count
      : repoInsights.forks;

  const metadataPartial =
    (typeof starsDisplay !== "number" &&
      typeof repoInsights.stars !== "number") ||
    (typeof forksDisplay !== "number" &&
      typeof repoInsights.forks !== "number");

  const refGithub = resolvedDefaultBranch ?? "";
  const techStack = refGithub
    ? await fetchRepoTechStackSummary(
        repoRow.github_owner,
        repoRow.github_repo,
        refGithub,
        finalRootEntries,
      )
    : null;

  const backfill: Record<string, string | number> & { updated_at?: string } = {};
  if (!dbDefaultBranch && resolvedDefaultBranch) {
    backfill.default_branch = resolvedDefaultBranch;
  }
  if (
    repoRow.stars_count === null &&
    typeof repoInsights.stars === "number"
  ) {
    backfill.stars_count = repoInsights.stars;
  }
  if (
    repoRow.forks_count === null &&
    typeof repoInsights.forks === "number"
  ) {
    backfill.forks_count = repoInsights.forks;
  }
  if (Object.keys(backfill).length > 0) {
    backfill.updated_at = new Date().toISOString();
    void supabase.from("repositories").update(backfill).eq("id", repoRow.id);
  }

  const summaryRow = await fetchFreshRepoAiSummaryRow(
    supabase,
    ownerSlug,
    repoSlug,
  );

  const initialAiSummary = selectInitialAiSummaryPayload(
    summaryRow,
    repoRow.last_commit_sha,
  );

  const canGenerateAiSummary = Boolean(
    process.env.HUGGINGFACE_API_KEY?.trim(),
  );

  await recordRepositoryVisit(supabase, user.id, repoRow.id);

  const gitHubAvatarSrc = `https://github.com/${repoRow.github_owner}.png`;

  return (
    <RepoDetailClient
      routeOwner={routeOwner}
      routeRepo={routeRepo}
      displayOwner={repoRow.github_owner}
      displayRepo={repoRow.github_repo}
      htmlUrl={repoRow.html_url}
      description={repoRow.description}
      defaultBranch={resolvedDefaultBranch}
      shaShort={shaShort}
      avatarUrl={gitHubAvatarSrc}
      stars={starsDisplay}
      forks={forksDisplay}
      metadataPartialNote={metadataPartial}
      readmeMarkdown={readmeMarkdown}
      initialRootEntries={finalRootEntries}
      techStack={techStack}
      repoInsights={repoInsights}
      indexedCommitSha={repoRow.indexed_commit_sha ?? null}
      initialTab={normalizeRepoTab(query.tab)}
      initialCodePath={query.path}
      initialAiSummary={initialAiSummary}
      canGenerateAiSummary={canGenerateAiSummary}
    />
  );
}
