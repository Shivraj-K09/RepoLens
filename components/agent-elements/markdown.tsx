"use client";

import { Streamdown, type Components } from "streamdown";
import { createCodePlugin } from "@streamdown/code";
import { File as FileIcon, Folder as FolderIcon } from "lucide-react";
import Link from "next/link";
import { Children, isValidElement, type ReactNode } from "react";
import { cn } from "./utils/cn";

function fixNumberedListBreaks(text: string): string {
  return text.replace(/^(\d+)\.\s*\n+\s*\n*/gm, "$1. ");
}

const CODE_FENCE_LANGS = new Set([
  "bash",
  "diff",
  "html",
  "js",
  "json",
  "jsx",
  "md",
  "markdown",
  "sh",
  "shell",
  "text",
  "ts",
  "tsx",
  "yml",
  "yaml",
]);

function normalizeCodeFenceLanguages(text: string): string {
  return text.replace(/```([^\n]*)/g, (_match, langRaw) => {
    const lang = String(langRaw || "")
      .trim()
      .toLowerCase();
    if (!lang) return "```";
    const normalized = lang.split(/\s+/)[0];
    return CODE_FENCE_LANGS.has(normalized) ? `\`\`\`${normalized}` : "```text";
  });
}

export type MarkdownProps = {
  content: string;
  className?: string;
  textContrast?: "normal" | "high";
};

function sanitizeMarkdownHref(href: string): string | null {
  const value = href.trim();
  if (!value) return null;
  if (value.startsWith("#")) return value;
  if (value.startsWith("/")) return value;
  if (value.startsWith("mailto:") || value.startsWith("tel:")) return value;
  if (/^https?:\/\//i.test(value)) return value;
  return null;
}

function readNodeText(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";
  const maybe = node as { props?: { children?: unknown } };
  return readNodeText(maybe.props?.children);
}

function normalizeListEntryLabel(text: string): string {
  const trimmed = text.trim();
  const withoutSubmodule = trimmed.replace(/\s+\(submodule\)$/i, "");
  return withoutSubmodule.endsWith("/")
    ? withoutSubmodule.slice(0, -1)
    : withoutSubmodule;
}

function classifyListEntryKind(text: string): "dir" | "file" | null {
  const trimmed = text.trim();
  const withoutSubmodule = trimmed.replace(/\s+\(submodule\)$/i, "");
  if (!/^[a-zA-Z0-9._/-]+\/?$/.test(withoutSubmodule)) return null;
  if (withoutSubmodule.includes(".") && !withoutSubmodule.endsWith("/")) {
    return "file";
  }
  return "dir";
}

function looksLikePathTreeItem(text: string): boolean {
  const normalized = normalizeListEntryLabel(text);
  if (classifyListEntryKind(normalized)) return true;
  return /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)+$/.test(normalized);
}

function hasNestedListChildren(children: ReactNode): boolean {
  const childArray = Children.toArray(children);
  return childArray.some((node) => {
    if (!isValidElement(node)) return false;
    return node.type === "ul" || node.type === "ol";
  });
}

function hasElementChildren(children: ReactNode): boolean {
  const childArray = Children.toArray(children);
  return childArray.some((node) => isValidElement(node));
}

const code = createCodePlugin({
  themes: ["github-light", "github-dark"],
});

