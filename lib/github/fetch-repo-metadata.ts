import { createOctokit } from "@/lib/github/octokit";

/** Columns on `public.repositories` we hydrate from GitHub’s REST API (`repos.get` + branch ref). */
export type GithubRepoMetadataDbPatch = {
  github_owner: string;
  github_repo: string;
  html_url: string | null;
  description: string | null;
  default_branch: string | null;
  stars_count: number | null;
  forks_count: number | null;
  last_commit_sha: string | null;
  updated_at: string;
};

function isHttpNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: number }).status === 404
  );
}

/**
 * Fetches canonical repo metadata from GitHub for persistence in Supabase.
 * Returns `null` if the repo is missing or the request fails (caller keeps baseline row).
 */
export async function fetchGithubRepoMetadataPatch(
  owner: string,
  repo: string,
): Promise<GithubRepoMetadataDbPatch | null> {
  const octokit = createOctokit();

  try {
    const { data } = await octokit.rest.repos.get({ owner, repo });

    const apiOwner = data.owner.login;
    const apiRepo = data.name;
    const branch = data.default_branch ?? null;

    let lastCommitSha: string | null = null;
    if (branch) {
      try {
        const { data: ref } = await octokit.rest.git.getRef({
          owner: apiOwner,
          repo: apiRepo,
          ref: `heads/${branch}`,
        });
        lastCommitSha =
          ref.object?.sha && typeof ref.object.sha === "string"
            ? ref.object.sha
            : null;
      } catch (refErr) {
        if (!isHttpNotFound(refErr)) {
          console.warn("[fetchGithubRepoMetadataPatch] getRef failed:", refErr);
        }
      }
    }

    const updated_at = new Date().toISOString();

    return {
      github_owner: apiOwner,
      github_repo: apiRepo,
      html_url: data.html_url ?? null,
      description: data.description ?? null,
      default_branch: branch,
      stars_count:
        typeof data.stargazers_count === "number"
          ? data.stargazers_count
          : null,
      forks_count:
        typeof data.forks_count === "number" ? data.forks_count : null,
      last_commit_sha: lastCommitSha,
      updated_at,
    };
  } catch (err) {
    if (isHttpNotFound(err)) {
      return null;
    }
    console.warn("[fetchGithubRepoMetadataPatch] repos.get failed:", err);
    return null;
  }
}
