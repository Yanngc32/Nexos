const locks = new Map<string, Promise<void>>();

export async function withThreadLock<T>(threadId: string, fn: () => Promise<T>, waitMs = 10_000): Promise<T> {
  const start = Date.now();
  while (locks.has(threadId)) {
    if (Date.now() - start > waitMs) {
      const err = new Error("thread locked");
      (err as Error & { status: number }).status = 409;
      throw err;
    }
    await locks.get(threadId);
  }
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(threadId, gate);
  try {
    return await fn();
  } finally {
    locks.delete(threadId);
    release();
  }
}
