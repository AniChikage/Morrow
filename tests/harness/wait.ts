export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Polls `predicate` (sync or async) until it returns a truthy value and returns that value.
 * Throws after `timeoutMs` with the predicate's source, so a timed-out wait names what it waited for.
 */
export async function until<T>(
  predicate: () => T | Promise<T>,
  timeoutMs = 5000,
  intervalMs = 20
): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value as NonNullable<T>;
    if (Date.now() >= end)
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for: ${predicate.toString().replace(/\s+/g, ' ').slice(0, 200)}`
      );
    await pause(intervalMs);
  }
}
