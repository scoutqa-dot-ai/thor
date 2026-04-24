export function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return "/" + parts.join("/");
}

export function isPathUnderCwd(path: string, cwd: string | undefined): boolean {
  if (!cwd || path.length === 0 || path === "-") return false;
  const resolved = path.startsWith("/") ? path : `${cwd.replace(/\/+$/, "")}/${path}`;
  const normalized = normalizePath(resolved);
  const normalizedCwd = normalizePath(cwd);
  return normalized === normalizedCwd || normalized.startsWith(normalizedCwd + "/");
}
