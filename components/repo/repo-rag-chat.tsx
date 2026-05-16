"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { AgentChat } from "@/components/agent-elements/agent-chat";
import { InputBar } from "@/components/agent-elements/input-bar";
import type { InputBarProps } from "@/components/agent-elements/input-bar";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  RepoRagInputBar,
  type MentionPathEntry,
} from "@/components/repo/repo-rag-input-bar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ChatStatus, UIMessage } from "ai";
import { Clock3, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

export type RepoRagChatProps = {
  routeOwner: string;
  routeRepo: string;
  displayOwner: string;
  displayRepo: string;
  indexedCommitSha: string | null;
  className?: string;
  /** Compact rail (default) vs floating panel with a dedicated top header band */
  surface?: "rail" | "floating";
};

type ChatSummary = {
  id: string;
  title: string;
  created_at?: string;
  updated_at: string;
  message_count: number;
  latest_message: {
    role: string;
    content: string;
    created_at: string;
  } | null;
};

type PersistedChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
};

function uiMessagesFromPersisted(
  messages: PersistedChatMessage[],
): UIMessage[] {
  return messages.map((m) => ({
    id: m.id,
    role: m.role === "system" ? "assistant" : m.role,
    parts: [{ type: "text", text: m.content }],
  }));
}

function ragIndexStorageKey(owner: string, repo: string) {
  return `house-assignment:rag-sha:${owner.toLowerCase()}:${repo.toLowerCase()}`;
}

function ragIndexingProgressKey(owner: string, repo: string) {
  return `house-assignment:rag-indexing:${owner.toLowerCase()}:${repo.toLowerCase()}`;
}

const INDEXING_PROGRESS_TTL_MS = 20 * 60 * 1000;
const INDEXED_SHA_TTL_MS = 3 * 60 * 1000;
const PROGRESS_WRITE_THROTTLE_MS = 450;
const STUCK_REFRESH_INTERVAL_MS = 900;
const STUCK_REFRESH_MAX_MS = 90_000;
const RESUME_POLL_INTERVAL_MS = 2000;
const RESUME_POLL_MAX_MS = 45_000;

type IndexedShaPayload = { sha: string; at: number };

function readStoredIndexedSha(owner: string, repo: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const key = ragIndexStorageKey(owner, repo);
    const raw = sessionStorage.getItem(key)?.trim();
    if (!raw) return null;

    // Legacy plain-string value (older builds) can become stale and unlock chat
    // while server-side `indexed_commit_sha` is still empty. Drop it.
    if (!raw.startsWith("{")) {
      sessionStorage.removeItem(key);
      return null;
    }

    const parsed = JSON.parse(raw) as IndexedShaPayload;
    if (
      typeof parsed.sha !== "string" ||
      !parsed.sha.trim() ||
      typeof parsed.at !== "number"
    ) {
      sessionStorage.removeItem(key);
      return null;
    }
    if (Date.now() - parsed.at > INDEXED_SHA_TTL_MS) {
      sessionStorage.removeItem(key);
      return null;
    }
    return parsed.sha.trim();
  } catch {
    return null;
  }
}

function writeStoredIndexedSha(owner: string, repo: string, sha: string) {
  try {
    const payload: IndexedShaPayload = { sha, at: Date.now() };
    sessionStorage.setItem(
      ragIndexStorageKey(owner, repo),
      JSON.stringify(payload),
    );
  } catch {
    /* private mode / quota */
  }
}

type IndexingProgressPayload = { at: number; percent: number; stage: string };

