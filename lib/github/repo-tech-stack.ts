import {
  githubReadRepoFileUtf8,
  type GithubReadRepoFileResult,
} from "@/lib/github/repo-path";

import type { RepoRootEntry } from "./fetch-repo-root-contents";

/** Display payload for Overview / dashboards (null only when GitHub ref is unavailable). */
export type RepoTechStackSummary = {
  ecosystems: readonly string[];
  npmProductionDeps: readonly string[];
  npmDevDeps: readonly string[];
  npmParseFailed?: boolean;
};

const ROOT_MARKER_MAP: readonly { file: string; label: string }[] = [
  { file: "package.json", label: "Node.js" },
  { file: "pnpm-lock.yaml", label: "Node.js" },
  { file: "yarn.lock", label: "Node.js" },
  { file: "package-lock.json", label: "Node.js" },
  { file: "bun.lockb", label: "Node.js" },
  { file: "Cargo.toml", label: "Rust" },
  { file: "Cargo.lock", label: "Rust" },
  { file: "go.mod", label: "Go" },
  { file: "pyproject.toml", label: "Python" },
  { file: "requirements.txt", label: "Python" },
  { file: "setup.py", label: "Python" },
  { file: "Pipfile", label: "Python" },
  { file: "Gemfile", label: "Ruby" },
  { file: "composer.json", label: "PHP" },
  { file: "pom.xml", label: "Java" },
  { file: "build.gradle", label: "Java" },
  { file: "build.gradle.kts", label: "Java" },
  { file: "Dockerfile", label: "Docker" },
];

const NPM_PRODUCTION_CAP = 36;
const NPM_DEV_CAP = 18;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dependencyKeys(obj: unknown, cap: number): string[] {
  if (!isRecord(obj)) return [];
  const keys = Object.keys(obj).filter((k) => k.trim() !== "").sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
  return keys.slice(0, cap);
}

function mergeNpmIntoSummary(
  raw: GithubReadRepoFileResult,
  ecosystems: Set<string>,
  npmProductionDeps: string[],
  npmDevDeps: string[],
): { npmParseFailed?: boolean } {
  let npmParseFailed: boolean | undefined;
  if (!raw.ok) {
    if (raw.code !== "not_found") npmParseFailed = true;
    return { npmParseFailed };
  }

  try {
    const pkg = JSON.parse(raw.text) as unknown;
    if (!isRecord(pkg)) {
      npmParseFailed = true;
      return { npmParseFailed };
    }

    npmProductionDeps.push(...dependencyKeys(pkg.dependencies, NPM_PRODUCTION_CAP));
    npmDevDeps.push(...dependencyKeys(pkg.devDependencies, NPM_DEV_CAP));

    if (npmProductionDeps.length > 0 || npmDevDeps.length > 0) {
      ecosystems.add("Node.js");
    }
  } catch {
    npmParseFailed = true;
  }

  return { npmParseFailed };
}

/**
 * Inspect root filenames + optionally parse `package.json` dependency keys.
 */
export async function fetchRepoTechStackSummary(
  owner: string,
  repo: string,
  refTrimmed: string,
  rootEntries: RepoRootEntry[] | null,
): Promise<RepoTechStackSummary | null> {
  if (!refTrimmed) return null;

  const filenames = new Set<string>();
  if (Array.isArray(rootEntries)) {
    for (const e of rootEntries) {
      if (e.kind === "file") filenames.add(e.name);
    }
  }

  const ecosystems = new Set<string>();
  for (const { file, label } of ROOT_MARKER_MAP) {
    if (filenames.has(file)) ecosystems.add(label);
  }

  const npmProductionDeps: string[] = [];
  const npmDevDeps: string[] = [];
  let npmParseFailed: boolean | undefined;

  const attemptPackageJson =
    rootEntries === null ||
    filenames.has("package.json") ||
    ecosystems.has("Node.js");

  if (attemptPackageJson) {
    const raw = await githubReadRepoFileUtf8(
      owner,
      repo,
      refTrimmed,
      "package.json",
    );
    const flags = mergeNpmIntoSummary(
      raw,
      ecosystems,
      npmProductionDeps,
      npmDevDeps,
    );
    if (flags.npmParseFailed) npmParseFailed = true;
  }

  const ecoSorted = [...ecosystems].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );

  return {
    ecosystems: ecoSorted,
    npmProductionDeps,
    npmDevDeps,
    ...(npmParseFailed ? { npmParseFailed: true as const } : {}),
  };
}
