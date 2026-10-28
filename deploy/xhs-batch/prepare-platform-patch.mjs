import fs from "node:fs/promises";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const PLATFORM_BASELINE = "76e197e2b01b2f625d068cede5b9b2e4d224598e50531072b8cf9313bb83ecae";
export const SERVER_BASELINE = "b42951d9bec95d368dd381a920a18f53329cab53f85ee5056e3a0d3aa3c8f397";
export const bindingGuard = `    if (input.expectedXhsId !== undefined && input.expectedXhsId !== account.xhsId) {
      return json(res, 409, { error: "xhs_account_binding_changed" });
    }
`;
export const identityFields = `    ...(job.kind === "xhs_data_collect" ? {
      xhsAccountId: String(job.xhsAccountId || ""),
      xhsAccountName: String(job.xhsAccountName || ""),
      clientRequestId: String(job.clientRequestId || ""),
      accountIdentitySource: "platform_binding_snapshot"
    } : {}),
`;
export function preparePatch(source) {
  if (crypto.createHash("sha256").update(source).digest("hex") !== PLATFORM_BASELINE) throw new Error("platform_baseline_changed_stop_and_review");
  const anchor = '    xhsAccountLabel: String(job.xhsAccountLabel || ""),\n';
  if (source.split(anchor).length !== 2) throw new Error("platform_patch_anchor_ambiguous");
  return source.replace(anchor, anchor + identityFields);
}
export function prepareServerPatch(source) {
  if (crypto.createHash("sha256").update(source).digest("hex") !== SERVER_BASELINE) throw new Error("server_baseline_changed_stop_and_review");
  const anchor = '    if (!account) return json(res, 409, { error: "xhs_account_slot_not_available" });\n';
  if (source.split(anchor).length !== 2) throw new Error("server_patch_anchor_ambiguous");
  const start = source.indexOf('  if (url.pathname === "/api/v1/user/automation/xhs-data-tasks"');
  const end = source.indexOf('  const dataDetailMatch', start);
  if (start < 0 || end < 0) throw new Error("collection_route_missing");
  let route = source.slice(start, end);
  const replace = (before, after) => {
    if (route.split(before).length !== 2) throw new Error("collection_patch_anchor_ambiguous");
    route = route.replace(before, after);
  };
  replace(anchor, anchor + bindingGuard);
  replace('      return json(res, 200, { tasks: state.automationJobs\n        .filter((job) => job.kind === "xhs_data_collect" && job.userId === ctx.userId)',
    '      const reference = url.searchParams.get("clientRequestId");\n'
    + '      if (reference !== null && !/^[A-Za-z0-9_.:-]{8,120}$/.test(reference)) return json(res, 400, { error: "invalid_collection_reference" });\n'
    + '      return json(res, 200, { batchContract: { version: 1, expectedXhsId: true, identitySnapshot: true, submissionLookup: true }, tasks: state.automationJobs\n'
    + '        .filter((job) => job.kind === "xhs_data_collect" && job.userId === ctx.userId && (reference === null || job.clientRequestId === reference))');
  const slot = '    if (!["app1", "app2"].includes(input.xhsAppSlot)) return json(res, 400, { error: "invalid_xhs_app_slot" });\n';
  replace(slot, slot
    + '    if (input.clientRequestId !== undefined && (typeof input.clientRequestId !== "string" || !/^[A-Za-z0-9_.:-]{8,120}$/.test(input.clientRequestId))) return json(res, 400, { error: "invalid_collection_reference" });\n'
    + '    if (input.clientRequestId && state.automationJobs.some(job => job.kind === "xhs_data_collect" && job.userId === ctx.userId && job.clientRequestId === input.clientRequestId)) return json(res, 409, { error: "collection_reference_already_used" });\n');
  const created = '      xhsAccountId: account.xhsId, xhsAccountName: account.accountName, title: "小红书数据采集" });\n';
  replace(created, created + '    if (input.clientRequestId) job.clientRequestId = input.clientRequestId;\n');
  return source.slice(0, start) + route + source.slice(end);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , input, output, mode = "model"] = process.argv;
  if (!input || !output || input === output) throw new Error("usage: prepare-platform-patch.mjs BASELINE NEW_OUTPUT");
  if (!["model", "server"].includes(mode)) throw new Error("invalid_patch_mode");
  const patched = (mode === "server" ? prepareServerPatch : preparePatch)(await fs.readFile(input, "utf8"));
  await fs.writeFile(output, patched, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ baseline: mode === "server" ? SERVER_BASELINE : PLATFORM_BASELINE, patched: crypto.createHash("sha256").update(patched).digest("hex") }));
}
