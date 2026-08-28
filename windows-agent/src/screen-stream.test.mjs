import assert from "node:assert/strict";
import test from "node:test";
import {
  buildScreenRelayUrl,
  buildScreenStreamMetrics,
  applyScreenDeviceProfile,
  resolveScreenTransportPacingBitRate,
  resolveScreenTransportPacketsPerBurst,
  createScreenStreamManager,
  createScreenScrcpyOptions,
  createScreenVideoCodecOptions,
  devicePowerState,
  dismissVendorScreenGuard,
  encodeRelayVideoPacket,
  ensureDeviceAwake,
  injectScreenClear,
  inspectScrcpyInputCapability,
  injectScreenKey,
  injectScreenText,
  isScrcpyDiagnosticLine,
  mapScreenControlCoordinates,
  parseScrcpyFallbackMaxSize,
  screenKeyCode,
  screenControlIsolationEnabled,
  screenSourceRecoveryEnabled,
  screenViewerKeyframeResetEnabled,
  screenSourceRecoveryDelayMs,
  selectScrcpyStartupOutcome,
  waitForSerialReservation
} from "./screen-stream.mjs";

test("caps only the configured device's screen profile", () => {
  const config = {
    screenDeviceProfiles: {
      "vivo-125": { maxFps: 40, videoBitRate: 1_500_000 }
    }
  };
  assert.deepEqual(
    applyScreenDeviceProfile({
      config,
      serial: "vivo-125",
      requestedOptions: { maxFps: 60, videoBitRate: 2_000_000, maxSize: 960 }
    }),
    { maxFps: 40, videoBitRate: 1_500_000, maxSize: 960 }
  );
  assert.deepEqual(
    applyScreenDeviceProfile({ config, serial: "other-phone", requestedOptions: { videoBitRate: 2_000_000 } }),
    { videoBitRate: 2_000_000 }
  );
});

test("uses a device-only burst pacing ceiling without changing encoder bitrate", () => {
  const config = {
    screenTransportPacingBitRate: 4_000_000,
    screenDeviceProfiles: {
      "vivo-125": { transportPacingBitRate: 8_000_000 }
    }
  };
  assert.equal(
    resolveScreenTransportPacingBitRate({ config, serial: "vivo-125", requestedOptions: { videoBitRate: 1_000_000 } }),
    8_000_000
  );
  assert.equal(
    resolveScreenTransportPacingBitRate({ config, serial: "other-phone", requestedOptions: { videoBitRate: 1_000_000 } }),
    4_000_000
  );
});

test("uses global two-packet RTP groups while allowing a bounded device override", () => {
  const config = {
    screenTransportPacketsPerBurst: 2,
    screenDeviceProfiles: {
      "phone-53": { transportPacketsPerBurst: 2 },
      "phone-35": { transportPacketsPerBurst: 8 }
    }
  };
  assert.equal(resolveScreenTransportPacketsPerBurst({ config, serial: "phone-53" }), 2);
  assert.equal(resolveScreenTransportPacketsPerBurst({ config, serial: "phone-35" }), 8);
  assert.equal(resolveScreenTransportPacketsPerBurst({ config, serial: "other-phone" }), 2);
});

test("keeps each Android encoder profile-compatible while forcing CBR and frequent keyframes", () => {
  assert.equal(createScreenVideoCodecOptions({ screenIFrameIntervalSeconds: 1 }).videoCodecOptions.toOptionValue(), "i-frame-interval=1,bitrate-mode=2");
  assert.equal(createScreenVideoCodecOptions({ screenIFrameIntervalSeconds: 30, screenEncoderBitrateMode: 1 }).videoCodecOptions.toOptionValue(), "i-frame-interval=10,bitrate-mode=1");
});

test("enables the scrcpy clipboard acknowledgement channel for explicit text input", () => {
  const options = createScreenScrcpyOptions({
    requestedOptions: {},
    maxSize: 1600,
    config: {
      screenMaxFps: 30,
      screenVideoBitRate: 5_000_000
    }
  });

  assert.equal(options.value.clipboardAutosync, true);
});

