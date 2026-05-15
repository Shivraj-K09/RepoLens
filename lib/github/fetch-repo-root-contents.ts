import {
  githubListRepoPathContents,
} from "@/lib/github/repo-path";

export type RepoRootEntry =
  | { kind: "dir"; name: string; path: string }
  | { kind: "file"; name: string; path: string }
  | { kind: "submodule"; name: string; path: string };

/**
 * Lists top-level paths at the repo root for {@param ref}
 * (GitHub “Code” directory table).
 */
export async function fetchGithubRepoRootContents(
  owner: string,
  repo: string,
  ref: string | null,
): Promise<RepoRootEntry[] | null> {
  const trimmed = ref?.trim();
  if (!trimmed) return null;

  const listed = await githubListRepoPathContents(owner, repo, trimmed, "");
  if (listed === null) return null;
  if (listed === "not-a-directory") return null;
  return listed;
}
