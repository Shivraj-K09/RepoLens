"use client";

import { createCodePlugin } from "@streamdown/code";
import { Streamdown } from "streamdown";
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  File,
  FileCode2,
  Folder,
  Home,
  Loader2,
  Package,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { RepoRootEntry } from "@/lib/github/fetch-repo-root-contents";
import { cn } from "@/lib/utils";

/** Client-safe path normalizer (must not import `@/lib/github/repo-path` — it pulls `server-only`). */
function normalizeRepoContentPathClient(raw: string | undefined | null):
  | {
      ok: true;
      path: string;
    }
  | { ok: false; reason: string } {
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

const codePlugin = createCodePlugin({
  themes: ["github-light", "github-dark"],
});

function languageFromPath(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  const ext = base.includes(".")
    ? (base.split(".").pop()?.toLowerCase() ?? "")
    : "";
  const map: Record<string, string> = {
    ts: "ts",
    tsx: "tsx",
    mts: "ts",
    cts: "ts",
    js: "js",
    jsx: "jsx",
    mjs: "js",
    cjs: "js",
    json: "json",
    md: "markdown",
    mdx: "mdx",
    css: "css",
    scss: "scss",
    less: "css",
    html: "html",
    htm: "html",
    vue: "vue",
    svelte: "svelte",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    rsx: "rust",
    sql: "sql",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    yml: "yaml",
    yaml: "yaml",
    toml: "toml",
    xml: "xml",
    graphql: "graphql",
    gql: "graphql",
  };
  return map[ext] ?? "text";
}

/** Single neutral style for all folders; file rows keep per-extension tints. */
const FOLDER_ROW_CLASS = "text-muted-foreground";

const TEXT_BLUE = "text-blue-500 dark:text-blue-400";
const TEXT_SKY = "text-sky-500 dark:text-sky-400";

/** Icon tint for files by extension / well-known filenames. */
function fileEntryIconClass(fileName: string): string {
  const base = fileName.toLowerCase();
  const ext = base.includes(".")
    ? (base.split(".").pop()?.toLowerCase() ?? "")
    : "";

  if (base === "dockerfile" || base.startsWith("dockerfile.")) return TEXT_SKY;
  if (
    base === "package.json" ||
    base === "package-lock.json" ||
    base === "pnpm-lock.yaml" ||
    base === "yarn.lock" ||
    base === "bun.lockb"
  )
    return "text-lime-600 dark:text-lime-400";
  if (
    base === "readme.md" ||
    base === "readme.txt" ||
    base.startsWith("readme.")
  )
    return TEXT_SKY;
  if (base === "tsconfig.json" || base.endsWith(".config.ts")) return TEXT_BLUE;
  if (base.endsWith(".config.js") || base.endsWith(".config.mjs"))
    return "text-yellow-600 dark:text-yellow-400";

  const byExt: Record<string, string> = {
    ts: TEXT_BLUE,
    tsx: "text-sky-500 dark:text-sky-400",
    mts: TEXT_BLUE,
    cts: TEXT_BLUE,
    js: "text-yellow-600 dark:text-yellow-400",
    jsx: "text-amber-500 dark:text-amber-400",
    mjs: "text-yellow-600 dark:text-yellow-400",
    cjs: "text-yellow-600 dark:text-yellow-400",
    json: "text-yellow-500 dark:text-yellow-400",
    md: TEXT_SKY,
    mdx: "text-orange-500 dark:text-orange-400",
    css: "text-pink-500 dark:text-pink-400",
    scss: "text-pink-500 dark:text-pink-400",
    sass: "text-pink-500 dark:text-pink-400",
    less: "text-pink-500 dark:text-pink-400",
    html: "text-orange-600 dark:text-orange-400",
    htm: "text-orange-600 dark:text-orange-400",
    vue: "text-emerald-500 dark:text-emerald-400",
    svelte: "text-orange-500 dark:text-orange-400",
    py: "text-green-500 dark:text-green-400",
    rs: "text-orange-700 dark:text-orange-400",
    go: "text-cyan-500 dark:text-cyan-400",
    rb: "text-red-500 dark:text-red-400",
    php: "text-indigo-500 dark:text-indigo-400",
    java: "text-orange-600 dark:text-orange-400",
    kt: "text-violet-500 dark:text-violet-400",
    swift: "text-orange-500 dark:text-orange-400",
    c: "text-blue-600 dark:text-blue-400",
    h: "text-purple-500 dark:text-purple-400",
    cpp: "text-blue-600 dark:text-blue-400",
    cc: "text-blue-600 dark:text-blue-400",
    hpp: "text-purple-500 dark:text-purple-400",
    cs: "text-violet-500 dark:text-violet-400",
    sql: "text-rose-500 dark:text-rose-400",
    sh: "text-lime-600 dark:text-lime-400",
    bash: "text-lime-600 dark:text-lime-400",
    zsh: "text-lime-600 dark:text-lime-400",
    yml: "text-slate-500 dark:text-slate-300",
    yaml: "text-slate-500 dark:text-slate-300",
    toml: "text-amber-700 dark:text-amber-500",
    xml: "text-amber-600 dark:text-amber-400",
    graphql: "text-pink-500 dark:text-pink-400",
    gql: "text-pink-500 dark:text-pink-400",
    svg: "text-yellow-500 dark:text-yellow-400",
    png: "text-violet-400 dark:text-violet-300",
    jpg: "text-violet-400 dark:text-violet-300",
    jpeg: "text-violet-400 dark:text-violet-300",
    gif: "text-violet-400 dark:text-violet-300",
    webp: "text-violet-400 dark:text-violet-300",
    ico: "text-violet-400 dark:text-violet-300",
    woff2: "text-fuchsia-500 dark:text-fuchsia-400",
    woff: "text-fuchsia-500 dark:text-fuchsia-400",
    ttf: "text-fuchsia-500 dark:text-fuchsia-400",
  };

  if (byExt[ext]) return byExt[ext];
  if (!ext) return "text-zinc-500 dark:text-zinc-400";
  return "text-zinc-500 dark:text-zinc-400";
}

function githubBlobUrl(
  owner: string,
  repo: string,
  ref: string,
  posixPath: string,
): string {
  const encodedPath = posixPath
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `https://github.com/${owner}/${repo}/blob/${encodeURIComponent(ref)}/${encodedPath}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 1024 ? 2 : 1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function buildGithubContentsUrl(routeOwner: string, routeRepo: string): string {
  return `/api/repos/${encodeURIComponent(routeOwner)}/${encodeURIComponent(routeRepo)}/github-contents`;
}

async function fetchDirectoryListing(
  apiBase: string,
  ref: string,
  posixPath: string,
): Promise<
  | { ok: true; entries: RepoRootEntry[] }
  | { ok: false; status: number; message: string }
> {
  const u = new URL(apiBase, window.location.origin);
  u.searchParams.set("mode", "list");
  u.searchParams.set("ref", ref);
  u.searchParams.set("path", posixPath);
  const res = await fetch(u.toString(), { credentials: "same-origin" });
  let body: { error?: unknown; entries?: RepoRootEntry[] } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    body = {};
  }
  if (!res.ok) {
    const msg =
      typeof body.error === "string"
        ? body.error
        : typeof body.error === "object" && body.error !== null
          ? JSON.stringify(body.error)
          : res.statusText;
    return { ok: false, status: res.status, message: msg };
  }
  return { ok: true, entries: Array.isArray(body.entries) ? body.entries : [] };
}

async function fetchRawFile(
  apiBase: string,
  ref: string,
  posixPath: string,
): Promise<
  | { ok: true; text: string; size: number; path: string }
  | { ok: false; status: number; message: string }
> {
  const u = new URL(apiBase, window.location.origin);
  u.searchParams.set("mode", "raw");
  u.searchParams.set("ref", ref);
  u.searchParams.set("path", posixPath);
  const res = await fetch(u.toString(), { credentials: "same-origin" });
  let body: { error?: string; text?: string; size?: number; path?: string } =
    {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    body = {};
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: body.error ?? res.statusText,
    };
  }
  if (typeof body.text !== "string") {
    return { ok: false, status: 502, message: "Invalid file payload" };
  }
  return {
    ok: true,
    text: body.text,
    size: typeof body.size === "number" ? body.size : body.text.length,
    path: typeof body.path === "string" ? body.path : posixPath,
  };
}

/** Session cache so switching back to a file does not flash loading again. */
const FILE_PREVIEW_CACHE_MAX = 64;

function rememberFilePreviewContent(
  cache: Map<string, { text: string; size: number }>,
  key: string,
  entry: { text: string; size: number },
) {
  while (cache.size >= FILE_PREVIEW_CACHE_MAX) {
    const old = cache.keys().next().value;
    if (old === undefined) break;
    cache.delete(old);
  }
  cache.set(key, entry);
}

export type RepoCodeExplorerProps = {
  routeOwner: string;
  routeRepo: string;
  displayOwner: string;
  displayRepo: string;
  defaultBranch: string | null;
  initialRootEntries: RepoRootEntry[] | null;
  initialOpenPath: string | null | undefined;
};

const EXPLORER_HEADER_ROW =
  "flex h-10 max-h-10 min-h-10 shrink-0 items-center gap-2 border-border/40 border-b px-2 text-[13px] text-muted-foreground";

const streamdownMinimalCodeWrap = cn(
  "[&_[data-streamdown='code-block']]:m-0 [&_[data-streamdown='code-block']]:max-w-full [&_[data-streamdown='code-block']]:min-w-0 [&_[data-streamdown='code-block']]:rounded-none [&_[data-streamdown='code-block']]:border-0 [&_[data-streamdown='code-block']]:bg-transparent [&_[data-streamdown='code-block']]:shadow-none [&_[data-streamdown='code-block']]:ring-0",
  "[&_[data-streamdown='code-block-header']]:hidden",
  "[&_[data-streamdown='code-block-body']]:max-w-full [&_[data-streamdown='code-block-body']]:min-w-0 [&_[data-streamdown='code-block-body']]:overflow-x-hidden [&_[data-streamdown='code-block-body']]:bg-transparent [&_[data-streamdown='code-block-body']]:px-0 [&_[data-streamdown='code-block-body']]:py-0 [&_[data-streamdown='code-block-body']]:ring-0",
  "[&_[data-streamdown='code-block']_pre]:m-0 [&_[data-streamdown='code-block']_pre]:max-w-full [&_[data-streamdown='code-block']_pre]:min-w-0 [&_[data-streamdown='code-block']_pre]:border-0 [&_[data-streamdown='code-block']_pre]:bg-transparent [&_[data-streamdown='code-block']_pre]:p-0 [&_[data-streamdown='code-block']_pre]:whitespace-normal [&_[data-streamdown='code-block']_pre]:font-mono [&_[data-streamdown='code-block']_pre]:shadow-none",
);

function SvgFilePreview({ text }: { text: string }) {
  const [renderError, setRenderError] = useState(false);

  const dataUrl = useMemo(() => {
    const raw = text.replace(/\u0000/g, "");
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw)}`;
  }, [text]);

  const copySvg = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text.replace(/\u0000/g, ""));
      toast.success("SVG copied to clipboard");
    } catch {
      toast.error("Could not copy to clipboard");
    }
  }, [text]);

  return (
    <div className="repo-file-preview-svg flex min-h-0 min-w-0 flex-col gap-2 px-3 py-2">
      <div className="flex shrink-0 justify-end">
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="h-7 gap-1 text-[12px]"
          onClick={() => void copySvg()}
        >
          <Copy className="size-3.5" aria-hidden />
          Copy SVG
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center">
        {renderError ? (
          <p className="max-w-sm px-2 text-center text-[12px] text-muted-foreground">
            Could not render this SVG as an image. Use Copy SVG to inspect the
            markup.
          </p>
        ) : (
          <Image
            src={dataUrl}
            alt=""
            width={240}
            height={200}
            unoptimized
            className="h-auto max-h-[min(28vh,200px)] w-auto max-w-[min(100%,240px)] object-contain"
            onError={() => setRenderError(true)}
          />
        )}
      </div>
    </div>
  );
}