test("assigns each screen session an isolated scrcpy reverse socket", () => {
  const options = createScreenScrcpyOptions({
    requestedOptions: {},
    maxSize: 1600,
    sessionId: "4c7b8fd3-e42a-480b-87df-e19e7bba0781",
    config: {
      screenMaxFps: 30,
      screenVideoBitRate: 5_000_000
    }
  });

  assert.equal(options.value.scid, "4c7b8fd");
  assert.match(options.serialize().join(" "), /scid=4c7b8fd/);
});

test("assigns the control-only scrcpy process a different socket id", () => {
  const options = createScreenScrcpyOptions({
    requestedOptions: {},
    maxSize: 960,
    sessionId: "4c7b8fd3-e42a-480b-87df-e19e7bba0781",
    channel: "control",
    video: false,
    control: true,
    config: { screenMaxFps: 40, screenVideoBitRate: 1_000_000 }
  });
  assert.equal(options.value.scid, "c4c7b8f");
  assert.equal(options.value.video, false);
  assert.equal(options.value.control, true);
});

test("allows lifecycle isolation to be enabled for a canary device only", () => {
  const config = {
    screenIsolateControlEnabled: false,
    screenSourceRecoveryEnabled: false,
    screenDeviceProfiles: {
      "phone-124": { isolateControl: true, sourceRecovery: true, viewerKeyframeReset: true }
    }
  };
  assert.equal(screenControlIsolationEnabled(config, "phone-124"), true);
  assert.equal(screenSourceRecoveryEnabled(config, "phone-124"), true);
  assert.equal(screenViewerKeyframeResetEnabled(config, "phone-124"), true);
  assert.equal(screenControlIsolationEnabled(config, "phone-128"), false);
  assert.equal(screenSourceRecoveryEnabled(config, "phone-128"), false);
  assert.equal(screenViewerKeyframeResetEnabled(config, "phone-128"), false);
});

test("detects the compatible max size selected by the scrcpy encoder", () => {
  assert.equal(
    parseScrcpyFallbackMaxSize("[server] INFO: Retrying with -m1280..."),
    1280
  );
  assert.equal(parseScrcpyFallbackMaxSize("[server] INFO: Device: Redmi"), 0);
  assert.equal(parseScrcpyFallbackMaxSize("Retrying with -m0..."), 0);
});

test("keeps only actionable scrcpy server diagnostics", () => {
  assert.equal(isScrcpyDiagnosticLine("[server] INFO: Device: Redmi"), false);
  assert.equal(isScrcpyDiagnosticLine("[server] WARN: Ignore positional event generated for size 736x1600"), true);
  assert.equal(isScrcpyDiagnosticLine("java.lang.SecurityException: Injecting to another application"), true);
});

test("blocks scrcpy control when the vendor security input switch is explicitly disabled", async () => {
  const result = await inspectScrcpyInputCapability({
    adbPath: "adb",
    serial: "xiaomi-1",
    run: async () => ({ stdout: "0\r\n" })
  });

  assert.deepEqual(result, {
    ready: false,
    securityInputSetting: "0"
  });
});

test("allows scrcpy control when the vendor security input switch is enabled or unsupported", async () => {
  for (const stdout of ["1\r\n", "\r\n"]) {
    const result = await inspectScrcpyInputCapability({
      adbPath: "adb",
      serial: "phone-1",
      run: async () => ({ stdout })
    });

    assert.equal(result.ready, true);
    assert.equal(result.securityInputSetting, stdout.trim());
  }
});

test("maps browser coordinates to the encoder's actual video size", () => {
  assert.deepEqual(
    mapScreenControlCoordinates(
      { x: 368, y: 800, videoWidth: 736, videoHeight: 1600 },
      { width: 592, height: 1280 }
    ),
    { x: 296, y: 640, videoWidth: 592, videoHeight: 1280 }
  );
});

test("keeps control coordinates unchanged when video sizes match", () => {
  assert.deepEqual(
    mapScreenControlCoordinates(
      { x: 296, y: 640, videoWidth: 592, videoHeight: 1280 },
      { width: 592, height: 1280 }
    ),
    { x: 296, y: 640, videoWidth: 592, videoHeight: 1280 }
  );
});

test("clamps control coordinates to the last valid encoder pixel", () => {
  assert.deepEqual(
    mapScreenControlCoordinates(
      { x: 720, y: 1600, videoWidth: 720, videoHeight: 1600 },
      { width: 720, height: 1600 }
    ),
    { x: 719, y: 1599, videoWidth: 720, videoHeight: 1600 }
  );
});

