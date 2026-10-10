// Merge only the reviewed history-maintenance repair into exported production
// code. No remote access, environment loading, deployment or credentials.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const [exportFile, outputDir] = process.argv.slice(2);
assert(exportFile && outputDir, "usage: node prepare-history-maintenance-merge.mjs exported-code.jsonl NEW-output-directory");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const local = await fs.readFile(path.join(repo, "server/index.mjs"), "utf8");
const rows = (await fs.readFile(exportFile, "utf8")).trim().split("\n").map(JSON.parse);
const container = rows.find(r => r.kind === "container-code").files;
const host = rows.find(r => r.kind === "host-code").files;
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const verified = JSON.parse(await fs.readFile(path.join(repo, "docs/evidence/TASK_HISTORY_LOCAL_FIX_20260910.json"), "utf8"));
assert.equal(sha(local), verified.sourceSha256["server/index.mjs"], "local entrypoint changed after verification; review before merging");
assert.equal(sha(await fs.readFile(path.join(repo, "server/task-history-maintenance.mjs"))), verified.sourceSha256["server/task-history-maintenance.mjs"], "maintenance module changed after verification");
function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, `expected exactly one match: ${before.slice(0, 110)}`);
  return source.replace(before, after);
}
function fn(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, name);
  const end = source.indexOf("\n}", start) + 2;
  assert(end > start, name);
  return source.slice(start, end);
}
function merge(input) {
  let out = replaceOnce(input, 'import crypto from "node:crypto";', 'import { compactTaskPayload, maintainTaskHistory, normalizeLoadedTaskHistory } from "./task-history-maintenance.mjs";\nimport crypto from "node:crypto";');
  out = replaceOnce(out, "  publicAutomationJob,", "  publicAutomationJob as buildPublicAutomationJob,");
  const anchor = "if (structuredRepos) applyStructuredOverlay(state, await structuredRepos.loadOverlay());\n";
  const localStart = local.indexOf(anchor) + anchor.length;
  out = replaceOnce(out, anchor, anchor + local.slice(localStart, local.indexOf("sortSmsMessagesNewestFirst(state.smsMessages);", localStart)));
  for (const name of ["compactCompletedTask", "trimTaskEvents", "compactTaskCollectionsForSave", "pruneArray", "sanitizeEventDetail", "sanitizeStoredEvent", "publicXhsEventSummary", "publicWindowsTaskEventSummary", "xhsTaskAsDeviceCommand"]) {
    out = replaceOnce(out, fn(out, name), fn(local, name));
  }
  out = replaceOnce(out, fn(out, "signedEvidenceUrl"), fn(out, "signedEvidenceUrl") + "\n\n" + fn(local, "publicEventHierarchyUrl") + "\n\n" + fn(local, "publicAutomationJob"));
  for (const kind of ["uiHierarchy", "uiSnapshot"]) {
    const before = `  if (input.${kind}Evidence) result.${kind}Evidence = publicEvidenceAsset(input.${kind}Evidence);`;
    const after = `  if (input.${kind}Evidence) {\n    result.${kind}Evidence = publicEvidenceAsset(input.${kind}Evidence);\n    result.${kind}Url = result.${kind}Evidence.url;\n  }`;
    out = replaceOnce(out, before, after);
  }
  out = replaceOnce(out, "    state.smsMessages = next.smsMessages;\n    smsMessageIndex.replace(state.smsMessages);", "    if (state.smsMessages !== next.smsMessages) {\n      state.smsMessages = next.smsMessages;\n      smsMessageIndex.replace(state.smsMessages);\n    }");
  // Restrict result changes to the two legacy ingress blocks, not other routes.
  for (const route of ["deviceCommandStatusMatch", "xhsTaskStatusMatch"]) {
    const start = out.indexOf(`  if (req.method === "POST" && ${route}) {`);
    const end = out.indexOf("\n  }", start) + 4;
    assert(start >= 0 && end > start, route);
    const block = out.slice(start, end);
    const replacement = replaceOnce(block, "    task.result = input.result || {};", "    task.result = isTerminalStatus(task.status)\n      ? sanitizeTaskResult(input.result || {}, { includeEvidence: true })\n      : input.result || {};");
    out = out.slice(0, start) + replacement + out.slice(end);
  }
  const start = out.indexOf('  if (req.method === "POST" && deviceCommandEventsMatch) {');
  const end = out.indexOf("\n  }", start) + 4;
  assert(start >= 0 && end > start);
  let block = out.slice(start, end);
  block = replaceOnce(block, "    const event = {", "    const event = sanitizeStoredEvent({");
  block = replaceOnce(block, "      createdAt: nowIso()\n    };", "      createdAt: nowIso()\n    });");
  out = out.slice(0, start) + block + out.slice(end);
  out = replaceOnce(out, "    return json(res, 200, { events: task.events || [] });", "    return json(res, 200, { events: (task.events || []).map((event) => sanitizeStoredEvent(event)) });");
  return out;
}
// Refuse reuse/overwrite of an existing staging directory.
await fs.mkdir(outputDir, { mode: 0o700 });
await fs.mkdir(path.join(outputDir, "candidate/server"), { recursive: true });
await fs.mkdir(path.join(outputDir, "baseline"));
const outputFiles = {};
for (const [file, source] of Object.entries(container)) {
  assert(/^server\/[\w.-]+\.mjs$/.test(file), "only exported server modules");
  const next = file === "server/index.mjs" ? merge(source) : source;
  await fs.writeFile(path.join(outputDir, "candidate", file), next, { mode: 0o600 });
  outputFiles[file] = { beforeSha256: sha(source), afterSha256: sha(next) };
}
await fs.writeFile(path.join(outputDir, "baseline/container-index.mjs"), container["server/index.mjs"], { mode: 0o600 });
await fs.writeFile(path.join(outputDir, "baseline/host-index.mjs"), host["server/index.mjs"], { mode: 0o600 });
const hostCandidate = merge(host["server/index.mjs"]);
await fs.writeFile(path.join(outputDir, "host-index.mjs"), hostCandidate, { mode: 0o600 });
await fs.copyFile(path.join(repo, "server/task-history-maintenance.mjs"), path.join(outputDir, "candidate/server/task-history-maintenance.mjs"));
const manifest = {
  releaseId: "20260910-history-maintenance-v1", status: "prepared_not_activated",
  container: outputFiles["server/index.mjs"],
  moduleSha256: sha(await fs.readFile(path.join(repo, "server/task-history-maintenance.mjs"))),
  host: { beforeSha256: sha(host["server/index.mjs"]), afterSha256: sha(hostCandidate) },
  unchangedContainerModules: Object.keys(outputFiles).filter(file => outputFiles[file].beforeSha256 === outputFiles[file].afterSha256),
  excluded: ["Windows Agent", "ADB/USB/PnP/phone", "MediaMTX", "player/control/transport policy", "other workspace candidates"]
};
await fs.writeFile(path.join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ ...manifest, unchangedContainerModules: manifest.unchangedContainerModules.length }));
