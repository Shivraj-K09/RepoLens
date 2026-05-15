"use client";

import Image from "next/image";
import type { ComponentType } from "react";
import { useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/utils";

const SIMPLE_ICON_ALIAS: Record<string, string> = {
  "next.js": "nextdotjs",
  "node.js": "nodedotjs",
  "tailwind css": "tailwindcss",
  typescript: "typescript",
  javascript: "javascript",
  react: "react",
  vue: "vuedotjs",
  nuxt: "nuxtdotjs",
  sveltekit: "svelte",
  astro: "astro",
  vite: "vite",
  remix: "remix",
  angular: "angular",
  express: "express",
  nestjs: "nestjs",
  fastify: "fastify",
  prisma: "prisma",
  "drizzle orm": "drizzle",
  graphql: "graphql",
  supabase: "supabase",
  firebase: "firebase",
  postgresql: "postgresql",
  mysql: "mysql",
  sqlite: "sqlite",
  mongodb: "mongodb",
  python: "python",
  go: "go",
  rust: "rust",
  docker: "docker",
  "docker compose": "docker",
  terraform: "terraform",
  "cloudflare workers": "cloudflare",
  deno: "deno",
  turborepo: "turborepo",
  nx: "nx",
  aws: "amazonwebservices",
  azure: "microsoftazure",
  "google cloud": "googlecloud",
};

type SimpleIconMeta = {
  title?: string;
  hex?: string;
  aliases?: unknown;
};

const iconHexByLabelCache = new Map<string, string>();
let iconHexMapInflight: Promise<Map<string, string>> | null = null;

function normalizeIconKey(label: string): string {
  return label.toLowerCase().trim().replace(/\s+/g, " ");
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.replace(/^#/, "").trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function relativeLuminance(rgb: { r: number; g: number; b: number }): number {
  const toLinear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * toLinear(rgb.r) +
    0.7152 * toLinear(rgb.g) +
    0.0722 * toLinear(rgb.b)
  );
}

function contrastRatioAgainstDark(rgb: {
  r: number;
  g: number;
  b: number;
}): number {
  const bgLum = 0.004;
  const fgLum = relativeLuminance(rgb);
  const lighter = Math.max(fgLum, bgLum);
  const darker = Math.min(fgLum, bgLum);
  return (lighter + 0.05) / (darker + 0.05);
}

function pushIconLabelKey(
  map: Map<string, string>,
  rawLabel: unknown,
  hex: string,
) {
  if (typeof rawLabel !== "string") return;
  const normalized = normalizeIconKey(rawLabel);
  if (!normalized) return;
  if (!map.has(normalized)) map.set(normalized, hex);
}

async function loadSimpleIconHexMap(): Promise<Map<string, string>> {
  if (iconHexByLabelCache.size > 0) return iconHexByLabelCache;
  if (iconHexMapInflight) return iconHexMapInflight;

  iconHexMapInflight = (async () => {
    const out = new Map<string, string>();
    try {
      const res = await fetch(
        "https://cdn.jsdelivr.net/npm/simple-icons@latest/_data/simple-icons.json",
      );
      if (!res.ok) return out;
      const body = (await res.json()) as SimpleIconMeta[];
      if (!Array.isArray(body)) return out;

      for (const item of body) {
        const hex =
          typeof item.hex === "string" && /^[0-9a-fA-F]{6}$/.test(item.hex)
            ? item.hex.toLowerCase()
            : null;
        if (!hex) continue;
        pushIconLabelKey(out, item.title, hex);

        const aliases = item.aliases;
        if (Array.isArray(aliases)) {
          for (const alias of aliases) pushIconLabelKey(out, alias, hex);
        } else if (aliases && typeof aliases === "object") {
          for (const value of Object.values(aliases as Record<string, unknown>)) {
            if (Array.isArray(value)) {
              for (const alias of value) pushIconLabelKey(out, alias, hex);
            } else {
              pushIconLabelKey(out, value, hex);
            }
          }
        }
      }
      for (const [k, v] of out) iconHexByLabelCache.set(k, v);
      return out;
    } catch {
      return out;
    }
  })();

  try {
    return await iconHexMapInflight;
  } finally {
    iconHexMapInflight = null;
  }
}

export function iconSlugForLabel(label: string): string | null {
  const key = normalizeIconKey(label);
  if (SIMPLE_ICON_ALIAS[key]) return SIMPLE_ICON_ALIAS[key]!;
  const guess = key
    .replace(/\./g, "dot")
    .replace(/\+/g, "plus")
    .replace(/#/g, "sharp")
    .replace(/[^a-z0-9]/g, "");
  return guess || null;
}

export function StatTile({
  icon: Icon,
  label,
  value,
  className,
}: {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={cn("rounded-md border border-border/60 bg-background p-2", className)}>
      <dt className="inline-flex items-center gap-1.25 text-[10px] uppercase tracking-wide text-muted-foreground/90">
        <Icon className="size-3.5" aria-hidden />
        {label}
      </dt>
      <dd className="mt-1 text-[12.5px] font-semibold text-foreground tabular-nums">
        {value}
      </dd>
    </div>
  );
}

export function TechChip({
  label,
  iconSlug,
}: {
  label: string;
  iconSlug: string | null;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const [brandHex, setBrandHex] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!iconSlug && !label) {
      queueMicrotask(() => {
        if (cancelled) return;
        setBrandHex(null);
      });
      return;
    }
    void loadSimpleIconHexMap().then((map) => {
      if (cancelled) return;
      const key = normalizeIconKey(label);
      const byLabel = map.get(key) ?? null;
      queueMicrotask(() => {
        if (cancelled) return;
        setBrandHex(byLabel);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [iconSlug, label]);

  const iconColorHex = useMemo(() => {
    if (!brandHex) return null;
    const rgb = hexToRgb(brandHex);
    if (!rgb) return brandHex;
    return contrastRatioAgainstDark(rgb) < 2.2 ? "ffffff" : brandHex;
  }, [brandHex]);
  const iconSrc =
    !imgFailed && iconSlug
      ? `https://cdn.simpleicons.org/${iconSlug}${iconColorHex ? `/${iconColorHex}` : ""}`
      : null;

  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-foreground">
      {iconSrc ? (
        <Image
          src={iconSrc}
          alt=""
          width={12}
          height={12}
          unoptimized
          className="size-3 shrink-0"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <span
          aria-hidden
          className="size-3 shrink-0 rounded-full bg-muted-foreground/40"
        />
      )}
      <span>{label}</span>
    </span>
  );
}
