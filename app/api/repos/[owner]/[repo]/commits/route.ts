import { NextResponse } from "next/server";
import { z } from "zod";

import { fetchRepoCommitsPage } from "@/lib/github/fetch-repo-commits";
import {
  checkRateLimit,
  rateLimitExceededResponse,
} from "@/lib/security/rate-limit";
import { sanitizeErrorMessage } from "@/lib/security/sanitize-error-message";
import { createClient } from "@/lib/supabase/server";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  per_page: z.coerce.number().int().min(1).max(50).optional().default(20),
  ref: z.string().trim().min(1).optional(),
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

  const rate = checkRateLimit({
    request,
    namespace: "repos:commits",
    userId: user.id,
    max: 60,
    windowMs: 60 * 1000,
  });
  if (!rate.allowed) {
    return rateLimitExceededResponse(
      rate,
      "Too many commit list requests. Please retry shortly.",
    );
  }

  const { data: repoRow, error: repoErr } = await supabase
    .from("repositories")
    .select("id, github_owner, github_repo, default_branch")
    .eq("user_id", user.id)
    .eq("github_owner_norm", ownerNorm)
    .eq("github_repo_norm", repoNorm)
    .maybeSingle();

  if (repoErr || !repoRow) {
    return NextResponse.json({ error: "Repository not found." }, { status: 404 });
  }

  let search: URLSearchParams;
  try {
    search = new URL(request.url).searchParams;
  } catch {
    return NextResponse.json({ error: "Bad URL" }, { status: 400 });
  }

  const parsed = querySchema.safeParse({
    page: search.get("page") ?? undefined,
    per_page: search.get("per_page") ?? undefined,
    ref: search.get("ref") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const { page, per_page: perPage } = parsed.data;
  const refParam = parsed.data.ref;
  const ref = refParam?.length
    ? refParam
    : repoRow.default_branch?.trim() || undefined;

  try {
    const result = await fetchRepoCommitsPage(repoRow.github_owner, repoRow.github_repo, {
      ref,
      page,
      perPage,
    });

    if (!result) {
      return NextResponse.json(
        { error: "Could not load commits from GitHub." },
        { status: 502 },
      );
    }

    return NextResponse.json(
      {
        commits: result.commits,
        page,
        perPage,
        hasMore: result.hasMore,
        ref: ref ?? null,
      },
      { headers: { "Cache-Control": "private, max-age=60" } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: sanitizeErrorMessage(e instanceof Error ? e.message : "Failed.") },
      { status: 503 },
    );
  }
}
