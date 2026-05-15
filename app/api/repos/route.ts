import { after, NextResponse } from "next/server";
import { z } from "zod";

import {
  indexRepositoryEmbeddings,
  resolveCommitShaForIndexing,
  shouldSkipEmbeddingReindex,
} from "@/lib/ai/index-repository-embeddings";
import { fetchGithubRepoMetadataPatch } from "@/lib/github/fetch-repo-metadata";
import {
  githubRepoParseErrorMessage,
  safeParseGithubRepoUrl,
} from "@/lib/github/repo-url";
import { createClient } from "@/lib/supabase/server";

const bodySchema = z.object({
  url: z.string().trim().min(1),
});

export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const body = bodySchema.safeParse(json);
  if (!body.success) {
    return NextResponse.json(
      { error: 'Expected a JSON body: { "url": string }' },
      { status: 400 },
    );
  }

  const repoRef = safeParseGithubRepoUrl(body.data.url);
  if (!repoRef.success) {
    return NextResponse.json(
      { error: githubRepoParseErrorMessage(repoRef.error) },
      { status: 422 },
    );
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!supabaseUrl || !supabaseAnonKey) {
    return NextResponse.json(
      { error: "Server is missing Supabase configuration." },
      { status: 503 },
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json(
      { error: "Sign in to add a repository." },
      { status: 401 },
    );
  }

  const row = {
    user_id: user.id,
    github_owner: repoRef.data.owner,
    github_repo: repoRef.data.repo,
    html_url: repoRef.data.htmlUrl,
  };

  const { data: existing, error: findError } = await supabase
    .from("repositories")
    .select("id")
    .eq("user_id", user.id)
    .eq("github_owner_norm", repoRef.data.owner.toLowerCase())
    .eq("github_repo_norm", repoRef.data.repo.toLowerCase())
    .maybeSingle();

  if (findError) {
    return NextResponse.json({ error: findError.message }, { status: 500 });
  }

  let repositoryId: string;
  let httpStatus: 200 | 201;
  let baselineRow: Record<string, unknown>;

  if (existing?.id) {
    repositoryId = existing.id;
    httpStatus = 200;
    const { data, error } = await supabase
      .from("repositories")
      .update({
        html_url: repoRef.data.htmlUrl,
        updated_at: new Date().toISOString(),
      })
      .eq("id", repositoryId)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    baselineRow = data as Record<string, unknown>;
  } else {
    const { data, error } = await supabase
      .from("repositories")
      .insert(row)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    baselineRow = data as Record<string, unknown>;
    repositoryId = data.id as string;
    httpStatus = 201;
  }

  const metaPatch = await fetchGithubRepoMetadataPatch(
    repoRef.data.owner,
    repoRef.data.repo,
  );

  let repository = baselineRow;
  if (metaPatch) {
    const { data: enriched, error: enrichError } = await supabase
      .from("repositories")
      .update(metaPatch)
      .eq("id", repositoryId)
      .select()
      .single();

    if (!enrichError && enriched) {
      repository = enriched as Record<string, unknown>;
    }
  }

  const hfKey = process.env.HUGGINGFACE_API_KEY?.trim();
  if (hfKey) {
    after(async () => {
      try {
        const { data: repoRow, error: rowErr } = await supabase
          .from("repositories")
          .select(
            "id, github_owner, github_repo, last_commit_sha, default_branch, indexed_commit_sha, indexed_at",
          )
          .eq("id", repositoryId)
          .single();

        if (rowErr || !repoRow) return;

        const commitSha = await resolveCommitShaForIndexing(supabase, repoRow);
        if (!commitSha) return;

        if (
          shouldSkipEmbeddingReindex({
            targetCommitSha: commitSha,
            indexedCommitSha: repoRow.indexed_commit_sha,
          })
        ) {
          return;
        }

        await indexRepositoryEmbeddings({
          supabase,
          repositoryId: repoRow.id,
          githubOwner: repoRow.github_owner,
          githubRepo: repoRow.github_repo,
          resolvedCommitSha: commitSha,
        });
      } catch (e) {
        console.error("[POST /api/repos] Background embedding index failed:", e);
      }
    });
  }

  return NextResponse.json({ repository }, { status: httpStatus });
}
