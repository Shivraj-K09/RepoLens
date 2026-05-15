const REDACTION = "[REDACTED]";

/**
 * Best-effort redaction for error strings returned to clients.
 * Prevents accidental leakage of bearer tokens/API keys in JSON error responses.
 */
export function sanitizeErrorMessage(input: string): string {
  let out = input;

  // Authorization: Bearer <token>
  out = out.replace(
    /(authorization\s*[:=]\s*bearer\s+)[^\s"'`]+/gi,
    `$1${REDACTION}`,
  );

  // Bearer <token>
  out = out.replace(/(bearer\s+)[^\s"'`]+/gi, `$1${REDACTION}`);

  // key-like assignments (apiKey=..., token: ...)
  out = out.replace(
    /((?:api[-_ ]?key|token|secret|password)\s*[:=]\s*)[^\s,;'"`]+/gi,
    `$1${REDACTION}`,
  );

  // URLs with credentials: https://user:pass@host
  out = out.replace(
    /(https?:\/\/)([^:\s/@]+):([^@\s/]+)@/gi,
    `$1${REDACTION}:${REDACTION}@`,
  );

  return out;
}

