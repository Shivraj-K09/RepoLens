import { NextResponse } from "next/server";
import { z } from "zod";

import { sanitizeErrorMessage } from "@/lib/security/sanitize-error-message";
import { fetchRecentRepoVisitSidebar } from "@/lib/supabase/repo-visit-history";
import { createClient } from "@/lib/supabase/server";

const deleteHistorySchema = z.object({
  repository_id: z.string().uuid(),
});

/** Recent repo visits for the signed-in user (sidebar). */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const visits = await fetchRecentRepoVisitSidebar(supabase, user.id);
  return NextResponse.json({ visits });
}

/** Remove one repository from the signed-in user's sidebar history. */
export async function DELETE(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = deleteHistorySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const { error } = await supabase
    .from("repository_history")
    .delete()
    .eq("user_id", user.id)
    .eq("repository_id", parsed.data.repository_id);

  if (error) {
    return NextResponse.json(
      { error: sanitizeErrorMessage(error.message) },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
