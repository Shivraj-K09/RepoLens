import { NextResponse } from "next/server";

import { getSiteUrl } from "@/lib/auth/site-url";
import { createClient } from "@/lib/supabase/server";

/**
 * Starts GitHub OAuth via Supabase Auth. No UI — open this URL in a browser while logged out.
 */
export async function GET(request: Request) {
  const siteUrl = getSiteUrl(request);
  const supabase = await createClient();

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "github",
    options: {
      redirectTo: `${siteUrl}/auth/callback`,
      scopes: "read:user user:email",
    },
  });

  if (error || !data.url) {
    return NextResponse.json(
      { error: error?.message ?? "Failed to start OAuth" },
      { status: 500 }
    );
  }

  return NextResponse.redirect(data.url);
}
