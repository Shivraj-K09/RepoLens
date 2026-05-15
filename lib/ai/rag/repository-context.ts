import "server-only";

import type { createClient } from "@/lib/supabase/server";
import { createOctokit } from "@/lib/github/octokit";
import {
  githubListRepoPathContents,
  githubReadRepoFileUtf8,
  normalizeRepoContentPath,
} from "@/lib/github/repo-path";

import { fetchCachedRepoTreePaths } from "./cache";
import { scorePathWithHints } from "./query-hints";

type SupabaseServer = Awaited<ReturnType<typeof createClient>>;

const REPO_SIGNAL_CACHE_TTL_MS = 5 * 60 * 1000;
const repoSignalCache = new Map<string, { value: string; expiresAt: number }>();

function parsePackageJsonSignals(packageText: string): string[] {
  try {
    const parsed = JSON.parse(packageText) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const scriptNames = Object.keys(parsed.scripts ?? {}).sort().slice(0, 12);
    const deps = Object.keys(parsed.dependencies ?? {}).sort().slice(0, 16);
    const devDeps = Object.keys(parsed.devDependencies ?? {}).sort().slice(0, 12);
    const lines: string[] = [];
    if (scriptNames.length > 0) {
      lines.push(`- package scripts: ${scriptNames.join(", ")}`);
    }
    if (deps.length > 0) {
      lines.push(`- runtime dependencies (sample): ${deps.join(", ")}`);
    }
    if (devDeps.length > 0) {
      lines.push(`- dev dependencies (sample): ${devDeps.join(", ")}`);
    }
    return lines;
  } catch {
    return [];
  }
}

export type RepositoryMetadataSnapshot = {
  github_owner: string;
  github_repo: string;
  description: string | null;
  default_branch: string | null;
  stars_count: number | null;
  forks_count: number | null;
  last_commit_sha: string | null;
  html_url: string | null;
};

export function buildRepositoryMetadataContext(
  row: RepositoryMetadataSnapshot | null,
): string {
  if (!row) return "";
  const lines: string[] = [];
  lines.push(`- canonical repository: ${row.github_owner}/${row.github_repo}`);
  if (row.description?.trim()) {
    lines.push(`- repository description: ${row.description.trim()}`);
  }
  if (row.default_branch?.trim()) {
    lines.push(`- default branch: ${row.default_branch.trim()}`);
  }
  if (row.last_commit_sha?.trim()) {
    lines.push(`- latest known commit: ${row.last_commit_sha.trim()}`);
  }
  if (typeof row.stars_count === "number") {
    lines.push(`- stars: ${row.stars_count}`);
  }
  if (typeof row.forks_count === "number") {
    lines.push(`- forks: ${row.forks_count}`);
  }
  if (row.html_url?.trim()) {
    lines.push(`- upstream URL: ${row.html_url.trim()}`);
  }
  if (lines.length === 0) return "";
  return ["Repository metadata (Octokit-sourced snapshot):", ...lines].join("\n");
}

const RAG_AI_SUMMARY_MAX_CHARS = 14_000;
const GITHUB_FACTS_PAGE_SIZE = 100;
const GITHUB_FACTS_DISPLAY_LIMIT = 30;
const RECENT_COMMITS_DEFAULT_LIMIT = 30;
const RECENT_COMMITS_DATE_LIMIT = 100;