function FilePreviewImpl({ path, text }: { path: string; text: string }) {
  const isMarkdown = path.toLowerCase().endsWith(".md");
  const isSvg = path.toLowerCase().endsWith(".svg");
  const lang = useMemo(() => languageFromPath(path), [path]);

  const fenced = useMemo(() => {
    if (isMarkdown) return null;
    if (text.includes("```")) return null;
    const safe = text.replace(/\u0000/g, "");
    return `\`\`\`${lang}\n${safe}\n\`\`\``;
  }, [text, lang, isMarkdown]);

  if (isMarkdown) {
    return (
      <div
        className={cn(
          "repo-file-preview-markdown max-w-full min-w-0 overflow-x-auto px-3 py-2 text-[12px] leading-normal text-foreground scrollbar-hide",
          streamdownMinimalCodeWrap,
        )}
      >
        <Streamdown
          mode="static"
          linkSafety={{ enabled: false }}
          controls={{ code: false }}
          plugins={{ code: codePlugin }}
          shikiTheme={["github-light", "github-dark"]}
        >
          {text}
        </Streamdown>
      </div>
    );
  }

  if (isSvg) {
    return <SvgFilePreview key={text} text={text} />;
  }

  if (fenced === null) {
    return (
      <pre
        className={cn(
          "m-0 max-w-full min-w-0 overflow-x-hidden overflow-y-auto border-0 px-3 py-2 font-mono text-[11px] leading-normal scrollbar-hide",
          "text-foreground/90 whitespace-pre-wrap wrap-break-word",
        )}
      >
        {text}
      </pre>
    );
  }

  return (
    <div
      className={cn(
        "repo-file-preview-code max-w-full min-w-0 overflow-x-hidden px-3 py-2 text-[11px] leading-normal text-foreground scrollbar-hide",
        streamdownMinimalCodeWrap,
      )}
    >
      <Streamdown
        mode="static"
        linkSafety={{ enabled: false }}
        controls={{ code: false }}
        plugins={{ code: codePlugin }}
        shikiTheme={["github-light", "github-dark"]}
      >
        {fenced}
      </Streamdown>
    </div>
  );
}

