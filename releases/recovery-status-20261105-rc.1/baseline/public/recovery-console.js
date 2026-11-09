function recoveryRequestKey(agentId, serial) {
  return JSON.stringify([String(agentId), String(serial).toUpperCase()]);
}

function recoveryControlFeedback(item) {
  const request = item.recoveryRequest;
  if (!request) {
    if (item.agentOnline && item.recoveryIsolated && item.recoveryReleaseRevision > 0 && !item.recoveryControlPending && !item.recoveryIsolationError) {
      return { tone: "warning", label: "当前仍处于隔离", next: "解除请求已送达；设备仍有故障，请查看下方原因", pending: false };
    }
    return null;
  }
  if (request.phase === "sending") return { tone: "active", label: "正在提交", next: "正在提交此手机的恢复设置", pending: true };
  if (request.phase === "unconfirmed") return { tone: "warning", label: "提交结果未确认", next: request.error || "请刷新核对当前状态后再重试", pending: false };
  if (!item.agentOnline) return { tone: "warning", label: "等待管理器上线", next: "请求已保存，管理器上线后接收", pending: true };
  if (!item.recoveryControlSynced || !Number.isSafeInteger(item.recoveryAckRevision) || item.recoveryAckRevision < request.revision) {
    return { tone: "active", label: "请求已提交", next: "等待管理器确认执行", pending: true };
  }
  if (item.recoveryControlRevision > request.revision && item.recoveryAckRevision < item.recoveryControlRevision) {
    return { tone: "active", label: "新设置等待确认", next: "恢复设置已再次更新，等待管理器同步最新设置", pending: true };
  }
  if (item.recoveryIsolationError) return { tone: "danger", label: "恢复记录异常", next: "管理器未能读写恢复记录，解除尚未完成", pending: false };
  if (request.kind === "release") {
    if (!item.recoveryIsolated && item.recoveryPaused) return { tone: "warning", label: "隔离已解除，恢复仍暂停", next: "当前设置已更新；此手机仍保持暂停", pending: false };
    if (!item.recoveryIsolated) return { tone: "active", label: "隔离已解除", next: "已继续自动恢复；设备是否上线以当前断点为准", pending: false };
    if (Date.parse(item.recoveryIsolated.isolatedAt) > Date.parse(request.previousIsolationAt)) {
      return { tone: "warning", label: "恢复后再次隔离", next: "已尝试恢复，但故障仍在；请查看下方原因", pending: false };
    }
    return Date.now() - request.startedAt > 90_000
      ? { tone: "warning", label: "解除尚未确认", next: "管理器已接收，但隔离状态尚未更新，请核对后重试", pending: false }
      : { tone: "active", label: "解除结果待确认", next: "管理器已接收，等待隔离状态更新", pending: true };
  }
  if ((request.kind === "pause") !== Boolean(item.recoveryPaused)) return { tone: "warning", label: "恢复设置已更新", next: item.recoveryPaused ? "当前此手机已暂停自动恢复" : "当前此手机已继续自动恢复", pending: false };
  return { tone: "active", label: request.kind === "pause" ? "自动恢复已暂停" : "已继续自动恢复", next: "管理器已确认此手机的设置", pending: false };
}