function capNote(label: string, count: number, cap: number): string {
  return count >= cap
    ? `- ${label}: showing first ${cap}; there may be more on GitHub`
    : `- ${label}: ${count}`;
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function formatDateTimePartsInTimeZone(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour");
  const minute = get("minute");
  if (!year || !month || !day || !hour || !minute) return "";
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function formatDatePartsInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  if (!year || !month || !day) return "";
  return `${year}-${month}-${day}`;
}

function targetLocalDateForCommitQuestion(
  question: string,
  timeZone: string,
): string | null {
  const q = question.toLowerCase();
  const now = new Date();
  if (/\byesterday\b/.test(q)) {
    return formatDatePartsInTimeZone(
      new Date(now.getTime() - 24 * 60 * 60 * 1000),
      timeZone,
    );
  }
  if (/\btoday\b/.test(q)) {
    return formatDatePartsInTimeZone(now, timeZone);
  }
  const explicit = q.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  return explicit?.[1] ?? null;
}

function wantsCommitCount(question: string): boolean {
  const q = question.toLowerCase();
  return /\b(how many|count|number of|total)\b/.test(q) && /\bcommits?\b/.test(q);
}

function commitQuestionAsksForDetail(question: string): boolean {
  const q = question.toLowerCase();
  return (
    /\bcommits?\b/.test(q) &&
    /\b(info|information|details?|about|tell me|explain|what changed|changes?|files?|diff|first|last|latest|oldest|earliest)\b/.test(
      q,
    )
  );
}

function extractCommitShaPrefix(question: string): string | null {
  const match = question.match(/\b[0-9a-f]{7,40}\b/i);
  return match?.[0]?.toLowerCase() ?? null;
}

function prefersOldestCommit(question: string): boolean {
  return /\b(first|oldest|earliest|initial)\b/i.test(question);
}

function prefersNewestCommit(question: string): boolean {
  return /\b(last|latest|newest|most recent)\b/i.test(question);
}

function firstLine(raw: string | null | undefined): string {
  const line = raw?.split(/\r?\n/)[0]?.trim() ?? "";
  return line || "(no message)";
}

function compactText(value: string, maxChars: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxChars) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxChars - 12)).trimEnd()} [truncated]`;
}

function parsePackageDependencies(packageText: string): {
  name: string;
  section: string;
}[] {
  try {
    const parsed = JSON.parse(packageText) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    return [
      ...Object.keys(parsed.dependencies ?? {}).map((name) => ({
        name,
        section: "dependencies",
      })),
      ...Object.keys(parsed.devDependencies ?? {}).map((name) => ({
        name,
        section: "devDependencies",
      })),
      ...Object.keys(parsed.optionalDependencies ?? {}).map((name) => ({
        name,
        section: "optionalDependencies",
      })),
    ].sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function evidenceTermsFromQuestion(question: string, keywordHints: string[]): string[] {
  const q = question.toLowerCase();
  const extras: string[] = [];
  for (const match of q.matchAll(/\b(?:use|uses|using|with|for|where is|where are|defines?|implementation|implemented)\s+([a-z0-9][a-z0-9._-]{2,})\b/g)) {
    const term = match[1]?.trim();
    if (term) extras.push(term);
  }
  const noisy = new Set([
    "repo",
    "repository",
    "uses",
    "using",
    "used",
    "where",
    "implementation",
    "implemented",
    "defines",
    "define",
    "file",
    "paths",
    "path",
    "present",
    "evidence",
    "verifiable",
    "authentication",
    "deployment",
    "queue",
  ]);
  const terms = [...keywordHints, ...extras]
    .map((term) => term.toLowerCase().replace(/[^a-z0-9._/-]/g, ""))
    .filter((term) => term.length >= 3 && !noisy.has(term));
  return [...new Set(terms)].slice(0, 8);
}

function termMatchesText(text: string, terms: string[]): boolean {
  const normalized = text.toLowerCase();
  const compressed = normalized.replace(/[-_/.\s]/g, "");
  return terms.some((term) => {
    const t = term.toLowerCase();
    if (!t) return false;
    if (normalized.includes(t)) return true;
    const tc = t.replace(/[-_/.\s]/g, "");
    return tc.length >= 3 && compressed.includes(tc);
  });
}

function matchingEvidenceLines(text: string, terms: string[]): string[] {
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), index: index + 1 }))
    .filter((row) => row.line.length > 0 && termMatchesText(row.line, terms))
    .slice(0, 8)
    .map((row) => `  - line ${row.index}: ${compactText(row.line, 220)}`);
}

function summarizeFileContentForDirectory(path: string, text: string): string {
  const exports = [
    ...text.matchAll(
      /\bexport\s+(?:async\s+)?(?:function|const|class|type|interface)\s+([A-Za-z0-9_]+)/g,
    ),
  ]
    .map((match) => String(match[1] ?? "").trim())
    .filter(Boolean)
    .slice(0, 8);
  const firstUsefulLine =
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(
        (line) =>
          line.length > 0 &&
          !line.startsWith("import ") &&
          !line.startsWith("export type") &&
          !line.startsWith("//"),
      ) ?? "";
  const parts = [
    `- ${path}`,
    exports.length > 0 ? `exports: ${exports.join(", ")}` : "",
    firstUsefulLine ? `signal: ${compactText(firstUsefulLine, 180)}` : "",
  ].filter(Boolean);
  return parts.join(" — ");
}

function wantsContributorFacts(question: string): boolean {
  const q = question.toLowerCase();
  return /\b(contributors?|contributed|contributions?|committer|author|authors?|who\s+(?:made|did|has|contributed)|most\s+(?:commits?|contributions?))\b/.test(
    q,
  );
}

function wantsRepoMetadataFacts(question: string): boolean {
  const q = question.toLowerCase();
  return (
    /\b(repo|repository)\b.*\b(details?|info|information|metadata|stats?|statistics|overview|health)\b/.test(
      q,
    ) ||
    /\b(stars?|forks?|watchers?|license|language|languages|topics?|size|visibility|created|updated|pushed|default branch)\b/.test(
      q,
    )
  );
}

function wantsBranchTagReleaseFacts(question: string): boolean {
  const q = question.toLowerCase();
  return /\b(branches?|tags?|releases?|versions?)\b/.test(q);
}

function wantsIssuePullFacts(question: string): boolean {
  const q = question.toLowerCase();
  return /\b(issues?|bugs?|pull requests?|prs?|merge requests?)\b/.test(q);
}

function wantsWorkflowFacts(question: string): boolean {
  const q = question.toLowerCase();
  return /\b(ci|checks?|workflows?|github actions?|actions|builds?|deployments?)\b/.test(
    q,
  );
}

function wantsCommitActivityFacts(question: string): boolean {
  const q = question.toLowerCase();
  return /\b(commits?|committers?|activity|recent changes?|latest changes?|history|today|yesterday)\b/.test(
    q,
  );
}

function wantsBroadGitHubFacts(question: string): boolean {
  const q = question.toLowerCase();
  return (
    /\b(all|everything|full|complete|overall)\b.*\b(repo|repository|github|details?|info|information|stats?|statistics|activity)\b/.test(
      q,
    ) ||
    /\b(repo|repository)\b.*\b(all|everything|full|complete)\b/.test(q)
  );
}

function shouldBuildGitHubFacts(question: string): boolean {
  const q = question.toLowerCase();
  return (
    wantsBroadGitHubFacts(question) ||
    wantsContributorFacts(question) ||
    wantsRepoMetadataFacts(question) ||
    wantsBranchTagReleaseFacts(question) ||
    wantsIssuePullFacts(question) ||
    wantsWorkflowFacts(question) ||
    wantsCommitActivityFacts(question) ||
    /\b(github|octokit|data sources?|context|passes? to (?:the )?(?:ai|model)|rag api)\b/.test(
      q,
    )
  );
}

function section(title: string, lines: string[]): string {
  const clean = lines.filter((line) => line.trim().length > 0);
  if (clean.length === 0) return "";
  return [title, ...clean].join("\n");
}

/**
 * Cached repo overview Markdown from `repository_ai_summaries` (same source as Summary tab).
 */
export async function buildCachedRepositoryAiSummaryContext(
  supabase: SupabaseServer,
  ownerNorm: string,
  repoNorm: string,
): Promise<string> {
  const { data, error } = await supabase
    .from("repository_ai_summaries")
    .select("summary_markdown, updated_at")
    .eq("github_owner_norm", ownerNorm.toLowerCase())
    .eq("github_repo_norm", repoNorm.toLowerCase())
    .maybeSingle();

  if (error || !data?.summary_markdown?.trim()) {
    return "";
  }
  const md = data.summary_markdown.trim();
  const excerpt =
    md.length > RAG_AI_SUMMARY_MAX_CHARS
      ? `${md.slice(0, RAG_AI_SUMMARY_MAX_CHARS)}\n\n[truncated]`
      : md;
  const updated =
    typeof data.updated_at === "string" && data.updated_at.trim()
      ? data.updated_at.trim()
      : "";
  return [
    "Repository overview (cached AI Markdown summary for this repo" +
      (updated ? `; last updated ${updated}` : "") +
      "):",
    excerpt,
  ].join("\n");
}

/**
 * Recent commits on the default branch (GitHub `listCommits` only — no per-commit CI calls).
 */
export async function buildRecentCommitsContextLines(params: {
  owner: string;
  repo: string;
  defaultBranch: string | null;
  question?: string;
  maxCommits?: number;
  timeZone?: string;
}): Promise<string> {
  const ref = params.defaultBranch?.trim() || undefined;
  const timeZone =
    params.timeZone && isValidTimeZone(params.timeZone)
      ? params.timeZone
      : "UTC";
  const targetDate = params.question
    ? targetLocalDateForCommitQuestion(params.question, timeZone)
    : null;
  const requestedLimit =
    params.maxCommits ??
    (targetDate ? RECENT_COMMITS_DATE_LIMIT : RECENT_COMMITS_DEFAULT_LIMIT);
  const perPage = Math.min(
    RECENT_COMMITS_DATE_LIMIT,
    Math.max(5, Math.floor(requestedLimit)),
  );

  const octokit = createOctokit();
  try {
    const { data } = await octokit.rest.repos.listCommits({
      owner: params.owner,
      repo: params.repo,
      ...(ref ? { sha: ref } : {}),
      per_page: perPage,
      page: 1,
    });
    if (!data?.length) return "";

    const rows = data.map((row) => {
      const msg =
        row.commit?.message?.split(/\r?\n/)[0]?.trim() ?? "(no message)";
      const sha = row.sha.length > 7 ? row.sha.slice(0, 7) : row.sha;
      const who =
        row.author?.login?.trim() ||
        row.commit?.author?.name?.trim() ||
        "?";
      const when = row.commit?.author?.date?.trim() ?? "";
      const localWhen = when
        ? formatDateTimePartsInTimeZone(when, timeZone)
        : "";
      const localDate = when
        ? formatDatePartsInTimeZone(new Date(when), timeZone)
        : "";
      return {
        localDate,
        line: `- ${sha} — ${msg} — ${who}${
        when ? ` — ${when}${localWhen ? ` (local ${localWhen})` : ""}` : ""
        }`,
      };
    });
    const lines = rows.slice(0, RECENT_COMMITS_DEFAULT_LIMIT).map((row) => row.line);
    const matchingRows = targetDate
      ? rows.filter((row) => row.localDate === targetDate)
      : [];
    const exactDateSummary =
      targetDate && matchingRows.length > 0
        ? [
            `Exact local-date commit summary for ${targetDate} (${timeZone}):`,
            `- matching commit count: ${matchingRows.length}`,
            ...matchingRows.map((row) => row.line),
            rows.length >= perPage
              ? `- searched newest ${perPage} commits only; older commits on this same date may be missing if this repository had more than ${perPage} very recent commits`
              : "",
            "Only rows with this exact local date count for this calendar-day question.",
          ].filter(Boolean).join("\n")
        : "";

    return [
      `Recent commits on the default branch (newest first; searched newest ${rows.length} commits; GitHub API timestamps are UTC; local dates shown in ${timeZone}):`,
      exactDateSummary,
      ...lines,
    ]
      .filter(Boolean)
      .join("\n");
  } catch {
    return "";
  }
}

export async function buildCommitDetailsContextForQuestion(params: {
  owner: string;
  repo: string;
  defaultBranch: string | null;
  question: string;
  timeZone?: string;
}): Promise<string> {
  if (!commitQuestionAsksForDetail(params.question)) return "";

  const timeZone =
    params.timeZone && isValidTimeZone(params.timeZone)
      ? params.timeZone
      : "UTC";
  const ref = params.defaultBranch?.trim() || undefined;
  const targetDate = targetLocalDateForCommitQuestion(params.question, timeZone);
  const shaPrefix = extractCommitShaPrefix(params.question);
  const octokit = createOctokit();

  try {
    const { data: recent } = await octokit.rest.repos.listCommits({
      owner: params.owner,
      repo: params.repo,
      ...(ref ? { sha: ref } : {}),
      per_page: 100,
      page: 1,
    });
    if (!recent?.length) return "";

    const candidates = recent
      .map((row) => {
        const when =
          row.commit?.author?.date?.trim() ||
          row.commit?.committer?.date?.trim() ||
          "";
        const localDate = when
          ? formatDatePartsInTimeZone(new Date(when), timeZone)
          : "";
        return { row, when, localDate };
      })
      .filter((item) => {
        if (shaPrefix) return item.row.sha.toLowerCase().startsWith(shaPrefix);
        if (targetDate) return item.localDate === targetDate;
        return true;
      });

    if (candidates.length === 0) return "";

    const sorted = candidates.toSorted((a, b) => {
      const at = a.when ? new Date(a.when).getTime() : 0;
      const bt = b.when ? new Date(b.when).getTime() : 0;
      return at - bt;
    });
    const selected = prefersOldestCommit(params.question)
      ? sorted[0]
      : prefersNewestCommit(params.question)
        ? sorted[sorted.length - 1]
        : shaPrefix
          ? sorted[0]
          : sorted[sorted.length - 1];
    if (!selected) return "";

    const { data: detail } = await octokit.rest.repos.getCommit({
      owner: params.owner,
      repo: params.repo,
      ref: selected.row.sha,
    });

    const commit = detail.commit;
    const fullMessage = commit.message?.trim() || "(no message)";
    const title = fullMessage.split(/\r?\n/)[0]?.trim() || "(no message)";
    const body = fullMessage
      .split(/\r?\n/)
      .slice(1)
      .join("\n")
      .trim();
    const committedAt =
      commit.author?.date?.trim() || commit.committer?.date?.trim() || "";
    const localCommittedAt = committedAt
      ? formatDateTimePartsInTimeZone(committedAt, timeZone)
      : "";
    const stats = detail.stats;
    const files = detail.files ?? [];
    const fileLines = files.slice(0, 24).map((file) => {
      const status = file.status ?? "modified";
      const changes =
        typeof file.changes === "number"
          ? `${file.changes} changes`
          : "changes unknown";
      return `- ${file.filename} — ${status}; +${file.additions ?? 0}/-${file.deletions ?? 0}; ${changes}`;
    });

    return [
      "Focused commit detail context (from GitHub getCommit; use this when answering about the selected commit):",
      `Selection rule: ${
        shaPrefix
          ? `commit SHA prefix ${shaPrefix}`
          : targetDate
            ? `${prefersOldestCommit(params.question) ? "first/earliest" : prefersNewestCommit(params.question) ? "last/latest" : "most recent"} commit on local date ${targetDate}`
            : "most relevant recent commit"
      }`,
      `- selected commit: ${detail.sha}`,
      `- short SHA: ${detail.sha.slice(0, 7)}`,
      `- title: ${title}`,
      `- author: ${detail.author?.login || commit.author?.name || "Unknown"}`,
      `- committed UTC: ${committedAt || "unknown"}`,
      `- committed local (${timeZone}): ${localCommittedAt || "unknown"}`,
      stats
        ? `- stats: ${stats.total ?? 0} total changes, ${stats.additions ?? 0} additions, ${stats.deletions ?? 0} deletions`
        : "- stats: unavailable",
      `- parent commits: ${detail.parents.map((p) => p.sha.slice(0, 7)).join(", ") || "none"}`,
      body ? `Commit message body:\n${body}` : "",
      fileLines.length > 0
        ? `Changed files (${files.length}${files.length > fileLines.length ? `, showing first ${fileLines.length}` : ""}):\n${fileLines.join("\n")}`
        : "Changed files: unavailable",
      `Candidate commits on the same local date: ${candidates.length}`,
      "When the user asks for information/details, answer with what this commit changed, using the title, stats, and changed files above. Do not merely repeat the recent commit list.",
    ]
      .filter(Boolean)
      .join("\n");
  } catch {
    return "";
  }
}

export async function buildGitHubFactsContextForQuestion(params: {
  owner: string;
  repo: string;
  defaultBranch: string | null;
  question: string;
  timeZone?: string;
}): Promise<string> {
  if (!shouldBuildGitHubFacts(params.question)) return "";

  const q = params.question.toLowerCase();
  const broad =
    wantsBroadGitHubFacts(params.question) ||
    /\b(github|octokit|data sources?|context|passes? to (?:the )?(?:ai|model)|rag api)\b/.test(
      q,
    );
  const timeZone =
    params.timeZone && isValidTimeZone(params.timeZone)
      ? params.timeZone
      : "UTC";
  const ref = params.defaultBranch?.trim() || undefined;
  const octokit = createOctokit();
  const blocks: string[] = [];

  const includeMetadata = broad || wantsRepoMetadataFacts(params.question);
  const includeContributors = broad || wantsContributorFacts(params.question);
  const includeCommits = broad || wantsCommitActivityFacts(params.question);
  const includeRefs = broad || wantsBranchTagReleaseFacts(params.question);
  const includeIssuesPulls = broad || wantsIssuePullFacts(params.question);
  const includeWorkflows = broad || wantsWorkflowFacts(params.question);

  try {
    const [
      repoResult,
      languagesResult,
      topicsResult,
      contributorsResult,
      commitsResult,
      branchesResult,
      tagsResult,
      releasesResult,
      pullsResult,
      issuesResult,
      workflowsResult,
    ] = await Promise.all([
      includeMetadata || broad
        ? octokit.rest.repos
            .get({ owner: params.owner, repo: params.repo })
            .then((r) => r.data)
            .catch(() => null)
        : Promise.resolve(null),
      includeMetadata || broad
        ? octokit.rest.repos
            .listLanguages({ owner: params.owner, repo: params.repo })
            .then((r) => r.data)
            .catch(() => null)
        : Promise.resolve(null),
      includeMetadata || broad
        ? octokit.rest.repos
            .getAllTopics({ owner: params.owner, repo: params.repo })
            .then((r) => r.data.names ?? [])
            .catch(() => null)
        : Promise.resolve(null),
      includeContributors
        ? octokit.rest.repos
            .listContributors({
              owner: params.owner,
              repo: params.repo,
              per_page: GITHUB_FACTS_PAGE_SIZE,
              page: 1,
            })
            .then((r) => r.data)
            .catch(() => null)
        : Promise.resolve(null),
      includeCommits || includeContributors
        ? octokit.rest.repos
            .listCommits({
              owner: params.owner,
              repo: params.repo,
              ...(ref ? { sha: ref } : {}),
              per_page: GITHUB_FACTS_PAGE_SIZE,
              page: 1,
            })
            .then((r) => r.data)
            .catch(() => null)
        : Promise.resolve(null),
      includeRefs
        ? octokit.rest.repos
            .listBranches({
              owner: params.owner,
              repo: params.repo,
              per_page: GITHUB_FACTS_PAGE_SIZE,
              page: 1,
            })
            .then((r) => r.data)
            .catch(() => null)
        : Promise.resolve(null),
      includeRefs
        ? octokit.rest.repos
            .listTags({
              owner: params.owner,
              repo: params.repo,
              per_page: GITHUB_FACTS_PAGE_SIZE,
              page: 1,
            })
            .then((r) => r.data)
            .catch(() => null)
        : Promise.resolve(null),
      includeRefs
        ? octokit.rest.repos
            .listReleases({
              owner: params.owner,
              repo: params.repo,
              per_page: GITHUB_FACTS_PAGE_SIZE,
              page: 1,
            })
            .then((r) => r.data)
            .catch(() => null)
        : Promise.resolve(null),
      includeIssuesPulls
        ? octokit.rest.pulls
            .list({
              owner: params.owner,
              repo: params.repo,
              state: q.includes("closed") ? "closed" : "open",
              per_page: GITHUB_FACTS_PAGE_SIZE,
              page: 1,
            })
            .then((r) => r.data)
            .catch(() => null)
        : Promise.resolve(null),
      includeIssuesPulls
        ? octokit.rest.issues
            .listForRepo({
              owner: params.owner,
              repo: params.repo,
              state: q.includes("closed") ? "closed" : "open",
              per_page: GITHUB_FACTS_PAGE_SIZE,
              page: 1,
            })
            .then((r) => r.data.filter((issue) => !issue.pull_request))
            .catch(() => null)
        : Promise.resolve(null),
      includeWorkflows
        ? octokit.rest.actions
            .listRepoWorkflows({
              owner: params.owner,
              repo: params.repo,
              per_page: GITHUB_FACTS_PAGE_SIZE,
              page: 1,
            })
            .then((r) => r.data.workflows ?? [])
            .catch(() => null)
        : Promise.resolve(null),
    ]);

    if (repoResult || languagesResult || topicsResult) {
      const languageEntries = Object.entries(languagesResult ?? {})
        .toSorted((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, bytes]) => `${name} (${bytes} bytes)`);
      blocks.push(
        section("GitHub repository facts (Octokit):", [
          repoResult
            ? `- full name: ${repoResult.full_name}`
            : `- full name: ${params.owner}/${params.repo}`,
          repoResult?.description
            ? `- description: ${compactText(repoResult.description, 240)}`
            : "",
          repoResult?.default_branch
            ? `- default branch: ${repoResult.default_branch}`
            : "",
          typeof repoResult?.stargazers_count === "number"
            ? `- stars: ${repoResult.stargazers_count}`
            : "",
          typeof repoResult?.forks_count === "number"
            ? `- forks: ${repoResult.forks_count}`
            : "",
          typeof repoResult?.watchers_count === "number"
            ? `- watchers: ${repoResult.watchers_count}`
            : "",
          typeof repoResult?.open_issues_count === "number"
            ? `- open issues count from repo API (includes PRs): ${repoResult.open_issues_count}`
            : "",
          repoResult?.license?.spdx_id
            ? `- license: ${repoResult.license.spdx_id}`
            : "",
          repoResult?.visibility ? `- visibility: ${repoResult.visibility}` : "",
          repoResult?.created_at ? `- created: ${repoResult.created_at}` : "",
          repoResult?.updated_at ? `- updated: ${repoResult.updated_at}` : "",
          repoResult?.pushed_at ? `- last pushed: ${repoResult.pushed_at}` : "",
          languageEntries.length > 0
            ? `- languages by bytes: ${languageEntries.join(", ")}`
            : "",
          topicsResult?.length ? `- topics: ${topicsResult.join(", ")}` : "",
          repoResult?.homepage
            ? `- homepage: ${repoResult.homepage}`
            : "",
        ]),
      );
    }

    if (contributorsResult) {
      const recentAuthorCounts = new Map<string, number>();
      for (const commit of commitsResult ?? []) {
        const key =
          commit.author?.login?.trim() ||
          commit.commit?.author?.name?.trim() ||
          "Unknown";
        recentAuthorCounts.set(key, (recentAuthorCounts.get(key) ?? 0) + 1);
      }
      blocks.push(
        section("GitHub contributor facts (Octokit):", [
          capNote(
            "contributors fetched from first GitHub API page",
            contributorsResult.length,
            GITHUB_FACTS_PAGE_SIZE,
          ),
          ...contributorsResult
            .slice(0, GITHUB_FACTS_DISPLAY_LIMIT)
            .map((c, index) => {
              const login = c.login ?? c.name ?? "Unknown";
              return `- #${index + 1} ${login}: ${c.contributions ?? 0} contributions`;
            }),
          recentAuthorCounts.size > 0
            ? `- recent default-branch commit authors sampled: ${[...recentAuthorCounts.entries()]
                .toSorted((a, b) => b[1] - a[1])
                .slice(0, 8)
                .map(([name, count]) => `${name} (${count})`)
                .join(", ")}`
            : "",
          "Use the ranked contributors list for questions about the top/most contributor.",
        ]),
      );
    }

    if (commitsResult?.length) {
      const targetDate = targetLocalDateForCommitQuestion(
        params.question,
        timeZone,
      );
      const activityRows = commitsResult.map((commit) => {
        const when =
          commit.commit?.author?.date?.trim() ||
          commit.commit?.committer?.date?.trim() ||
          "";
        const localWhen = when
          ? formatDateTimePartsInTimeZone(when, timeZone)
          : "";
        const localDate = when
          ? formatDatePartsInTimeZone(new Date(when), timeZone)
          : "";
        const who =
          commit.author?.login?.trim() ||
          commit.commit?.author?.name?.trim() ||
          "Unknown";
        return {
          localDate,
          line: `- ${commit.sha.slice(0, 7)} — ${firstLine(commit.commit?.message)} — ${who}${when ? ` — ${when}${localWhen ? ` (local ${localWhen})` : ""}` : ""}`,
        };
      });
      const matchingRows = targetDate
        ? activityRows.filter((row) => row.localDate === targetDate)
        : [];
      blocks.push(
        section(
          "GitHub commit activity facts (newest first; local time shown when available):",
          [
            capNote(
              "commits fetched from first GitHub API page",
              commitsResult.length,
              GITHUB_FACTS_PAGE_SIZE,
            ),
            targetDate && wantsCommitCount(params.question)
              ? `- exact matching commit count for local date ${targetDate}: ${matchingRows.length}`
              : "",
            targetDate
              ? `- matching rows for local date ${targetDate}:`
              : "",
            ...(targetDate ? matchingRows.map((row) => row.line) : []),
            targetDate
              ? "- Do not count any row whose local date differs from the target date above."
              : "",
            targetDate ? "- other recent rows are context only:" : "",
            ...activityRows.slice(0, 12).map((row) => row.line),
          ],
        ),
      );
    }

    if (branchesResult || tagsResult || releasesResult) {
      blocks.push(
        section("GitHub refs and releases facts (Octokit):", [
          branchesResult
            ? capNote(
                "branches fetched from first GitHub API page",
                branchesResult.length,
                GITHUB_FACTS_PAGE_SIZE,
              )
            : "",
          tagsResult
            ? capNote(
                "tags fetched from first GitHub API page",
                tagsResult.length,
                GITHUB_FACTS_PAGE_SIZE,
              )
            : "",
          releasesResult
            ? capNote(
                "releases fetched from first GitHub API page",
                releasesResult.length,
                GITHUB_FACTS_PAGE_SIZE,
              )
            : "",
          branchesResult?.length
            ? `- branches sample: ${branchesResult
                .slice(0, GITHUB_FACTS_DISPLAY_LIMIT)
                .map((b) => `${b.name}${b.protected ? " (protected)" : ""}`)
                .join(", ")}`
            : branchesResult
              ? "- branches: none returned"
              : "",
          tagsResult?.length
            ? `- tags sample: ${tagsResult
                .slice(0, GITHUB_FACTS_DISPLAY_LIMIT)
                .map((t) => t.name)
                .join(", ")}`
            : tagsResult
              ? "- tags: none returned"
              : "",
          releasesResult?.length
            ? `- releases sample: ${releasesResult
                .slice(0, GITHUB_FACTS_DISPLAY_LIMIT)
                .map(
                  (r) =>
                    `${r.tag_name}${r.name ? ` (${compactText(r.name, 80)})` : ""}${r.draft ? " draft" : ""}${r.prerelease ? " prerelease" : ""}`,
                )
                .join(", ")}`
            : releasesResult
              ? "- releases: none returned"
              : "",
        ]),
      );
    }

    if (issuesResult || pullsResult) {
      blocks.push(
        section("GitHub issues and pull requests facts (Octokit):", [
          pullsResult
            ? capNote(
                `${q.includes("closed") ? "closed" : "open"} pull requests fetched from first GitHub API page`,
                pullsResult.length,
                GITHUB_FACTS_PAGE_SIZE,
              )
            : "",
          issuesResult
            ? capNote(
                `${q.includes("closed") ? "closed" : "open"} issues fetched from first GitHub API page`,
                issuesResult.length,
                GITHUB_FACTS_PAGE_SIZE,
              )
            : "",
          pullsResult?.length
            ? `- pull requests: ${pullsResult
                .slice(0, GITHUB_FACTS_DISPLAY_LIMIT)
                .map((pr) => `#${pr.number} ${compactText(pr.title, 110)} (${pr.state})`)
                .join("; ")}`
            : pullsResult
              ? "- pull requests: none returned"
              : "",
          issuesResult?.length
            ? `- issues: ${issuesResult
                .slice(0, GITHUB_FACTS_DISPLAY_LIMIT)
                .map((issue) => `#${issue.number} ${compactText(issue.title, 110)} (${issue.state})`)
                .join("; ")}`
            : issuesResult
              ? "- issues: none returned"
              : "",
        ]),
      );
    }

    if (workflowsResult) {
      blocks.push(
        section(
          "GitHub Actions workflow facts (Octokit):",
          [
            capNote(
              "workflows fetched from first GitHub API page",
              workflowsResult.length,
              GITHUB_FACTS_PAGE_SIZE,
            ),
            ...workflowsResult
              .slice(0, GITHUB_FACTS_DISPLAY_LIMIT)
              .map((workflow) => {
                return `- ${workflow.name}: ${workflow.state}; path ${workflow.path}`;
              }),
          ],
        ),
      );
    }
  } catch {
    return "";
  }

  if (blocks.length === 0) return "";
  return [
    "Question-targeted GitHub facts:",
    "These facts come from live Octokit/GitHub API calls selected for this question. Prefer them for GitHub metadata, contributors, refs, releases, issues, PRs, workflows, and commit-activity questions.",
    ...blocks,
  ].join("\n\n");
}

export async function buildIssuePullDirectAnswerForQuestion(params: {
  owner: string;
  repo: string;
  question: string;
}): Promise<string> {
  if (!wantsIssuePullFacts(params.question)) return "";
  const q = params.question.toLowerCase();
  if (!/\b(list|show|every|all|open|closed)\b/.test(q)) return "";

  const state = q.includes("closed") ? "closed" : "open";
  const octokit = createOctokit();
  const [pullsResult, issuesResult] = await Promise.all([
    octokit.rest.pulls
      .list({
        owner: params.owner,
        repo: params.repo,
        state,
        per_page: GITHUB_FACTS_PAGE_SIZE,
        page: 1,
      })
      .then((r) => r.data)
      .catch(() => null),
    octokit.rest.issues
      .listForRepo({
        owner: params.owner,
        repo: params.repo,
        state,
        per_page: GITHUB_FACTS_PAGE_SIZE,
        page: 1,
      })
      .then((r) => r.data.filter((issue) => !issue.pull_request))
      .catch(() => null),
  ]);

  if (!pullsResult && !issuesResult) return "";

  const label = state === "closed" ? "closed" : "open";
  const lines: string[] = [];
  lines.push(
    `GitHub returned the first page only, with a cap of ${GITHUB_FACTS_PAGE_SIZE} ${label} issues and ${GITHUB_FACTS_PAGE_SIZE} ${label} PRs.`,
  );
  lines.push("");
  lines.push(`**${label[0]?.toUpperCase() ?? "O"}${label.slice(1)} PRs**`);
  if (pullsResult?.length) {
    for (const pr of pullsResult.slice(0, GITHUB_FACTS_DISPLAY_LIMIT)) {
      lines.push(`- #${pr.number}: ${compactText(pr.title, 160)}`);
    }
    if (pullsResult.length > GITHUB_FACTS_DISPLAY_LIMIT) {
      lines.push(
        `- Showing ${GITHUB_FACTS_DISPLAY_LIMIT} of ${pullsResult.length} PRs fetched from the first page.`,
      );
    }
  } else {
    lines.push("- None returned.");
  }
  lines.push("");
  lines.push(`**${label[0]?.toUpperCase() ?? "O"}${label.slice(1)} issues**`);
  if (issuesResult?.length) {
    for (const issue of issuesResult.slice(0, GITHUB_FACTS_DISPLAY_LIMIT)) {
      lines.push(`- #${issue.number}: ${compactText(issue.title, 160)}`);
    }
    if (issuesResult.length > GITHUB_FACTS_DISPLAY_LIMIT) {
      lines.push(
        `- Showing ${GITHUB_FACTS_DISPLAY_LIMIT} of ${issuesResult.length} issues fetched from the first page.`,
      );
    }
  } else {
    lines.push("- None returned.");
  }

  return lines.join("\n");
}

