export function getSiteUrl(request: Request): string {
  const fromEnv =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ??
    process.env.SITE_URL?.replace(/\/$/, "");

  if (fromEnv) {
    return fromEnv;
  }

  const forwardedOrigin = forwardedRequestOrigin(request);
  if (forwardedOrigin) {
    return forwardedOrigin;
  }

  return new URL(request.url).origin;
}

function forwardedRequestOrigin(request: Request): string | null {
  const host = request.headers.get("x-forwarded-host");
  if (!host) return null;

  const rawProto = request.headers.get("x-forwarded-proto") ?? "https";
  const proto =
    rawProto.split(",")[0]?.trim()?.toLowerCase() === "http" ? "http" : "https";
  const hostname = host.split(",")[0]?.trim();
  if (!hostname) return null;

  const origin = `${proto}://${hostname}`.replace(/\/$/, "");
  return origin;
}
