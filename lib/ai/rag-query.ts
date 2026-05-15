import "server-only";

import { HUGGINGFACE_MINILM_VECTOR_DIM } from "@/lib/ai/config";
import { embedTextsHuggingFaceInference } from "@/lib/ai/huggingface-embeddings";

type ServerSupabaseClient = Awaited<
  ReturnType<typeof import("@/lib/supabase/server").createClient>
>;

export type MatchedChunkRow = {
  id: string;
  path: string;
  chunk_index: number;
  content: string;
  distance: number;
};

export const DEFAULT_RAG_MATCH_COUNT = 12;

function vectorToPgString(vec: number[]): string {
  return `[${vec.map((n) => Number(n)).join(",")}]`;
}

/**
 * Embed the user question (same model as stored chunks) and return the vector.
 */
export async function embedRagQueryText(question: string): Promise<number[]> {
  const [vec] = await embedTextsHuggingFaceInference([question]);
  if (!vec || vec.length !== HUGGINGFACE_MINILM_VECTOR_DIM) {
    throw new Error(
      `Query embedding dimension mismatch (expected ${HUGGINGFACE_MINILM_VECTOR_DIM})`,
    );
  }
  return vec;
}

/**
 * pgvector similarity search via `match_repo_embeddings` RPC.
 */
export async function matchRepositoryEmbeddings(
  supabase: ServerSupabaseClient,
  params: {
    repositoryId: string;
    commitSha: string;
    queryEmbedding: number[];
    matchCount?: number;
  },
): Promise<MatchedChunkRow[]> {
  const matchCount = params.matchCount ?? DEFAULT_RAG_MATCH_COUNT;

  const { data, error } = await supabase.rpc("match_repo_embeddings", {
    p_repository_id: params.repositoryId,
    p_commit_sha: params.commitSha,
    p_query_embedding: vectorToPgString(params.queryEmbedding),
    p_match_count: matchCount,
  });

  if (error) {
    throw new Error(error.message);
  }

  if (!Array.isArray(data)) {
    return [];
  }

  return (data as MatchedChunkRow[]).map((row) => ({
    id: String(row.id),
    path: row.path,
    chunk_index: row.chunk_index,
    content: row.content,
    distance: Number(row.distance),
  }));
}

export function buildRagPrompt(
  params: {
    repository: { owner: string; repo: string; commitSha: string };
    question: string;
    originalQuestion?: string;
    contextChunks: MatchedChunkRow[];
    readmeText?: string | null;
  },
): {
  system: string;
  user: string;
} {
  const { repository, question, originalQuestion, contextChunks, readmeText } =
    params;
  const q = (originalQuestion ?? question).toLowerCase();
  const isSummaryIntent =
    q.includes("summarize") ||
    q.includes("summary") ||
    q.includes("what this repository does") ||
    q.includes("who it is for");
  const isLocationIntent =
    /\b(where|which|location|located|path)\b/.test(q) ||
    /\b(where can i|where do i|where is)\b/.test(q);
  const isStructureIntent =
    /\b(file structure|project structure|top[- ]level|tree|directories|directory|folders?|files?)\b/.test(
      q,
    ) || /\blist\b/.test(q);
  const isChangeIntent =
    /\b(edit|update|modify|change|what to edit)\b/.test(q) ||
    /\b(where can i|where do i)\b/.test(q);
  const isMultiPartQuestion =
    /\b(and|also)\b/.test(q) ||
    ((q.match(/\?/g) ?? []).length >= 2 && q.length > 24);

  const readmeTrimmed = readmeText?.trim() || "";
  const readmeCap = isSummaryIntent ? 7_000 : 1_200;
  const readmeExcerpt =
    readmeTrimmed.length > readmeCap
      ? `${readmeTrimmed.slice(0, readmeCap)}\n\n[README truncated]`
      : readmeTrimmed;

  const repoHeader =
    `Repository: ${repository.owner}/${repository.repo}\n` +
    `Indexed commit: ${repository.commitSha}`;

  const repoPrimer = readmeExcerpt
    ? `Repository primer (README snapshot):\n${readmeExcerpt}`
    : "Repository primer (README snapshot): unavailable";

  const chunkBlocks = contextChunks
    .map(
      (c, i) =>
        `### Excerpt ${i + 1} (${c.path}, chunk ${c.chunk_index})\n${c.content}`,
    )
    .join("\n\n");

  const chunksSection =
    contextChunks.length === 0
      ? "Repository excerpts: (none)"
      : `Semantic excerpts:\n\n${chunkBlocks}`;

  const system = [
    "You are a repository assistant.",
    "Never use hardcoded or canned answers.",
    "Do not answer from prior memory or generic framework assumptions.",
    "Every factual claim must be grounded in the provided repository evidence (paths, excerpts, or repository metadata context).",
    "If evidence is insufficient for a specific claim, explicitly say you cannot verify that claim from this repository context.",
    "Answer using semantic excerpts as the primary source of truth.",
    "Use the README snapshot only as secondary high-level context.",
    "Focus on the repository/codebase, not company marketing.",
    "Prefer concrete facts from provided content and mention file paths when useful.",
    "When semantic excerpts are available, prioritize them over README phrasing.",
    "Use README details only when they are directly relevant and supported by repository code context.",
    "Do not drift into company/product background unless the user explicitly asks.",
    "Never invent file or folder paths; only mention paths that appear in the provided context.",
    "For folder/file listing questions, output only exact paths from context and say when the provided tree is capped.",
    "When listing structure, use bullet points with plain relative paths and avoid prefixes like 'dir:' or 'file:'.",
    "If the user implies a target (feature/folder/tool) without @mention, infer the most likely matching path from provided excerpts and answer directly with that path.",
    "For 'where is X' questions, prefer specific file paths over broad directories when a concrete file path exists in the provided context.",
    "If an 'Authoritative location candidates' block is present, prioritize the highest-confidence matching file path from that block.",
    isChangeIntent
      ? "For location/change questions, answer with: (1) exact path, (2) what to edit there in 1-3 bullets."
      : "",
    isMultiPartQuestion
      ? "When the user asks multiple things in one question, answer every part explicitly in separate bullets. Do not omit any sub-question."
      : "",
    "If the user asks what technology/system is used (e.g., auth, storage, queue), state the concrete technology name from repository evidence.",
    "If repository-specific workflow guidance context is provided, use it to explain exactly how to update docs and open a PR in this repository.",
    "When giving a path answer, always output a full repository-relative path (with '/' separators), not only a filename.",
    "Do not mention retrieval internals (e.g., 'semantic excerpts' or 'context not provided') in the final answer.",
    "Never guess from generic framework knowledge when the repository evidence does not support it.",
    "Do not recommend external docs unless the user explicitly asks for external references.",
    "If something is genuinely unavailable in the provided content, say that briefly.",
    isLocationIntent
      ? "For this question type, prioritize internal repository paths and avoid external URLs."
      : "",
    isSummaryIntent
      ? isStructureIntent
        ? "For repository summaries, output: (1) one-sentence purpose, (2) who this repo is for, (3) key capabilities in bullets, (4) project structure with file/directory references."
        : "For repository summaries, output: (1) one-sentence purpose, (2) who this repo is for, (3) key capabilities in bullets, (4) key implementation areas from code excerpts. Do not dump broad file/folder listings unless the user asked for structure."
      : "",
  ].join(" ");

  const user = [repoHeader, chunksSection, repoPrimer, `Question: ${question}`].join(
    "\n\n",
  );

  return { system, user };
}
