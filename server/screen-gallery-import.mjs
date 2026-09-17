const ACTIVE_SCREEN_SESSION_STATUSES = new Set(["connecting", "ready", "streaming"]);

export function canQueueScreenGalleryImport(session, ctx) {
  return Boolean(
    session
    && ctx
    && ACTIVE_SCREEN_SESSION_STATUSES.has(String(session.status || ""))
    && String(session.userId || "") === String(ctx.userId || "")
  );
}

export function publicScreenGalleryImportTask(task) {
  const result = task?.result && typeof task.result === "object" ? task.result : {};
  return {
    taskId: String(task?.taskId || ""),
    status: String(task?.status || "queued"),
    createdAt: String(task?.createdAt || ""),
    updatedAt: String(task?.updatedAt || ""),
    completedAt: String(task?.completedAt || ""),
    result: {
      message: String(result.message || result.error || ""),
      remotePath: String(result.remotePath || "")
    }
  };
}