export async function buildQuestionEvidenceContext(params: {
  owner: string;
  repo: string;
  commitSha: string;
  question: string;
  keywordHints: string[];
}): Promise<string> {
  const terms = evidenceTermsFromQuestion(params.question, params.keywordHints);
  if (terms.length === 0) return "";
  const tree = await fetchCachedRepoTreePaths({
    owner: params.owner,
    repo: params.repo,
    commitSha: params.commitSha,
  });
  const files = tree?.files ?? [];
  const paths = tree ? [...tree.files, ...tree.dirs] : [];
  const matchingPaths = paths
    .filter((path) => termMatchesText(path, terms))
    .toSorted((a, b) => a.localeCompare(b))
    .slice(0, 24);

  let matchingDeps: { name: string; section: string }[] = [];
  const packageJson = await githubReadRepoFileUtf8(
    params.owner,
    params.repo,
    params.commitSha,
    "package.json",
  );
  if (packageJson.ok) {
    matchingDeps = parsePackageDependencies(packageJson.text).filter((dep) =>
      termMatchesText(dep.name, terms),
    );
  }

  const sampleFiles = matchingPaths
    .filter((path) => files.includes(path))
    .slice(0, 5);
  const sampledLineBlocks = (
    await Promise.all(
      sampleFiles.map(async (path) => {
        const file = await githubReadRepoFileUtf8(
          params.owner,
          params.repo,
          params.commitSha,
          path,
        );
        if (!file.ok) return "";
        const lines = matchingEvidenceLines(file.text, terms);
        if (lines.length === 0) return "";
        return `- ${path}\n${lines.join("\n")}`;
      }),
    )
  ).filter(Boolean);

  const lines = [
    "Question-targeted repository evidence:",
    `- searched terms: ${terms.join(", ")}`,
    "- Evidence sources checked: root package.json dependencies, indexed repository file/folder paths, and matching file snippets when readable.",
  ];
  if (matchingDeps.length > 0) {
    lines.push("- Matching package dependencies:");
    lines.push(
      ...matchingDeps
        .slice(0, 20)
        .map((dep) => `  - ${dep.name} (${dep.section})`),
    );
  } else {
    lines.push("- Matching package dependencies: none found in root package.json");
  }
  if (matchingPaths.length > 0) {
    lines.push("- Matching indexed paths:");
    lines.push(...matchingPaths.map((path) => `  - ${path}`));
  } else {
    lines.push("- Matching indexed paths: none found");
  }
  if (sampledLineBlocks.length > 0) {
    lines.push("- Matching file snippets:");
    lines.push(...sampledLineBlocks);
  }
  lines.push(
    "Answer from this evidence only. If dependencies, paths, and snippets show no match for the requested technology or location, say that no repository evidence was found; do not infer usage from framework defaults.",
  );
  return lines.join("\n");
}

