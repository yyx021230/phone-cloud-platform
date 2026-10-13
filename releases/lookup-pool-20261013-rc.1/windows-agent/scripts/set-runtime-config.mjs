import fs from "node:fs/promises";
import path from "node:path";

const [configPath, key, rawValue] = process.argv.slice(2);
const allowedKeys = new Set(["screenPublisherStatsIntervalSeconds"]);

if (!configPath || !allowedKeys.has(key)) {
  throw new Error("usage: node set-runtime-config.mjs <configPath> screenPublisherStatsIntervalSeconds <seconds>");
}

const value = Math.max(0, Math.min(60, Number(rawValue)));
if (!Number.isFinite(value)) throw new Error("invalid_runtime_config_value");

const source = await fs.readFile(configPath, "utf8");
const config = JSON.parse(source.replace(/^\uFEFF/, ""));
config[key] = value;

const output = `${JSON.stringify(config, null, 2)}\n`;
// Parse the exact bytes before replacing the live config.
JSON.parse(output);

const directory = path.dirname(configPath);
const temporaryPath = path.join(directory, `.${path.basename(configPath)}.tmp`);
await fs.writeFile(temporaryPath, output, "utf8");
await fs.rename(temporaryPath, configPath);

console.log(JSON.stringify({ updated: key, value }));