export function Markdown({ content, className }: MarkdownProps) {
  const safeContent = normalizeCodeFenceLanguages(
    fixNumberedListBreaks(content),
  );
  const components: Components = {
    h1: ({ children, ...props }) => (
      <h1 className="an-md-h1 text-base font-semibold mt-3 mb-1.5" {...props}>
        {children}
      </h1>
    ),
    h2: ({ children, ...props }) => (
      <h2 className="an-md-h2 text-base font-semibold mt-3 mb-1.5" {...props}>
        {children}
      </h2>
    ),
    h3: ({ children, ...props }) => (
      <h3 className="an-md-h3 text-sm font-semibold mt-2 mb-1" {...props}>
        {children}
      </h3>
    ),
    h4: ({ children, ...props }) => (
      <h4 className="an-md-h4 text-sm font-medium mt-2 mb-1" {...props}>
        {children}
      </h4>
    ),
    p: ({ children, ...props }) => (
      <p
        className="an-md-p whitespace-pre-wrap text-[13px] leading-relaxed text-an-foreground/80"
        {...props}
      >
        {children}
      </p>
    ),
    ul: ({ children, ...props }) => (
      <ul
        className="an-md-ul list-disc list-outside space-y-0.5 text-[13px] mb-2 pl-2 text-an-foreground/80 [&_ul]:pl-2 [&_ol]:pl-2 [&_li]:min-w-0 [&_li]:max-w-full [&_li]:wrap-anywhere"
        {...props}
      >
        {children}
      </ul>
    ),
    ol: ({ children, ...props }) => (
      <ol
        className="an-md-ol list-decimal list-outside space-y-0.5 text-[13px] mb-2 pl-3 text-an-foreground/80 [&_ul]:pl-2 [&_ol]:pl-2 [&_li]:min-w-0 [&_li]:max-w-full [&_li]:wrap-anywhere"
        {...props}
      >
        {children}
      </ol>
    ),
    li: ({ children, ...props }) => {
      const childArray = Children.toArray(children);
      const fullText = childArray.map(readNodeText).join("").trim();
      const labelSource = fullText.split("\n")[0]?.trim() ?? fullText;
      const label = normalizeListEntryLabel(labelSource);
      const kind = classifyListEntryKind(label);
      const pathTreeItem = looksLikePathTreeItem(labelSource);
      const inferredKind: "dir" | "file" =
        kind ??
        (label.includes(".") && !label.endsWith("/") ? "file" : "dir");

      // Only apply path-icon formatting for simple plain-text list rows.
      // Complex rows (links, nested lists, mixed markdown) should render as-is
      // to avoid truncating or collapsing nested content.
      if (hasNestedListChildren(children) || hasElementChildren(children)) {
        if (pathTreeItem) {
          return (
            <li
              className="an-md-li list-none text-[13px] pl-0.5 text-an-foreground/80 wrap-break-word"
              {...props}
            >
              <div className="flex items-start gap-1.5">
                {inferredKind === "dir" ? (
                  <FolderIcon
                    aria-hidden
                    className="mt-0.5 size-3.5 shrink-0 opacity-80"
                  />
                ) : (
                  <FileIcon
                    aria-hidden
                    className="mt-0.5 size-3.5 shrink-0 opacity-80"
                  />
                )}
                <div className="min-w-0 flex-1">{children}</div>
              </div>
            </li>
          );
        }
        return (
          <li
            className={cn(
              "an-md-li text-[13px] pl-0.5 text-an-foreground/80 wrap-break-word",
              pathTreeItem ? "list-none" : "",
            )}
            {...props}
          >
            {children}
          </li>
        );
      }
      if (!pathTreeItem) {
        return (
          <li
            className="an-md-li text-[13px] pl-0.5 text-an-foreground/80 wrap-break-word"
            {...props}
          >
            {children}
          </li>
        );
      }
      return (
        <li
          className="an-md-li list-none text-[13px] pl-0.5 text-an-foreground/80 wrap-break-word"
          {...props}
        >
          <span className="inline-flex items-start gap-1.5">
            {inferredKind === "dir" ? (
              <FolderIcon
                aria-hidden
                className="mt-0.5 size-3.5 shrink-0 opacity-80"
              />
            ) : (
              <FileIcon
                aria-hidden
                className="mt-0.5 size-3.5 shrink-0 opacity-80"
              />
            )}
            <span className="min-w-0 wrap-break-word">{label}</span>
          </span>
        </li>
      );
    },
    strong: ({ children, ...props }) => (
      <strong className="font-medium text-an-foreground" {...props}>
        {children}
      </strong>
    ),
    a: ({ href, children, ...props }) => {
      if (!href) return <span>{children}</span>;
      const safeHref = sanitizeMarkdownHref(href);
      if (!safeHref) return <span>{children}</span>;
      const isExternal =
        /^https?:\/\//i.test(safeHref) || safeHref.startsWith("mailto:");
      const isInternalRoute = !isExternal && safeHref.startsWith("/");
      const isRepoCodeLink =
        !isExternal &&
        safeHref.startsWith("/repo/") &&
        safeHref.includes("?tab=code");
      let isDirLink = false;
      if (isRepoCodeLink) {
        try {
          const url = new URL(safeHref, "http://localhost");
          const kind = url.searchParams.get("kind");
          const path = (url.searchParams.get("path") ?? "").trim();
          const leaf = path.split("/").filter(Boolean).at(-1) ?? "";
          const labelText = normalizeListEntryLabel(
            Children.toArray(children).map(readNodeText).join("").trim(),
          );
          const pathLooksDir = Boolean(leaf) && !leaf.includes(".");
          const labelLooksDir = Boolean(labelText) && !labelText.includes(".");
          isDirLink =
            kind === "dir" ||
            (kind !== "dir" && (pathLooksDir || labelLooksDir));
        } catch {
          isDirLink = false;
        }
      }
      if (isExternal) {
        return (
          <a
            {...props}
            href={safeHref}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "an-md-link hover:underline underline-offset-2 text-an-primary-color",
            )}
          >
            {children}
          </a>
        );
      }
      if (isInternalRoute) {
        return (
          <Link
            {...props}
            href={safeHref}
            onClick={(event) => {
              if (!isRepoCodeLink || typeof window === "undefined") return;
              try {
                const url = new URL(safeHref, window.location.origin);
                const parts = url.pathname.split("/").filter(Boolean);
                if (parts.length >= 3 && parts[0] === "repo") {
                  const owner = decodeURIComponent(parts[1] ?? "");
                  const repo = decodeURIComponent(parts[2] ?? "");
                  const path = url.searchParams.get("path") ?? "";
                  const tab = url.searchParams.get("tab") ?? "code";
                  if (owner && repo && path && tab === "code") {
                    event.preventDefault();
                    window.dispatchEvent(
                      new CustomEvent("repo-open-path", {
                        detail: { owner, repo, path },
                      }),
                    );
                  }
                }
              } catch {
                /* Link performs default navigation */
              }
            }}
            className={cn(
              "an-md-link hover:underline underline-offset-2 text-an-primary-color",
              isRepoCodeLink &&
                "inline-flex items-center gap-1 text-inherit no-underline hover:underline",
            )}
          >
            {isRepoCodeLink ? (
              isDirLink ? (
                <FolderIcon
                  aria-hidden
                  className="size-3.5 shrink-0 opacity-80"
                />
              ) : (
                <FileIcon
                  aria-hidden
                  className="size-3.5 shrink-0 opacity-80"
                />
              )
            ) : null}
            {children}
          </Link>
        );
      }
      return (
        <a
          {...props}
          href={safeHref}
          className={cn(
            "an-md-link hover:underline underline-offset-2 text-an-primary-color",
          )}
        >
          {children}
        </a>
      );
    },
    code: ({ children, className, ...props }) => {
      const isCodeBlock =
        typeof className === "string" && className.includes("language-");
      if (isCodeBlock) {
        return (
          <code className={className} {...props}>
            {children}
          </code>
        );
      }
      return (
        <code
          className="rounded-sm bg-an-foreground/10 px-1 py-0.5 font-mono text-[11px] leading-tight text-an-foreground/90"
          {...props}
        >
          {children}
        </code>
      );
    },
    blockquote: ({ children, ...props }) => (
      <blockquote
        className="an-md-blockquote pl-3 italic mb-2 text-[13px] border-l-2 border-an-border-color text-an-foreground/70"
        {...props}
      >
        {children}
      </blockquote>
    ),
    hr: ({ ...props }) => (
      <hr className="an-md-hr my-4 border-an-border-color" {...props} />
    ),
    table: ({ children, ...props }) => (
      <div className="overflow-x-auto my-3 border border-an-border-color rounded-an-tool-border-radius">
        <table
          className="an-md-table w-full text-sm [&>thead]:bg-an-tool-background [&>thead>tr>th]:bg-an-tool-background"
          {...props}
        >
          {children}
        </table>
      </div>
    ),
    th: ({ children, ...props }) => (
      <th
        className="text-left font-medium px-3 py-2 bg-an-background-secondary"
        {...props}
      >
        {children}
      </th>
    ),
    td: ({ children, ...props }) => (
      <td
        className="px-3 py-2 border-t border-an-border-color text-an-foreground/80"
        {...props}
      >
        {children}
      </td>
    ),
  };

  return (
    <div
      className={cn(
        "an-markdown",
        "overflow-visible wrap-break-word",
        "[&_li>p]:inline [&_li>p]:mb-0",
        className,
      )}
    >
      <Streamdown
        components={components}
        linkSafety={{ enabled: false }}
        plugins={{ code }}
      >
        {safeContent}
      </Streamdown>
    </div>
  );
}