export async function buildRepositorySignalContext(params: {
  owner: string;
  repo: string;
  commitSha: string;
}): Promise<string> {
  const key = `${params.owner.toLowerCase()}:${params.repo.toLowerCase()}:${params.commitSha.toLowerCase()}`;
  const now = Date.now();
  const cached = repoSignalCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const tree = await fetchCachedRepoTreePaths(params);
  if (!tree) return "";

  const lines: string[] = [];
  const rootFiles = tree.files
    .filter((path) => !path.includes("/"))
    .sort((a, b) => a.localeCompare(b));
  const rootFileSet = new Set(rootFiles);
  const rootMarkers = [
    "package.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "package-lock.json",
    "tsconfig.json",
    "next.config.ts",
    "next.config.js",
    "pyproject.toml",
    "requirements.txt",
    "go.mod",
    "Cargo.toml",
    "Dockerfile",
  ].filter((name) => rootFileSet.has(name));
  if (rootMarkers.length > 0) {
    lines.push(`- root tooling markers: ${rootMarkers.join(", ")}`);
  }

  const firstSegmentCounts = new Map<string, number>();
  for (const filePath of tree.files) {
    const segment = filePath.split("/")[0] ?? "";
    if (!segment) continue;
    firstSegmentCounts.set(segment, (firstSegmentCounts.get(segment) ?? 0) + 1);
  }
  const topAreas = [...firstSegmentCounts.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([segment, count]) => `${segment} (${count} files)`);
  if (topAreas.length > 0) {
    lines.push(`- largest implementation areas: ${topAreas.join(", ")}`);
  }

  const workflowFiles = tree.files
    .filter((path) => path.startsWith(".github/workflows/"))
    .slice(0, 8);
  if (workflowFiles.length > 0) {
    lines.push(`- CI/workflow files: ${workflowFiles.join(", ")}`);
  }

  if (rootFileSet.has("package.json")) {
    const pkg = await githubReadRepoFileUtf8(
      params.owner,
      params.repo,
      params.commitSha,
      "package.json",
    );
    if (pkg.ok) {
      lines.push(...parsePackageJsonSignals(pkg.text));
    }
  }

  const signalText =
    lines.length > 0
      ? ["Repository implementation signals:", ...lines].join("\n")
      : "";
  repoSignalCache.set(key, {
    value: signalText,
    expiresAt: now + REPO_SIGNAL_CACHE_TTL_MS,
  });
  return signalText;
}

