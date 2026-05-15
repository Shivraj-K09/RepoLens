import type { RagSourceFile } from "@/lib/ai/chunk-text";
import { fetchGithubRepoReadmeMarkdown } from "@/lib/github/fetch-readme";
import {
  githubListRepoPathContents,
  githubReadRepoFileUtf8,
} from "@/lib/github/repo-path";

/** Text-ish extensions suitable for repo understanding (code + docs). */
const RAG_TEXT_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".scss",
  ".html",
  ".vue",
  ".svelte",
  ".rs",
  ".go",
  ".py",
  ".rb",
  ".php",
  ".java",
  ".kt",
  ".swift",
  ".yml",
  ".yaml",
]);

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".next",
  "out",
  "coverage",
  "__pycache__",
  ".venv",
  "vendor",
  "target",
  ".turbo",
  ".nuxt",
  ".output",
]);

/** Large / noisy lockfiles — skip for RAG signal vs tokens */
const SKIP_FILE_NAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "Podfile.lock",
]);

const MAX_DIRECTORY_DEPTH = 3;
const MAX_FILES_SCANNED = 260;
const MAX_FILES_FETCHED = 100;
const MAX_TOTAL_CHARS = 750_000;
const FILE_READ_WAVE_CONCURRENCY = 8;

const PRIORITY_ROOT_FILES = [
  "package.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  "nx.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
] as const;

const CODE_PRIORITY_PREFIXES = [
  "packages/next/",
  "packages/",
  "src/",
  "app/",
  "lib/",
  "server/",
  "client/",
  "scripts/",
] as const;

const DEPRIORITIZED_PREFIXES = ["errors/", "docs/", ".github/"] as const;

function candidatePathScore(path: string): number {
  let score = 0;

  for (const prefix of CODE_PRIORITY_PREFIXES) {
    if (path.startsWith(prefix)) {
      score += 80;
      break;
    }
  }

  for (const prefix of DEPRIORITIZED_PREFIXES) {
    if (path.startsWith(prefix)) {
      score -= 40;
      break;
    }
  }

  const ext = fileExtension(path);
  if (ext === ".ts" || ext === ".tsx") score += 40;
  else if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs")
    score += 30;
  else if (ext === ".md" || ext === ".mdx") score -= 5;

  const base = baseName(path).toLowerCase();
  if (
    base === "readme.md" ||
    base === "readme" ||
    base.startsWith("changelog") ||
    base.startsWith("contributing")
  ) {
    score -= 20;
  }

  const depth = path.split("/").length;
  score -= Math.min(10, depth);

  return score;
}

