import { NextResponse } from "next/server";

import {
  indexRepositoryEmbeddings,
  resolveCommitShaForIndexing,
  shouldSkipEmbeddingReindex,
} from "@/lib/ai/index-repository-embeddings";
import { createClient } from "@/lib/supabase/server";
import { getSavedRepositoryForIndexing } from "@/lib/supabase/require-repo-for-user";

type RouteParams = { params: Promise<{ owner: string; repo: string }> };

type NdjsonEvent =
  | { type: "progress"; percent: number; stage: string }
  | {
      type: "complete";
      skipped?: boolean;
      commit_sha: string;
      chunk_count?: number;
      indexed_at?: string | null;
    }
  | { type: "error"; message: string };

function ndjsonResponse(
  execute: (send: (e: NdjsonEvent) => void) => Promise<void>,
) {
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: NdjsonEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
        } catch {
          // Client disconnected or stream already closed.
          closed = true;
        }
      };
      try {
        await execute(send);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Indexing failed";
        send({ type: "error", message });
      } finally {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // Already closed/cancelled.
          }
        }
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function POST(request: Request, { params }: RouteParams) {
  const { owner: ownerParam, repo: repoParam } = await params;
  const ownerNorm = ownerParam.toLowerCase();
  const repoNorm = repoParam.toLowerCase();

  const url = new URL(request.url);
  const wantStream =
    url.searchParams.get("stream") === "1" ||
    url.searchParams.get("stream") === "true";

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

  if (!process.env.HUGGINGFACE_API_KEY?.trim()) {
    return NextResponse.json(
      {
        error:
          "Server is not configured for embeddings (set HUGGINGFACE_API_KEY).",
      },
      { status: 503 },
    );
  }

  if (wantStream) {
    return ndjsonResponse(async (send) => {
      send({ type: "progress", percent: 0, stage: "Starting…" });

      const commitSha = await resolveCommitShaForIndexing(supabase, repoRow);
      if (!commitSha) {
        send({
          type: "error",
          message:
            "Could not resolve a Git commit SHA. Open this page again after GitHub metadata loads.",
        });
        return;
      }

      send({ type: "progress", percent: 2, stage: "Resolved commit…" });

      const force =
        url.searchParams.get("force") === "1" ||
        url.searchParams.get("force") === "true";
      const hardForce =
        url.searchParams.get("force") === "hard" ||
        url.searchParams.get("hard") === "1" ||
        url.searchParams.get("hard") === "true";

      if (
        (!force || !hardForce) &&
        shouldSkipEmbeddingReindex({
          targetCommitSha: commitSha,
          indexedCommitSha: repoRow.indexed_commit_sha,
        })
      ) {
        const { count } = await supabase
          .from("embeddings")
          .select("*", { count: "exact", head: true })
          .eq("repository_id", repoRow.id)
          .eq("commit_sha", commitSha);

        send({ type: "progress", percent: 100, stage: "Already indexed." });
        send({
          type: "complete",
          skipped: true,
          commit_sha: commitSha,
          chunk_count: count ?? 0,
          indexed_at: repoRow.indexed_at,
        });
        return;
      }

      try {
        const result = await indexRepositoryEmbeddings({
          supabase,
          repositoryId: repoRow.id,
          githubOwner: repoRow.github_owner,
          githubRepo: repoRow.github_repo,
          resolvedCommitSha: commitSha,
          onProgress: (p) =>
            send({ type: "progress", percent: p.percent, stage: p.stage }),
        });
        send({
          type: "complete",
          commit_sha: result.commit_sha,
          chunk_count: result.chunk_count,
          indexed_at: result.indexed_at,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Indexing failed";
        if (/relation .* does not exist/i.test(message)) {
          send({
            type: "error",
            message:
              "Embeddings table is missing. Run `supabase/manual/phase4-embeddings-pgvector.sql` in Supabase SQL editor.",
          });
          return;
        }
        send({ type: "error", message });
      }
    });
  }

  try {
    const commitSha = await resolveCommitShaForIndexing(supabase, repoRow);
    if (!commitSha) {
      return NextResponse.json(
        {
          error:
            "Could not resolve a Git commit SHA. Open the repo overview so metadata can load, then try again.",
        },
        { status: 422 },
      );
    }

    const force =
      url.searchParams.get("force") === "1" ||
      url.searchParams.get("force") === "true";
    const hardForce =
      url.searchParams.get("force") === "hard" ||
      url.searchParams.get("hard") === "1" ||
      url.searchParams.get("hard") === "true";

    if (
      (!force || !hardForce) &&
      shouldSkipEmbeddingReindex({
        targetCommitSha: commitSha,
        indexedCommitSha: repoRow.indexed_commit_sha,
      })
    ) {
      const { count } = await supabase
        .from("embeddings")
        .select("*", { count: "exact", head: true })
        .eq("repository_id", repoRow.id)
        .eq("commit_sha", commitSha);

      return NextResponse.json({
        skipped: true,
        commit_sha: commitSha,
        chunk_count: count ?? 0,
        indexed_at: repoRow.indexed_at,
      });
    }

    const result = await indexRepositoryEmbeddings({
      supabase,
      repositoryId: repoRow.id,
      githubOwner: repoRow.github_owner,
      githubRepo: repoRow.github_repo,
      resolvedCommitSha: commitSha,
    });

    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Indexing failed";
    if (/relation .* does not exist/i.test(message)) {
      return NextResponse.json(
        {
          error:
            "Embeddings table is missing. Run `supabase/manual/phase4-embeddings-pgvector.sql` in the Supabase SQL editor, then retry.",
        },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
