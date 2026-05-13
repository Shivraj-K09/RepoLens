import { NextResponse } from "next/server";

/** Non-HTML auth error surface (no UI). */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const reason = url.searchParams.get("reason") ?? "authentication_failed";

  return new NextResponse(`Auth error: ${reason}`, {
    status: 400,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
