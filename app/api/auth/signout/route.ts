import { NextResponse } from "next/server";

import { getSiteUrl } from "@/lib/auth/site-url";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  const siteUrl = getSiteUrl(request);
  return NextResponse.redirect(new URL("/", siteUrl), 303);
}
