import "server-only";

/**
 * Phase 4 — model configuration (server-only).
 *
 * **Chat / LLM:** Hugging Face via `@ai-sdk/huggingface` (`createHuggingFace` → `languageModel`).
 * Set `HUGGINGFACE_API_KEY` + optional `HUGGINGFACE_CHAT_MODEL` (see `huggingface-chat-model.ts`).
 *
 * **Embeddings (RAG):** `POST` to the Inference router's feature-extraction pipeline
 * (`lib/ai/huggingface-embeddings.ts` — `…/models/{id}/pipeline/feature-extraction`);
 * optional `HUGGINGFACE_INFERENCE_BASE` overrides the router root (must end in `hf-inference`).
 */

export const DEFAULT_HUGGINGFACE_CHAT_MODEL =
  "meta-llama/Llama-3.1-8B-Instruct";

export const DEFAULT_HUGGINGFACE_EMBEDDING_MODEL =
  "sentence-transformers/all-MiniLM-L6-v2";

/** Must match `vector(…)` in `supabase/manual/phase4-embeddings-pgvector.sql`. */
export const HUGGINGFACE_MINILM_VECTOR_DIM = 384;

export function getHuggingFaceChatModelId(): string {
  const id = process.env.HUGGINGFACE_CHAT_MODEL?.trim();
  return id || DEFAULT_HUGGINGFACE_CHAT_MODEL;
}

export function getHuggingFaceEmbeddingModelId(): string {
  const id = process.env.HUGGINGFACE_EMBEDDING_MODEL?.trim();
  return id || DEFAULT_HUGGINGFACE_EMBEDDING_MODEL;
}

export function requireHuggingFaceApiKey(): string {
  const key = process.env.HUGGINGFACE_API_KEY?.trim();
  if (!key) {
    throw new Error("Missing HUGGINGFACE_API_KEY (chat + embeddings).");
  }
  return key;
}
