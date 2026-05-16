import { createClient } from "@/lib/supabase/server";

export type SavedRepositoryIdRow = {
  id: string;
  github_owner: string;
  github_repo: string;
};

export type SavedRepositoryIndexingRow = SavedRepositoryIdRow & {
  last_commit_sha: string | null;
  default_branch: string | null;
  indexed_commit_sha: string | null;
  indexed_at: string | null;
};

export type SavedRepoAccessResult =
  | { status: "ok"; row: SavedRepositoryIdRow }
  | { status: "not_saved" }
  | { status: "db_error"; message: string };

export type SavedRepoIndexingResult =
  | { status: "ok"; row: SavedRepositoryIndexingRow }
  | { status: "not_saved" }
  | { status: "db_error"; message: string };

/** Returns canonical owner/repo casing from DB row if user saved this repo. */
export async function requireSavedRepoAccess(
  userId: string,
  githubOwnerNorm: string,
  githubRepoNorm: string,
): Promise<SavedRepoAccessResult> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("repositories")
    .select("id, github_owner, github_repo")
    .eq("user_id", userId)
    .eq("github_owner_norm", githubOwnerNorm.toLowerCase())
    .eq("github_repo_norm", githubRepoNorm.toLowerCase())
    .maybeSingle();

  if (error) {
    return { status: "db_error", message: error.message };
  }
  if (!data) {
    return { status: "not_saved" };
  }

  return { status: "ok", row: data };
}

/** Same lookup as {@link requireSavedRepoAccess} with fields needed to index embeddings. */
export async function getSavedRepositoryForIndexing(
  userId: string,
  githubOwnerNorm: string,
  githubRepoNorm: string,
): Promise<SavedRepoIndexingResult> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("repositories")
    .select(
      "id, github_owner, github_repo, last_commit_sha, default_branch, indexed_commit_sha, indexed_at",
    )
    .eq("user_id", userId)
    .eq("github_owner_norm", githubOwnerNorm.toLowerCase())
    .eq("github_repo_norm", githubRepoNorm.toLowerCase())
    .maybeSingle();

  if (error) {
    return { status: "db_error", message: error.message };
  }
  if (!data) {
    return { status: "not_saved" };
  }

  return { status: "ok", row: data as SavedRepositoryIndexingRow };
}
