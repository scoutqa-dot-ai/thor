export function withKeyLock<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, settled);
  void settled.finally(() => {
    if (locks.get(key) === settled) locks.delete(key);
  });
  return next;
}
