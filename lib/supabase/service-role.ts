import "server-only";

/**
 * Explicit accessor for privileged service-role workflows.
 * Use this only in special server-only jobs after user context was checked.
 */
export function getServiceRoleKeyForPrivilegedOperation(params: {
  checkedUserId: string;
  reason: string;
}): string {
  const checkedUserId = params.checkedUserId.trim();
  const reason = params.reason.trim();
  if (!checkedUserId) {
    throw new Error(
      "Service-role access denied: checkedUserId is required for privileged operations.",
    );
  }
  if (!reason) {
    throw new Error(
      "Service-role access denied: reason is required for privileged operations.",
    );
  }

  const key = process.env.SUPABASE_SERVICE_ROLE?.trim();
  if (!key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE is not configured for privileged server operations.",
    );
  }

  return key;
}

