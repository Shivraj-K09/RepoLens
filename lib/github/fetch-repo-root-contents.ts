import {
  githubListRepoPathContents,
} from "@/lib/github/repo-path";

const ROOT_CONTENTS_CACHE_TTL_MS = 3 * 60 * 1000;
const rootContentsCache = new Map<
  string,
  { value: RepoRootEntry[] | null; expiresAt: number }
>();
const rootContentsInflight = new Map<string, Promise<RepoRootEntry[] | null>>();

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

  const key = `${owner.toLowerCase()}/${repo.toLowerCase()}@${trimmed.toLowerCase()}`;
  const now = Date.now();
  const cached = rootContentsCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  const inflight = rootContentsInflight.get(key);
  if (inflight) return inflight;

  const task = (async () => {
    const listed = await githubListRepoPathContents(owner, repo, trimmed, "");
    if (listed === null) return null;
    if (listed === "not-a-directory") return null;
    return listed;
  })();

  rootContentsInflight.set(key, task);
  try {
    const value = await task;
    rootContentsCache.set(key, {
      value,
      expiresAt: Date.now() + ROOT_CONTENTS_CACHE_TTL_MS,
    });
    return value;
  } finally {
    rootContentsInflight.delete(key);
  }
}
