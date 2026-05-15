function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded =
    normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

/**
 * Defense-in-depth guard: this client must never run with a service-role key.
 */
export function assertPublicAnonKey(
  key: string,
  source: "browser" | "server" | "proxy",
): void {
  const trimmed = key.trim();
  const parts = trimmed.split(".");
  if (parts.length !== 3) return;

  try {
    const payloadRaw = decodeBase64Url(parts[1] ?? "");
    const payload = JSON.parse(payloadRaw) as { role?: string };
    if (payload.role === "service_role") {
      throw new Error(
        `[supabase:${source}] Refusing to initialize client with service-role key. Use NEXT_PUBLIC_SUPABASE_ANON_KEY for normal app clients.`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("service-role")) {
      throw error;
    }
    // If token isn't a JWT-shaped value, do not block startup.
  }
}

