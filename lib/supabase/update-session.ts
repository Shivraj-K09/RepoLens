import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

let loggedMissingSupabaseEnv = false;

/**
 * Refreshes the Supabase auth session and syncs cookies on the response.
 * Called from root `proxy.ts` (Next.js 16+ replaces `middleware`).
 */
export async function updateSession(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl?.trim() || !supabaseAnonKey?.trim()) {
    if (!loggedMissingSupabaseEnv) {
      loggedMissingSupabaseEnv = true;
      console.error(
        "[updateSession] Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
          "Configure them in your environment (e.g. Vercel project settings). Skipping session refresh.",
      );
    }
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    supabaseUrl,
    supabaseAnonKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value);
          });

          supabaseResponse = NextResponse.next({
            request,
          });

          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );

          Object.entries(headers).forEach(([key, value]) =>
            supabaseResponse.headers.set(key, value)
          );
        },
      },
    }
  );

  await supabase.auth.getUser();

  return supabaseResponse;
}