export async function buildMentionedPathKindContext(params: {
  owner: string;
  repo: string;
  commitSha: string;
  hints: string[];
}): Promise<string> {
  if (params.hints.length === 0) return "";
  const tree = await fetchCachedRepoTreePaths({
    owner: params.owner,
    repo: params.repo,
    commitSha: params.commitSha,
  });
  if (!tree) return "";

  const fileSet = new Set(tree.files);
  const dirSet = new Set(tree.dirs);

  const lines: string[] = [];
  for (const rawHint of params.hints.slice(0, 6)) {
    const normalized = normalizeRepoContentPath(rawHint);
    if (!normalized.ok || !normalized.path) continue;
    const path = normalized.path;
    const isFile = fileSet.has(path);
    const isDir =
      dirSet.has(path) ||
      tree.files.some((p) => p.startsWith(`${path}/`)) ||
      tree.dirs.some((p) => p.startsWith(`${path}/`));
    if (isDir) {
      lines.push(`- ${path}: directory`);
    } else if (isFile) {
      lines.push(`- ${path}: file`);
    }
  }
  if (lines.length === 0) return "";

  return [
    "Resolved mentioned path types (authoritative):",
    ...lines,
    "If user wording conflicts with these path types, follow these resolved types.",
  ].join("\n");
}

