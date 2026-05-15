import { NextResponse } from "next/server";

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

type RateLimitStore = Map<string, RateLimitBucket>;

declare global {
  var __repolensRateLimitStore: RateLimitStore | undefined;
}

const store: RateLimitStore = globalThis.__repolensRateLimitStore ?? new Map();
if (!globalThis.__repolensRateLimitStore) {
  globalThis.__repolensRateLimitStore = store;
}

let operationCount = 0;

function cleanupExpiredBuckets(now: number): void {
  operationCount += 1;
  if (operationCount % 200 !== 0) return;
  for (const [key, bucket] of store.entries()) {
    if (bucket.resetAt <= now) {
      store.delete(key);
    }
  }
}

function clientAddressFromRequest(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp?.trim()) return realIp.trim();

  const cfIp = request.headers.get("cf-connecting-ip");
  if (cfIp?.trim()) return cfIp.trim();

  return "unknown";
}

export type RateLimitCheckParams = {
  request: Request;
  namespace: string;
  max: number;
  windowMs: number;
  userId?: string;
};

export type RateLimitCheckResult = {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
  limit: number;
  resetAt: number;
};

export function checkRateLimit(params: RateLimitCheckParams): RateLimitCheckResult {
  const now = Date.now();
  cleanupExpiredBuckets(now);

  const actor = params.userId?.trim() || clientAddressFromRequest(params.request);
  const key = `${params.namespace}:${actor}`;
  const existing = store.get(key);
  const resetAt = existing && existing.resetAt > now ? existing.resetAt : now + params.windowMs;
  const bucket: RateLimitBucket =
    existing && existing.resetAt > now
      ? existing
      : { count: 0, resetAt };

  if (bucket.count >= params.max) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((bucket.resetAt - now) / 1000),
    );
    return {
      allowed: false,
      retryAfterSeconds,
      remaining: 0,
      limit: params.max,
      resetAt: bucket.resetAt,
    };
  }

  bucket.count += 1;
  store.set(key, bucket);

  return {
    allowed: true,
    retryAfterSeconds: 0,
    remaining: Math.max(0, params.max - bucket.count),
    limit: params.max,
    resetAt: bucket.resetAt,
  };
}

export function rateLimitExceededResponse(
  result: RateLimitCheckResult,
  message = "Too many requests. Please retry shortly.",
) {
  return NextResponse.json(
    { error: message },
    {
      status: 429,
      headers: {
        "Retry-After": String(result.retryAfterSeconds),
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": String(result.remaining),
        "X-RateLimit-Reset": String(result.resetAt),
      },
    },
  );
}

