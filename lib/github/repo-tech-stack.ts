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

const ROOT_STACK_SIGNAL_MAP: readonly { file: string; label: string }[] = [
  { file: "next.config.js", label: "Next.js" },
  { file: "next.config.mjs", label: "Next.js" },
  { file: "next.config.ts", label: "Next.js" },
  { file: "nuxt.config.ts", label: "Nuxt" },
  { file: "nuxt.config.js", label: "Nuxt" },
  { file: "svelte.config.js", label: "SvelteKit" },
  { file: "svelte.config.ts", label: "SvelteKit" },
  { file: "astro.config.mjs", label: "Astro" },
  { file: "astro.config.ts", label: "Astro" },
  { file: "vite.config.ts", label: "Vite" },
  { file: "vite.config.js", label: "Vite" },
  { file: "remix.config.js", label: "Remix" },
  { file: "angular.json", label: "Angular" },
  { file: "tailwind.config.ts", label: "Tailwind CSS" },
  { file: "tailwind.config.js", label: "Tailwind CSS" },
  { file: "tsconfig.json", label: "TypeScript" },
  { file: "turbo.json", label: "Turborepo" },
  { file: "nx.json", label: "Nx" },
  { file: "deno.json", label: "Deno" },
  { file: "deno.jsonc", label: "Deno" },
  { file: "wrangler.toml", label: "Cloudflare Workers" },
  { file: "serverless.yml", label: "Serverless" },
  { file: "serverless.yaml", label: "Serverless" },
  { file: "docker-compose.yml", label: "Docker Compose" },
  { file: "docker-compose.yaml", label: "Docker Compose" },
  { file: "terraform.tf", label: "Terraform" },
  { file: "main.tf", label: "Terraform" },
  { file: "helmfile.yaml", label: "Helm" },
];

const NPM_PRODUCTION_CAP = 36;
const NPM_DEV_CAP = 18;
const TECH_STACK_CACHE_TTL_MS = 3 * 60 * 1000;
const techStackCache = new Map<
  string,
  { value: RepoTechStackSummary | null; expiresAt: number }
>();
const techStackInflight = new Map<
  string,
  Promise<RepoTechStackSummary | null>
>();

function hashString(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dependencyKeys(obj: unknown, cap: number): string[] {
  if (!isRecord(obj)) return [];
  const keys = Object.keys(obj)
    .flatMap((k) => (k.trim() !== "" ? [k] : []))
    .toSorted((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return keys.slice(0, cap);
}

function dependencyKeysUncapped(obj: unknown): string[] {
  if (!isRecord(obj)) return [];
  return Object.keys(obj).flatMap((k) => (k.trim() !== "" ? [k] : []));
}

function addSignalsFromDependencyNames(
  names: readonly string[],
  ecosystems: Set<string>,
) {
  const deps = new Set(names.map((name) => name.toLowerCase()));

  if (deps.has("next")) ecosystems.add("Next.js");
  if (deps.has("react") || deps.has("react-dom")) ecosystems.add("React");
  if (deps.has("vue")) ecosystems.add("Vue");
  if (deps.has("nuxt")) ecosystems.add("Nuxt");
  if (deps.has("svelte") || deps.has("@sveltejs/kit"))
    ecosystems.add("SvelteKit");
  if (deps.has("@angular/core")) ecosystems.add("Angular");
  if (deps.has("astro")) ecosystems.add("Astro");
  if (deps.has("vite")) ecosystems.add("Vite");
  if (deps.has("tailwindcss")) ecosystems.add("Tailwind CSS");
  if (deps.has("typescript")) ecosystems.add("TypeScript");
  if (deps.has("express")) ecosystems.add("Express");
  if (deps.has("fastify")) ecosystems.add("Fastify");
  if (deps.has("hono")) ecosystems.add("Hono");
  if (deps.has("koa")) ecosystems.add("Koa");
  if (deps.has("@nestjs/core")) ecosystems.add("NestJS");
  if (deps.has("@remix-run/react") || deps.has("remix"))
    ecosystems.add("Remix");
  if (deps.has("prisma")) ecosystems.add("Prisma");
  if (deps.has("drizzle-orm")) ecosystems.add("Drizzle ORM");
  if (deps.has("graphql") || deps.has("@apollo/client"))
    ecosystems.add("GraphQL");
  if (deps.has("@tanstack/react-query")) ecosystems.add("React Query");
  if (deps.has("redux") || deps.has("@reduxjs/toolkit"))
    ecosystems.add("Redux");
  if (deps.has("@supabase/supabase-js")) ecosystems.add("Supabase");
  if (deps.has("firebase")) ecosystems.add("Firebase");
  if (deps.has("mongoose")) ecosystems.add("MongoDB");
  if (deps.has("pg")) ecosystems.add("PostgreSQL");
  if (deps.has("mysql2")) ecosystems.add("MySQL");
  if (deps.has("better-sqlite3") || deps.has("sqlite3"))
    ecosystems.add("SQLite");

  if (deps.has("django")) ecosystems.add("Django");
  if (deps.has("flask")) ecosystems.add("Flask");
  if (deps.has("fastapi")) ecosystems.add("FastAPI");
  if (deps.has("rails")) ecosystems.add("Ruby on Rails");
  if (deps.has("phoenix")) ecosystems.add("Phoenix");
  if (deps.has("laravel")) ecosystems.add("Laravel");
  if (deps.has("spring-boot")) ecosystems.add("Spring Boot");

  for (const depName of names) {
    const dep = depName.toLowerCase();
    if (dep.startsWith("@aws-sdk/") || dep === "aws-cdk")
      ecosystems.add("AWS");
    if (dep.startsWith("@azure/")) ecosystems.add("Azure");
    if (dep.startsWith("@google-cloud/")) ecosystems.add("Google Cloud");
  }
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

    npmProductionDeps.push(
      ...dependencyKeys(pkg.dependencies, NPM_PRODUCTION_CAP),
    );
    npmDevDeps.push(...dependencyKeys(pkg.devDependencies, NPM_DEV_CAP));
    addSignalsFromDependencyNames(
      [
        ...dependencyKeysUncapped(pkg.dependencies),
        ...dependencyKeysUncapped(pkg.devDependencies),
      ],
      ecosystems,
    );

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

  const rootFingerprint =
    rootEntries === null
      ? "unknown"
      : hashString(
          rootEntries
            .map((entry) => `${entry.kind}:${entry.path}`)
            .toSorted((a, b) => a.localeCompare(b))
            .join("|"),
        );
  const cacheKey = `${owner.toLowerCase()}/${repo.toLowerCase()}@${refTrimmed.toLowerCase()}#${rootFingerprint}`;
  const now = Date.now();
  const cached = techStackCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  const inflight = techStackInflight.get(cacheKey);
  if (inflight) return inflight;

  const task = (async () => {
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
    for (const { file, label } of ROOT_STACK_SIGNAL_MAP) {
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

    const ecoSorted = [...ecosystems].toSorted((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );

    return {
      ecosystems: ecoSorted,
      npmProductionDeps,
      npmDevDeps,
      ...(npmParseFailed ? { npmParseFailed: true as const } : {}),
    };
  })();

  techStackInflight.set(cacheKey, task);
  try {
    const value = await task;
    techStackCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + TECH_STACK_CACHE_TTL_MS,
    });
    return value;
  } finally {
    techStackInflight.delete(cacheKey);
  }
}
