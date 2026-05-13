export type LandingAuthSnapshot = {
  avatarUrl: string | null;
  displayName: string;
  githubUsername: string | null;
};

/** Minimal subset of Supabase `User`, kept local so we avoid a `@supabase/supabase-js` import. */
type AuthUserLite = {
  email?: string | null;
  user_metadata?: Record<string, unknown>;
};

export function landingAuthFromUser(user: AuthUserLite): LandingAuthSnapshot {
  const meta = user.user_metadata ?? {};
  const pick = (keys: readonly string[]): string | undefined => {
    for (const k of keys) {
      const v = meta[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return undefined;
  };

  const username = pick(["user_name", "preferred_username"]);
  const fullName = pick(["full_name", "name"]);

  const displayName =
    fullName ?? username ?? user.email?.split("@")[0] ?? "Signed in";

  return {
    avatarUrl: typeof meta.avatar_url === "string" ? meta.avatar_url : null,
    displayName,
    githubUsername: username ?? null,
  };
}
