import "server-only";

import { chunkRagSourceFiles, type RagTextChunk } from "@/lib/ai/chunk-text";
import { fetchRagSourceFilesFromGithub } from "@/lib/github/rag-fetch-sources";

/**
 * Pull important GitHub files for {@param ref} and split into RAG chunks (not embedded).
 */
export async function buildRagChunksForGithubRepo(
  owner: string,
  repo: string,
  ref: string,
): Promise<RagTextChunk[]> {
  const files = await fetchRagSourceFilesFromGithub(owner, repo, ref);
  return chunkRagSourceFiles(files);
}