test("selects the scrcpy fallback before exposing a stale first frame", async () => {
  const outcome = await selectScrcpyStartupOutcome({
    firstPacketPromise: new Promise(() => {}),
    fallbackPromise: Promise.resolve(1280)
  });

  assert.deepEqual(outcome, { type: "fallback", maxSize: 1280 });
});

test("keeps the first frame when the encoder does not change size", async () => {
  const packet = { done: false, value: Buffer.from([1, 2, 3]) };
  const outcome = await selectScrcpyStartupOutcome({
    firstPacketPromise: Promise.resolve(packet),
    fallbackPromise: new Promise(() => {})
  });

  assert.deepEqual(outcome, { type: "packet", packet });
});

test("builds an encoded websocket relay URL", () => {
  assert.equal(
    buildScreenRelayUrl("https://phone.example.com/", "agent A"),
    "wss://phone.example.com/api/v1/windows-agents/agent%20A/screen-relay"
  );
});

test("prefixes video with channel and session id", () => {
  const payload = encodeRelayVideoPacket("session-1", Buffer.from([7, 8, 9]));
  assert.equal(payload[0], 1);
  assert.equal(payload[1], 9);
  assert.equal(payload.subarray(2, 11).toString(), "session-1");
  assert.deepEqual(payload.subarray(11), Buffer.from([7, 8, 9]));
});

test("builds a bounded five-second Agent stream measurement without frame payloads", () => {
  assert.deepEqual(
    buildScreenStreamMetrics({
      session: { videoWidth: 720, videoHeight: 1600 },
      stats: { frames: 145, capturedFrames: 150, firstCapturePtsMs: 1_000, lastCapturePtsMs: 6_000, bytes: 2_500_000, droppedFrames: 8 },
      elapsedMs: 5_000,
      relayBufferedBytes: 12_345
    }),
    {
      fps: 29,
      capturedFps: 30,
      megabitsPerSecond: 4,
      droppedFrames: 8,
      relayBufferedBytes: 12_345,
      width: 720,
      height: 1600
    }
  );
});

test("reports control-to-next-frame timing without mixing wall time and source PTS clocks", () => {
  const messages = [];
  const manager = createScreenStreamManager({
    config: {},
    agentDir: "/tmp/phone-cloud-test"
  });
  manager.socket = { readyState: 1, send(value) { messages.push(JSON.parse(value)); } };
  const session = {
    sessionId: "session-frame-clock",
    serial: "phone-1",
    captureTimeline: { firstPtsMs: 100, lastPtsMs: 100, lastObservedAtMs: 1_000 },
    visualLatencyProbe: { sequenceId: 9, action: "up", injectedAtMs: 1_000, sourcePtsMsAtInput: 100 }
  };
  manager.recordSourceFrameTiming(session, { type: "data", pts: 130_000n }, 1_025);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].diagnostic, {
    sequenceId: 9,
    action: "up",
    event: "next_h264_packet_after_input",
    inputToAgentFrameMs: 25,
    sourcePtsMs: 130,
    sourcePtsAdvanceMs: 30
  });
  assert.equal("inputToCapturedFrameMs" in messages[0].diagnostic, false);
});

test("maps wakeup to Android KEYCODE_WAKEUP without toggling screen power", () => {
  assert.equal(screenKeyCode("wakeup"), 224);
  assert.equal(screenKeyCode("volume_up"), 24);
});

test("maps enter and deletion keys to Android key codes", () => {
  assert.equal(screenKeyCode("enter"), 66);
  assert.equal(screenKeyCode("delete"), 67);
  assert.equal(screenKeyCode("forward_delete"), 112);
});

test("clears the focused phone input with Ctrl+A followed by delete", async () => {
  const calls = [];
  const controller = {
    async injectKeyCode(event) { calls.push([event.action, event.keyCode, event.metaState]); }
  };

  await injectScreenClear(controller);

  assert.deepEqual(calls, [
    [0, 29, 0x1000],
    [1, 29, 0x1000],
    [0, 67, 0],
    [1, 67, 0]
  ]);
});