function fileExtension(path: string): string {
  const i = path.lastIndexOf(".");
  if (i <= 0) return "";
  return path.slice(i).toLowerCase();
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function shouldIncludeFilePath(repoPath: string): boolean {
  const name = baseName(repoPath);
  if (SKIP_FILE_NAMES.has(name)) return false;
  if (name.endsWith(".min.js") || name.endsWith(".min.css")) return false;
  if (name.endsWith(".map")) return false;

  const ext = fileExtension(repoPath);
  if (ext && RAG_TEXT_EXTENSIONS.has(ext)) return true;

  if (/^(readme|license|contributing|changelog|security)/i.test(name)) {
    return true;
  }

  return false;
}

function shouldSkipDirectoryName(name: string): boolean {
  if (!name) return true;
  if (SKIP_DIR_NAMES.has(name)) return true;
  if (name === ".agents") return false;
  // Hidden folders (e.g. .husky/.github/.changeset) are expensive/noisy for RAG.
  return name.startsWith(".");
}

export type FetchRagSourceFilesOptions = {
  maxFiles?: number;
  maxTotalChars?: number;
};

/**
 * Loads README, a few high-signal root manifests, then breadth-first source/docs
 * up to a file and character budget.
 */
export async function fetchRagSourceFilesFromGithub(
  owner: string,
  repo: string,
  ref: string,
  options?: FetchRagSourceFilesOptions,
): Promise<RagSourceFile[]> {
  const maxFiles = Math.min(
    options?.maxFiles ?? MAX_FILES_FETCHED,
    MAX_FILES_SCANNED,
  );
  const maxTotalChars = options?.maxTotalChars ?? MAX_TOTAL_CHARS;

  const trimmedRef = ref.trim();
  if (!trimmedRef) return [];

  const seenPaths = new Set<string>();
  const collected: RagSourceFile[] = [];
  const rootListing = await githubListRepoPathContents(owner, repo, trimmedRef, "");
  const rootFiles =
    Array.isArray(rootListing)
      ? new Set(
          rootListing.flatMap((e) => (e.kind === "file" ? [e.name] : [])),
        )
      : null;
  let totalChars = 0;

  function addFile(path: string, text: string) {
    if (seenPaths.has(path)) return;
    seenPaths.add(path);
    collected.push({ path, text });
    totalChars += text.length;
  }

  const readmeText = await fetchGithubRepoReadmeMarkdown(
    owner,
    repo,
    trimmedRef,
  );
  if (readmeText?.trim()) {
    addFile("README", readmeText);
  }

  const priorityRelFiltered = PRIORITY_ROOT_FILES.filter(
    (rel) => !rootFiles || rootFiles.has(rel),
  );
  const priorityReads = await Promise.all(
    priorityRelFiltered.map((rel) =>
      githubReadRepoFileUtf8(owner, repo, trimmedRef, rel),
    ),
  );
  for (let i = 0; i < priorityRelFiltered.length; i += 1) {
    if (collected.length >= maxFiles || totalChars >= maxTotalChars) break;
    const rel = priorityRelFiltered[i]!;
    const read = priorityReads[i]!;
    if (read.ok && read.text.trim()) {
      addFile(rel, read.text);
    }
  }

  /** BFS queue: directory paths */
  const queue: { path: string; depth: number }[] = [];
  const candidateFiles: string[] = [];

  if (Array.isArray(rootListing)) {
    const rootDirs = rootListing
      .filter(
        (e) =>
          e.kind === "dir" &&
          !shouldSkipDirectoryName(e.name),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const d of rootDirs) {
      queue.push({ path: d.path, depth: 1 });
    }

    const rootTextFiles = rootListing
      .filter((e) => e.kind === "file")
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const f of rootTextFiles) {
      if (!shouldIncludeFilePath(f.path)) continue;
      if (seenPaths.has(f.path)) continue;
      candidateFiles.push(f.path);
    }
  } else {
    queue.push({ path: "", depth: 0 });
  }

  while (
    queue.length > 0 &&
    candidateFiles.length < MAX_FILES_SCANNED &&
    collected.length + candidateFiles.length < maxFiles * 2
  ) {
    const item = queue.shift();
    if (!item) break;
    if (item.depth > MAX_DIRECTORY_DEPTH) continue;

    const listed = await githubListRepoPathContents(
      owner,
      repo,
      trimmedRef,
      item.path,
    );
    if (listed === null || listed === "not-a-directory") continue;

    const dirs = listed
      .filter(
        (e) =>
          e.kind === "dir" &&
          !shouldSkipDirectoryName(e.name),
      )
      .sort((a, b) => a.name.localeCompare(b.name));

    const files = listed
      .filter((e) => e.kind === "file")
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const d of dirs) {
      queue.push({ path: d.path, depth: item.depth + 1 });
    }

    for (const f of files) {
      if (!shouldIncludeFilePath(f.path)) continue;
      if (seenPaths.has(f.path)) continue;
      candidateFiles.push(f.path);
    }
  }

  candidateFiles.sort((a, b) => {
    const sa = candidatePathScore(a);
    const sb = candidatePathScore(b);
    if (sa !== sb) return sb - sa;
    const da = a.split("/").length;
    const db = b.split("/").length;
    if (da !== db) return da - db;
    return a.localeCompare(b, undefined, { sensitivity: "base" });
  });

  for (
    let waveStart = 0;
    waveStart < candidateFiles.length;
    waveStart += FILE_READ_WAVE_CONCURRENCY
  ) {
    if (collected.length >= maxFiles) break;
    if (totalChars >= maxTotalChars) break;

    const wavePaths = candidateFiles
      .slice(waveStart, waveStart + FILE_READ_WAVE_CONCURRENCY)
      .filter((p) => !seenPaths.has(p));

    const waveReads = await Promise.all(
      wavePaths.map(async (path) => ({
        path,
        read: await githubReadRepoFileUtf8(owner, repo, trimmedRef, path),
      })),
    );

    for (const { path, read } of waveReads) {
      if (collected.length >= maxFiles) break;
      if (totalChars >= maxTotalChars) break;
      if (seenPaths.has(path)) continue;
      if (!read.ok || !read.text.trim()) continue;

      if (totalChars + read.text.length > maxTotalChars && collected.length > 3) {
        continue;
      }

      addFile(path, read.text);
    }
  }

  return collected;
}
