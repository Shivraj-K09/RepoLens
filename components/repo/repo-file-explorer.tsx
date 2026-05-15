"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronRight,
  File as FileIcon,
  Folder,
  GitFork,
  Loader2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { RepoRootEntry } from "@/lib/github/fetch-repo-root-contents";
import {
  ExplorerLru,
  explorerListKey,
  explorerRawKey,
  sortRepoExplorerEntries,
} from "@/lib/github/explorer-lru-cache";

import { cn } from "@/lib/utils";

const ROW_ESTIMATE_PX = 31;
const ROW_OVERSCAN = 10;
const MAX_OPEN_FILE_TABS = 14;
const LIST_CACHE_CAPACITY = 64;
const RAW_CACHE_CAPACITY = 48;

type RepoFileExplorerProps = {
  routeOwner: string;
  routeRepo: string;
  /** Full branch/ref name GitHub resolves (e.g. `main`). */
  refBranch: string;
  /** Server-provided root rows to avoid duplicate first fetch. */
  initialRootEntries: RepoRootEntry[] | null;
  /** Optional file path to open immediately in a tab. */
  initialOpenPath?: string | null;
  /** Monotonic key to re-run open-path intent, even for same path. */
  initialOpenPathRequestId?: number;
};

type ActiveFileTab =
  | { path: string; shortName: string; status: "loading" }
  | {
      path: string;
      shortName: string;
      status: "ready";
      text: string;
    }
  | { path: string; shortName: string; status: "error"; message: string };

function apiBase(routeOwner: string, routeRepo: string) {
  return `/api/repos/${encodeURIComponent(routeOwner)}/${encodeURIComponent(routeRepo)}/github-contents`;
}

function fileShortName(pathPosix: string) {
  const i = pathPosix.lastIndexOf("/");
  return i >= 0 ? pathPosix.slice(i + 1) : pathPosix;
}