test("selects the focused phone input with the direct Ctrl+A control", async () => {
  const calls = [];
  const controller = {
    async injectKeyCode(event) { calls.push([event.action, event.keyCode, event.metaState]); }
  };

  await injectScreenKey(controller, "select_all");

  assert.deepEqual(calls, [
    [0, 29, 0x1000],
    [1, 29, 0x1000]
  ]);
});

test("wakeup explicitly turns the display on before injecting the wake key", async () => {
  const calls = [];
  const controller = {
    async setScreenPowerMode(mode) { calls.push(["power", mode]); },
    async injectKeyCode(event) { calls.push(["key", event.action, event.keyCode]); }
  };

  await injectScreenKey(controller, "wakeup");

  assert.deepEqual(calls, [
    ["power", 2],
    ["key", 0, 224],
    ["key", 1, 224]
  ]);
});

test("pastes text through the native scrcpy clipboard control", async () => {
  const values = [];
  const controller = {
    async setClipboard(value) { values.push(value); },
    async injectText() { throw new Error("clipboard paste should be preferred for screen text input"); }
  };

  assert.equal(await injectScreenText(controller, "你好 Phone Cloud 123"), true);

  assert.deepEqual(values, [{ sequence: 0n, paste: true, content: "你好 Phone Cloud 123" }]);
});

test("falls back to injectText when the connected scrcpy server rejects clipboard paste", async () => {
  const values = [];
  const controller = {
    async setClipboard() { throw new Error("clipboard_paste_unsupported"); },
    async injectText(value) { values.push(value); }
  };

  assert.equal(await injectScreenText(controller, "fallback"), true);

  assert.deepEqual(values, ["fallback"]);
});

test("detects awake and asleep devices from dumpsys power", () => {
  assert.equal(devicePowerState("mWakefulness=Awake\nDisplay Power: state=ON"), "awake");
  assert.equal(devicePowerState("mWakefulness=Asleep\nDisplay Power: state=OFF"), "asleep");
  assert.equal(devicePowerState("unrecognized vendor output"), "unknown");
});

test("uses the wake helper and verifies the device is awake", async () => {
  const calls = [];
  let powerChecks = 0;
  const run = async (_adbPath, args) => {
    calls.push(args);
    if (args.some((value) => String(value).includes("dumpsys power"))) {
      powerChecks += 1;
      return { stdout: powerChecks === 1 ? "mWakefulness=Asleep" : "mWakefulness=Awake" };
    }
    return { stdout: "awake" };
  };

  const result = await ensureDeviceAwake({
    adbPath: "adb",
    serial: "phone-1",
    remoteWakeHelperPath: "/data/local/tmp/phone-cloud-wake.jar",
    run
  });

  assert.equal(result.wakeRequested, true);
  assert.equal(result.finalPowerState, "awake");
  assert.deepEqual(calls, [
    ["-s", "phone-1", "shell", "dumpsys power | grep -m 1 mWakefulness"],
    ["-s", "phone-1", "shell", "CLASSPATH=/data/local/tmp/phone-cloud-wake.jar app_process / com.phonecloud.wake.Main"],
    ["-s", "phone-1", "shell", "wm", "dismiss-keyguard"],
    ["-s", "phone-1", "shell", "dumpsys power | grep -m 1 mWakefulness"]
  ]);
});

test("uses KEYCODE_WAKEUP when the wake helper leaves a device asleep", async () => {
  const calls = [];
  let powerChecks = 0;
  const run = async (_adbPath, args) => {
    calls.push(args);
    if (args.some((value) => String(value).includes("dumpsys power"))) {
      powerChecks += 1;
      return { stdout: powerChecks < 3 ? "mWakefulness=Asleep" : "mWakefulness=Awake" };
    }
    return { stdout: "" };
  };

  const result = await ensureDeviceAwake({
    adbPath: "adb",
    serial: "phone-1",
    remoteWakeHelperPath: "/data/local/tmp/phone-cloud-wake.jar",
    run
  });

  assert.equal(result.wakeRequested, true);
  assert.equal(result.finalPowerState, "awake");
  assert.deepEqual(calls, [
    ["-s", "phone-1", "shell", "dumpsys power | grep -m 1 mWakefulness"],
    ["-s", "phone-1", "shell", "CLASSPATH=/data/local/tmp/phone-cloud-wake.jar app_process / com.phonecloud.wake.Main"],
    ["-s", "phone-1", "shell", "wm", "dismiss-keyguard"],
    ["-s", "phone-1", "shell", "dumpsys power | grep -m 1 mWakefulness"],
    ["-s", "phone-1", "shell", "input", "keyevent", "224"],
    ["-s", "phone-1", "shell", "wm", "dismiss-keyguard"],
    ["-s", "phone-1", "shell", "dumpsys power | grep -m 1 mWakefulness"]
  ]);
});