async function submitRecoveryControl(toggle) {
  const { agentId, recoveryToggle: serial } = toggle.dataset;
  const requests = state.windowsRecoveryRequests ||= new Map();
  const key = recoveryRequestKey(agentId, serial);
  const agent = state.agents.find(value => value.agentId === agentId);
  if (!agent) return;
  const old = requests.get(key);
  const health = agent.health?.recoveryControl || {};
  const isolated = (health.isolated || []).find(value => value.serial === String(serial).toUpperCase());
  const item = { agentOnline: isOnline(agent.lastSeenAt), recoveryRequest: old, recoveryIsolated: isolated,
    recoveryControlSynced: health.synced === true, recoveryAckRevision: health.revision,
    recoveryControlRevision: agent.recoveryControl?.revision, recoveryIsolationError: health.isolationError };
  if (old && recoveryControlFeedback(item)?.pending) return;
  const reset = toggle.dataset.resetIsolation === "true";
  const paused = toggle.dataset.paused === "true";
  const request = { kind: reset ? "release" : paused ? "pause" : "resume", phase: "sending",
    startedAt: Date.now(), previousIsolationAt: isolated?.isolatedAt || "", revision: null };
  requests.set(key, request);
  renderWindowsRecoveryConsole();
  try {
    const payload = await api(`/api/v1/windows-agents/${encodeURIComponent(agentId)}/recovery-control`, {
      method: "POST", body: JSON.stringify({ adbSerial: serial, paused, resetIsolation: reset, expectedRevision: Number(toggle.dataset.revision) })
    });
    if (!Number.isSafeInteger(payload.control?.revision) || payload.control.revision < Number(toggle.dataset.revision)) throw new Error("恢复设置回执不完整，请刷新核对");
    request.phase = "accepted";
    request.revision = payload.control.revision;
  } catch (error) {
    request.phase = "unconfirmed";
    request.error = error.message === "recovery_control_revision_conflict"
      ? "页面状态已更新，请刷新核对后重试" : "请求结果未确认，请刷新核对；系统不会自动重复提交";
  }
  await loadAll().catch(() => {});
  renderWindowsRecoveryConsole();
}

