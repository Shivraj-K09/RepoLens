/**
 * Compact star counts: `924`, `1.2K`, `15.4K` (thousands use one truncated decimal).
 * Millions+ use en-US compact notation.
 */
export function formatStarsCompact(count: number | null | undefined): string {
  if (count == null || count < 0) return "";

  if (count < 1000) {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(
      count,
    );
  }

  if (count < 1_000_000) {
    const k = count / 1000;
    const t = Math.floor(k * 10) / 10;
    return t % 1 === 0 ? `${t}K` : `${t.toFixed(1)}K`;
  }

  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    compactDisplay: "short",
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).format(count);
}
