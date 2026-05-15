import type { RepoRootEntry } from "@/lib/github/fetch-repo-root-contents";

const segmentPath = (path: string | undefined | null) => {
  const raw = (path ?? "").trim();
  if (!raw) return "";
  return raw
    .split("/")
    .flatMap((segment) => {
      const s = segment.trim();
      return s ? [encodeURIComponent(s)] : [];
    })
    .join("/");
};

/** GitHub “Code” viewer URL for a repo-root entry (`tree/` or `blob/`). */
export function githubRootEntryHref(
  owner: string,
  repo: string,
  ref: string | undefined | null,
  entry: RepoRootEntry,
): string {
  const safeRef =
    typeof ref === "string" ? ref.trim() : "";
  const refSegment =
    safeRef !== "" ? encodeURIComponent(safeRef) : "HEAD";

  const pathRaw =
    typeof entry.path === "string" && entry.path.trim() !== ""
      ? entry.path
      : (entry.name ?? "");
  const pathPart = segmentPath(pathRaw);

  if (entry.kind === "dir" || entry.kind === "submodule") {
    const suffix = pathPart ? `/${pathPart}` : "";
    return `https://github.com/${owner}/${repo}/tree/${refSegment}${suffix}`;
  }

  const blobSuffix = pathPart ? `/${pathPart}` : "";
  return `https://github.com/${owner}/${repo}/blob/${refSegment}${blobSuffix}`;
}
