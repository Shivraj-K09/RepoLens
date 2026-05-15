import { NextResponse } from "next/server";

import { sanitizeErrorMessage } from "@/lib/security/sanitize-error-message";
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
    return NextResponse.json(
      { user: null, error: sanitizeErrorMessage(error.message) },
      { status: 401 },
    );
  }

  return NextResponse.json({ user }, { status: user ? 200 : 401 });
}
