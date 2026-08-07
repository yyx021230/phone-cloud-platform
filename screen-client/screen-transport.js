export function buildScreenTransportUrls(baseUrl, sessionId, browserToken) {
  const base = new URL(String(baseUrl || globalThis.location?.origin || "http://127.0.0.1"));
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  // The browser credential is sent through Sec-WebSocket-Protocol, rather
  // than a query parameter that can be rewritten by proxies or extensions.
  base.search = "";
  base.hash = "";
  const sessionPath = encodeURIComponent(String(sessionId || ""));
  const control = new URL(base);
  control.pathname = `/realtime/v1/sessions/${sessionPath}/control`;
  const video = new URL(base);
  video.pathname = `/realtime/v1/sessions/${sessionPath}/video`;
  return { controlUrl: control.toString(), videoUrl: video.toString() };
}

export function createScreenTransport(options = {}) {
  const WebSocketCtor = options.WebSocketCtor || globalThis.WebSocket;
  const onControl = options.onControl || (() => {});
  const onVideo = options.onVideo || (() => {});
  const onOpen = options.onOpen || (() => {});
  const onError = options.onError || (() => {});
  const onClose = options.onClose || (() => {});
  let controlSocket = null;
  let videoSocket = null;
  let closing = false;

  const close = (code = 1000, reason = "user_closed") => {
    closing = true;
    for (const socket of [controlSocket, videoSocket]) {
      if (socket && socket.readyState < 2) socket.close(code, reason);
    }
    controlSocket = null;
    videoSocket = null;
  };

  return {
    connect({ baseUrl, sessionId, browserToken, videoEnabled = true }) {
      close();
      closing = false;
      const urls = buildScreenTransportUrls(baseUrl, sessionId, browserToken);
      const protocols = [String(browserToken || "")].filter(Boolean);
      controlSocket = new WebSocketCtor(urls.controlUrl, protocols);
      videoSocket = videoEnabled ? new WebSocketCtor(urls.videoUrl, protocols) : null;
      if (videoSocket) videoSocket.binaryType = "arraybuffer";
      controlSocket.onopen = () => onOpen("control");
      if (videoSocket) videoSocket.onopen = () => onOpen("video");
      controlSocket.onmessage = (event) => onControl(event.data);
      if (videoSocket) videoSocket.onmessage = (event) => onVideo(event.data);
      controlSocket.onerror = (event) => onError("control", event);
      if (videoSocket) videoSocket.onerror = (event) => onError("video", event);
      controlSocket.onclose = (event) => { if (!closing) onClose("control", event); };
      if (videoSocket) videoSocket.onclose = (event) => { if (!closing) onClose("video", event); };
      return urls;
    },
    send(message) {
      if (controlSocket?.readyState !== WebSocketCtor.OPEN) return false;
      controlSocket.send(JSON.stringify(message));
      return true;
    },
    close,
    get sockets() {
      return { control: controlSocket, video: videoSocket };
    }
  };
}
