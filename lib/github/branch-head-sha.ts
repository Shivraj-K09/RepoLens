import { createOctokit } from "@/lib/github/octokit";

/** Resolves `refs/heads/{branch}` to a commit SHA, or `null` if missing / detached edge cases. */
export async function fetchBranchHeadSha(
  owner: string,
  repo: string,
  branch: string,
): Promise<string | null> {
  const trimmed = branch.trim();
  if (!trimmed) return null;

  const octokit = createOctokit();
  try {
    const { data } = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${trimmed}`,
    });
    return typeof data.object?.sha === "string" ? data.object.sha : null;
  } catch {
    return null;
  }
}
