import "server-only";

import {
  getHuggingFaceEmbeddingModelId,
  requireHuggingFaceApiKey,
} from "@/lib/ai/config";

/**
 * Hugging Face **Inference** embeddings.
 * The legacy `api-inference.huggingface.co/models/...` endpoint returns **404** for many models;
 * the current serverless/router path is under `router.huggingface.co/hf-inference/models/...`.
 * Use path segments for `org/model` (slashes), do not encode the whole id as one segment.
 *
 * **Important:** For sentence-transformer models the router serves both **feature-extraction**
 * and **sentence-similarity** at different paths. You must call
 * `…/models/{model}/pipeline/feature-extraction` — not bare `…/models/{model}` — or the
 * server picks sentence-similarity and fails with a missing `sentences` argument (400).
 * Optional: `{"inputs": ["a","b"]}` is valid for **feature-extraction** batching; the wrong
 * pipeline rejects array inputs.
 *
 * @see https://huggingface.co/docs/inference-providers/en/index
 */

const SINGLE_REQUEST_CONCURRENCY = Math.max(
  1,
  Number.parseInt(
    process.env.HUGGINGFACE_EMBED_SINGLE_REQUEST_CONCURRENCY ?? "6",
    10,
  ) || 6,
);

/**
 * HF router requires an explicit pipeline segment for MiniLM-style models; otherwise requests
 * hit sentence-similarity and return 400 (`sentences` missing). Matches
 * `@huggingface/inference` (`models/{id}/pipeline/feature-extraction`).
 *
 * `HUGGINGFACE_INFERENCE_BASE` is the **router root** ending in `hf-inference`, for example
 * `https://router.huggingface.co/hf-inference`. Values that end with `/models` (older docs)
 * are normalized so we do not duplicate path segments.
 */
function embeddingRouterFeatureExtractionUrl(modelId: string): string {
  let base =
    process.env.HUGGINGFACE_INFERENCE_BASE?.trim() ||
    "https://router.huggingface.co/hf-inference";
  base = base.replace(/\/$/, "");
  if (base.endsWith("/models")) {
    base = base.slice(0, -"/models".length);
  }
  return `${base}/models/${modelId}/pipeline/feature-extraction`;
}

/** Classic serverless Inference API (may support batch `inputs` for some models). */
function embeddingLegacyUrl(modelId: string): string {
  return `https://api-inference.huggingface.co/models/${modelId}`;
}

function meanPool(seq: number[][]): number[] {
  if (seq.length === 0) return [];
  const dim = seq[0]?.length ?? 0;
  const acc = new Array(dim).fill(0);
  for (const row of seq) {
    for (let i = 0; i < dim; i++) {
      acc[i] += row[i] ?? 0;
    }
  }
  return acc.map((v) => v / seq.length);
}

/**
 * Normalize HF JSON into `batchSize` rows of pooled float vectors.
 */
function toEmbeddingRows(data: unknown, batchSize: number): number[][] {
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(
      "Hugging Face embedding response was empty or not an array",
    );
  }

  // One flat vector — single input
  if (typeof data[0] === "number") {
    if (batchSize !== 1) {
      throw new Error("Unexpected single vector for batched inputs");
    }
    return [data as number[]];
  }

  const first = data[0] as unknown;

  // Matrix [seq][dim] — one sequence (mean-pool) or batch of row vectors
  if (Array.isArray(first) && typeof (first as number[])[0] === "number") {
    const rows = data as number[][];
    if (rows.length === batchSize) {
      return rows;
    }
    if (batchSize === 1) {
      return [meanPool(rows)];
    }
    throw new Error("Embedding row count does not match batch size");
  }

  // 3D [batch][seq][dim]
  if (
    Array.isArray(first) &&
    Array.isArray((first as unknown[])[0]) &&
    typeof ((first as number[][])[0] as number[])[0] === "number"
  ) {
    const batch = data as number[][][];
    if (batch.length !== batchSize) {
      throw new Error("Embedding batch dimension mismatch");
    }
    return batch.map(meanPool);
  }

  throw new Error("Unexpected Hugging Face embedding response shape");
}

function isSentenceSimilarityBatchError(status: number, body: string): boolean {
  if (status !== 400) return false;
  const b = body.toLowerCase();
  return (
    b.includes("sentences") ||
    b.includes("sentence_similarity") ||
    b.includes("sentencesimilarity")
  );
}

async function fetchEmbeddingForText(
  url: string,
  apiKey: string,
  text: string,
): Promise<number[]> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ inputs: text }),
  });

  const detail = await res.text().catch(() => "");

  if (!res.ok) {
    throw new Error(
      `Hugging Face embedding request failed (${res.status}): ${detail.slice(0, 500)}`,
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(detail) as unknown;
  } catch {
    throw new Error("Hugging Face embedding response was not JSON");
  }

  const rows = toEmbeddingRows(data, 1);
  const row = rows[0];
  if (!row) {
    throw new Error("Hugging Face returned no embedding row");
  }
  return row;
}

/**
 * Run async work with a fixed concurrency limit (pool over `items`).
 */
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      const item = items[i];
      if (item === undefined) break;
      results[i] = await fn(item, i);
    }
  }

  const n = Math.min(concurrency, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

/**
 * Embed many strings. Batch POST is attempted only when
 * `HUGGINGFACE_EMBEDDING_TRY_BATCH=1` — otherwise we use concurrent single-input
 * requests compatible with router feature extraction.
 */
export async function embedTextsHuggingFaceInference(
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const apiKey = requireHuggingFaceApiKey();
  const model = getHuggingFaceEmbeddingModelId();
  const routerUrl = embeddingRouterFeatureExtractionUrl(model);
  const legacyUrl = embeddingLegacyUrl(model);

  const tryBatch = process.env.HUGGINGFACE_EMBEDDING_TRY_BATCH?.trim() === "1";

  if (tryBatch && texts.length > 1) {
    const res = await fetch(routerUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inputs: texts }),
    });
    const detail = await res.text().catch(() => "");
    if (res.ok) {
      try {
        const data: unknown = JSON.parse(detail);
        return toEmbeddingRows(data, texts.length);
      } catch {
        /* fall through to singles */
      }
    } else if (!isSentenceSimilarityBatchError(res.status, detail)) {
      throw new Error(
        `Hugging Face embedding request failed (${res.status}): ${detail.slice(0, 500)}`,
      );
    }
  }

  async function embedViaRouter(): Promise<number[][]> {
    return mapPool(texts, SINGLE_REQUEST_CONCURRENCY, (text) =>
      fetchEmbeddingForText(routerUrl, apiKey, text),
    );
  }

  async function embedViaLegacy(): Promise<number[][]> {
    return mapPool(texts, SINGLE_REQUEST_CONCURRENCY, (text) =>
      fetchEmbeddingForText(legacyUrl, apiKey, text),
    );
  }

  try {
    return await embedViaRouter();
  } catch (routerErr) {
    try {
      return await embedViaLegacy();
    } catch {
      throw routerErr;
    }
  }
}