export async function buildDirectPathContext(params: {
  owner: string;
  repo: string;
  commitSha: string;
  hints: string[];
}): Promise<string> {
  const blocks: string[] = [];
  const tree = await fetchCachedRepoTreePaths({
    owner: params.owner,
    repo: params.repo,
    commitSha: params.commitSha,
  });

  for (const rawHint of params.hints.slice(0, 4)) {
    const normalized = normalizeRepoContentPath(rawHint);
    if (!normalized.ok) continue;
    const path = normalized.path;
    if (!path) continue;

    const file = await githubReadRepoFileUtf8(
      params.owner,
      params.repo,
      params.commitSha,
      path,
    );
    if (file.ok) {
      const text =
        file.text.length > 8_000
          ? `${file.text.slice(0, 8_000)}\n\n[truncated]`
          : file.text;
      blocks.push(`### Mentioned file: ${path}\nPath kind: file\n${text}`);
      continue;
    }

    if (tree) {
      const dirSetInner = new Set(tree.dirs);
      const dirExists =
        dirSetInner.has(path) ||
        tree.files.some((p) => p.startsWith(`${path}/`)) ||
        tree.dirs.some((p) => p.startsWith(`${path}/`));
      if (dirExists) {
        const prefix = `${path}/`;
        const topDirs = new Set<string>();
        const topFiles = new Set<string>();

        for (const dirPath of tree.dirs) {
          if (!dirPath.startsWith(prefix)) continue;
          const relative = dirPath.slice(prefix.length);
          if (!relative || relative.includes("/")) continue;
          topDirs.add(relative);
        }
        for (const filePath of tree.files) {
          if (!filePath.startsWith(prefix)) continue;
          const relative = filePath.slice(prefix.length);
          if (!relative || relative.includes("/")) continue;
          topFiles.add(relative);
        }

        const topLevelEntries = [
          ...[...topDirs].toSorted((a, b) => a.localeCompare(b)),
          ...[...topFiles].toSorted((a, b) => a.localeCompare(b)),
        ].map((entry) => `- ${path}/${entry}`);

        const MAX_TREE_DEPTH = 3;
        const MAX_TREE_NODES = 240;
        const MAX_SAMPLE_FILES = 3;

        const recursive: { relative: string; depth: number }[] = [];
        walk: for (const p of [...tree.dirs, ...tree.files]) {
          if (!p.startsWith(prefix)) continue;
          const relative = p.slice(prefix.length);
          if (relative.length === 0) continue;
          const depth = Math.max(0, relative.split("/").length - 1);
          if (depth >= MAX_TREE_DEPTH) continue;
          recursive.push({ relative, depth });
          if (recursive.length >= MAX_TREE_NODES) break walk;
        }

        const treeLines = recursive.map(
          ({ relative, depth }) => `${"  ".repeat(depth)}- ${relative}`,
        );

        const sampleFilePaths = tree.files
          .filter((p) => p.startsWith(prefix))
          .slice(0, MAX_SAMPLE_FILES);
        const directChildFilePaths = tree.files
          .filter((p) => {
            if (!p.startsWith(prefix)) return false;
            const relative = p.slice(prefix.length);
            return relative.length > 0 && !relative.includes("/");
          })
          .toSorted((a, b) => a.localeCompare(b))
          .slice(0, 12);

        const folderSampleBlocks = (
          await Promise.all(
            sampleFilePaths.map(async (filePath) => {
              const fileSample = await githubReadRepoFileUtf8(
                params.owner,
                params.repo,
                params.commitSha,
                filePath,
              );
              if (!fileSample.ok) return "";
              const text =
                fileSample.text.length > 1_200
                  ? `${fileSample.text.slice(0, 1_200)}\n\n[truncated]`
                  : fileSample.text;
              return `#### Sample from ${filePath}\n${text}`;
            }),
          )
        ).filter(Boolean);
        const directChildFileSummaries = (
          await Promise.all(
            directChildFilePaths.map(async (filePath) => {
              const fileSample = await githubReadRepoFileUtf8(
                params.owner,
                params.repo,
                params.commitSha,
                filePath,
              );
              if (!fileSample.ok) return "";
              return summarizeFileContentForDirectory(
                filePath,
                fileSample.text,
              );
            }),
          )
        ).filter(Boolean);

        blocks.push(
          `### Mentioned folder: ${path}\n` +
            "Path kind: directory (even if user wording says 'file').\n" +
            "All paths below are repository-relative; keep this folder prefix when answering.\n" +
            `Top-level entries (complete, uncapped):\n${topLevelEntries.join("\n") || "(empty)"}\n\n` +
            (directChildFileSummaries.length > 0
              ? `Direct child file summaries:\n${directChildFileSummaries.join("\n")}\n\n`
              : "") +
            `Recursive contents (depth ${MAX_TREE_DEPTH}, capped):\n` +
            `${treeLines.join("\n") || "(empty)"}\n\n` +
            (folderSampleBlocks.length > 0
              ? `Representative file content:\n\n${folderSampleBlocks.join("\n\n")}`
              : "Representative file content: unavailable"),
        );
        continue;
      }
    }

    const listed = await githubListRepoPathContents(
      params.owner,
      params.repo,
      params.commitSha,
      path,
    );
    if (!Array.isArray(listed)) continue;
    if (listed.length === 0) {
      blocks.push(
        `### Mentioned path not found: ${path}\n` +
          "The requested path was not found in this repository at the indexed commit.",
      );
      continue;
    }
    const topLevelEntries = listed.map((child) => {
      const relative = child.path.startsWith(`${path}/`)
        ? child.path.slice(path.length + 1)
        : child.path;
      const fullPath = path ? `${path}/${relative}` : relative;
      if (child.kind === "dir") return `- ${fullPath}`;
      if (child.kind === "file") return `- ${fullPath}`;
      return `- ${fullPath} (submodule)`;
    });

    const MAX_TREE_DEPTH = 3;
    const MAX_TREE_NODES = 240;
    const MAX_SAMPLE_FILES = 3;
    const treeLines: string[] = [];
    const sampleFilePaths: string[] = [];
    const directChildFilePaths = listed
      .filter((child) => child.kind === "file")
      .map((child) => child.path)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 12);
    let nodes = 0;

    const queue: { path: string; depth: number }[] = [{ path, depth: 0 }];
    while (queue.length > 0 && nodes < MAX_TREE_NODES) {
      const item = queue.shift();
      if (!item) break;

      const children = await githubListRepoPathContents(
        params.owner,
        params.repo,
        params.commitSha,
        item.path,
      );
      if (!Array.isArray(children)) continue;

      for (const child of children) {
        if (nodes >= MAX_TREE_NODES) break;
        const relative = child.path.startsWith(`${path}/`)
          ? child.path.slice(path.length + 1)
          : child.path;
        const childDepth = Math.max(0, relative.split("/").length - 1);
        const indent = "  ".repeat(Math.min(MAX_TREE_DEPTH, childDepth));
        if (child.kind === "dir") {
          treeLines.push(`${indent}- ${relative}`);
          nodes += 1;
          if (item.depth + 1 < MAX_TREE_DEPTH) {
            queue.push({ path: child.path, depth: item.depth + 1 });
          }
        } else if (child.kind === "file") {
          treeLines.push(`${indent}- ${relative}`);
          nodes += 1;
          if (sampleFilePaths.length < MAX_SAMPLE_FILES) {
            sampleFilePaths.push(child.path);
          }
        }
      }
    }

    const listedSampleBlocks = (
      await Promise.all(
        sampleFilePaths.map(async (filePath) => {
          const fileSample = await githubReadRepoFileUtf8(
            params.owner,
            params.repo,
            params.commitSha,
            filePath,
          );
          if (!fileSample.ok) return "";
          const text =
            fileSample.text.length > 1_200
              ? `${fileSample.text.slice(0, 1_200)}\n\n[truncated]`
              : fileSample.text;
          return `#### Sample from ${filePath}\n${text}`;
        }),
      )
    ).filter(Boolean);
    const directChildFileSummaries = (
      await Promise.all(
        directChildFilePaths.map(async (filePath) => {
          const fileSample = await githubReadRepoFileUtf8(
            params.owner,
            params.repo,
            params.commitSha,
            filePath,
          );
          if (!fileSample.ok) return "";
          return summarizeFileContentForDirectory(filePath, fileSample.text);
        }),
      )
    ).filter(Boolean);

    blocks.push(
      `### Mentioned folder: ${path}\n` +
        "Path kind: directory (even if user wording says 'file').\n" +
        "All paths below are repository-relative; keep this folder prefix when answering.\n" +
        `Top-level entries (complete, uncapped):\n${topLevelEntries.join("\n") || "(empty)"}\n\n` +
        (directChildFileSummaries.length > 0
          ? `Direct child file summaries:\n${directChildFileSummaries.join("\n")}\n\n`
          : "") +
        `Recursive contents (depth ${MAX_TREE_DEPTH}, capped):\n` +
        `${treeLines.join("\n") || "(empty)"}\n\n` +
        (listedSampleBlocks.length > 0
          ? `Representative file content:\n\n${listedSampleBlocks.join("\n\n")}`
          : "Representative file content: unavailable"),
    );
  }

  return blocks.join("\n\n");
}