test("falls back to KEYCODE_WAKEUP when the vendor wake helper exits with an error", async () => {
  const calls = [];
  let powerChecks = 0;
  const run = async (_adbPath, args) => {
    calls.push(args);
    if (args.some((value) => String(value).includes("dumpsys power"))) {
      powerChecks += 1;
      return { stdout: powerChecks === 1 ? "mWakefulness=Asleep" : "mWakefulness=Awake" };
    }
    if (args.some((value) => String(value).includes("com.phonecloud.wake.Main"))) {
      throw new Error("vendor app_process rejected wake helper");
    }
    return { stdout: "" };
  };

  const result = await ensureDeviceAwake({
    adbPath: "adb",
    serial: "phone-1",
    remoteWakeHelperPath: "/data/local/tmp/phone-cloud-wake.jar",
    run
  });

  assert.equal(result.finalPowerState, "awake");
  assert.equal(result.wakeMethod, "keycode_wakeup_after_helper_failure");
  assert.equal(result.wakeHelperFailed, true);
  assert.deepEqual(calls, [
    ["-s", "phone-1", "shell", "dumpsys power | grep -m 1 mWakefulness"],
    ["-s", "phone-1", "shell", "CLASSPATH=/data/local/tmp/phone-cloud-wake.jar app_process / com.phonecloud.wake.Main"],
    ["-s", "phone-1", "shell", "input", "keyevent", "224"],
    ["-s", "phone-1", "shell", "wm", "dismiss-keyguard"],
    ["-s", "phone-1", "shell", "dumpsys power | grep -m 1 mWakefulness"]
  ]);
});

test("does not press KEYCODE_POWER when the device is already awake", async () => {
  const calls = [];
  const run = async (_adbPath, args) => {
    calls.push(args);
    return { stdout: "mWakefulness=Awake\nDisplay Power: state=ON" };
  };

  const result = await ensureDeviceAwake({ adbPath: "adb", serial: "phone-1", run });

  assert.equal(result.wakeRequested, false);
  assert.equal(result.finalPowerState, "awake");
  assert.deepEqual(calls, [
    ["-s", "phone-1", "shell", "dumpsys power | grep -m 1 mWakefulness"],
    ["-s", "phone-1", "shell", "wm", "dismiss-keyguard"]
  ]);
});

test("dismisses the MIUI proximity guard through scrcpy control", async () => {
  const calls = [];
  const controller = {
    async injectKeyCode(event) { calls.push([event.action, event.keyCode]); }
  };
  const result = await dismissVendorScreenGuard({
    adbPath: "adb",
    serial: "phone-1",
    controller,
    run: async () => ({ stdout: "mCurrentFocus=Window{abc ScreenOnProximitySensorGuide}" })
  });

  assert.equal(result.detected, true);
  assert.deepEqual(calls, [[0, 24], [1, 24]]);
});

test("waits for a short device task before reserving the serial for screen control", async () => {
  let attempts = 0;
  const statuses = [];
  const reserved = await waitForSerialReservation({
    serial: "phone-1",
    timeoutMs: 1_000,
    pollMs: 10,
    reserveSerial() {
      attempts += 1;
      return attempts >= 3;
    },
    onWaiting() {
      statuses.push("waiting");
    },
    delayFn: async () => {}
  });

  assert.equal(reserved, true);
  assert.equal(attempts, 3);
  assert.deepEqual(statuses, ["waiting"]);
});

