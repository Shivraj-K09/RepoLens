"use client";

import { createBrowserClient } from "@supabase/ssr";
import { assertPublicAnonKey } from "@/lib/supabase/key-safety";

export function createClient() {
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  assertPublicAnonKey(anonKey, "browser");

  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    anonKey,
  );
}
