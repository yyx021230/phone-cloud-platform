import {lookupAccountOfflineEvidence,latestAccountWork} from './lookup-account-offline.mjs';

function occupancyLabel(lockType, appSlot) {
  if (lockType === "screen_control") return "实时控制";
  if (lockType === "sms_wait") return "等待短信";
  if (lockType === "xhs_qr") return `${appSlot === "app2" ? "小红书 2" : "小红书 1"} 扫码`;
  if (lockType === "xhs_data_collect") return `${appSlot === "app2" ? "小红书 2" : "小红书 1"} 数据采集`;
  if (lockType === "xhs_publish") return `${appSlot === "app2" ? "小红书 2" : "小红书 1"} 发布`;
  if (lockType === "alipay_name_lookup") return "支付宝查名字";
  return "设备任务";
}

function resolveOwner(ownerUserId, viewer, users) {
  if (viewer?.role === "user" && viewer.userId === ownerUserId) return { label: "你", visible: true };
  const normalizedOwnerUserId = String(ownerUserId || "").trim();
  if (normalizedOwnerUserId.startsWith("admin:")) return { label: "管理员", visible: true };
  if (normalizedOwnerUserId === "system" || normalizedOwnerUserId.startsWith("system:")) {
    return { label: "系统任务", visible: true };
  }
  const owner = users.find((user) => user.userId === ownerUserId);
  if (!owner) return { label: "未知用户", visible: false };
  if (owner.role === "admin") return { label: "管理员", visible: true };
  return { label: owner.displayName || owner.username || "未知用户", visible: true };
}

export function buildDeviceOccupancy({ lock, viewer = null, users = [], lookupSession = null, lookupChannel = null, lookupJobs = [] } = {}) {
  if (!lock) return null;
  const appSlot = String(lock.appSlot || "");
  const owner = resolveOwner(String(lock.ownerUserId || ""), viewer, users);
  const isScreenControl = lock.lockType === "screen_control";
  return {
    ...(lookupSession ? {lookup: buildLookupCardStatus(lookupSession, lookupChannel, lookupJobs)} : {}),
    kind: String(lock.lockType || "task"),
    label: occupancyLabel(lock.lockType, appSlot),
    ownerLabel: owner.label,
    ownerVisible: owner.visible,
    startedAt: String(lock.createdAt || ""),
    appSlot,
    taskId: isScreenControl ? "" : String(lock.taskId || ""),
    sessionId: isScreenControl ? String(lock.taskId || "") : ""
  };
}

// Read-only presentation evidence. Never return phone numbers, account IDs,
// result names, diagnostics or raw error messages to the inventory card.
export function buildLookupCardStatus(session, channel = null, jobs = []) {
  const value = (state, label, hint, needsHuman = false) => ({state, label, hint, needsHuman});
  const sameChannel = channel?.sessionId === session.sessionId ? channel : null;
  if (session.status === 'stopping' || sameChannel?.phase === 'stopping' || sameChannel?.roundStopPreparationId) {
    return value('stopping', '查名释放中', '正在等待手机确认停止，占用确认后释放');
  }
  const latestJob = latestAccountWork(jobs, session.sessionId);
  if (lookupAccountOfflineEvidence(latestJob, session)) {
    return value('login_required', '账号掉线 · 需登录', '请到实时控制重新授权登录；后续启动时重新探测', true);
  }
  if (['ended', 'failed', 'expired'].includes(session.status)) {
    return value('checking', '查名状态待确认', '任务已结束或异常，正在核对占用状态');
  }
  if (sameChannel?.phase === 'unknown') {
    return value('checking', '查名状态待确认', '正在核对设备执行状态，请勿重复提交查询');
  }
  const pending = session.pendingJobId && jobs.find(j => j.jobId === session.pendingJobId && j.sessionId === session.sessionId);
  if (session.pendingJobId) {
    if (session.status === 'switching' || pending?.kind === 'alipay_name_switch') return value('switching', '正在切换账号', '系统自动处理，暂不需要人工');
    if (pending?.resumeAfterHumanVerification) return value('resuming', '验证后接续中', '已检测到验证完成，正在继续原任务');
    if (session.status === 'starting' || pending?.kind === 'alipay_name_start') return value('preparing', '查名准备中', '正在启动并检查账号');
    return value('running', '查名执行中', '正在执行探测或号码查询');
  }
  const observation=sameChannel?.humanObservation;
  if(sameChannel?.phase==='human'&&observation){
    if(observation.confirmed&&Date.now()-observation.at<=30000)return value('verified_waiting','验证完成 · 等待接续','已确认验证完成，优先等待执行位置');
    if(observation.state==='unknown'||Date.now()-observation.at>30000)return value('checking','验证检测中','暂未取得可靠页面状态，系统继续检测');
  }
  const result = sameChannel?.queryId ? session.results?.find(r => r.resultId === sameChannel.queryId) : session.results?.find(r => r.status !== 'queued');
  const human = session.startupHumanVerification?.status === 'needs_human_verification' ? session.startupHumanVerification : result;
  if (session.status === 'needs_human_verification' || human?.status === 'needs_human_verification') {
    const puzzle = human?.limitReason === 'jigsaw_verification';
    return value('human_required', puzzle ? '等待人工拼图' : '等待人工验证', '请到实时控制完成验证，完成后系统自动接续', true);
  }
  if (session.requiresAccountSwitch || sameChannel?.phase === 'switching') return value('switching', '触限处理中', '系统切换账号或等待冷却，暂不需要人工');
  if (sameChannel?.phase === 'recovery' || human?.status === 'needs_recovery') return value('recovering', '查名异常恢复中', '系统正在恢复或转交原查询');
  if (sameChannel?.phase === 'idle' || session.status === 'ready') return value('idle', '查名待命', '等待分配号码；空闲到期后重新探测');
  return value('preparing', '查名准备中', '正在检查当前任务状态');
}