const FilePreview = memo(FilePreviewImpl);

export function RepoCodeExplorer(props: RepoCodeExplorerProps) {
  const router = useRouter();
  const pathname = usePathname();
  const apiBase = useMemo(
    () => buildGithubContentsUrl(props.routeOwner, props.routeRepo),
    [props.routeOwner, props.routeRepo],
  );

  const refBranch = props.defaultBranch?.trim() ?? "";

  const [browsePath, setBrowsePath] = useState("");
  const [entries, setEntries] = useState<RepoRootEntry[] | null>(
    () => props.initialRootEntries,
  );
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);

  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [fileText, setFileText] = useState<string | null>(null);
  const [fileMeta, setFileMeta] = useState<{ size: number } | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const fileContentCacheRef = useRef<Map<string, { text: string; size: number }>>(
    new Map(),
  );
  const fileLoadGenerationRef = useRef(0);

  useEffect(() => {
    fileContentCacheRef.current.clear();
  }, [apiBase, refBranch]);

  const syncUrl = useCallback(
    (dir: string, file: string | null) => {
      const params = new URLSearchParams();
      params.set("tab", "code");
      if (file) {
        const n = normalizeRepoContentPathClient(file);
        if (n.ok && n.path) params.set("path", n.path);
      } else if (dir) {
        const n = normalizeRepoContentPathClient(dir);
        if (n.ok && n.path) params.set("path", n.path);
      }
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router],
  );

  const loadFileInternal = useCallback(
    async (posixPath: string, opts?: { skipUrl?: boolean }) => {
      if (!refBranch) return;
      const normalized = normalizeRepoContentPathClient(posixPath);
      if (!normalized.ok || !normalized.path) {
        setFileError(normalized.ok ? "Invalid path" : normalized.reason);
        return;
      }
      const path = normalized.path;
      const gen = ++fileLoadGenerationRef.current;
      const cacheKey = `${refBranch}:${path}`;
      const cached = fileContentCacheRef.current.get(cacheKey);

      setFileError(null);
      setSelectedFilePath(path);

      const parent = path.includes("/")
        ? path.slice(0, path.lastIndexOf("/"))
        : "";
      setBrowsePath(parent);
      setListError(null);

      if (!cached) {
        setFileLoading(true);
        setFileText(null);
        setFileMeta(null);
      }

      const skipListRefresh = parent === browsePath;
      if (!skipListRefresh) {
        if (parent === "" && props.initialRootEntries) {
          setEntries(props.initialRootEntries);
        } else if (parent !== "") {
          setListLoading(true);
          try {
            const listRes = await fetchDirectoryListing(
              apiBase,
              refBranch,
              parent,
            );
            if (gen !== fileLoadGenerationRef.current) return;
            if (listRes.ok) setEntries(listRes.entries);
          } finally {
            setListLoading(false);
          }
        } else {
          const listRes = await fetchDirectoryListing(apiBase, refBranch, "");
          if (gen !== fileLoadGenerationRef.current) return;
          if (listRes.ok) setEntries(listRes.entries);
        }
      }

      if (cached) {
        if (gen !== fileLoadGenerationRef.current) return;
        setFileText(cached.text);
        setFileMeta({ size: cached.size });
        setFileLoading(false);
        setFileError(null);
        if (!opts?.skipUrl) syncUrl(parent, path);
        return;
      }

      try {
        const file = await fetchRawFile(apiBase, refBranch, path);
        if (gen !== fileLoadGenerationRef.current) return;
        if (!file.ok) {
          setFileText(null);
          setFileMeta(null);
          setFileError(file.message);
          return;
        }
        rememberFilePreviewContent(fileContentCacheRef.current, cacheKey, {
          text: file.text,
          size: file.size,
        });
        setFileText(file.text);
        setFileMeta({ size: file.size });
        if (!opts?.skipUrl) syncUrl(parent, path);
      } finally {
        if (gen === fileLoadGenerationRef.current) {
          setFileLoading(false);
        }
      }
    },
    [apiBase, browsePath, props.initialRootEntries, refBranch, syncUrl],
  );

  const loadFileInternalRef = useRef(loadFileInternal);
  useEffect(() => {
    loadFileInternalRef.current = loadFileInternal;
  }, [loadFileInternal]);

  const loadDirectory = useCallback(
    async (posixPath: string, opts?: { skipUrl?: boolean }) => {
      if (!refBranch) return;
      setListError(null);
      setSelectedFilePath(null);
      setFileText(null);
      setFileMeta(null);
      setFileError(null);

      const normalized = normalizeRepoContentPathClient(posixPath);
      if (!normalized.ok) {
        setListError(normalized.reason);
        return;
      }
      const path = normalized.path;

      if (path === "" && props.initialRootEntries !== null) {
        setBrowsePath("");
        setEntries(props.initialRootEntries);
        if (!opts?.skipUrl) syncUrl("", null);
        return;
      }

      setListLoading(true);
      try {
        const res = await fetchDirectoryListing(apiBase, refBranch, path);
        if (!res.ok) {
          if (res.status === 422) {
            await loadFileInternal(path, { skipUrl: opts?.skipUrl });
            return;
          }
          setListError(res.message || "Could not load folder");
          setEntries([]);
          setBrowsePath(path);
          return;
        }
        setBrowsePath(path);
        setEntries(res.entries);
        if (!opts?.skipUrl) syncUrl(path, null);
      } finally {
        setListLoading(false);
      }
    },
    [apiBase, loadFileInternal, props.initialRootEntries, refBranch, syncUrl],
  );

  const openFile = useCallback(
    (posixPath: string) => {
      void loadFileInternal(posixPath, { skipUrl: false });
    },
    [loadFileInternal],
  );

  const openFolder = useCallback(
    (posixPath: string) => {
      void loadDirectory(posixPath, { skipUrl: false });
    },
    [loadDirectory],
  );

  useEffect(() => {
    if (!refBranch) return;
    let cancelled = false;

    void (async () => {
      const raw = props.initialOpenPath?.trim();
      if (!raw) {
        if (props.initialRootEntries !== null) {
          if (!cancelled) {
            setBrowsePath("");
            setEntries(props.initialRootEntries);
            setSelectedFilePath(null);
            setFileText(null);
            setFileMeta(null);
            setListError(null);
            setFileError(null);
          }
          return;
        }
        const res = await fetchDirectoryListing(apiBase, refBranch, "");
        if (cancelled || !res.ok) return;
        setBrowsePath("");
        setEntries(res.entries);
        setSelectedFilePath(null);
        setFileText(null);
        setFileMeta(null);
        setListError(null);
        setFileError(null);
        return;
      }

      const n = normalizeRepoContentPathClient(raw);
      if (!n.ok) {
        if (props.initialRootEntries !== null && !cancelled) {
          setBrowsePath("");
          setEntries(props.initialRootEntries);
          setSelectedFilePath(null);
          setFileText(null);
          setFileMeta(null);
          setListError(null);
          setFileError(null);
        } else {
          const res = await fetchDirectoryListing(apiBase, refBranch, "");
          if (cancelled || !res.ok) return;
          setBrowsePath("");
          setEntries(res.entries);
        }
        return;
      }

      const tryPath = n.path;
      const listTry = await fetchDirectoryListing(apiBase, refBranch, tryPath);
      if (cancelled) return;
      if (listTry.ok) {
        setBrowsePath(tryPath);
        setEntries(listTry.entries);
        setSelectedFilePath(null);
        setFileText(null);
        setFileMeta(null);
        setListError(null);
        setFileError(null);
        return;
      }
      if (listTry.status === 422) {
        await loadFileInternalRef.current(tryPath, { skipUrl: true });
      } else if (props.initialRootEntries !== null) {
        setBrowsePath("");
        setEntries(props.initialRootEntries);
        setSelectedFilePath(null);
        setFileText(null);
        setFileMeta(null);
        setListError(null);
        setFileError(null);
      } else {
        const res = await fetchDirectoryListing(apiBase, refBranch, "");
        if (cancelled || !res.ok) return;
        setBrowsePath("");
        setEntries(res.entries);
      }
    })();

    return () => {
      cancelled = true;
    };
    // Intentionally omit loadFileInternal: it changes with browsePath; re-running this
    // effect would reset the tree to root whenever the user opens a folder.
  }, [apiBase, props.initialOpenPath, props.initialRootEntries, refBranch]);

  const breadcrumbSegments = useMemo(() => {
    if (!browsePath) return [];
    return browsePath.split("/").filter(Boolean);
  }, [browsePath]);

  const fileGithubUrl = useMemo(() => {
    if (!selectedFilePath || !refBranch) return null;
    return githubBlobUrl(
      props.displayOwner,
      props.displayRepo,
      refBranch,
      selectedFilePath,
    );
  }, [props.displayOwner, props.displayRepo, refBranch, selectedFilePath]);

  const breadcrumbScrollRef = useRef<HTMLDivElement>(null);
  const [breadcrumbScroll, setBreadcrumbScroll] = useState({
    hasOverflow: false,
    canLeft: false,
    canRight: false,
  });

  const updateBreadcrumbScrollState = useCallback(() => {
    const el = breadcrumbScrollRef.current;
    if (!el) {
      setBreadcrumbScroll({
        hasOverflow: false,
        canLeft: false,
        canRight: false,
      });
      return;
    }
    const { scrollLeft, scrollWidth, clientWidth } = el;
    const epsilon = 3;
    const hasOverflow = scrollWidth > clientWidth + epsilon;
    setBreadcrumbScroll({
      hasOverflow,
      canLeft: hasOverflow && scrollLeft > epsilon,
      canRight: hasOverflow && scrollLeft + clientWidth < scrollWidth - epsilon,
    });
  }, []);

  useLayoutEffect(() => {
    updateBreadcrumbScrollState();
  }, [browsePath, breadcrumbSegments.length, updateBreadcrumbScrollState]);

  useEffect(() => {
    const el = breadcrumbScrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      queueMicrotask(updateBreadcrumbScrollState);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateBreadcrumbScrollState]);

  /** Shiki highlights async (Streamdown “shell then colorize”); DOM mutations can reset scroll / anchoring. */
  const codePreviewScrollRef = useRef<HTMLDivElement>(null);
  const codePreviewScrollTopRef = useRef(0);

  const onCodePreviewScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      codePreviewScrollTopRef.current = e.currentTarget.scrollTop;
    },
    [],
  );

  useLayoutEffect(() => {
    codePreviewScrollTopRef.current = 0;
    const el = codePreviewScrollRef.current;
    if (el) el.scrollTop = 0;
  }, [selectedFilePath]);

  useEffect(() => {
    const root = codePreviewScrollRef.current;
    if (!root || fileLoading || fileText == null) return;

    const tryRestore = () => {
      const el = codePreviewScrollRef.current;
      if (!el) return;
      const saved = codePreviewScrollTopRef.current;
      if (saved < 32) return;
      const cur = el.scrollTop;
      if (cur < saved - 24) {
        el.scrollTop = saved;
      }
    };

    const scheduleRestore = () => {
      requestAnimationFrame(() => {
        requestAnimationFrame(tryRestore);
      });
    };

    const mo = new MutationObserver(() => {
      queueMicrotask(scheduleRestore);
    });
    mo.observe(root, { childList: true, subtree: true });

    return () => {
      mo.disconnect();
    };
  }, [fileLoading, fileText, selectedFilePath]);

  if (!refBranch) {
    return (
      <div className="flex flex-1 items-center justify-center px-3 py-8">
        <p className="max-w-sm text-center text-[13px] text-muted-foreground leading-relaxed">
          No default branch is set for this repository, so files cannot be
          listed yet.
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "repo-code-explorer flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row",
      )}
    >
      <div className="flex min-h-0 w-full min-w-0 shrink-0 flex-col lg:w-[min(100%,280px)] lg:border-border/40 lg:border-r">
        <div className={cn(EXPLORER_HEADER_ROW, "min-w-0 gap-0.5")}>
          {breadcrumbScroll.hasOverflow ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={!breadcrumbScroll.canLeft}
              className={cn(
                "size-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground",
                !breadcrumbScroll.canLeft && "pointer-events-none opacity-25",
              )}
              aria-label="Scroll breadcrumbs left"
              onClick={() => {
                const el = breadcrumbScrollRef.current;
                if (!el) return;
                el.scrollBy({
                  left: -Math.max(72, el.clientWidth * 0.55),
                  behavior: "smooth",
                });
              }}
            >
              <ChevronLeft className="size-3.5" aria-hidden />
            </Button>
          ) : null}
          <div
            ref={breadcrumbScrollRef}
            onScroll={updateBreadcrumbScrollState}
            className="min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain scrollbar-hide"
          >
            <div className="inline-flex h-full min-h-7 items-center gap-x-0.5 pr-0.5">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="h-7 shrink-0 px-1 text-muted-foreground hover:text-foreground"
                onClick={() => void loadDirectory("", { skipUrl: false })}
              >
                <Home className="size-3.5" aria-hidden />
                <span className="sr-only">Root</span>
              </Button>
              {breadcrumbSegments.map((seg, i) => {
                const prefix = breadcrumbSegments.slice(0, i + 1).join("/");
                return (
                  <span
                    key={prefix}
                    className="inline-flex shrink-0 items-center gap-0.5"
                  >
                    <ChevronRight
                      className="size-3.5 shrink-0 opacity-40"
                      aria-hidden
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="h-7 shrink-0 px-1 font-normal whitespace-nowrap text-[12px] text-foreground/85 hover:text-foreground"
                      title={seg}
                      onClick={() =>
                        void loadDirectory(prefix, { skipUrl: false })
                      }
                    >
                      {seg}
                    </Button>
                  </span>
                );
              })}
            </div>
          </div>
          {breadcrumbScroll.hasOverflow ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={!breadcrumbScroll.canRight}
              className={cn(
                "size-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground",
                !breadcrumbScroll.canRight && "pointer-events-none opacity-25",
              )}
              aria-label="Scroll breadcrumbs right"
              onClick={() => {
                const el = breadcrumbScrollRef.current;
                if (!el) return;
                el.scrollBy({
                  left: Math.max(72, el.clientWidth * 0.55),
                  behavior: "smooth",
                });
              }}
            >
              <ChevronRight className="size-3.5" aria-hidden />
            </Button>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-auto scrollbar-hide">
          {listLoading ? (
            <div className="flex items-center justify-center gap-1.5 py-8 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              <span className="text-[13px]">Loading…</span>
            </div>
          ) : listError ? (
            <div className="flex items-start gap-1.5 p-2 text-[13px] text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{listError}</span>
            </div>
          ) : !entries || entries.length === 0 ? (
            <div className="px-2 py-6 text-center text-[13px] text-muted-foreground">
              Empty folder.
            </div>
          ) : (
            <ul className="m-0 list-none p-0">
              {entries.map((entry) => {
                const isSelectedFile =
                  selectedFilePath !== null && entry.path === selectedFilePath;
                return (
                  <li key={entry.path + entry.kind}>
                    {entry.kind === "dir" ? (
                      <button
                        type="button"
                        className={cn(
                          "flex w-full items-center gap-2 px-2 py-1.5 text-left text-[13px] transition-colors",
                          "hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40",
                        )}
                        onClick={() => openFolder(entry.path)}
                      >
                        <Folder
                          className={cn("size-4 shrink-0", FOLDER_ROW_CLASS)}
                          aria-hidden
                        />
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate",
                            FOLDER_ROW_CLASS,
                          )}
                        >
                          {entry.name}
                        </span>
                      </button>
                    ) : entry.kind === "submodule" ? (
                      <div className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[13px] text-muted-foreground">
                        <Package
                          className="size-4 shrink-0 text-amber-600/80 dark:text-amber-500/80"
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {entry.name}
                        </span>
                        <span className="shrink-0 opacity-60">submodule</span>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className={cn(
                          "flex w-full items-center gap-2 px-2 py-1.5 text-left text-[13px] transition-colors",
                          "hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40",
                          isSelectedFile ? "bg-muted/35 font-medium" : "",
                        )}
                        onClick={() => openFile(entry.path)}
                      >
                        <FileCode2
                          className={cn(
                            "size-4 shrink-0",
                            fileEntryIconClass(entry.name),
                          )}
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1 truncate text-foreground">
                          {entry.name}
                        </span>
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className={cn(EXPLORER_HEADER_ROW, "min-w-0 justify-start gap-2")}>
          <span
            className="shrink-0 rounded border border-border/50 bg-muted/25 px-1.5 py-0.5 font-medium font-mono text-[11px] text-muted-foreground tabular-nums leading-none"
            title={`Branch: ${refBranch}`}
          >
            {refBranch}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground/90">
            {selectedFilePath ?? (browsePath === "" ? "" : browsePath)}
          </span>
          {fileMeta ? (
            <span className="shrink-0 text-[12px] text-muted-foreground tabular-nums">
              {formatBytes(fileMeta.size)}
            </span>
          ) : null}
          {fileGithubUrl ? (
            <Link
              href={fileGithubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex shrink-0 items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="size-3.5" aria-hidden />
              View on GitHub
            </Link>
          ) : null}
        </div>

        <div
          ref={codePreviewScrollRef}
          onScroll={onCodePreviewScroll}
          className="repo-code-preview-scroll min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto scrollbar-hide"
        >
          {fileLoading ? (
            <div className="flex items-center justify-center gap-1.5 py-12 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              <span className="text-[13px]">Loading…</span>
            </div>
          ) : fileError ? (
            <div className="flex items-start gap-1.5 p-2 text-[13px] text-muted-foreground">
              <AlertCircle
                className="mt-0.5 size-4 shrink-0 text-destructive"
                aria-hidden
              />
              <div>
                <p className="font-medium text-destructive">
                  Preview unavailable
                </p>
                <p className="mt-0.5 opacity-90">{fileError}</p>
              </div>
            </div>
          ) : selectedFilePath && fileText !== null ? (
            <FilePreview path={selectedFilePath} text={fileText} />
          ) : (
            <div className="flex h-full min-h-32 flex-col items-center justify-center gap-1 px-3 py-8 text-center">
              <File className="size-8 text-muted-foreground/30" aria-hidden />
              <p className="max-w-56 text-[13px] text-muted-foreground leading-snug">
                Select a file to preview.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