function readIndexingProgress(
  owner: string,
  repo: string,
): IndexingProgressPayload | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(ragIndexingProgressKey(owner, repo));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as IndexingProgressPayload;
    if (
      typeof parsed.at !== "number" ||
      typeof parsed.percent !== "number" ||
      typeof parsed.stage !== "string"
    ) {
      return null;
    }
    if (Date.now() - parsed.at > INDEXING_PROGRESS_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeIndexingProgress(
  owner: string,
  repo: string,
  percent: number,
  stage: string,
) {
  try {
    const payload: IndexingProgressPayload = {
      at: Date.now(),
      percent,
      stage,
    };
    sessionStorage.setItem(
      ragIndexingProgressKey(owner, repo),
      JSON.stringify(payload),
    );
  } catch {
    /* private mode / quota */
  }
}

function clearIndexingProgress(owner: string, repo: string) {
  try {
    sessionStorage.removeItem(ragIndexingProgressKey(owner, repo));
  } catch {
    /* noop */
  }
}

function newId() {
  return crypto.randomUUID();
}

function splitForProgressiveRender(delta: string): string[] {
  const normalized = delta.replace(/\r\n/g, "\n");
  const pieces: string[] = [];
  const MAX_CHARS = 48;
  let i = 0;
  while (i < normalized.length) {
    pieces.push(normalized.slice(i, i + MAX_CHARS));
    i += MAX_CHARS;
  }
  return pieces;
}

function normalizeMentionCandidate(raw: string): string | null {
  const clean = raw.trim().replace(/^@/, "").replace(/^\/+/, "");
  if (!clean) return null;
  if (clean.length > 260) return null;
  if (/\s/.test(clean)) return null;
  if (clean.includes("..")) return null;
  return clean;
}

function looksLikeIanaTimeZone(value: string): boolean {
  return /^[A-Z][A-Za-z_+-]+\/[A-Z][A-Za-z_+-]+(?:\/[A-Z][A-Za-z_+-]+)?$/.test(
    value,
  );
}

function pathLooksLikeDirectory(path: string): boolean {
  const leaf = path.split("/").pop() ?? path;
  return !leaf.includes(".");
}

function inferDirectoryIntentFromContext(
  fullText: string,
  offset: number,
  normalizedPath: string,
): boolean {
  if (pathLooksLikeDirectory(normalizedPath)) {
    const around = fullText
      .slice(Math.max(0, offset - 84), Math.min(fullText.length, offset + 84))
      .toLowerCase();
    if (
      /\b(folder|folders|directory|directories|tree|contents?|inside)\b/.test(
        around,
      )
    ) {
      return true;
    }
  }
  return false;
}

function codeTabHref(
  routeOwner: string,
  routeRepo: string,
  path: string,
  kind?: "file" | "dir",
): string {
  const params = new URLSearchParams({
    tab: "code",
    path,
  });
  if (kind) params.set("kind", kind);
  return `/repo/${encodeURIComponent(routeOwner)}/${encodeURIComponent(routeRepo)}?${params.toString()}`;
}

function linkifyAssistantPaths(
  text: string,
  routeOwner: string,
  routeRepo: string,
): string {
  // Convert backticked paths into internal code-tab links.
  let next = text.replace(
    /`([^`\n]{2,240})`/g,
    (match, raw, offset, source) => {
      const rawText = String(raw);
      const sourceText = String(source ?? "");
      const at =
        typeof offset === "number" ? offset : sourceText.indexOf(match);
      const trailingSlashDir = rawText.trim().endsWith("/");
      const normalized = normalizeMentionCandidate(rawText.replace(/\/+$/, ""));
      if (!normalized) return `\`${raw}\``;
      if (looksLikeIanaTimeZone(normalized)) return `\`${raw}\``;
      const pathLike = normalized.includes("/") || normalized.includes(".");
      if (!pathLike) return `\`${raw}\``;
      const inferredDir =
        trailingSlashDir ||
        pathLooksLikeDirectory(normalized) ||
        inferDirectoryIntentFromContext(sourceText, at, normalized);
      const isDir = inferredDir;
      const href = codeTabHref(
        routeOwner,
        routeRepo,
        normalized,
        isDir ? "dir" : "file",
      );
      return `[\`${normalized}\`](${href})`;
    },
  );

  // Convert explicit @mentions into clickable links.
  next = next.replace(
    /(^|\s)@([a-zA-Z0-9._/-]{2,240})/g,
    (match, prefix, raw, offset, source) => {
      const rawText = String(raw);
      const sourceText = String(source ?? "");
      const at =
        typeof offset === "number" ? offset : sourceText.indexOf(match);
      const trailingSlashDir = rawText.trim().endsWith("/");
      const normalized = normalizeMentionCandidate(rawText.replace(/\/+$/, ""));
      if (!normalized) return match;
      if (looksLikeIanaTimeZone(normalized)) return match;
      const inferredDir =
        trailingSlashDir ||
        pathLooksLikeDirectory(normalized) ||
        inferDirectoryIntentFromContext(sourceText, at, normalized);
      const isDir = inferredDir;
      const href = codeTabHref(
        routeOwner,
        routeRepo,
        normalized,
        isDir ? "dir" : "file",
      );
      return `${prefix}[@${normalized}](${href})`;
    },
  );

  // Convert plain path-like tokens into clickable links.
  next = next.replace(
    /(^|[\s(])((?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]+(?:\.[a-zA-Z0-9._-]+)?)(?=$|[\s),.:;!?])/g,
    (match, prefix, rawPath, offset, source) => {
      const pathText = String(rawPath);
      const sourceText = String(source ?? "");
      const at =
        typeof offset === "number" ? offset : sourceText.indexOf(match);
      const before = at > 0 ? sourceText[at - 1] : "";
      if (before === "`") return match;
      if (pathText.startsWith("http")) return match;
      if (pathText.includes("](")) return match;
      const normalized = normalizeMentionCandidate(pathText);
      if (!normalized) return match;
      if (looksLikeIanaTimeZone(normalized)) return match;
      const inferredDir = pathLooksLikeDirectory(normalized);
      const href = codeTabHref(
        routeOwner,
        routeRepo,
        normalized,
        inferredDir ? "dir" : "file",
      );
      return `${prefix}[\`${normalized}\`](${href})`;
    },
  );

  return next;
}