function renderWindowsRecoveryConsole() {
  if (!els.windowsRecoveryConsole) return;
  const telemetryAgents = state.agents.map((agent) => ({
    agent,
    recovery: agent.health?.deviceRecovery || {},
    online: isOnline(agent.lastSeenAt)
  })).filter(({ recovery, online }) => online || recovery.observedAt || recovery.inventoryObservedAt);
  const queue = telemetryAgents.flatMap(({ agent, recovery, online }) => {
    const desired = agent.recoveryControl || {revision:0,paused:[]};
    const rows = [...(recovery.queue || [])];
    for (const hold of [...(desired.paused || []), ...(agent.health?.recoveryControl?.isolated || [])]) {
      if (!rows.some(item => String(item.serial).toUpperCase() === hold.serial)) {
        const device = state.devices.find(d => d.adb?.agentId === agent.agentId && String(d.adb?.serial || "").toUpperCase() === hold.serial);
        rows.push({serial:hold.serial,deviceName:device?.deviceName || hold.serial,state:device?.recovery?.state || "unknown"});
      }
    }
    return rows.map((item) => ({
    recoveryIsolated: (agent.health?.recoveryControl?.isolated || []).find(x=>x.serial===String(item.serial).toUpperCase()),
    recoveryIsolationReset: agent.health?.recoveryControl?.isolationReset===true,
    recoveryPaused: (desired.paused || []).some(x => x.serial === String(item.serial).toUpperCase()),
    recoveryControlPending: agent.health?.recoveryControl?.synced !== true || agent.health?.recoveryControl?.revision !== desired.revision,
    recoveryControlSupported: agent.health?.recoveryControl?.protocol === "device_recovery_control_v1",
    recoveryControlRevision: desired.revision,
    recoveryControlSynced: agent.health?.recoveryControl?.synced === true,
    recoveryAckRevision: Number(agent.health?.recoveryControl?.revision ?? -1),
    recoveryIsolationError: agent.health?.recoveryControl?.isolationError || "",
    recoveryReleaseRevision: (desired.releases || []).find(value => value.serial === String(item.serial).toUpperCase())?.revision || 0,
    recoveryRequest: state.windowsRecoveryRequests?.get(recoveryRequestKey(agent.agentId, item.serial)),
    ...item,
    agentId: agent.agentId,
    agentName: agent.agentName || agent.agentId,
    agentOnline: online,
    agentCircuitOpen: Boolean(recovery.circuitOpen),
    agentBlockedReason: String(recovery.blockedReason || ""),
    agentRecoveryMode: String(recovery.recoveryMode || "normal"),
    agentRescue: Boolean(recovery.rescueCanMutate)
      && (recovery.rescueSerials || []).some((serial) => String(serial).toUpperCase() === String(item.serial || "").toUpperCase()),
    nextActionAt: item.nextActionAt || recovery.actionReadyAt || (recovery.circuitOpen ? recovery.circuitUntil : "")
  }));
  });
  const events = telemetryAgents.flatMap(({ agent, recovery }) => (recovery.recentEvents || []).map((event) => ({
    ...event,
    agentId: agent.agentId,
    agentName: agent.agentName || agent.agentId
  }))).sort((left, right) => new Date(right.at || 0).getTime() - new Date(left.at || 0).getTime()).slice(0, 40);
  const observed = telemetryAgents.filter(({ recovery }) => recovery.observedAt || recovery.inventoryObservedAt);
  const circuitAgents = telemetryAgents.filter(({ recovery }) => recovery.circuitOpen);
  const rescueCount = telemetryAgents.reduce((sum, { recovery }) => sum + (recovery.rescueCanMutate ? Number((recovery.rescueSerials || []).length) : 0), 0);
  const activeCount = queue.filter((item) => item.inProgress).length;
  const unauthorizedCount = queue.filter((item) => item.state === "adb_unauthorized").length;
  const physicalCount = telemetryAgents.reduce((sum, { recovery }) => sum + Number(recovery.physicalCount || 0), 0);
  const adbCount = telemetryAgents.reduce((sum, { recovery }) => sum + Number(recovery.adbDeviceCount || 0), 0);
  const actionsUsed = telemetryAgents.reduce((sum, { recovery }) => sum + Number(recovery.automaticActionsLastHour || 0), 0);
  const isolationError = telemetryAgents.some(({agent})=>agent.health?.recoveryControl?.isolationError);
  const status = isolationError
    ? {tone:"danger",label:"恢复记录异常",detail:"自动恢复已暂停；在线检测继续，请检查隔离记录"}
    : !observed.length
    ? { tone: "idle", label: "等待恢复遥测", detail: "Windows 管理器尚未上报逐设备恢复状态" }
    : rescueCount
      ? { tone: "active", label: `${rescueCount} 台连带设备精确救援`, detail: "普通队列保持熔断，仅逐台救回本轮恢复造成的批外掉线设备" }
    : circuitAgents.length
      ? { tone: "danger", label: "保护熔断", detail: circuitAgents.map(({ agent, recovery }) => `${agent.agentName || agent.agentId}：${recoveryBlockReason(recovery)}`).join("；") }
      : activeCount
        ? { tone: "active", label: `${activeCount} 台正在恢复`, detail: "动作执行后会先验证 ADB，再决定是否进入下一次重试" }
        : telemetryAgents.some(({ recovery }) => recovery.recoveryMode === "continuous_recovery")
          ? { tone: "active", label: "异常设备持续恢复", detail: "连续失败或动作链耗尽的手机单独隔离，其他手机继续检测与恢复" }
        : telemetryAgents.some(({ recovery }) => recovery.recoveryMode === "degraded_recovery")
          ? { tone: "active", label: "残余队列并发恢复", detail: "批量异常已稳定，正在按每批最多 8 台执行精确恢复" }
        : queue.length
          ? { tone: "warning", label: `${queue.length} 台待恢复`, detail: recoveryBlockSummary(telemetryAgents) }
          : { tone: "healthy", label: "恢复链路稳定", detail: "当前没有物理在线但 ADB 异常的手机" };
  const filter = ["all", "active", "waiting", "manual"].includes(state.windowsRecoveryFilter) ? state.windowsRecoveryFilter : "all";
  const filteredQueue = queue.filter((item) => recoveryQueueMatchesFilter(item, filter));
  const filterCounts = {
    all: queue.length,
    active: queue.filter((item) => item.inProgress).length,
    waiting: queue.filter((item) => recoveryQueueMatchesFilter(item, "waiting")).length,
    manual: queue.filter((item) => recoveryQueueMatchesFilter(item, "manual")).length
  };
  const latestObservedAt = observed.map(({ recovery }) => recovery.observedAt || recovery.inventoryObservedAt).sort().at(-1) || "";

  els.windowsRecoveryConsole.innerHTML = `
    <section class="recovery-console" aria-label="USB 和 ADB 自动恢复控制台">
      <header class="recovery-console-head">
        <div>
          <span class="recovery-eyebrow">RECOVERY / LIVE</span>
          <h3>USB · ADB 恢复控制台</h3>
          <p>把每台手机从物理枚举、ADB 子接口到平台上线的恢复过程完整展开。</p>
        </div>
        <div class="recovery-global-status is-${status.tone}">
          <i aria-hidden="true"></i>
          <div><strong>${escapeHtml(status.label)}</strong><span>${escapeHtml(status.detail)}</span></div>
        </div>
      </header>

      <div class="recovery-kpi-grid">
        ${recoveryKpi("物理 USB", physicalCount, observed.length ? "Windows 已枚举" : "等待采样", "usb")}
        ${recoveryKpi("ADB 在线", adbCount, physicalCount ? `${Math.round(adbCount / physicalCount * 100)}% 可达` : "暂无样本", "adb")}
        ${recoveryKpi("恢复队列", queue.length, activeCount ? `${activeCount} 台执行中` : "当前等待", "queue")}
        ${recoveryKpi("需授权", unauthorizedCount, `${unauthorizedCount} 台等待手机确认 USB 调试`, "manual")}
        ${recoveryKpi("小时动作", actionsUsed, "只统计动作，不再作为停止条件", "budget")}
      </div>

      <div class="recovery-agent-rail">
        ${telemetryAgents.length ? telemetryAgents.map(({ agent, recovery, online }) => `
          <div class="recovery-agent-node ${online ? "is-online" : "is-offline"} ${recovery.circuitOpen ? "is-circuit" : ""}">
            <i aria-hidden="true"></i>
            <div>
              <strong>${escapeHtml(agent.agentName || agent.agentId)}</strong>
              <span>${online ? recoveryAgentSummary(recovery) : "管理器离线，遥测已停止"}</span>
            </div>
            <time>${escapeHtml(shortTime(recovery.observedAt || agent.lastSeenAt))}</time>
          </div>
        `).join("") : `<div class="recovery-empty-inline">还没有 Windows 管理器上线。</div>`}
      </div>

      <div class="recovery-workspace">
        <section class="recovery-queue-panel">
          <div class="recovery-panel-head">
            <div><span>DEVICE QUEUE</span><h4>逐设备恢复队列</h4></div>
            <small>采样 ${escapeHtml(shortTime(latestObservedAt))}</small>
          </div>
          <div class="recovery-filter-bar" role="group" aria-label="恢复队列筛选">
            ${recoveryFilterButton("all", "全部", filterCounts.all, filter)}
            ${recoveryFilterButton("active", "执行中", filterCounts.active, filter)}
            ${recoveryFilterButton("waiting", "等待重试", filterCounts.waiting, filter)}
            ${recoveryFilterButton("manual", "需人工", filterCounts.manual, filter)}
          </div>
          <div class="recovery-queue-list">
            ${filteredQueue.length ? filteredQueue.map(renderRecoveryQueueRow).join("") : renderRecoveryEmpty(queue.length, filter)}
          </div>
        </section>

        <aside class="recovery-flight-recorder">
          <div class="recovery-panel-head">
            <div><span>FLIGHT RECORDER</span><h4>恢复事件记录</h4></div>
            <small>最近 ${events.length} 条</small>
          </div>
          <div class="recovery-event-list">
            ${events.length ? events.map((event) => renderRecoveryEvent(event, queue)).join("") : `<div class="recovery-empty"><strong>暂无恢复事件</strong><span>异常识别、动作、验证和熔断都会按时间记录在这里。</span></div>`}
          </div>
        </aside>
      </div>
      <footer class="recovery-legend">
        <span><i class="is-auto"></i>自动处理：精确 ADB reconnect / 单设备 PnP 重启</span>
        <span><i class="is-wait"></i>安全等待：任务占用、Windows 安装器或退避冷却</span>
        <span><i class="is-manual"></i>人工处理：USB 未授权、物理拔出或 5 次状态化动作预算用尽</span>
      </footer>
    </section>
  `;
}

