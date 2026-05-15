"use client";

import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, {
  defaultSchema,
  type Options as SanitizeSchema,
} from "rehype-sanitize";

type RepoReadmeProps = {
  markdown: string;
  githubOwner: string;
  githubRepo: string;
  defaultBranch: string | null;
};

/**
 * GitHub-style README hygiene (based on `defaultSchema`) plus tags common in real READMEs:
 * `<picture>`, centered `<div align="center">`, badge `<img>` / `<a target="_blank">`, etc.
 */
const readmeSanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a ?? []), "target", "rel"],
    img: [
      ...(defaultSchema.attributes?.img ?? []),
      "width",
      "height",
      "srcSet",
      "loading",
      "decoding",
    ],
    source: [
      ...(defaultSchema.attributes?.source ?? []),
      "srcSet",
      "type",
      "media",
    ],
  },
};

function readmeBlobBase(
  owner: string,
  repo: string,
  branch: string | null,
): string | null {
  const b = branch?.trim();
  if (!b) return null;
  return `https://github.com/${owner}/${repo}/blob/${b}/`;
}

function normalizeReadmeHref(href: string, blobBase: string | null): string {
  const h = href.trim();
  if (!h) return h;
  if (h.startsWith("#")) return h;
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith("//")) return `https:${h}`;
  if (h.startsWith("/")) return `https://github.com${h}`;
  if (h.startsWith("mailto:") || h.startsWith("tel:")) return h;
  if (!blobBase) return h;
  const path = h.replace(/^\.\//, "");
  return `${blobBase}${path}`;
}

function readmeHrefOpensNewTab(resolved: string): boolean {
  const h = resolved.trim();
  if (!h || h.startsWith("#")) return false;
  if (h.startsWith("mailto:") || h.startsWith("tel:")) return false;
  return true;
}

function rehypeReadmeAnchors(blobBase: string | null) {
  return (tree: { children?: unknown[] }) => {
    const visit = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const n = node as {
        type?: string;
        tagName?: string;
        properties?: Record<string, unknown>;
        children?: unknown[];
      };
      if (n.type === "element" && n.tagName === "a") {
        const props = (n.properties ??= {});
        const rawHref = props.href;
        const hrefStr =
          typeof rawHref === "string"
            ? rawHref
            : Array.isArray(rawHref) && typeof rawHref[0] === "string"
              ? rawHref[0]
              : "";
        const normalized = normalizeReadmeHref(hrefStr, blobBase);
        if (normalized) props.href = normalized;
        if (readmeHrefOpensNewTab(normalized)) {
          props.target = "_blank";
          props.rel = "noopener noreferrer";
        }
      }
      if (Array.isArray(n.children)) {
        for (const c of n.children) visit(c);
      }
    };
    for (const child of tree.children ?? []) visit(child);
  };
}

function readmeAnchorsUnified(blobBase: string | null) {
  return () => (tree: { children?: unknown[] }) => {
    rehypeReadmeAnchors(blobBase)(tree);
  };
}

/**
 * Editorial README — matches page column width, calm rhythm,
 * restrained headings so it doesn&apos;t shout over the hero.
 */
export function RepoReadme({
  markdown,
  githubOwner,
  githubRepo,
  defaultBranch,
}: RepoReadmeProps) {
  const blobBase = readmeBlobBase(githubOwner, githubRepo, defaultBranch);

  const body =
    "readme scrollbar-hide w-full pt-2 text-[0.9575rem] leading-[1.72] tracking-[0.01em] antialiased text-foreground" +
    " [&_blockquote]:my-8 [&_blockquote]:border-muted-foreground/25 [&_blockquote]:border-l [&_blockquote]:pl-5 [&_blockquote]:text-muted-foreground [&_blockquote]:text-[0.9425rem] [&_blockquote]:italic" +
    " [&_code]:rounded [&_code]:border [&_code]:border-border/60 [&_code]:bg-muted/40 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.8675rem]" +
    " [&_pre_code]:rounded-none [&_pre_code]:border-0 [&_pre_code]:bg-transparent [&_pre_code]:px-0 [&_pre_code]:py-0 [&_pre_code]:text-[0.8375rem] [&_pre_code]:text-inherit" +
    " [&_h1]:mb-10 [&_h1]:border-border/60 [&_h1]:border-b [&_h1]:pb-3 [&_h1]:wrap-break-word [&_h1]:text-[1.2rem] [&_h1]:font-semibold [&_h1]:leading-tight [&_h1]:tracking-tight" +
    " [&_h2]:mb-6 [&_h2]:mt-14 [&_h2]:scroll-mt-20 [&_h2]:wrap-break-word [&_h2]:text-[1.05rem] [&_h2]:font-semibold [&_h2]:leading-snug [&_h2:first-of-type]:mt-10" +
    " [&_h3]:mb-5 [&_h3]:mt-12 [&_h3]:wrap-break-word [&_h3]:text-[1.0025rem] [&_h3]:font-semibold [&_h3]:leading-snug [&_strong]:font-semibold" +
    " [&_hr]:my-14 [&_hr]:border-border/70" +
    " [&_img]:my-10 [&_img]:inline-block [&_img]:max-w-full [&_img]:rounded-md" +
    " [&_li]:my-2 [&_li]:pl-1" +
    " [&_ol]:my-7 [&_ol]:list-decimal [&_ol]:pl-[1.25em] [&_ol]:text-muted-foreground" +
    " [&_p]:my-7 [&_p]:wrap-break-word [&_ul]:marker:text-muted-foreground" +
    " [&_picture]:my-10 [&_picture]:block" +
    " [&_pre]:scrollbar-hide [&_pre]:my-8 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border/65 [&_pre]:bg-muted/35 [&_pre]:p-[1rem_1.1rem] [&_pre]:font-mono [&_pre]:text-[0.8375rem] [&_pre]:leading-[1.62]" +
    " [&_table]:my-8 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:rounded-md [&_table]:border [&_table]:border-border/60 [&_table]:border-collapse [&_table]:text-[0.9175rem]" +
    " [&_td]:border-border/55 [&_td]:border-t [&_td]:bg-background/35 [&_td]:px-3 [&_td]:py-2.5" +
    " [&_th]:border-border/65 [&_th]:border-t [&_th]:bg-muted/45 [&_th]:px-3 [&_th]:py-2.5 [&_th]:text-left [&_th]:font-medium" +
    " [&_ul]:my-7 [&_ul]:list-disc [&_ul]:pl-[1.2em]" +
    " [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-[4px] [&_a]:decoration-primary/35 hover:[&_a]:decoration-primary/70";

  return (
    <article className={body}>
      <ReactMarkdown
        rehypePlugins={[
          rehypeRaw,
          [rehypeSanitize, readmeSanitizeSchema],
          readmeAnchorsUnified(blobBase),
        ]}
      >
        {markdown}
      </ReactMarkdown>
    </article>
  );
}
