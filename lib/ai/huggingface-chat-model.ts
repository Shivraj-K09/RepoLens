import "server-only";

import { createHuggingFace } from "@ai-sdk/huggingface";

import {
  getHuggingFaceChatModelId,
  requireHuggingFaceApiKey,
} from "@/lib/ai/config";

/**
 * Language model for chat / RAG answers via **Hugging Face** (`@ai-sdk/huggingface` → Router / Responses API).
 * Use with `generateText` / `streamText` from `ai`.
 */
export function getHuggingFaceChatLanguageModel() {
  const hf = createHuggingFace({
    apiKey: requireHuggingFaceApiKey(),
  });

  return hf.languageModel(getHuggingFaceChatModelId());
}
