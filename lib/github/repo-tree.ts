import { createOctokit } from "@/lib/github/octokit";

function isHttp404(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: number }).status === 404
  );
}

export type RepoTreePaths = {
  files: string[];
  dirs: string[];
  truncated: boolean;
};

/**
 * Fetch recursive repository tree for a ref (branch/tag/commit).
 * Uses Git data APIs (commit -> tree recursive), which is much faster than
 * per-directory Contents traversal for mention/autocomplete inventories.
 */
export async function githubListRepoTreePaths(
  owner: string,
  repo: string,
  ref: string,
): Promise<RepoTreePaths | null> {
  const trimmedRef = ref.trim();
  if (!trimmedRef) return null;

  const octokit = createOctokit();
  try {
    const commit = await octokit.rest.repos.getCommit({
      owner,
      repo,
      ref: trimmedRef,
    });
    const treeSha = commit.data.commit.tree.sha;
    if (!treeSha) return null;

    const treeRes = await octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: treeSha,
      recursive: "1",
    });

    const files: string[] = [];
    const dirs = new Set<string>();

    for (const node of treeRes.data.tree ?? []) {
      const path = node.path?.trim();
      if (!path) continue;
      if (node.type === "blob") {
        files.push(path);
      } else if (node.type === "tree") {
        dirs.add(path);
      }
    }

    const sortedFiles = files.toSorted((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
    const dirList = [...dirs].toSorted((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );

    return {
      files: sortedFiles,
      dirs: dirList,
      truncated: Boolean(treeRes.data.truncated),
    };
  } catch (err) {
    if (isHttp404(err)) return { files: [], dirs: [], truncated: false };
    console.warn("[githubListRepoTreePaths]", err);
    return null;
  }
}
