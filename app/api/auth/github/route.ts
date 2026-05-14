import { NextResponse } from "next/server";

import { safeNextPath } from "@/lib/auth/safe-next-path";
import { getSiteUrl } from "@/lib/auth/site-url";
import { createClient } from "@/lib/supabase/server";

/**
 * Starts GitHub OAuth via Supabase Auth. No UI — open this URL in a browser while logged out.
 */
export async function GET(request: Request) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!supabaseUrl || !supabaseAnonKey) {
    return NextResponse.json(
      { error: "Authentication is not configured." },
      { status: 503 },
    );
  }

  const siteUrl = getSiteUrl(request);
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const nextPath = safeNextPath(requestUrl.searchParams.get("next"));

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    return NextResponse.redirect(new URL(nextPath, siteUrl));
  }

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
      { status: 500 },
    );
  }

  return NextResponse.redirect(data.url);
}
