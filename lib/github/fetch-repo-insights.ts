import { createOctokit } from "@/lib/github/octokit";

const INSIGHTS_CACHE_TTL_MS = 3 * 60 * 1000;
const CONTRIBUTOR_PAGE_SIZE = 100;
const CONTRIBUTOR_PAGE_CAP = 10;

export type LanguageShare = {
  name: string;
  /** Percent of total bytes in analyzed languages (0–100, one decimal). */
  percent: number;
};

export type GithubRepoInsights = {
  languages: string[];
  /** Language mix by GitHub byte counts (top entries). */
  languageShare: LanguageShare[];
  /** GitHub repository topics (max 12). */
  topics: readonly string[];
  license: string | null;
  homepageUrl: string | null;
  contributionsTotal: number | null;
  lastUpdated: string | null;
  /** GitHub `size` field: kilobytes of repo contents (not disk equivalent). */
  sizeKb: number | null;
  /** From `GET /repos/{owner}/{repo}` (Octokit `repos.get`). */
  description: string | null;
  defaultBranch: string | null;
  stars: number | null;
  forks: number | null;
  /** Tip SHA of the default branch (`refs/heads/{defaultBranch}`) when resolved. */
  defaultBranchHeadSha: string | null;
};

type CacheValue = {
  value: GithubRepoInsights;
  expiresAt: number;
};

const insightsCache = new Map<string, CacheValue>();
const insightsInflight = new Map<string, Promise<GithubRepoInsights>>();

function normalizeLicense(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value || value.toUpperCase() === "NOASSERTION") return null;
  return value;
}

function normalizeHomepageUrl(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

function sortLanguagesByBytes(
  input: Record<string, number> | null | undefined,
): string[] {
  if (!input) return [];
  return Object.entries(input)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name)
    .slice(0, 8);
}

function languageSharesFromBytes(
  input: Record<string, number> | null | undefined,
  max = 8,
): LanguageShare[] {
  if (!input) return [];
  const entries = Object.entries(input).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, bytes]) => s + bytes, 0);
  if (total <= 0) return [];
  return entries.slice(0, max).map(([name, bytes]) => ({
    name,
    percent: Math.round((bytes / total) * 1000) / 10,
  }));
}

function normalizeTopics(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    .map((t) => t.trim())
    .slice(0, 12);
}

async function fetchContributionsTotal(
  owner: string,
  repo: string,
): Promise<number | null> {
  const octokit = createOctokit();
  let total = 0;

  try {
    for (let page = 1; page <= CONTRIBUTOR_PAGE_CAP; page += 1) {
      const { data } = await octokit.rest.repos.listContributors({
        owner,
        repo,
        per_page: CONTRIBUTOR_PAGE_SIZE,
        page,
      });
      if (!Array.isArray(data) || data.length === 0) break;

      for (const contributor of data) {
        if (typeof contributor.contributions === "number") {
          total += contributor.contributions;
        }
      }
      if (data.length < CONTRIBUTOR_PAGE_SIZE) break;
    }
    return total > 0 ? total : 0;
  } catch {
    return null;
  }
}

export async function fetchGithubRepoInsights(
  owner: string,
  repo: string,
): Promise<GithubRepoInsights> {
  const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const now = Date.now();

  const cached = insightsCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  const inflight = insightsInflight.get(key);
  if (inflight) return inflight;

  const task = (async (): Promise<GithubRepoInsights> => {
    const octokit = createOctokit();

    const [repoResult, langsResult, contributionsTotal] = await Promise.all([
      octokit.rest.repos
        .get({ owner, repo })
        .then((res) => res.data)
        .catch(() => null),
      octokit.rest.repos
        .listLanguages({ owner, repo })
        .then((res) => res.data)
        .catch(() => null),
      fetchContributionsTotal(owner, repo),
    ]);

    const defaultBranch =
      typeof repoResult?.default_branch === "string"
        ? repoResult.default_branch.trim() || null
        : null;

    let defaultBranchHeadSha: string | null = null;
    if (defaultBranch) {
      try {
        const { data: ref } = await octokit.rest.git.getRef({
          owner,
          repo,
          ref: `heads/${defaultBranch}`,
        });
        defaultBranchHeadSha =
          ref.object?.sha && typeof ref.object.sha === "string"
            ? ref.object.sha
            : null;
      } catch {
        defaultBranchHeadSha = null;
      }
    }

    const sizeRaw = repoResult?.size;
    const sizeKb =
      typeof sizeRaw === "number" && Number.isFinite(sizeRaw) ? sizeRaw : null;

    return {
      languages: sortLanguagesByBytes(langsResult ?? undefined),
      languageShare: languageSharesFromBytes(langsResult ?? undefined),
      topics: normalizeTopics(repoResult?.topics),
      license: normalizeLicense(repoResult?.license?.spdx_id ?? null),
      homepageUrl: normalizeHomepageUrl(repoResult?.homepage ?? null),
      contributionsTotal,
      lastUpdated: repoResult?.pushed_at ?? repoResult?.updated_at ?? null,
      sizeKb,
      description:
        typeof repoResult?.description === "string"
          ? repoResult.description.trim() || null
          : null,
      defaultBranch,
      stars:
        typeof repoResult?.stargazers_count === "number"
          ? repoResult.stargazers_count
          : null,
      forks:
        typeof repoResult?.forks_count === "number"
          ? repoResult.forks_count
          : null,
      defaultBranchHeadSha,
    };
  })();

  insightsInflight.set(key, task);
  try {
    const value = await task;
    insightsCache.set(key, {
      value,
      expiresAt: Date.now() + INSIGHTS_CACHE_TTL_MS,
    });
    return value;
  } finally {
    insightsInflight.delete(key);
  }
}
