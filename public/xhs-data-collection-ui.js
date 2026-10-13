const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);
const metric = (value) => Number.isFinite(value) ? value.toLocaleString("zh-CN") : "—";

export function xhsDataTargetsForDevice(device) {
  return (device?.xhsAccounts || []).filter((account) => account.enabled !== false).map((account) => ({
    slot: account.appSlot, label: [account.label || (account.appSlot === "app2" ? "小红书 2" : "小红书 1"),
      account.accountName || "未绑定账号"].join(" · ")
  }));
}

export function xhsDataUnavailableReason(device) {
  if (!device || !device.adbOnline) return "请选择一台 ADB 在线的手机";
  if (device.busy) return "手机正在使用中，请等待当前任务结束";
  if (!device.xhsDataCollectionReady) return "Windows 管理器尚未启用数据采集，请联系管理员更新";
  if (!xhsDataTargetsForDevice(device).length) return "这台手机没有启用的小红书账号槽位";
  return "";
}

export function renderXhsDataResult(job) {
  const data = job?.result?.collection;
  if (!data) return `<div class="empty scan-empty-state">${escape(job?.result?.message || "采集完成后显示作品数据。")}</div>`;
  const notes = Array.isArray(data.notes) ? data.notes : [];
  const status = data.complete ? "范围完整" : "未确认完整";
  const total = data.totals || {};
  return `<div class="xhs-data-result-head"><strong>${escape(status)} · ${notes.length} 篇</strong>
    <span class="status-pill ${data.complete ? "ok" : "warn"}">${escape(status)}</span></div>
    <p class="hint">${escape(data.window_start_date)} — ${escape(data.window_end_date)} · ${escape(data.captured_at ? new Date(data.captured_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "")}</p>
    ${data.complete ? "" : '<p class="hint warn">尚未读到时间边界或列表末尾，以下是已采到的作品。</p>'}
    <div class="xhs-data-totals"><div><small>观看</small><strong>${metric(total.list_view_count)}</strong></div>
    <div><small>点赞</small><strong>${metric(total.list_like_count)}</strong></div><div><small>评论</small><strong>${metric(total.list_comment_count)}</strong></div></div>
    <div class="xhs-data-table-wrap"><table class="xhs-data-table"><thead><tr><th>作品 / 发布日期</th><th>观看</th><th>点赞</th><th>评论</th></tr></thead><tbody>
    ${notes.map((note) => `<tr><td><strong>${escape(note.title)}</strong><small>${escape(note.published_date)} · ${escape(note.status_raw || "状态未显示")}</small></td>
      <td>${metric(note.list_view_count)}</td><td>${metric(note.list_like_count)}</td><td>${metric(note.list_comment_count)}</td></tr>`).join("") || '<tr><td colspan="4">此日期范围没有作品</td></tr>'}
    </tbody></table></div>
    ${data.account_bound ? "" : '<p class="hint">该槽位尚未绑定账号，结果保存为本次采集快照。</p>'}
    <button type="button" class="ghost-button" data-xhs-data-export="${escape(job.jobId)}">下载 JSON</button>`;
}

export function renderXhsDataTask(job, selectedId) {
  const status = ({ queued: "排队中", running: "采集中", stalled: "等待管理器恢复", succeeded: "完成", failed: "失败", cancelled: "已取消", expired: "已过期" })[job.status] || job.status;
  return `<article class="scan-task-card ${job.jobId === selectedId ? "is-selected" : ""}"><div class="scan-task-head"><strong>${escape(job.xhsAccountLabel || job.xhsAppSlot)}</strong>
    <em class="${job.status === "succeeded" ? "ok" : job.status === "failed" ? "bad" : "warn"}">${escape(status)}</em></div>
    <p>${escape(job.result?.message || job.events?.at(-1)?.message || "等待 Windows 管理器领取")}</p>
    <small>${escape(job.createdAt ? new Date(job.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "")}</small>
    <div class="xhs-data-task-actions"><button type="button" class="ghost-button" data-xhs-data-view="${escape(job.jobId)}">查看结果</button>
    ${job.cancellable ? `<button type="button" class="ghost-button" data-xhs-data-cancel="${escape(job.jobId)}">取消采集</button>` : ""}</div></article>`;
}
