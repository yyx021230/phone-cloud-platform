const apiRoot = "/api/v1/admin/xhs-daily-batches";
const timestamp = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const batchLabels = { completed: "已结束", running: "进行中", needs_attention: "待核对" };
const statusLabels = {
  succeeded: "成功", failed: "失败", skipped: "跳过", queued: "待派发",
  submitting: "派发中", running: "执行中", unknown: "结果待核对",
};
const reasons = {
  complete: "作品列表采集完成", confirmed_logged_out: "已确认未登录",
  collection_failed: "采集失败，未记录具体原因", task_details_unavailable: "原任务详情不可核对",
  element_loading_timeout: "界面元素加载超时", native_elements_unavailable: "未取得完整原生元素",
  device_command_timeout: "设备命令超时", account_identity_unproven: "账号身份未核实",
  adb_authorization: "ADB 授权未就绪", clone_missing: "未安装副 App", privacy_agreement: "等待处理首次使用协议",
  device_offline: "设备离线", device_not_listed: "库存中未找到设备",
  device_busy: "设备占用", device_busy_waiting: "等待设备空闲", device_busy_window_expired: "等待空闲超过派发窗口",
  dispatch_window_expired: "超过派发窗口", batch_stopped: "批次已停止派发",
  target_removed_from_allowlist: "已移出采集名单", binding_changed_or_missing: "账号绑定已变更或缺失",
  agent_update_required: "采集执行器未就绪", invalid_collection_result: "结果未通过校验",
  task_status_unavailable: "暂时无法读取原任务", job_identity_mismatch: "原任务与槽位不一致",
  submission_interrupted_no_replay: "派发中断，等待核对", submission_outcome_unknown_no_replay: "派发结果待核对",
  reconciled_existing_job: "已找回原任务", submission_recovered: "已找回原任务",
  cancelled: "原任务已取消", expired: "原任务已超时",
};
const slot = value => ({ app1: "主 App", app2: "副 App" }[value] || "槽位未记录");
const time = value => value && Number.isFinite(Date.parse(value)) ? timestamp.format(new Date(value)) : "—";

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value != null) node.textContent = value;
  if (className) node.className = className;
  return node;
}

