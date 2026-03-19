/**
 * Parse a repo-to-channels mapping string into a channel→repo Map.
 * Format: "repo:channel1,channel2;repo2:channel3"
 * E.g. "thor:C123,C456;palembang:C789" → Map { "C123" → "thor", "C456" → "thor", "C789" → "palembang" }
 */
export function parseChannelRepoMap(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;
  for (const group of raw.split(";")) {
    const trimmed = group.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx <= 0) continue;
    const repo = trimmed.slice(0, colonIdx).trim();
    const channels = trimmed.slice(colonIdx + 1);
    for (const ch of channels.split(",")) {
      const channel = ch.trim();
      if (channel) map.set(channel, repo);
    }
  }
  return map;
}

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
