import { WebSocket } from "ws";

export function buildScreenVideoPublishUrl(serverBaseUrl, sessionId, agentId) {
  const url = new URL(String(serverBaseUrl || "http://127.0.0.1:8787"));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/realtime/v1/sessions/${encodeURIComponent(String(sessionId || ""))}/video-publish`;
  url.search = `agentId=${encodeURIComponent(String(agentId || ""))}`;
  url.hash = "";
  return url.toString();
}

export async function openScreenVideoChannel(options = {}) {
  const WebSocketCtor = options.WebSocketCtor || WebSocket;
  const url = buildScreenVideoPublishUrl(options.serverBaseUrl, options.sessionId, options.agentId);
  const socket = new WebSocketCtor(url, {
    headers: { authorization: `Bearer ${String(options.agentToken || "")}` },
    handshakeTimeout: Math.max(1_000, Number(options.handshakeTimeoutMs || 15_000))
  });
  await waitForOpen(socket, options.openTimeoutMs || 15_000);
  return {
    socket,
    send(packet) {
      if (socket.readyState !== WebSocketCtor.OPEN) return false;
      socket.send(Buffer.from(packet), { binary: true });
      return true;
    },
    close(code = 1000, reason = "video_closed") {
      if (socket.readyState === WebSocketCtor.OPEN || socket.readyState === WebSocketCtor.CONNECTING) socket.close(code, reason);
    }
  };
}

function waitForOpen(socket, timeoutMs) {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === socket.constructor?.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      try { socket.terminate?.(); } catch {}
      reject(new Error("screen_video_channel_timeout"));
    }, Math.max(1_000, Number(timeoutMs || 15_000)));
    const cleanup = () => {
      clearTimeout(timer);
      socket.off?.("open", onOpen);
      socket.off?.("error", onError);
    };
    const onOpen = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}