export function mountXhsDailyAdmin(host) {
  host.innerHTML = `
    <div class="xhs-daily">
      <header class="xhs-daily-head">
        <div><span class="xhs-daily-kicker">小红书 · 定时采集</span><h2>批次运行日志</h2>
        <p>按北京时间查看每天定时批次的原始结果。</p></div>
        <button type="button" class="ghost-button" data-refresh>刷新记录</button>
      </header>
      <p class="xhs-daily-notice" role="status" aria-live="polite">正在读取批次…</p>
      <div class="xhs-daily-layout">
        <aside class="xhs-daily-rail" aria-label="定时批次">
          <h3>批次历史</h3><div data-batches></div>
          <div class="xhs-daily-paging"><button type="button" class="ghost-button" data-newer>较新</button><button type="button" class="ghost-button" data-older>较早</button></div>
        </aside>
        <section class="xhs-daily-detail" aria-label="批次明细" hidden>
          <div class="xhs-daily-detail-head"><div><h3 data-day></h3><p data-timing></p></div><span data-batch-status></span></div>
          <div class="xhs-daily-counts" data-counts></div>
          <div class="xhs-daily-filters">
            <label>结果 <select data-filter><option value="">全部</option><option value="succeeded">成功</option><option value="failed">失败</option><option value="confirmed_logged_out">已确认未登录</option><option value="skipped">跳过</option><option value="pending">未完成</option></select></label>
            <label>手机或账号 <input data-search type="search" placeholder="例如 157 或账号名称"></label>
          </div>
          <div class="xhs-daily-table-wrap" tabindex="0" aria-label="槽位结果表">
            <table class="xhs-daily-table"><thead><tr><th scope="col">手机 / 槽位</th><th scope="col">账号</th><th scope="col">结果</th><th scope="col">原因</th><th scope="col">结束时间</th></tr></thead><tbody></tbody></table>
          </div>
          <p class="xhs-daily-foot" data-row-count></p>
        </section>
      </div>
    </div>`;
  const $ = selector => host.querySelector(selector);
  const notice = $(".xhs-daily-notice");
  const detail = $(".xhs-daily-detail");
  const filter = $("[data-filter]");
  const search = $("[data-search]");
  const newer = $("[data-newer]");
  const older = $("[data-older]");
  let offset = 0, nextOffset = null, batches = [], batch = null, selected = null;
  let pending, disposed = false;

  async function get(path, signal) {
    const token = localStorage.getItem("phoneCloudSessionToken") || "";
    const response = await fetch(apiRoot + path, {
      headers: { Authorization: "Bearer " + token }, cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
    });
    if (!response.ok) throw Object.assign(new Error("读取失败"), { status: response.status });
    return response.json();
  }

  function renderHistory() {
    const list = $("[data-batches]");
    list.replaceChildren(...batches.map(run => {
      const button = element("button", null, "xhs-daily-run");
      button.type = "button";
      button.setAttribute("aria-pressed", String(run.runId === selected));
      button.append(element("strong", run.day), element("span", batchLabels[run.status] || "待核对"),
        element("small", `成功 ${run.counts.succeeded} · 失败 ${run.counts.failed} · 跳过 ${run.counts.skipped}`));
      button.onclick = () => loadDetail(run.runId);
      return button;
    }));
    if (!batches.length) list.append(element("p", "暂无批次记录", "xhs-daily-foot"));
    newer.disabled = offset === 0;
    older.disabled = nextOffset == null;
  }

  function renderRows() {
    if (!batch) return;
    const key = filter.value;
    const needle = search.value.trim().toLocaleLowerCase();
    const rows = batch.items.filter(item => {
      const matches = !key || key === item.status || key === item.reason
        || (key === "pending" && !["succeeded", "failed", "skipped"].includes(item.status));
      return matches && (!needle || `${item.deviceName ?? ""} ${item.accountName ?? ""}`.toLocaleLowerCase().includes(needle));
    });
    $("tbody").replaceChildren(...rows.map(item => {
      const row = element("tr");
      const phone = element("td");
      phone.append(element("strong", item.deviceName ? `${item.deviceName} 号` : "未记录"), element("small", slot(item.appSlot)));
      const status = element("td");
      status.append(element("span", statusLabels[item.status] || "待核对", `xhs-daily-pill ${item.status}`));
      const reason = element("td", reasons[item.reason] || "—");
      if (item.deferredAttempts) reason.append(element("small", `曾等待设备 ${item.deferredAttempts} 次`));
      row.append(phone, element("td", item.accountName || "未记录"), status, reason, element("td", time(item.completedAt)));
      return row;
    }));
    $("[data-row-count]").textContent = rows.length ? `显示 ${rows.length} / ${batch.counts.total} 个槽位` : "没有符合条件的槽位";
  }

  function renderDetail() {
    detail.hidden = !batch;
    if (!batch) return;
    $("[data-day]").textContent = `${batch.day} 定时批次`;
    $("[data-timing]").textContent = `计划 ${time(batch.scheduledAt)} · 结束 ${time(batch.completedAt)}`;
    const state = $("[data-batch-status]");
    state.textContent = batchLabels[batch.status] || "待核对";
    state.className = `xhs-daily-pill ${batch.status === "completed" ? "succeeded" : "running"}`;
    const loggedOut = batch.items.filter(item => item.reason === "confirmed_logged_out").length;
    $("[data-counts]").replaceChildren(...[
      ["目标", batch.counts.total], ["成功", batch.counts.succeeded], ["失败", batch.counts.failed],
      ["跳过", batch.counts.skipped], ["未完成", batch.counts.pending], ["已确认未登录 · 计入失败", loggedOut],
    ].map(([label, count]) => {
      const box = element("div");
      box.append(element("span", label), element("strong", count));
      return box;
    }));
    renderRows();
  }

  async function load({ page = offset, id = selected, refreshHistory = false } = {}) {
    if (disposed) return;
    pending?.abort();
    const request = new AbortController();
    pending = request;
    notice.textContent = "正在读取…";
    try {
      if (refreshHistory) {
        const history = await get(`?offset=${page}`, request.signal);
        if (request.signal.aborted) return;
        offset = page;
        batches = history.batches;
        nextOffset = history.nextOffset;
        id = batches.some(run => run.runId === id) ? id : batches[0]?.runId;
      }
      if (selected !== id) {
        batch = null;
        renderDetail();
      }
      selected = id;
      renderHistory();
      const result = id ? await get("/" + encodeURIComponent(id), request.signal) : null;
      if (request.signal.aborted) return;
      batch = result?.batch ?? null;
      renderDetail();
      notice.textContent = batch ? "显示定时批次记录。手工补测结果单独保存。" : "当前没有可查看的定时批次。";
    } catch (error) {
      if (request.signal.aborted) return;
      if (error.status === 401 || error.status === 403) {
        batches = [];
        batch = null;
        renderHistory();
        renderDetail();
      }
      notice.textContent = error.status === 401 || error.status === 403 ? "请使用管理员账号登录。"
        : error.status === 503 ? "批次记录库暂不可用。" : "读取失败，请点击刷新记录重试。";
    }
  }

  const loadDetail = id => load({ id });
  newer.onclick = () => load({ page: Math.max(0, offset - 20), refreshHistory: true });
  older.onclick = () => { if (nextOffset != null) load({ page: nextOffset, refreshHistory: true }); };
  $("[data-refresh]").onclick = () => load({ refreshHistory: true });
  filter.onchange = renderRows;
  search.oninput = renderRows;
  load({ refreshHistory: true });
  return () => {
    disposed = true;
    pending?.abort();
    host.replaceChildren();
  };
}
