"use client";

import { File, Folder } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { InputBar, type InputBarProps } from "@/components/agent-elements/input-bar";
import { cn } from "@/lib/utils";

export type MentionPathEntry = {
  path: string;
  kind: "file" | "dir";
};

type RepoRagInputBarProps = InputBarProps & {
  mentionEntries?: MentionPathEntry[];
};

const HOLD_REPEAT_DELAY_MS = 170;
const HOLD_REPEAT_INTERVAL_MS = 48;

function readMentionQuery(input: string): { query: string; start: number; end: number } | null {
  const m = /(^|\s)@([^\s@]*)$/.exec(input);
  if (!m) return null;
  const end = input.length;
  const query = m[2] ?? "";
  return {
    query,
    start: end - query.length - 1,
    end,
  };
}

function scoreMention(path: string, query: string): number {
  const p = path.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 1;
  if (p === q) return 100;
  if (p.startsWith(q)) return 80;
  if (p.includes(`/${q}`)) return 60;
  if (p.includes(q)) return 40;
  return 0;
}

export function RepoRagInputBar({
  mentionEntries = [],
  value,
  onChange,
  disabled,
  ...rest
}: RepoRagInputBarProps) {
  const draft = value ?? "";
  const mentionState = readMentionQuery(draft);

  const suggestionItems = useMemo(() => {
    if (!mentionState) return [];
    const q = mentionState.query.trim();
    const ranked = mentionEntries
      .map((entry) => ({ entry, score: scoreMention(entry.path, q) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        if (a.entry.kind !== b.entry.kind) return a.entry.kind === "dir" ? -1 : 1;
        return a.entry.path.localeCompare(b.entry.path, undefined, {
          sensitivity: "base",
        });
      })
      .slice(0, 80)
      .map((row) => row.entry);
    return ranked;
  }, [mentionEntries, mentionState]);

  const [activeIndex, setActiveIndex] = useState(0);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const holdDelayTimeoutRef = useRef<number | null>(null);
  const holdRepeatIntervalRef = useRef<number | null>(null);
  const heldDirectionRef = useRef<-1 | 0 | 1>(0);

  useEffect(() => {
    queueMicrotask(() => {
      setActiveIndex(0);
    });
  }, [mentionState?.query, suggestionItems.length]);

  useEffect(() => {
    itemRefs.current = [];
  }, [suggestionItems.length]);

  const showMentions =
    !disabled &&
    Boolean(mentionState) &&
    suggestionItems.length > 0 &&
    typeof onChange === "function";

  useEffect(() => {
    if (!showMentions) return;
    const el = itemRefs.current[activeIndex];
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
  }, [activeIndex, showMentions]);

  function clearHeldArrowNavigation() {
    if (holdDelayTimeoutRef.current != null) {
      window.clearTimeout(holdDelayTimeoutRef.current);
      holdDelayTimeoutRef.current = null;
    }
    if (holdRepeatIntervalRef.current != null) {
      window.clearInterval(holdRepeatIntervalRef.current);
      holdRepeatIntervalRef.current = null;
    }
    heldDirectionRef.current = 0;
  }

  useEffect(() => {
    if (!showMentions) {
      clearHeldArrowNavigation();
    }
  }, [showMentions]);

  useEffect(() => {
    return () => {
      clearHeldArrowNavigation();
    };
  }, []);

  function applyMention(path: string) {
    if (!mentionState || typeof onChange !== "function") return;
    const before = draft.slice(0, mentionState.start);
    const after = draft.slice(mentionState.end);
    const next = `${before}@${path} ${after}`.replace(/\s{2,}/g, " ");
    onChange(next);
  }

  function moveSelection(direction: -1 | 1) {
    setActiveIndex((prev) => {
      if (direction > 0) {
        return Math.min(suggestionItems.length - 1, prev + 1);
      }
      return Math.max(0, prev - 1);
    });
  }

  function handleKeyDownCapture(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!showMentions) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const direction = (e.key === "ArrowDown" ? 1 : -1) as -1 | 1;
      e.preventDefault();
      e.stopPropagation();

      if (heldDirectionRef.current !== direction || !e.repeat) {
        moveSelection(direction);
      }

      if (!e.repeat) {
        clearHeldArrowNavigation();
        heldDirectionRef.current = direction;
        holdDelayTimeoutRef.current = window.setTimeout(() => {
          moveSelection(direction);
          holdRepeatIntervalRef.current = window.setInterval(() => {
            moveSelection(direction);
          }, HOLD_REPEAT_INTERVAL_MS);
        }, HOLD_REPEAT_DELAY_MS);
      }
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      const selected = suggestionItems[activeIndex];
      if (!selected) return;
      e.preventDefault();
      e.stopPropagation();
      applyMention(selected.path);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (typeof onChange === "function" && mentionState) {
        onChange(draft.slice(0, mentionState.start));
      }
    }
  }

  function handleKeyUpCapture(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      clearHeldArrowNavigation();
    }
  }

  return (
    <div
      className="relative"
      onKeyDownCapture={handleKeyDownCapture}
      onKeyUpCapture={handleKeyUpCapture}
      onBlurCapture={clearHeldArrowNavigation}
    >
      {showMentions ? (
        <div className="pointer-events-none absolute right-3 bottom-[calc(100%+6px)] left-3 z-40">
          <div className="pointer-events-auto max-h-56 overflow-y-auto scrollbar-hide rounded-md border border-border bg-popover p-1 shadow-md">
            {suggestionItems.map((item, idx) => (
              <button
                key={`${item.kind}:${item.path}`}
                type="button"
                ref={(el) => {
                  itemRefs.current[idx] = el;
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px]",
                  idx === activeIndex
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent hover:text-accent-foreground",
                )}
                onMouseEnter={() => setActiveIndex(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyMention(item.path);
                }}
                title={item.path}
              >
                {item.kind === "dir" ? (
                  <Folder className="size-3.5 shrink-0 opacity-80" />
                ) : (
                  <File className="size-3.5 shrink-0 opacity-80" />
                )}
                <span className="truncate font-mono">{item.path}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <InputBar
        {...rest}
        value={value}
        onChange={onChange}
        disabled={disabled}
      />
    </div>
  );
}
