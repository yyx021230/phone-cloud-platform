import H264ConverterModule, { mimeType as converterMimeType } from "h264-converter";

const DefaultConverter = H264ConverterModule?.default || H264ConverterModule;
const FRAME_DELIMITER = new Uint8Array([0, 0, 0, 1, 9, 240]);

export const SCREEN_MIME_TYPE = converterMimeType || 'video/mp4; codecs="avc1.42E01E"';
// h264-converter is an MSE compatibility shim. Its 30fps timeline is stable
// across the Android encoders currently in the device fleet; every changed
// frame is still appended immediately for interactive controls.
const STREAM_TIMELINE_FPS = 30;
const STREAM_FRAMES_PER_FRAGMENT = 1;

export class MediaSourceScreenPlayer {
  constructor({
    video,
    onFirstFrame = () => {},
    onStats = () => {},
    onError = () => {},
    Converter = DefaultConverter,
    mediaSourceApi = globalThis.MediaSource,
    firstFrameTimeoutMs = 15000,
    setTimer = globalThis.setTimeout.bind(globalThis),
    clearTimer = globalThis.clearTimeout.bind(globalThis),
    setRepeatingTimer = globalThis.setInterval.bind(globalThis),
    clearRepeatingTimer = globalThis.clearInterval.bind(globalThis),
    now = () => globalThis.performance?.now?.() || Date.now()
  }) {
    if (!video) throw new Error("缺少实时投屏 video 元素");
    if (!mediaSourceApi || typeof mediaSourceApi.isTypeSupported !== "function" || !mediaSourceApi.isTypeSupported(SCREEN_MIME_TYPE)) {
      throw new Error("当前浏览器不支持实时投屏");
    }
    this.video = video;
    this.onFirstFrame = onFirstFrame;
    this.onStats = onStats;
    this.onError = onError;
    this.Converter = Converter;
    this.firstFrameTimeoutMs = firstFrameTimeoutMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.setRepeatingTimer = setRepeatingTimer;
    this.clearRepeatingTimer = clearRepeatingTimer;
    this.now = now;
    this.converter = null;
    this.firstFrameTimer = null;
    this.monitorTimer = null;
    this.frameCallbackId = null;
    this.started = false;
    this.hasFirstFrame = false;
    this.failed = false;
    this.presentedFrames = 0;
    this.lastQuality = { decoded: 0, dropped: 0, presented: 0, at: this.now() };
    this.handleLoadedData = () => this.markFirstFrame();
    this.handleVideoError = () => this.fail(new Error(this.describeVideoError()));
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.failed = false;
    this.video.addEventListener("loadeddata", this.handleLoadedData);
    this.video.addEventListener("error", this.handleVideoError);
    this.converter = new this.Converter(this.video, STREAM_TIMELINE_FPS, STREAM_FRAMES_PER_FRAGMENT);
    this.converter.play();
    this.requestNextVideoFrame();
    this.firstFrameTimer = this.setTimer(() => {
      this.fail(new Error("已连接执行器，但 15 秒内未收到可播放画面"));
    }, this.firstFrameTimeoutMs);
    this.monitorTimer = this.setRepeatingTimer(() => this.monitorPlayback(), 250);
  }

  write(data) {
    if (!this.started || this.failed || !data?.byteLength) return;
    const chunk = new Uint8Array(data.byteLength + FRAME_DELIMITER.byteLength);
    chunk.set(data, 0);
    chunk.set(FRAME_DELIMITER, data.byteLength);
    this.converter.appendRawData(chunk);
  }

  stop() {
    if (this.firstFrameTimer) this.clearTimer(this.firstFrameTimer);
    if (this.monitorTimer) this.clearRepeatingTimer(this.monitorTimer);
    if (this.frameCallbackId != null && typeof this.video.cancelVideoFrameCallback === "function") {
      this.video.cancelVideoFrameCallback(this.frameCallbackId);
    }
    this.firstFrameTimer = null;
    this.monitorTimer = null;
    this.frameCallbackId = null;
    this.video.removeEventListener("loadeddata", this.handleLoadedData);
    this.video.removeEventListener("error", this.handleVideoError);
    try { this.converter?.appendRawData(new Uint8Array()); } catch {}
    try { this.converter?.pause(); } catch {}
    this.converter = null;
    this.video.pause?.();
    if ("playbackRate" in this.video) this.video.playbackRate = 1;
    this.video.removeAttribute?.("src");
    this.video.load?.();
    this.started = false;
    this.hasFirstFrame = false;
  }

  requestNextVideoFrame() {
    if (!this.started || typeof this.video.requestVideoFrameCallback !== "function") return;
    this.frameCallbackId = this.video.requestVideoFrameCallback(() => {
      if (!this.started) return;
      this.presentedFrames += 1;
      this.markFirstFrame();
      this.requestNextVideoFrame();
    });
  }

  markFirstFrame() {
    if (!this.started || this.hasFirstFrame || this.failed) return;
    this.hasFirstFrame = true;
    if (this.firstFrameTimer) this.clearTimer(this.firstFrameTimer);
    this.firstFrameTimer = null;
    this.video.play?.().catch?.((error) => this.fail(error));
    this.onFirstFrame({
      decoderBackend: "mse",
      videoWidth: Number(this.video.videoWidth || 0),
      videoHeight: Number(this.video.videoHeight || 0)
    });
  }

  monitorPlayback() {
    if (!this.started || this.failed) return;
    const buffered = this.video.buffered;
    let bufferSeconds = 0;
    if (buffered?.length) {
      const index = buffered.length - 1;
      const start = buffered.start(index);
      const end = buffered.end(index);
      bufferSeconds = Math.max(0, end - Number(this.video.currentTime || 0));
      if (bufferSeconds > 0.45) {
        this.video.currentTime = Math.max(start, end - 0.08);
        bufferSeconds = Math.max(0, end - this.video.currentTime);
        this.video.playbackRate = 1;
      } else if (bufferSeconds > 0.15) {
        this.video.playbackRate = 1.12;
      } else if (bufferSeconds < 0.08) {
        this.video.playbackRate = 1;
      }
    }
    const quality = this.video.getVideoPlaybackQuality?.();
    const at = this.now();
    const decoded = quality ? Number(quality.totalVideoFrames || 0) : this.presentedFrames;
    const dropped = quality ? Number(quality.droppedVideoFrames || 0) : 0;
    const presented = this.presentedFrames;
    const elapsedSeconds = Math.max(0.001, (at - this.lastQuality.at) / 1000);
    const fps = Math.max(0, (presented - this.lastQuality.presented) / elapsedSeconds);
    this.lastQuality = { decoded, dropped, presented, at };
    this.onStats({ decoded, dropped, presented, fps, bufferSeconds });
  }

  fail(error) {
    if (this.failed) return;
    this.failed = true;
    this.onError(error instanceof Error ? error : new Error(String(error || "视频解码失败")));
  }

  describeVideoError() {
    const code = Number(this.video.error?.code || 0);
    if (code === 3) return "浏览器无法解码手机视频流";
    if (code === 4) return "浏览器不支持手机视频格式";
    return "实时画面播放失败";
  }
}
