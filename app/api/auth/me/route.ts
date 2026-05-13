import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";

/**
 * Returns the authenticated Supabase user (JSON). Use to verify Phase 1 session wiring — no UI.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error) {
    return NextResponse.json({ user: null, error: error.message }, { status: 401 });
  }

  return NextResponse.json({ user }, { status: user ? 200 : 401 });
}
