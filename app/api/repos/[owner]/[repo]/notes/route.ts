import { NextResponse } from "next/server";
import { z } from "zod";

import { sanitizeErrorMessage } from "@/lib/security/sanitize-error-message";
import { createClient } from "@/lib/supabase/server";
import { requireSavedRepoAccess } from "@/lib/supabase/require-repo-for-user";

type RouteParams = { params: Promise<{ owner: string; repo: string }> };

const createNoteSchema = z.object({
  title: z.string().max(120).optional(),
  body: z.string().trim().min(1, "Note text is required").max(500),
  color_index: z.number().int().min(0).max(9).optional(),
});

export async function GET(_request: Request, { params }: RouteParams) {
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

  const repoRow = await requireSavedRepoAccess(user.id, ownerNorm, repoNorm);
  if (!repoRow) {
    return NextResponse.json(
      { error: "Repository not saved for this account" },
      { status: 403 },
    );
  }

  const { data, error } = await supabase
    .from("repository_notes")
    .select("id, title, body, color_index, sort_order, created_at, updated_at")
    .eq("repository_id", repoRow.id)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    if (/relation .*repository_notes|does not exist/i.test(error.message)) {
      return NextResponse.json(
        {
          error:
            "Notes table missing. Run `supabase/manual/repository-notes.sql` in the Supabase SQL editor.",
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: sanitizeErrorMessage(error.message) },
      { status: 500 },
    );
  }

  return NextResponse.json({ notes: data ?? [] });
}

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
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const repoRow = await requireSavedRepoAccess(user.id, ownerNorm, repoNorm);
  if (!repoRow) {
    return NextResponse.json(
      { error: "Repository not saved for this account" },
      { status: 403 },
    );
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = createNoteSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const title = (parsed.data.title ?? "").trim();
  const color_index = parsed.data.color_index ?? 0;

  const { data, error } = await supabase
    .from("repository_notes")
    .insert({
      user_id: user.id,
      repository_id: repoRow.id,
      title,
      body: parsed.data.body.trim(),
      color_index,
    })
    .select("id, title, body, color_index, sort_order, created_at, updated_at")
    .single();

  if (error) {
    if (/relation .*repository_notes|does not exist/i.test(error.message)) {
      return NextResponse.json(
        {
          error:
            "Notes table missing. Run `supabase/manual/repository-notes.sql` in the Supabase SQL editor.",
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: sanitizeErrorMessage(error.message) },
      { status: 500 },
    );
  }

  return NextResponse.json({ note: data }, { status: 201 });
}
