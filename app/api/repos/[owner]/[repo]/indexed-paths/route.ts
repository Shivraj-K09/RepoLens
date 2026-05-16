import { NextResponse } from "next/server";
import { z } from "zod";

import { githubListRepoTreePaths } from "@/lib/github/repo-tree";
import {
  checkRateLimit,
  rateLimitExceededResponse,
} from "@/lib/security/rate-limit";
import { sanitizeErrorMessage } from "@/lib/security/sanitize-error-message";
import { createClient } from "@/lib/supabase/server";
import { getSavedRepositoryForIndexing } from "@/lib/supabase/require-repo-for-user";

type RouteParams = { params: Promise<{ owner: string; repo: string }> };

type MentionEntry = { path: string; kind: "file" | "dir" };

const querySchema = z.object({
  limit: z.coerce.number().int().min(500).max(25_000).optional(),
});

function buildMentionEntries(filePaths: string[]): MentionEntry[] {
  const files = new Set<string>();
  const dirs = new Set<string>();

  for (const raw of filePaths) {
    const path = raw.trim();
    if (!path) continue;
    files.add(path);
    const segs = path.split("/").filter(Boolean);
    for (let i = 1; i < segs.length; i++) {
      dirs.add(segs.slice(0, i).join("/"));
    }
  }

  const dirEntries: MentionEntry[] = [...dirs]
    .toSorted((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map((path) => ({ path, kind: "dir" as const }));

  const fileEntries: MentionEntry[] = [...files]
    .toSorted((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map((path) => ({ path, kind: "file" as const }));

  return [...dirEntries, ...fileEntries];
}

export async function GET(request: Request, { params }: RouteParams) {
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

  const indexedPathsRateLimit = checkRateLimit({
    request,
    namespace: "repos:indexed-paths",
    userId: user.id,
    max: 60,
    windowMs: 60 * 1000,
  });
  if (!indexedPathsRateLimit.allowed) {
    return rateLimitExceededResponse(
      indexedPathsRateLimit,
      "Too many indexed path requests. Please retry shortly.",
    );
  }

  const repoLookup = await getSavedRepositoryForIndexing(
    user.id,
    ownerNorm,
    repoNorm,
  );
  if (repoLookup.status === "db_error") {
    return NextResponse.json(
      { error: sanitizeErrorMessage(repoLookup.message) },
      { status: 500 },
    );
  }
  if (repoLookup.status === "not_saved") {
    return NextResponse.json(
      { error: "Repository not saved for this account" },
      { status: 403 },
    );
  }
  const repoRow = repoLookup.row;

  const commitSha = repoRow.indexed_commit_sha?.trim();
  if (!commitSha) {
    return NextResponse.json({ entries: [] satisfies MentionEntry[] });
  }

  const tree = await githubListRepoTreePaths(
    repoRow.github_owner,
    repoRow.github_repo,
    commitSha,
  );
  if (!tree) {
    return NextResponse.json({ error: "GitHub tree unavailable" }, { status: 502 });
  }

  const entries = buildMentionEntries(tree.files);
  const queryParsed = querySchema.safeParse({
    limit: new URL(request.url).searchParams.get("limit") ?? undefined,
  });
  if (!queryParsed.success) {
    return NextResponse.json(
      { error: queryParsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const limit = queryParsed.data.limit ?? 12_000;
  const limited = entries.slice(0, limit);
  return NextResponse.json(
    {
      entries: limited,
      commit_sha: commitSha,
      total: entries.length,
      truncated: tree.truncated || limited.length < entries.length,
    },
    { headers: { "Cache-Control": "private, max-age=60" } },
  );
}
