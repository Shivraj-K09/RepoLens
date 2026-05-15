import { NextResponse } from "next/server";
import { z } from "zod";

import { safeNextPath } from "@/lib/auth/safe-next-path";
import { getSiteUrl } from "@/lib/auth/site-url";
import {
  checkRateLimit,
  rateLimitExceededResponse,
} from "@/lib/security/rate-limit";
import { sanitizeErrorMessage } from "@/lib/security/sanitize-error-message";
import { createClient } from "@/lib/supabase/server";

const querySchema = z.object({
  next: z.string().max(2048).optional(),
});

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

  const queryParsed = querySchema.safeParse({
    next: requestUrl.searchParams.get("next") ?? undefined,
  });
  if (!queryParsed.success) {
    return NextResponse.json(
      { error: queryParsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const nextPath = safeNextPath(queryParsed.data.next ?? null);

  const authRateLimit = checkRateLimit({
    request,
    namespace: "auth:github:start",
    max: 20,
    windowMs: 5 * 60 * 1000,
  });
  if (!authRateLimit.allowed) {
    return rateLimitExceededResponse(
      authRateLimit,
      "Too many GitHub sign-in attempts. Please wait and retry.",
    );
  }

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
      {
        error: sanitizeErrorMessage(
          error?.message ?? "Failed to start OAuth",
        ),
      },
      { status: 500 },
    );
  }

  return NextResponse.redirect(data.url);
}
