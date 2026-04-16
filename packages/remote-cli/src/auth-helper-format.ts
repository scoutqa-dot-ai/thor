const DEFAULT_TAG = "[thor-github-app]";

export function formatAuthHelperError(err: unknown, tag = DEFAULT_TAG): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.startsWith(`${tag} `) ? message : `${tag} ${message}`;
}
