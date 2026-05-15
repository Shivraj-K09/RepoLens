import { fetchGithubRepoReadmeMarkdown } from "@/lib/github/fetch-readme";
import {
  githubListRepoTreePaths,
  type RepoTreePaths,
} from "@/lib/github/repo-tree";

const README_CACHE_TTL_MS = 10 * 60 * 1000;
const readmeCache = new Map<
  string,
  { value: string | null; expiresAt: number }
>();
const REPO_TREE_CACHE_TTL_MS = 2 * 60 * 1000;
const repoTreeCache = new Map<
  string,
  { value: RepoTreePaths | null; expiresAt: number }
>();

export async function fetchCachedReadmeMarkdown(params: {
  owner: string;
  repo: string;
  commitSha: string;
}): Promise<string | null> {
  const key = `${params.owner.toLowerCase()}:${params.repo.toLowerCase()}:${params.commitSha.toLowerCase()}`;
  const now = Date.now();
  const cached = readmeCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  const value = await fetchGithubRepoReadmeMarkdown(
    params.owner,
    params.repo,
    params.commitSha,
  );
  readmeCache.set(key, { value, expiresAt: now + README_CACHE_TTL_MS });
  return value;
}

export async function fetchCachedRepoTreePaths(params: {
  owner: string;
  repo: string;
  commitSha: string;
}): Promise<RepoTreePaths | null> {
  const key = `${params.owner.toLowerCase()}:${params.repo.toLowerCase()}:${params.commitSha.toLowerCase()}`;
  const now = Date.now();
  const cached = repoTreeCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  const value = await githubListRepoTreePaths(
    params.owner,
    params.repo,
    params.commitSha,
  );
  repoTreeCache.set(key, { value, expiresAt: now + REPO_TREE_CACHE_TTL_MS });
  return value;
}

export async function withTimeoutOrFallback<T>(
  promise: Promise<T>,
  fallback: T,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeoutPromise = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), timeoutMs);
    });
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

