import { wecomExecution } from './wecom-diagnostics.mjs';

const groups = [
  ['page_compatibility', ['system_overlay_interrupted'], '系统通知栏或快捷设置遮挡了企微', '收起系统面板后核对原任务；不自动关闭面板或重新提交。'],
  ['configuration', ['wecom_rpc_session_context_unconfirmed'], '本任务的本地读取连接绑定未通过核对', '核对原任务的读取通道，不换ADB入口或重试未知操作。'],
  ['page_compatibility', ['wecom_element_geometry_unconfirmed', 'wecom_element_display_unconfirmed'], '元素位置或屏幕尺寸未通过核对', '查看这台手机的页面和显示尺寸，不猜坐标或切换ADB。'],
  ['transport', ['wecom_element_tap_delivery_unknown'], '元素点击的交付结果未确认', '核对原任务和手机当前页面，不重复点击、保存或发送。'],
  ['account_limit', ['wecom_add_friend_too_frequent'], '指定企微成员添加好友过于频繁', '暂停该成员分配并核对原任务，不自动换账户或重发。'],
  ['login', ['login_required'], '企微账户未登录', '在对应手机登录所选账户，再核对原任务。'],
  ['human', ['human_required', 'device_unlock_requires_user'], '手机需要人工验证或解锁', '在对应手机完成验证或解锁，不重新提交原任务。'],
  ['device_connection', ['adb_io_timeout', 'device_offline', 'adb_offline', 'agent_offline', 'adb_device_not_ready'], '手机或执行端连接未就绪', '检查这台手机和执行端的连接；不要重建共享ADB或切换身份。'],
  ['device_busy', ['device_busy', 'device_lease_lost', 'poco_already_running', 'wecom_cleanup_pending'], '手机占用或任务独占权未确认', '等待当前占用或清理结束，按原任务查询；不要强退其他任务。'],
  ['configuration', ['wecom_device_not_allowed', 'wecom_device_mapping_unconfirmed', 'wecom_app_slot_not_configured', 'profile_phone_mismatch', 'profile_not_found'], '手机编号或主号/分身配置未确认', '核对设备目录、真实编号及所选主号/分身，不能自动改用另一个账户。'],
  ['business_stop', ['already_contact'], '该账户已添加此客户', '无需重新添加；这不是本次发送成功。'],
  ['business_stop', ['not_found'], '本次未找到匹配客户', '核对客户号码及手机搜索结果。'],
  ['cleanup', ['preview_cleanup_unconfirmed', 'wecom_cleanup_bootstrap_unconfirmed'], '任务工具清理尚未确认', '保留原任务和单机占用，等待运维核对清理；不要直接清锁或再次运行。'],
  ['result_unconfirmed', ['remark_persistence_unconfirmed', 'remark_persistence_unstable', 'remark_readback_mismatch', 'invitation_claim_unconfirmed_no_retry', 'invitation_local_claim_exists_no_retry', 'wecom_invitation_already_claimed_no_retry', 'invitation_click_issued_delivery_unknown', 'invitation_outcome_unknown_no_retry'], '备注保存或邀请状态需要核对', '查看原任务及该账户的实际结果，不能自动再次保存或发送。'],
  ['page_compatibility', ['ambiguous_or_missing_element', 'element_changed_before_action', 'element_has_no_stable_selector', 'page_changed_before_action', 'home_navigation_page_changed', 'unsupported_start_page', 'unrecognized_phone_input', 'phone_readback_mismatch', 'search_input_not_empty', 'preview_target_unverified', 'wrong_foreground_app', 'unexpected_send_page', 'invitation_element_changed', 'invitation_element_missing', 'invitation_page_changed', 'invitation_page_unstable', 'invitation_result_already_present', 'remark_fields_changed', 'remark_phone_not_verified', 'invalid_remark_context', 'system_overlay_changed_before_action', 'system_overlay_dismissal_not_confirmed'], '页面结构、目标或前台状态未通过核对', '查看失败阶段和这台手机的当前页面，由脚本维护人员核对适配；不要盲点或重放。'],
  ['timeout', ['timeout', 'screen_prepare_timeout', 'screen_wake_not_confirmed', 'device_unlock_not_confirmed', 'wecom_launch_not_ready', 'home_navigation_timeout', 'preview_phase_timeout', 'observation_budget_exhausted', 'remark_observation_budget_exhausted', 'poco_not_ready', 'wecom_preview_worker_timeout_no_replay', 'task_expired'], '本阶段等待超时或组件未就绪', '结合失败阶段核对手机和原任务结果，不自动重跑或放宽超时。'],
];
const catalog = new Map(groups.flatMap(([category, codes, message, action]) => codes.map(code => [code, { category, message, action }])));
const phases = { configuration:'任务配置', adb_identity:'ADB身份核对', device_preflight:'设备检查', screen_prepare:'屏幕准备', poco_launch:'读取组件启动', poco_health:'读取组件检查', wecom_launch:'企微启动', rpc_setup:'读取通道连接', startup_guards:'启动弹窗处理', foreground_wait:'前台确认', selector_observe:'页面读取', selector_click:'元素点击', home_navigation:'首页导航', recipient_search:'客户搜索', remark_edit:'备注填写', remark_save:'备注保存核对', send_claim:'发送凭据确认', invitation_send:'邀请发送', cleanup:'工具清理' };

// A presentation-only projection. It grants no retry, send, cleanup or lease.
export function wecomErrorInfo({ code, status, execution, sendStatus, remarkSaveStatus } = {}) {
  const outcomeUnconfirmed = status === 'stalled' || sendStatus === 'unknown' || remarkSaveStatus === 'unknown';
  if (['queued', 'running'].includes(status) || (!outcomeUnconfirmed && ['preview_ready', 'stopped_before_send', 'send_boundary_reached'].includes(code))) return null;
  if (!code && !['failed', 'stalled', 'expired'].includes(status)) return null;
  const trace = wecomExecution(execution);
  const transport = trace?.transportFailure;
  let info = catalog.get(code);
  if (typeof code === 'string' && code.startsWith('qa_')) info = { category:'test_environment', message:'隔离测试的授权或环境核验未通过', action:'核对测试预约、缓存及通道归属；不能据此判断企微页面故障。' };
  else if (code === 'wecom_rpc_delivery_unknown_no_replay') info = transport?.reason === 'peer_verification_failed'
    ? { category:'test_environment', message:'读取通道归属核验失败', action:'核对原通道和测试授权；本次操作未重放。' }
    : { category:'transport', message:transport?.reason === 'read_timeout' ? '读取通道等待响应超时，操作交付未确认' : transport?.reason === 'connection_closed' || transport?.reason === 'transport_disconnected' ? '读取通道断开，操作交付未确认' : '读取通道通信失败，操作交付未确认', action:'核对原任务及手机日志；有匹配证据后再处理原因，不自动重放。' };
  info ||= { category:'internal', message:'任务执行中止，原因尚未分类', action:'按任务号和失败阶段交给维护人员核对，不自动重跑。' };
  const phase = trace?.failurePhase || '';
  return { ...info, phase, phaseLabel:phases[phase] || '', outcomeUnconfirmed,
    action:(outcomeUnconfirmed ? '发送或保存结果尚未确认，请勿重复提交。' : '') + info.action };
}