export function RepoFileExplorer({
  routeOwner,
  routeRepo,
  refBranch,
  initialRootEntries,
  initialOpenPath,
  initialOpenPathRequestId,
}: RepoFileExplorerProps) {
  const seedRef = useRef(initialRootEntries);
  const listCacheRef = useRef(new ExplorerLru<string, RepoRootEntry[]>(LIST_CACHE_CAPACITY));
  const rawCacheRef = useRef(new ExplorerLru<string, string>(RAW_CACHE_CAPACITY));
  const rawInflightRef = useRef(
    new Map<string, Promise<string | null>>(),
  );

  const [cwd, setCwd] = useState("");
  const [entries, setEntries] = useState<RepoRootEntry[]>(
    Array.isArray(initialRootEntries)
      ? sortRepoExplorerEntries(initialRootEntries.filter(Boolean))
      : [],
  );
  const [loadingList, setLoadingList] = useState(() => initialRootEntries == null);
  const [listError, setListError] = useState<string | null>(null);

  const [tabs, setTabs] = useState<ActiveFileTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);

  const listScrollRef = useRef<HTMLDivElement>(null);

  const breadcrumbs = useMemo(() => {
    if (!cwd) return [] as string[];
    return cwd.split("/").filter(Boolean);
  }, [cwd]);

  /* eslint-disable-next-line react-hooks/incompatible-library -- @tanstack/react-virtual */
  const rowVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => listScrollRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: ROW_OVERSCAN,
  });

  useEffect(() => {
    rowVirtualizer.measure();
  }, [rowVirtualizer, entries]);

  useEffect(() => {
    seedRef.current = initialRootEntries;
    listCacheRef.current.clear();
    rawCacheRef.current.clear();
    rawInflightRef.current.clear();
    setTabs([]);
    setActiveTabPath(null);
    const seed = Array.isArray(initialRootEntries)
      ? sortRepoExplorerEntries(initialRootEntries.filter(Boolean))
      : [];
    setCwd("");
    setEntries(seed);
    setLoadingList(initialRootEntries == null);
    setListError(null);
  }, [refBranch, routeOwner, routeRepo, initialRootEntries]);

  const fetchListResolved = useCallback(
    async (pathPosix: string): Promise<RepoRootEntry[] | null | "not-directory"> => {
      const key = explorerListKey(routeOwner, routeRepo, refBranch, pathPosix);
      const hit = listCacheRef.current.get(key);
      if (hit) return [...hit];

      const q = new URLSearchParams({ mode: "list", ref: refBranch });
      q.set("path", pathPosix);
      const res = await fetch(`${apiBase(routeOwner, routeRepo)}?${q}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body?.error === "Not a directory") return "not-directory";
        return null;
      }
      if (!Array.isArray(body.entries))
        return null;
      const rows = sortRepoExplorerEntries(
        body.entries as RepoRootEntry[],
      );
      listCacheRef.current.set(key, rows);
      return rows;
    },
    [refBranch, routeOwner, routeRepo],
  );

  const fetchRawResolved = useCallback(
    async (pathPosix: string): Promise<string | null> => {
      const key = explorerRawKey(routeOwner, routeRepo, refBranch, pathPosix);
      const memo = rawCacheRef.current.get(key);
      if (memo !== undefined) return memo;

      let p = rawInflightRef.current.get(key);
      if (!p) {
        p = (async () => {
          const q = new URLSearchParams({
            mode: "raw",
            ref: refBranch,
            path: pathPosix,
          });
          const res = await fetch(`${apiBase(routeOwner, routeRepo)}?${q}`);
          if (!res.ok) return null;
          const body = (await res.json()) as { text?: string };
          return typeof body.text === "string" ? body.text : null;
        })();
        rawInflightRef.current.set(key, p);
      }
      const text = await p;
      rawInflightRef.current.delete(key);
      if (text !== null) rawCacheRef.current.set(key, text);
      return text;
    },
    [refBranch, routeOwner, routeRepo],
  );

  const prefetchRaw = useCallback(
    async (pathPosix: string) => {
      if (!pathPosix.trim()) return;
      const key = explorerRawKey(routeOwner, routeRepo, refBranch, pathPosix);
      if (
        rawCacheRef.current.get(key) !== undefined ||
        rawInflightRef.current.has(key)
      ) {
        return;
      }
      void fetchRawResolved(pathPosix).catch(() => null);
    },
    [fetchRawResolved, routeOwner, routeRepo, refBranch],
  );

  const loadDirectory = useCallback(
    async (pathPosix: string) => {
      if (pathPosix === "" && Array.isArray(seedRef.current)) {
        setEntries(sortRepoExplorerEntries(seedRef.current.filter(Boolean)));
        setListError(null);
        setLoadingList(false);
        return;
      }
      setLoadingList(true);
      setListError(null);
      const rows = await fetchListResolved(pathPosix);
      setLoadingList(false);
      if (rows === null) {
        setListError("Unable to load this folder.");
        setEntries([]);
      } else if (rows === "not-directory") {
        setListError("Not a folder.");
        setEntries([]);
      } else {
        setEntries(rows);
      }
    },
    [fetchListResolved],
  );

  useEffect(() => {
    void loadDirectory(cwd);
  }, [cwd, loadDirectory]);

  const openFolder = useCallback((pathPosix: string) => {
    setCwd(pathPosix);
  }, []);

  const hydrateTab = useCallback(
    async (pathPosix: string) => {
      const result = await fetchRawResolved(pathPosix);
      setTabs((prev) =>
        prev.map((t) => {
          if (t.path !== pathPosix) return t;
          if (result === null) {
            return {
              ...t,
              status: "error",
              message: "Could not preview this file (too large or binary?)",
            } as ActiveFileTab;
          }
          return {
            ...t,
            status: "ready",
            text: result,
          } as ActiveFileTab;
        }),
      );
    },
    [fetchRawResolved],
  );

  const openOrFocusFile = useCallback(
    (pathPosix: string, opts?: { background?: boolean }) => {
      const shortName = fileShortName(pathPosix);
      let existed = false;

      setTabs((prev) => {
        existed = prev.some((t) => t.path === pathPosix);
        if (existed) return prev;
        let next = [
          ...prev,
          {
            path: pathPosix,
            shortName,
            status: "loading" as const,
          },
        ];
        if (next.length > MAX_OPEN_FILE_TABS) {
          next = next.slice(next.length - MAX_OPEN_FILE_TABS);
        }
        return next;
      });

      if (!existed) void hydrateTab(pathPosix);
      if (!opts?.background) setActiveTabPath(pathPosix);
    },
    [hydrateTab],
  );

  const closeTab = useCallback((pathPosix: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.path === pathPosix);
      const survivors = prev.filter((t) => t.path !== pathPosix);

      const nextFocus =
        idx <= 0
          ? survivors[0]?.path ?? null
          : survivors[idx - 1]?.path ?? survivors[survivors.length - 1]?.path ?? null;

      queueMicrotask(() =>
        setActiveTabPath((cur) => (cur === pathPosix ? nextFocus : cur)),
      );

      return survivors;
    });
  }, []);


  const activeTab =
    tabs.find((t) => t.path === activeTabPath) ?? tabs[0] ?? null;

  useEffect(() => {
    const candidate = (initialOpenPath ?? "").trim().replace(/^\/+/, "");
    if (!candidate) return;
    let cancelled = false;

    const openFromPath = async () => {
      const asDirectory = await fetchListResolved(candidate);
      if (cancelled) return;
      if (Array.isArray(asDirectory)) {
        setActiveTabPath(null);
        setCwd(candidate);
        return;
      }

      const parent =
        candidate.includes("/") && candidate.lastIndexOf("/") > 0
          ? candidate.slice(0, candidate.lastIndexOf("/"))
          : "";
      setCwd(parent);
      openOrFocusFile(candidate);
    };

    void openFromPath();

    return () => {
      cancelled = true;
    };
  }, [initialOpenPath, initialOpenPathRequestId, fetchListResolved, openOrFocusFile]);

  function glyph(entry: RepoRootEntry) {
    if (entry.kind === "dir") {
      return (
        <Folder
          aria-hidden
          strokeWidth={1.6}
          className="size-[14px] shrink-0 opacity-85"
        />
      );
    }
    if (entry.kind === "submodule") {
      return (
        <GitFork
          aria-hidden
          strokeWidth={1.6}
          className="size-[14px] shrink-0 opacity-85"
        />
      );
    }
    return (
      <FileIcon
        aria-hidden
        strokeWidth={1.6}
        className="size-[14px] shrink-0 opacity-85"
      />
    );
  }

  const vItems = rowVirtualizer.getVirtualItems();

  return (
    <div className="flex min-h-[min(60vh,480px)] flex-col gap-px border-border/55 border-t lg:flex-row">
      <aside className="flex min-h-[min(160px,32vh)] w-full shrink-0 flex-col border-border/55 bg-muted/[0.12] lg:max-w-[min(100%,14.5rem)] lg:border-e lg:border-t-0">
        <nav
          aria-label="Folder breadcrumbs"
          className="scrollbar-hide flex items-center gap-0.5 overflow-x-auto border-border/55 border-b px-2 py-1.75 text-muted-foreground text-[11.5px] leading-tight lg:px-2.25"
        >
          <button
            type="button"
            aria-current={cwd === "" ? "page" : undefined}
            onClick={() => openFolder("")}
            className={cn(
              "rounded px-1 py-0.5 transition-colors hover:bg-muted hover:text-foreground",
              cwd === ""
                ? "font-medium text-foreground"
                : "text-muted-foreground",
            )}
          >
            /
          </button>
          {breadcrumbs.map((segment, idx) => {
            const pref = breadcrumbs.slice(0, idx + 1).join("/");
            const isLast = idx === breadcrumbs.length - 1;
            return (
              <span key={pref} className="flex shrink-0 items-center">
                <ChevronRight
                  aria-hidden
                  className="mx-px size-[11px] opacity-55"
                  strokeWidth={1.85}
                />
                <button
                  type="button"
                  aria-current={isLast ? "page" : undefined}
                  onClick={() => openFolder(pref)}
                  className={cn(
                    "max-w-[8.75rem] truncate rounded px-1 py-0.5 transition-colors hover:bg-muted hover:text-foreground lg:max-w-[10rem]",
                    isLast
                      ? "font-medium text-foreground"
                      : "text-muted-foreground",
                  )}
                  title={segment}
                >
                  {segment}
                </button>
              </span>
            );
          })}
        </nav>

        <div
          ref={listScrollRef}
          className="scrollbar-hide min-h-[8rem] max-h-[min(60vh,420px)] flex-1 overflow-y-auto px-0.75 py-2 lg:max-h-none lg:flex-1 lg:py-2.25 lg:pr-px"
          style={{ overflowAnchor: "none" }}
        >
          {loadingList ? (
            <div className="flex items-center gap-2 px-2 py-3 text-muted-foreground text-[12px]">
              <Loader2 className="size-3.5 animate-spin shrink-0" />
              Loading…
            </div>
          ) : listError ? (
            <p className="wrap-break-word p-2 text-muted-foreground text-[12px]">
              {listError}
            </p>
          ) : entries.length === 0 ? (
            <p className="p-2 text-muted-foreground text-[12px]">Empty folder.</p>
          ) : (
            <div
              className="relative w-full pt-px"
              style={{
                height: `${rowVirtualizer.getTotalSize()}px`,
              }}
            >
              {vItems.map((vi) => {
                const entry = entries[vi.index];
                if (!entry) return null;
                const isFileSel =
                  Boolean(
                    activeTabPath === entry.path && entry.kind === "file",
                  );
                const isHoveredFile = entry.kind === "file";

                return (
                  <div
                    key={`${cwd}/${entry.path}`}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: `${vi.size}px`,
                      transform: `translateY(${vi.start}px)`,
                    }}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        if (
                          entry.kind === "dir" ||
                          entry.kind === "submodule"
                        ) {
                          openFolder(entry.path);
                          return;
                        }
                        if (e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) {
                          openOrFocusFile(entry.path, { background: true });
                          return;
                        }
                        openOrFocusFile(entry.path);
                      }}
                      onKeyDown={(e) => {
                        if (
                          entry.kind !== "file" ||
                          e.key !== "Enter" ||
                          !e.shiftKey
                        )
                          return;
                        e.preventDefault();
                        openOrFocusFile(entry.path, { background: true });
                      }}
                      onAuxClick={(e) => {
                        if (entry.kind !== "file") return;
                        if (e.button !== 1) return;
                        e.preventDefault();
                        openOrFocusFile(entry.path, { background: true });
                      }}
                      onMouseEnter={
                        isHoveredFile
                          ? () => prefetchRaw(entry.path)
                          : undefined
                      }
                      aria-pressed={Boolean(
                        activeTabPath === entry.path &&
                          entry.kind === "file",
                      )}
                      className={cn(
                        "flex h-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.25 text-[12px] text-left tracking-tight transition-colors",
                        "hover:bg-muted/70",
                        isFileSel
                          ? "bg-muted/56 text-foreground"
                          : "text-foreground",
                      )}
                      title={
                        entry.kind === "file"
                          ? `${entry.name} · ⌘/Ctrl‑ or Shift‑click, Shift+Enter, or middle‑click opens in background`
                          : entry.name
                      }
                    >
                      <span className="text-muted-foreground">{glyph(entry)}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11.75px] leading-snug">
                        {entry.name}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>

      <div className="flex min-h-[min(260px,40vh)] min-w-0 flex-1 flex-col bg-background">
        <div
          className={cn(
            "scrollbar-hide flex shrink-0 items-center gap-0 overflow-x-auto border-border/55 border-b bg-muted/[0.07] px-1 py-0.75",
          )}
          role="tablist"
          aria-orientation="horizontal"
        >
          {tabs.length === 0 ? (
            <span className="truncate px-2 py-1.25 text-muted-foreground text-[11.5px]">
              No files open: pick a file. Shift+Enter or ⌘/Ctrl-click adds a tab in the background.
            </span>
          ) : (
            tabs.map((tab) => {
              const sel = tab.path === activeTabPath;
              return (
                <div
                  key={tab.path}
                  className={cn(
                    "flex shrink-0 items-center rounded-md px-px",
                    sel && "bg-background ring-1 ring-border/65",
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={sel}
                    onClick={() => setActiveTabPath(tab.path)}
                    className={cn(
                      "max-w-[10.5rem] truncate rounded px-2 py-1.25 font-mono text-[11.25px] transition-colors hover:bg-muted",
                      sel
                        ? "font-medium text-foreground"
                        : "text-muted-foreground hover:text-foreground/90",
                    )}
                    title={tab.path}
                  >
                    {tab.shortName || tab.path}
                  </button>
                  <button
                    type="button"
                    aria-label={`Close ${tab.shortName}`}
                    onClick={() => closeTab(tab.path)}
                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <X className="size-3.25 shrink-0" strokeWidth={2} aria-hidden />
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="border-border/55 border-b px-3 py-1.75 text-muted-foreground text-[11.5px] md:px-3.25">
          {!activeTab ? (
            <span>
              Pick a file from the tree. Open several files with normal click;
              ⌘ or Ctrl‑click opens in the background. Middle‑click opens in the
              background.
            </span>
          ) : activeTab.status === "loading" ? (
            <span className="flex items-center gap-1.5">
              <Loader2 className="size-3.5 animate-spin shrink-0" />
              Reading file…{" "}
              <span className="font-medium font-mono text-foreground text-[12px]">
                {activeTab.shortName}
              </span>
            </span>
          ) : (
            <span className="font-medium font-mono text-foreground text-[12px]">
              {activeTab.shortName}
            </span>
          )}
        </div>
        <div className="scrollbar-hide min-h-[12rem] flex-1 overflow-auto p-3 md:p-3.25">
          {!activeTab ? (
            <p className="text-muted-foreground text-[12px] leading-relaxed">
              No file preview.
            </p>
          ) : activeTab.status === "loading" ? (
            null
          ) : activeTab.status === "error" ? (
            <p className="text-muted-foreground text-[12px]">
              {activeTab.message}
            </p>
          ) : (
            <pre className="wrap-break-word font-mono text-[11.25px] leading-[1.5] whitespace-pre-wrap text-foreground">
              {activeTab.text}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