test("gives screen control a chance to preempt background work before reserving the serial", async () => {
  const events = [];
  let backgroundWorkActive = true;
  const manager = createScreenStreamManager({
    config: {
      adbPath: "adb",
      screenMaxSize: 1600,
      screenMaxFps: 30,
      screenVideoBitRate: 5_000_000
    },
    agentDir: "/tmp/phone-cloud-test",
    preemptSerial(serial) {
      events.push(`preempt:${serial}`);
      backgroundWorkActive = false;
    },
    reserveSerial(serial) {
      events.push(`reserve:${serial}`);
      return !backgroundWorkActive;
    },
    async beforeSessionStart() {},
    async afterSessionEnd() {}
  });
  manager.socket = { readyState: 1, send() {} };
  manager.runSession = async () => {};

  await manager.startSession({ sessionId: "session-priority", adbSerial: "phone-1", options: {} });

  assert.deepEqual(events, ["preempt:phone-1", "reserve:phone-1"]);
});

test("stops waiting when the device task does not release before the deadline", async () => {
  let now = 0;
  const reserved = await waitForSerialReservation({
    serial: "phone-1",
    timeoutMs: 100,
    pollMs: 50,
    reserveSerial: () => false,
    now: () => now,
    delayFn: async (ms) => { now += ms; }
  });

  assert.equal(reserved, false);
});

test("pauses the automation worker while screen control owns the device", async () => {
  const events = [];
  let finishStream;
  const streamFinished = new Promise((resolve) => { finishStream = resolve; });
  const manager = createScreenStreamManager({
    config: {
      adbPath: "adb",
      screenMaxSize: 1600,
      screenMaxFps: 30,
      screenVideoBitRate: 5_000_000
    },
    agentDir: "/tmp/phone-cloud-test",
    reserveSerial() {
      events.push("reserved");
      return true;
    },
    releaseSerial() {
      events.push("released");
    },
    async beforeSessionStart(serial) {
      events.push(`paused:${serial}`);
    },
    async afterSessionEnd(serial) {
      events.push(`resumed:${serial}`);
    }
  });
  manager.socket = { readyState: 1, send() {} };
  manager.runSession = async () => {
    events.push("streaming");
    await streamFinished;
  };

  await manager.startSession({ sessionId: "session-1", adbSerial: "phone-1", options: {} });
  assert.deepEqual(events, ["reserved", "paused:phone-1", "streaming"]);

  finishStream();
  await waitUntil(() => events.includes("resumed:phone-1"));
  assert.deepEqual(events, ["reserved", "paused:phone-1", "streaming", "released", "resumed:phone-1"]);
});

test("does not resurrect a session when stop arrives during asynchronous startup", async () => {
  const events = [];
  let continueStartup;
  const blockedStartup = new Promise((resolve) => { continueStartup = resolve; });
  const manager = createScreenStreamManager({
    config: {
      adbPath: "adb",
      screenMaxSize: 1600,
      screenMaxFps: 30,
      screenVideoBitRate: 5_000_000
    },
    agentDir: "/tmp/phone-cloud-test",
    reserveSerial() { events.push("reserved"); return true; },
    releaseSerial() { events.push("released"); },
    async beforeSessionStart() { events.push("paused"); await blockedStartup; },
    async afterSessionEnd() { events.push("resumed"); }
  });
  manager.socket = { readyState: 1, send() {} };
  manager.runSession = async () => { events.push("streaming"); };

  const starting = manager.startSession({ sessionId: "session-cancelled", adbSerial: "phone-1", options: {} });
  await waitUntil(() => events.includes("paused"));
  await manager.handleMessage({ type: "screen_stop", sessionId: "session-cancelled", reason: "test_stop" });
  continueStartup();
  await starting;

  assert.equal(manager.sessions.has("session-cancelled"), false);
  assert.deepEqual(events, ["reserved", "paused", "released", "resumed"]);
});

test("waits for in-flight adb work before pausing automation for screen control", async () => {
  const events = [];
  const manager = createScreenStreamManager({
    config: {
      adbPath: "adb",
      screenMaxSize: 1600,
      screenMaxFps: 30,
      screenVideoBitRate: 5_000_000
    },
    agentDir: "/tmp/phone-cloud-test",
    reserveSerial() {
      events.push("reserved");
      return true;
    },
    async waitForSerialIdle(serial) {
      events.push(`idle:${serial}`);
    },
    async beforeSessionStart(serial) {
      events.push(`paused:${serial}`);
    },
    async afterSessionEnd() {}
  });
  manager.socket = { readyState: 1, send() {} };
  manager.runSession = async () => {
    events.push("streaming");
  };

  await manager.startSession({ sessionId: "session-adb-handoff", adbSerial: "phone-1", options: {} });

  assert.deepEqual(events.slice(0, 4), ["reserved", "idle:phone-1", "paused:phone-1", "streaming"]);
});

