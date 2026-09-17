export function createVideoBackpressureGate({ highWaterMark = 2 * 1024 * 1024, lowWaterMark = 512 * 1024 } = {}) {
  let dropping = false;
  return {
    inspect(packet, bufferedAmount = 0) {
      const data = Buffer.from(packet || []);
      const configuration = data[0] === 0;
      const keyframe = data[0] === 1 && data[1] === 1;
      const buffered = Math.max(0, Number(bufferedAmount || 0));
      if (buffered > highWaterMark) dropping = true;
      if (configuration) return { forward: true, dropped: false, recovered: false };
      if (!dropping) return { forward: true, dropped: false, recovered: false };
      if (keyframe && buffered <= lowWaterMark) {
        dropping = false;
        return { forward: true, dropped: false, recovered: true };
      }
      return { forward: false, dropped: true, recovered: false };
    }
  };
}
