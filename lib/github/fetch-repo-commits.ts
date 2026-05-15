import "server-only";

import type { RestEndpointMethodTypes } from "@octokit/rest";

import { createOctokit } from "@/lib/github/octokit";

type ListCommitsResponse =
  RestEndpointMethodTypes["repos"]["listCommits"]["response"];

export type RepoCommitCheckSummary = {
  /** Total check runs returned for this commit. */
  total: number;
  /** Runs that completed with success or skipped (GitHub-like “passed”). */
  passed: number;
  failed: number;
  pending: number;
  state: "success" | "failure" | "pending" | "none";
};

export type RepoCommitListItem = {
  sha: string;
  shaShort: string;
  messageTitle: string;
  authorDisplay: string;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  committedAt: string;
  htmlUrl: string;
  checks: RepoCommitCheckSummary | null;
};

function firstLineMessage(raw: string): string {
  const line = raw.split(/\r?\n/)[0]?.trim() ?? "";
  return line || "(no message)";
}

function aggregateCheckRuns(
  runs: RestEndpointMethodTypes["checks"]["listForRef"]["response"]["data"]["check_runs"],
): RepoCommitCheckSummary | null {
  if (!runs?.length) return null;

  let passed = 0;
  let failed = 0;
  let pending = 0;

  for (const r of runs) {
    if (r.status !== "completed") {
      pending += 1;
      continue;
    }
    const c = r.conclusion;
    if (
      c === "success" ||
      c === "skipped" ||
      c === "neutral"
    ) {
      passed += 1;
    } else if (
      c === "failure" ||
      c === "timed_out" ||
      c === "cancelled" ||
      c === "action_required"
    ) {
      failed += 1;
    } else {
      pending += 1;
    }
  }

  const state: RepoCommitCheckSummary["state"] =
    pending > 0 ? "pending" : failed > 0 ? "failure" : "success";

  return {
    total: runs.length,
    passed,
    failed,
    pending,
    state,
  };
}

async function fetchAllCheckRunsForSha(
  owner: string,
  repo: string,
  sha: string,
): Promise<
  RestEndpointMethodTypes["checks"]["listForRef"]["response"]["data"]["check_runs"]
> {
  const octokit = createOctokit();
  const out: NonNullable<
    RestEndpointMethodTypes["checks"]["listForRef"]["response"]["data"]["check_runs"]
  > = [];
  for (let page = 1; page <= 10; page += 1) {
    const { data } = await octokit.rest.checks.listForRef({
      owner,
      repo,
      ref: sha,
      per_page: 100,
      page,
    });
    const runs = data.check_runs ?? [];
    out.push(...runs);
    if (runs.length < 100) break;
  }
  return out;
}

function aggregateCommitStatuses(
  statuses:
    | RestEndpointMethodTypes["repos"]["getCombinedStatusForRef"]["response"]["data"]["statuses"]
    | null
    | undefined,
): {
  total: number;
  passed: number;
  failed: number;
  pending: number;
} | null {
  if (!statuses?.length) return null;
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const s of statuses) {
    const st = s.state;
    if (st === "success") passed += 1;
    else if (st === "failure" || st === "error") failed += 1;
    else pending += 1;
  }
  return { total: statuses.length, passed, failed, pending };
}

function mergeCheckAndStatusSummaries(
  checks: RepoCommitCheckSummary | null,
  statusParts: {
    total: number;
    passed: number;
    failed: number;
    pending: number;
  } | null,
): RepoCommitCheckSummary | null {
  if (!checks && !statusParts) return null;
  const passed = (checks?.passed ?? 0) + (statusParts?.passed ?? 0);
  const failed = (checks?.failed ?? 0) + (statusParts?.failed ?? 0);
  const pending = (checks?.pending ?? 0) + (statusParts?.pending ?? 0);
  const total = (checks?.total ?? 0) + (statusParts?.total ?? 0);
  if (total <= 0) return null;
  const state: RepoCommitCheckSummary["state"] =
    pending > 0 ? "pending" : failed > 0 ? "failure" : "success";
  return { total, passed, failed, pending, state };
}

