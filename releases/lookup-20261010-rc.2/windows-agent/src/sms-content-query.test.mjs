import assert from "node:assert/strict";
import test from "node:test";
import { buildSmsContentQueryArgs, quoteAdbRemoteShellArgument } from "./sms-content-query.mjs";

test("quotes an SMS selection for the Android remote shell", () => {
  assert.equal(quoteAdbRemoteShellArgument("_id > 580"), "'_id > 580'");
  assert.equal(quoteAdbRemoteShellArgument("address = '10086'"), "'address = '\\''10086'\\'''");
});

test("builds an incremental content query without exposing shell redirection", () => {
  assert.deepEqual(buildSmsContentQueryArgs(["_id", "date"], "_id > 580"), [
    "shell",
    "content",
    "query",
    "--uri",
    "content://sms",
    "--projection",
    "_id:date",
    "--where",
    "'_id > 580'"
  ]);
});

test("omits the selection only for an intentional full query", () => {
  assert.deepEqual(buildSmsContentQueryArgs(["_id"]), [
    "shell",
    "content",
    "query",
    "--uri",
    "content://sms",
    "--projection",
    "_id"
  ]);
});

test("rejects an empty SMS projection", () => {
  assert.throws(() => buildSmsContentQueryArgs([]), /sms_content_projection_required/);
});
