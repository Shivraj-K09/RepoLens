"use client";

import type { ChatStatus } from "ai";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { InputBar } from "@/components/agent-elements/input-bar";
import {
  githubRepoParseErrorMessage,
  safeParseGithubRepoUrl,
} from "@/lib/github/repo-url";

type LandingRepoInputProps = {
  className?: string;
};

/**
 * Agent Elements `InputBar` — composed for a single GitHub repository URL (see agent-elements skill).
 */
export function LandingRepoInput({ className }: LandingRepoInputProps) {
  const { push } = useRouter();
  const [status] = useState<ChatStatus>("ready");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const onSend = useCallback(
    async ({ content }: { role: "user"; content: string }) => {
      const trimmed = content.trim();
      if (!trimmed) return;

      const parsed = safeParseGithubRepoUrl(trimmed);
      if (!parsed.success) {
        setError(githubRepoParseErrorMessage(parsed.error));
        return;
      }
      setError(null);
      setPending(true);
      try {
        const res = await fetch("/api/repos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: trimmed }),
        });
        const payload: unknown = await res.json().catch(() => null);
        const message =
          payload &&
          typeof payload === "object" &&
          "error" in payload &&
          typeof (payload as { error: unknown }).error === "string"
            ? (payload as { error: string }).error
            : "Could not save repository.";

        if (!res.ok) {
          setError(message);
          return;
        }

        push(`/repo/${parsed.data.owner}/${parsed.data.repo}`);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Could not save repository.";
        setError(message);
      } finally {
        setPending(false);
      }
    },
    [push],
  );

  const onStop = useCallback(() => {}, []);

  return (
    <div className={className}>
      <div className="w-full [--an-max-width:100%]">
        <InputBar
          status={status}
          onSend={onSend}
          onStop={onStop}
          disabled={pending}
          placeholder="https://github.com/owner/repository"
          className="px-0 pb-0"
        />
      </div>
      {error ? (
        <p
          className="mt-2 text-center text-[13px] text-destructive"
          role="status"
        >
          {error}
        </p>
      ) : pending ? (
        <p className="mt-2 flex items-center justify-center gap-1.5 text-[12px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Saving repository...
        </p>
      ) : null}
    </div>
  );
}
