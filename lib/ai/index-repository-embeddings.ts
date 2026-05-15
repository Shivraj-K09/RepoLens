import "server-only";

import { buildRagChunksForGithubRepo } from "@/lib/ai/build-repo-rag-chunks";
import { HUGGINGFACE_MINILM_VECTOR_DIM } from "@/lib/ai/config";
import { embedTextsHuggingFaceInference } from "@/lib/ai/huggingface-embeddings";
import { fetchBranchHeadSha } from "@/lib/github/branch-head-sha";
import { fetchGithubRepoMetadataPatch } from "@/lib/github/fetch-repo-metadata";

type ServerSupabaseClient = Awaited<
  ReturnType<typeof import("@/lib/supabase/server").createClient>
>;

const EMBED_BATCH_SIZE = 24;
const INSERT_BATCH_SIZE = 48;
/** Parallel HF calls per wave (same total chunks; fewer wall-clock seconds). */
const EMBED_WAVE_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.HUGGINGFACE_EMBED_WAVE_CONCURRENCY ?? "2", 10) ||
    2,
);

export type { ServerSupabaseClient };

export type IndexProgressPayload = {
  percent: number;
  stage: string;
};

export type IndexRepositoryEmbeddingsParams = {
  supabase: ServerSupabaseClient;
  repositoryId: string;
  githubOwner: string;
  githubRepo: string;
  /** After metadata refresh — resolved commit SHA to index and store */
  resolvedCommitSha: string;
  /** Optional progress for streaming UI (0–100). */
  onProgress?: (p: IndexProgressPayload) => void;
};

export type IndexRepositoryEmbeddingsResult = {
  commit_sha: string;
  chunk_count: number;
  indexed_at: string;
};

const inflightIndexByRepoCommit = new Map<
  string,
  Promise<IndexRepositoryEmbeddingsResult>
>();

export function normalizeGitCommitSha(sha: string): string {
  return sha.trim().toLowerCase();
}

/**
 * Skip a full re-index when this commit was already processed (`repositories.indexed_commit_sha`).
 */
export function shouldSkipEmbeddingReindex(params: {
  targetCommitSha: string;
  indexedCommitSha: string | null | undefined;
}): boolean {
  const target = params.targetCommitSha.trim();
  const indexed = params.indexedCommitSha?.trim();
  if (!target || !indexed) return false;
  return normalizeGitCommitSha(target) === normalizeGitCommitSha(indexed);
}

function vectorToPgString(vec: number[]): string {
  return `[${vec.map((n) => Number(n)).join(",")}]`;
}

/**
 * Replaces existing rows for this repository, re-embeds RAG chunks, inserts into `embeddings`,
 * updates `repositories.indexed_at` / `indexed_commit_sha`.
 *
 * Concurrent calls for the same repository + commit share one in-process job (server instance),
 * so a background `after()` pass and a streaming API request do not double-embed.
 */
export async function indexRepositoryEmbeddings(
  params: IndexRepositoryEmbeddingsParams,
): Promise<IndexRepositoryEmbeddingsResult> {
  const commitNorm = normalizeGitCommitSha(params.resolvedCommitSha);
  const dedupeKey = `${params.repositoryId}:${commitNorm}`;
  const existing = inflightIndexByRepoCommit.get(dedupeKey);
  if (existing) {
    params.onProgress?.({
      percent: 12,
      stage: "Waiting for index in progress…",
    });
    return await existing;
  }

  const run = runIndexRepositoryEmbeddingsOnce(params).finally(() => {
    inflightIndexByRepoCommit.delete(dedupeKey);
  });
  inflightIndexByRepoCommit.set(dedupeKey, run);
  return run;
}

