/** Bound the caller's wait even when an injected adapter ignores cancellation. */
export async function abortable<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let cancel: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([aborted, Promise.resolve().then(() => {
      signal.throwIfAborted();
      return work();
    })]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