export async function buildRepositoryTreeContext(params: {
  owner: string;
  repo: string;
  commitSha: string;
  maxDepth?: number;
  maxNodes?: number;
}): Promise<string> {
  const maxDepth = Math.max(1, params.maxDepth ?? 3);
  const maxNodes = Math.max(80, params.maxNodes ?? 420);
  const tree = await fetchCachedRepoTreePaths({
    owner: params.owner,
    repo: params.repo,
    commitSha: params.commitSha,
  });
  if (!tree) return "";

  const lines: string[] = [];
  const nodes: { path: string; depth: number }[] = [];
  walk: for (const pathItem of [...tree.dirs, ...tree.files]) {
    const depth = Math.max(0, pathItem.split("/").length - 1);
    if (depth >= maxDepth) continue;
    nodes.push({ path: pathItem, depth });
    if (nodes.length >= maxNodes) break walk;
  }

  for (const row of nodes) {
    const indent = "  ".repeat(Math.min(maxDepth, row.depth));
    lines.push(`${indent}- ${row.path}`);
  }

  if (lines.length === 0) return "";
  return (
    `Repository tree snapshot (depth ${maxDepth}, capped at ${maxNodes} nodes):\n` +
    lines.join("\n")
  );
}

export async function buildWorkflowDocsContext(params: {
  owner: string;
  repo: string;
  commitSha: string;
}): Promise<string> {
  const tree = await fetchCachedRepoTreePaths({
    owner: params.owner,
    repo: params.repo,
    commitSha: params.commitSha,
  });
  if (!tree) return "";

  const staged: { path: string; score: number }[] = [];
  for (const path of tree.files) {
    const p = path.toLowerCase();
    let score = 0;
    if (p.includes("contributing")) score += 120;
    if (
      p.includes("pull_request_template") ||
      p.includes("pull-request-template")
    ) {
      score += 115;
    }
    if (p.includes(".github/") && p.includes("pull")) score += 90;
    if (p.includes("docs/") && p.includes("contribut")) score += 85;
    if (p.endsWith("readme.md") || p.endsWith("readme.mdx")) score += 40;
    if (p.includes("workflow") && p.includes(".github/workflows/")) score += 35;
    if (score > 0) staged.push({ path, score });
  }

  const candidates = staged
    .toSorted((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.path.localeCompare(b.path);
    })
    .slice(0, 5);

  if (candidates.length === 0) return "";

  const fileBlocks = (
    await Promise.all(
      candidates.map(async (row) => {
        const file = await githubReadRepoFileUtf8(
          params.owner,
          params.repo,
          params.commitSha,
          row.path,
        );
        if (!file.ok) return "";
        const text =
          file.text.length > 1800
            ? `${file.text.slice(0, 1800)}\n\n[truncated]`
            : file.text;
        const sanitizedText = text.replace(
          /https?:\/\/[^\s)]+/gi,
          "[external-url-omitted]",
        );
        return `### Workflow doc: ${row.path}\n${sanitizedText}`;
      }),
    )
  ).filter(Boolean);
  if (fileBlocks.length === 0) return "";
  return [
    "Repository-specific contribution/update workflow guidance:",
    ...fileBlocks,
  ].join("\n\n");
}

