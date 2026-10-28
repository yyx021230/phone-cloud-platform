import fs from "node:fs/promises";
import http from "node:http";
import pg from "pg";
import { createBatchStore } from "./store.mjs";
import { BatchEngine, validateClients } from "./engine.mjs";
import { createPlatformClient } from "./platform.mjs";
import { createBatchHandler } from "./http.mjs";

// This separate service never loads the platform .env or starts an Agent/ADB.
if (!process.env.XHS_BATCH_CONFIG_FILE || !process.env.XHS_BATCH_DATABASE_URL) throw new Error("batch_config_required");
const stat = await fs.stat(process.env.XHS_BATCH_CONFIG_FILE);
if (process.platform !== "win32" && (stat.mode & 0o077)) throw new Error("batch_config_must_be_private");
const config = JSON.parse(await fs.readFile(process.env.XHS_BATCH_CONFIG_FILE, "utf8"));
const clients = validateClients(config.clients);
const pool = new pg.Pool({ connectionString: process.env.XHS_BATCH_DATABASE_URL, max: 2,
  connectionTimeoutMillis: 5000, query_timeout: 10000, statement_timeout: 10000 });
const store = await createBatchStore(pool);
const platforms = new Map(clients.map(c => [c.clientId, createPlatformClient({ baseUrl: config.platformBaseUrl, username: c.username, password: c.password })]));
const engine = new BatchEngine({ store, clients, platforms });
const server = http.createServer(createBatchHandler({ engine, store, clients }));
server.requestTimeout = 35_000; server.headersTimeout = 10_000;
server.listen(Number(process.env.XHS_BATCH_PORT || 8791), "127.0.0.1");
let ticking = false;
const timer = setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try { await engine.tick(); await store.pruneNonces(Date.now()); }
  catch { console.error("xhs_batch_tick_failed_check_health_and_persisted_run"); }
  finally { ticking = false; }
}, 10_000);
const stop = async () => {
  clearInterval(timer);
  server.close();
  await engine.chain;
  await store.close(); await pool.end();
};
process.once("SIGTERM", stop); process.once("SIGINT", stop);
