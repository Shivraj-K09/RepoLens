import { fetchGithubRepoMetadataPatch } from "@/lib/github/fetch-repo-metadata";
import { formatStarsCompact } from "@/lib/format/compact-metric";
import type { createClient } from "@/lib/supabase/server";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export type SidebarRepoVisit = {
  /** Stable React key — repository UUID. */
  id: string;
  ownerDisplay: string;
  repoDisplay: string;
  href: string;
  avatarUrl: string;
  starsLabel: string;
};

function sidebarVisitFromRepoRow(
  repositoryId: string,
  owner: string,
  repo: string,
): Pick<
  SidebarRepoVisit,
  "id" | "ownerDisplay" | "repoDisplay" | "href" | "avatarUrl"
> {
  const slugOwner = encodeURIComponent(owner);
  const slugRepo = encodeURIComponent(repo);
  return {
    id: repositoryId,
    ownerDisplay: owner,
    repoDisplay: repo,
    href: `/repo/${slugOwner}/${slugRepo}`,
    avatarUrl: `https://github.com/${encodeURIComponent(owner)}.png?size=64`,
  };
}

export async function recordRepositoryVisit(
  supabase: SupabaseServerClient,
  userId: string,
  repositoryId: string,
) {
  const opened = new Date().toISOString();
  const { error } = await supabase.from("repository_history").upsert(
    {
      user_id: userId,
      repository_id: repositoryId,
      last_viewed_at: opened,
    },
    { onConflict: "user_id,repository_id" },
  );

  if (error && process.env.NODE_ENV === "development") {
    console.warn("[recordRepositoryVisit]", error.message);
  }
}

/** Recent repo opens for sidebar (newest first). */
export async function fetchRecentRepoVisitSidebar(
  supabase: SupabaseServerClient,
  userId: string,
  limit = 18,
): Promise<SidebarRepoVisit[]> {
  const { data: historyRows, error: histError } = await supabase
    .from("repository_history")
    .select("repository_id, last_viewed_at")
    .eq("user_id", userId)
    .order("last_viewed_at", { ascending: false })
    .limit(Math.max(limit, 1) * 3);

  if (histError || !Array.isArray(historyRows) || historyRows.length === 0) {
    if (process.env.NODE_ENV === "development" && histError) {
      console.warn("[fetchRecentRepoVisitSidebar] history", histError.message);
    }
    return [];
  }

  const idsOrdered: string[] = [];
  const seenIds = new Set<string>();
  for (const row of historyRows as { repository_id?: string | null }[]) {
    const id =
      typeof row.repository_id === "string" ? row.repository_id.trim() : "";
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    idsOrdered.push(id);
  }

  if (idsOrdered.length === 0) return [];

  const { data: repoRows, error: repoError } = await supabase
    .from("repositories")
    .select("id, github_owner, github_repo, stars_count")
    .eq("user_id", userId)
    .in("id", idsOrdered);

  if (repoError || !Array.isArray(repoRows)) {
    if (process.env.NODE_ENV === "development" && repoError) {
      console.warn("[fetchRecentRepoVisitSidebar] repos", repoError.message);
    }
    return [];
  }

  type RepoRow = {
    id: string;
    github_owner: string;
    github_repo: string;
    stars_count: number | null;
  };

  const repoById = new Map(
    (repoRows as RepoRow[]).map((r) => [r.id, r]),
  );

  const needsStarHydration = (repoRows as RepoRow[]).filter(
    (row) =>
      (row.stars_count === null || row.stars_count === undefined) &&
      Boolean(row.github_owner?.trim()) &&
      Boolean(row.github_repo?.trim()),
  );

  const starsHydrated = new Map<string, number>();
  await Promise.all(
    needsStarHydration.map(async (row) => {
      const patch = await fetchGithubRepoMetadataPatch(
        row.github_owner,
        row.github_repo,
      );
      if (!patch || typeof patch.stars_count !== "number") return;
      starsHydrated.set(row.id, patch.stars_count);

      const update: Record<string, string | number> = {
        updated_at: new Date().toISOString(),
        stars_count: patch.stars_count,
      };
      if (typeof patch.forks_count === "number") {
        update.forks_count = patch.forks_count;
      }
      void supabase.from("repositories").update(update).eq("id", row.id);
    }),
  );

  const out: SidebarRepoVisit[] = [];
  const seenHref = new Set<string>();

  for (const rid of idsOrdered) {
    const r = repoById.get(rid);
    if (!r?.github_owner || !r.github_repo) continue;

    const base = sidebarVisitFromRepoRow(rid, r.github_owner, r.github_repo);
    if (seenHref.has(base.href)) continue;
    seenHref.add(base.href);

    const starsRaw =
      typeof r.stars_count === "number"
        ? r.stars_count
        : (starsHydrated.get(rid) ?? null);
    const starsLabel =
      starsRaw === null || starsRaw === undefined
        ? "—"
        : formatStarsCompact(starsRaw) || "—";

    out.push({ ...base, starsLabel });
    if (out.length >= limit) break;
  }

  return out;
}
