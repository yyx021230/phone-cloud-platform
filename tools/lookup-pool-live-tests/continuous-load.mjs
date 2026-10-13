// Caller-side load generation only. This module does not select devices or
// change platform scheduling; callers retain business keys inside execute.
export async function runContinuousLoad(items, { concurrency = 6, execute, shouldStop = () => false } = {}) {
  if (!Array.isArray(items) || typeof execute !== 'function') throw new TypeError('items and execute required');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) throw new RangeError('concurrency must be 1..20');
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (!shouldStop()) {
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = { status: 'fulfilled', value: await execute(items[index], index) }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  return results;
}
