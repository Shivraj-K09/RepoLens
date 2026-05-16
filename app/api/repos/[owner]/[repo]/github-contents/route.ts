import { NextResponse } from "next/server";
import { z } from "zod";

import {
  githubListRepoPathContents,
  githubReadRepoFileUtf8,
  normalizeRepoContentPath,
} from "@/lib/github/repo-path";
import {
  checkRateLimit,
  rateLimitExceededResponse,
} from "@/lib/security/rate-limit";
import { sanitizeErrorMessage } from "@/lib/security/sanitize-error-message";
import { createClient } from "@/lib/supabase/server";
import { requireSavedRepoAccess } from "@/lib/supabase/require-repo-for-user";

const querySchema = z.object({
  mode: z.enum(["list", "raw"]),
  ref: z.string().trim().min(1, "Missing ref"),
  path: z.string().optional(),
});

type RouteParams = { params: Promise<{ owner: string; repo: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  const { owner: ownerParam, repo: repoParam } = await params;
  const ownerNorm = ownerParam.toLowerCase();
  const repoNorm = repoParam.toLowerCase();

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const githubContentsRateLimit = checkRateLimit({
    request,
    namespace: "repos:github-contents",
    userId: user.id,
    max: 240,
    windowMs: 60 * 1000,
  });
  if (!githubContentsRateLimit.allowed) {
    return rateLimitExceededResponse(
      githubContentsRateLimit,
      "Too many repository content requests. Please retry shortly.",
    );
  }

  const saved = await requireSavedRepoAccess(user.id, ownerNorm, repoNorm);
  if (saved.status === "db_error") {
    return NextResponse.json(
      { error: sanitizeErrorMessage(saved.message) },
      { status: 500 },
    );
  }
  if (saved.status === "not_saved") {
    return NextResponse.json(
      { error: "Repository not saved for this account" },
      { status: 403 },
    );
  }

  const canonicalOwner = saved.row.github_owner;
  const canonicalRepo = saved.row.github_repo;

  let search: URLSearchParams;
  try {
    search = new URL(request.url).searchParams;
  } catch {
    return NextResponse.json({ error: "Bad URL" }, { status: 400 });
  }

  const parsed = querySchema.safeParse({
    mode: search.get("mode"),
    ref: search.get("ref"),
    path: search.get("path") ?? "",
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const { mode, ref } = parsed.data;
  const pathNormalized = normalizeRepoContentPath(parsed.data.path ?? "");

  if (!pathNormalized.ok) {
    return NextResponse.json({ error: pathNormalized.reason }, { status: 400 });
  }

  const posixPath = pathNormalized.path;

  if (mode === "list") {
    const listed = await githubListRepoPathContents(
      canonicalOwner,
      canonicalRepo,
      ref,
      posixPath,
    );
    if (listed === null) {
      return NextResponse.json({ error: "GitHub unavailable" }, { status: 502 });
    }
    if (listed === "not-a-directory") {
      return NextResponse.json(
        { error: "Not a directory" },
        { status: 422 },
      );
    }
    return NextResponse.json(
      { entries: listed },
      { headers: { "Cache-Control": "private, max-age=120" } },
    );
  }

  /* raw file */
  if (!posixPath) {
    return NextResponse.json({ error: "Missing file path" }, { status: 400 });
  }

  const file = await githubReadRepoFileUtf8(
    canonicalOwner,
    canonicalRepo,
    ref,
    posixPath,
  );

  if (!file.ok) {
    switch (file.code) {
      case "not_found":
        return NextResponse.json({ error: file.code }, { status: 404 });
      case "too_large":
        return NextResponse.json({ error: file.code }, { status: 413 });
      case "not_file":
        return NextResponse.json({ error: file.code }, { status: 422 });
      case "binary_or_decode":
        return NextResponse.json({ error: file.code }, { status: 415 });
      default:
        return NextResponse.json({ error: file.code }, { status: 502 });
    }
  }

  return NextResponse.json(
    { path: posixPath, text: file.text, size: file.size },
    { headers: { "Cache-Control": "private, max-age=180" } },
  );
}
