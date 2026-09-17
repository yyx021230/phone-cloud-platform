export function createControlInput({
  video,
  send,
  keyboardTarget = video,
  documentTarget = globalThis.document,
  keyboardEnabled = () => true,
  requestFrame = globalThis.requestAnimationFrame?.bind(globalThis) || ((handler) => setTimeout(handler, 16)),
  cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis) || clearTimeout
}) {
  if (!video || typeof send !== "function") throw new Error("invalid_screen_control_input");
  let sequenceId = 0;
  let pendingMove = null;
  let moveFrameId = null;
  let sourceSize = null;
  let composing = false;
  let keyboardActive = false;
  const textTarget = keyboardTarget?.addEventListener ? keyboardTarget : video;
  const hasEditableTextTarget = typeof textTarget?.value === "string";
  const useDocumentKeyboard = Boolean(documentTarget?.addEventListener && documentTarget !== textTarget);

  const transmit = (message) => send({ ...message, sequenceId: ++sequenceId });
  const transmitText = (value) => {
    // The relay deliberately caps one text control at 1,000 UTF-16 code
    // units. Split large clipboard content here so a paste never makes the
    // control socket reject the entire message. Keep surrogate pairs intact.
    let chunk = "";
    for (const character of String(value || "")) {
      if (chunk && chunk.length + character.length > 1000) {
        transmit({ type: "text", text: chunk });
        chunk = "";
      }
      chunk += character;
    }
    if (chunk) transmit({ type: "text", text: chunk });
  };
  const snapshot = (event) => ({
    type: event.type,
    pointerId: event.pointerId,
    clientX: event.clientX,
    clientY: event.clientY
  });
  const sendTouch = (action, event, clampOutside = true) => {
    const position = mapPointerPosition(video, event, { clampOutside, sourceSize });
    if (!position) return false;
    transmit({ type: "touch", action, pointerId: event.pointerId, ...position });
    return true;
  };
  const flush = () => {
    if (moveFrameId != null) cancelFrame(moveFrameId);
    moveFrameId = null;
    const move = pendingMove;
    pendingMove = null;
    if (move) sendTouch("move", move);
  };
  const down = (event) => {
    event.preventDefault?.();
    // A visually hidden textarea is the keyboard focus target. Unlike video,
    // it receives native paste and Chinese/Japanese/Korean IME composition
    // events across browsers, while the visible UI remains the phone screen.
    if (!sendTouch("down", event, false)) return;
    keyboardActive = true;
    const focusKeyboard = () => textTarget.focus?.({ preventScroll: true });
    focusKeyboard();
    // Some Chromium builds restore focus after the pointer gesture finishes.
    // Re-focus once the gesture has settled so IME composition has a true
    // editable target before the user starts typing.
    setTimeout(focusKeyboard, 0);
    video.setPointerCapture?.(event.pointerId);
  };
  const move = (event) => {
    event.preventDefault?.();
    if (video.hasPointerCapture && !video.hasPointerCapture(event.pointerId)) return;
    pendingMove = snapshot(event);
    if (moveFrameId != null) return;
    moveFrameId = requestFrame(() => {
      moveFrameId = null;
      const latest = pendingMove;
      pendingMove = null;
      if (latest) sendTouch("move", latest);
    });
  };
  const up = (event) => {
    event.preventDefault?.();
    flush();
    sendTouch(event.type === "pointerup" ? "up" : "cancel", event);
    if (!video.hasPointerCapture || video.hasPointerCapture(event.pointerId)) video.releasePointerCapture?.(event.pointerId);
  };
  const keyboard = (event) => {
    if (!keyboardActive || !keyboardEnabled() || event.isComposing || event.key === "Process") return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && String(event.key || "").toLowerCase() === "a") {
      event.preventDefault?.();
      transmit({ type: "key", key: "select_all" });
      return;
    }
    const key = String(event.key || "");
    const specialKey = { Backspace: "delete", Delete: "forward_delete", Enter: "enter" }[key];
    if (specialKey) {
      event.preventDefault?.();
      transmit({ type: "key", key: specialKey });
      return;
    }
    // Editable targets deliver ordinary characters through `input`, which is
    // essential for IME text. Retain the direct-video fallback for callers
    // that intentionally do not provide a keyboard bridge.
    if (event.ctrlKey || event.metaKey || event.altKey || key.length !== 1) return;
    if (!hasEditableTextTarget) {
      event.preventDefault?.();
      transmitText(key);
    }
  };
  const input = (event) => {
    if (!keyboardActive || !keyboardEnabled() || composing) return;
    const text = String(event.data || textTarget.value || "");
    if (text) transmitText(text);
    if (hasEditableTextTarget) textTarget.value = "";
  };
  const compositionStart = () => {
    if (keyboardActive && keyboardEnabled()) composing = true;
  };
  const compositionEnd = (event) => {
    if (!keyboardActive || !keyboardEnabled()) return;
    composing = false;
    const text = String(event.data || textTarget.value || "");
    if (text) transmitText(text);
    if (hasEditableTextTarget) textTarget.value = "";
  };
  const paste = (event) => {
    if (!keyboardActive || !keyboardEnabled()) return;
    const text = String(event.clipboardData?.getData("text/plain") || "");
    if (!text) return;
    event.preventDefault?.();
    transmitText(text);
    if (hasEditableTextTarget) textTarget.value = "";
  };
  const documentPointerDown = (event) => {
    if (event.target !== video && !video.contains?.(event.target)) keyboardActive = false;
  };
  const pointerListeners = [["pointerdown", down], ["pointermove", move], ["pointerup", up], ["pointercancel", up]];
  const keyboardListeners = [["input", input], ["compositionstart", compositionStart], ["compositionend", compositionEnd]];
  const keyboardEventListeners = [["keydown", keyboard], ["paste", paste]];
  for (const [name, handler] of pointerListeners) video.addEventListener(name, handler);
  for (const [name, handler] of keyboardListeners) textTarget.addEventListener(name, handler);
  if (useDocumentKeyboard) {
    for (const [name, handler] of keyboardEventListeners) documentTarget.addEventListener(name, handler, true);
    documentTarget.addEventListener("pointerdown", documentPointerDown, true);
  } else {
    for (const [name, handler] of keyboardEventListeners) textTarget.addEventListener(name, handler);
  }

  return {
    flush,
    setSourceSize(width, height) {
      const normalizedWidth = Math.max(0, Math.round(Number(width || 0)));
      const normalizedHeight = Math.max(0, Math.round(Number(height || 0)));
      sourceSize = normalizedWidth && normalizedHeight ? { width: normalizedWidth, height: normalizedHeight } : null;
    },
    key(key) { transmit({ type: "key", key }); },
    text(value) { transmitText(value); },
    destroy() {
      flush();
      keyboardActive = false;
      for (const [name, handler] of pointerListeners) video.removeEventListener(name, handler);
      for (const [name, handler] of keyboardListeners) textTarget.removeEventListener(name, handler);
      if (useDocumentKeyboard) {
        for (const [name, handler] of keyboardEventListeners) documentTarget.removeEventListener(name, handler, true);
        documentTarget.removeEventListener("pointerdown", documentPointerDown, true);
      } else {
        for (const [name, handler] of keyboardEventListeners) textTarget.removeEventListener(name, handler);
      }
    }
  };
}

