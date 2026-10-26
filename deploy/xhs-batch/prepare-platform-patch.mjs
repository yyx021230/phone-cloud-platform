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
  return source.replace(anchor, anchor + bindingGuard);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , input, output, mode = "model"] = process.argv;
  if (!input || !output || input === output) throw new Error("usage: prepare-platform-patch.mjs BASELINE NEW_OUTPUT");
  if (!["model", "server"].includes(mode)) throw new Error("invalid_patch_mode");
  const patched = (mode === "server" ? prepareServerPatch : preparePatch)(await fs.readFile(input, "utf8"));
  await fs.writeFile(output, patched, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ baseline: mode === "server" ? SERVER_BASELINE : PLATFORM_BASELINE, patched: crypto.createHash("sha256").update(patched).digest("hex") }));
}
