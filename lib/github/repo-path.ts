import { createOctokit } from "@/lib/github/octokit";

import type { RepoRootEntry } from "./fetch-repo-root-contents";

/** Max decoded size for preview (reasonable for browsers). */
const MAX_FILE_BYTES = 900_000;

function isHttp404(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: number }).status === 404
  );
}

function mapGithubNode(node: {
  type: string;
  name: string;
  path: string;
}): RepoRootEntry {
  if (node.type === "dir") {
    return { kind: "dir", name: node.name, path: node.path };
  }
  if (node.type === "file") {
    return { kind: "file", name: node.name, path: node.path };
  }
  /* submodule · symlink … */
  return { kind: "submodule", name: node.name, path: node.path };
}

/** Normalized repo-relative path (`""` root, no `./`, no `..`). */
export function normalizeRepoContentPath(raw: string | undefined | null): {
  ok: true;
  path: string;
} | { ok: false; reason: string } {
  const s = (raw ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (s === "" || s === ".") return { ok: true, path: "" };
  if (s.includes("..")) {
    return { ok: false, reason: 'Path cannot contain ".."' };
  }
  const segs = s.split("/").filter(Boolean);
  for (const seg of segs) {
    if (seg === "..") return { ok: false, reason: "Invalid segment" };
  }
  return { ok: true, path: segs.join("/") };
}

/** Directory listing via GitHub Contents API (`repos.getContent`). */
export async function githubListRepoPathContents(
  owner: string,
  repo: string,
  ref: string,
  posixPath: string,
): Promise<RepoRootEntry[] | null | "not-a-directory"> {
  const trimmedRef = ref.trim();
  if (!trimmedRef) return null;

  const octokit = createOctokit();
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: posixPath === "" ? "" : posixPath,
      ref: trimmedRef,
    });

    if (!Array.isArray(data)) {
      return "not-a-directory";
    }

    const mapped = data.map((it) =>
      mapGithubNode({
        type: it.type,
        name: it.name,
        path: it.path,
      }),
    );

    return mapped.sort((a, b) => {
      const rank = (e: RepoRootEntry) =>
        e.kind === "dir" ? 0 : e.kind === "file" ? 1 : 2;
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
  } catch (err) {
    if (isHttp404(err)) {
      return [];
    }
    console.warn("[githubListRepoPathContents]", err);
    return null;
  }
}

export type GithubReadRepoFileResult =
  | { ok: true; text: string; size: number }
  | {
      ok: false;
      code:
        | "not_found"
        | "too_large"
        | "not_file"
        | "binary_or_decode"
        | "unknown";
    };

/** Read text for a blob path (symlink/submodule/dir → typed errors). */
export async function githubReadRepoFileUtf8(
  owner: string,
  repo: string,
  ref: string,
  posixPath: string,
): Promise<GithubReadRepoFileResult> {
  const trimmedRef = ref.trim();
  if (!trimmedRef || !posixPath.trim()) {
    return { ok: false, code: "not_found" };
  }

  const octokit = createOctokit();
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: posixPath,
      ref: trimmedRef,
    });

    if (Array.isArray(data)) {
      return { ok: false, code: "not_file" };
    }

    if (data.type !== "file") {
      return { ok: false, code: "not_file" };
    }

    const reported = typeof data.size === "number" ? data.size : null;
    if (reported != null && reported > MAX_FILE_BYTES) {
      return { ok: false, code: "too_large" };
    }

    const encoding =
      "encoding" in data && typeof data.encoding === "string"
        ? data.encoding
        : undefined;
    const content =
      "content" in data && typeof data.content === "string"
        ? data.content
        : undefined;

    if (encoding !== "base64" || !content) {
      return { ok: false, code: "not_file" };
    }

    let buf: Buffer;
    try {
      buf = Buffer.from(content.replace(/\n/g, ""), "base64");
    } catch {
      return { ok: false, code: "binary_or_decode" };
    }

    if (buf.byteLength > MAX_FILE_BYTES) {
      return { ok: false, code: "too_large" };
    }

    let text = buf.toString("utf8");
    if (/[\x00-\x08\x0B\x0E-\x1F]/.test(text)) {
      return { ok: false, code: "binary_or_decode" };
    }

    text = text.replace(/\r\n/g, "\n");
    return { ok: true, text, size: buf.byteLength };
  } catch (err) {
    if (isHttp404(err)) return { ok: false, code: "not_found" };
    console.warn("[githubReadRepoFileUtf8]", err);
    return { ok: false, code: "unknown" };
  }
}