export function mapPointerPosition(video, event, { clampOutside = true, sourceSize = null } = {}) {
  const rect = video.getBoundingClientRect();
  // WebRTC videoWidth/videoHeight can briefly be zero or stale across a
  // renegotiation. Prefer the encoder dimensions confirmed by the executor.
  const videoWidth = Math.max(0, Math.round(Number(sourceSize?.width || video.videoWidth || 0)));
  const videoHeight = Math.max(0, Math.round(Number(sourceSize?.height || video.videoHeight || 0)));
  if (!videoWidth || !videoHeight || !rect.width || !rect.height) return null;
  const sourceRatio = videoWidth / videoHeight;
  const boxRatio = rect.width / rect.height;
  const renderedWidth = sourceRatio > boxRatio ? rect.width : rect.height * sourceRatio;
  const renderedHeight = sourceRatio > boxRatio ? rect.width / sourceRatio : rect.height;
  const offsetX = (rect.width - renderedWidth) / 2;
  const offsetY = (rect.height - renderedHeight) / 2;
  const rawX = Number(event.clientX) - rect.left - offsetX;
  const rawY = Number(event.clientY) - rect.top - offsetY;
  if (!clampOutside && (rawX < 0 || rawY < 0 || rawX > renderedWidth || rawY > renderedHeight)) return null;
  const relativeX = Math.max(0, Math.min(renderedWidth, rawX));
  const relativeY = Math.max(0, Math.min(renderedHeight, rawY));
  return {
    x: Math.min(videoWidth - 1, Math.max(0, Math.round(relativeX / renderedWidth * videoWidth))),
    y: Math.min(videoHeight - 1, Math.max(0, Math.round(relativeY / renderedHeight * videoHeight))),
    videoWidth,
    videoHeight
  };
}
