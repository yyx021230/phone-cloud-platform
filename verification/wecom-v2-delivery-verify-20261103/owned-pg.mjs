// Reviewed fixture entry guard only. No pool or connection is created on import.
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
export async function ownedConfiguration() {
  const root = process.env.WECOM_V2_FIXTURE_ROOT || "", port = Number(process.env.WECOM_V2_FIXTURE_PORT);
  if (process.getuid?.() === 0 || !path.isAbsolute(root) || !path.basename(root).startsWith("pc-wecom-v2-delivery-pg-")
    || !Number.isInteger(port) || port < 20000 || port > 65535) throw Error("fixture_owned_configuration_required");
  const info = await fs.lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0
    || await fs.realpath(root) !== root) throw Error("fixture_private_root_required");
  const marker = JSON.parse(await fs.readFile(path.join(root, "fixture.json"), "utf8"));
  const pid = (await fs.readFile(path.join(root, "db", "postmaster.pid"), "utf8")).trim().split("\n");
  if (marker.kind !== "owned-loopback-wecom-v2-delivery" || marker.root !== root || marker.port !== port || marker.postgresPid !== Number(pid[0])
    || pid[1] !== path.join(root, "db") || Number(pid[3]) !== port || pid[4] !== root) throw Error("fixture_postmaster_identity_required");
  process.kill(marker.postgresPid, 0); // Read-only existence, never signal/stop it.
  const require = createRequire("/Users/yyx/ztqc/phone-cloud-platform/package.json");
  if (require("pg/package.json").version !== "8.22.0") throw Error("fixture_pg_dependency_changed");
  const { Pool } = require("pg");
  const options = { host: "127.0.0.1", port, user: "wecom_v2_fixture", database: "wecom_v2_host_fixture", password: "", ssl: false,
    connectionTimeoutMillis: 2000, idleTimeoutMillis: 1000, query_timeout: 6000, max: 4 };
  return { root, port, marker, Pool, options };
}
export async function verifyOwnedServer(pool, config) {
  const answer = await pool.query(`SELECT current_setting('data_directory') AS directory,
    current_setting('port') AS port, current_user AS username, current_database() AS database,
    current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS synchronous_commit`);
  const r = answer.rows[0];
  if (r?.directory !== path.join(config.root, "db") || Number(r.port) !== config.port || r.username !== "wecom_v2_fixture"
    || r.database !== "wecom_v2_host_fixture" || r.fsync !== "on" || r.synchronous_commit !== "on") throw Error("fixture_server_mismatch");
  return { privateDataDirectoryMatched: true, loopbackPortMatched: true, fsync: r.fsync, synchronousCommit: r.synchronous_commit };
}
