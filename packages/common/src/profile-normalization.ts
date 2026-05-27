export function normalizeProfileEnvSuffix(profile: string): string {
  const normalized = profile.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  let start = 0;
  let end = normalized.length;
  while (start < end && normalized[start] === "_") start += 1;
  while (end > start && normalized[end - 1] === "_") end -= 1;
  return normalized.slice(start, end);
}
