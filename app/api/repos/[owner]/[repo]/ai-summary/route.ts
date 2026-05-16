import { NextResponse } from "next/server";

import { ensureRepoAiSummaryCached } from "@/lib/ai/ensure-repo-ai-summary-cached";
import {
  checkRateLimit,
  rateLimitExceededResponse,
} from "@/lib/security/rate-limit";
import { sanitizeErrorMessage } from "@/lib/security/sanitize-error-message";
import { createClient } from "@/lib/supabase/server";
import { requireSavedRepoAccess } from "@/lib/supabase/require-repo-for-user";

type RouteParams = { params: Promise<{ owner: string; repo: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  const { owner: ownerParam, repo: repoParam } = await params;
  const ownerNorm = ownerParam.toLowerCase();
  const repoNorm = repoParam.toLowerCase();

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
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
      { error: "Repository not found." },
      { status: 404 },
    );
  }

  const rate = checkRateLimit({
    request,
    namespace: "repo-ai-summary",
    userId: user.id,
    max: 24,
    windowMs: 10 * 60 * 1000,
  });
  if (!rate.allowed) {
    return rateLimitExceededResponse(
      rate,
      "Too many summary requests. Please retry shortly.",
    );
  }

  const { data: repoRow, error: repoErr } = await supabase
    .from("repositories")
    .select(
      "github_owner, github_repo, last_commit_sha, default_branch, description, stars_count, forks_count",
    )
    .eq("id", saved.row.id)
    .single();

  if (repoErr || !repoRow) {
    return NextResponse.json(
      { error: "Repository not found." },
      { status: 404 },
    );
  }

  try {
    const result = await ensureRepoAiSummaryCached({
      supabase,
      githubOwner: repoRow.github_owner,
      githubRepo: repoRow.github_repo,
      lastCommitSha: repoRow.last_commit_sha,
      description: repoRow.description,
      defaultBranch: repoRow.default_branch,
      stars: repoRow.stars_count,
      forks: repoRow.forks_count,
    });

    return NextResponse.json({
      summary: {
        markdown: result.markdown,
        updatedAt: result.updatedAt,
        fromCache: result.fromCache,
      },
    });
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "Summary generation failed.";
    return NextResponse.json(
      { error: sanitizeErrorMessage(message) },
      { status: 503 },
    );
  }
}
