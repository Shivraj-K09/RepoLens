import { NextResponse } from "next/server";
import { z } from "zod";

import { sanitizeErrorMessage } from "@/lib/security/sanitize-error-message";
import { createClient } from "@/lib/supabase/server";
import { requireSavedRepoAccess } from "@/lib/supabase/require-repo-for-user";

type RouteParams = {
  params: Promise<{ owner: string; repo: string; noteId: string }>;
};

const patchNoteSchema = z.object({
  title: z.string().max(120).optional(),
  body: z.string().trim().min(1).max(500).optional(),
  color_index: z.number().int().min(0).max(9).optional(),
});

export async function PATCH(request: Request, { params }: RouteParams) {
  const { owner: ownerParam, repo: repoParam, noteId } = await params;
  const ownerNorm = ownerParam.toLowerCase();
  const repoNorm = repoParam.toLowerCase();

  if (!z.string().uuid().safeParse(noteId).success) {
    return NextResponse.json({ error: "Invalid note id" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const repoLookup = await requireSavedRepoAccess(user.id, ownerNorm, repoNorm);
  if (repoLookup.status === "db_error") {
    return NextResponse.json(
      { error: sanitizeErrorMessage(repoLookup.message) },
      { status: 500 },
    );
  }
  if (repoLookup.status === "not_saved") {
    return NextResponse.json(
      { error: "Repository not saved for this account" },
      { status: 403 },
    );
  }
  const repoRow = repoLookup.row;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = patchNoteSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const patch: Record<string, string | number> = {
    updated_at: new Date().toISOString(),
  };
  if (parsed.data.title !== undefined) patch.title = parsed.data.title.trim();
  if (parsed.data.body !== undefined) patch.body = parsed.data.body.trim();
  if (parsed.data.color_index !== undefined) {
    patch.color_index = parsed.data.color_index;
  }

  if (Object.keys(patch).length <= 1) {
    return NextResponse.json(
      { error: "No updatable fields provided" },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from("repository_notes")
    .update(patch)
    .eq("id", noteId)
    .eq("repository_id", repoRow.id)
    .eq("user_id", user.id)
    .select("id, title, body, color_index, sort_order, created_at, updated_at")
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { error: sanitizeErrorMessage(error.message) },
      { status: 500 },
    );
  }
  if (!data) {
    return NextResponse.json({ error: "Note not found" }, { status: 404 });
  }

  return NextResponse.json({ note: data });
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  const { owner: ownerParam, repo: repoParam, noteId } = await params;
  const ownerNorm = ownerParam.toLowerCase();
  const repoNorm = repoParam.toLowerCase();

  if (!z.string().uuid().safeParse(noteId).success) {
    return NextResponse.json({ error: "Invalid note id" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const repoLookup = await requireSavedRepoAccess(user.id, ownerNorm, repoNorm);
  if (repoLookup.status === "db_error") {
    return NextResponse.json(
      { error: sanitizeErrorMessage(repoLookup.message) },
      { status: 500 },
    );
  }
  if (repoLookup.status === "not_saved") {
    return NextResponse.json(
      { error: "Repository not saved for this account" },
      { status: 403 },
    );
  }
  const repoRow = repoLookup.row;

  const { data: deleted, error } = await supabase
    .from("repository_notes")
    .delete()
    .eq("id", noteId)
    .eq("repository_id", repoRow.id)
    .eq("user_id", user.id)
    .select("id");

  if (error) {
    return NextResponse.json(
      { error: sanitizeErrorMessage(error.message) },
      { status: 500 },
    );
  }

  if (!deleted?.length) {
    return NextResponse.json({ error: "Note not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
