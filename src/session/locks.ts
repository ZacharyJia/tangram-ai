type AsyncFn<T> = () => Promise<T>;

// Simple per-key mutex to keep per-chat state consistent.
const chains = new Map<string, Promise<unknown>>();

export async function withKeyLock<T>(key: string, fn: AsyncFn<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);

  chains.set(key, run);
  try {
    return await run;
  } finally {
    if (chains.get(key) === run) chains.delete(key);
  }
}