function recoveryKpi(label, value, detail, tone) {
  return `<div class="recovery-kpi is-${tone}"><span>${escapeHtml(label)}</span><strong>${Number(value || 0)}</strong><small>${escapeHtml(detail)}</small></div>`;
}

function recoveryFilterButton(value, label, count, selected) {
  return `<button class="${selected === value ? "active" : ""}" data-recovery-filter="${value}" type="button"><span>${escapeHtml(label)}</span><strong>${Number(count || 0)}</strong></button>`;
}

function recoveryQueueMatchesFilter(item, filter) {
  if (filter === "active") return Boolean(item.inProgress);
  if (filter === "manual" && (item.recoveryPaused || item.recoveryIsolated)) return true;
  if (filter === "manual") return Boolean(item.quarantined || item.state === "adb_unauthorized" || item.state === "physically_absent");
  if (filter === "waiting") return !item.inProgress && !recoveryQueueMatchesFilter(item, "manual");
  return true;
}

function renderRecoveryQueueRow(item) {
  const status = recoveryDeviceStatus(item);
  const feedback = recoveryControlFeedback(item);
  const stateLabel = recoveryStateLabel(item.state);
  const attempts = Math.max(0, Number(item.attempts || 0));
  const maxAttempts = Math.max(1, Number(item.maxAttempts || 5));
  const isolationReason=item.recoveryIsolated ? (item.recoveryIsolated.reason === "recovery_attempts_exhausted" ? "恢复动作链已耗尽，等待管理员解除" : `连续恢复失败 ${Number(item.recoveryIsolated.failures || 0)} 次，等待管理员解除`) : "";
  const evidence = [isolationReason,item.lastError, item.rootProblem && `USB ${item.rootProblem}`, item.adbInterfaceProblem && `ADB ${item.adbInterfaceProblem}`].filter(Boolean).join(" · ");
  return `
    <article class="recovery-device-row is-${status.tone}">
      <div class="recovery-device-identity">
        <span class="recovery-device-number">${escapeHtml(recoveryDeviceNumber(item.deviceName))}</span>
        <div><strong>${escapeHtml(item.deviceName || item.serial)}</strong><code>${escapeHtml(item.serial)}</code></div>
      </div>
      <div class="recovery-breakpoint">
        <span>当前断点</span>
        <strong>${escapeHtml(stateLabel)}</strong>
        <small>${escapeHtml(item.agentName || item.agentId || "-")}</small>
      </div>
      <div class="recovery-attempts">
        <div><span>自动尝试</span><strong>${attempts} / ${maxAttempts}</strong></div>
        <div class="recovery-attempt-rail" aria-label="已执行 ${attempts} 次，共最多 ${maxAttempts} 次">
          ${Array.from({ length: maxAttempts }, (_, index) => `<i class="${recoveryAttemptClass(index, attempts, item)}"></i>`).join("")}
        </div>
        <small>${escapeHtml(recoveryModeLabel(item.mode, item.targetType))}</small>
      </div>
      <div class="recovery-next-action">
        <em class="is-${status.tone}">${escapeHtml(status.label)}</em>
        ${item.nextActionAt && !item.quarantined && !item.recoveryPaused && !item.recoveryIsolated && !item.recoveryControlPending ? `<strong data-recovery-countdown="${escapeHtml(item.nextActionAt)}">${escapeHtml(formatRecoveryCountdown(item.nextActionAt))}</strong>` : `<strong>${escapeHtml(status.next)}</strong>`}
        <small>${escapeHtml(item.lastAttemptAt ? `上次动作 ${shortTime(item.lastAttemptAt)}` : "尚未执行恢复动作")}</small>
      </div>
      <div class="recovery-evidence">
        <button class="ghost-button" type="button" data-recovery-toggle="${escapeHtml(item.serial)}" data-agent-id="${escapeHtml(item.agentId)}" data-revision="${Number(item.recoveryControlRevision || 0)}" data-reset-isolation="${Boolean(item.recoveryIsolated)}" data-paused="${item.recoveryPaused || item.recoveryIsolated ? "false" : "true"}" ${item.recoveryControlSupported && (!item.recoveryIsolated || item.recoveryIsolationReset) && !feedback?.pending ? "" : "disabled"}>
          ${feedback?.pending ? "处理中…" : item.recoveryIsolated ? "解除隔离并继续" : item.recoveryPaused ? "继续自动恢复" : "暂停自动恢复"}
        </button>
        <small role="status" aria-live="polite">${escapeHtml(feedback?.next || (!item.recoveryControlSupported ? "管理器升级后可用" : !item.agentOnline || item.recoveryControlPending ? "设置等待管理器确认" : item.recoveryPaused ? "已暂停新恢复动作；已启动的驱动安装仍需收尾" : "只控制此手机的自动恢复，保留在线检测"))}</small>
      </div>
      ${evidence ? `<p class="recovery-evidence" title="${escapeHtml(evidence)}">证据：${escapeHtml(evidence)}</p>` : ""}
    </article>
  `;
}

