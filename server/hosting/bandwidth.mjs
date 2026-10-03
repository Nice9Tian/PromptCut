/** One aggregate budget per authenticated user/device, shared by every channel and direction. */
export function createBandwidth({ bytesPerSecond = 1024 * 1024, totalBytesPerSecond = 16 * 1024 * 1024, now = Date.now } = {}) {
  if (!(bytesPerSecond > 0) || !(totalBytesPerSecond > 0)) throw new Error('invalid relay bandwidth');
  const users = new Map(); let totalNext = 0;
  return {
    reserve(user, bytes) {
      const at = now();
      const userEnd = Math.max(at, users.get(user) ?? 0) + bytes * 1000 / bytesPerSecond;
      const totalEnd = Math.max(at, totalNext) + bytes * 1000 / totalBytesPerSecond;
      const end = Math.max(userEnd, totalEnd);
      users.set(user, end); totalNext = totalEnd;
      return Math.max(0, end - at);
    },
    prune() { const at = now(); for (const [user, end] of users) if (end <= at) users.delete(user); },
  };
}
