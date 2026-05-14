import { NextResponse } from "next/server";

import { getSiteUrl } from "@/lib/auth/site-url";
import { createClient } from "@/lib/supabase/server";

/** Full-page navigation target: clears cookies and redirects home in one round trip. */
export async function GET(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();

  const siteUrl = getSiteUrl(request);
  return NextResponse.redirect(new URL("/", siteUrl));
}

/** Clears Supabase cookies — JSON response for programmatic callers. */
export async function POST() {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