test("releases the device when scrcpy cleanup never settles", async () => {
  const events = [];
  const manager = createScreenStreamManager({
    config: {
      adbPath: "adb",
      screenMaxSize: 1600,
      screenMaxFps: 30,
      screenVideoBitRate: 5_000_000,
      screenCleanupTimeoutMs: 20,
      screenCleanupGraceMs: 1
    },
    agentDir: "/tmp/phone-cloud-test",
    releaseSerial(serial) {
      events.push(`released:${serial}`);
    },
    async afterSessionEnd(serial) {
      events.push(`resumed:${serial}`);
    }
  });
  manager.sessions.set("session-stuck", {
    sessionId: "session-stuck",
    serial: "phone-stuck",
    reader: { cancel: () => new Promise(() => {}) },
    client: { close: () => new Promise(() => {}) },
    closed: false
  });

  await Promise.race([
    manager.closeSession("session-stuck", "test", false),
    new Promise((_, reject) => setTimeout(() => reject(new Error("cleanup_timeout")), 250))
  ]);

  assert.deepEqual(events, ["released:phone-stuck", "resumed:phone-stuck"]);
  assert.equal(manager.sessions.has("session-stuck"), false);
});

test("rebinds the shared control queue when a control write times out", async () => {
  const events = [];
  const manager = createScreenStreamManager({
    config: {
      adbPath: "adb",
      screenMaxSize: 1600,
      screenMaxFps: 30,
      screenVideoBitRate: 5_000_000
    },
    agentDir: "/tmp/phone-cloud-test",
    log(message) { events.push(message); }
  });
  const videoClient = { async close() { events.push("video_closed"); } };
  const controlClient = { controller: {} };
  const session = {
    sessionId: "session-control-timeout",
    serial: "phone-1",
    closed: false,
    controlGeneration: 1,
    controlRecovering: false,
    controlQueue: { close(reason) { events.push(`queue_closed:${reason}`); } },
    videoClient,
    controlClient
  };

  manager.startControlClient = async (target) => {
    events.push(`control_rebound:${target.serial}`);
    target.controlClient = target.videoClient;
  };

  manager.requestControlRecovery(session, { type: "touch", action: "down", sequenceId: 7 }, 1);
  await waitUntil(() => events.includes("control_rebound:phone-1"));

  assert.deepEqual(events, [
    "queue_closed:screen_control_recovering",
    "screen control channel stalled",
    "control_rebound:phone-1"
  ]);
  assert.equal(session.videoClient, videoClient);
  assert.doesNotMatch(events.join(","), /video_closed/);
});

test("does not reset Android video when the WHIP publisher receives a WHEP PLI", async () => {
  const events = [];
  const manager = createScreenStreamManager({
    config: {
      adbPath: "adb",
      screenMaxSize: 1600,
      screenMaxFps: 30,
      screenVideoBitRate: 5_000_000,
      screenKeyframeRecoveryCooldownMs: 500,
      screenViewerKeyframeStartupWindowMs: 12_000,
      screenViewerKeyframeRecoveryMaxAttempts: 2
    },
    agentDir: "/tmp/phone-cloud-test",
    log(message, fields = {}) { events.push({ message, fields }); }
  });
  let resets = 0;
  const session = {
    sessionId: "session-viewer-keyframe",
    serial: "phone-static",
    closed: false,
    media: { mode: "webrtc" },
    startedAtMs: Date.now(),
    videoClient: { controller: { async resetVideo() { resets += 1; } } },
    mediaPublisher: {
      bufferedBytes: 0,
      async write() {}
    }
  };

  assert.equal(await manager.requestWebRtcKeyframe(session, "pli"), false);
  assert.equal(resets, 0);
  assert.equal(await manager.requestWebRtcKeyframe(session, "pli"), false);
  assert.equal(resets, 0);
  assert.equal(events.some((entry) => entry.message === "screen keyframe request observed"), true);
});

