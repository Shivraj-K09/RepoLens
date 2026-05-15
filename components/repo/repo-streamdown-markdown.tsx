"use client";

import { createCodePlugin } from "@streamdown/code";
import { Streamdown } from "streamdown";

import { cn } from "@/lib/utils";

const codePlugin = createCodePlugin({
  themes: ["github-light", "github-dark"],
});

const streamdownMinimalCodeWrap = cn(
  "[&_[data-streamdown='code-block']]:m-0 [&_[data-streamdown='code-block']]:max-w-full [&_[data-streamdown='code-block']]:min-w-0 [&_[data-streamdown='code-block']]:rounded-none [&_[data-streamdown='code-block']]:border-0 [&_[data-streamdown='code-block']]:bg-transparent [&_[data-streamdown='code-block']]:shadow-none [&_[data-streamdown='code-block']]:ring-0",
  "[&_[data-streamdown='code-block-header']]:hidden",
  "[&_[data-streamdown='code-block-body']]:max-w-full [&_[data-streamdown='code-block-body']]:min-w-0 [&_[data-streamdown='code-block-body']]:overflow-x-hidden [&_[data-streamdown='code-block-body']]:bg-transparent [&_[data-streamdown='code-block-body']]:px-0 [&_[data-streamdown='code-block-body']]:py-0 [&_[data-streamdown='code-block-body']]:ring-0",
  "[&_[data-streamdown='code-block']_pre]:m-0 [&_[data-streamdown='code-block']_pre]:max-w-full [&_[data-streamdown='code-block']_pre]:min-w-0 [&_[data-streamdown='code-block']_pre]:border-0 [&_[data-streamdown='code-block']_pre]:bg-transparent [&_[data-streamdown='code-block']_pre]:p-0 [&_[data-streamdown='code-block']_pre]:whitespace-normal [&_[data-streamdown='code-block']_pre]:font-mono [&_[data-streamdown='code-block']_pre]:shadow-none",
);

/** Remove trailing ## Notes when it only contains a lone placeholder dash (legacy prompt output). */
function stripPlaceholderNotesSection(md: string): string {
  const normalized = md.replace(/\r\n/g, "\n").trimEnd();
  return normalized.replace(/\n## Notes\s*\n+\s*[-–—]\s*$/m, "").trimEnd();
}

type RepoStreamdownMarkdownProps = {
  markdown: string;
  className?: string;
};

export function RepoStreamdownMarkdown({
  markdown,
  className,
}: RepoStreamdownMarkdownProps) {
  return (
    <div
      className={cn(
        "repo-summary-markdown max-w-full min-w-0 overflow-x-auto text-[12px] leading-normal text-foreground scrollbar-hide",
        streamdownMinimalCodeWrap,
        className,
      )}
    >
      <Streamdown
        mode="static"
        linkSafety={{ enabled: false }}
        controls={{ code: false }}
        plugins={{ code: codePlugin }}
        shikiTheme={["github-light", "github-dark"]}
      >
        {stripPlaceholderNotesSection(markdown)}
      </Streamdown>
    </div>
  );
}
