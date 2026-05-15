import { z } from "zod";

/** Owner login: alphanumeric + hyphens (GitHub-style); max length aligns with DB. */
const OWNER_SEGMENT = z
  .string()
  .min(1)
  .max(39)
  .regex(
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/,
    "Invalid repository owner segment",
  );

const REPO_SEGMENT = z
  .string()
  .min(1)
  .max(100)
  .regex(
    /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/,
    "Invalid repository name segment",
  );

export type ParsedGithubRepo = {
  /** Lowercase owner (normalized). */
  owner: string;
  /** Lowercase repo name (normalized). */
  repo: string;
  /** Canonical browse URL, no trailing slash. */
  htmlUrl: string;
};

const parsedGithubRepoSchema = z.object({
  owner: OWNER_SEGMENT,
  repo: REPO_SEGMENT,
  htmlUrl: z.url(),
});

/**
 * Trim pasted input and resolve shorthand (`owner/repo`, `github.com/...`) to an https GitHub URL string.
 */
export function normalizeGithubRepoInput(raw: string): string {
  let s = raw.trim().replace(/^["'`]|["'`]$/g, "");
  if (!s) return s;

  const shorthand =
    /^([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?)\/([a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,98}[a-zA-Z0-9])?)$/.exec(
      s,
    );
  if (shorthand && !/^https?:\/\//i.test(s)) {
    const [, o, r] = shorthand;
    return `https://github.com/${o}/${r}`;
  }

  if (!/^https?:\/\//i.test(s)) {
    if (/^(?:www\.)?github\.com\//i.test(s)) {
      s = `https://${s.replace(/^\/+/, "")}`;
    }
  }

  return s.trim();
}

function ownerRepoFromGithubUrl(url: URL): { owner: string; repo: string } {
  const host = url.hostname.replace(/^www\./i, "");
  if (host !== "github.com") {
    throw new z.ZodError([
      {
        code: "custom",
        path: [],
        message: "Only github.com repositories are supported",
      },
    ]);
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new z.ZodError([
      {
        code: "custom",
        path: [],
        message: "URL must include owner and repository (e.g. …/owner/repo)",
      },
    ]);
  }

  const owner = parts[0]!;
  let repo = parts[1]!;
  repo = repo.replace(/\.git$/i, "");

  return { owner, repo };
}

/**
 * Parse & validate a pasted GitHub repository reference.
 * Accepts full `https://github.com/owner/repo` URLs (with optional `.git`, `/tree/…`, query),
 * `github.com/owner/repo`, `www.github.com/…`, or shorthand `owner/repo`.
 */
export function parseGithubRepoUrl(rawInput: unknown): ParsedGithubRepo {
  const trimmed = z.string().trim().min(1).parse(rawInput);
  const normalized = normalizeGithubRepoInput(trimmed);
  if (!normalized) {
    throw new z.ZodError([
      {
        code: "custom",
        path: [],
        message: "Enter a GitHub repository URL or owner/repo",
      },
    ]);
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new z.ZodError([
      {
        code: "custom",
        path: [],
        message: "Could not parse as a URL — try https://github.com/owner/repo",
      },
    ]);
  }

  const { owner, repo } = ownerRepoFromGithubUrl(url);

  const ownerNorm = owner.toLowerCase();
  const repoNorm = repo.toLowerCase();

  return parsedGithubRepoSchema.parse({
    owner: ownerNorm,
    repo: repoNorm,
    htmlUrl: `https://github.com/${ownerNorm}/${repoNorm}`,
  });
}

export type GithubRepoSafeParseResult =
  | { success: true; data: ParsedGithubRepo }
  | { success: false; error: z.ZodError };

export function safeParseGithubRepoUrl(
  rawInput: unknown,
): GithubRepoSafeParseResult {
  try {
    const value = parseGithubRepoUrl(rawInput);
    return { success: true, data: value };
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { success: false, error: err };
    }
    throw err;
  }
}

/** Human-readable message for UI when `safeParseGithubRepoUrl` fails. */
export function githubRepoParseErrorMessage(error: z.ZodError): string {
  const first = error.issues[0];
  return first?.message ?? "Invalid GitHub repository";
}