export async function buildInferredKeywordContext(params: {
  owner: string;
  repo: string;
  commitSha: string;
  keywordHints: string[];
}): Promise<string> {
  if (params.keywordHints.length === 0) return "";
  const tree = await fetchCachedRepoTreePaths({
    owner: params.owner,
    repo: params.repo,
    commitSha: params.commitSha,
  });
  if (!tree) return "";
  const candidates: { path: string; kind: "dir" | "file"; score: number }[] = [];
  for (const path of tree.files) {
    const score = scorePathWithHints(path, params.keywordHints);
    if (score > 0) {
      candidates.push({ path, kind: "file", score });
    }
  }
  for (const path of tree.dirs) {
    const score = scorePathWithHints(path, params.keywordHints);
    if (score > 0) {
      candidates.push({ path, kind: "dir", score });
    }
  }

  if (candidates.length === 0) return "";

  const ranked = candidates
    .toSorted((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.path.localeCompare(b.path);
    })
    .slice(0, 10);
  const lines: string[] = [];
  const samplePaths: string[] = [];

  for (const row of ranked) {
    if (row.kind === "dir") {
      const childNames: string[] = [];
      const childDirNames: string[] = [];
      const prefix = `${row.path}/`;
      for (const p of tree.dirs) {
        if (!p.startsWith(prefix)) continue;
        const rel = p.slice(prefix.length);
        if (!rel || rel.includes("/")) continue;
        if (childDirNames.length >= 10) break;
        childDirNames.push(rel);
      }
      for (const p of tree.files) {
        if (!p.startsWith(prefix)) continue;
        const rel = p.slice(prefix.length);
        if (!rel || rel.includes("/")) continue;
        if (childNames.length >= 10) break;
        childNames.push(rel);
      }
      const preview = [...childDirNames, ...childNames].slice(0, 12);
      lines.push(
        `- ${row.path} (folder)${preview.length > 0 ? ` -> ${preview.join(", ")}` : ""}`,
      );
      continue;
    }

    lines.push(`- ${row.path}`);
    if (samplePaths.length < 3) {
      samplePaths.push(row.path);
    }
  }

  const sampleBlocks = (
    await Promise.all(
      samplePaths.map(async (path) => {
        const fileSample = await githubReadRepoFileUtf8(
          params.owner,
          params.repo,
          params.commitSha,
          path,
        );
        if (!fileSample.ok) return "";
        const text =
          fileSample.text.length > 1200
            ? `${fileSample.text.slice(0, 1200)}\n\n[truncated]`
            : fileSample.text;
        return `#### Sample from ${path}\n${text}`;
      }),
    )
  ).filter(Boolean);

  return [
    "Inferred repository targets from your question:",
    lines.join("\n"),
    sampleBlocks.length > 0
      ? `Relevant file excerpts:\n\n${sampleBlocks.join("\n\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
