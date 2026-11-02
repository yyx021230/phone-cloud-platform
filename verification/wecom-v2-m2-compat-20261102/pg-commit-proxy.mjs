// Fixture-only PG wire gate. Importing it opens no port. Only fixed loopback
// destinations are supported; no credentials, Bind payloads or SQL text logged.
import net from "node:net";
import { once } from "node:events";

const MAX_FRAME = 65536, MAX_BUFFER = 131072;
export class FrameReader {
  constructor(startup = false) { this.startup = startup; this.buffer = Buffer.alloc(0); }
  feed(chunk) {
    if (!Buffer.isBuffer(chunk) || chunk.length + this.buffer.length > MAX_BUFFER) throw Error("fixture_frame_bound");
    this.buffer = Buffer.concat([this.buffer, chunk]); const frames = [];
    while (this.buffer.length >= (this.startup ? 4 : 5)) {
      const startup = this.startup, length = this.buffer.readUInt32BE(startup ? 0 : 1), size = length + (startup ? 0 : 1);
      if (length < (startup ? 8 : 4) || size > MAX_FRAME) throw Error("fixture_frame_bound");
      if (this.buffer.length < size) break;
      const raw = Buffer.from(this.buffer.subarray(0, size)); this.buffer = this.buffer.subarray(size);
      if (startup && raw.readUInt32BE(4) !== 196608) throw Error("fixture_startup_protocol");
      frames.push({ type: startup ? "startup" : String.fromCharCode(raw[0]), payload: raw.subarray(startup ? 4 : 5), raw });
      this.startup = false;
    }
    return frames;
  }
}
function queryText(frame) {
  if (frame.type === "Q") return frame.payload.toString("utf8").replace(/\0$/, "");
  if (frame.type !== "P") return "";
  const at = frame.payload.indexOf(0), end = frame.payload.indexOf(0, at + 1);
  return at >= 0 && end >= 0 ? frame.payload.subarray(at + 1, end).toString("utf8") : "";
}
export class CommitGate {
  constructor(mode, controller, emit) {
    if (!["before_commit", "after_commit"].includes(mode)) throw Error("fixture_mode");
    this.mode = mode; this.controller = controller; this.emit = emit;
    this.awaiting = false; this.commandCount = 0; this.tag = "none"; this.errors = 0;
  }
  frontend(frame) {
    const text = queryText(frame), match = /^\s*(SELECT|INSERT|UPDATE|BEGIN|SET|COMMIT|ROLLBACK)\b/i.exec(text);
    if (match) this.emit({ event: "query", command: match[1].toUpperCase() });
    if (frame.type === "Q" && /^\s*COMMIT\s*;?\s*$/i.test(text) && !this.controller.spent) {
      this.controller.spent = true;
      if (this.mode === "before_commit") { this.emit({ event: "dropped_before_commit" }); return { forward: false, drop: true }; }
      this.awaiting = true;
    }
    return { forward: true, drop: false };
  }
  backend(frame) {
    if (!this.awaiting) return { forward: true, drop: false };
    if (frame.type === "E") this.errors++;
    if (frame.type === "C") {
      this.commandCount++;
      const raw = frame.payload.length <= 64 && frame.payload.at(-1) === 0 ? frame.payload.subarray(0, -1).toString("ascii") : "invalid";
      this.tag = ["COMMIT", "ROLLBACK"].includes(raw) ? raw : "other";
    }
    if (frame.type === "Z") {
      const ready = frame.payload.length === 1 && [73, 84, 69].includes(frame.payload[0]) ? String.fromCharCode(frame.payload[0]) : "other";
      this.emit({ event: "backend_commit_completion", commandTag: this.tag, commandCompleteCount: this.commandCount,
        readyForQuery: ready, errorResponseCount: this.errors,
        commitConfirmedFromBackend: this.tag === "COMMIT" && this.commandCount === 1 && ready === "I" && this.errors === 0 });
      return { forward: false, drop: true };
    }
    return { forward: false, drop: false }; // Never leak COMMIT success bytes.
  }
}

export async function startCommitReplyProxy({ backendPort, mode, onBackendCompletion }) {
  if (!Number.isInteger(backendPort) || backendPort < 20000 || backendPort > 65535) throw Error("fixture_port");
  if (!["before_commit", "after_commit"].includes(mode)) throw Error("fixture_mode");
  if (onBackendCompletion !== undefined && typeof onBackendCompletion !== "function") throw Error("fixture_callback");
  const events = [], sockets = new Set(), controller = { spent: false }; let sequence = 0;
  const emit = event => {
    if (events.length >= 128) throw Error("fixture_event_bound"); events.push(Object.freeze(event));
    if (event.event === "backend_commit_completion") onBackendCompletion?.(Object.freeze({ ...event }));
  };
  const server = net.createServer(front => {
    const connectionId = ++sequence;
    if (sequence > 8) { front.destroy(); return; }
    const back = net.createConnection({ host: "127.0.0.1", port: backendPort });
    sockets.add(front); sockets.add(back);
    const gate = new CommitGate(mode, controller, event => emit({ connectionId, ...event }));
    const readers = [new FrameReader(true), new FrameReader(false)];
    const drop = () => { front.destroy(); back.destroy(); };
    const consume = (chunk, source) => {
      try {
        for (const frame of readers[source].feed(chunk)) {
          const action = source === 0 ? gate.frontend(frame) : gate.backend(frame);
          if (action.forward) (source === 0 ? back : front).write(frame.raw);
          if (action.drop) { drop(); break; }
        }
      } catch { try { emit({ connectionId, event: "proxy_rejected" }); } catch {} drop(); }
    };
    front.setTimeout(10000, drop); back.setTimeout(10000, drop);
    front.on("data", chunk => consume(chunk, 0)); back.on("data", chunk => consume(chunk, 1));
    front.on("error", drop); back.on("error", drop);
    front.on("close", () => { sockets.delete(front); back.destroy(); });
    back.on("close", () => { sockets.delete(back); front.destroy(); });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return {
    port: server.address().port,
    snapshot: () => ({ mode, connections: sequence, faultSpent: controller.spent, events: structuredClone(events) }),
    async close() {
      const closed = new Promise(resolve => server.close(() => resolve(true)));
      const waiting = [...sockets].map(socket => new Promise(resolve => socket.once("close", resolve)));
      for (const socket of sockets) socket.destroy();
      let timer;
      const completed = await Promise.race([Promise.all([closed, ...waiting]).then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 2000); })]);
      clearTimeout(timer);
      if (!completed || server.listening || sockets.size !== 0) throw Error("fixture_proxy_close_unconfirmed");
    }
  };
}
