import assert from "node:assert/strict";
import test from "node:test";

import { MediaSourceScreenPlayer, SCREEN_MIME_TYPE } from "./mse-player.js";

function createVideo() {
  const listeners = new Map();
  return {
    currentTime: 0,
    videoWidth: 712,
    videoHeight: 1600,
    buffered: { length: 0 },
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name) { listeners.delete(name); },
    dispatch(name) { listeners.get(name)?.(); },
    play: async () => {},
    pause() {},
    removeAttribute() {},
    load() {},
    getVideoPlaybackQuality() { return { totalVideoFrames: 0, droppedVideoFrames: 0 }; }
  };
}

test("uses one fixed MSE H264 codec", () => {
  assert.equal(SCREEN_MIME_TYPE, 'video/mp4; codecs="avc1.42E01E"');
});

test("fails explicitly when MediaSource H264 is unsupported", () => {
  const video = createVideo();
  assert.throws(
    () => new MediaSourceScreenPlayer({
      video,
      mediaSourceApi: { isTypeSupported: () => false },
      Converter: class {}
    }),
    /当前浏览器不支持实时投屏/
  );
});

test("reports first frame only after the video produces a frame", async () => {
  const video = createVideo();
  let firstFrames = 0;
  class Converter {
    play() {}
    appendRawData() {}
    pause() {}
  }
  const player = new MediaSourceScreenPlayer({
    video,
    mediaSourceApi: { isTypeSupported: () => true },
    Converter,
    onFirstFrame: () => { firstFrames += 1; }
  });
  player.start();
  assert.equal(firstFrames, 0);
  video.dispatch("loadeddata");
  assert.equal(firstFrames, 1);
  video.dispatch("loadeddata");
  assert.equal(firstFrames, 1);
  player.stop();
});

test("allows slow phones fifteen seconds to produce the first playable frame", () => {
  const video = createVideo();
  let scheduled;
  let failure = "";
  class Converter {
    play() {}
    appendRawData() {}
    pause() {}
  }
  const player = new MediaSourceScreenPlayer({
    video,
    mediaSourceApi: { isTypeSupported: () => true },
    Converter,
    setTimer(handler, delay) { scheduled = { handler, delay }; return 1; },
    clearTimer() {},
    onError(error) { failure = error.message; }
  });
  player.start();
  assert.equal(scheduled.delay, 15000);
  scheduled.handler();
  assert.match(failure, /未收到可播放画面/);
  player.stop();
});

test("packages every changed H264 frame immediately on the stable timeline", () => {
  const video = createVideo();
  let converterArgs;
  class Converter {
    constructor(...args) { converterArgs = args; }
    play() {}
    appendRawData() {}
    pause() {}
  }
  const player = new MediaSourceScreenPlayer({
    video,
    mediaSourceApi: { isTypeSupported: () => true },
    Converter,
    setTimer: () => 1,
    clearTimer() {}
  });
  player.start();
  assert.deepEqual(converterArgs, [video, 30, 1]);
  player.stop();
});

test("measures presented FPS without getVideoPlaybackQuality", () => {
  const video = createVideo();
  delete video.getVideoPlaybackQuality;
  let frameCallback;
  let monitor;
  let now = 0;
  let stats;
  video.requestVideoFrameCallback = (callback) => { frameCallback = callback; return 7; };
  video.cancelVideoFrameCallback = () => {};
  class Converter {
    play() {}
    appendRawData() {}
    pause() {}
  }
  const player = new MediaSourceScreenPlayer({
    video,
    mediaSourceApi: { isTypeSupported: () => true },
    Converter,
    now: () => now,
    setTimer: () => 1,
    clearTimer() {},
    setRepeatingTimer(handler) { monitor = handler; return 2; },
    clearRepeatingTimer() {},
    onStats(value) { stats = value; }
  });
  player.start();
  frameCallback();
  frameCallback();
  now = 1000;
  monitor();
  assert.equal(stats.decoded, 2);
  assert.equal(stats.fps, 2);
  player.stop();
});

test("keeps playback close to an eighty millisecond live edge", () => {
  const video = createVideo();
  video.playbackRate = 1;
  video.buffered = { length: 1, start: () => 0, end: () => 0.22 };
  let monitor;
  class Converter {
    play() {}
    appendRawData() {}
    pause() {}
  }
  const player = new MediaSourceScreenPlayer({
    video,
    mediaSourceApi: { isTypeSupported: () => true },
    Converter,
    setTimer: () => 1,
    clearTimer() {},
    setRepeatingTimer(handler) { monitor = handler; return 2; },
    clearRepeatingTimer() {}
  });
  player.start();
  monitor();
  assert.equal(video.currentTime, 0);
  assert.equal(video.playbackRate, 1.12);
  video.buffered = { length: 1, start: () => 0, end: () => 0.6 };
  monitor();
  assert.equal(video.currentTime, 0.52);
  player.stop();
});
