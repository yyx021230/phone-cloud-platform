import assert from "node:assert/strict";
import test from "node:test";
import { galleryImportFileName, parseGalleryImportImage } from "./gallery-import.mjs";

test("parses a supported gallery import image without retaining its data URL", () => {
  const image = parseGalleryImportImage("data:image/png;base64,iVBORw0KGgo=");
  assert.equal(image.extension, "png");
  assert.equal(image.mime, "image/png");
  assert.equal(image.bytes.length, 8);
});

test("creates a safe task-scoped gallery filename", () => {
  assert.equal(galleryImportFileName("task/one", "jpg"), "import-task_one.jpg");
  assert.equal(galleryImportFileName("", "exe"), "import-image.png");
});
