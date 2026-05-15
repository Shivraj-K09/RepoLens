import "server-only";

import { generateText } from "ai";

import { getHuggingFaceChatLanguageModel } from "@/lib/ai/huggingface-chat-model";

export type RepoAiSummaryInput = {
  owner: string;
  repo: string;
  description: string | null;
  defaultBranch: string | null;
  readmeExcerpt: string | null;
  techStackLabels: readonly string[];
  languageLabels: readonly string[];
  /** e.g. "TypeScript 62.1%, JavaScript 21.3%, ..." */
  languageMixLine: string | null;
  topics: readonly string[];
  license: string | null;
};

const README_MAX_CHARS = 20_000;

export function excerptReadme(readme: string | null): string | null {
  if (!readme?.trim()) return null;
  const t = readme.trim();
  if (t.length <= README_MAX_CHARS) return t;
  return `${t.slice(0, README_MAX_CHARS)}\n\n…`;
}

export async function generateRepoAiSummaryMarkdown(
  input: RepoAiSummaryInput,
): Promise<string> {
  const model = getHuggingFaceChatLanguageModel();
  const repoFullName = `${input.owner}/${input.repo}`;

  const facts = [
    `Repository: ${repoFullName}`,
    input.description ? `Short description (GitHub): ${input.description}` : null,
    input.defaultBranch ? `Default branch: ${input.defaultBranch}` : null,
    input.license ? `SPDX license (if detected): ${input.license}` : null,
    input.languageMixLine
      ? `Primary languages by share of repo bytes (GitHub Linguist): ${input.languageMixLine}`
      : null,
    input.languageLabels.length > 0 && !input.languageMixLine
      ? `Language names (GitHub Linguist, by bytes): ${input.languageLabels.join(", ")}`
      : null,
    input.techStackLabels.length > 0
      ? `Tooling/ecosystems inferred from manifest files (best-effort): ${input.techStackLabels.join(", ")}`
      : null,
    input.topics.length > 0
      ? `GitHub topic tags: ${input.topics.join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const readmeBlock = input.readmeExcerpt
    ? `\nREADME excerpt:\n'''\n${input.readmeExcerpt}\n'''\n`
    : "\nNo README excerpt was available.\n";

  const { text } = await generateText({
    model,
    maxOutputTokens: 6144,
    temperature: 0.16,
    system:
      "You write accurate repository documentation for engineers. Every claim must be supported by the README excerpt or the facts list below it. If something is not in those sources, omit it or say briefly that it is not documented — do not invent APIs, sponsors, metrics, roadmap, maintainers, security posture, or download counts. Output GitHub-flavored Markdown: ## headings, short paragraphs, tight bullets, **bold** for a few key terms only. Never mention AI, models, or how this text was produced. No 'In conclusion', 'This README', or duplicate bullet lists across sections. No git clone blocks or long shell scripts. Do not recite topic tags as a prose list; weave them in naturally only when helpful. Treat Linguist language percentages as approximate file-type mix, not proof of runtime behavior.",
    prompt: `Write a concise overview of this GitHub repository.

Facts (may be partial):
${facts}
${readmeBlock}

Use these ## headings in **this exact order**, with **no other top-level ## headings**:
## Overview
## What it does
## Tech & structure
## Setup & usage

Add **## Notes** only when you have **at least one** concrete bullet (gap, risk, or caveat) supported by the README or facts. If you have nothing to say, **omit the Notes section entirely** — no heading, no body. **Never** use a lone dash, hyphen, em dash, “N/A”, “None”, or empty placeholder under Notes.

**Length:** about **280–520 words** when the README is substantive; shorter when the README is thin. Prefer density over padding.

**Sections:**
- **Overview**: 2–4 sentences: purpose and audience, grounded in README + description.
- **What it does**: one short intro sentence then **3–6 bullets** of behavior/features; only from README; prefix uncertain items with "Appears to:" or "Likely:".
- **Tech & structure**: **2–5 bullets** on stack and how pieces connect; use manifest-inferred tooling only as labeled; avoid repeating the full language percentage string — at most one short phrase on dominant languages if it matters.
- **Setup & usage**: copy exact commands from README when present; if missing, 1–2 bullets on what is not documented.
- **Notes** (optional): only **1–3 bullets** when substantive; otherwise skip the whole section.

Do not cite star counts, fork counts, repo size, or any aggregated 'total commits' number unless that exact number appears verbatim in the README excerpt.`,
  });

  return text.trim();
}