function recoveryDeviceNumber(name) {
  const match = String(name || "").match(/\d+/);
  return match ? match[0].padStart(2, "0") : "--";
}

function recoveryAttemptClass(index, attempts, item) {
  if (item.inProgress && index === Math.max(0, attempts - 1)) return "is-active";
  if (index < attempts) return item.quarantined && index === attempts - 1 ? "is-failed" : "is-done";
  if (!item.quarantined && index === attempts) return "is-next";
  return "";
}

function recoveryDeviceStatus(item) {
  const feedback = recoveryControlFeedback(item);
  if (feedback) return feedback;
  if (item.recoveryIsolated) return {tone:"warning",label:"自动恢复已隔离",next:"需管理员解除；在线检测继续"};
  if (item.recoveryPaused) return {tone:"warning",label:!item.agentOnline || item.recoveryControlPending ? "暂停待确认" : "自动恢复已暂停",next:item.inProgress ? "已有动作正在收尾" : "在线检测继续"};
  if (!item.agentOnline) return { tone: "danger", label: "主机离线", next: "等待管理器恢复" };
  if (item.inProgress) return { tone: "active", label: "正在执行", next: "动作进行中" };
  if (item.mode === "recovery_cycle_cooldown") return { tone: "warning", label: "轮次冷却", next: "冷却结束后自动开始下一轮" };
  if (item.quarantined) return { tone: "danger", label: "已隔离", next: "等待人工诊断" };
  if (item.state === "adb_unauthorized") return { tone: "manual", label: "待授权", next: "请在手机确认 USB 调试" };
  if (item.state === "physically_absent") return { tone: "muted", label: "物理缺席", next: "等待重新插入" };
  if (item.state === "inventory_unavailable") return { tone: "danger", label: "清单不可用", next: "等待 Windows 采样恢复" };
  if (item.agentCircuitOpen && item.agentRescue) return { tone: "active", label: "熔断救援", next: "仅恢复该连带设备" };
  if (item.agentCircuitOpen) return { tone: "muted", label: "熔断观察", next: "稳定窗口后单台探测" };
  if (item.agentBlockedReason === "host_busy") return { tone: "muted", label: "任务避让", next: "等待前台自动化结束" };
  if (item.agentBlockedReason === "device_install_busy") return { tone: "muted", label: "安装器忙", next: "等待 Windows 安装器空闲" };
  if (item.agentBlockedReason === "hourly_budget_exhausted") return { tone: "muted", label: "预算已满", next: "等待小时预算释放" };
  if (item.agentBlockedReason === "action_cooldown") return { tone: "warning", label: "主机冷却", next: "等待下一台安全窗口" };
  if (item.agentBlockedReason === "post_action_stability_window") return { tone: "warning", label: "连带观察", next: "确认其他在线手机保持稳定" };
  return { tone: "warning", label: item.attempts ? "冷却验证" : "等待处理", next: "等待下次扫描" };
}