/**
 * GitHub Actions → Check Runs API; Vercel and many CIs → Commit Statuses API.
 * Merge both so counts match github.com/comparison for typical setups.
 */
async function fetchCiSummaryForSha(
  owner: string,
  repo: string,
  sha: string,
): Promise<RepoCommitCheckSummary | null> {
  const octokit = createOctokit();
  try {
    const [runs, statuses] = await Promise.all([
      fetchAllCheckRunsForSha(owner, repo, sha).catch(() => []),
      octokit.rest.repos
        .getCombinedStatusForRef({ owner, repo, ref: sha })
        .then((r) => r.data.statuses ?? [])
        .catch(() => []),
    ]);
    const checkAgg = aggregateCheckRuns(runs);
    const statusParts = aggregateCommitStatuses(statuses);
    return mergeCheckAndStatusSummaries(checkAgg, statusParts);
  } catch {
    return null;
  }
}

async function mapPool<T, R>(
  items: readonly T[],
  poolSize: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let next = 0;

  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  };

  const n = Math.min(poolSize, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

function parseLinkNext(linkHeader: string | undefined): boolean {
  if (!linkHeader) return false;
  return /rel="next"/.test(linkHeader);
}

function mapCommitRow(
  owner: string,
  repo: string,
  row: ListCommitsResponse["data"][number],
  checks: RepoCommitCheckSummary | null,
): RepoCommitListItem {
  const sha = row.sha;
  const commit = row.commit;
  const author = row.author;
  const msg = commit?.message ?? "";
  const nameFromCommit = commit?.author?.name?.trim();
  const login = author?.login?.trim() || null;
  const committedAt =
    commit?.author?.date ??
    commit?.committer?.date ??
    new Date().toISOString();

  return {
    sha,
    shaShort: sha.length > 7 ? sha.slice(0, 7) : sha,
    messageTitle: firstLineMessage(msg),
    authorDisplay: login ?? nameFromCommit ?? "Unknown",
    authorLogin: login,
    authorAvatarUrl: author?.avatar_url ?? null,
    committedAt,
    htmlUrl:
      row.html_url ??
      `https://github.com/${owner}/${repo}/commit/${sha}`,
    checks,
  };
}

export type FetchRepoCommitsPageResult = {
  commits: RepoCommitListItem[];
  hasMore: boolean;
};

/**
 * One page of commits for a ref (branch or SHA), with CI summarized per commit via
 * {@link https://docs.github.com/en/rest/checks/runs Check runs} plus
 * {@link https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference combined commit statuses}
 * (e.g. Vercel) merged together.
 */
export async function fetchRepoCommitsPage(
  owner: string,
  repo: string,
  options: {
    /** Branch or commit SHA; omit or null uses repo default branch on GitHub. */
    ref?: string | null;
    page: number;
    perPage: number;
    /** Parallel `checks.listForRef` calls per page (capped). */
    checkConcurrency?: number;
  },
): Promise<FetchRepoCommitsPageResult | null> {
  const page = Math.max(1, Math.floor(options.page));
  const perPage = Math.min(50, Math.max(1, Math.floor(options.perPage)));
  const ref = options.ref?.trim() || undefined;
  const checkConcurrency = Math.min(
    8,
    Math.max(1, options.checkConcurrency ?? 4),
  );

  const octokit = createOctokit();
  let response: ListCommitsResponse;
  try {
    response = await octokit.rest.repos.listCommits({
      owner,
      repo,
      ...(ref ? { sha: ref } : {}),
      per_page: perPage,
      page,
    });
  } catch (e) {
    console.warn("[fetchRepoCommitsPage] listCommits failed:", e);
    return null;
  }

  const rows = response.data;
  const hasMore = parseLinkNext(response.headers.link);

  const shas = rows.map((r) => r.sha);
  const checkResults = await mapPool(shas, checkConcurrency, (sha) =>
    fetchCiSummaryForSha(owner, repo, sha),
  );

  const commits = rows.map((row, i) =>
    mapCommitRow(owner, repo, row, checkResults[i] ?? null),
  );

  return { commits, hasMore };
}
