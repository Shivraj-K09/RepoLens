import { generateText, streamText } from "ai";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getHuggingFaceChatLanguageModel } from "@/lib/ai/huggingface-chat-model";
import {
  buildRagPrompt,
  DEFAULT_RAG_MATCH_COUNT,
  embedRagQueryText,
  matchRepositoryEmbeddings,
} from "@/lib/ai/rag-query";
import { fetchGithubRepoReadmeMarkdown } from "@/lib/github/fetch-readme";
import {
  githubListRepoPathContents,
  githubReadRepoFileUtf8,
  normalizeRepoContentPath,
} from "@/lib/github/repo-path";
import { githubListRepoTreePaths, type RepoTreePaths } from "@/lib/github/repo-tree";
import { createClient } from "@/lib/supabase/server";
import { getSavedRepositoryForIndexing } from "@/lib/supabase/require-repo-for-user";

const bodySchema = z.object({
  question: z.string().trim().min(1, "Question is required").max(8_000),
  /** When true, response is `text/plain` streamed with `streamText`. */
  stream: z.boolean().optional(),
  /** Override default number of chunks (max 32 in SQL). */
  match_count: z.number().int().min(1).max(32).optional(),
  /** Optional persisted chat id for history. */
  chat_id: z.string().uuid().optional(),
});

type RouteParams = { params: Promise<{ owner: string; repo: string }> };

type PathHintChunkRow = {
  id: string;
  source_path: string;
  chunk_index: number;
  content: string;
};

const QUESTION_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "can",
  "could",
  "do",
  "does",
  "for",
  "from",
  "in",
  "inside",
  "is",
  "it",
  "kind",
  "me",
  "of",
  "on",
  "or",
  "please",
  "tell",
  "that",
  "the",
  "there",
  "this",
  "to",
  "types",
  "what",
  "which",
  "you",
  "your",
  "folder",
  "file",
  "components",
  "component",
]);

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
const SEMANTIC_SEARCH_TIMEOUT_MS = 3000;
const CONTEXT_ENRICHMENT_TIMEOUT_MS = 1800;

