"use client";

import type { ChatStatus } from "ai";
import { useCallback, useState } from "react";

import { InputBar } from "@/components/agent-elements/input-bar";

const GITHUB_REPO_URL =
  /^https?:\/\/(www\.)?github\.com\/[\w.-]+\/[\w.-]+(\/)?(\?.*)?$/i;

type LandingRepoInputProps = {
  className?: string;
};

/**
 * Agent Elements `InputBar` — composed for a single GitHub repository URL (see agent-elements skill).
 */
export function LandingRepoInput({ className }: LandingRepoInputProps) {
  const [status] = useState<ChatStatus>("ready");
  const [error, setError] = useState<string | null>(null);

  const onSend = useCallback(
    ({ content }: { role: "user"; content: string }) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      if (!GITHUB_REPO_URL.test(trimmed)) {
        setError(
          "Enter a valid GitHub repo URL, e.g. https://github.com/owner/repo",
        );
        return;
      }
      setError(null);
      // Wire navigation or indexing when the flow exists.
    },
    [],
  );

  const onStop = useCallback(() => {}, []);

  return (
    <div className={className}>
      <div className="w-full [--an-max-width:100%]">
        <InputBar
          status={status}
          onSend={onSend}
          onStop={onStop}
          placeholder="https://github.com/owner/repository"
          className="px-0 pb-0"
          autoFocus
        />
      </div>
      {error ? (
        <p
          className="mt-2 text-center text-[13px] text-destructive"
          role="status"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
