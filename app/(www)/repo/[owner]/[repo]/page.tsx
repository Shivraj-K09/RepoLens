import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { RepoDetailClient } from "@/components/repo/repo-detail-client";
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
    repoRow.stars_count === null ||
    repoRow.forks_count === null ||
    repoRow.default_branch === null;

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

  const shaShort =
    repoRow.last_commit_sha && repoRow.last_commit_sha.length > 7
      ? repoRow.last_commit_sha.slice(0, 7)
      : repoRow.last_commit_sha;

  const metadataPartial =
    repoRow.stars_count === null || repoRow.forks_count === null;

  const [readmeMarkdown, rootEntries] = await Promise.all([
    fetchGithubRepoReadmeMarkdown(repoRow.github_owner, repoRow.github_repo),
    fetchGithubRepoRootContents(
      repoRow.github_owner,
      repoRow.github_repo,
      repoRow.default_branch,
    ),
  ]);

  const refGithub = repoRow.default_branch?.trim() ?? "";
  const techStack = refGithub
    ? await fetchRepoTechStackSummary(
        repoRow.github_owner,
        repoRow.github_repo,
        refGithub,
        rootEntries,
      )
    : null;

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
      defaultBranch={repoRow.default_branch}
      shaShort={shaShort}
      avatarUrl={gitHubAvatarSrc}
      stars={repoRow.stars_count}
      forks={repoRow.forks_count}
      metadataPartialNote={metadataPartial}
      readmeMarkdown={readmeMarkdown}
      initialRootEntries={rootEntries}
      techStack={techStack}
      indexedCommitSha={repoRow.indexed_commit_sha ?? null}
      initialTab={query.tab}
      initialCodePath={query.path}
    />
  );
}