function recoveryStateLabel(value) {
  return ({
    inventory_unavailable: "物理 USB 清单不可用",
    physically_absent: "Windows 未枚举到手机",
    usb_present_mtp_only: "仅有 MTP / 文件传输",
    usb_composite_no_adb_interface: "ADB USB 子接口未暴露",
    usb_root_pnp_error: "USB Composite 设备异常",
    adb_interface_pnp_error: "Android ADB 驱动异常",
    adb_interface_ready_transport_missing: "ADB 接口正常，transport 缺失",
    adb_unauthorized: "ADB 未授权",
    adb_offline: "ADB transport 离线",
    adb_device: "ADB 已在线"
  })[value] || value || "状态未知";
}

function recoveryModeLabel(mode, targetType) {
  if (mode === "adb_reconnect") return "动作：仅重连 ADB transport";
  if (mode === "restart_adb_interface") return "动作：精确重启 ADB / WinUSB 接口";
  if (mode === "recreate_adb_interface") return "动作：重建 ADB 子接口并扫描手机根节点";
  if (mode === "recreate_adb_root") return "动作：重建单手机 ADB 根节点并扫描精确上游";
  if (mode === "cycle_usb_port") return "动作：循环该手机的精确 USB 下游端口";
  if (mode === "recreate_usb_composite") return "动作：重建单手机 USB Composite 子树";
  if (mode === "restart") return `动作：精确重启${targetType === "adb_interface" ? " ADB 接口" : "单个 USB 设备"}`;
  if (mode === "no_exact_target") return "只读复查：尚未找到安全目标";
  if (mode === "recovery_cycle_cooldown") return "动作链已跑完，冷却后自动开始下一轮";
  if (mode === "quarantine") return "自动动作已停止，仍持续观察";
  return "策略：异常设备持续恢复，轮次之间固定冷却";
}