type NdjsonEvent =
  | { type: "progress"; percent: number; stage: string }
  | {
      type: "complete";
      skipped?: boolean;
      commit_sha: string;
      chunk_count?: number;
      indexed_at?: string | null;
    }
  | { type: "error"; message: string };

function drainJsonObjects(buffer: string): {
  objects: string[];
  remainder: string;
} {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];
    if (!ch) continue;

    if (start === -1) {
      if (ch === "{") {
        start = i;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        objects.push(buffer.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return {
    objects,
    remainder: start === -1 ? "" : buffer.slice(start),
  };
}

async function readNdjsonEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (ev: NdjsonEvent) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const emitFromText = (text: string) => {
    const normalized = text.replace(/\}\s*\{/g, "}\n{");
    const lines = normalized.split(/\r?\n/);
    const tail = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        onEvent(JSON.parse(trimmed) as NdjsonEvent);
      } catch {
        // non-line JSON chunk; fallback parser handles it
      }
    }
    return tail;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    buffer = emitFromText(buffer);
    const drained = drainJsonObjects(buffer);
    buffer = drained.remainder;
    for (const raw of drained.objects) {
      try {
        onEvent(JSON.parse(raw) as NdjsonEvent);
      } catch {
        /* ignore malformed chunk */
      }
    }
  }

  buffer += decoder.decode();
  buffer = emitFromText(buffer);
  const drained = drainJsonObjects(buffer);
  for (const raw of drained.objects) {
    try {
      onEvent(JSON.parse(raw) as NdjsonEvent);
    } catch {
      /* ignore */
    }
  }
}