test("wakes then resets the source exactly once for each connected WHEP reader generation", async () => {
  const events = [];
  const lifecycle = [];
  const manager = createScreenStreamManager({
    config: {},
    agentDir: "/tmp/phone-cloud-test",
    log(message, fields = {}) { events.push({ message, fields }); }
  });
  let resets = 0;
  const session = {
    sessionId: "session-reader-ready",
    serial: "phone-static",
    closed: false,
    media: { mode: "webrtc" },
    viewerKeyframeResetEnabled: true,
    viewerKeyframeRecovery: { attempts: 0, pending: false, completed: false, generation: 0 },
    videoClient: { controller: { async resetVideo() { resets += 1; lifecycle.push("reset"); } } }
  };
  manager.sessions.set(session.sessionId, session);
  manager.wakeSessionForMediaReader = async () => {
    lifecycle.push("wake");
    return { powerState: "asleep", finalPowerState: "awake", wakeRequested: true, wakeMethod: "helper" };
  };

  assert.equal(await manager.handleMediaReaderReady(session.sessionId, 1), true);
  assert.deepEqual(lifecycle, ["wake", "reset"]);
  assert.equal(await manager.handleMediaReaderReady(session.sessionId, 1), false);
  assert.equal(await manager.requestWebRtcKeyframe(session, "pli"), false);
  assert.equal(resets, 1);
  assert.equal(await manager.handleMediaReaderReady(session.sessionId, 2), true);
  assert.deepEqual(lifecycle, ["wake", "reset", "wake", "reset"]);
  assert.equal(resets, 2);
  assert.equal(events.filter((entry) => entry.message === "screen viewer keyframe reset requested").length, 2);
});

test("publisher resync waits for the next source IDR without resetting the encoder", async () => {
  const events = [];
  const manager = createScreenStreamManager({
    config: {
      adbPath: "adb",
      screenMaxSize: 1600,
      screenMaxFps: 30,
      screenVideoBitRate: 5_000_000,
      screenKeyframeRecoveryCooldownMs: 500
    },
    agentDir: "/tmp/phone-cloud-test",
    log(message, fields = {}) { events.push({ message, fields }); }
  });
  let resets = 0;
  const session = {
    sessionId: "session-source-keyframe",
    serial: "phone-overload",
    closed: false,
    media: { mode: "webrtc" },
    videoClient: { controller: { async resetVideo() { resets += 1; } } }
  };

  assert.equal(await manager.requestWebRtcKeyframeRecovery(session, "publisher_overload"), false);
  assert.equal(resets, 0);
  assert.equal(await manager.requestWebRtcKeyframeRecovery(session, "publisher_overload"), false);
  assert.equal(resets, 0);
  assert.equal(events.some((entry) => entry.message === "screen keyframe recovery waiting for source idr"), true);
});

test("bounds hot video-source recovery without closing the media publisher", () => {
  const events = [];
  const manager = createScreenStreamManager({
    config: {
      screenSourceRecoveryMaxAttempts: 3,
      screenSourceRecoveryWindowSeconds: 30
    },
    agentDir: "/tmp/phone-cloud-test",
    log(message, fields = {}) { events.push({ message, fields }); }
  });
  manager.socket = { readyState: 1 };
  const session = {
    sessionId: "session-source-recovery",
    serial: "phone-124",
    sourceRecoveryEnabled: true,
    media: { mode: "webrtc" },
    mediaPublisher: { running: true }
  };
  const attempts = [];
  assert.equal(manager.reserveSourceRecoveryAttempt(session, attempts), true);
  assert.equal(manager.reserveSourceRecoveryAttempt(session, attempts), true);
  assert.equal(manager.reserveSourceRecoveryAttempt(session, attempts), true);
  assert.equal(manager.reserveSourceRecoveryAttempt(session, attempts), false);
  assert.equal(events.at(-1).message, "scrcpy video source recovery exhausted");
});

test("backs off long enough to bridge a transient USB/ADB re-enumeration", () => {
  assert.deepEqual(
    Array.from({ length: 8 }, (_item, index) => screenSourceRecoveryDelayMs(index + 1)),
    [200, 500, 1_000, 2_000, 3_000, 4_000, 5_000, 5_000]
  );
  assert.equal(screenSourceRecoveryDelayMs(99), 5_000);
});

async function waitUntil(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition_timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