function formatRecoveryCountdown(value) {
  const remaining = new Date(value || 0).getTime() - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return "等待本轮扫描";
  const seconds = Math.ceil(remaining / 1000);
  if (seconds < 60) return `${seconds} 秒后复查`;
  return `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, "0")}秒后复查`;
}

function updateRecoveryCountdowns() {
  document.querySelectorAll("[data-recovery-countdown]").forEach((node) => {
    node.textContent = formatRecoveryCountdown(node.dataset.recoveryCountdown);
  });
}

function recoveryBlockReason(recovery = {}) {
  return ({
    circuit_mass_outage: "多设备异常，保护熔断中",
    circuit_burst_outage: "设备突发掉线，保护熔断中",
    circuit_pnp_timeout: "PnP 动作超时，保护熔断中",
    host_busy: "前台自动化任务正在执行，暂缓 PnP",
    device_install_busy: "Windows 设备安装器忙，等待下一并发批次",
    hourly_budget_exhausted: "小时动作预算已用尽",
    action_cooldown: "上一台动作后处于主机冷却期",
    post_action_stability_window: "PnP 动作后正在观察延迟连带掉线",
    physical_inventory_unavailable: "物理 USB 清单不可用",
    not_observed: "等待第一次物理 USB 采样"
  })[recovery.blockedReason] || (recovery.blockedReason ? recovery.blockedReason : "可执行自动恢复");
}

function recoveryBlockSummary(agents) {
  const blocked = agents.map(({ recovery }) => recoveryBlockReason(recovery)).filter((value) => value !== "可执行自动恢复");
  return blocked[0] || "按每台手机的退避时间依次恢复";
}

function recoveryAgentSummary(recovery = {}) {
  if (!recovery.observedAt && !recovery.inventoryObservedAt) return "等待逐设备恢复遥测";
  if (recovery.circuitOpen && recovery.rescueCanMutate) return `保护熔断中 · ${(recovery.rescueSerials || []).length} 台连带设备单台救援`;
  if (recovery.circuitOpen) return recoveryBlockReason(recovery);
  const queueCount = Array.isArray(recovery.queue) ? recovery.queue.length : Number(recovery.actionableCount || 0) + Number(recovery.unauthorizedCount || 0);
  if (recovery.recoveryMode === "continuous_recovery") return `${queueCount} 台在持续恢复 · 轮次冷却后自动重试`;
  if (recovery.recoveryMode === "degraded_recovery") return `${queueCount} 台残余异常 · 最多 8 台并发恢复中`;
  return queueCount ? `${queueCount} 台在恢复视野 · ${recoveryBlockReason(recovery)}` : `${Number(recovery.adbDeviceCount || 0)} 台 ADB 正常`;
}

