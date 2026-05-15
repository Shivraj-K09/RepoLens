import { createClient } from "@/lib/supabase/server";

import { fetchCachedRepoTreePaths } from "./cache";
import { scorePathWithHints } from "./query-hints";

type PathHintChunkRow = {
  id: string;
  source_path: string;
  chunk_index: number;
  content: string;
};

type RetrievedChunk = {
  id: string;
  path: string;
  chunk_index: number;
  content: string;
  distance: number;
};

export async function fetchHintPathChunks(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  repositoryId: string;
  commitSha: string;
  hints: string[];
}): Promise<RetrievedChunk[]> {
  const out: RetrievedChunk[] = [];

  const results = await Promise.all(
    params.hints.map(async (hint) => {
      const { data, error } = await params.supabase
        .from("embeddings")
        .select("id, source_path, chunk_index, content")
        .eq("repository_id", params.repositoryId)
        .eq("commit_sha", params.commitSha)
        .ilike("source_path", `%${hint}%`)
        .order("chunk_index", { ascending: true })
        .limit(6);
      if (error || !Array.isArray(data)) return [] as PathHintChunkRow[];
      return data as PathHintChunkRow[];
    }),
  );
  for (const rows of results) {
    for (const row of rows) {
      out.push({
        id: String(row.id),
        path: row.source_path,
        chunk_index: Number(row.chunk_index),
        content: row.content,
        distance: -1,
      });
    }
  }

  return out;
}

export async function fetchKeywordPathChunks(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  repositoryId: string;
  commitSha: string;
  keywordHints: string[];
}): Promise<RetrievedChunk[]> {
  const out: RetrievedChunk[] = [];

  const results = await Promise.all(
    params.keywordHints.map(async (hint) => {
      const { data, error } = await params.supabase
        .from("embeddings")
        .select("id, source_path, chunk_index, content")
        .eq("repository_id", params.repositoryId)
        .eq("commit_sha", params.commitSha)
        .ilike("source_path", `%${hint}%`)
        .order("chunk_index", { ascending: true })
        .limit(28);

      if (error || !Array.isArray(data)) {
        return [] as RetrievedChunk[];
      }
      const ranked = (data as PathHintChunkRow[])
        .map((row) => ({
          row,
          score: scorePathWithHints(row.source_path, [hint]),
        }))
        .sort((a, b) => {
          if (a.score !== b.score) return b.score - a.score;
          if (a.row.source_path !== b.row.source_path) {
            return a.row.source_path.localeCompare(b.row.source_path);
          }
          return a.row.chunk_index - b.row.chunk_index;
        })
        .slice(0, 8);
      return ranked.map(({ row }) => ({
        id: String(row.id),
        path: row.source_path,
        chunk_index: Number(row.chunk_index),
        content: row.content,
        distance: -0.5,
      }));
    }),
  );
  for (const rows of results) {
    out.push(...rows);
  }

  return out.slice(0, 16);
}

export async function inferLikelyPathsFromTree(params: {
  owner: string;
  repo: string;
  commitSha: string;
  keywordHints: string[];
  question: string;
}): Promise<string[]> {
  const tree = await fetchCachedRepoTreePaths({
    owner: params.owner,
    repo: params.repo,
    commitSha: params.commitSha,
  });
  if (!tree) return [];

  const q = params.question.toLowerCase();
  const searchTerms = new Set<string>();
  for (const hint of params.keywordHints) {
    if (hint.length >= 3) searchTerms.add(hint.toLowerCase());
  }
  if (/\binstall|installation|setup\b/.test(q)) {
    searchTerms.add("install");
    searchTerms.add("installation");
    searchTerms.add("setup");
  }
  if (/\bdoc|docs|documentation\b/.test(q)) {
    searchTerms.add("doc");
    searchTerms.add("docs");
    searchTerms.add("documentation");
  }
  if (/\bmdx\b/.test(q)) searchTerms.add("mdx");
  if (/\bgetting started\b/.test(q)) {
    searchTerms.add("getting");
    searchTerms.add("started");
    searchTerms.add("getting-started");
  }

  const allPaths = [...tree.files, ...tree.dirs];
  const candidates: string[] = [];
  for (const path of allPaths) {
    const p = path.toLowerCase();
    let anyMatch = false;
    for (const term of searchTerms) {
      if (p.includes(term)) {
        anyMatch = true;
        break;
      }
    }
    if (anyMatch) candidates.push(path);
  }

  const scored = candidates
    .map((path) => {
      const p = path.toLowerCase();
      let score = scorePathWithHints(path, [...searchTerms]);
      if (p.startsWith("docs/")) score += 45;
      if (/\.(md|mdx)$/.test(p)) score += 25;
      if (p.includes("installation")) score += 120;
      if (p.includes("getting-started")) score += 50;
      if (p.includes("01-installation")) score += 120;
      if (p.includes("/index.mdx")) score -= 25;
      if (tree.files.includes(path)) score += 12;
      return { path, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.path.localeCompare(b.path);
    })
    .slice(0, 8)
    .map((row) => row.path);

  return scored;
}

export function buildAuthoritativeLocationContext(paths: string[]): string {
  if (paths.length === 0) return "";
  return [
    "Authoritative location candidates from repository paths:",
    ...paths.map((path) => `- ${path}`),
  ].join("\n");
}

export function buildKeywordLocationCandidateContext(params: {
  chunks: { path: string; distance: number }[];
  keywordHints: string[];
  question: string;
}): string {
  if (params.keywordHints.length === 0 || params.chunks.length === 0) return "";
  const q = params.question.toLowerCase();
  const needDocs = /\b(doc|docs|documentation)\b/.test(q);
  const needInstall = /\b(install|installation|setup|getting started)\b/.test(q);
  const byPath = new Map<
    string,
    { path: string; bestDistance: number; score: number }
  >();
  for (const row of params.chunks) {
    const prev = byPath.get(row.path);
    const score = scorePathWithHints(row.path, params.keywordHints);
    if (prev) {
      prev.bestDistance = Math.min(prev.bestDistance, row.distance);
      prev.score = Math.max(prev.score, score);
      continue;
    }
    byPath.set(row.path, { path: row.path, bestDistance: row.distance, score });
  }
  const ranked = [...byPath.values()]
    .map((row) => {
      let score = row.score;
      const p = row.path.toLowerCase();
      if (needDocs && p.includes("doc")) score += 30;
      if (needInstall && /install|installation|getting-started|setup/.test(p)) {
        score += 45;
      }
      if (/\.(md|mdx|txt)$/.test(p)) score += 20;
      return { ...row, score };
    })
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.bestDistance !== b.bestDistance) {
        return a.bestDistance - b.bestDistance;
      }
      return a.path.localeCompare(b.path);
    })
    .slice(0, 10);

  if (ranked.length === 0) return "";
  return [
    "Likely matching repository paths for this location question:",
    ranked.map((r) => `- ${r.path}`).join("\n"),
  ].join("\n");
}