function isFolderInventoryIntent(question: string): boolean {
  const q = question.toLowerCase();
  return (
    /\b(folder|folders|directory|directories|tree|structure)\b/.test(q) ||
    /\bwhat(?:'s| is)?\s+inside\b/.test(q) ||
    /\blist\b.*\b(files?|folders?|directories?)\b/.test(q)
  );
}

function isCodebaseOverviewIntent(question: string): boolean {
  const q = question.toLowerCase();
  return (
    /\b(whole|entire|overall)\s+(codebase|repo|repository)\b/.test(q) ||
    /\babout\s+(this|the)\s+(codebase|repo|repository)\b/.test(q) ||
    /\b(explain|describe|summarize)\b.*\b(codebase|repo|repository)\b/.test(q)
  );
}

function isLocationLookupIntent(question: string): boolean {
  const q = question.toLowerCase();
  return (
    /\b(where|which|location|located|path)\b/.test(q) ||
    /\b(where can i|where do i|where is)\b/.test(q)
  );
}

function isWorkflowGuidanceIntent(question: string): boolean {
  const q = question.toLowerCase();
  return (
    /\b(pr|pull request|merge request)\b/.test(q) ||
    /\b(contribute|contributing|contribution)\b/.test(q) ||
    /\b(how to update|how do i update|change docs|documentation change)\b/.test(
      q,
    )
  );
}

function userExplicitlyAskedForExternalLinks(question: string): boolean {
  const q = question.toLowerCase();
  return (
    /\b(external|official)\s+docs?\b/.test(q) ||
    /\bshare\b.*\blink\b/.test(q) ||
    /\burl\b/.test(q) ||
    /https?:\/\//.test(q)
  );
}

function isSummaryIntent(question: string): boolean {
  const q = question.toLowerCase();
  return (
    q.includes("summarize") ||
    q.includes("summary") ||
    q.includes("what this repository does") ||
    q.includes("who it is for")
  );
}

async function fetchCachedReadmeMarkdown(params: {
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

async function fetchCachedRepoTreePaths(params: {
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

async function withTimeoutOrFallback<T>(
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

async function buildMentionedPathKindContext(params: {
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

  const lines: string[] = [];
  for (const rawHint of params.hints.slice(0, 6)) {
    const normalized = normalizeRepoContentPath(rawHint);
    if (!normalized.ok || !normalized.path) continue;
    const path = normalized.path;
    const isFile = tree.files.includes(path);
    const isDir =
      tree.dirs.includes(path) ||
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

function extractPathHints(question: string): string[] {
  const uniq: string[] = [];

  function pushHint(v: string, options?: { allowBare?: boolean }) {
    const allowBare = options?.allowBare === true;
    const clean = v
      .trim()
      .replace(/^@/, "")
      .replace(/[.,;:!?]+$/, "");
    if (!clean) return;
    if (clean.length < 2) return;
    if (!allowBare && !clean.includes("/") && !clean.startsWith(".")) return;
    if (!uniq.includes(clean)) uniq.push(clean);
  }

  for (const m of question.matchAll(/@([^\s`"'()<>]+)/g)) {
    const v = m[1];
    if (typeof v === "string") pushHint(v, { allowBare: true });
    if (uniq.length >= 6) return uniq;
  }

  for (const m of question.matchAll(/`([^`]+)`/g)) {
    const v = m[1];
    if (typeof v === "string") pushHint(v);
    if (uniq.length >= 6) return uniq;
  }

  for (const m of question.matchAll(
    /(?:^|\s)([a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)+)(?=\s|$)/g,
  )) {
    const v = m[1];
    if (typeof v === "string") pushHint(v);
    if (uniq.length >= 6) return uniq;
  }

  for (const m of question.matchAll(/\b([a-zA-Z0-9._-]+)\s+folder\b/gi)) {
    const v = m[1];
    if (typeof v === "string") pushHint(v, { allowBare: true });
    if (uniq.length >= 6) return uniq;
  }

  return uniq;
}

function extractKeywordHints(question: string): string[] {
  const words = (question.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? [])
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !QUESTION_STOPWORDS.has(w));
  const uniq: string[] = [];
  for (const w of words) {
    if (!uniq.includes(w)) uniq.push(w);
  }
  for (let i = 0; i < words.length - 1; i += 1) {
    const a = words[i];
    const b = words[i + 1];
    if (!a || !b) continue;
    const hyphen = `${a}-${b}`;
    const slash = `${a}/${b}`;
    if (!uniq.includes(hyphen)) uniq.push(hyphen);
    if (!uniq.includes(slash)) uniq.push(slash);
  }
  return uniq.slice(0, 6);
}

async function fetchHintPathChunks(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  repositoryId: string;
  commitSha: string;
  hints: string[];
}): Promise<
  {
    id: string;
    path: string;
    chunk_index: number;
    content: string;
    distance: number;
  }[]
> {
  const out: {
    id: string;
    path: string;
    chunk_index: number;
    content: string;
    distance: number;
  }[] = [];

  const results = await Promise.all(
    params.hints.map(async (hint) => {
      const { data, error } = await params.supabase
        .from("embeddings")
        .select("id, source_path, chunk_index, content")
        .eq("repository_id", params.repositoryId)
        .eq("commit_sha", params.commitSha)
        .ilike("source_path", `%${hint}%`)
        .order("chunk_index", { ascending: true })
        .limit(6);
      if (error || !Array.isArray(data)) return [] as PathHintChunkRow[];
      return data as PathHintChunkRow[];
    }),
  );
  for (const rows of results) {
    for (const row of rows) {
      out.push({
        id: String(row.id),
        path: row.source_path,
        chunk_index: Number(row.chunk_index),
        content: row.content,
        // Path-hint matches are explicit file hits; keep them ahead of semantic matches.
        distance: -1,
      });
    }
  }

  return out;
}

async function fetchKeywordPathChunks(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  repositoryId: string;
  commitSha: string;
  keywordHints: string[];
}): Promise<
  {
    id: string;
    path: string;
    chunk_index: number;
    content: string;
    distance: number;
  }[]
> {
  const out: {
    id: string;
    path: string;
    chunk_index: number;
    content: string;
    distance: number;
  }[] = [];

  const results = await Promise.all(
    params.keywordHints.map(async (hint) => {
      const { data, error } = await params.supabase
        .from("embeddings")
        .select("id, source_path, chunk_index, content")
        .eq("repository_id", params.repositoryId)
        .eq("commit_sha", params.commitSha)
        .ilike("source_path", `%${hint}%`)
        .order("chunk_index", { ascending: true })
        .limit(28);

      if (error || !Array.isArray(data)) {
        return [] as {
          id: string;
          path: string;
          chunk_index: number;
          content: string;
          distance: number;
        }[];
      }
      const ranked = (data as PathHintChunkRow[])
        .map((row) => ({
          row,
          score: scorePathWithHints(row.source_path, [hint]),
        }))
        .sort((a, b) => {
          if (a.score !== b.score) return b.score - a.score;
          if (a.row.source_path !== b.row.source_path) {
            return a.row.source_path.localeCompare(b.row.source_path);
          }
          return a.row.chunk_index - b.row.chunk_index;
        })
        .slice(0, 8);
      return ranked.map(({ row }) => ({
        id: String(row.id),
        path: row.source_path,
        chunk_index: Number(row.chunk_index),
        content: row.content,
        // Keyword path guesses are weaker than explicit hints but stronger than raw semantic-only.
        distance: -0.5,
      }));
    }),
  );
  for (const rows of results) {
    out.push(...rows);
  }

  return out.slice(0, 16);
}

async function inferLikelyPathsFromTree(params: {
  owner: string;
  repo: string;
  commitSha: string;
  keywordHints: string[];
  question: string;
}): Promise<string[]> {
  const tree = await fetchCachedRepoTreePaths({
    owner: params.owner,
    repo: params.repo,
    commitSha: params.commitSha,
  });
  if (!tree) return [];

  const q = params.question.toLowerCase();
  const searchTerms = new Set<string>();
  for (const hint of params.keywordHints) {
    if (hint.length >= 3) searchTerms.add(hint.toLowerCase());
  }
  if (/\binstall|installation|setup\b/.test(q)) {
    searchTerms.add("install");
    searchTerms.add("installation");
    searchTerms.add("setup");
  }
  if (/\bdoc|docs|documentation\b/.test(q)) {
    searchTerms.add("doc");
    searchTerms.add("docs");
    searchTerms.add("documentation");
  }
  if (/\bmdx\b/.test(q)) searchTerms.add("mdx");
  if (/\bgetting started\b/.test(q)) {
    searchTerms.add("getting");
    searchTerms.add("started");
    searchTerms.add("getting-started");
  }

  const allPaths = [...tree.files, ...tree.dirs];
  const candidates: string[] = [];
  for (const path of allPaths) {
    const p = path.toLowerCase();
    let anyMatch = false;
    for (const term of searchTerms) {
      if (p.includes(term)) {
        anyMatch = true;
        break;
      }
    }
    if (anyMatch) candidates.push(path);
  }

  const scored = candidates
    .map((path) => {
      const p = path.toLowerCase();
      let score = scorePathWithHints(path, [...searchTerms]);
      if (p.startsWith("docs/")) score += 45;
      if (/\.(md|mdx)$/.test(p)) score += 25;
      if (p.includes("installation")) score += 120;
      if (p.includes("getting-started")) score += 50;
      if (p.includes("01-installation")) score += 120;
      if (p.includes("/index.mdx")) score -= 25;
      if (tree.files.includes(path)) score += 12;
      return { path, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.path.localeCompare(b.path);
    })
    .slice(0, 8)
    .map((row) => row.path);

  return scored;
}

function buildAuthoritativeLocationContext(paths: string[]): string {
  if (paths.length === 0) return "";
  return [
    "Authoritative location candidates from repository paths:",
    ...paths.map((path) => `- ${path}`),
  ].join("\n");
}

function buildKeywordLocationCandidateContext(params: {
  chunks: { path: string; distance: number }[];
  keywordHints: string[];
  question: string;
}): string {
  if (params.keywordHints.length === 0 || params.chunks.length === 0) return "";
  const q = params.question.toLowerCase();
  const needDocs = /\b(doc|docs|documentation)\b/.test(q);
  const needInstall = /\b(install|installation|setup|getting started)\b/.test(
    q,
  );
  const byPath = new Map<
    string,
    { path: string; bestDistance: number; score: number }
  >();
  for (const row of params.chunks) {
    const prev = byPath.get(row.path);
    const score = scorePathWithHints(row.path, params.keywordHints);
    if (prev) {
      prev.bestDistance = Math.min(prev.bestDistance, row.distance);
      prev.score = Math.max(prev.score, score);
      continue;
    }
    byPath.set(row.path, { path: row.path, bestDistance: row.distance, score });
  }
  const ranked = [...byPath.values()]
    .map((row) => {
      let score = row.score;
      const p = row.path.toLowerCase();
      if (needDocs && p.includes("doc")) score += 30;
      if (needInstall && /install|installation|getting-started|setup/.test(p))
        score += 45;
      if (/\.(md|mdx|txt)$/.test(p)) score += 20;
      return { ...row, score };
    })
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.bestDistance !== b.bestDistance)
        return a.bestDistance - b.bestDistance;
      return a.path.localeCompare(b.path);
    })
    .slice(0, 10);

  if (ranked.length === 0) return "";
  return [
    "Likely matching repository paths for this location question:",
    ranked.map((r) => `- ${r.path}`).join("\n"),
  ].join("\n");
}

async function buildDirectPathContext(params: {
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
      const dirExists =
        tree.dirs.includes(path) ||
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
          ...[...topDirs].sort((a, b) => a.localeCompare(b)),
          ...[...topFiles].sort((a, b) => a.localeCompare(b)),
        ].map((entry) => `- ${entry}`);

        const MAX_TREE_DEPTH = 3;
        const MAX_TREE_NODES = 240;
        const MAX_SAMPLE_FILES = 3;

        const recursive = [...tree.dirs, ...tree.files]
          .filter((p) => p.startsWith(prefix))
          .map((p) => p.slice(prefix.length))
          .filter((relative) => relative.length > 0)
          .map((relative) => ({
            relative,
            depth: Math.max(0, relative.split("/").length - 1),
          }))
          .filter((row) => row.depth < MAX_TREE_DEPTH)
          .slice(0, MAX_TREE_NODES);

        const treeLines = recursive.map(
          ({ relative, depth }) => `${"  ".repeat(depth)}- ${relative}`,
        );

        const sampleFilePaths = tree.files
          .filter((p) => p.startsWith(prefix))
          .slice(0, MAX_SAMPLE_FILES);

        const sampleBlocks: string[] = [];
        for (const filePath of sampleFilePaths) {
          const fileSample = await githubReadRepoFileUtf8(
            params.owner,
            params.repo,
            params.commitSha,
            filePath,
          );
          if (!fileSample.ok) continue;
          const text =
            fileSample.text.length > 1_200
              ? `${fileSample.text.slice(0, 1_200)}\n\n[truncated]`
              : fileSample.text;
          sampleBlocks.push(`#### Sample from ${filePath}\n${text}`);
        }

        blocks.push(
          `### Mentioned folder: ${path}\n` +
            "Path kind: directory (even if user wording says 'file').\n" +
            `Top-level entries (complete, uncapped):\n${topLevelEntries.join("\n") || "(empty)"}\n\n` +
            `Recursive contents (depth ${MAX_TREE_DEPTH}, capped):\n` +
            `${treeLines.join("\n") || "(empty)"}\n\n` +
            (sampleBlocks.length > 0
              ? `Representative file content:\n\n${sampleBlocks.join("\n\n")}`
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
      if (child.kind === "dir") return `- ${relative}`;
      if (child.kind === "file") return `- ${relative}`;
      return `- ${relative} (submodule)`;
    });

    const MAX_TREE_DEPTH = 3;
    const MAX_TREE_NODES = 240;
    const MAX_SAMPLE_FILES = 3;
    const treeLines: string[] = [];
    const sampleFilePaths: string[] = [];
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

    const sampleBlocks: string[] = [];
    for (const filePath of sampleFilePaths) {
      const fileSample = await githubReadRepoFileUtf8(
        params.owner,
        params.repo,
        params.commitSha,
        filePath,
      );
      if (!fileSample.ok) continue;
      const text =
        fileSample.text.length > 1_200
          ? `${fileSample.text.slice(0, 1_200)}\n\n[truncated]`
          : fileSample.text;
      sampleBlocks.push(`#### Sample from ${filePath}\n${text}`);
    }

    blocks.push(
      `### Mentioned folder: ${path}\n` +
        "Path kind: directory (even if user wording says 'file').\n" +
        `Top-level entries (complete, uncapped):\n${topLevelEntries.join("\n") || "(empty)"}\n\n` +
        `Recursive contents (depth ${MAX_TREE_DEPTH}, capped):\n` +
        `${treeLines.join("\n") || "(empty)"}\n\n` +
        (sampleBlocks.length > 0
          ? `Representative file content:\n\n${sampleBlocks.join("\n\n")}`
          : "Representative file content: unavailable"),
    );
  }

  return blocks.join("\n\n");
}

async function buildRepositoryTreeContext(params: {
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
  const nodes = [...tree.dirs, ...tree.files]
    .map((path) => ({
      path,
      depth: Math.max(0, path.split("/").length - 1),
    }))
    .filter((row) => row.depth < maxDepth)
    .slice(0, maxNodes);

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

async function buildWorkflowDocsContext(params: {
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

  const candidates = tree.files
    .map((path) => {
      const p = path.toLowerCase();
      let score = 0;
      if (p.includes("contributing")) score += 120;
      if (
        p.includes("pull_request_template") ||
        p.includes("pull-request-template")
      )
        score += 115;
      if (p.includes(".github/") && p.includes("pull")) score += 90;
      if (p.includes("docs/") && p.includes("contribut")) score += 85;
      if (p.endsWith("readme.md") || p.endsWith("readme.mdx")) score += 40;
      if (p.includes("workflow") && p.includes(".github/workflows/"))
        score += 35;
      return { path, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.path.localeCompare(b.path);
    })
    .slice(0, 5);

  if (candidates.length === 0) return "";

  const fileBlocks: string[] = [];
  for (const row of candidates) {
    const file = await githubReadRepoFileUtf8(
      params.owner,
      params.repo,
      params.commitSha,
      row.path,
    );
    if (!file.ok) continue;
    const text =
      file.text.length > 1800
        ? `${file.text.slice(0, 1800)}\n\n[truncated]`
        : file.text;
    const sanitizedText = text.replace(
      /https?:\/\/[^\s)]+/gi,
      "[external-url-omitted]",
    );
    fileBlocks.push(`### Workflow doc: ${row.path}\n${sanitizedText}`);
  }
  if (fileBlocks.length === 0) return "";
  return [
    "Repository-specific contribution/update workflow guidance:",
    ...fileBlocks,
  ].join("\n\n");
}

type DeterministicPathAnswer = {
  answer: string;
  paths: string[];
};

function buildDeterministicCodebaseOverviewAnswer(params: {
  owner: string;
  repo: string;
  commitSha: string;
  tree: RepoTreePaths;
}): DeterministicPathAnswer {
  const topLevelDirs = params.tree.dirs
    .filter((p) => !p.includes("/"))
    .sort((a, b) => a.localeCompare(b));
  const topLevelFiles = params.tree.files
    .filter((p) => !p.includes("/"))
    .sort((a, b) => a.localeCompare(b));

  const areaCounts = topLevelDirs
    .map((dir) => {
      const prefix = `${dir}/`;
      const count = params.tree.files.filter((p) => p.startsWith(prefix)).length;
      return { dir, count };
    })
    .sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      return a.dir.localeCompare(b.dir);
    })
    .slice(0, 8);

  const answer = [
    `Repository \`${params.owner}/${params.repo}\` (indexed commit \`${params.commitSha}\`) contains ${params.tree.files.length} files and ${params.tree.dirs.length} directories.`,
    "",
    "Top-level directories:",
    topLevelDirs.length > 0
      ? topLevelDirs.map((p) => `- ${p}`).join("\n")
      : "- (none)",
    "",
    "Top-level files:",
    topLevelFiles.length > 0
      ? topLevelFiles.map((p) => `- ${p}`).join("\n")
      : "- (none)",
    "",
    "Largest code areas by file count:",
    areaCounts.length > 0
      ? areaCounts.map((row) => `- ${row.dir} (${row.count} files)`).join("\n")
      : "- (none)",
  ].join("\n");

  const paths = [
    ...topLevelDirs,
    ...topLevelFiles,
    ...areaCounts.map((row) => row.dir),
  ];
  return { answer, paths: uniqueSorted(paths).slice(0, 60) };
}

function buildDeterministicKeywordSearchAnswer(params: {
  question: string;
  keywordHints: string[];
  tree: RepoTreePaths;
}): DeterministicPathAnswer | null {
  if (params.keywordHints.length === 0) return null;
  const q = params.question.toLowerCase();
  const needFolders =
    /\b(folder|folders|directory|directories|tree|structure|inside|contains)\b/.test(
      q,
    );
  const candidates = [...params.tree.dirs, ...params.tree.files]
    .map((path) => {
      let score = scorePathWithHints(path, params.keywordHints);
      const p = path.toLowerCase();
      if (needFolders && params.tree.dirs.includes(path)) score += 12;
      if (/\bcomponents?\b/.test(q) && p.includes("component")) score += 16;
      if (/\bapi\b/.test(q) && p.includes("api")) score += 16;
      if (/\bconfig\b/.test(q) && /config|\.json|\.mjs|\.js|\.ts/.test(p))
        score += 10;
      return { path, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.path.localeCompare(b.path);
    })
    .slice(0, 16)
    .map((row) => row.path);

  if (candidates.length === 0) return null;

  const answer = [
    "Verified repository paths relevant to your question:",
    ...candidates.map((path) => `- ${path}`),
    "",
    "These paths are from the indexed repository tree (no guessed framework paths).",
  ].join("\n");

  return { answer, paths: candidates };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function limitPaths(values: string[], max = 12): string[] {
  return uniqueSorted(values).slice(0, max);
}

function renderPathAnswer(title: string, paths: string[]): string {
  return [title, "", ...paths.map((p) => `- ${p}`)].join("\n");
}

function isDirectoryPathInTree(tree: RepoTreePaths, path: string): boolean {
  return (
    tree.dirs.includes(path) ||
    tree.files.some((p) => p.startsWith(`${path}/`)) ||
    tree.dirs.some((p) => p.startsWith(`${path}/`))
  );
}

function isFilePathInTree(tree: RepoTreePaths, path: string): boolean {
  return tree.files.includes(path);
}

function buildDeterministicFolderTreeAnswer(params: {
  hintPath: string;
  tree: RepoTreePaths;
}): DeterministicPathAnswer | null {
  const hintPath = params.hintPath;
  if (!hintPath) return null;
  if (!isDirectoryPathInTree(params.tree, hintPath)) return null;

  const prefix = `${hintPath}/`;
  const immediateDirs = params.tree.dirs
    .filter((p) => p.startsWith(prefix))
    .map((p) => p.slice(prefix.length))
    .filter((relative) => relative.length > 0 && !relative.includes("/"))
    .map((relative) => `${hintPath}/${relative}`);
  const immediateFiles = params.tree.files
    .filter((p) => p.startsWith(prefix))
    .map((p) => p.slice(prefix.length))
    .filter((relative) => relative.length > 0 && !relative.includes("/"))
    .map((relative) => `${hintPath}/${relative}`);
  const topLevelEntries = [...immediateDirs, ...immediateFiles].sort((a, b) =>
    a.localeCompare(b),
  );

  const MAX_DEPTH = 4;
  const MAX_NODES = 260;
  const allDescendants = [...params.tree.dirs, ...params.tree.files]
    .filter((p) => p.startsWith(prefix))
    .sort((a, b) => a.localeCompare(b));
  const childMap = new Map<string, string[]>();
  for (const child of allDescendants) {
    const relative = child.slice(prefix.length);
    if (!relative) continue;
    const relParts = relative.split("/");
    const parentRel =
      relParts.length <= 1 ? "" : relParts.slice(0, relParts.length - 1).join("/");
    const parentPath = parentRel ? `${hintPath}/${parentRel}` : hintPath;
    const list = childMap.get(parentPath) ?? [];
    list.push(child);
    childMap.set(parentPath, list);
  }
  for (const [parent, children] of childMap.entries()) {
    childMap.set(
      parent,
      [...children].sort((a, b) => {
        const aIsDir = isDirectoryPathInTree(params.tree, a);
        const bIsDir = isDirectoryPathInTree(params.tree, b);
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
        return a.localeCompare(b);
      }),
    );
  }

  const treeLines = [`- ${hintPath}`];
  const emittedPaths: string[] = [];
  const emitted = new Set<string>();
  function walk(parentPath: string, depth: number) {
    if (depth > MAX_DEPTH) return;
    const children = childMap.get(parentPath) ?? [];
    for (const child of children) {
      if (emitted.size >= MAX_NODES) return;
      if (emitted.has(child)) continue;
      emitted.add(child);
      emittedPaths.push(child);
      treeLines.push(`${"  ".repeat(depth)}- ${child}`);
      if (isDirectoryPathInTree(params.tree, child)) {
        walk(child, depth + 1);
      }
      if (emitted.size >= MAX_NODES) return;
    }
  }
  walk(hintPath, 1);

  const answer = [
    `Top-level entries in \`${hintPath}\`:`,
    topLevelEntries.length > 0
      ? topLevelEntries.map((p) => `- ${p}`).join("\n")
      : "- (empty)",
    "",
    `Recursive tree for \`${hintPath}\` (depth ${MAX_DEPTH}, capped at ${MAX_NODES} nodes):`,
    treeLines.join("\n"),
  ].join("\n");

  const paths = [hintPath, ...topLevelEntries, ...emittedPaths];
  return { answer, paths: uniqueSorted(paths).slice(0, 120) };
}

function tryDeterministicMentionedPathAnswer(params: {
  hints: string[];
  tree: RepoTreePaths;
  folderInventoryIntent: boolean;
}): DeterministicPathAnswer | null {
  if (!params.folderInventoryIntent || params.hints.length === 0) return null;
  for (const rawHint of params.hints) {
    const normalized = normalizeRepoContentPath(rawHint);
    if (!normalized.ok || !normalized.path) continue;
    const hintPath = normalized.path;
    const folderAnswer = buildDeterministicFolderTreeAnswer({
      hintPath,
      tree: params.tree,
    });
    if (folderAnswer) return folderAnswer;
    if (isFilePathInTree(params.tree, hintPath)) {
      return {
        answer: `\`${hintPath}\` is a file, not a folder.`,
        paths: [hintPath],
      };
    }
  }
  return null;
}

function tryDeterministicTreeAnswer(params: {
  question: string;
  files: string[];
  dirs: string[];
}): DeterministicPathAnswer | null {
  const q = params.question.toLowerCase();
  const files = params.files;
  const dirs = params.dirs;
  const nonTest = (path: string) =>
    !path.startsWith("test/") &&
    !path.includes("/test/") &&
    !path.includes("__tests__");

  if (/\btest-related\b.*\b(paths?|files?)\b/.test(q)) {
    const testPaths = limitPaths(
      [
        ...files.filter((p) =>
          /(^|\/)(test|tests|e2e|unit|integration|__tests__)(\/|$)|\.(test|spec)\./.test(
            p.toLowerCase(),
          ),
        ),
        ...dirs.filter((p) =>
          /(^|\/)(test|tests|e2e|unit|integration|__tests__)(\/|$)/.test(
            p.toLowerCase(),
          ),
        ),
      ],
      20,
    );
    if (testPaths.length > 0) {
      return {
        answer: renderPathAnswer("Test-related paths:", testPaths),
        paths: testPaths,
      };
    }
  }

  if (/\bwhere\b.*\bapi routes?\b/.test(q)) {
    const apiCandidates = limitPaths(
      [
        ...files.filter(
          (p) =>
            nonTest(p) &&
            (/(^|\/)app\/api\/.+\/route\.(t|j)sx?$/.test(p) ||
              /(^|\/)pages\/api\/.+\.(t|j)sx?$/.test(p)),
        ),
        ...dirs.filter(
          (p) => nonTest(p) && /(^|\/)(app\/api|pages\/api)(\/|$)/.test(p),
        ),
      ],
      12,
    );
    if (apiCandidates.length > 0) {
      return {
        answer: renderPathAnswer("Likely API route locations:", apiCandidates),
        paths: apiCandidates,
      };
    }
  }

  if (/\bauthentication logic\b|\bauth logic\b/.test(q)) {
    const authPaths = limitPaths(
      files.filter(
        (p) =>
          nonTest(p) &&
          /(auth|authentication|login|session|oauth)/.test(p.toLowerCase()),
      ),
      12,
    );
    if (authPaths.length > 0) {
      return {
        answer: renderPathAnswer(
          "Likely authentication-related paths:",
          authPaths,
        ),
        paths: authPaths,
      };
    }
  }

  if (/\bci\b|\brelease\b/.test(q) && /\blikely located\b|\bwhere\b/.test(q)) {
    const ciPaths = limitPaths(
      files.filter((p) =>
        /(^\.github\/workflows\/|release|changeset|run-tests|ci)/.test(
          p.toLowerCase(),
        ),
      ),
      12,
    );
    if (ciPaths.length > 0) {
      return {
        answer: renderPathAnswer("Likely CI/release logic paths:", ciPaths),
        paths: ciPaths,
      };
    }
  }

  if (/\binstallation\b/.test(q) && /\bdocs?\b/.test(q)) {
    const installDocs = limitPaths(
      files.filter(
        (p) =>
          p.toLowerCase().startsWith("docs/") &&
          /(install|installation|getting-started)/.test(p.toLowerCase()),
      ),
      8,
    );
    if (installDocs.length > 0) {
      const primary = installDocs[0]!;
      return {
        answer:
          `Exact path: ${primary}\n\nWhat to edit there:\n` +
          "- Update the installation steps/content in that file.\n" +
          "- Keep headings/frontmatter/style consistent with nearby docs.\n" +
          "- Run repo formatting/check steps before opening a PR.",
        paths: installDocs,
      };
    }
  }

  if (/\bdeploy(ing|ment)?\b/.test(q) && /\bdocs?\b/.test(q)) {
    const deployDocs = limitPaths(
      files.filter(
        (p) =>
          p.toLowerCase().startsWith("docs/") &&
          /deploy|deployment/.test(p.toLowerCase()),
      ),
      8,
    );
    if (deployDocs.length > 0) {
      return {
        answer: renderPathAnswer("Deploying docs paths:", deployDocs),
        paths: deployDocs,
      };
    }
  }

  return null;
}

function shouldRunDeterministicTreeProbe(question: string): boolean {
  const q = question.toLowerCase();
  return (
    /\bwhere\b/.test(q) ||
    /\blikely\b/.test(q) ||
    /\bpath\b/.test(q) ||
    /\bapi routes?\b/.test(q) ||
    /\bauth(entication)?\b/.test(q) ||
    /\bci\b/.test(q) ||
    /\brelease\b/.test(q) ||
    /\binstallation\b/.test(q) ||
    /\bdeploy(ing|ment)?\b/.test(q) ||
    /\btest-related\b/.test(q)
  );
}

function normalizeTreePathToken(raw: string): string {
  return raw
    .trim()
    .replace(/^`+|`+$/g, "")
    .replace(/^["'([{]+|["')\]}.,;:!?]+$/g, "")
    .replace(/^\.?\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function extractPathCandidatesFromLine(line: string): string[] {
  const out = new Set<string>();
  const slashPathRegex =
    /(^|[\s`([{"'])([a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)+\/?)(?=$|[\s`)\]}",.:;!?'])/g;
  for (const match of line.matchAll(slashPathRegex)) {
    const token = (match[2] ?? "").trim();
    if (!token) continue;
    out.add(token);
  }
  const backtickPathRegex = /`([^`\n]*\/[^`\n]*)`/g;
  for (const match of line.matchAll(backtickPathRegex)) {
    const token = (match[1] ?? "").trim();
    if (!token) continue;
    out.add(token);
  }
  return [...out];
}

function removeUnverifiedPathLines(answer: string, tree: RepoTreePaths): {
  answer: string;
  removedCount: number;
} {
  const verifiedPaths = new Set<string>(
    [...tree.files, ...tree.dirs].map((path) => path.toLowerCase()),
  );
  let removedCount = 0;
  const kept = answer
    .split("\n")
    .filter((line) => {
      const candidates = extractPathCandidatesFromLine(line);
      if (candidates.length === 0) return true;
      const hasInvalidPath = candidates.some((candidate) => {
        const normalized = normalizeTreePathToken(candidate);
        return normalized.length > 0 && !verifiedPaths.has(normalized);
      });
      if (!hasInvalidPath) return true;
      if (
        /^\s*[-*]\s+/.test(line) ||
        /^\s*\d+\.\s+/.test(line) ||
        /^\s*exact path\s*:/i.test(line)
      ) {
        removedCount += 1;
        return false;
      }
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { answer: kept, removedCount };
}

function normalizeRagAnswer(params: {
  answer: string;
  question: string;
  locationLookupIntent: boolean;
  authoritativeLocationPaths: string[];
  allowExternalLinks: boolean;
  verifiedTree?: RepoTreePaths | null;
}): string {
  let out = params.answer.trim();
  if (!out) return out;

  if (!params.allowExternalLinks) {
    out = out.replace(/https?:\/\/[^\s)]+/gi, "").replace(/[ \t]+\n/g, "\n");
  }

  if (
    params.locationLookupIntent &&
    params.authoritativeLocationPaths.length > 0
  ) {
    const byBase = new Map<string, string[]>();
    for (const path of params.authoritativeLocationPaths) {
      const base = path.split("/").pop()?.toLowerCase() ?? "";
      if (!base) continue;
      const list = byBase.get(base) ?? [];
      list.push(path);
      byBase.set(base, list);
    }

    out = out.replace(
      /\b([a-zA-Z0-9._-]+\.(?:md|mdx|txt|tsx|ts|js|jsx|json|yml|yaml))\b/g,
      (match, fileNameRaw) => {
        const fileName = String(fileNameRaw).toLowerCase();
        const hits = byBase.get(fileName) ?? [];
        if (hits.length === 1) return hits[0] ?? match;
        return match;
      },
    );

    const primaryPath = params.authoritativeLocationPaths[0];
    const hasFullPath =
      /(?:^|[\s`([])([a-zA-Z0-9._-]+\/[a-zA-Z0-9._/-]*[a-zA-Z0-9._-]+)/.test(
        out,
      );
    if (primaryPath && !hasFullPath) {
      out = `Exact path: ${primaryPath}\n\n${out}`;
    } else if (primaryPath && !out.includes(primaryPath)) {
      out = `Exact path: ${primaryPath}\n\n${out}`;
    }

    if (!/what to edit/i.test(out)) {
      out +=
        "\n\nWhat to edit there:\n" +
        "- Update the relevant section content in that file.\n" +
        "- Keep headings, frontmatter, and style consistent with nearby docs.\n" +
        "- Validate links/examples and run repository formatting/check steps before opening a PR.";
    }
  }

  if (params.verifiedTree) {
    const filtered = removeUnverifiedPathLines(out, params.verifiedTree);
    out = filtered.answer;
    if (filtered.removedCount > 0) {
      out =
        `${out}\n\n` +
        "Removed unverified path lines to keep this answer strictly repository-grounded.";
    }
  }

  if (!out.trim()) {
    return "I can't verify a repository-grounded answer for this question yet.";
  }

  return out.trim();
}

function deriveChatTitleFromQuestion(question: string): string {
  const oneLine = question.replace(/\s+/g, " ").trim();
  if (!oneLine) return "New chat";
  return oneLine.slice(0, 120);
}

async function persistChatTurn(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  chatId: string | null;
  userQuestion: string;
  assistantAnswer: string;
}) {
  if (!params.chatId) return;
  const userText = params.userQuestion.trim();
  const assistantText = params.assistantAnswer.trim();
  if (!userText || !assistantText) return;

  const { error: insertError } = await params.supabase
    .from("chat_messages")
    .insert([
      { chat_id: params.chatId, role: "user", content: userText },
      { chat_id: params.chatId, role: "assistant", content: assistantText },
    ]);
  if (insertError) throw new Error(insertError.message);

  const { error: touchError } = await params.supabase
    .from("chats")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", params.chatId);
  if (touchError) throw new Error(touchError.message);
}

function scorePathWithHints(path: string, hints: string[]): number {
  const p = path.toLowerCase();
  let score = 0;
  for (const hint of hints) {
    const h = hint.toLowerCase();
    if (!h) continue;
    if (p === h) score += 120;
    if (p.endsWith(`/${h}`)) score += 80;
    if (p.includes(`/${h}/`)) score += 70;
    if (p.includes(h)) score += 40;
    const compressedPath = p.replace(/[-_/]/g, "");
    const compressedHint = h.replace(/[-_/]/g, "");
    if (compressedHint.length >= 4 && compressedPath.includes(compressedHint)) {
      score += 30;
    }
  }
  return score;
}

async function buildInferredKeywordContext(params: {
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

  const ranked = candidates.sort((a, b) => b.score - a.score).slice(0, 10);
  const lines: string[] = [];
  const sampleBlocks: string[] = [];

  for (const row of ranked) {
    if (row.kind === "dir") {
      const children = tree.files
        .filter((p) => p.startsWith(`${row.path}/`))
        .map((p) => p.slice(row.path.length + 1))
        .filter((p) => p.length > 0 && !p.includes("/"))
        .slice(0, 10);
      const childDirs = tree.dirs
        .filter((p) => p.startsWith(`${row.path}/`))
        .map((p) => p.slice(row.path.length + 1))
        .filter((p) => p.length > 0 && !p.includes("/"))
        .slice(0, 10);
      const preview = [...childDirs, ...children].slice(0, 12);
      lines.push(
        `- ${row.path} (folder)${preview.length > 0 ? ` -> ${preview.join(", ")}` : ""}`,
      );
      continue;
    }

    lines.push(`- ${row.path}`);
    if (sampleBlocks.length >= 3) continue;
    const fileSample = await githubReadRepoFileUtf8(
      params.owner,
      params.repo,
      params.commitSha,
      row.path,
    );
    if (!fileSample.ok) continue;
    const text =
      fileSample.text.length > 1200
        ? `${fileSample.text.slice(0, 1200)}\n\n[truncated]`
        : fileSample.text;
    sampleBlocks.push(`#### Sample from ${row.path}\n${text}`);
  }

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

export async function POST(request: Request, { params }: RouteParams) {
  const { owner: ownerParam, repo: repoParam } = await params;
  const ownerNorm = ownerParam.toLowerCase();
  const repoNorm = repoParam.toLowerCase();

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const repoRow = await getSavedRepositoryForIndexing(
    user.id,
    ownerNorm,
    repoNorm,
  );
  if (!repoRow) {
    return NextResponse.json(
      { error: "Repository not saved for this account" },
      { status: 403 },
    );
  }

  const indexedSha = repoRow.indexed_commit_sha?.trim();
  if (!indexedSha) {
    return NextResponse.json(
      {
        error:
          "This repository is not indexed yet. Call POST .../index-embeddings first.",
      },
      { status: 422 },
    );
  }

  if (!process.env.HUGGINGFACE_API_KEY?.trim()) {
    return NextResponse.json(
      { error: "Server is missing HUGGINGFACE_API_KEY." },
      { status: 503 },
    );
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const {
    question,
    stream: streamRequested,
    match_count,
    chat_id,
  } = parsed.data;
  const summaryIntent = isSummaryIntent(question);
  const pathHints = extractPathHints(question);
  const keywordHints = extractKeywordHints(question);
  const folderInventoryIntent = isFolderInventoryIntent(question);
  const codebaseOverviewIntent = isCodebaseOverviewIntent(question);
  const locationLookupIntent = isLocationLookupIntent(question);
  const workflowGuidanceIntent = isWorkflowGuidanceIntent(question);
  const allowExternalLinks = userExplicitlyAskedForExternalLinks(question);

  let persistedChatId: string | null = null;
  if (chat_id) {
    const { data: chatRow, error: chatError } = await supabase
      .from("chats")
      .select("id")
      .eq("id", chat_id)
      .eq("user_id", user.id)
      .eq("repository_id", repoRow.id)
      .maybeSingle();
    if (chatError) {
      return NextResponse.json({ error: chatError.message }, { status: 500 });
    }
    if (!chatRow) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }
    persistedChatId = chatRow.id;
  } else {
    const { data: createdChat, error: createChatError } = await supabase
      .from("chats")
      .insert({
        user_id: user.id,
        repository_id: repoRow.id,
        title: deriveChatTitleFromQuestion(question),
      })
      .select("id")
      .single();
    if (createChatError || !createdChat?.id) {
      return NextResponse.json(
        { error: createChatError?.message ?? "Failed to create chat" },
        { status: 500 },
      );
    }
    persistedChatId = createdChat.id;
  }

  try {
    const getRepoTree = (() => {
      let treePromise: Promise<RepoTreePaths | null> | null = null;
      return () => {
        if (!treePromise) {
          treePromise = fetchCachedRepoTreePaths({
            owner: repoRow.github_owner,
            repo: repoRow.github_repo,
            commitSha: indexedSha,
          });
        }
        return treePromise;
      };
    })();

    if (shouldRunDeterministicTreeProbe(question)) {
      const deterministicTree = await getRepoTree();
      if (deterministicTree) {
        const deterministic = tryDeterministicTreeAnswer({
          question,
          files: deterministicTree.files,
          dirs: deterministicTree.dirs,
        });
        if (deterministic) {
          const normalized = normalizeRagAnswer({
            answer: deterministic.answer,
            question,
            locationLookupIntent,
            authoritativeLocationPaths: deterministic.paths,
            allowExternalLinks,
            verifiedTree: deterministicTree,
          });
          try {
            await persistChatTurn({
              supabase,
              chatId: persistedChatId,
              userQuestion: question,
              assistantAnswer: normalized,
            });
          } catch (persistError) {
            console.warn(
              "[rag] chat persistence failed (deterministic path):",
              persistError,
            );
          }
          if (streamRequested === true) {
            const headers = new Headers();
            headers.set("Content-Type", "text/plain; charset=utf-8");
            headers.set("X-RepoLens-Commit-Sha", indexedSha);
            if (persistedChatId) {
              headers.set("X-RepoLens-Chat-Id", persistedChatId);
            }
            return new Response(normalized, { status: 200, headers });
          }
          return NextResponse.json({
            answer: normalized,
            commit_sha: indexedSha,
            chat_id: persistedChatId,
            sources: deterministic.paths.map((path) => ({
              path,
              chunk_index: -1,
              distance: -2,
            })),
          });
        }
      }
    }

    if (codebaseOverviewIntent && pathHints.length === 0) {
      const deterministicTree = await getRepoTree();
      if (deterministicTree) {
        const deterministic = buildDeterministicCodebaseOverviewAnswer({
          owner: repoRow.github_owner,
          repo: repoRow.github_repo,
          commitSha: indexedSha,
          tree: deterministicTree,
        });
        const normalized = normalizeRagAnswer({
          answer: deterministic.answer,
          question,
          locationLookupIntent,
          authoritativeLocationPaths: [],
          allowExternalLinks,
          verifiedTree: deterministicTree,
        });
        try {
          await persistChatTurn({
            supabase,
            chatId: persistedChatId,
            userQuestion: question,
            assistantAnswer: normalized,
          });
        } catch (persistError) {
          console.warn(
            "[rag] chat persistence failed (deterministic codebase overview):",
            persistError,
          );
        }
        if (streamRequested === true) {
          const headers = new Headers();
          headers.set("Content-Type", "text/plain; charset=utf-8");
          headers.set("X-RepoLens-Commit-Sha", indexedSha);
          if (persistedChatId) {
            headers.set("X-RepoLens-Chat-Id", persistedChatId);
          }
          return new Response(normalized, { status: 200, headers });
        }
        return NextResponse.json({
          answer: normalized,
          commit_sha: indexedSha,
          chat_id: persistedChatId,
          sources: deterministic.paths.map((path) => ({
            path,
            chunk_index: -1,
            distance: -2,
          })),
        });
      }
    }

    if (pathHints.length > 0) {
      const deterministicTree = await getRepoTree();
      if (deterministicTree) {
        const deterministicMentioned = tryDeterministicMentionedPathAnswer({
          hints: pathHints,
          tree: deterministicTree,
          folderInventoryIntent,
        });
        if (deterministicMentioned) {
          const normalized = normalizeRagAnswer({
            answer: deterministicMentioned.answer,
            question,
            locationLookupIntent,
            authoritativeLocationPaths: deterministicMentioned.paths,
            allowExternalLinks,
            verifiedTree: deterministicTree,
          });
          try {
            await persistChatTurn({
              supabase,
              chatId: persistedChatId,
              userQuestion: question,
              assistantAnswer: normalized,
            });
          } catch (persistError) {
            console.warn(
              "[rag] chat persistence failed (deterministic mentioned path):",
              persistError,
            );
          }
          if (streamRequested === true) {
            const headers = new Headers();
            headers.set("Content-Type", "text/plain; charset=utf-8");
            headers.set("X-RepoLens-Commit-Sha", indexedSha);
            if (persistedChatId) {
              headers.set("X-RepoLens-Chat-Id", persistedChatId);
            }
            return new Response(normalized, { status: 200, headers });
          }
          return NextResponse.json({
            answer: normalized,
            commit_sha: indexedSha,
            chat_id: persistedChatId,
            sources: deterministicMentioned.paths.map((path) => ({
              path,
              chunk_index: -1,
              distance: -2,
            })),
          });
        }
      }
    }

    const shouldIncludeReadme = summaryIntent || codebaseOverviewIntent;
    const readmeTextPromise = shouldIncludeReadme
      ? fetchCachedReadmeMarkdown({
          owner: repoRow.github_owner,
          repo: repoRow.github_repo,
          commitSha: indexedSha,
        })
      : Promise.resolve<string | null>(null);

    const shouldRunSemanticSearch = pathHints.length === 0;
    const semanticChunks = shouldRunSemanticSearch
      ? await withTimeoutOrFallback(
          (async () => {
            const queryEmbedding = await embedRagQueryText(question);
            return matchRepositoryEmbeddings(supabase, {
              repositoryId: repoRow.id,
              commitSha: indexedSha,
              queryEmbedding,
              matchCount:
                match_count ??
                (question.trim().length <= 48 ? 8 : DEFAULT_RAG_MATCH_COUNT),
            });
          })(),
          [],
          SEMANTIC_SEARCH_TIMEOUT_MS,
        )
      : [];

    const pathHintChunksPromise =
      pathHints.length > 0
        ? fetchHintPathChunks({
            supabase,
            repositoryId: repoRow.id,
            commitSha: indexedSha,
            hints: pathHints,
          })
        : Promise.resolve([]);
    const keywordPathChunksPromise =
      pathHints.length === 0 &&
      (locationLookupIntent || semanticChunks.length <= 4)
        ? fetchKeywordPathChunks({
            supabase,
            repositoryId: repoRow.id,
            commitSha: indexedSha,
            keywordHints,
          })
        : Promise.resolve([]);
    const [pathHintChunks, keywordPathChunks] = await Promise.all([
      pathHintChunksPromise,
      keywordPathChunksPromise,
    ]);

    const authoritativeLocationPathsPromise =
      locationLookupIntent &&
      pathHints.length === 0 &&
      semanticChunks.length <= 6
        ? inferLikelyPathsFromTree({
            owner: repoRow.github_owner,
            repo: repoRow.github_repo,
            commitSha: indexedSha,
            keywordHints,
            question,
          })
        : Promise.resolve<string[]>([]);
    const pathKindContextPromise =
      pathHints.length > 0
        ? buildMentionedPathKindContext({
            owner: repoRow.github_owner,
            repo: repoRow.github_repo,
            commitSha: indexedSha,
            hints: pathHints,
          })
        : Promise.resolve("");
    const directPathContextPromise = buildDirectPathContext({
      owner: repoRow.github_owner,
      repo: repoRow.github_repo,
      commitSha: indexedSha,
      hints: pathHints,
    });
    const shouldAttachRepoTree =
      (folderInventoryIntent && pathHints.length === 0) ||
      (codebaseOverviewIntent && !summaryIntent);
    const repoTreeContextPromise = shouldAttachRepoTree
      ? buildRepositoryTreeContext({
          owner: repoRow.github_owner,
          repo: repoRow.github_repo,
          commitSha: indexedSha,
          maxDepth: codebaseOverviewIntent ? 5 : 4,
          maxNodes: codebaseOverviewIntent ? 560 : 420,
        })
      : Promise.resolve("");
    const workflowDocsContextPromise = workflowGuidanceIntent
      ? buildWorkflowDocsContext({
          owner: repoRow.github_owner,
          repo: repoRow.github_repo,
          commitSha: indexedSha,
        })
      : Promise.resolve("");
    const [
      authoritativeLocationPaths,
      pathKindContext,
      directPathContext,
      repoTreeContext,
      workflowDocsContext,
    ] = await Promise.all([
      withTimeoutOrFallback(
        authoritativeLocationPathsPromise,
        [],
        CONTEXT_ENRICHMENT_TIMEOUT_MS,
      ),
      pathHints.length > 0
        ? pathKindContextPromise
        : withTimeoutOrFallback(
            pathKindContextPromise,
            "",
            CONTEXT_ENRICHMENT_TIMEOUT_MS,
          ),
      pathHints.length > 0
        ? directPathContextPromise
        : withTimeoutOrFallback(
            directPathContextPromise,
            "",
            CONTEXT_ENRICHMENT_TIMEOUT_MS,
          ),
      withTimeoutOrFallback(
        repoTreeContextPromise,
        "",
        CONTEXT_ENRICHMENT_TIMEOUT_MS,
      ),
      withTimeoutOrFallback(
        workflowDocsContextPromise,
        "",
        CONTEXT_ENRICHMENT_TIMEOUT_MS,
      ),
    ]);
    const authoritativeLocationContext = buildAuthoritativeLocationContext(
      authoritativeLocationPaths,
    );
    const merged = [...pathHintChunks, ...keywordPathChunks, ...semanticChunks];
    const deduped = merged.filter((row, idx) => {
      return merged.findIndex((x) => x.id === row.id) === idx;
    });
    const chunks = deduped.sort((a, b) => {
      if (a.distance !== b.distance) return a.distance - b.distance;
      if (a.path !== b.path) return a.path.localeCompare(b.path);
      return a.chunk_index - b.chunk_index;
    });

    if (chunks.length === 0 && pathHints.length === 0) {
      const deterministicTree = await getRepoTree();
      if (deterministicTree) {
        const deterministicKeyword = buildDeterministicKeywordSearchAnswer({
          question,
          keywordHints,
          tree: deterministicTree,
        });
        if (deterministicKeyword) {
          const normalized = normalizeRagAnswer({
            answer: deterministicKeyword.answer,
            question,
            locationLookupIntent,
            authoritativeLocationPaths: deterministicKeyword.paths,
            allowExternalLinks,
            verifiedTree: deterministicTree,
          });
          try {
            await persistChatTurn({
              supabase,
              chatId: persistedChatId,
              userQuestion: question,
              assistantAnswer: normalized,
            });
          } catch (persistError) {
            console.warn(
              "[rag] chat persistence failed (deterministic keyword):",
              persistError,
            );
          }
          if (streamRequested === true) {
            const headers = new Headers();
            headers.set("Content-Type", "text/plain; charset=utf-8");
            headers.set("X-RepoLens-Commit-Sha", indexedSha);
            if (persistedChatId) {
              headers.set("X-RepoLens-Chat-Id", persistedChatId);
            }
            return new Response(normalized, { status: 200, headers });
          }
          return NextResponse.json({
            answer: normalized,
            commit_sha: indexedSha,
            chat_id: persistedChatId,
            sources: deterministicKeyword.paths.map((path) => ({
              path,
              chunk_index: -1,
              distance: -2,
            })),
          });
        }
      }
    }

    const keywordLocationContext =
      locationLookupIntent && pathHints.length === 0
        ? buildKeywordLocationCandidateContext({
            chunks,
            keywordHints,
            question,
          })
        : "";
    const inferredKeywordContext =
      chunks.length === 0 && pathHints.length === 0
        ? await withTimeoutOrFallback(
            buildInferredKeywordContext({
              owner: repoRow.github_owner,
              repo: repoRow.github_repo,
              commitSha: indexedSha,
              keywordHints,
            }),
            "",
            CONTEXT_ENRICHMENT_TIMEOUT_MS,
          )
        : "";
    const readmeText = await readmeTextPromise;

    const { system, user } = buildRagPrompt({
      repository: {
        owner: repoRow.github_owner,
        repo: repoRow.github_repo,
        commitSha: indexedSha,
      },
      question: [
        question,
        pathKindContext,
        directPathContext
          ? `Direct path context from user-mentioned files/folders:\n\n${directPathContext}`
          : "",
        authoritativeLocationContext,
        keywordLocationContext,
        inferredKeywordContext,
        workflowDocsContext,
        repoTreeContext,
      ]
        .filter(Boolean)
        .join("\n\n"),
      contextChunks: chunks,
      readmeText,
    });
    const model = getHuggingFaceChatLanguageModel();

    const sourcePayload = chunks.map((c) => ({
      path: c.path,
      chunk_index: c.chunk_index,
      distance: c.distance,
    }));

    if (streamRequested === true) {
      const result = streamText({
        model,
        system,
        prompt: user,
        temperature: 0,
      });
      const encoder = new TextEncoder();
      let streamedText = "";
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for await (const delta of result.textStream) {
              const chunk = String(delta ?? "");
              if (!chunk) continue;
              streamedText += chunk;
              controller.enqueue(encoder.encode(chunk));
            }

            const completed = streamedText.trim();
            if (completed) {
              const verifiedTree = await getRepoTree();
              const normalizedAnswer = normalizeRagAnswer({
                answer: completed,
                question,
                locationLookupIntent,
                authoritativeLocationPaths,
                allowExternalLinks,
                verifiedTree,
              });
              try {
                await persistChatTurn({
                  supabase,
                  chatId: persistedChatId,
                  userQuestion: question,
                  assistantAnswer: normalizedAnswer,
                });
              } catch (persistError) {
                console.warn(
                  "[rag] chat persistence failed (stream):",
                  persistError,
                );
              }
            }
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
      });
      const headers = new Headers();
      headers.set("Content-Type", "text/plain; charset=utf-8");
      headers.set("X-RepoLens-Commit-Sha", indexedSha);
      if (persistedChatId) {
        headers.set("X-RepoLens-Chat-Id", persistedChatId);
      }
      return new Response(body, {
        status: 200,
        headers,
      });
    }

    const { text } = await generateText({
      model,
      system,
      prompt: user,
      temperature: 0,
    });
    const normalizedAnswer = normalizeRagAnswer({
      answer: text,
      question,
      locationLookupIntent,
      authoritativeLocationPaths,
      allowExternalLinks,
      verifiedTree: await getRepoTree(),
    });
    try {
      await persistChatTurn({
        supabase,
        chatId: persistedChatId,
        userQuestion: question,
        assistantAnswer: normalizedAnswer,
      });
    } catch (persistError) {
      console.warn("[rag] chat persistence failed:", persistError);
    }

    return NextResponse.json({
      answer: normalizedAnswer,
      commit_sha: indexedSha,
      chat_id: persistedChatId,
      sources: sourcePayload,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "RAG query failed";
    if (/function .* does not exist|match_repo_embeddings/i.test(message)) {
      return NextResponse.json(
        {
          error:
            "Similarity search is not installed. Run `supabase/manual/phase4-match-embeddings-rpc.sql` in the Supabase SQL editor.",
        },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
