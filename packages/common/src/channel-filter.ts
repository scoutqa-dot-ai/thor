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

/**
 * Create a channel filter that blocks DMs and enforces an allowlist.
 *
 * - DM channels (starting with "D") are always blocked.
 * - If the allowlist is empty, all non-DM channels are allowed.
 * - Otherwise only channels in the allowlist are allowed.
 */
export function createChannelFilter(allowedChannelIds: Set<string>) {
  return function isChannelAllowed(channel: string): boolean {
    if (channel.startsWith("D")) return false;
    if (allowedChannelIds.size === 0) return true;
    return allowedChannelIds.has(channel);
  };
}
