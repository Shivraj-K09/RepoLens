import { NextResponse } from "next/server";

import { safeNextPath } from "@/lib/auth/safe-next-path";
import { createClient } from "@/lib/supabase/server";

/**
 * Supabase OAuth callback: exchanges `code` for a session cookie.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");
  const nextPath = safeNextPath(url.searchParams.get("next"));

  if (oauthError) {
    const reason =
      url.searchParams.get("error_description") ?? oauthError;
    return NextResponse.redirect(
      new URL(
        `/auth/auth-code-error?reason=${encodeURIComponent(reason)}`,
        url.origin
      )
    );
  }

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(new URL(nextPath, url.origin));
    }
  }

  return NextResponse.redirect(new URL("/auth/auth-code-error", url.origin));
}
