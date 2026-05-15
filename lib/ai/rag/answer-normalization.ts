import type { RepoTreePaths } from "@/lib/github/repo-tree";

function normalizeTreePathToken(raw: string): string {
  return raw
    .trim()
    .replace(/^`+|`+$/g, "")
    .replace(/^["'([{]+|["')\]}.,;:!?]+$/g, "")
    .replace(/^\.?\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function extractPathCandidatesFromLine(line: string): string[] {
  const out = new Set<string>();
  const slashPathRegex =
    /(^|[\s`([{"'])([a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)+\/?)(?=$|[\s`)\]}",.:;!?'])/g;
  for (const match of line.matchAll(slashPathRegex)) {
    const token = (match[2] ?? "").trim();
    if (!token) continue;
    out.add(token);
  }
  const backtickPathRegex = /`([^`\n]*\/[^`\n]*)`/g;
  for (const match of line.matchAll(backtickPathRegex)) {
    const token = (match[1] ?? "").trim();
    if (!token) continue;
    out.add(token);
  }
  return [...out];
}

function removeUnverifiedPathLines(answer: string, tree: RepoTreePaths): {
  answer: string;
  removedCount: number;
} {
  const verifiedPaths = new Set<string>(
    [...tree.files, ...tree.dirs].map((path) => path.toLowerCase()),
  );
  let removedCount = 0;
  const kept = answer
    .split("\n")
    .filter((line) => {
      const candidates = extractPathCandidatesFromLine(line);
      if (candidates.length === 0) return true;
      const hasInvalidPath = candidates.some((candidate) => {
        const normalized = normalizeTreePathToken(candidate);
        return normalized.length > 0 && !verifiedPaths.has(normalized);
      });
      if (!hasInvalidPath) return true;
      if (
        /^\s*[-*]\s+/.test(line) ||
        /^\s*\d+\.\s+/.test(line) ||
        /^\s*exact path\s*:/i.test(line)
      ) {
        removedCount += 1;
        return false;
      }
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { answer: kept, removedCount };
}

function isModelContextQuestion(question: string): boolean {
  const q = question.toLowerCase();
  return (
    /\b(exact|what|which|list|show|explain)\b.*\b(context|data sources?|evidence|sent|passed)\b.*\b(ai|model|prompt)\b/.test(
      q,
    ) ||
    /\bwhat\b.*\b(context|data sources?)\b.*\bsent\b/.test(q) ||
    /\bmodel context manifest\b/.test(q)
  );
}

function removeLeakedContextManifest(answer: string): string {
  const manifestLine =
    /^\s*(?:[-*]\s*)?(?:system instructions from buildRagPrompt|repository header: owner, repo, indexed commit SHA|semantic RAG chunks:|user question enriched with request date context|prior chat history:|saved repository metadata snapshot|cached repository AI summary|focused GitHub commit detail|question-targeted live GitHub facts|recent default-branch commits|resolved mentioned path kinds|direct file\/folder context|authoritative location candidates|keyword location candidates|inferred keyword context|repository implementation signals|repository workflow docs|repository tree snapshot|Model context manifest for this request)/i;

  return answer
    .split("\n")
    .filter((line) => !manifestLine.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeRagAnswer(params: {
  answer: string;
  question: string;
  locationLookupIntent: boolean;
  authoritativeLocationPaths: string[];
  allowExternalLinks: boolean;
  verifiedTree?: RepoTreePaths | null;
}): string {
  let out = params.answer.trim();
  if (!out) return out;

  if (!isModelContextQuestion(params.question)) {
    out = removeLeakedContextManifest(out);
  }

  if (!params.allowExternalLinks) {
    out = out.replace(/https?:\/\/[^\s)]+/gi, "").replace(/[ \t]+\n/g, "\n");
  }

  if (
    params.locationLookupIntent &&
    params.authoritativeLocationPaths.length > 0
  ) {
    const byBase = new Map<string, string[]>();
    for (const path of params.authoritativeLocationPaths) {
      const base = path.split("/").pop()?.toLowerCase() ?? "";
      if (!base) continue;
      const list = byBase.get(base) ?? [];
      list.push(path);
      byBase.set(base, list);
    }

    out = out.replace(
      /\b([a-zA-Z0-9._-]+\.(?:md|mdx|txt|tsx|ts|js|jsx|json|yml|yaml))\b/g,
      (match, fileNameRaw) => {
        const fileName = String(fileNameRaw).toLowerCase();
        const hits = byBase.get(fileName) ?? [];
        if (hits.length === 1) return hits[0] ?? match;
        return match;
      },
    );

    const primaryPath = params.authoritativeLocationPaths[0];
    const hasFullPath =
      /(?:^|[\s`([])([a-zA-Z0-9._-]+\/[a-zA-Z0-9._/-]*[a-zA-Z0-9._-]+)/.test(
        out,
      );
    if (primaryPath && !hasFullPath) {
      out = `Exact path: ${primaryPath}\n\n${out}`;
    } else if (primaryPath && !out.includes(primaryPath)) {
      out = `Exact path: ${primaryPath}\n\n${out}`;
    }
  }

  if (params.verifiedTree) {
    const filtered = removeUnverifiedPathLines(out, params.verifiedTree);
    out = filtered.answer;
  }

  if (!out.trim()) {
    return "I can't verify a repository-grounded answer for this question yet.";
  }

  return out.trim();
}

export function deriveChatTitleFromQuestion(question: string): string {
  const oneLine = question.replace(/\s+/g, " ").trim();
  if (!oneLine) return "New chat";
  return oneLine.slice(0, 120);
}