export function RepoRagChat({
  routeOwner,
  routeRepo,
  displayOwner,
  displayRepo,
  indexedCommitSha,
  className,
  surface = "rail",
}: RepoRagChatProps) {
  const { refresh } = useRouter();
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("ready");
  const [chatError, setChatError] = useState<Error | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  const [localIndexedSha, setLocalIndexedSha] = useState<string | null>(null);

  const [indexPercent, setIndexPercent] = useState(0);
  const [indexStage, setIndexStage] = useState("");
  const [indexing, setIndexing] = useState(false);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [manualReindexing, setManualReindexing] = useState(false);
  const [mentionEntries, setMentionEntries] = useState<MentionPathEntry[]>([]);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const newChatDraftModeRef = useRef(false);
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);
  const [chatHistoryLoading, setChatHistoryLoading] = useState(false);
  const [chatHistoryError, setChatHistoryError] = useState<string | null>(null);
  const [chatLoading, setChatLoading] = useState(false);

  /**
   * After refresh: server may still be indexing — don't start a second HTTP index;
   * poll until `indexedCommitSha` appears.
   */
  const [resumePollOnly, setResumePollOnly] = useState(false);

  const lastProgressWriteRef = useRef(0);

  const ragUrl = `/api/repos/${encodeURIComponent(routeOwner)}/${encodeURIComponent(routeRepo)}/rag`;
  const indexUrl = `/api/repos/${encodeURIComponent(routeOwner)}/${encodeURIComponent(routeRepo)}/index-embeddings?stream=1`;
  const chatsUrl = `/api/repos/${encodeURIComponent(routeOwner)}/${encodeURIComponent(routeRepo)}/chats`;
  const clientTimeZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch {
      return null;
    }
  }, []);

  useLayoutEffect(() => {
    queueMicrotask(() => {
      setLocalIndexedSha(readStoredIndexedSha(routeOwner, routeRepo));
    });
  }, [routeOwner, routeRepo]);

  /** If we already have a commit on the server, drop any stale “indexing” session blob. */
  useLayoutEffect(() => {
    if (indexedCommitSha?.trim()) {
      clearIndexingProgress(routeOwner, routeRepo);
      queueMicrotask(() => {
        setResumePollOnly(false);
      });
    }
  }, [indexedCommitSha, routeOwner, routeRepo]);

  /** Resume UI from session after refresh (no new index POST until TTL). */
  useLayoutEffect(() => {
    if (indexedCommitSha?.trim()) return;

    const saved = readIndexingProgress(routeOwner, routeRepo);
    if (!saved) {
      queueMicrotask(() => {
        setResumePollOnly(false);
      });
      return;
    }

    queueMicrotask(() => {
      setResumePollOnly(true);
      setIndexPercent(saved.percent);
      setIndexStage(saved.stage);
    });
  }, [routeOwner, routeRepo, indexedCommitSha]);

  /** Recover SHA from storage if the NDJSON “complete” line was missed. */
  useLayoutEffect(() => {
    if (indexPercent < 95) return;
    const stored = readStoredIndexedSha(routeOwner, routeRepo)?.trim();
    if (!stored) return;
    queueMicrotask(() => {
      setLocalIndexedSha((prev) => prev?.trim() || stored);
    });
  }, [indexPercent, routeOwner, routeRepo]);

  useEffect(() => {
    const fromServer = indexedCommitSha?.trim();
    if (!fromServer) return;
    writeStoredIndexedSha(routeOwner, routeRepo, fromServer);
    queueMicrotask(() => {
      setLocalIndexedSha(fromServer);
    });
  }, [indexedCommitSha, routeOwner, routeRepo]);

  const effectiveIndexedSha = useMemo(
    () => indexedCommitSha?.trim() || localIndexedSha?.trim() || "",
    [indexedCommitSha, localIndexedSha],
  );

  const maybeWriteProgress = useCallback(
    (percent: number, stage: string) => {
      const now = Date.now();
      if (
        percent > 0 &&
        percent < 100 &&
        now - lastProgressWriteRef.current < PROGRESS_WRITE_THROTTLE_MS
      ) {
        return;
      }
      lastProgressWriteRef.current = now;
      writeIndexingProgress(routeOwner, routeRepo, percent, stage);
    },
    [routeOwner, routeRepo],
  );

  const burstRefresh = useCallback(() => {
    refresh();
    requestAnimationFrame(() => {
      refresh();
    });
    setTimeout(() => refresh(), 120);
    setTimeout(() => refresh(), 600);
  }, [refresh]);

  const runIndexStream = useCallback(
    async (options?: { force?: boolean }) => {
      if (indexing) return;
      const force = options?.force === true;
      if (force) {
        setManualReindexing(true);
        setStatus("ready");
      }
      setResumePollOnly(false);
      setIndexError(null);
      setChatHistoryError(null);
      setIndexPercent(0);
      setIndexStage("Connecting…");
      setIndexing(true);
      writeIndexingProgress(routeOwner, routeRepo, 0, "Connecting…");

      const ac = new AbortController();
      abortRef.current = ac;

      try {
        const res = await fetch(force ? `${indexUrl}&force=1` : indexUrl, {
          method: "POST",
          signal: ac.signal,
        });

        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(
            typeof data.error === "string" ? data.error : `HTTP ${res.status}`,
          );
        }

        if (!res.body) {
          throw new Error("No response body");
        }

        await readNdjsonEvents(res.body, (ev) => {
          if (ev.type === "progress") {
            setIndexPercent(ev.percent);
            setIndexStage(ev.stage);
            maybeWriteProgress(ev.percent, ev.stage);
          }
          if (ev.type === "complete") {
            setIndexPercent(100);
            setIndexStage(
              ev.skipped ? "Ready (already indexed)." : "Index complete.",
            );
            clearIndexingProgress(routeOwner, routeRepo);
            const sha = ev.commit_sha.trim();
            if (sha) {
              writeStoredIndexedSha(routeOwner, routeRepo, sha);
              setLocalIndexedSha(sha);
            }
            if (ev.skipped) {
              toast.message(
                force
                  ? "Re-index skipped: current commit is already indexed."
                  : "Repository already indexed for this commit.",
              );
            } else {
              toast.success(
                force
                  ? "Repository re-indexed for Q&A."
                  : "Repository indexed for Q&A.",
              );
            }
            burstRefresh();
          }
          if (ev.type === "error") {
            throw new Error(ev.message);
          }
        });
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
          setIndexStage("Cancelled.");
          clearIndexingProgress(routeOwner, routeRepo);
          return;
        }
        const msg =
          e instanceof Error ? e.message : "Indexing failed. Try again.";
        setIndexError(msg);
        clearIndexingProgress(routeOwner, routeRepo);
      } finally {
        setIndexing(false);
        if (force) {
          setManualReindexing(false);
        }
        if (abortRef.current === ac) {
          abortRef.current = null;
        }
      }
    },
    [
      burstRefresh,
      indexUrl,
      indexing,
      maybeWriteProgress,
      routeOwner,
      routeRepo,
    ],
  );

  const chatReady = Boolean(effectiveIndexedSha) && !manualReindexing;

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, [routeOwner, routeRepo]);

  useEffect(() => {
    if (!chatReady) {
      queueMicrotask(() => {
        setMentionEntries([]);
      });
      return;
    }
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch(
          `/api/repos/${encodeURIComponent(routeOwner)}/${encodeURIComponent(routeRepo)}/indexed-paths`,
          { signal: ac.signal },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? "Failed to load indexed paths");
        }
        const body = (await res.json()) as { entries?: MentionPathEntry[] };
        if (!Array.isArray(body.entries)) return;
        setMentionEntries(body.entries);
      } catch (error) {
        // Keep chat usable if mention list cannot be loaded, but still surface a
        // friendly message in the history panel so this failure isn't silent.
        const message =
          error instanceof Error
            ? error.message
            : "Failed to load indexed paths";
        setChatHistoryError(message);
      }
    })();
    return () => ac.abort();
  }, [chatReady, routeOwner, routeRepo]);

  const MentionInputSlot = useCallback(
    (props: InputBarProps) => (
      <RepoRagInputBar {...props} mentionEntries={mentionEntries} />
    ),
    [mentionEntries],
  );

  const loadChats = useCallback(async () => {
    if (!chatReady) return;
    setChatHistoryLoading(true);
    setChatHistoryError(null);
    try {
      const res = await fetch(chatsUrl);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Failed to load chats");
      }
      const body = (await res.json()) as { chats?: ChatSummary[] };
      const next = Array.isArray(body.chats) ? body.chats : [];
      setChats(next);
      if (!activeChatId && !newChatDraftModeRef.current && next.length > 0) {
        setActiveChatId(next[0]!.id);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to load chats";
      setChatHistoryError(message);
    } finally {
      setChatHistoryLoading(false);
    }
  }, [activeChatId, chatReady, chatsUrl]);

  const refreshChatsListOnly = useCallback(async () => {
    if (!chatReady) return;
    try {
      const res = await fetch(chatsUrl);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Failed to refresh chats");
      }
      const body = (await res.json()) as { chats?: ChatSummary[] };
      const next = Array.isArray(body.chats) ? body.chats : [];
      setChats(next);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to refresh chats";
      setChatHistoryError(message);
    }
  }, [chatReady, chatsUrl]);

  const loadChatMessages = useCallback(
    async (chatId: string) => {
      setChatLoading(true);
      setChatHistoryError(null);
      try {
        const res = await fetch(`${chatsUrl}/${encodeURIComponent(chatId)}`);
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? "Failed to load chat");
        }
        const body = (await res.json()) as {
          messages?: PersistedChatMessage[];
        };
        const persisted = Array.isArray(body.messages) ? body.messages : [];
        setMessages((prev) => {
          if (
            (status === "submitted" || status === "streaming") &&
            chatId === activeChatId
          ) {
            return prev;
          }
          const incoming = uiMessagesFromPersisted(persisted);
          return incoming;
        });
        setStatus((prev) =>
          prev === "submitted" || prev === "streaming" ? prev : "ready",
        );
        setChatError(undefined);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Failed to load chat";
        setChatHistoryError(message);
      } finally {
        setChatLoading(false);
      }
    },
    [activeChatId, chatsUrl, status],
  );

  const deleteChat = useCallback(
    async (chatId: string) => {
      setChatHistoryError(null);
      const res = await fetch(`${chatsUrl}/${encodeURIComponent(chatId)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Failed to delete chat");
      }
      setChats((prev) => prev.filter((c) => c.id !== chatId));
      if (activeChatId === chatId) {
        setActiveChatId(null);
        setMessages([]);
      }
    },
    [activeChatId, chatsUrl],
  );

  const loadChatsEvent = useEffectEvent(() => {
    void loadChats();
  });
  const loadChatMessagesEvent = useEffectEvent((chatId: string) => {
    void loadChatMessages(chatId);
  });
  const runIndexStreamEvent = useEffectEvent(() => {
    void runIndexStream();
  });

  useEffect(() => {
    const onReindexRequest = (event: Event) => {
      const custom = event as CustomEvent<{ owner?: string; repo?: string }>;
      const owner = custom.detail?.owner?.toLowerCase() ?? "";
      const repo = custom.detail?.repo?.toLowerCase() ?? "";
      if (!owner || !repo) return;
      if (
        owner !== routeOwner.toLowerCase() ||
        repo !== routeRepo.toLowerCase()
      ) {
        return;
      }
      void runIndexStream({ force: true });
    };

    window.addEventListener("repo-rag-reindex-request", onReindexRequest);
    return () =>
      window.removeEventListener("repo-rag-reindex-request", onReindexRequest);
  }, [routeOwner, routeRepo, runIndexStream]);

  useEffect(() => {
    if (!chatReady) return;
    queueMicrotask(() => {
      loadChatsEvent();
    });
  }, [chatReady]);

  useEffect(() => {
    if (!chatReady || !activeChatId) return;
    queueMicrotask(() => {
      loadChatMessagesEvent(activeChatId);
    });
  }, [activeChatId, chatReady]);

  /** First load: either poll only (session says index in flight) or start stream. */
  useEffect(() => {
    if ((effectiveIndexedSha && !manualReindexing) || indexError || indexing)
      return;

    if (resumePollOnly) {
      const started = Date.now();
      const id = setInterval(() => {
        refresh();
        if (Date.now() - started >= RESUME_POLL_MAX_MS) {
          clearInterval(id);
          setResumePollOnly(false);
          clearIndexingProgress(routeOwner, routeRepo);
          setIndexError(
            "Previous indexing session did not report completion. Please retry indexing.",
          );
        }
      }, RESUME_POLL_INTERVAL_MS);
      return () => clearInterval(id);
    }

    queueMicrotask(() => {
      runIndexStreamEvent();
    });
  }, [
    effectiveIndexedSha,
    manualReindexing,
    resumePollOnly,
    refresh,
    indexError,
    indexing,
    routeOwner,
    routeRepo,
  ]);

  /** At 100%: server props can lag — refresh often until chat unlocks or cap. */
  useEffect(() => {
    if ((effectiveIndexedSha && !manualReindexing) || indexError) return;
    if (indexPercent < 100) return;

    const started = Date.now();
    const id = setInterval(() => {
      refresh();
      if (Date.now() - started > STUCK_REFRESH_MAX_MS) {
        clearInterval(id);
      }
    }, STUCK_REFRESH_INTERVAL_MS);

    burstRefresh();

    return () => clearInterval(id);
  }, [
    indexPercent,
    effectiveIndexedSha,
    manualReindexing,
    refresh,
    burstRefresh,
    indexError,
  ]);

  const onStop = useCallback(() => {
    abortRef.current?.abort();
    setStatus("ready");
  }, []);

  const onSend = useCallback(
    async ({ content }: { role: "user"; content: string }) => {
      if (!effectiveIndexedSha) {
        return;
      }
      if (manualReindexing) return;

      const trimmed = content.trim();
      if (!trimmed) return;

      setChatError(undefined);
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      const userId = newId();
      const assistantId = newId();

      setMessages((prev) => [
        ...prev,
        {
          id: userId,
          role: "user",
          parts: [{ type: "text", text: trimmed }],
        },
        {
          id: assistantId,
          role: "assistant",
          parts: [{ type: "text", text: "" }],
        },
      ]);
      setStatus("submitted");

      try {
        const currentChatId = activeChatId;

        const res = await fetch(ragUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/plain" },
          body: JSON.stringify({
            question: trimmed,
            stream: true,
            ...(clientTimeZone ? { timezone: clientTimeZone } : {}),
            ...(currentChatId ? { chat_id: currentChatId } : {}),
          }),
          signal: ac.signal,
        });

        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(errBody.error ?? res.statusText);
        }

        if (!res.body) {
          throw new Error("Empty response body");
        }

        const headerChatId = res.headers.get("X-RepoLens-Chat-Id")?.trim();
        const effectiveChatId = headerChatId || currentChatId;
        if (headerChatId && !currentChatId) {
          setActiveChatId(headerChatId);
          newChatDraftModeRef.current = false;
          void refreshChatsListOnly();
        }

        setStatus("streaming");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let acc = "";
        const paintTick = () =>
          new Promise<void>((resolve) => setTimeout(resolve, 12));

        const flushDelta = async (delta: string) => {
          const parts = splitForProgressiveRender(delta);
          for (const part of parts) {
            if (ac.signal.aborted) {
              throw new DOMException("Aborted", "AbortError");
            }
            acc += part;
            const renderText = linkifyAssistantPaths(
              acc,
              routeOwner,
              routeRepo,
            );
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      parts: [{ type: "text", text: renderText }],
                    }
                  : m,
              ),
            );
            await paintTick();
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const delta = decoder.decode(value, { stream: true });
          if (delta) {
            await flushDelta(delta);
          }
        }

        const trailing = decoder.decode();
        if (trailing) {
          await flushDelta(trailing);
        }

        if (!acc.trim()) {
          // Rare provider behavior: streaming completes with no text.
          // Retry once with non-stream JSON so users never see a blank answer.
          const retryRes = await fetch(ragUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              question: trimmed,
              stream: false,
              ...(clientTimeZone ? { timezone: clientTimeZone } : {}),
              ...(effectiveChatId ? { chat_id: effectiveChatId } : {}),
            }),
            signal: ac.signal,
          });
          if (retryRes.ok) {
            const body = (await retryRes.json().catch(() => ({}))) as {
              answer?: string;
            };
            const retryText =
              typeof body.answer === "string" ? body.answer.trim() : "";
            if (retryText) {
              const renderText = linkifyAssistantPaths(
                retryText,
                routeOwner,
                routeRepo,
              );
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        parts: [{ type: "text", text: renderText }],
                      }
                    : m,
                ),
              );
              setStatus("ready");
              return;
            }
          }

          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    parts: [
                      {
                        type: "text",
                        text: "I could not generate a response for that question. Please try again, or narrow it to a specific path like `@bench/vercel`.",
                      },
                    ],
                  }
                : m,
            ),
          );
        }

        setStatus("ready");
        void refreshChatsListOnly();
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    parts: [
                      {
                        type: "text",
                        text: (m.parts?.[0] as { text?: string })?.text
                          ? `${(m.parts[0] as { text: string }).text}\n\n(stopped)`
                          : "(stopped)",
                      },
                    ],
                  }
                : m,
            ),
          );
          setStatus("ready");
          return;
        }

        const message =
          e instanceof Error ? e.message : "Something went wrong. Try again.";
        setMessages((prev) => prev.filter((m) => m.id !== assistantId));
        setChatError(new Error(message));
        setStatus("error");
      } finally {
        if (abortRef.current === ac) {
          abortRef.current = null;
        }
      }
    },
    [
      activeChatId,
      effectiveIndexedSha,
      manualReindexing,
      ragUrl,
      refreshChatsListOnly,
      routeOwner,
      routeRepo,
      clientTimeZone,
    ],
  );

  const indexingStatusLine =
    indexError != null
      ? "Indexing failed."
      : resumePollOnly && !indexing
        ? "Index still running (from before you refreshed). Waiting for the server, usually under a minute for large repos."
        : indexing || indexPercent < 100
          ? "Indexing repository for grounded answers…"
          : indexPercent >= 100
            ? "Almost ready: syncing this page with your project. If it stalls, check the error below or retry."
            : "Preparing…";

  const newChatAndHistory =
    surface === "floating" ? (
      <div className="flex shrink-0 items-center gap-1">
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-8 shrink-0"
              disabled={!chatReady || chatLoading}
              onClick={() => {
                newChatDraftModeRef.current = true;
                setActiveChatId(null);
                setMessages([]);
                setStatus("ready");
                setChatError(undefined);
              }}
              aria-label="New chat"
            >
              <Plus className="size-4" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="end">
            New chat
          </TooltipContent>
        </Tooltip>
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={chatHistoryOpen ? "secondary" : "outline"}
              size="icon"
              className="size-8 shrink-0"
              disabled={!chatReady}
              onClick={() => setChatHistoryOpen((v) => !v)}
              aria-pressed={chatHistoryOpen}
              aria-label="Chat history"
            >
              <Clock3 className="size-4" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="end">
            History
          </TooltipContent>
        </Tooltip>
      </div>
    ) : (
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 px-2.5 text-[12px]"
          disabled={!chatReady || chatLoading}
          onClick={() => {
            newChatDraftModeRef.current = true;
            setActiveChatId(null);
            setMessages([]);
            setStatus("ready");
            setChatError(undefined);
          }}
        >
          <Plus className="size-3.5 shrink-0" aria-hidden />
          New chat
        </Button>
        <Button
          type="button"
          variant={chatHistoryOpen ? "secondary" : "outline"}
          size="sm"
          className="h-8 gap-1.5 px-2.5 text-[12px]"
          disabled={!chatReady}
          onClick={() => setChatHistoryOpen((v) => !v)}
          aria-pressed={chatHistoryOpen}
        >
          <Clock3 className="size-3.5 shrink-0" aria-hidden />
          History
        </Button>
      </div>
    );

  return (
    <div
      className={cn("flex h-full min-h-0 flex-col bg-background", className)}
    >
      {surface === "floating" ? (
        <div className="shrink-0 border-border/80 border-b bg-muted/55 px-4 py-3 pr-12 dark:bg-muted/30">
          <div className="flex flex-col gap-2.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <p className="font-semibold text-[13px] text-foreground leading-snug tracking-tight">
                  Repository AI
                </p>
                <p className="text-[11px] text-muted-foreground leading-snug">
                  Ask questions grounded in this repo&apos;s index.
                </p>
              </div>
              {newChatAndHistory}
            </div>
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              {displayOwner}/{displayRepo}
            </p>
          </div>
        </div>
      ) : (
        <div className="shrink-0 border-border border-b px-3 py-2.5 pr-12 lg:pr-3">
          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <div className="min-w-0 sm:pr-0">
              <p className="font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
                AI chat
              </p>
              <p className="truncate font-mono text-[12px] text-foreground">
                {displayOwner}/{displayRepo}
              </p>
            </div>
            {newChatAndHistory}
          </div>
        </div>
      )}
      {chatHistoryOpen ? (
        <div className="shrink-0 border-border border-b bg-background px-2 py-1.5">
          <div className="max-h-56 overflow-y-auto scrollbar-hide">
            {chatHistoryLoading ? (
              <div className="space-y-1 p-1">
                {Array.from({ length: 4 }).map((_, idx) => (
                  <div
                    key={`chat-history-skeleton-${idx}`}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5"
                  >
                    <Skeleton className="h-3.5 w-28" />
                    <Skeleton className="ml-auto size-5 rounded-sm" />
                  </div>
                ))}
              </div>
            ) : chats.length === 0 ? (
              <p className="px-2 py-1 text-[11px] text-muted-foreground">
                No saved chats yet.
              </p>
            ) : (
              <div className="space-y-0.5">
                {chats.map((chat) => (
                  <div
                    key={chat.id}
                    className={cn(
                      "group/history-item flex items-center gap-1 rounded-md px-1 py-0.5 text-left transition-colors",
                      activeChatId === chat.id
                        ? "bg-accent text-accent-foreground"
                        : "bg-background text-foreground hover:bg-accent/60",
                    )}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 rounded-md px-1.5 py-1 text-left"
                      onClick={() => {
                        newChatDraftModeRef.current = false;
                        setActiveChatId(chat.id);
                        setChatHistoryOpen(false);
                      }}
                    >
                      <p className="truncate text-[12px] leading-tight">
                        {chat.title}
                      </p>
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={cn(
                        "size-6 shrink-0 text-destructive hover:bg-destructive/10",
                        "opacity-0 transition-opacity group-hover/history-item:opacity-100",
                        activeChatId === chat.id ? "opacity-100" : "",
                      )}
                      onClick={() => {
                        void deleteChat(chat.id).catch((e) => {
                          const message =
                            e instanceof Error ? e.message : "Delete failed";
                          setChatHistoryError(message);
                        });
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {chatHistoryError ? (
              <p className="px-2 py-1 text-[11px] text-destructive">
                {chatHistoryError}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {!chatReady ? (
        <>
          <div className="flex min-h-0 flex-1 flex-col justify-center gap-3 overflow-y-auto p-4">
            <p className="text-[12px] text-muted-foreground leading-relaxed">
              {indexingStatusLine}
            </p>

            <div className="flex flex-col gap-1.5">
              <div className="flex justify-between gap-2 text-[11px] text-muted-foreground">
                <span className="min-w-0 truncate">{indexStage}</span>
                <span className="shrink-0 tabular-nums">
                  {Math.min(100, Math.max(0, indexPercent))}%
                </span>
              </div>
              <Progress
                className="h-2"
                value={Math.min(100, Math.max(0, indexPercent))}
              />
              {resumePollOnly && !indexing ? (
                <p className="text-[11px] text-muted-foreground leading-snug">
                  Progress is restored from this browser session. We are not
                  starting another full index.
                </p>
              ) : null}
            </div>

            {indexError ? (
              <div className="flex flex-col gap-2">
                <p className="text-[11px] text-destructive leading-snug">
                  {indexError}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={indexing}
                  onClick={() => void runIndexStream()}
                >
                  Retry indexing
                </Button>
              </div>
            ) : null}
          </div>

          <div className="shrink-0 border-border border-t p-3">
            <InputBar
              onSend={() => {}}
              onStop={() => {}}
              status="ready"
              disabled
              placeholder="Indexing… you can type after the index finishes."
              className="px-0 pb-0"
            />
          </div>
        </>
      ) : (
        <AgentChat
          className="min-h-0 flex-1"
          messages={messages}
          status={status}
          slots={{ InputBar: MentionInputSlot }}
          onSend={(message) => {
            void onSend(message);
          }}
          onStop={onStop}
          error={chatError}
          suggestions={[
            {
              id: "summarize",
              label: "Summarize this repo",
              value: "Summarize what this repository does and who it is for.",
            },
            {
              id: "stack",
              label: "Tech stack",
              value:
                "What is the main tech stack and how is the project structured?",
            },
            {
              id: "entry",
              label: "Entry points",
              value:
                "What are the main entry points and how do I run the app locally?",
            },
          ]}
        />
      )}
    </div>
  );
}
