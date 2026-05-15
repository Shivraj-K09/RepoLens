import { createOctokit } from "@/lib/github/octokit";

function isHttpNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: number }).status === 404
  );
}

function rawReadmeToString(data: unknown): string | null {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof Uint8Array) {
    return new TextDecoder("utf-8").decode(data);
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder("utf-8").decode(data);
  }
  return null;
}

/**
 * Root README.md / README.rst etc. resolved by GitHub (usually markdown).
 * Pass {@param ref} to pin a branch/commit/tag (defaults to default branch).
 */
export async function fetchGithubRepoReadmeMarkdown(
  owner: string,
  repo: string,
  ref?: string | null,
): Promise<string | null> {
  const octokit = createOctokit();
  const trimmedRef = ref?.trim();

  try {
    const { data } = await octokit.rest.repos.getReadme({
      owner,
      repo,
      ...(trimmedRef ? { ref: trimmedRef } : {}),
      mediaType: {
        format: "raw",
      },
    });

    const text = rawReadmeToString(data);
    return text ?? null;
  } catch (err) {
    if (isHttpNotFound(err)) {
      return null;
    }
    console.warn("[fetchGithubRepoReadmeMarkdown]", err);
    return null;
  }
}
