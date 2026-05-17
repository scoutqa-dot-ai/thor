/**
 * Compact token formatter: under 1k stays as-is, otherwise truncate (don't
 * round) to one decimal place with a K/M suffix.
 *   5_983     → "5.9K"
 *   583_930   → "583.9K"
 *   4_962_304 → "4.9M"
 */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(Math.floor(n / 100) / 10).toFixed(1)}K`;
  return `${(Math.floor(n / 100_000) / 10).toFixed(1)}M`;
}

export function formatDuration(ms: number): string;
export function formatDuration(ms: unknown): string | undefined;
export function formatDuration(ms: unknown): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return undefined;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return `${totalHours}h ${minutes}m`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `${days}d ${hours}h`;
}

export function formatAge(ts: string | undefined): string | undefined {
  if (!ts) return undefined;
  const ms = Date.now() - Date.parse(ts);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return formatDuration(ms);
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatCostUsd(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}
