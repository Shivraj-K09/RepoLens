import { NextResponse } from "next/server";

import { fetchRecentRepoVisitSidebar } from "@/lib/supabase/repo-visit-history";
import { createClient } from "@/lib/supabase/server";

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
