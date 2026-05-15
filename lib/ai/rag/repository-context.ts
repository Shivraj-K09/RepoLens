import {
  githubListRepoPathContents,
  githubReadRepoFileUtf8,
  normalizeRepoContentPath,
} from "@/lib/github/repo-path";

import { fetchCachedRepoTreePaths } from "./cache";
import { scorePathWithHints } from "./query-hints";

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
  ].filter((name) => rootFiles.includes(name));
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
    .sort((a, b) => b[1] - a[1])
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

  if (rootFiles.includes("package.json")) {
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

  const candidates = [...tree.files]
    .map((path) => {
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

