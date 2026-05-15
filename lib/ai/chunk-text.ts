/**
 * RAG chunking: fixed-size windows with overlap (character-based).
 */

export const DEFAULT_RAG_CHUNK_MAX_CHARS = 2_000;
export const DEFAULT_RAG_CHUNK_OVERLAP = 200;

/**
 * Split plain text into overlapping chunks for embedding.
 * Empty / whitespace-only input yields no chunks.
 */
export function chunkPlainTextForRag(
  text: string,
  options?: { maxChars?: number; overlap?: number },
): string[] {
  const maxChars = options?.maxChars ?? DEFAULT_RAG_CHUNK_MAX_CHARS;
  const overlap = options?.overlap ?? DEFAULT_RAG_CHUNK_OVERLAP;

  const t = text.replace(/\r\n/g, "\n").trim();
  if (!t) return [];

  if (t.length <= maxChars) {
    return [t];
  }

  const chunks: string[] = [];
  let start = 0;
  const step = Math.max(1, maxChars - overlap);

  while (start < t.length) {
    const end = Math.min(start + maxChars, t.length);
    chunks.push(t.slice(start, end));
    if (end >= t.length) break;
    start += step;
  }

  return chunks;
}

export type RagSourceFile = {
  /** Repo-relative POSIX path */
  path: string;
  text: string;
};

export type RagTextChunk = {
  path: string;
  chunkIndex: number;
  /** Includes a short path header so retrieval + LLM know the source file */
  text: string;
};

/**
 * Chunk each file’s text; every chunk is prefixed with `File: …` for RAG context.
 */
export function chunkRagSourceFiles(
  files: readonly RagSourceFile[],
  options?: { maxChars?: number; overlap?: number },
): RagTextChunk[] {
  const out: RagTextChunk[] = [];

  const maxChars = options?.maxChars ?? DEFAULT_RAG_CHUNK_MAX_CHARS;
  const overlap = options?.overlap ?? DEFAULT_RAG_CHUNK_OVERLAP;

  for (const file of files) {
    const body = file.text.replace(/\r\n/g, "\n").trim();
    if (!body) continue;

    const header = `File: ${file.path}\n\n`;
    const innerMax = Math.max(200, maxChars - header.length);

    const parts = chunkPlainTextForRag(body, {
      maxChars: innerMax,
      overlap: Math.min(overlap, Math.floor(innerMax / 2)),
    });
    parts.forEach((part, idx) => {
      out.push({
        path: file.path,
        chunkIndex: idx,
        text: `${header}${part}`,
      });
    });
  }

  return out;
}
