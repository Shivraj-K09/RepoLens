/**
 * en-US date/time in **UTC** so server and browser render identical strings
 * (avoids hydration mismatch from different default locales / time zones).
 */
export function formatTimestampUtcEnUS(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}