async function runIndexRepositoryEmbeddingsOnce(
  params: IndexRepositoryEmbeddingsParams,
): Promise<IndexRepositoryEmbeddingsResult> {
  const {
    supabase,
    repositoryId,
    githubOwner,
    githubRepo,
    resolvedCommitSha: commitSha,
    onProgress,
  } = params;

  onProgress?.({ percent: 6, stage: "Reading files from GitHub…" });

  const chunks = await buildRagChunksForGithubRepo(
    githubOwner,
    githubRepo,
    commitSha,
  );

  onProgress?.({
    percent: 20,
    stage: chunks.length
      ? `Prepared ${chunks.length} chunks`
      : "No text chunks to embed",
  });

  if (chunks.length === 0) {
    onProgress?.({ percent: 70, stage: "Saving index metadata…" });
    const { error: del0 } = await supabase
      .from("embeddings")
      .delete()
      .eq("repository_id", repositoryId);
    if (del0) {
      throw new Error(del0.message);
    }

    const emptyAt = new Date().toISOString();
    const { error: metaErr } = await supabase
      .from("repositories")
      .update({
        indexed_at: emptyAt,
        indexed_commit_sha: commitSha,
      })
      .eq("id", repositoryId);

    if (metaErr) {
      throw new Error(metaErr.message);
    }

    onProgress?.({ percent: 100, stage: "Done." });

    return { commit_sha: commitSha, chunk_count: 0, indexed_at: emptyAt };
  }

  onProgress?.({ percent: 24, stage: "Clearing old vectors for this repository…" });

  const { error: delErr } = await supabase
    .from("embeddings")
    .delete()
    .eq("repository_id", repositoryId);

  if (delErr) {
    throw new Error(delErr.message);
  }

  const rows: {
    repository_id: string;
    commit_sha: string;
    source_path: string;
    chunk_index: number;
    content: string;
    embedding: string;
  }[] = [];

  const batchCount = Math.max(1, Math.ceil(chunks.length / EMBED_BATCH_SIZE));

  let completedBatches = 0;

  for (
    let waveStart = 0;
    waveStart < batchCount;
    waveStart += EMBED_WAVE_CONCURRENCY
  ) {
    const wave: number[] = [];
    for (
      let w = 0;
      w < EMBED_WAVE_CONCURRENCY && waveStart + w < batchCount;
      w++
    ) {
      wave.push(waveStart + w);
    }

    const waveParts = await Promise.all(
      wave.map(async (b) => {
        const i = b * EMBED_BATCH_SIZE;
        const slice = chunks.slice(i, i + EMBED_BATCH_SIZE);
        const texts = slice.map((c) => c.text);
        const matrices = await embedTextsHuggingFaceInference(texts);
        if (matrices.length !== slice.length) {
          throw new Error("Embedding batch size mismatch");
        }
        const part: typeof rows = [];
        for (let j = 0; j < slice.length; j++) {
          const vec = matrices[j];
          if (!vec || vec.length !== HUGGINGFACE_MINILM_VECTOR_DIM) {
            throw new Error(
              `Unexpected embedding dimension (expected ${HUGGINGFACE_MINILM_VECTOR_DIM})`,
            );
          }
          const ch = slice[j];
          part.push({
            repository_id: repositoryId,
            commit_sha: commitSha,
            source_path: ch.path,
            chunk_index: ch.chunkIndex,
            content: ch.text,
            embedding: vectorToPgString(vec),
          });
        }
        return part;
      }),
    );

    for (const part of waveParts) {
      rows.push(...part);
    }

    completedBatches += wave.length;
    onProgress?.({
      percent: 26 + Math.floor(58 * (completedBatches / batchCount)),
      stage: `Embedding batches ${completedBatches}/${batchCount}…`,
    });
  }

  onProgress?.({ percent: 88, stage: "Saving vectors to the database…" });

  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
    const { error: insErr } = await supabase.from("embeddings").insert(batch);
    if (insErr) {
      throw new Error(insErr.message);
    }
  }

  const indexedAt = new Date().toISOString();
  const { error: upErr } = await supabase
    .from("repositories")
    .update({
      indexed_at: indexedAt,
      indexed_commit_sha: commitSha,
    })
    .eq("id", repositoryId);

  if (upErr) {
    throw new Error(upErr.message);
  }

  onProgress?.({ percent: 100, stage: "Done." });

  return {
    commit_sha: commitSha,
    chunk_count: chunks.length,
    indexed_at: indexedAt,
  };
}

/**
 * Ensures `last_commit_sha` is present; returns SHA to use as Git ref for GitHub API + storage.
 */
export async function resolveCommitShaForIndexing(
  supabase: ServerSupabaseClient,
  repo: {
    id: string;
    github_owner: string;
    github_repo: string;
    last_commit_sha: string | null;
    default_branch: string | null;
  },
): Promise<string | null> {
  let lastCommit = repo.last_commit_sha?.trim() || null;

  if (!lastCommit) {
    const patch = await fetchGithubRepoMetadataPatch(
      repo.github_owner,
      repo.github_repo,
    );
    if (patch?.last_commit_sha?.trim()) {
      lastCommit = patch.last_commit_sha.trim();
      await supabase
        .from("repositories")
        .update({
          ...patch,
        })
        .eq("id", repo.id);
    }
  }

  if (!lastCommit) {
    const branch = repo.default_branch?.trim();
    if (branch) {
      const sha = await fetchBranchHeadSha(
        repo.github_owner,
        repo.github_repo,
        branch,
      );
      if (sha) {
        lastCommit = sha;
        const updated_at = new Date().toISOString();
        await supabase
          .from("repositories")
          .update({ last_commit_sha: sha, updated_at })
          .eq("id", repo.id);
      }
    }
  }

  return lastCommit;
}
