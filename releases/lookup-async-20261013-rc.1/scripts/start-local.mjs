import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const children = [];
let stopping = false;

start("platform", "node", ["server/index.mjs"], rootDir);
start("windows-agent", "node", ["src/index.mjs"], path.join(rootDir, "windows-agent"));

process.on("SIGINT", () => stopAll("SIGINT"));
process.on("SIGTERM", () => stopAll("SIGTERM"));

function start(name, command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    windowsHide: true
  });
  children.push({ name, child });
  child.stdout.on("data", (chunk) => writePrefixed(name, chunk));
  child.stderr.on("data", (chunk) => writePrefixed(name, chunk));
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`[${name}] exited code=${code ?? ""} signal=${signal ?? ""}`);
    stopAll(`${name}_exit`);
  });
}

function writePrefixed(name, chunk) {
  for (const line of String(chunk || "").split(/\r?\n/)) {
    if (!line) continue;
    console.log(`[${name}] ${line}`);
  }
}

function stopAll(reason) {
  if (stopping) return;
  stopping = true;
  console.log(`[local] stopping: ${reason}`);
  for (const { child } of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(0), 1500).unref();
}
