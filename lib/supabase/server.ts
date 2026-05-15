import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { assertPublicAnonKey } from "@/lib/supabase/key-safety";

export async function createClient() {
  const cookieStore = await cookies();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  assertPublicAnonKey(anonKey, "server");

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    anonKey,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet, headers) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Server Components cannot always set cookies; `proxy.ts` refreshes the session.
          }
          void headers;
        },
      },
    }
  );
}