function renderRecoveryEvent(event, queue) {
  const match = queue.find((item) => String(item.serial).toUpperCase() === String(event.serial || "").toUpperCase());
  const title = recoveryEventLabel(event);
  const detail = recoveryEventDetail(event);
  return `
    <article class="recovery-event is-${escapeHtml(event.severity || "info")}">
      <i aria-hidden="true"></i>
      <div>
        <time>${escapeHtml(shortTime(event.at))}</time>
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(match?.deviceName || event.serial || event.agentName || "Windows 恢复器")}${detail ? ` · ${escapeHtml(detail)}` : ""}</span>
      </div>
    </article>
  `;
}

function recoveryEventLabel(event) {
  return ({
    detected: "发现链路异常",
    state_changed: "链路断点发生变化",
    recovered: "ADB 已验证恢复",
    action_started: `开始第 ${Number(event.attempt || 0)} 次自动恢复`,
    action_completed: "恢复动作完成，等待验证",
    action_failed: "恢复动作失败",
    cooldown_started: "本轮动作完成，进入冷却",
    deferred: "恢复动作安全暂缓",
    quarantined: Number(event.attempt || 0) >= Math.max(1, Number(event.maxAttempts || 5))
      ? `${Math.max(1, Number(event.maxAttempts || 5))} 次自动恢复已用尽`
      : Number(event.attempt || 0) > 0
        ? `第 ${Number(event.attempt)} 次后已无安全动作`
        : "当前状态无安全动作",
    rescue_started: "熔断连带设备救援已开始",
    post_action_watch_started: "PnP 动作进入连带观察期",
    circuit_opened: "主机保护熔断已打开",
    circuit_closed: "主机保护熔断已解除"
  })[event.type] || event.type || "恢复状态更新";
}

function recoveryEventDetail(event) {
  if (event.type === "state_changed") return `${recoveryStateLabel(event.previousState)} → ${recoveryStateLabel(event.state)}`;
  if (event.type === "recovered") return recoveryStateLabel(event.state);
  return event.result || recoveryReasonLabel(event.reason) || recoveryModeLabel(event.mode, event.targetType);
}

function recoveryReasonLabel(value) {
  return ({
    target_busy: "该手机正在执行任务",
    device_install_busy: "Windows 设备安装器正在工作",
    host_or_pnp_action_in_progress: "同主机已有恢复动作",
    host_became_busy: "执行前检测到主机被占用",
    exact_instance_not_found: "未找到可安全重启的精确 PnP 节点",
    automatic_attempt_limit_reached: "达到单设备自动尝试上限",
    adb_reconnect_failed: "ADB transport 重连失败",
    pnp_timeout: "单设备 PnP 重启超时",
    pnp_action_failed: "单设备 PnP 重启失败",
    delayed_collateral_guard: "持续观察延迟出现的批外掉线",
    circuit_collateral_rescue: "普通队列保持熔断，仅救回批外连带设备",
    recovery_cycle_completed: "当前动作链已完成，冷却后自动开始下一轮",
    mass_outage: "同时异常设备过多",
    burst_outage: "短时间内集中掉线",
    stable_scans_passed: "连续稳定采样通过"
  })[value] || value || "";
}

function renderRecoveryEmpty(hasQueue, filter) {
  if (hasQueue && filter !== "all") return `<div class="recovery-empty"><strong>这个筛选下没有设备</strong><span>切换“全部”可查看当前完整恢复队列。</span></div>`;
  return `<div class="recovery-empty is-healthy"><strong>当前队列已清空</strong><span>所有已物理连接的手机都已到达 ADB 在线状态。</span></div>`;
}
