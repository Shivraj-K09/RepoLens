import { NextResponse } from "next/server";

import { githubListRepoTreePaths } from "@/lib/github/repo-tree";
import { createClient } from "@/lib/supabase/server";
import { getSavedRepositoryForIndexing } from "@/lib/supabase/require-repo-for-user";

type RouteParams = { params: Promise<{ owner: string; repo: string }> };

type MentionEntry = { path: string; kind: "file" | "dir" };

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
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map((path) => ({ path, kind: "dir" as const }));

  const fileEntries: MentionEntry[] = [...files]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
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

  const repoRow = await getSavedRepositoryForIndexing(user.id, ownerNorm, repoNorm);
  if (!repoRow) {
    return NextResponse.json(
      { error: "Repository not saved for this account" },
      { status: 403 },
    );
  }

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
  const limit = Math.min(
    Math.max(Number(new URL(request.url).searchParams.get("limit") || 12000), 500),
    25000,
  );
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
