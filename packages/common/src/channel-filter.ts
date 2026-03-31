/**
 * Parse a comma-separated channel ID string into a Set.
 */
export function parseAllowedChannelIds(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}
