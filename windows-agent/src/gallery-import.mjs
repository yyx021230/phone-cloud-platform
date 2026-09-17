const IMAGE_TYPES = new Map([
  ["png", "image/png"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"]
]);

export function parseGalleryImportImage(dataUrl) {
  const match = String(dataUrl || "").match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) throw new Error("图库导入任务缺少有效图片");
  const sourceExtension = match[1].toLowerCase();
  const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (!bytes.length) throw new Error("图库导入图片为空");
  return {
    bytes,
    extension: sourceExtension === "jpeg" ? "jpg" : sourceExtension,
    mime: IMAGE_TYPES.get(sourceExtension) || ""
  };
}

export function galleryImportFileName(taskId, extension) {
  const safeTaskId = String(taskId || "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "image";
  const safeExtension = ["png", "jpg", "webp"].includes(String(extension || "")) ? extension : "png";
  return `import-${safeTaskId}.${safeExtension}`;
}
