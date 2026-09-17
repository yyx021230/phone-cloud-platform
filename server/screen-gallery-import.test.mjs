import assert from "node:assert/strict";
import test from "node:test";
import { canQueueScreenGalleryImport, publicScreenGalleryImportTask } from "./screen-gallery-import.mjs";

const activeSession = {
  sessionId: "screen-1",
  userId: "user-1",
  status: "streaming"
};

test("allows a screen gallery import only for the session owner while active", () => {
  assert.equal(canQueueScreenGalleryImport(activeSession, { userId: "user-1", role: "user" }), true);
  assert.equal(canQueueScreenGalleryImport(activeSession, { userId: "user-2", role: "user" }), false);
  assert.equal(canQueueScreenGalleryImport({ ...activeSession, status: "closed" }, { userId: "user-1", role: "user" }), false);
});

test("returns only safe gallery import task progress to the session client", () => {
  const task = publicScreenGalleryImportTask({
    taskId: "task-1",
    status: "succeeded",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:02.000Z",
    payload: { imageDataUrl: "data:image/png;base64,secret" },
    result: { message: "图片已导入手机图库", remotePath: "/sdcard/Pictures/PhoneCloud/import-task-1.png", localPath: "D:\\cache\\secret.png" }
  });

  assert.deepEqual(task, {
    taskId: "task-1",
    status: "succeeded",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:02.000Z",
    completedAt: "",
    result: { message: "图片已导入手机图库", remotePath: "/sdcard/Pictures/PhoneCloud/import-task-1.png" }
  });
});

test("one-shot gallery task delivery keeps a private copy for the executor", () => {
  const task = {
    taskId: "task-2",
    payload: { imageDataUrl: "data:image/png;base64,secret" },
    result: {}
  };
  const deliveredPayload = structuredClone(task.payload);
  delete task.payload.imageDataUrl;

  assert.equal(deliveredPayload.imageDataUrl, "data:image/png;base64,secret");
  assert.equal(task.payload.imageDataUrl, undefined);
});
