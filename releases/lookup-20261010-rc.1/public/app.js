
import { ScreenInactivityGuard } from "./screen-inactivity-guard.js?v=20260902-screen-idle-10m-baseline-v2";
import { createUserDeviceInventoryGuard, requireUserDeviceInventory } from "./user-device-inventory.js";

const ONLINE_MS = 90_000;

function readJsonLocalStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

const state = {
  token: localStorage.getItem("phoneCloudSessionToken") || "",
  user: null,
  page: new URLSearchParams(window.location.search).get("page") || localStorage.getItem("phoneCloudPage") || "dashboard",
  overview: {},
  agents: [],
  devices: [],
  users: [],
  userDevices: [],
  userDevicesLoading: false,
  userDevicesLoadError: "",
  userDevicesLoadedAt: 0,
  userSelectedDeviceId: localStorage.getItem("phoneCloudUserSelectedDeviceId") || "",
  userWorkbenchView: localStorage.getItem("phoneCloudUserWorkbenchView") || "inventory",
  userDetailTab: localStorage.getItem("phoneCloudUserDetailTab") || "sms",
  userDeviceFilter: localStorage.getItem("phoneCloudUserDeviceFilter") || "all",
  userDeviceBrandFilter: localStorage.getItem("phoneCloudUserDeviceBrandFilter") || "",
  userDeviceAndroidFilter: localStorage.getItem("phoneCloudUserDeviceAndroidFilter") || "",
  userDeviceSearch: "",
  userDeviceSwitcherOpen: false,
  userDeviceSwitcherSearch: "",
  userSmsSearch: "",
  userSmsSimFilter: "",
  userSmsCodeOnly: false,
  userSmsPage: 1,
  userSmsPageSize: Number(localStorage.getItem("phoneCloudUserSmsPageSize") || 20),
  userPhones: [],
  userDeviceSmsMessages: [],
  userDeviceSmsTotal: 0,
  userDeviceSmsLoading: false,
  userDeviceSmsLoadingDeviceId: "",
  userDeviceSmsLoadedAt: 0,
  userDeviceSmsLoadedDeviceId: "",
  userDeviceSmsLoadedQueryKey: "",
  userSmsLoadError: "",
  userSmsRefreshDeviceId: "",
  userSmsRefreshCooldownUntil: 0,
  userSmsOrders: [],
  userXhsTasks: [],
  userPendingXhsTasks: [],
  userXhsSubmitting: false,
  userAutomationModule: localStorage.getItem("phoneCloudUserAutomationModule") || "scan",
  userPublishTasks: [],
  userPublishSubmitting: false,
  userKuaishouTasks: [],
  userKuaishouBusy: false,
  userLookupSessions: [],
  userLookupBusy: false,
  userLookupEnding: false,
  userScreenSession: null,
  userScreenToken: "",
  userScreenStatus: "idle",
  userScreenDetail: "等待连接",
  userScreenDeviceId: "",
  userScreenController: null,
  userScreenStarting: false,
  userScreenMetrics: {},
  userScreenGalleryImport: null,
  userScreenGalleryImporting: false,
  userScreenGalleryDraftFile: null,
  userScreenGalleryDraftDataUrl: "",
  userScreenGalleryDraftError: "",
  userAutomationTargetByDevice: readJsonLocalStorage("phoneCloudUserAutomationTargetByDevice", {}),
  windowsTasks: [],
  windowsTaskEvidenceLoading: {},
  windowsRecoveryFilter: localStorage.getItem("phoneCloudWindowsRecoveryFilter") || "all",
  smsOrders: [],
  smsEvents: [],
  smsMessages: [],
  xhsTasks: [],
  xhsTaskEvidenceLoading: {},
  xhsTaskTotal: 0,
  xhsTaskPage: Number(localStorage.getItem("phoneCloudXhsTaskPage") || 1),
  xhsTaskPageSize: Number(localStorage.getItem("phoneCloudXhsTaskPageSize") || 20),
  appRelease: null,
  diagnostics: null,
  operationsMetrics: null,
  workflowScripts: [],
  audit: [],
  adminDeviceEditingUntil: 0,
  adminWorkflowScriptEditingUntil: 0,
  adminDeviceListingFilter: localStorage.getItem("phoneCloudAdminDeviceListingFilter") || "all"
};

const MAX_QR_IMAGE_FILE_BYTES = 3_000_000;
const QR_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const USER_SMS_AUTO_REFRESH_MS = 30_000;
const USER_XHS_TASK_REFRESH_MS = 3_000;
const USER_LOOKUP_REFRESH_MS = 1_000;
const CLIENT_UPDATE_CHECK_MS = 15_000;
const AUTO_REFRESH_MS = 30_000;
const REALTIME_DIAGNOSTICS_REFRESH_MS = 5_000;
const USER_SMS_MANUAL_REFRESH_COOLDOWN_MS = 10_000;
let userSmsSearchTimer = null;
let userSmsRefreshCooldownTimer = null;
let userSmsAutoRefreshTimer = null;
let userXhsTaskRefreshTimer = null;
let userLookupRefreshTimer = null;
const userSmsLastAutoRefreshAtByDevice = new Map();
const userSmsDeviceSyncRequestedByDevice = new Set();
const adminDeviceSavingIds = new Set();
const adminDeviceListingIds = new Set();
const adminDeviceExpandedIds = new Set();
const adminDeviceFeedbackById = new Map();
let latestLoadAllRequestId = 0;
let latestUserSmsRequestId = 0;
let latestUserAutomationRefreshRequestId = 0;
let userAutomationRefreshPromise = null;
let userLookupSyncVersion = 0;
let userLookupRefreshPromise = null;
let clientUpdateCheckPromise = null;
let copiedLookupResultId = "";
let copiedLookupResetTimer = null;
let loadAllInFlight = false;
const userDeviceInventoryGuard = createUserDeviceInventoryGuard({ emptyConfirmationCycles: 2 });
let didApplyUserDefaultLanding = false;
let userScreenExitReleaseRequested = false;
const screenshotStore = new Map();

function forceUserInventoryHome() {
  state.page = "user-workbench";
  state.userWorkbenchView = "inventory";
  state.userSelectedDeviceId = "";
  state.userDeviceSwitcherOpen = false;
  state.userDeviceSwitcherSearch = "";
  state.userDeviceSmsMessages = [];
  state.userDeviceSmsTotal = 0;
  state.userDeviceSmsLoading = false;
  state.userDeviceSmsLoadingDeviceId = "";
  state.userSmsLoadError = "";
  localStorage.setItem("phoneCloudPage", state.page);
  localStorage.setItem("phoneCloudUserWorkbenchView", state.userWorkbenchView);
  localStorage.removeItem("phoneCloudUserSelectedDeviceId");
}

function restoreUserWorkbenchRoute() {
  state.page = "user-workbench";
  if (!["inventory", "detail"].includes(state.userWorkbenchView)) {
    state.userWorkbenchView = "inventory";
  }
  if (state.userWorkbenchView === "detail" && !state.userSelectedDeviceId) {
    state.userWorkbenchView = "inventory";
  }
  localStorage.setItem("phoneCloudPage", state.page);
  localStorage.setItem("phoneCloudUserWorkbenchView", state.userWorkbenchView);
}

const els = {
  loginScreen: document.getElementById("loginScreen"),
  loginForm: document.getElementById("loginForm"),
  loginUsernameInput: document.getElementById("loginUsernameInput"),
  loginPasswordInput: document.getElementById("loginPasswordInput"),
  loginHint: document.getElementById("loginHint"),
  authUserName: document.getElementById("authUserName"),
  authUserRole: document.getElementById("authUserRole"),
  refreshButton: document.getElementById("refreshButton"),
  defaultTopTitle: document.getElementById("defaultTopTitle"),
  userTopBrand: document.getElementById("userTopBrand"),
  userTopMetrics: document.getElementById("userTopMetrics"),
  userTopTotalDevices: document.getElementById("userTopTotalDevices"),
  userTopAvailableDevices: document.getElementById("userTopAvailableDevices"),
  userTopOnlineDevices: document.getElementById("userTopOnlineDevices"),
  userTopBusyDevices: document.getElementById("userTopBusyDevices"),
  userTopIdentity: document.getElementById("userTopIdentity"),
  userTopIdentityText: document.getElementById("userTopIdentityText"),
  userTopAvatar: document.getElementById("userTopAvatar"),
  userTopAdminButton: document.getElementById("userTopAdminButton"),
  topSettingsButton: document.getElementById("topSettingsButton"),
  settingsOpenButtons: document.querySelectorAll("[data-settings-open]"),
  settingsCloseButtons: document.querySelectorAll("[data-settings-close]"),
  settingsModal: document.getElementById("settingsModal"),
  settingsAvatar: document.getElementById("settingsAvatar"),
  settingsDisplayName: document.getElementById("settingsDisplayName"),
  settingsAccountMeta: document.getElementById("settingsAccountMeta"),
  settingsAccountFacts: document.getElementById("settingsAccountFacts"),
  settingsLogoutButton: document.getElementById("settingsLogoutButton"),
  pageTitle: document.getElementById("pageTitle"),
  pageSummary: document.getElementById("pageSummary"),
  pageButtons: document.querySelectorAll("[data-page-button]"),
  pages: document.querySelectorAll("[data-page]"),
  overviewGrid: document.getElementById("overviewGrid"),
  userSmsOrderForm: document.getElementById("userSmsOrderForm"),
  userDeviceInventoryView: document.getElementById("userDeviceInventoryView"),
  userDeviceDetailView: document.getElementById("userDeviceDetailView"),
  userDeviceBackButton: document.getElementById("userDeviceBackButton"),
  userInventorySummary: document.getElementById("userInventorySummary"),
  userInventoryRefreshButton: document.getElementById("userInventoryRefreshButton"),
  userDeviceSearchInput: document.getElementById("userDeviceSearchInput"),
  userDeviceStatusSelect: document.getElementById("userDeviceStatusSelect"),
  userDeviceBrandSelect: document.getElementById("userDeviceBrandSelect"),
  userDeviceAndroidSelect: document.getElementById("userDeviceAndroidSelect"),
  userDeviceClearFiltersButton: document.getElementById("userDeviceClearFiltersButton"),
  userDeviceFilterChips: document.getElementById("userDeviceFilterChips"),
  userDeviceList: document.getElementById("userDeviceList"),
  userDeviceTitle: document.getElementById("userDeviceTitle"),
  userDeviceSwitcher: document.getElementById("userDeviceSwitcher"),
  userDeviceSwitcherButton: document.getElementById("userDeviceSwitcherButton"),
  userDeviceSwitcherPanel: document.getElementById("userDeviceSwitcherPanel"),
  userDeviceSwitcherSearch: document.getElementById("userDeviceSwitcherSearch"),
  userDeviceSwitcherCount: document.getElementById("userDeviceSwitcherCount"),
  userDeviceSwitcherList: document.getElementById("userDeviceSwitcherList"),
  userDeviceStatusPills: document.getElementById("userDeviceStatusPills"),
  userDeviceDetailStatus: document.getElementById("userDeviceDetailStatus"),
  userDeviceDetailMeta: document.getElementById("userDeviceDetailMeta"),
  userDeviceDetail: document.getElementById("userDeviceDetail"),
  userDetailTabs: document.getElementById("userDetailTabs"),
  userDetailPanels: document.querySelectorAll("[data-user-detail-panel]"),
  userDeviceAutomationStatus: document.getElementById("userDeviceAutomationStatus"),
  userDeviceSmsHint: document.getElementById("userDeviceSmsHint"),
  userDeviceSmsRefreshButton: document.getElementById("userDeviceSmsRefreshButton"),
  userSmsSearchInput: document.getElementById("userSmsSearchInput"),
  userSmsSimFilter: document.getElementById("userSmsSimFilter"),
  userSmsCodeOnlyToggle: document.getElementById("userSmsCodeOnlyToggle"),
  userDeviceSmsList: document.getElementById("userDeviceSmsList"),
  userSmsPagination: document.getElementById("userSmsPagination"),
  userSmsHint: document.getElementById("userSmsHint"),
  userSmsList: document.getElementById("userSmsList"),
  userXhsTaskForm: document.getElementById("userXhsTaskForm"),
  userAutomationTargetSelect: document.getElementById("userAutomationTargetSelect"),
  userAutomationTargetCards: document.getElementById("userAutomationTargetCards"),
  userQrImageInput: document.getElementById("userQrImageInput"),
  userQrPreview: document.getElementById("userQrPreview"),
  userXhsHint: document.getElementById("userXhsHint"),
  userXhsList: document.getElementById("userXhsList"),
  userAutomationModuleTabs: document.getElementById("userAutomationModuleTabs"),
  userAutomationModulePanels: document.querySelectorAll("[data-automation-module-panel]"),
  userPublishForm: document.getElementById("userPublishForm"),
  userPublishTargetSelect: document.getElementById("userPublishTargetSelect"),
  userPublishImagesInput: document.getElementById("userPublishImagesInput"),
  userPublishImageUpload: document.getElementById("userPublishImageUpload"),
  userPublishImagesMeta: document.getElementById("userPublishImagesMeta"),
  userPublishTitleInput: document.getElementById("userPublishTitleInput"),
  userPublishTitleCount: document.getElementById("userPublishTitleCount"),
  userPublishContentInput: document.getElementById("userPublishContentInput"),
  userPublishContentCount: document.getElementById("userPublishContentCount"),
  userPublishHint: document.getElementById("userPublishHint"),
  userPublishSubmitButton: document.getElementById("userPublishSubmitButton"),
  userPublishTaskList: document.getElementById("userPublishTaskList"),
  userKuaishouStatus: document.getElementById("userKuaishouStatus"),
  userKuaishouMinDelay: document.getElementById("userKuaishouMinDelay"),
  userKuaishouMaxDelay: document.getElementById("userKuaishouMaxDelay"),
  userKuaishouHint: document.getElementById("userKuaishouHint"),
  userKuaishouStartButton: document.getElementById("userKuaishouStartButton"),
  userKuaishouStopButton: document.getElementById("userKuaishouStopButton"),
  userKuaishouTaskList: document.getElementById("userKuaishouTaskList"),
  userLookupSessionStatus: document.getElementById("userLookupSessionStatus"),
  userLookupStartButton: document.getElementById("userLookupStartButton"),
  userLookupSwitchButton: document.getElementById("userLookupSwitchButton"),
  userLookupCurrentAccount: document.getElementById("userLookupCurrentAccount"),
  userLookupAccountChooser: document.getElementById("userLookupAccountChooser"),
  userLookupAccountList: document.getElementById("userLookupAccountList"),
  userLookupCooldownPanel: document.getElementById("userLookupCooldownPanel"),
  userLookupCooldownRows: document.getElementById("userLookupCooldownRows"),
  userLookupRecoveryRetryButton: document.getElementById("userLookupRecoveryRetryButton"),
  userLookupPhoneInput: document.getElementById("userLookupPhoneInput"),
  userLookupQueryButton: document.getElementById("userLookupQueryButton"),
  userLookupHumanResumePanel: document.getElementById("userLookupHumanResumePanel"),
  userLookupHumanResumeButton: document.getElementById("userLookupHumanResumeButton"),
  userLookupEndButton: document.getElementById("userLookupEndButton"),
  userLookupHint: document.getElementById("userLookupHint"),
  userLookupResultList: document.getElementById("userLookupResultList"),
  userScreenVideo: document.getElementById("userScreenVideo"),
  userScreenStatus: document.getElementById("userScreenStatus"),
  userScreenStartButton: document.getElementById("userScreenStartButton"),
  userScreenWakeButton: document.getElementById("userScreenWakeButton"),
  userScreenStopButton: document.getElementById("userScreenStopButton"),
  userScreenGalleryFileInput: document.getElementById("userScreenGalleryFileInput"),
  userScreenGalleryPasteButton: document.getElementById("userScreenGalleryPasteButton"),
  userScreenGalleryPasteZone: document.getElementById("userScreenGalleryPasteZone"),
  userScreenGalleryImport: document.getElementById("userScreenGalleryImport"),
  userScreenGalleryDraft: document.getElementById("userScreenGalleryDraft"),
  userScreenGalleryPreview: document.getElementById("userScreenGalleryPreview"),
  userScreenGalleryFileName: document.getElementById("userScreenGalleryFileName"),
  userScreenGalleryFileMeta: document.getElementById("userScreenGalleryFileMeta"),
  userScreenGalleryClearButton: document.getElementById("userScreenGalleryClearButton"),
  userScreenGalleryConfirmButton: document.getElementById("userScreenGalleryConfirmButton"),
  userScreenGalleryImportStatus: document.getElementById("userScreenGalleryImportStatus"),
  userScreenPlaceholder: document.getElementById("userScreenPlaceholder"),
  userScreenOverlay: document.getElementById("userScreenOverlay"),
  userScreenOverlaySpinner: document.getElementById("userScreenOverlaySpinner"),
  userScreenOverlayTitle: document.getElementById("userScreenOverlayTitle"),
  userScreenOverlayDetail: document.getElementById("userScreenOverlayDetail"),
  userScreenReconnectButton: document.getElementById("userScreenReconnectButton"),
  userScreenHint: document.getElementById("userScreenHint"),
  userScreenNavigationButtons: document.querySelectorAll(".screen-navigation [data-screen-key]"),
  userScreenControlWorkspace: document.getElementById("userScreenControlWorkspace"),
  userScreenIdleModal: document.getElementById("userScreenIdleModal"),
  userScreenIdleCountdownRing: document.getElementById("userScreenIdleCountdownRing"),
  userScreenIdleCountdown: document.getElementById("userScreenIdleCountdown"),
  userScreenIdleInlineCountdown: document.getElementById("userScreenIdleInlineCountdown"),
  userScreenIdleProgress: document.getElementById("userScreenIdleProgress"),
  userScreenIdleContinueButton: document.getElementById("userScreenIdleContinueButton"),
  userScreenIdleDisconnectButton: document.getElementById("userScreenIdleDisconnectButton"),
  passwordForm: document.getElementById("passwordForm"),
  passwordHint: document.getElementById("passwordHint"),
  userCreateForm: document.getElementById("userCreateForm"),
  userCreateHint: document.getElementById("userCreateHint"),
  userList: document.getElementById("userList"),
  agentCreateButton: document.getElementById("agentCreateButton"),
  agentTokenNotice: document.getElementById("agentTokenNotice"),
  windowsList: document.getElementById("windowsList"),
  windowsTaskList: document.getElementById("windowsTaskList"),
  windowsRecoveryConsole: document.getElementById("windowsRecoveryConsole"),
  deviceList: document.getElementById("deviceList"),
  deviceListingToolbar: document.getElementById("deviceListingToolbar"),
  deviceBulkListingButtons: document.querySelectorAll("[data-device-bulk-listing]"),
  smsOrderForm: document.getElementById("smsOrderForm"),
  smsHint: document.getElementById("smsHint"),
  smsList: document.getElementById("smsList"),
  smsLibraryForm: document.getElementById("smsLibraryForm"),
  smsLibraryDeviceSelect: document.getElementById("smsLibraryDeviceSelect"),
  smsLibraryBoxSelect: document.getElementById("smsLibraryBoxSelect"),
  smsLibrarySearchInput: document.getElementById("smsLibrarySearchInput"),
  smsLibraryList: document.getElementById("smsLibraryList"),
  releaseForm: document.getElementById("releaseForm"),
  releaseHint: document.getElementById("releaseHint"),
  releaseDetail: document.getElementById("releaseDetail"),
  xhsTaskForm: document.getElementById("xhsTaskForm"),
  xhsHint: document.getElementById("xhsHint"),
  xhsDeviceSelect: document.getElementById("xhsDeviceSelect"),
  xhsSlotSelect: document.getElementById("xhsSlotSelect"),
  xhsList: document.getElementById("xhsList"),
  workflowScriptForm: document.getElementById("workflowScriptForm"),
  workflowScriptEnabled: document.getElementById("workflowScriptEnabled"),
  workflowScriptMeta: document.getElementById("workflowScriptMeta"),
  workflowConfirmWaitMs: document.getElementById("workflowConfirmWaitMs"),
  workflowTimeoutTotalMs: document.getElementById("workflowTimeoutTotalMs"),
  workflowTimeoutRestartMs: document.getElementById("workflowTimeoutRestartMs"),
  workflowTimeoutProfileMs: document.getElementById("workflowTimeoutProfileMs"),
  workflowTimeoutScannerMs: document.getElementById("workflowTimeoutScannerMs"),
  workflowTimeoutAlbumMs: document.getElementById("workflowTimeoutAlbumMs"),
  workflowTimeoutSelectImageMs: document.getElementById("workflowTimeoutSelectImageMs"),
  workflowTimeoutLoginConfirmMs: document.getElementById("workflowTimeoutLoginConfirmMs"),
  workflowLoginKeywords: document.getElementById("workflowLoginKeywords"),
  workflowOrdinaryButtons: document.getElementById("workflowOrdinaryButtons"),
  workflowPlatformButtons: document.getElementById("workflowPlatformButtons"),
  workflowScriptSteps: document.getElementById("workflowScriptSteps"),
  workflowScriptHint: document.getElementById("workflowScriptHint"),
  workflowScriptPreview: document.getElementById("workflowScriptPreview"),
  diagnosticsSummary: document.getElementById("diagnosticsSummary"),
  diagnosticsChecks: document.getElementById("diagnosticsChecks"),
  diagnosticsDetail: document.getElementById("diagnosticsDetail"),
  realtimeDiagnostics: document.getElementById("realtimeDiagnostics"),
  auditList: document.getElementById("auditList")
};

function updateUserScreenIdleCountdown({ seconds = 10, progress = 1 } = {}) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const safeProgress = Math.max(0, Math.min(1, Number(progress) || 0));
  if (els.userScreenIdleCountdown) els.userScreenIdleCountdown.textContent = String(safeSeconds);
  if (els.userScreenIdleInlineCountdown) els.userScreenIdleInlineCountdown.textContent = String(safeSeconds);
  if (els.userScreenIdleCountdownRing) {
    els.userScreenIdleCountdownRing.style.setProperty("--idle-countdown-progress", `${safeProgress * 100}%`);
  }
  if (els.userScreenIdleProgress) els.userScreenIdleProgress.style.transform = `scaleX(${safeProgress})`;
}

function renderUserScreenIdleWarning({ open, seconds = 10, progress = 1 } = {}) {
  if (!els.userScreenIdleModal) return;
  updateUserScreenIdleCountdown({ seconds, progress });
  els.userScreenIdleModal.hidden = !open;
  document.body.classList.toggle("screen-idle-modal-open", Boolean(open));
  if (open) {
    requestAnimationFrame(() => {
      if (!els.userScreenIdleModal?.hidden) els.userScreenIdleContinueButton?.focus();
    });
  }
}

const userScreenInactivityGuard = new ScreenInactivityGuard({
  onWarning: renderUserScreenIdleWarning,
  onCountdown: updateUserScreenIdleCountdown,
  onTimeout() {
    stopUserScreenSession({ detail: "长时间未操作，已自动断开" }).catch(() => {});
  }
});

function authHeaders(extra = {}) {
  return {
    ...extra,
    authorization: `Bearer ${state.token}`,
    "content-type": "application/json"
  };
}

async function api(path, options = {}) {
  const signal = options.signal || AbortSignal.timeout(15_000);
  const response = await fetch(path, {
    ...options,
    signal,
    headers: authHeaders(options.headers || {})
  });
  let payload;
  try {
    payload = await response.json();
  } catch (cause) {
    if (!response.ok) {
      payload = {};
    } else {
      const error = new Error("服务器响应不完整，本次刷新已取消并保留当前页面数据。");
      error.status = response.status;
      error.code = "invalid_json_response";
      error.cause = cause;
      throw error;
    }
  }
  if (response.ok && (!payload || typeof payload !== "object" || Array.isArray(payload))) {
    const error = new Error("服务器响应格式异常，本次刷新已取消并保留当前页面数据。");
    error.status = response.status;
    error.code = "invalid_json_response";
    throw error;
  }
  if (!response.ok) {
    const error = new Error(humanError(payload, response.status));
    error.status = response.status;
    error.code = payload.error || "";
    error.payload = payload;
    throw error;
  }
  return payload;
}

function waitForUserDeviceInventoryConfirmation(delayMs = 350) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function loadStableUserDeviceInventory() {
  const firstPayload = await api("/api/v1/user/devices");
  const firstDevices = requireUserDeviceInventory(firstPayload);
  if (firstDevices.length > 0 || state.userDevices.length === 0) {
    userDeviceInventoryGuard.reset();
    return firstPayload;
  }

  // A single empty inventory contradicting a populated screen is not enough
  // to evict the selected phone. Re-read once to distinguish a truncated or
  // stale backend response from a real fleet-wide inventory change.
  await waitForUserDeviceInventoryConfirmation();
  const confirmationPayload = await api("/api/v1/user/devices");
  const confirmationDevices = requireUserDeviceInventory(confirmationPayload);
  const decision = userDeviceInventoryGuard.decide(state.userDevices, confirmationDevices);
  if (!decision.apply) {
    const error = new Error("设备清单瞬时为空，已保留上次有效数据并等待下一轮确认。");
    error.code = "user_devices_transient_empty";
    throw error;
  }
  return { ...confirmationPayload, devices: decision.devices };
}

function humanError(payload = {}, status = 0) {
  const code = payload.error || "";
  const detail = payload.detail || "";
  const map = {
    device_busy: "这台手机正在执行任务，请稍后再试。",
    account_slot_busy: "这个账号槽位正在扫码，请稍后再试。",
    device_not_published: "这台手机还没有上架，暂时不能使用。",
    sms_refresh_too_frequent: `短信库刷新太频繁，请 ${payload.retryAfterSeconds || 10} 秒后再试。`,
    sms_refresh_unavailable: "这台手机暂时不能主动刷新短信库，请确认 Windows 管理器和 ADB 在线。",
    screen_device_offline: "这台手机当前不在线，暂时不能投屏。",
    screen_agent_offline: "负责这台手机的 Windows 管理器尚未连接投屏通道。",
    device_screen_busy: "这台手机已经有一个实时控制会话。",
    lookup_screen_control_active: "实时控屏进行中，请结束控屏后再继续查名字或切换账号。",
    lookup_recovery_required: "当前任务恢复失败，后续队列已暂停；请重试当前任务或结束会话。",
    lookup_human_verification_not_resumable: "当前没有可继续检查的人工验证任务，请刷新会话状态。",
    lookup_human_verification_phone_missing: "原查询号码已缺失，无法安全恢复；请重新输入号码查询。",
    invalid_kuaishou_lead_delay_range: "间隔必须是 30–3600 秒，且最长时间不能小于最短时间。",
    kuaishou_lead_already_active: "已有一个快手录入任务正在消费这份飞书表格，请先停止它。",
    screen_session_not_found: "投屏会话已结束，请重新连接。",
    screen_gallery_import_busy: "这张图片正在导入手机图库，请等待完成。",
    xhs_device_not_available: "当前没有可用的小红书扫码手机。",
    xhs_account_not_available: "这台手机未配置可用的小红书账号。",
    xhs_id_required: "已填写小红书账号名称时，小红书 ID 也必须填写。",
    xhs_account_name_required: "已填写小红书 ID 时，账号名称也必须填写。",
    xhs_id_duplicate_on_device: "同一台手机的两个槽位不能绑定同一个小红书 ID。",
    xhs_id_already_bound: `小红书 ID ${payload.xhsId || ""} 已绑定在 ${payload.conflictDeviceName || payload.conflictDeviceId || "另一台手机"}，不能重复绑定。`,
    account_not_configured: "这台手机未配置可用账号，请联系管理员。",
    phone_not_available: "这个手机号当前不可用或正在等待验证码。",
    user_active_xhs_task_limit_reached: "你的扫码任务已达到上限，请等待已有任务完成。",
    user_waiting_sms_limit_reached: "你的验证码等待任务已达到上限。",
    invalid_credentials: "账号或密码错误。",
    too_many_login_attempts: "密码错误次数过多，请等几分钟后再试。",
    unauthorized: "登录已失效，请重新登录。",
    forbidden_origin: "当前访问来源未被允许。"
  };
  return detail || map[code] || code || `HTTP ${status}`;
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function shortTime(value) {
  if (!value) return "-";
  const diff = Date.now() - new Date(value).getTime();
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function visibleUserXhsTasks() {
  return [...(state.userPendingXhsTasks || []), ...(state.userXhsTasks || [])];
}

function addPendingUserXhsTask(task) {
  state.userPendingXhsTasks = [
    task,
    ...(state.userPendingXhsTasks || []).filter((item) => item.taskId !== task.taskId)
  ];
}

function removePendingUserXhsTask(taskId) {
  state.userPendingXhsTasks = (state.userPendingXhsTasks || []).filter((task) => task.taskId !== taskId);
}

function markPendingUserXhsTaskFailed(taskId, message) {
  state.userPendingXhsTasks = (state.userPendingXhsTasks || []).map((task) => (
    task.taskId === taskId
      ? {
          ...task,
          status: "submit_failed",
          summary: {
            ...(task.summary || {}),
            failureMessage: message || "任务创建失败，请重试"
          }
        }
      : task
  ));
}

function prunePendingUserXhsTasks() {
  const now = Date.now();
  state.userPendingXhsTasks = (state.userPendingXhsTasks || []).filter((task) => {
    const age = now - new Date(task.createdAt || 0).getTime();
    return Number.isFinite(age) && age < 90_000 && task.status !== "submit_failed";
  });
}

function isActiveXhsStatus(status) {
  return ["creating", "queued", "running", "stalled"].includes(String(status || ""));
}

function isUserScanPanelActive() {
  return Boolean(
    state.token &&
    state.page === "user-workbench" &&
    state.userWorkbenchView === "detail" &&
    state.userDetailTab === "scan" &&
    state.userSelectedDeviceId
  );
}

function shouldFastRefreshUserXhsTasks() {
  return isUserScanPanelActive();
}

function shouldFastRefreshUserLookupSessions() {
  return Boolean(
    state.token
    && state.page === "user-workbench"
    && state.userLookupSessions.some((session) => ["starting", "ready", "querying", "switching", "choosing_account", "needs_human_verification", "stopping"].includes(session.status))
  );
}

function currentAppAssetVersion() {
  const script = Array.from(document.scripts).find((item) => {
    try {
      return new URL(item.src, window.location.href).pathname.endsWith("/app.js");
    } catch {
      return false;
    }
  });
  if (!script?.src) return "";
  try {
    return new URL(script.src, window.location.href).searchParams.get("v") || "";
  } catch {
    return "";
  }
}

async function reloadActiveLookupAfterClientUpdate() {
  if (document.visibilityState !== "visible" || clientUpdateCheckPromise) return clientUpdateCheckPromise;
  const currentVersion = currentAppAssetVersion();
  if (!currentVersion) return null;
  clientUpdateCheckPromise = (async () => {
    const response = await fetch(`/?client-version-check=${Date.now()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) return;
    const html = await response.text();
    const latestVersion = html.match(/app\.js\?v=([^\"'&\s<]+)/)?.[1] || "";
    if (!latestVersion || latestVersion === currentVersion) return;
    const lookupActive = state.userLookupBusy
      || state.userLookupEnding
      || state.userLookupSessions.some((session) => ["starting", "ready", "querying", "switching", "choosing_account", "needs_human_verification", "stopping"].includes(session.status));
    if (lookupActive) window.location.reload();
  })();
  try {
    return await clientUpdateCheckPromise;
  } finally {
    clientUpdateCheckPromise = null;
  }
}

function isOnline(value) {
  return value && Date.now() - new Date(value).getTime() < ONLINE_MS;
}

function taskTypeLabel(type) {
  return {
    adb_install_apk: "安装 APK",
    adb_grant_permissions: "授权权限",
    adb_start_agent: "启动 Agent",
    adb_collect_diagnostics: "采集诊断",
    adb_restart_server: "重启 ADB",
    sms_sync_now: "主动同步短信",
    xhs_qr_appium: "小红书 Airtest/Poco 扫码"
  }[type] || type || "ADB 任务";
}

function windowsTaskButtonLabel(type) {
  return {
    adb_install_apk: "旧 APK 安装",
    adb_grant_permissions: "旧 APK 授权",
    adb_start_agent: "旧 Agent 启动"
  }[type] || taskTypeLabel(type);
}

function pageCopy(page) {
  return {
    dashboard: ["总览", "平台、Windows 管理器和手机状态"],
    "user-workbench": ["用户工作台", "查看设备短信库和提交自动化扫码任务"],
    users: ["用户账号", "创建、查看和停用平台用户"],
    windows: ["Windows 管理器", "USB ADB 控制面，负责设备同步、短信库和扫码自动化"],
    devices: ["手机设备", "核对设备资料、账号槽位和上架状态"],
    release: ["APK 发布", "上传或登记手机 Agent APK，供 Windows 自动安装"],
    sms: ["短信库", "按手机查看系统短信，并保留验证码订单闭环"],
    xhs: ["小红书扫码", "上传二维码并派发小红书扫码任务"],
    "workflow-scripts": ["自动化脚本", "维护小红书扫码默认脚本，任务创建时冻结配置"],
    diagnostics: ["诊断检查", "上线前配置、运行状态和联调准备度"],
    audit: ["审计日志", "管理操作、设备同步和任务轨迹"]
  }[page] || ["总览", ""];
}

function rolePage(button) {
  return button.dataset.rolePage || "admin";
}

function allowedPages() {
  if (!state.user) return [];
  const role = state.user.role === "admin" ? "admin" : "user";
  return [...els.pageButtons]
    .filter((button) => rolePage(button) === role || (role === "admin" && rolePage(button) === "user"))
    .map((button) => button.dataset.pageButton);
}

function renderShell() {
  const isAuthenticated = Boolean(state.user);
  document.body.classList.remove("booting");
  document.body.classList.toggle("auth-screen", !isAuthenticated);
  document.body.classList.toggle("admin-chrome", isAuthenticated && state.user?.role === "admin");
  els.loginScreen?.classList.toggle("hidden", isAuthenticated);
  if (!isAuthenticated) return;

  const allowed = allowedPages();
  if (!allowed.includes(state.page)) {
    state.page = allowed[0] || "dashboard";
    localStorage.setItem("phoneCloudPage", state.page);
  }
  const [title, summary] = pageCopy(state.page);
  const userWorkbenchChrome = state.page === "user-workbench";
  const showTopDeviceMetrics = userWorkbenchChrome || (state.user?.role === "admin" && ["dashboard", "devices"].includes(state.page));
  document.body.classList.toggle("user-workbench-chrome", Boolean(userWorkbenchChrome));
  els.defaultTopTitle?.classList.toggle("hidden", Boolean(userWorkbenchChrome));
  els.userTopBrand?.classList.toggle("hidden", !userWorkbenchChrome);
  els.userTopMetrics?.classList.toggle("hidden", !showTopDeviceMetrics);
  els.userTopIdentity?.classList.toggle("hidden", !userWorkbenchChrome);
  els.userTopAdminButton?.classList.toggle("hidden", !userWorkbenchChrome || state.user?.role !== "admin");
  els.topSettingsButton?.classList.toggle("hidden", !userWorkbenchChrome || !state.user);
  els.pageTitle.textContent = title;
  els.pageSummary.textContent = summary;
  els.pageButtons.forEach((button) => {
    const visible = allowed.includes(button.dataset.pageButton);
    button.hidden = !visible;
    button.classList.toggle("active", visible && button.dataset.pageButton === state.page);
  });
  els.pages.forEach((page) => page.classList.toggle("hidden", page.dataset.page !== state.page));
  els.refreshButton.hidden = !state.user || userWorkbenchChrome;
  els.authUserName.textContent = state.user?.displayName || state.user?.username || "未登录";
  els.authUserRole.textContent = state.user ? (state.user.role === "admin" ? "管理员" : "普通用户") : "请登录平台账号";
  if (els.userTopIdentityText) {
    els.userTopIdentityText.textContent = state.user
      ? `${state.user.displayName || state.user.username || "测试用户"} · ${state.user.role === "admin" ? "管理员" : "普通用户"}`
      : "未登录";
  }
  if (els.userTopAvatar) {
    els.userTopAvatar.textContent = String(state.user?.displayName || state.user?.username || "测").trim().slice(0, 1) || "测";
  }
  renderTopDeviceMetrics();
}

function renderTopDeviceMetrics() {
  const usingAdminData = state.user?.role === "admin" && state.page !== "user-workbench";
  const userDevicesLoading = !usingAdminData && state.userDevicesLoading && !state.userDevicesLoadedAt;
  const devices = usingAdminData ? (state.devices || []) : (state.userDevices || []);
  const total = usingAdminData
    ? Number(state.overview?.devices ?? devices.length ?? 0)
    : devices.length;
  const online = usingAdminData
    ? Number(state.overview?.adbOnline ?? devices.filter((device) => device?.adb?.state === "device" || device?.adbOnline).length)
    : devices.filter(userDeviceOnline).length;
  const busy = usingAdminData
    ? (state.xhsTasks || []).filter((task) => ["queued", "running"].includes(task.status)).length
    : devices.filter((device) => device.busy).length;
  const available = usingAdminData
    ? Math.max(0, online - busy)
    : devices.filter((device) => device.available || (userDeviceOnline(device) && !device.busy)).length;

  if (els.userTopTotalDevices) els.userTopTotalDevices.textContent = userDevicesLoading ? "-" : total;
  if (els.userTopAvailableDevices) els.userTopAvailableDevices.textContent = userDevicesLoading ? "-" : available;
  if (els.userTopOnlineDevices) els.userTopOnlineDevices.textContent = userDevicesLoading ? "-" : online;
  if (els.userTopBusyDevices) els.userTopBusyDevices.textContent = userDevicesLoading ? "-" : busy;
}

function renderOverview() {
  renderTopDeviceMetrics();
  const items = [
    ["Windows 管理器", state.overview.onlineAgents ?? 0, `共 ${state.overview.windowsAgents ?? 0} 台`],
    ["ADB 在线手机", state.overview.adbOnline ?? 0, `设备池 ${state.overview.devices ?? 0} 台`],
    ["活跃设备锁", state.overview.deviceLocks ?? 0, "扫码占用中"],
    ["等待验证码", state.overview.waitingSms ?? 0, "短信订单"],
    ["短信库", state.overview.smsLibraryMessages ?? 0, "已同步短信"],
    ["扫码排队", state.overview.xhsQueued ?? 0, `运行中 ${state.overview.xhsRunning ?? 0}`],
    ["扫码成功率", state.overview.xhsSuccessRate === null || state.overview.xhsSuccessRate === undefined ? "-" : `${state.overview.xhsSuccessRate}%`, "已完成任务"]
  ];
  els.overviewGrid.innerHTML = items.map(([label, value, note], index) => `
    <article class="metric metric-${index + 1}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(note)}</small>
    </article>
  `).join("");
}

function renderUserWorkbench() {
  if (!els.userDeviceList) return;
  const devicesLoading = Boolean(state.userDevicesLoading);
  const hasLoadedDevicesOnce = Boolean(state.userDevicesLoadedAt);
  if (state.userSelectedDeviceId && hasLoadedDevicesOnce && !devicesLoading && !state.userDevices.some((device) => device.deviceId === state.userSelectedDeviceId)) {
    state.userSelectedDeviceId = "";
    state.userWorkbenchView = "inventory";
    localStorage.removeItem("phoneCloudUserSelectedDeviceId");
    localStorage.setItem("phoneCloudUserWorkbenchView", state.userWorkbenchView);
  }
  const selectedDevice = state.userDevices.find((device) => device.deviceId === state.userSelectedDeviceId) || null;
  const restoringSelectedDevice = state.userWorkbenchView === "detail" && state.userSelectedDeviceId && devicesLoading && !hasLoadedDevicesOnce;
  const showDeviceDetail = state.userWorkbenchView === "detail" && (selectedDevice || restoringSelectedDevice);
  const filteredDeviceSmsMessages = filterUserDeviceSmsMessages(selectedDevice);
  const onlineCount = state.userDevices.filter(userDeviceOnline).length;
  const availableCount = state.userDevices.filter((device) => device.available || (userDeviceOnline(device) && !device.busy)).length;
  const busyCount = state.userDevices.filter((device) => device.busy).length;
  const searchText = String(state.userDeviceSearch || "").trim().toLowerCase();
  const numericSearch = /^\d+$/.test(searchText);
  const filteredDevices = state.userDevices
    .filter((device) => {
      if (!matchesUserDeviceStatus(device, state.userDeviceFilter)) return false;
      if (state.userDeviceBrandFilter && !userDeviceBrand(device).toLowerCase().includes(state.userDeviceBrandFilter.toLowerCase())) return false;
      if (state.userDeviceAndroidFilter && String(device.androidVersion || "").trim() !== state.userDeviceAndroidFilter) return false;
      if (searchText && !userDeviceSearchText(device).includes(searchText)) return false;
      return true;
    })
    .map((device, index) => ({ device, index }))
    .sort((left, right) => {
      if (!numericSearch) return left.index - right.index;
      return rankUserDeviceSearch(left.device, searchText) - rankUserDeviceSearch(right.device, searchText)
        || left.index - right.index;
    })
    .map(({ device }) => device);

  if (els.userInventorySummary) {
    const staleInventorySuffix = state.userDevicesLoadError && hasLoadedDevicesOnce
      ? " · 本次刷新异常，正在显示上次有效清单"
      : "";
    els.userInventorySummary.textContent = devicesLoading && !hasLoadedDevicesOnce
      ? "正在加载手机库存..."
      : state.userDevicesLoadError && !hasLoadedDevicesOnce
        ? `手机库存加载失败：${state.userDevicesLoadError}`
      : `共 ${state.userDevices.length} 台手机，可用 ${availableCount} 台，在线 ${onlineCount} 台，执行中 ${busyCount} 台${staleInventorySuffix}`;
  }
  renderTopDeviceMetrics();
  els.userDeviceInventoryView?.classList.toggle("hidden", Boolean(showDeviceDetail));
  els.userDeviceDetailView?.classList.toggle("hidden", !showDeviceDetail);
  if (!["sms", "scan", "screen"].includes(state.userDetailTab)) state.userDetailTab = "sms";
  if (els.userDetailTabs) {
    [...els.userDetailTabs.querySelectorAll("[data-user-detail-tab]")].forEach((button) => {
      button.classList.toggle("active", button.dataset.userDetailTab === state.userDetailTab);
    });
  }
  els.userDetailPanels?.forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.userDetailPanel !== state.userDetailTab);
  });
  if (els.userDeviceSearchInput && els.userDeviceSearchInput.value !== state.userDeviceSearch) {
    els.userDeviceSearchInput.value = state.userDeviceSearch;
  }
  syncUserDeviceFilterOptions();
  if (els.userDeviceStatusSelect) els.userDeviceStatusSelect.value = state.userDeviceFilter;
  if (els.userDeviceBrandSelect) els.userDeviceBrandSelect.value = state.userDeviceBrandFilter;
  if (els.userDeviceAndroidSelect) els.userDeviceAndroidSelect.value = state.userDeviceAndroidFilter;
  if (els.userDeviceFilterChips) {
    [...els.userDeviceFilterChips.querySelectorAll("[data-user-device-filter]")].forEach((button) => {
      const active = button.dataset.userDeviceFilter === state.userDeviceFilter;
      button.classList.toggle("active", active);
      button.classList.toggle("is-active", active);
    });
  }

  if (els.userDeviceList) {
    els.userDeviceList.innerHTML = devicesLoading && !hasLoadedDevicesOnce
      ? renderUserDeviceInventoryLoading()
      : state.userDevicesLoadError && !hasLoadedDevicesOnce
        ? `<div class="empty user-device-empty"><b>手机库存暂时无法加载</b><span>${escapeHtml(state.userDevicesLoadError)}</span></div>`
      : filteredDevices.length
        ? filteredDevices.map((device) => renderUserDeviceCard(device)).join("")
        : `<div class="empty user-device-empty">没有匹配的手机。</div>`;
  }

  renderUserDeviceSwitcher(selectedDevice, showDeviceDetail);

  if (els.userDeviceTitle) els.userDeviceTitle.textContent = selectedDevice ? selectedDevice.deviceName || selectedDevice.deviceId : "手机详情";
  if (els.userDeviceDetailStatus) {
    els.userDeviceDetailStatus.className = `status-pill ${selectedDevice ? userDeviceStatusClass(selectedDevice) : ""}`;
    els.userDeviceDetailStatus.textContent = selectedDevice ? userDeviceStatusLabel(selectedDevice) : "未选择";
  }
  if (els.userDeviceStatusPills) {
    els.userDeviceStatusPills.innerHTML = selectedDevice
      ? renderDeviceStatusPills(selectedDevice)
      : `<span class="status-pill">未选择</span>`;
  }
  if (els.userDeviceDetailMeta) {
    els.userDeviceDetailMeta.textContent = selectedDevice
      ? [selectedDevice.model || "未知型号", selectedDevice.androidVersion ? `Android ${selectedDevice.androidVersion}` : "", selectedDevice.adbSerial || selectedDevice.deviceId].filter(Boolean).join(" · ")
      : "这台手机的短信库和扫码任务。";
  }
  if (els.userDeviceDetail) {
    els.userDeviceDetail.innerHTML = selectedDevice
      ? renderUserDeviceDetailPanel(selectedDevice)
      : `<div class="empty">选择一台在线手机查看详情。</div>`;
  }
  if (els.userDeviceAutomationStatus) {
    els.userDeviceAutomationStatus.innerHTML = selectedDevice ? renderAutomationChecks(selectedDevice) : "";
  }

  const automationTargets = selectedDevice ? automationTargetsForDevice(selectedDevice) : [];
  if (els.userAutomationTargetSelect) {
    els.userAutomationTargetSelect.innerHTML = automationTargets.length
      ? automationTargets.map((target) => `<option value="${escapeHtml(target.value)}" ${target.disabled ? "disabled" : ""}>${escapeHtml(target.label)}${target.description ? ` · ${escapeHtml(target.description)}` : ""}</option>`).join("")
      : `<option value="">这台手机暂无可用自动化账号</option>`;
    applyRememberedAutomationTarget(selectedDevice, automationTargets);
  }
  if (els.userAutomationTargetCards) {
    els.userAutomationTargetCards.innerHTML = selectedDevice ? renderAutomationTargetCards(automationTargets) : `<div class="empty compact-empty">选择一台手机后显示可用账号。</div>`;
    syncScanTargetCards();
  }
  if (els.userXhsTaskForm) {
    const submitButton = els.userXhsTaskForm.querySelector(".scan-submit-button");
    const hasAvailableTarget = automationTargets.some((target) => !target.disabled && target.platform === "xhs");
    const disabledReason = !selectedDevice
      ? "请先选择一台手机"
      : selectedDevice.busy
        ? "这台手机正在执行任务"
        : !hasAvailableTarget
          ? "这台手机未配置可用小红书账号"
          : !automationReadyForDevice(selectedDevice)
            ? automationIssueLabel(selectedDevice)
            : "";
    if (submitButton) {
      submitButton.disabled = Boolean(disabledReason) || Boolean(state.userXhsSubmitting);
      submitButton.classList.toggle("is-loading", Boolean(state.userXhsSubmitting));
      submitButton.textContent = state.userXhsSubmitting ? "正在提交任务..." : (disabledReason || "提交扫码任务");
      submitButton.title = disabledReason;
    }
  }
  if (els.userSmsSearchInput && els.userSmsSearchInput.value !== state.userSmsSearch) {
    els.userSmsSearchInput.value = state.userSmsSearch;
  }
  if (els.userSmsCodeOnlyToggle) {
    els.userSmsCodeOnlyToggle.checked = Boolean(state.userSmsCodeOnly);
  }
  if (els.userSmsSimFilter) {
    const simOptions = selectedDevice
      ? (selectedDevice.sims || []).map((sim, index) => {
          const value = String(sim.slotIndex ?? index);
          const label = sim.label || `SIM ${Number(sim.slotIndex ?? index) + 1}`;
          return `<option value="${escapeHtml(value)}">${escapeHtml(label)}${sim.phoneNumber ? ` · ${escapeHtml(displayPhoneNumber(sim.phoneNumber))}` : ""}</option>`;
        }).join("")
      : "";
    els.userSmsSimFilter.innerHTML = `<option value="">全部 SIM</option>${simOptions}`;
    els.userSmsSimFilter.value = state.userSmsSimFilter;
  }

  if (els.userDeviceSmsHint) {
    const pageSize = normalizedUserSmsPageSize();
    const pageStart = state.userDeviceSmsTotal ? (Math.max(1, state.userSmsPage) - 1) * pageSize + 1 : 0;
    const pageEnd = Math.min(state.userDeviceSmsTotal || 0, pageStart + filteredDeviceSmsMessages.length - 1);
    els.userDeviceSmsHint.textContent = selectedDevice
      ? `${selectedDevice.deviceName || selectedDevice.deviceId} · 本机短信库 · 共 ${state.userDeviceSmsTotal || 0} 条，当前 ${pageStart}-${pageEnd}`
      : "选择一台在线手机后查看。";
  }
  updateUserSmsRefreshButton(selectedDevice);
  if (els.userDeviceSmsList) {
    const isLoadingSelectedSms = state.userDeviceSmsLoading && state.userDeviceSmsLoadingDeviceId === state.userSelectedDeviceId;
    els.userDeviceSmsList.innerHTML = isLoadingSelectedSms && !filteredDeviceSmsMessages.length && !state.userDeviceSmsTotal
      ? `<div class="sms-loading-state"><span class="inline-spinner"></span><b>正在加载这台手机的短信库</b></div>`
      : filteredDeviceSmsMessages.length
        ? `${isLoadingSelectedSms ? `<div class="sms-library-updating"><span class="inline-spinner"></span>正在更新短信库</div>` : ""}${renderUserSmsTable(filteredDeviceSmsMessages)}`
        : state.userSmsLoadError
          ? `<div class="empty sms-load-error"><b>短信库暂时未加载</b><span>${escapeHtml(state.userSmsLoadError)}</span></div>`
          : `<div class="empty">暂无短信记录。请等待 Windows 管理器完成短信同步，或确认这台手机短信库本身为空。</div>`;
  }
  if (els.userSmsPagination) {
    els.userSmsPagination.innerHTML = selectedDevice ? renderUserSmsPagination() : "";
  }

  const selectedDeviceXhsTasks = selectedDevice
    ? visibleUserXhsTasks().filter((task) => task.deviceId === selectedDevice.deviceId)
    : [];
  if (els.userXhsList) els.userXhsList.innerHTML = selectedDeviceXhsTasks.length
    ? selectedDeviceXhsTasks.map((task) => renderUserXhsTaskCard(task)).join("")
    : `<div class="empty scan-empty-state">暂无扫码任务。上传二维码后，这里会显示执行步骤和结果。</div>`;
  if (!["scan", "publish", "kuaishou", "name"].includes(state.userAutomationModule)) state.userAutomationModule = "scan";
  els.userAutomationModuleTabs?.querySelectorAll("[data-automation-module]").forEach((button) => {
    const active = button.dataset.automationModule === state.userAutomationModule;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  els.userAutomationModulePanels?.forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.automationModulePanel !== state.userAutomationModule);
  });
  if (els.userPublishTargetSelect) {
    const publishTargets = automationTargets.filter((target) => target.platform === "xhs");
    els.userPublishTargetSelect.innerHTML = publishTargets.length
      ? publishTargets.map((target) => `<option value="${escapeHtml(target.value)}" ${target.disabled ? "disabled" : ""}>${escapeHtml(target.label)}${target.description ? ` · ${escapeHtml(target.description)}` : ""}</option>`).join("")
      : `<option value="">这台手机暂无可用小红书账号</option>`;
    const remembered = state.userAutomationTargetByDevice?.[selectedDevice?.deviceId || ""];
    if (remembered && publishTargets.some((target) => target.value === remembered && !target.disabled)) els.userPublishTargetSelect.value = remembered;
  }
  if (els.userPublishSubmitButton) {
    const disabled = !selectedDevice || selectedDevice.busy || !automationReadyForDevice(selectedDevice) || state.userPublishSubmitting;
    els.userPublishSubmitButton.disabled = disabled;
    els.userPublishSubmitButton.innerHTML = `<span>${state.userPublishSubmitting ? "正在创建..." : "开始发布"}</span><i aria-hidden="true">→</i>`;
  }
  const selectedPublishTasks = selectedDevice
    ? state.userPublishTasks.filter((task) => task.deviceId === selectedDevice.deviceId)
    : [];
  if (els.userPublishTaskList) els.userPublishTaskList.innerHTML = selectedPublishTasks.length
    ? selectedPublishTasks.map(renderAutomationJobCard).join("")
    : `<div class="empty scan-empty-state">暂无发布记录。</div>`;
  renderKuaishouLead(selectedDevice);
  const lookupSession = selectedDevice ? activeLookupSessionForDevice(selectedDevice.deviceId) : null;
  renderLookupSession(lookupSession, selectedDevice);
  renderUserScreenControl(selectedDevice);
  notifyLookupHumanVerification(lookupSession, selectedDevice);
}

function activeKuaishouLeadTask(deviceId = "") {
  return state.userKuaishouTasks.find((task) => task.deviceId === deviceId && ["queued", "running", "stalled"].includes(task.status)) || null;
}

function renderKuaishouLead(device) {
  const tasks = device ? state.userKuaishouTasks.filter((task) => task.deviceId === device.deviceId) : [];
  const active = activeKuaishouLeadTask(device?.deviceId || "");
  const progress = active?.result?.progress || tasks[0]?.result?.progress || {};
  const status = active?.status || tasks[0]?.status || "idle";
  const statusText = ({ queued: "等待 Windows 管理器", running: "持续扫描中", stalled: "管理器离线，等待恢复", failed: "任务异常停止", cancelled: "已由用户停止", expired: "任务已过期", idle: "尚未启动" })[status] || status;
  const lastMessage = active?.events?.at(-1)?.message || tasks[0]?.events?.at(-1)?.message || (active ? "正在准备飞书消费器" : "选择间隔范围后启动飞书队列");
  if (els.userKuaishouStatus) {
    els.userKuaishouStatus.dataset.state = status === "running" ? "ready" : status;
    els.userKuaishouStatus.innerHTML = `<i></i><div><strong>${escapeHtml(statusText)}</strong><span>${escapeHtml(lastMessage)}</span></div>`;
  }
  const controlsDisabled = Boolean(active) || state.userKuaishouBusy;
  if (els.userKuaishouMinDelay) els.userKuaishouMinDelay.disabled = controlsDisabled;
  if (els.userKuaishouMaxDelay) els.userKuaishouMaxDelay.disabled = controlsDisabled;
  if (els.userKuaishouStartButton) {
    els.userKuaishouStartButton.disabled = !device || Boolean(device.busy) || controlsDisabled || !automationReadyForDevice(device);
    els.userKuaishouStartButton.innerHTML = `<span>${state.userKuaishouBusy && !active ? "正在启动..." : "启动快手录入"}</span><i aria-hidden="true">→</i>`;
  }
  if (els.userKuaishouStopButton) {
    els.userKuaishouStopButton.disabled = !active || state.userKuaishouBusy;
    els.userKuaishouStopButton.textContent = state.userKuaishouBusy && active ? "正在停止..." : "停止任务";
  }
  if (els.userKuaishouTaskList) {
    els.userKuaishouTaskList.innerHTML = tasks.length ? tasks.map((task) => {
      const taskProgress = task.result?.progress || {};
      const taskStatus = ({ queued: "排队中", running: "运行中", stalled: "待恢复", failed: "异常停止", cancelled: "已停止", expired: "已过期" })[task.status] || task.status;
      const message = task.events?.at(-1)?.message || task.result?.message || "等待执行";
      const nextRun = taskProgress.nextRunAt ? ` · 下次 ${shortTime(taskProgress.nextRunAt)}` : "";
      return `<article class="scan-task-card is-${escapeHtml(task.status || "queued")}">
        <div class="scan-task-head"><div><strong>快手录入</strong><span>${escapeHtml(task.minDelaySeconds)}–${escapeHtml(task.maxDelaySeconds)} 秒间隔</span></div><em class="${task.status === "running" ? "ok" : ["failed", "expired"].includes(task.status) ? "bad" : "warn"}">${escapeHtml(taskStatus)}</em></div>
        <div class="kuaishou-progress-facts"><span>已处理<b>${Math.max(0, Number(taskProgress.processedCount || 0))}</b></span><span>成功<b>${Math.max(0, Number(taskProgress.successCount || 0))}</b></span><span>提交前失败<b>${Math.max(0, Number(taskProgress.failedAttemptCount || 0))}</b></span><span>安全跳过<b>${Math.max(0, Number(taskProgress.skippedCount || 0))}</b></span></div>
        <p>${escapeHtml(message)}${escapeHtml(nextRun)}</p><small>${escapeHtml(shortTime(task.updatedAt || task.createdAt))}</small>
      </article>`;
    }).join("") : `<div class="empty scan-empty-state">暂无快手录入任务。启动后会持续等待飞书中的新数据。</div>`;
  }
}

function renderAutomationJobCard(job) {
  const status = String(job.status || "queued");
  const statusText = ({ queued: "排队中", running: "执行中", succeeded: "已完成", failed: "失败", cancelled: "已取消", expired: "已过期" })[status] || status;
  const message = job.result?.message || job.result?.error || job.events?.at(-1)?.message || "等待 Windows 管理器处理";
  return `<article class="scan-task-card is-${escapeHtml(status)}">
    <div class="scan-task-head"><div><strong>${escapeHtml(job.title || "小红书图文发布")}</strong><span>${escapeHtml(job.xhsAccountLabel || job.xhsAppSlot || "小红书")}</span></div><em class="${status === "succeeded" ? "ok" : ["failed", "expired"].includes(status) ? "bad" : "warn"}">${escapeHtml(statusText)}</em></div>
    <p>${escapeHtml(message)}</p><small>${escapeHtml(shortTime(job.updatedAt || job.createdAt))}</small>
  </article>`;
}

function activeLookupSessionForDevice(deviceId) {
  return state.userLookupSessions.find((session) => session.deviceId === deviceId && ["starting", "ready", "querying", "switching", "choosing_account", "needs_human_verification", "stopping"].includes(session.status))
    || state.userLookupSessions.find((session) => session.deviceId === deviceId)
    || null;
}

function bumpUserLookupSyncVersion() {
  userLookupSyncVersion += 1;
  return userLookupSyncVersion;
}

function upsertUserLookupSession(session, options = {}) {
  if (!session?.sessionId) return;
  const current = state.userLookupSessions.find((item) => item.sessionId === session.sessionId);
  if (options.preserveStopping && current?.status === "stopping") return;
  state.userLookupSessions = [
    session,
    ...state.userLookupSessions.filter((item) => item.sessionId !== session.sessionId)
  ];
}

function canApplyLookupRefresh(syncVersion) {
  return syncVersion === userLookupSyncVersion && !state.userLookupBusy && !state.userLookupEnding;
}

async function copyLookupTailToClipboard(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("没有可复制的姓名尾字");
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // HTTP deployments and restrictive browser policies use the synchronous fallback below.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.inset = "-1000px auto auto -1000px";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("浏览器未允许复制，请手动复制尾字");
}

function renderLookupSession(session, device) {
  const active = session && ["starting", "ready", "querying", "switching", "choosing_account", "needs_human_verification", "stopping"].includes(session.status);
  const adminOverride = session?.operatorMode === "admin_override";
  const ready = session?.status === "ready" && !session.pendingJobId && !session.requiresAccountSwitch;
  const choosingAccount = session?.status === "choosing_account" && !session.pendingJobId;
  const lookupScreenControlActive = Boolean(
    device?.screenControlBusy
    || (state.userScreenDeviceId === device?.deviceId
      && ["connecting", "preparing", "ready", "live", "streaming"].includes(state.userScreenStatus))
  );
  const results = session?.results || [];
  const humanVerificationResult = resumableLookupHumanVerificationResult(session);
  const recoveryResult = resumableLookupRecoveryResult(session);
  const lookupBlocked = Boolean(humanVerificationResult || recoveryResult);
  const humanResumeAvailable = Boolean(
    humanVerificationResult
  );
  const runningResult = results.find((result) => ["submitting", "queued", "running", "cancelling"].includes(result.status));
  const runningSince = new Date(runningResult?.createdAt || 0).getTime();
  const runningElapsedMs = Number.isFinite(runningSince) && runningSince > 0 ? Math.max(0, Date.now() - runningSince) : 0;
  const runningStage = runningResult?.stage || "查询任务已提交";
  const startedAt = new Date(session?.createdAt || 0).getTime();
  const startingSeconds = Number.isFinite(startedAt) && startedAt > 0
    ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
    : 0;
  const statusCopy = {
    starting: ["正在检查账户", `正在识别当前账户、检查冷却并准备搜索页 · 已等待 ${startingSeconds} 秒`],
    ready: [session?.error ? "需要处理后重试" : "查询会话已就绪", session?.error || `已成功查询 ${session?.successfulCount || 0} 个号码`],
    querying: ["正在查询", `${runningStage} · 已用 ${formatDurationMs(runningElapsedMs)}`],
    switching: ["正在处理账号", "正在读取账号列表或复核指定账号"],
    choosing_account: ["请选择支付宝账号", `已读取 ${session?.accountChoices?.length || 0} 个已保存账号`],
    needs_human_verification: ["当前号码等待人工验证", "请进入实时控屏完成拼图，系统检测通过后自动重查原号码"],
    stopping: ["正在结束", "正在释放手机"],
    failed: ["会话异常结束", session?.error || "请重新开始"],
    ended: ["会话已结束", `本次成功 ${session?.successfulCount || 0} 个号码`],
    expired: ["会话已过期", "请重新开始"]
  };
  const copy = humanResumeAvailable
    ? ["当前号码等待人工验证", "发起者或管理员可进入实时控屏；验证通过后系统自动交接并重查原号码"]
    : statusCopy[session?.status] || ["尚未开始", "点击开始建立查询会话"];
  if (humanVerificationResult?.phase === "start") {
    copy[0] = "账户准备等待人工验证";
    copy[1] = "请进入实时控屏完成拼图，系统检测通过后继续准备账户。";
  }
  if (recoveryResult) { copy[0] = "当前任务恢复失败"; copy[1] = session.error || "后续队列已暂停，请重试当前任务。"; }
  if (!humanResumeAvailable && (session?.requiresAccountSwitch || session?.error?.includes("当前手机无可用账户"))) {
    copy[0] = "当前手机无可用账户";
    copy[1] = session.error || "已保存账户全部冷却中，请查看冷却结束时间，稍后重新建立会话。";
  }
  if (!humanResumeAvailable && session?.status === "ready" && session?.lastAccountSwitch?.toAccount && !session.error) {
    const fromAccount = session.lastAccountSwitch.fromAccount || "上一账号";
    copy[1] = `已从 ${fromAccount} 切换至 ${session.lastAccountSwitch.toAccount}`;
  }
  if (els.userLookupSessionStatus) {
    els.userLookupSessionStatus.dataset.state = session?.status || "idle";
    els.userLookupSessionStatus.innerHTML = `<i></i><div><strong>${escapeHtml(copy[0])}</strong><span>${escapeHtml(copy[1])}</span></div>`;
  }
  if (els.userLookupStartButton) {
    els.userLookupStartButton.disabled = Boolean(active) || !device || device.busy || state.userLookupBusy;
    els.userLookupStartButton.innerHTML = `<span>${session?.status === "starting" ? "启动中..." : "启动查询会话"}</span><i aria-hidden="true">→</i>`;
  }
  if (els.userLookupCurrentAccount) {
    els.userLookupCurrentAccount.textContent = session?.currentAccount || "尚未识别";
  }
  if (els.userLookupSwitchButton) {
    els.userLookupSwitchButton.disabled = adminOverride || lookupBlocked || (!ready && !choosingAccount) || state.userLookupBusy || state.userLookupEnding || lookupScreenControlActive;
    els.userLookupSwitchButton.textContent = session?.status === "switching" ? "处理中..." : choosingAccount ? "重新读取账号" : "选择切换账号";
  }
  if (els.userLookupAccountChooser) {
    els.userLookupAccountChooser.hidden = !choosingAccount;
  }
  if (els.userLookupAccountList) {
    const choices = Array.isArray(session?.accountChoices) ? session.accountChoices : [];
    els.userLookupAccountList.innerHTML = choices.map((choice, index) => {
      const current = Boolean(choice.current);
      const cooling = choice.cooling === true;
      return `<button type="button" class="lookup-account-choice ${current ? "is-current" : ""}" data-lookup-account-choice="${escapeHtml(choice.account || "")}" ${current || cooling ? "disabled" : ""}><span><small>账号 ${index + 1}</small><strong>${escapeHtml(choice.account || "未知账号")}</strong></span><em>${cooling ? "冷却中，不可切换" : current ? "当前" : "切换到此账号"}</em></button>`;
    }).join("") || `<div class="empty scan-empty-state">没有读取到可切换账号，请重新读取。</div>`;
  }
  if (els.userLookupCooldownRows) {
    const rows = Array.isArray(session?.accountCooldowns) ? session.accountCooldowns : [];
    if (els.userLookupCooldownPanel) els.userLookupCooldownPanel.hidden = !rows.length;
    const dateLabel = (value) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "待确认";
    els.userLookupCooldownRows.innerHTML = rows.map((row) => {
      const minutes = Math.max(1, Math.ceil(Number(row.remainingMs || 0) / 60000));
      const remaining = minutes >= 60 ? `${Math.floor(minutes / 60)}小时${minutes % 60}分` : `${minutes}分钟`;
      return `<tr><th scope="row">${escapeHtml(row.account)}</th><td>${escapeHtml(dateLabel(row.limitedAt))}</td><td>${escapeHtml(dateLabel(row.cooldownUntil))}<small>${row.cooling ? `冷却中 · 剩余${remaining}` : "冷却已到期 · 可再次尝试"}</small></td></tr>`;
    }).join("");
  }
  if (els.userLookupPhoneInput) els.userLookupPhoneInput.disabled = adminOverride || lookupBlocked || !ready || state.userLookupBusy || state.userLookupEnding || lookupScreenControlActive;
  if (els.userLookupQueryButton) els.userLookupQueryButton.disabled = adminOverride || lookupBlocked || !ready || state.userLookupBusy || state.userLookupEnding || lookupScreenControlActive;
  if (els.userLookupHumanResumePanel) els.userLookupHumanResumePanel.hidden = !lookupBlocked;
  if (els.userLookupHumanResumeButton) {
    els.userLookupHumanResumeButton.hidden = true;
    els.userLookupHumanResumeButton.disabled = true;
  }
  if (els.userLookupRecoveryRetryButton) {
    els.userLookupRecoveryRetryButton.disabled = !recoveryResult || state.userLookupBusy || state.userLookupEnding || lookupScreenControlActive;
    els.userLookupRecoveryRetryButton.hidden = !recoveryResult;
    els.userLookupRecoveryRetryButton.textContent = recoveryResult?.phase === "start" ? "重试账户准备" : "重试当前号码";
  }
  const humanPanelTitle = els.userLookupHumanResumePanel?.querySelector?.("strong");
  const humanPanelText = els.userLookupHumanResumePanel?.querySelector?.("small");
  if (humanPanelTitle) humanPanelTitle.textContent = recoveryResult ? "当前任务恢复失败" : humanVerificationResult?.phase === "start" ? "账户准备等待人工验证" : "当前号码等待人工验证";
  if (humanPanelText) humanPanelText.textContent = recoveryResult
    ? "后续队列保持暂停。重试将继续当前任务，也可以结束会话。"
    : humanVerificationResult?.phase === "start" ? "请进入实时控屏完成拼图，系统检测通过后继续准备账户，无需确认。"
    : "请进入实时控屏完成拼图。系统检测通过后重查原号码，无需确认。";
  if (els.userLookupEndButton) {
    els.userLookupEndButton.disabled = adminOverride || !active || session?.status === "stopping" || state.userLookupEnding;
    els.userLookupEndButton.textContent = session?.status === "stopping" || state.userLookupEnding ? "结束中..." : "结束会话";
  }
  if (els.userLookupHint && session) {
    const hint = {
      starting: `支付宝正在准备查询页，已等待 ${startingSeconds} 秒，请勿重复点击。`,
      ready: session.error || (session.lastAccountSwitch?.toAccount
        ? `账号切换成功：${session.lastAccountSwitch.fromAccount || "上一账号"} → ${session.lastAccountSwitch.toAccount}，可以继续查询。`
        : session.successfulCount > 0 ? "查询完成，可以继续输入下一个手机号。" : "查询会话已就绪，可以输入手机号。"),
      querying: `${runningStage}，已用 ${formatDurationMs(runningElapsedMs)}。`,
      switching: "正在读取支付宝账号元素或复核你指定的账号，请保持手机连接。",
      choosing_account: session.error || "账号列表已读取，请明确选择要切换的账号；标记“当前”的账号不可重复选择。",
      stopping: "正在结束查询会话并释放手机。",
      failed: session.error || "查询会话启动失败，请重新开始。",
      ended: "查询会话已结束。",
      expired: "查询会话已过期，请重新开始。"
    }[session.status];
    if (hint) els.userLookupHint.textContent = lookupScreenControlActive && ["ready", "choosing_account"].includes(session.status)
      ? "实时控屏中；结束控屏后可继续提交查名字或切换账号。"
      : hint;
    if (recoveryResult) els.userLookupHint.textContent = session.error || "当前任务恢复失败，后续队列已暂停，请重试当前任务。";
    if (humanResumeAvailable) els.userLookupHint.textContent = lookupScreenControlActive
      ? "请人工完成拼图，无需点击确认；系统连续检测通过后会自动结束这次控屏，清空搜索框并重查原号码。当前号码和后续队列保持暂停。"
      : "检测到拼图，需要人工介入；任务发起者或管理员可进入实时控屏。系统自动检测验证消失后清空搜索框并重查原号码，不跳过当前任务。";
  }
  if (els.userLookupResultList) {
    const previousFirstResultId = els.userLookupResultList.dataset.firstResultId || "";
    const previousScrollTop = els.userLookupResultList.scrollTop;
    const nextFirstResultId = String(results[0]?.resultId || "");
    els.userLookupResultList.innerHTML = results.length
      ? results.map((result, index) => {
        const failed = result.status === "failed" || result.status === "needs_recovery";
        const notFound = result.status === "not_found";
        const needsHuman = result.status === "needs_human_verification";
        const limitReached = result.status === "limit_reached";
        const cancelled = result.status === "cancelled";
        const running = ["submitting", "queued", "running", "cancelling"].includes(result.status);
        const lookupTail = String(result.realNameTailCharacter || "").trim();
        const copyableTail = result.status === "succeeded" && Boolean(lookupTail);
        const copied = copyableTail && copiedLookupResultId === result.resultId;
        const resultStartedAt = new Date(result.createdAt || 0).getTime();
        const liveDurationMs = Number.isFinite(resultStartedAt) && resultStartedAt > 0 ? Math.max(0, Date.now() - resultStartedAt) : 0;
        const durationMs = running ? liveDurationMs : Math.max(0, Number(result.durationMs || 0));
        const durationSuffix = durationMs > 0 ? ` · ${formatDurationMs(durationMs)}` : "";
        const detail = running
          ? `${result.stage || (result.status === "cancelling" ? "正在取消查询" : "查询任务已提交")}${durationSuffix}`
          : cancelled
            ? `${result.error || "查询已取消"}${durationSuffix}`
            : notFound
              ? `${result.stage || "未查询到姓名"}${durationSuffix}`
            : failed || needsHuman || limitReached
            ? `${result.error || (needsHuman ? "请在手机完成验证后重试" : limitReached ? "当前账号已触发查询限制，请手动切号" : "查询失败")}${durationSuffix}`
            : `${result.name || `*${result.realNameTailCharacter || ""}`}${durationSuffix}`;
        const rowClass = running ? "is-running" : failed ? "is-failed" : notFound ? "is-not-found" : needsHuman || limitReached ? "is-attention" : cancelled ? "is-cancelled" : "";
        const resultMark = running
          ? `<i class="lookup-result-spinner" aria-label="查询进行中"></i>`
          : escapeHtml(cancelled ? "×" : notFound ? "—" : result.realNameTailCharacter || "-");
        const tailAction = copyableTail
          ? `<button class="lookup-tail-copy ${copied ? "is-copied" : ""}" type="button" data-lookup-copy-result-id="${escapeHtml(result.resultId || "")}" aria-label="复制姓名尾字 ${escapeHtml(lookupTail)}"><b>${escapeHtml(lookupTail)}</b><span>${copied ? "已复制" : "复制"}</span></button>`
          : `<b class="lookup-result-mark">${resultMark}</b>`;
        return `<article class="lookup-result-row ${rowClass}" data-lookup-result-id="${escapeHtml(result.resultId || "")}"><span>${results.length - index}</span><div><strong>${escapeHtml(result.phoneNumber || "")}</strong><small>${escapeHtml(detail)}</small></div>${tailAction}<time>${escapeHtml(shortTime(result.updatedAt || result.createdAt))}</time></article>`;
      }).join("")
      : `<div class="empty scan-empty-state">暂无返回信息。</div>`;
    els.userLookupResultList.dataset.firstResultId = nextFirstResultId;
    if (nextFirstResultId && nextFirstResultId === previousFirstResultId) {
      els.userLookupResultList.scrollTop = previousScrollTop;
    }
  }
}

function renderUserScreenControl(device) {
  if (!els.userScreenStatus) return;
  const session = state.userScreenSession;
  const ownsActiveSession = Boolean(session && state.userScreenDeviceId === device?.deviceId && ["connecting", "preparing", "ready", "live", "streaming"].includes(state.userScreenStatus));
  const live = ["live", "streaming"].includes(state.userScreenStatus);
  const unavailableReason = !device
    ? "请先选择一台手机"
    : !device.adbOnline
      ? "手机 ADB 离线"
      : !device.screenControlAvailable
        ? "Windows 管理器投屏通道未连接"
        : device.busy && !ownsActiveSession && !device.screenControlConcurrentLookupAllowed
          ? (device.busyReasons || ["手机正在执行其他任务"])[0]
          : "";
  els.userScreenStatus.dataset.state = state.userScreenStatus;
  els.userScreenStatus.textContent = state.userScreenDetail || "等待连接";
  els.userScreenStartButton.disabled = Boolean(unavailableReason) || ownsActiveSession || state.userScreenStarting;
  els.userScreenStartButton.textContent = state.userScreenStarting ? "正在建立连接..." : ownsActiveSession ? "投屏已启动" : "开始投屏";
  els.userScreenStartButton.title = unavailableReason;
  els.userScreenWakeButton.disabled = Boolean(unavailableReason) || state.userScreenStarting || (ownsActiveSession && !live);
  els.userScreenWakeButton.title = unavailableReason || (live ? "点亮手机屏幕，不会关闭已亮屏幕" : "建立投屏并自动点亮手机屏幕");
  els.userScreenStopButton.disabled = !ownsActiveSession && !state.userScreenStarting;
  const galleryImport = state.userScreenGalleryImport;
  if (els.userScreenGalleryFileInput) {
    els.userScreenGalleryFileInput.disabled = !live || isUserScreenGalleryImportActive();
  }
  if (els.userScreenGalleryPasteButton) {
    els.userScreenGalleryPasteButton.disabled = !live || isUserScreenGalleryImportActive();
  }
  if (els.userScreenGalleryPasteZone) {
    els.userScreenGalleryPasteZone.contentEditable = live && !isUserScreenGalleryImportActive() ? "true" : "false";
    els.userScreenGalleryPasteZone.classList.toggle("is-disabled", !live || isUserScreenGalleryImportActive());
  }
  const galleryDraft = state.userScreenGalleryDraftFile;
  els.userScreenGalleryImport?.classList.toggle("has-draft", Boolean(galleryDraft));
  if (els.userScreenGalleryDraft) {
    els.userScreenGalleryDraft.hidden = !galleryDraft;
  }
  if (els.userScreenGalleryPreview && galleryDraft) {
    els.userScreenGalleryPreview.src = state.userScreenGalleryDraftDataUrl;
  }
  if (els.userScreenGalleryFileName) {
    els.userScreenGalleryFileName.textContent = galleryDraft?.name || "未选择图片";
  }
  if (els.userScreenGalleryFileMeta) {
    els.userScreenGalleryFileMeta.textContent = galleryDraft ? `${galleryDraft.type || "图片"} · ${formatScreenGalleryFileSize(galleryDraft.size)}` : "";
  }
  if (els.userScreenGalleryClearButton) {
    els.userScreenGalleryClearButton.disabled = !galleryDraft || isUserScreenGalleryImportActive();
  }
  if (els.userScreenGalleryConfirmButton) {
    els.userScreenGalleryConfirmButton.disabled = !live || !galleryDraft || isUserScreenGalleryImportActive();
  }
  if (els.userScreenGalleryImportStatus) {
    const galleryMessage = galleryImport?.result?.message || "";
    els.userScreenGalleryImportStatus.dataset.state = galleryImport?.status || "idle";
    els.userScreenGalleryImportStatus.textContent = !live
      ? "连接手机画面后可导入 PNG、JPEG 或 WebP 图片。"
      : state.userScreenGalleryImporting
        ? "正在将图片推送到手机图库..."
        : galleryImport?.status === "queued"
          ? "图片已提交，正在等待 Windows 管理器处理。"
          : galleryImport?.status === "running"
            ? "正在导入图片到手机图库..."
            : galleryImport?.status === "succeeded"
              ? (galleryMessage || "图片已导入手机图库。")
              : galleryImport?.status === "failed"
                ? (galleryMessage || "图片导入失败，请重试。")
                : state.userScreenGalleryDraftError
                  ? state.userScreenGalleryDraftError
                  : galleryDraft
                    ? "图片已暂存，确认后将导入手机图库。"
                    : "选择或粘贴图片后会展开预览，确认后才导入手机相册。";
  }
  const screenConnecting = ["connecting", "preparing", "ready"].includes(state.userScreenStatus);
  const screenFailed = state.userScreenStatus === "failed";
  if (els.userScreenOverlay) {
    const overlayTitle = {
      connecting: "正在连接手机画面",
      preparing: "正在准备手机画面",
      ready: "正在等待视频首帧",
      failed: "连接手机画面失败"
    }[state.userScreenStatus] || "";
    els.userScreenOverlay.hidden = !screenConnecting && !screenFailed;
    els.userScreenOverlay.dataset.state = state.userScreenStatus;
    if (els.userScreenOverlayTitle) els.userScreenOverlayTitle.textContent = overlayTitle;
    if (els.userScreenOverlayDetail) els.userScreenOverlayDetail.textContent = state.userScreenDetail || (screenFailed ? "请重新连接后再试。" : "请保持当前页面打开。");
    if (els.userScreenOverlaySpinner) els.userScreenOverlaySpinner.hidden = screenFailed;
    if (els.userScreenReconnectButton) els.userScreenReconnectButton.hidden = !screenFailed;
  }
  els.userScreenPlaceholder.hidden = live || screenConnecting || screenFailed;
  els.userScreenNavigationButtons?.forEach((button) => { button.disabled = !live; });
  if (els.userScreenHint) {
    const metrics = state.userScreenMetrics || {};
    const liveMetrics = [
      Number(metrics.fps) > 0 ? `${Number(metrics.fps).toFixed(0)} FPS` : "",
      Number.isFinite(metrics.bufferSeconds) ? `缓冲 ${Math.round(Number(metrics.bufferSeconds) * 1000)}ms` : "",
      Number.isFinite(metrics.controlRttMs) ? `控制 ${Math.round(Number(metrics.controlRttMs))}ms` : ""
    ].filter(Boolean).join(" · ");
    els.userScreenHint.textContent = unavailableReason
      ? unavailableReason
      : live
        ? `实时控制已连接。${liveMetrics || "点击画面或滑动即可操作手机。"} 点击画面后可直接键盘输入，Ctrl/Cmd+V 粘贴，退格删除，Ctrl/Cmd+A 全选。`
        : device.screenControlConcurrentLookupAllowed
          ? device.screenControlNeedsHumanAction
            ? "检测到拼图或人工验证；可立即开始控屏处理，控屏期间脚本暂停使用 Poco。"
            : state.user?.role === "admin"
              ? "管理员可在空闲的查名字会话中临时控屏；控屏期间脚本暂停使用 Poco。"
              : "可在你发起的查名字会话中临时控屏；控屏期间脚本暂停使用 Poco，结束控屏后可继续查询。"
          : "投屏会独占这台手机，结束后才能继续扫码任务。";
  }
}

async function startUserScreenSession() {
  const device = state.userDevices.find((item) => item.deviceId === state.userSelectedDeviceId);
  if (!device || state.userScreenStarting) return;
  if (!window.PhoneCloudScreenController) throw new Error("实时控制组件尚未加载，请刷新页面后重试。");
  userScreenInactivityGuard.stop();
  state.userScreenStarting = true;
  state.userScreenStatus = "connecting";
  state.userScreenDetail = "正在请求实时控制会话";
  state.userScreenMetrics = {};
  state.userScreenGalleryImport = null;
  state.userScreenGalleryImporting = false;
  renderUserScreenControl(device);
  try {
    const payload = await api(`/api/v1/user/devices/${encodeURIComponent(device.deviceId)}/screen-sessions`, { method: "POST" });
    state.userScreenSession = payload.session;
    state.userScreenToken = payload.browserToken || "";
    state.userScreenDeviceId = device.deviceId;
    userScreenInactivityGuard.start();
    state.userScreenController?.destroy();
    state.userScreenController = new window.PhoneCloudScreenController({
      video: els.userScreenVideo,
      onStatus(message) {
        if (state.userScreenDeviceId !== device.deviceId) return;
        state.userScreenStatus = message.status || "connecting";
        const humanHandoverClosed = message.status === "closed"
          && /^(控制|视频)通道连接失败（1000：lookup_human_verification_completed）$/.test(String(message.detail || ""));
        state.userScreenDetail = humanHandoverClosed
          ? "人工验证已完成，控屏已自动结束；脚本正在重查原号码。"
          : message.detail || message.status || "正在连接";
        if (["failed", "closed"].includes(state.userScreenStatus)) {
          const failedSessionId = state.userScreenSession?.sessionId || "";
          userScreenInactivityGuard.stop();
          state.userScreenSession = null;
          state.userScreenToken = "";
          state.userScreenDeviceId = "";
          if (failedSessionId) releaseFailedUserScreenSession(failedSessionId);
        }
        renderUserScreenControl(state.userDevices.find((item) => item.deviceId === state.userSelectedDeviceId));
      },
      onMetrics(metrics) {
        if (state.userScreenDeviceId !== device.deviceId) return;
        state.userScreenMetrics = metrics || {};
        renderUserScreenControl(state.userDevices.find((item) => item.deviceId === state.userSelectedDeviceId));
      }
    });
    state.userScreenController.connect({ sessionId: payload.session.sessionId, browserToken: payload.browserToken, media: payload.media });
  } catch (error) {
    userScreenInactivityGuard.stop();
    state.userScreenStatus = "failed";
    state.userScreenDetail = error.message || "投屏启动失败";
    state.userScreenSession = null;
    state.userScreenToken = "";
    throw error;
  } finally {
    state.userScreenStarting = false;
    renderUserScreenControl(device);
  }
}

function releaseFailedUserScreenSession(sessionId) {
  userScreenInactivityGuard.stop();
  const controller = state.userScreenController;
  state.userScreenController = null;
  controller?.disconnect();
  fetch(`/api/v1/screen-sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${state.token}` },
    keepalive: true
  }).catch(() => {});
}

async function stopUserScreenSession({ detail = "等待连接" } = {}) {
  const sessionId = state.userScreenSession?.sessionId;
  const restoreStartButtonFocus = Boolean(els.userScreenIdleModal?.contains(document.activeElement));
  userScreenInactivityGuard.stop();
  state.userScreenController?.disconnect();
  state.userScreenController = null;
  state.userScreenSession = null;
  state.userScreenToken = "";
  state.userScreenDeviceId = "";
  state.userScreenStatus = "idle";
  state.userScreenDetail = detail;
  state.userScreenMetrics = {};
  state.userScreenGalleryImport = null;
  state.userScreenGalleryImporting = false;
  renderUserScreenControl(state.userDevices.find((item) => item.deviceId === state.userSelectedDeviceId));
  if (restoreStartButtonFocus) requestAnimationFrame(() => els.userScreenStartButton?.focus());
  if (sessionId) await api(`/api/v1/screen-sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }).catch(() => {});
}

function releaseUserScreenSessionOnPageExit() {
  const sessionId = state.userScreenSession?.sessionId;
  userScreenInactivityGuard.stop();
  if (!sessionId || !state.token || userScreenExitReleaseRequested) return;
  userScreenExitReleaseRequested = true;
  state.userScreenController?.disconnect();
  fetch(`/api/v1/screen-sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${state.token}` },
    keepalive: true
  }).catch(() => {});
}

async function wakeUserScreen() {
  const device = state.userDevices.find((item) => item.deviceId === state.userSelectedDeviceId);
  if (!device || state.userScreenStarting) return;
  if (["live", "streaming"].includes(state.userScreenStatus) && state.userScreenController) {
    state.userScreenController?.key("wakeup");
    state.userScreenDetail = "已发送唤醒指令";
    renderUserScreenControl(device);
    setTimeout(() => {
      if (state.userSelectedDeviceId !== device.deviceId || !["live", "streaming"].includes(state.userScreenStatus)) return;
      if (state.userScreenDetail === "已发送唤醒指令") {
        state.userScreenDetail = "实时画面已连接";
        renderUserScreenControl(device);
      }
    }, 1200);
    return;
  }
  await startUserScreenSession();
}

const SCREEN_GALLERY_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function isUserScreenGalleryImportActive() {
  return state.userScreenGalleryImporting || ["queued", "running"].includes(state.userScreenGalleryImport?.status);
}

function canImportUserScreenGallery() {
  return Boolean(
    state.userDetailTab === "screen"
    && state.userScreenSession?.sessionId
    && ["live", "streaming"].includes(state.userScreenStatus)
    && !isUserScreenGalleryImportActive()
  );
}

function isSupportedScreenGalleryImage(file) {
  return Boolean(file && SCREEN_GALLERY_IMAGE_TYPES.has(String(file.type || "").toLowerCase()));
}

function clipboardImageFile(items) {
  for (const item of Array.from(items || [])) {
    if (item.kind !== "file" || !SCREEN_GALLERY_IMAGE_TYPES.has(String(item.type || "").toLowerCase())) continue;
    const file = item.getAsFile?.();
    if (file) return file;
  }
  return null;
}

function formatScreenGalleryFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function clearUserScreenGalleryDraft() {
  state.userScreenGalleryDraftFile = null;
  state.userScreenGalleryDraftDataUrl = "";
  state.userScreenGalleryDraftError = "";
}

async function stageUserScreenGalleryImage(file) {
  if (!isSupportedScreenGalleryImage(file)) throw new Error("仅支持 PNG、JPEG 或 WebP 图片。");
  clearUserScreenGalleryDraft();
  state.userScreenGalleryDraftFile = file;
  state.userScreenGalleryDraftDataUrl = await fileToDataUrl(file, { label: "待上传图片" });
  renderUserScreenControl(state.userDevices.find((item) => item.deviceId === state.userSelectedDeviceId));
}

async function handleUserScreenGalleryPaste(event) {
  const target = event.target instanceof HTMLElement ? event.target.closest("#userScreenGalleryPasteZone") : null;
  if (!target || !canImportUserScreenGallery()) return;
  event.preventDefault();
  const file = clipboardImageFile(event.clipboardData?.items);
  if (!file) {
    state.userScreenGalleryDraftError = "未识别到图片，请复制 PNG、JPEG 或 WebP 图片后再粘贴。";
    renderUserScreenControl(state.userDevices.find((item) => item.deviceId === state.userSelectedDeviceId));
    return;
  }
  await stageUserScreenGalleryImage(file);
}

async function importUserScreenGalleryImage(file = state.userScreenGalleryDraftFile) {
  const sessionId = state.userScreenSession?.sessionId;
  if (!file || !sessionId) return;
  if (!['live', 'streaming'].includes(state.userScreenStatus)) throw new Error("请先等待实时画面连接成功");
  if (isUserScreenGalleryImportActive()) return;
  if (!isSupportedScreenGalleryImage(file)) throw new Error("仅支持 PNG、JPEG 或 WebP 图片。");
  const device = state.userDevices.find((item) => item.deviceId === state.userSelectedDeviceId);
  state.userScreenGalleryImporting = true;
  state.userScreenGalleryImport = null;
  renderUserScreenControl(device);
  try {
    const imageDataUrl = await fileToDataUrl(file, { label: "导入图片" });
    const payload = await api(`/api/v1/screen-sessions/${encodeURIComponent(sessionId)}/gallery-imports`, {
      method: "POST",
      body: JSON.stringify({ imageDataUrl })
    });
    state.userScreenGalleryImport = payload.task || null;
    if (els.userScreenGalleryFileInput) els.userScreenGalleryFileInput.value = "";
    renderUserScreenControl(device);
    if (payload.task?.taskId) pollUserScreenGalleryImport(sessionId, payload.task.taskId);
  } catch (error) {
    state.userScreenGalleryImport = { status: "failed", result: { message: error.message || "图片导入失败" } };
    throw error;
  } finally {
    state.userScreenGalleryImporting = false;
    renderUserScreenControl(device);
  }
}

async function pollUserScreenGalleryImport(sessionId, taskId) {
  const deadlineAt = Date.now() + 6 * 60 * 1000;
  let attempt = 0;
  while (Date.now() < deadlineAt) {
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 700 : 1500));
    attempt += 1;
    if (state.userScreenSession?.sessionId !== sessionId) return;
    try {
      const payload = await api(`/api/v1/screen-sessions/${encodeURIComponent(sessionId)}/gallery-imports/${encodeURIComponent(taskId)}`);
      if (state.userScreenSession?.sessionId !== sessionId) return;
      state.userScreenGalleryImport = payload.task || state.userScreenGalleryImport;
      if (payload.task?.status === "succeeded") clearUserScreenGalleryDraft();
      renderUserScreenControl(state.userDevices.find((item) => item.deviceId === state.userSelectedDeviceId));
      if (["succeeded", "failed", "cancelled"].includes(payload.task?.status)) return;
    } catch (error) {
      if (error.code === "screen_session_not_found") return;
      state.userScreenGalleryImport = { status: "failed", result: { message: error.message || "无法读取导入状态" } };
      renderUserScreenControl(state.userDevices.find((item) => item.deviceId === state.userSelectedDeviceId));
      return;
    }
  }
  if (state.userScreenSession?.sessionId !== sessionId) return;
  state.userScreenGalleryImport = {
    status: "failed",
    result: { message: "图片导入等待超时，请重新提交；平台不会继续显示为导入中。" }
  };
  renderUserScreenControl(state.userDevices.find((item) => item.deviceId === state.userSelectedDeviceId));
}

function renderUserDeviceInventoryLoading() {
  return `
    <div class="user-device-loading-state">
      <span class="inline-spinner"></span>
      <b>正在加载手机库存</b>
      <small>正在同步设备在线状态和可用账号</small>
    </div>
  `;
}

function applyRememberedAutomationTarget(device, targets) {
  if (!els.userAutomationTargetSelect || !device) return;
  const remembered = state.userAutomationTargetByDevice?.[device.deviceId] || "";
  const availableValues = targets.filter((target) => !target.disabled).map((target) => target.value);
  const targetValue = availableValues.includes(remembered) ? remembered : (availableValues[0] || "");
  els.userAutomationTargetSelect.value = targetValue;
  if (targetValue) rememberAutomationTarget(device.deviceId, targetValue);
}

function rememberAutomationTarget(deviceId, value) {
  if (!deviceId) return;
  state.userAutomationTargetByDevice = {
    ...(state.userAutomationTargetByDevice || {}),
    [deviceId]: value || ""
  };
  localStorage.setItem("phoneCloudUserAutomationTargetByDevice", JSON.stringify(state.userAutomationTargetByDevice));
}

function renderUserDeviceCard(device) {
  const adbOnline = Boolean(device.adbOnline);
  const presence = userDevicePresence(device);
  const latestTask = userLatestTaskLabel(device);
  const sims = (device.sims || []).filter((sim) => sim.phoneNumber || sim.carrierName || sim.label);
  const accounts = (device.xhsAccounts || []).filter((account) => account.enabled !== false);
  const selected = device.deviceId === state.userSelectedDeviceId;
  return `
    <article class="device-card user-device-card selectable-row ${selected ? "is-selected selected-row" : ""} is-${presence.key}" data-user-device-id="${escapeHtml(device.deviceId)}" ondblclick="window.__openUserDeviceDetail?.(this.dataset.userDeviceId)" title="${escapeHtml(presence.hint)}" role="button" tabindex="0">
      <button class="device-open-button" data-user-device-open="${escapeHtml(device.deviceId)}" onclick="window.__openUserDeviceDetail?.(this.dataset.userDeviceOpen)" type="button" aria-label="打开 ${escapeHtml(device.deviceName || device.deviceId)}"></button>
      <div class="device-main">
        <div class="device-top-row">
          <div class="device-thumb" aria-hidden="true">
            <span>${escapeHtml(deviceInitial(device))}</span>
          </div>
          <div class="device-top-content">
            <div class="device-heading-row">
              <div class="device-heading-copy">
                <div class="device-title-line">
                  <strong>${escapeHtml(device.deviceName || device.deviceId)}</strong>
                  <span class="device-signal is-${presence.key}">${escapeHtml(presence.signal)}</span>
                </div>
                <small>${escapeHtml([deviceBrandLabel(device), device.model || "未知型号", device.androidVersion ? `Android ${device.androidVersion}` : "Android -", adbOnline ? "ADB" : device.appVersion || "App -"].filter(Boolean).join(" · "))}</small>
              </div>
            </div>
            <div class="device-meta-grid">
              <span><b>Battery</b>${escapeHtml(batteryLabel(device.batteryLevel))}</span>
              <span><b>SIM</b>${escapeHtml((device.sims || []).length || 0)}</span>
              <span><b>SMS</b>${escapeHtml(device.smsLibraryCount || 0)}</span>
            </div>
          </div>
        </div>
        <div class="phone-chips">
          ${sims.length ? sims.slice(0, 2).map((sim, index) => {
            const simText = [sim.label || `SIM ${index + 1}`, displayPhoneNumber(sim.phoneNumber), sim.carrierName].filter(Boolean).join(" · ");
            return `<i>${escapeHtml(simText)}</i>`;
          }).join("") : `<i>未读取到 SIM 信息</i>`}
        </div>
        <div class="xhs-chips">
          ${accounts.length ? accounts.slice(0, 2).map((account) => `<i>${escapeHtml(account.appSlot || "")} · ${escapeHtml(account.accountName || account.label || "未填小红书账号")}${account.xhsId ? ` · ID ${escapeHtml(account.xhsId)}` : ""}</i>`).join("") : `<i>未填小红书账号</i>`}
        </div>
        ${renderDeviceOccupancy(device)}
        <div class="device-task-line">
          <span>Latest task</span>
          <b>${escapeHtml(latestTask)}</b>
          <button class="device-open-cta" data-user-device-open="${escapeHtml(device.deviceId)}" onclick="window.__openUserDeviceDetail?.(this.dataset.userDeviceOpen)" type="button">查看详情</button>
        </div>
      </div>
    </article>
  `;
}

function renderUserDeviceDetailPanel(device) {
  const sims = device.sims || [];
  const accounts = (device.xhsAccounts || []).filter((account) => account.enabled !== false);
  return `
    <div class="device-profile-phone" aria-hidden="true">
      <div class="detail-phone-large">
        <span></span>
        <strong>${escapeHtml(deviceInitial(device))}</strong>
      </div>
      <em>${escapeHtml(userDeviceStatusLabel(device))}</em>
    </div>
    <div class="device-profile-facts">
      ${profileFact("手机品牌", deviceBrandLabel(device) || "未知品牌")}
      ${profileFact("设备型号", device.model || "未知型号")}
      ${profileFact("Android 版本", device.androidVersion ? `Android ${device.androidVersion}` : "-")}
      ${profileFact("ADB 序列号", device.adbSerial || device.deviceId || "-")}
      ${profileFact("电量", batteryLabel(device.batteryLevel), batteryTone(device.batteryLevel))}
      ${profileFact("SIM 卡数量", String(sims.length || 0))}
      ${profileFact("短信总数", `${device.smsLibraryCount || state.userDeviceSmsTotal || 0} 条`, "ok")}
      ${profileFact("最后同步时间", shortTime(device.lastSeenAt || device.updatedAt || device.lastHeartbeatAt))}
      ${profileFact("当前使用者", device.occupancy ? `${device.occupancy.ownerLabel} · ${device.occupancy.label}${device.occupancy.startedAt ? ` · ${shortTime(device.occupancy.startedAt)}` : ""}` : "未占用", device.occupancy ? "warn" : "ok")}
    </div>
    <div class="device-profile-resources">
      <section>
        <h3>SIM 卡信息</h3>
        <div class="profile-resource-grid">
          ${sims.length ? sims.map((sim, index) => renderDetailSim(sim, index)).join("") : `<div class="empty compact-empty">未读取到 SIM 卡信息；部分 Android 机型会限制 ADB 读取 SIM 表。</div>`}
        </div>
      </section>
      <section>
        <h3>小红书账号槽位</h3>
        <div class="profile-resource-grid">
          ${accounts.length ? accounts.map((account) => renderDetailAccount(account)).join("") : `<div class="empty compact-empty">还没有配置小红书账号槽位。</div>`}
        </div>
      </section>
    </div>
  `;
}

function profileFact(label, value, tone = "") {
  return `
    <div class="profile-fact ${tone}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderDeviceOccupancy(device) {
  const occupancy = device?.occupancy;
  if (!occupancy) return "";
  const startedAt = occupancy.startedAt ? shortTime(occupancy.startedAt) : "刚刚";
  return `
    <div class="device-occupancy-line" title="${escapeHtml(`${occupancy.ownerLabel} · ${occupancy.label} · ${startedAt}`)}">
      <span>使用者</span>
      <b>${escapeHtml(occupancy.ownerLabel)}</b>
      <small>${escapeHtml(`${occupancy.label} · ${startedAt}`)}</small>
    </div>
  `;
}

function renderDeviceStatusPills(device) {
  const adbOnline = Boolean(device.adbOnline);
  const adbUnauthorized = userDeviceAdbUnauthorized(device);
  const automationReady = automationReadyForDevice(device);
  const automationLabel = automationReady ? "自动化可用" : device.busy ? "任务占用中" : automationIssueLabel(device);
  return [
    `<span class="status-pill ${userDeviceStatusClass(device)}">${escapeHtml(userDeviceStatusLabel(device))}</span>`,
    `<span class="status-pill ${adbOnline ? "ok" : adbUnauthorized ? "bad" : "warn"}">${escapeHtml(adbOnline ? "ADB 在线" : adbUnauthorized ? "ADB 未授权" : "未连接")}</span>`,
    `<span class="status-pill ${automationReady ? "ok" : "warn"}">${escapeHtml(automationLabel)}</span>`
  ].join("");
}

function renderAutomationChecks(device) {
  const adbOnline = Boolean(device.adbOnline);
  const adbUnauthorized = userDeviceAdbUnauthorized(device);
  const configuredXhsAccounts = (device.xhsAccounts || []).filter((account) => (
    account.enabled !== false && String(account.accountName || "").trim()
  )).length;
  const xhsDetail = configuredXhsAccounts
    ? `${configuredXhsAccounts} 个账号槽位`
    : "未配置账号槽位";
  const checks = [
    ["连接状态", adbOnline ? "手机在线" : adbUnauthorized ? "已连接，未授权" : "未连接", adbOnline ? "ok" : adbUnauthorized ? "warn" : "bad"],
    ["任务状态", adbOnline ? (device.busy ? "占用中" : "可提交任务") : adbUnauthorized ? "请在手机上允许 USB 调试" : "不可用", adbOnline ? (device.busy ? "warn" : "ok") : "warn"],
    ["账号槽位", adbOnline ? xhsDetail : "不可用", adbOnline && configuredXhsAccounts ? "ok" : "warn"],
    ["异常处理", adbOnline ? "失败原因会显示在任务进度中" : adbUnauthorized ? "解锁手机并点击允许 USB 调试" : "请检查数据线、Hub 和 USB 调试", adbOnline ? "ok" : "warn"]
  ];
  return checks.map(([label, value, tone]) => `
    <div class="automation-check ${tone}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `).join("");
}

function filterUserDeviceSmsMessages(selectedDevice) {
  if (!selectedDevice) return [];
  const search = String(state.userSmsSearch || "").trim().toLowerCase();
  return state.userDeviceSmsMessages.filter((message) => {
    if (state.userSmsCodeOnly && !message.code) return false;
    if (state.userSmsSimFilter !== "" && String(message.slotIndex ?? "") !== String(state.userSmsSimFilter)) return false;
    if (!search) return true;
    const haystack = [
      message.address,
      message.phoneNumber,
      message.body,
      message.code,
      smsBoxLabel(message.box),
      message.slotIndex !== null && message.slotIndex !== undefined ? `sim ${Number(message.slotIndex) + 1}` : ""
    ].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(search);
  });
}

function renderUserSmsTable(messages) {
  return `
    <div class="sms-table-head">
      <span>时间</span>
      <span>发件人</span>
      <span>SIM</span>
      <span>验证码</span>
      <span>内容预览</span>
      <span>操作</span>
    </div>
    ${messages.map((message) => renderUserSmsTableRow(message)).join("")}
  `;
}

function renderUserSmsTableRow(message) {
  const slotLabel = message.slotIndex !== null && message.slotIndex !== undefined ? `SIM ${Number(message.slotIndex) + 1}` : "-";
  const sender = displayPhoneNumber(message.address || message.phoneNumber || "未知号码");
  const body = message.body || "";
  return `
    <article class="sms-table-row">
      <time>${escapeHtml(shortTime(message.messageAt))}</time>
      <div class="sms-sender-cell">
        <strong>${escapeHtml(sender)}</strong>
        <small>${escapeHtml(smsSourceLabel(message))}</small>
      </div>
      <span>${escapeHtml(slotLabel)}</span>
      <code class="${message.code ? "has-code" : ""}">${escapeHtml(message.code || "-")}</code>
      <p>${escapeHtml(body)}</p>
      <button data-copy-text="${escapeHtml(message.code || body)}" type="button">复制</button>
    </article>
  `;
}

function renderUserSmsPagination() {
  const pageSize = normalizedUserSmsPageSize();
  const total = state.userDeviceSmsTotal || 0;
  const totalPages = userSmsTotalPages();
  const page = Math.min(Math.max(1, Number(state.userSmsPage || 1)), totalPages);
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = total ? Math.min(total, start + state.userDeviceSmsMessages.length - 1) : 0;
  return `
    <div class="sms-page-info">
      <strong>${escapeHtml(start)}-${escapeHtml(end)}</strong>
      <span>/ ${escapeHtml(total)} 条</span>
    </div>
    <div class="sms-page-controls">
      <button data-user-sms-page="prev" type="button" ${page <= 1 ? "disabled" : ""}>上一页</button>
      <span>第 ${escapeHtml(page)} / ${escapeHtml(totalPages)} 页</span>
      <button data-user-sms-page="next" type="button" ${page >= totalPages ? "disabled" : ""}>下一页</button>
      <select id="userSmsPageSizeSelect" data-user-sms-page-size aria-label="每页短信数量">
        ${[10, 20, 50, 100].map((size) => `<option value="${size}" ${size === pageSize ? "selected" : ""}>每页 ${size} 条</option>`).join("")}
      </select>
    </div>
  `;
}

function copyText(value) {
  if (!value) return;
  navigator.clipboard?.writeText(value).catch(() => {});
}

function detailMetric(label, value, tone = "") {
  return `
    <div class="detail-metric ${tone}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderDetailSim(sim, index) {
  const simMeta = [displayPhoneNumber(sim.phoneNumber), sim.carrierName].filter(Boolean).join(" · ") || "未读取到手机号";
  return `
    <article class="detail-resource-card">
      <div>
        <strong>${escapeHtml(sim.label || `SIM ${Number(sim.slotIndex ?? index) + 1}`)}</strong>
        <span>${escapeHtml(simMeta)}</span>
      </div>
      <em class="${sim.busy ? "warn" : "ok"}">${sim.busy ? "短信占用" : "可用"}</em>
    </article>
  `;
}

function renderDetailAccount(account) {
  return `
    <article class="detail-resource-card">
      <div>
        <strong>${escapeHtml(account.label || account.appSlot)}</strong>
        <span>${escapeHtml(account.accountName || "未填账号备注")}${account.xhsId ? ` · ID ${escapeHtml(account.xhsId)}` : ""}</span>
      </div>
      <em class="${account.busy ? "warn" : "ok"}">${account.busy ? "扫码占用" : "可用"}</em>
    </article>
  `;
}

function syncScanTargetCards() {
  if (!els.userAutomationTargetCards || !els.userAutomationTargetSelect) return;
  const value = els.userAutomationTargetSelect.value || "";
  els.userAutomationTargetCards.querySelectorAll("[data-scan-target-value]").forEach((card) => {
    card.classList.toggle("is-selected", card.dataset.scanTargetValue === value);
  });
}

function renderAutomationTargetCards(targets) {
  if (!targets.length) return `<div class="empty compact-empty">这台手机暂无已配置账号槽位。</div>`;
  return targets.map((target) => {
    const platformLabel = target.platform === "douyin" ? "抖音" : "小红书";
    const iconText = target.platform === "douyin" ? "抖" : "红";
    return `
      <button class="scan-target-card ${target.disabled ? "is-disabled" : ""}" data-scan-target-value="${escapeHtml(target.value)}" type="button" ${target.disabled ? "disabled" : ""}>
        <span class="scan-target-icon">${escapeHtml(iconText)}</span>
        <span class="scan-target-meta">
          <small>${escapeHtml(platformLabel)}</small>
          <strong>${escapeHtml(target.label)}</strong>
          <em>${escapeHtml(target.description || "未填账号备注")}</em>
        </span>
        <b>${target.disabled ? "占用" : "可用"}</b>
      </button>
    `;
  }).join("");
}

function automationTargetsForDevice(device) {
  if (!device) return [];
  const xhsTargets = (device.xhsAccounts || [])
    .filter((account) => account.enabled !== false && String(account.accountName || "").trim())
    .map((account) => ({
      platform: "xhs",
      slot: account.appSlot || "app1",
      value: `xhs:${account.appSlot || "app1"}`,
      label: account.label || (account.appSlot === "app2" ? "小红书 2" : "小红书 1"),
      xhsId: account.xhsId || "",
      accountName: account.accountName || "",
      description: [account.accountName, account.xhsId ? `ID ${account.xhsId}` : ""].filter(Boolean).join(" · ") || "未填账号备注",
      disabled: Boolean(account.busy)
    }));
  const douyinTargets = (device.douyinAccounts || [])
    .filter((account) => account.enabled !== false)
    .map((account) => ({
      platform: "douyin",
      slot: account.appSlot || "app1",
      value: `douyin:${account.appSlot || "app1"}`,
      label: account.label || (account.appSlot === "app2" ? "抖音 2" : "抖音 1"),
      description: account.accountName || "未填账号备注",
      disabled: true
    }));
  return [...xhsTargets, ...douyinTargets];
}

function parseAutomationTarget(value) {
  const [platform, slot] = String(value || "").split(":");
  return {
    platform: platform || "",
    slot: slot || ""
  };
}

function automationReadyForDevice(device) {
  const automation = device?.automationStatus || {};
  return Boolean(
    device?.adbOnline &&
    !device?.busy &&
    automation.deviceAutomationReady
  );
}

function automationIssueLabel(device) {
  const automation = device?.automationStatus || {};
  const status = automation.devicePreflightStatus || "unknown";
  const repairAction = automation.repairAction || "";
  const error = automation.deviceAutomationError || automation.lastError || "";
  if (!device?.adbOnline) return "等待 ADB";
  if (automation.deviceAutomationReady) return "ADB 自动化可用";
  if (repairAction === "adb_install_permission_required" || /USB 安装|USER_RESTRICTED|User rejected|Install canceled/i.test(error)) return "需开启 USB 安装";
  if (status === "failed") {
    if (!automation.helpersReady) return "组件安装失败";
    return "自动化异常";
  }
  if (status === "queued" || status === "preparing" || status === "unknown") return "环境准备中";
  if (!automation.airtestReady) return "Airtest/Poco 未就绪";
  if (!automation.pocoReady) return "PocoService 未就绪";
  if (!automation.helpersReady) return "手机组件待装";
  return "自动化待修复";
}

function userDeviceStatusLabel(device) {
  if (userDeviceAdbUnauthorized(device)) return "ADB 未授权";
  const adbOnline = Boolean(device.adbOnline);
  if (device.busy) return "执行中";
  if (automationReadyForDevice(device)) return "自动化可用";
  if (adbOnline) return automationIssueLabel(device);
  if (device.agentOnline) return "兼容在线";
  return "未连接";
}

function userDeviceStatusClass(device) {
  if (userDeviceAdbUnauthorized(device)) return "bad";
  const adbOnline = Boolean(device.adbOnline);
  if (device.busy) return "warn";
  if (automationReadyForDevice(device)) return "ok";
  if (adbOnline) return "warn";
  if (device.agentOnline) return "warn";
  return "bad";
}

function userDevicePresence(device) {
  if (userDeviceAdbUnauthorized(device)) return { key: "unauthorized", signal: "Unauthorized", hint: "设备已连接，但尚未在手机上允许 USB 调试授权" };
  const adbOnline = Boolean(device.adbOnline);
  if (device.busy) return { key: "running", signal: "Running", hint: device.busyReasons?.join("、") || "设备执行中" };
  if (automationReadyForDevice(device)) return { key: "online", signal: "Online", hint: "ADB 在线，自动化可用" };
  if (adbOnline) return { key: "idle", signal: "Preparing", hint: automationIssueLabel(device) };
  if (device.agentOnline) return { key: "idle", signal: "Idle", hint: "旧 Agent 在线，ADB 自动化暂不可用" };
  return { key: "offline", signal: "Offline", hint: "Windows 管理器未检测到这台手机" };
}

function matchesUserDeviceStatus(device, status) {
  if (!status || status === "all") return true;
  if (status === "online") return userDeviceOnline(device);
  if (status === "available") return automationReadyForDevice(device);
  if (status === "busy") return Boolean(device.busy);
  if (status === "unauthorized") return userDeviceAdbUnauthorized(device);
  if (status === "offline") return userDeviceDisconnected(device);
  return true;
}

function userDeviceAdbState(device) {
  return String(device?.adbState || device?.adb?.state || "").trim().toLowerCase();
}

function userDeviceAdbUnauthorized(device) {
  return userDeviceAdbState(device) === "unauthorized";
}

function userDeviceDisconnected(device) {
  return !userDeviceAdbUnauthorized(device) && !userDeviceOnline(device);
}

function userDeviceBrand(device) {
  return String(device.brand || device.manufacturer || device.model || device.deviceName || "").split(/\s+/)[0] || "";
}

function deviceBrandLabel(device) {
  const value = String(device.brand || device.manufacturer || "").trim();
  return value || userDeviceBrand(device);
}

function displayPhoneNumber(value) {
  const text = String(value || "").trim();
  const compact = text.replace(/[\s-]/g, "");
  if (/^\+?861\d{10}$/.test(compact)) return compact.replace(/^\+?86/, "");
  return text;
}

function syncUserDeviceFilterOptions() {
  if (els.userDeviceBrandSelect) {
    const brands = [...new Set(state.userDevices.map(userDeviceBrand).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const current = state.userDeviceBrandFilter;
    els.userDeviceBrandSelect.innerHTML = `<option value="">品牌：全部</option>${brands.map((brand) => `<option value="${escapeHtml(brand)}">${escapeHtml(brand)}</option>`).join("")}`;
    if (brands.includes(current)) els.userDeviceBrandSelect.value = current;
    else state.userDeviceBrandFilter = "";
  }
  if (els.userDeviceAndroidSelect) {
    const versions = [...new Set(state.userDevices.map((device) => String(device.androidVersion || "").trim()).filter(Boolean))].sort((a, b) => Number(b) - Number(a));
    const current = state.userDeviceAndroidFilter;
    els.userDeviceAndroidSelect.innerHTML = `<option value="">Android：全部</option>${versions.map((version) => `<option value="${escapeHtml(version)}">Android ${escapeHtml(version)}</option>`).join("")}`;
    if (versions.includes(current)) els.userDeviceAndroidSelect.value = current;
    else state.userDeviceAndroidFilter = "";
  }
}

function userDeviceOnline(device) {
  return Boolean(device.online || device.adbOnline || device.agentOnline || isOnline(device.lastSeenAt));
}

function userDeviceSearchText(device) {
  return [
    device.deviceId,
    device.deviceName,
    device.model,
    device.androidVersion,
    ...(device.sims || []).flatMap((sim) => [sim.phoneNumber, sim.carrierName, sim.label]),
    ...(device.xhsAccounts || []).flatMap((account) => [account.label, account.accountName, account.xhsId, account.appSlot])
  ].filter(Boolean).join(" ").toLowerCase();
}

function rankUserDeviceSearch(device, searchText) {
  const query = String(searchText || "").trim().toLowerCase();
  const deviceName = String(device?.deviceName || "").trim().toLowerCase();
  const deviceId = String(device?.deviceId || "").trim().toLowerCase();
  const phoneNumbers = (device?.sims || [])
    .map((sim) => String(sim?.phoneNumber || "").replace(/[^0-9]/g, ""))
    .filter(Boolean);

  if (deviceName === query) return 0;
  if (deviceName.startsWith(query)) return 1;
  if (deviceName.includes(query)) return 2;
  if (phoneNumbers.some((phoneNumber) => phoneNumber.startsWith(query))) return 3;
  if (phoneNumbers.some((phoneNumber) => phoneNumber.includes(query))) return 4;
  if (deviceId.startsWith(query)) return 5;
  if (deviceId.includes(query)) return 6;
  return 7;
}

const userDeviceSwitcherCollator = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base"
});

function userDeviceSwitcherStatus(device) {
  if (userDeviceAdbUnauthorized(device)) return "unauthorized";
  if (device.busy) return "busy";
  if (automationReadyForDevice(device)) return "available";
  if (device.adbOnline) return "preparing";
  if (userDeviceOnline(device)) return "online";
  return "offline";
}

function compareUserDeviceSwitcherOptions(left, right, query = "") {
  if (query) {
    const rankDelta = rankUserDeviceSearch(left, query) - rankUserDeviceSearch(right, query);
    if (rankDelta) return rankDelta;
  }
  const leftLabel = String(left.deviceName || left.deviceId || "");
  const rightLabel = String(right.deviceName || right.deviceId || "");
  return userDeviceSwitcherCollator.compare(leftLabel, rightLabel)
    || userDeviceSwitcherCollator.compare(String(left.deviceId || ""), String(right.deviceId || ""));
}

function renderUserDeviceSwitcher(selectedDevice, showDeviceDetail = true) {
  if (!els.userDeviceSwitcherButton || !els.userDeviceSwitcherPanel || !els.userDeviceSwitcherList) return;
  const canSwitch = Boolean(selectedDevice && state.userDevices.length);
  if (!showDeviceDetail || !canSwitch) state.userDeviceSwitcherOpen = false;
  const open = Boolean(state.userDeviceSwitcherOpen && canSwitch);
  const query = String(state.userDeviceSwitcherSearch || "").trim().toLowerCase();
  const devices = state.userDevices
    .filter((device) => !query || userDeviceSearchText(device).includes(query))
    .sort((left, right) => compareUserDeviceSwitcherOptions(left, right, query));
  const onlineCount = state.userDevices.filter(userDeviceOnline).length;

  els.userDeviceSwitcherButton.disabled = !canSwitch;
  els.userDeviceSwitcherButton.setAttribute("aria-expanded", String(open));
  els.userDeviceSwitcherButton.setAttribute(
    "aria-label",
    selectedDevice ? `切换手机，当前为 ${selectedDevice.deviceName || selectedDevice.deviceId}` : "切换手机"
  );
  els.userDeviceSwitcherPanel.hidden = !open;
  if (els.userDeviceSwitcherSearch && els.userDeviceSwitcherSearch.value !== state.userDeviceSwitcherSearch) {
    els.userDeviceSwitcherSearch.value = state.userDeviceSwitcherSearch;
  }
  if (els.userDeviceSwitcherCount) {
    els.userDeviceSwitcherCount.textContent = query
      ? `${devices.length} / ${state.userDevices.length} 台`
      : `${state.userDevices.length} 台 · 在线 ${onlineCount} 台`;
  }
  els.userDeviceSwitcherList.innerHTML = devices.length
    ? devices.map((device) => {
        const current = device.deviceId === selectedDevice?.deviceId;
        const status = userDeviceSwitcherStatus(device);
        const simPhone = (device.sims || []).map((sim) => displayPhoneNumber(sim.phoneNumber)).find(Boolean) || "";
        const meta = [
          device.model || deviceBrandLabel(device) || "未知型号",
          device.androidVersion ? `Android ${device.androidVersion}` : "",
          simPhone
        ].filter(Boolean).join(" · ");
        return `
          <button class="user-device-switch-option is-${status} ${current ? "is-current" : ""}" type="button" role="option" aria-selected="${current}" data-user-device-switch-id="${escapeHtml(device.deviceId)}">
            <i aria-hidden="true"></i>
            <span>
              <strong>${escapeHtml(device.deviceName || device.deviceId)}</strong>
              <small>${escapeHtml(meta)}</small>
            </span>
            <em>${escapeHtml(current ? "当前" : userDeviceStatusLabel(device))}</em>
          </button>
        `;
      }).join("")
    : `<div class="user-device-switcher-empty">没有匹配的手机</div>`;
}

function closeUserDeviceSwitcher() {
  if (!state.userDeviceSwitcherOpen) return;
  state.userDeviceSwitcherOpen = false;
  renderUserDeviceSwitcher(
    state.userDevices.find((device) => device.deviceId === state.userSelectedDeviceId) || null,
    state.userWorkbenchView === "detail"
  );
}

function openUserDeviceSwitcher() {
  if (!state.userSelectedDeviceId || !state.userDevices.length) return;
  state.userDeviceSwitcherSearch = "";
  state.userDeviceSwitcherOpen = true;
  const selectedDevice = state.userDevices.find((device) => device.deviceId === state.userSelectedDeviceId) || null;
  renderUserDeviceSwitcher(selectedDevice, true);
  requestAnimationFrame(() => {
    els.userDeviceSwitcherList?.querySelector(".is-current")?.scrollIntoView({ block: "nearest" });
    els.userDeviceSwitcherSearch?.focus();
  });
}

function userLatestTaskLabel(device) {
  const xhsTask = visibleUserXhsTasks().find((task) => task.deviceId === device.deviceId);
  if (xhsTask) return `扫码任务 · ${statusText(xhsTask.status)}`;
  const phoneNumbers = new Set((device.sims || []).map((sim) => sim.phoneNumber).filter(Boolean));
  const smsOrder = state.userSmsOrders.find((order) => phoneNumbers.has(order.phoneNumber));
  if (smsOrder) return `短信验证码 · ${statusText(smsOrder.status)}`;
  return "点开查看任务";
}

function batteryLabel(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number}%` : "-";
}

function batteryTone(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  if (number <= 20) return "bad";
  if (number <= 45) return "warn";
  return "ok";
}

function deviceInitial(device) {
  const label = String(device.model || device.deviceName || device.deviceId || "?").trim();
  return label ? label[0].toUpperCase() : "?";
}

function renderUsers() {
  if (!els.userList) return;
  els.userList.innerHTML = state.users.length
    ? state.users.map((user) => `
      <article class="data-row" data-user-id="${escapeHtml(user.userId)}">
        <div>
          <strong>${escapeHtml(user.displayName || user.username)}</strong>
          <span>${escapeHtml(user.username)} · ${escapeHtml(user.role)} · ${escapeHtml(user.lastLoginAt ? shortTime(user.lastLoginAt) : "未登录")}</span>
        </div>
        <div class="row-actions">
          <em class="${user.enabled ? "ok" : "bad"}">${user.enabled ? "启用" : "停用"}</em>
          <button data-user-action="${user.enabled ? "disable" : "enable"}" type="button">${user.enabled ? "停用" : "启用"}</button>
          <button data-user-action="reset-password" type="button">重置密码</button>
        </div>
      </article>
    `).join("")
    : `<div class="empty">暂无用户。</div>`;
}

const AUTOMATIC_RECOVERY_STATES = new Set([
  "usb_present_mtp_only",
  "usb_composite_no_adb_interface",
  "usb_root_pnp_error",
  "adb_interface_pnp_error",
  "adb_interface_ready_transport_missing",
  "adb_offline"
]);

function renderWindowsRecoveryConsole() {
  if (!els.windowsRecoveryConsole) return;
  const telemetryAgents = state.agents.map((agent) => ({
    agent,
    recovery: agent.health?.deviceRecovery || {},
    online: isOnline(agent.lastSeenAt)
  })).filter(({ recovery, online }) => online || recovery.observedAt || recovery.inventoryObservedAt);
  const queue = telemetryAgents.flatMap(({ agent, recovery, online }) => (recovery.queue || []).map((item) => ({
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
  })));
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
  const status = !observed.length
    ? { tone: "idle", label: "等待恢复遥测", detail: "Windows 管理器尚未上报逐设备恢复状态" }
    : rescueCount
      ? { tone: "active", label: `${rescueCount} 台连带设备精确救援`, detail: "普通队列保持熔断，仅逐台救回本轮恢复造成的批外掉线设备" }
    : circuitAgents.length
      ? { tone: "danger", label: "保护熔断", detail: circuitAgents.map(({ agent, recovery }) => `${agent.agentName || agent.agentId}：${recoveryBlockReason(recovery)}`).join("；") }
      : activeCount
        ? { tone: "active", label: `${activeCount} 台正在恢复`, detail: "动作执行后会先验证 ADB，再决定是否进入下一次重试" }
        : telemetryAgents.some(({ recovery }) => recovery.recoveryMode === "continuous_recovery")
          ? { tone: "active", label: "异常设备持续恢复", detail: "不隔离、不熔断；每台手机在轮次冷却后继续下一轮精确恢复" }
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
  if (filter === "manual") return Boolean(item.quarantined || item.state === "adb_unauthorized" || item.state === "physically_absent");
  if (filter === "waiting") return !item.inProgress && !recoveryQueueMatchesFilter(item, "manual");
  return true;
}

function renderRecoveryQueueRow(item) {
  const status = recoveryDeviceStatus(item);
  const stateLabel = recoveryStateLabel(item.state);
  const attempts = Math.max(0, Number(item.attempts || 0));
  const maxAttempts = Math.max(1, Number(item.maxAttempts || 5));
  const evidence = [item.lastError, item.rootProblem && `USB ${item.rootProblem}`, item.adbInterfaceProblem && `ADB ${item.adbInterfaceProblem}`].filter(Boolean).join(" · ");
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
        ${item.nextActionAt && !item.quarantined ? `<strong data-recovery-countdown="${escapeHtml(item.nextActionAt)}">${escapeHtml(formatRecoveryCountdown(item.nextActionAt))}</strong>` : `<strong>${escapeHtml(status.next)}</strong>`}
        <small>${escapeHtml(item.lastAttemptAt ? `上次动作 ${shortTime(item.lastAttemptAt)}` : "尚未执行恢复动作")}</small>
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

function renderWindows() {
  renderWindowsRecoveryConsole();
  els.windowsList.innerHTML = state.agents.length
    ? state.agents.map((agent) => {
      const online = isOnline(agent.lastSeenAt);
      const devices = agent.devices || [];
      const enabled = agent.enabled !== false && !agent.revokedAt;
      const boundToken = Boolean(agent.hasToken);
      return `
        <article class="agent-card ${enabled ? "" : "is-disabled"}" data-agent-id="${escapeHtml(agent.agentId)}">
          <header>
            <div>
              <strong>${escapeHtml(agent.agentName || agent.agentId)}</strong>
              <span>${escapeHtml(agent.agentId)} · ${escapeHtml(agent.hostname || "未知主机")} · ${escapeHtml(agent.adbVersion || "ADB 未上报")}</span>
            </div>
            <div class="agent-security-actions">
              <em class="${online && enabled ? "ok" : "bad"}">${enabled ? online ? "在线" : "离线" : "已禁用"}</em>
              <button data-agent-action="rotate-token" type="button">重置 token</button>
              <button data-agent-action="${enabled ? "disable" : "enable"}" type="button">${enabled ? "禁用" : "启用"}</button>
            </div>
          </header>
          <div class="agent-security-strip">
            <span class="${boundToken ? "ok" : "warn"}">${boundToken ? `独立 token · ${escapeHtml(agent.tokenPrefix || "已绑定")}` : "未绑定独立 token"}</span>
            <span>最后 IP ${escapeHtml(agent.lastIp || agent.ip || "-")}</span>
            <span>轮换 ${escapeHtml(shortTime(agent.lastRotatedAt))}</span>
            <span>权限 ${escapeHtml((agent.scopes || []).join(", ") || "默认")}</span>
          </div>
          <div class="mini-metrics">
            <span>${devices.length} 个 ADB 设备</span>
            <span>${devices.filter((device) => device.state === "device").length} 个可控制</span>
            <span>${agent.taskCounts?.running || 0} 个执行中</span>
            <span class="${agent.health?.status === "ok" ? "ok" : "warn"}">健康 ${escapeHtml(agent.health?.status || "unknown")}</span>
            <span>进程 CPU ${formatMetric(agent.health?.runtime?.processCpuPercent, 1)}%</span>
            <span>进程内存 ${formatMetric(agent.health?.runtime?.processRssMb, 0)} MB</span>
            <span>系统内存 ${formatMetric(agent.health?.runtime?.hostMemoryUsedPercent, 0)}%</span>
            <span>投屏会话 ${agent.health?.screenControl?.activeSessions || 0}</span>
          </div>
          ${agent.health?.warnings?.length ? `<div class="agent-warning">${escapeHtml(agent.health.warnings.join("、"))}</div>` : ""}
          <div class="adb-list">
            ${devices.length ? devices.map((device) => `
              <div class="adb-row" data-agent-id="${escapeHtml(agent.agentId)}" data-adb-serial="${escapeHtml(device.adbSerial)}" data-device-id="${escapeHtml(device.deviceId || "")}">
                <div>
                  <strong>${escapeHtml(device.deviceName || device.adbSerial)}</strong>
                  <span>${escapeHtml(device.adbSerial)} · ${escapeHtml(device.model || "未知型号")} · ${escapeHtml(device.state)}</span>
                </div>
                <div class="row-actions">
                  <button data-task="adb_install_apk" type="button">旧 APK 安装</button>
                  <button data-task="adb_grant_permissions" type="button">旧 APK 授权</button>
                  <button data-task="adb_start_agent" type="button">旧 Agent 启动</button>
                </div>
              </div>
            `).join("") : `<div class="empty">暂无 ADB 手机</div>`}
          </div>
        </article>
      `;
    }).join("")
    : `<div class="empty">还没有 Windows 管理器上线。</div>`;
  renderWindowsTasks();
}

function renderWindowsTasks() {
  if (!els.windowsTaskList) return;
  els.windowsTaskList.innerHTML = state.windowsTasks.length
    ? state.windowsTasks.slice(0, 20).map((task) => {
      const diagnostic = task.result?.diagnostic || null;
      const lastEvent = task.lastEvent || {};
      const message = task.result?.message || task.result?.error || lastEvent.message || "";
      const screenshot = task.result?.screenshot || lastEvent.screenshot || null;
      const uiHierarchy = task.result?.uiHierarchy || lastEvent.uiHierarchy || lastEvent.uiSnapshot || "";
      const hasEvidence = Boolean(task.result?.hasScreenshot || task.result?.hasUiHierarchy || task.result?.screenshot || task.screenshotCount || uiHierarchy);
      const uiHierarchyUrl = task.result?.uiHierarchyUrl || task.result?.uiHierarchyEvidence?.url || lastEvent.uiHierarchyUrl || lastEvent.uiHierarchyEvidence?.url || "";
      const evidenceLoaded = Boolean(task.evidenceLoaded || screenshot?.dataUrl || screenshot?.url || uiHierarchy || uiHierarchyUrl);
      const evidenceLoading = Boolean(state.windowsTaskEvidenceLoading?.[task.taskId]);
      return `
        <article class="data-row">
          <div>
            <strong>${escapeHtml(taskTypeLabel(task.type))} · ${escapeHtml(task.adbSerial || task.deviceId || "-")}</strong>
            <span>${escapeHtml(shortTime(task.createdAt))} · ${escapeHtml(task.agentId || "-")} · ${escapeHtml(task.taskId)}</span>
            ${message ? `<span class="task-diagnostic">${escapeHtml(message)}</span>` : ""}
            ${diagnostic ? `<span class="task-diagnostic">${escapeHtml(diagnostic.code || "diagnostic")}：${escapeHtml(diagnostic.hint || diagnostic.message || "")}</span>` : ""}
            ${lastEvent.currentActivity ? `<span class="task-diagnostic">${escapeHtml(lastEvent.currentActivity)}</span>` : ""}
            ${renderScreenshotThumb(screenshot, "Windows 任务失败截图")}
            ${renderUiHierarchy(uiHierarchy, uiHierarchyUrl)}
            ${Number(task.screenshotCount || 0) ? `<span>${Number(task.screenshotCount || 0)} 张失败截图 · ${Number(task.eventCount || 0)} 条日志</span>` : `<span>${Number(task.eventCount || 0)} 条日志</span>`}
            ${hasEvidence && !evidenceLoaded ? `<button class="inline-action" data-load-windows-evidence="${escapeHtml(task.taskId)}" type="button">${evidenceLoading ? "加载中..." : "加载失败现场"}</button>` : ""}
            ${evidenceLoaded ? renderTaskRunnerLog(task) : ""}
          </div>
          <div class="row-actions">
            <em class="${task.status === "succeeded" ? "ok" : task.status === "failed" ? "bad" : "warn"}">${escapeHtml(statusText(task.status))}</em>
          </div>
        </article>
      `;
    }).join("")
    : `<div class="empty">暂无 ADB 任务。点击上方手机行里的安装、授权或启动按钮后会出现在这里。</div>`;
}

async function loadWindowsTaskEvidence(taskId) {
  const id = String(taskId || "");
  if (!id || state.windowsTaskEvidenceLoading[id]) return;
  state.windowsTaskEvidenceLoading = { ...(state.windowsTaskEvidenceLoading || {}), [id]: true };
  renderWindowsTasks();
  try {
    const [detail, events] = await Promise.all([
      api(`/api/v1/windows-agent-tasks/${encodeURIComponent(id)}`),
      api(`/api/v1/windows-agent-tasks/${encodeURIComponent(id)}/events?includeEvidence=1`)
    ]);
    state.windowsTasks = state.windowsTasks.map((task) => {
      if (task.taskId !== id) return task;
      const eventList = events.events || [];
      const lastEvent = eventList[eventList.length - 1] || task.lastEvent || null;
      return {
        ...task,
        ...(detail.task || {}),
        events: eventList,
        lastEvent,
        evidenceLoaded: true
      };
    });
  } finally {
    state.windowsTaskEvidenceLoading = { ...(state.windowsTaskEvidenceLoading || {}), [id]: false };
    renderWindowsTasks();
  }
}

function renderDevices() {
  if (isAdminDeviceEditing()) return;
  renderDeviceListingToolbar();
  const visibleDevices = state.devices.filter((device) => {
    if (state.adminDeviceListingFilter === "all") return true;
    return normalizedListingStatus(device.listingStatus) === state.adminDeviceListingFilter;
  });
  els.deviceList.innerHTML = visibleDevices.length
    ? visibleDevices.map((device) => {
      const isSaving = adminDeviceSavingIds.has(device.deviceId);
      const isListing = adminDeviceListingIds.has(device.deviceId);
      const isExpanded = adminDeviceExpandedIds.has(device.deviceId);
      const feedback = adminDeviceFeedbackById.get(device.deviceId) || {};
      const statusLine = feedback.message || (isSaving ? "正在保存设备资料..." : isListing ? "正在更新上架状态..." : "");
      const app1 = (device.xhsAccounts || []).find((item) => item.appSlot === "app1") || {};
      const app2 = (device.xhsAccounts || []).find((item) => item.appSlot === "app2") || {};
      const occupancyText = device.occupancy ? `${device.occupancy.ownerLabel} · ${device.occupancy.label}` : "";
      const adbState = String(device.adb?.state || "").trim().toLowerCase();
      const adbStateText = adbState === "device" ? "ADB 在线" : adbState === "unauthorized" ? "ADB 未授权" : adbState === "missing" || !adbState ? "未连接" : `ADB ${adbState}`;
      return `
      <article class="device-card admin-device-card ${isExpanded ? "is-expanded" : ""} ${isSaving || isListing ? "is-saving" : ""} ${feedback.kind ? `has-${escapeHtml(feedback.kind)}` : ""}" data-device-id="${escapeHtml(device.deviceId)}">
        <header class="admin-device-card-head">
          <div class="admin-device-title">
            <label class="device-select-row">
              <input data-role="device-select" type="checkbox" />
              <strong>${escapeHtml(device.deviceName || device.deviceId)}</strong>
            </label>
            <span>${escapeHtml(device.brand || device.manufacturer || "Android")} · ${escapeHtml(device.model || "未知型号")} · Android ${escapeHtml(device.androidVersion || "-")}</span>
          </div>
          <div class="device-status-stack admin-device-quick-actions">
            <div class="device-status-pills">
              <em class="${listingStatusClass(device.listingStatus)}">${escapeHtml(listingStatusText(device.listingStatus))}</em>
              <em class="${adbState === "device" ? "ok" : adbState === "unauthorized" ? "bad" : "warn"}">${escapeHtml(adbStateText)}</em>
              ${device.conflictStatus ? `<em class="bad">归属冲突</em>` : ""}
            </div>
            <div class="device-listing-inline-actions">
              <button class="ghost-button device-editor-toggle" data-action="toggle-device-editor" type="button" aria-expanded="${isExpanded ? "true" : "false"}">${isExpanded ? "收起资料" : "编辑资料"}</button>
              ${deviceListingActions(device)}
            </div>
          </div>
        </header>
        <div class="admin-device-summary">
          <dl class="device-facts">
            <div><dt>ADB 序列号</dt><dd>${escapeHtml(device.adb?.serial || "-")}</dd></div>
            <div><dt>管理器</dt><dd>${escapeHtml(device.adb?.agentId || "-")}</dd></div>
            <div><dt>最近同步</dt><dd>${escapeHtml(shortTime(device.lastSeenAt))}</dd></div>
            <div><dt>电量</dt><dd>${device.batteryLevel ?? "-"}${device.batteryLevel === null || device.batteryLevel === undefined ? "" : "%"}</dd></div>
          </dl>
          <p class="device-listing-note">${escapeHtml(listingStatusHint(device.listingStatus))}${device.conflictStatus ? ` · ${escapeHtml(device.conflictAgents?.join(" / ") || "设备归属冲突")}` : ""}</p>
          ${occupancyText ? `<p class="device-listing-note device-occupancy-note">占用：${escapeHtml(occupancyText)} · ${escapeHtml(shortTime(device.occupancy.startedAt))}</p>` : ""}
        </div>
        <div class="admin-device-editor ${isExpanded ? "" : "hidden"}">
          <div class="admin-device-editor-head">
            <div><strong>设备资料</strong><span>修改设备名称、SIM 号码和用户可选账号槽位</span></div>
            <span class="device-save-status ${feedback.kind ? `is-${escapeHtml(feedback.kind)}` : ""}">${escapeHtml(statusLine)}</span>
          </div>
        <div class="device-edit-grid admin-device-edit-grid">
          <fieldset>
            <legend>设备</legend>
            <label>
              <span>设备名称</span>
              <input data-role="device-name" value="${escapeHtml(device.deviceName || device.deviceId)}" placeholder="例如：94号-云英洲" maxlength="80" />
            </label>
          </fieldset>
          <fieldset>
            <legend>SIM 卡</legend>
            <label>
              <span>SIM 1 手机号</span>
              <input data-role="sim-phone" data-index="0" value="${escapeHtml(device.sims?.[0]?.phoneNumber || "")}" placeholder="17500000000" inputmode="tel" />
            </label>
            <label>
              <span>SIM 2 手机号</span>
              <input data-role="sim-phone" data-index="1" value="${escapeHtml(device.sims?.[1]?.phoneNumber || "")}" placeholder="可选" inputmode="tel" />
            </label>
          </fieldset>
          <fieldset>
            <legend>小红书账号</legend>
            <label>
              <span>app1 账号名称</span>
              <input data-role="xhs-account-name" data-slot="app1" value="${escapeHtml(app1.accountName || "")}" placeholder="可改的显示名称" />
              <input data-role="xhs-account-id" data-slot="app1" value="${escapeHtml(app1.xhsId || "")}" placeholder="小红书 ID（稳定标识）" maxlength="64" />
              <span class="inline-check"><input data-role="xhs-account-enabled" data-slot="app1" type="checkbox" ${app1.enabled === false ? "" : "checked"} />启用</span>
            </label>
            <label>
              <span>app2 / II·小红书 账号名称</span>
              <input data-role="xhs-account-name" data-slot="app2" value="${escapeHtml(app2.accountName || "")}" placeholder="可改的显示名称" />
              <input data-role="xhs-account-id" data-slot="app2" value="${escapeHtml(app2.xhsId || "")}" placeholder="小红书 ID（稳定标识）" maxlength="64" />
              <span class="inline-check"><input data-role="xhs-account-enabled" data-slot="app2" type="checkbox" ${app2.enabled === false ? "" : "checked"} />启用</span>
            </label>
          </fieldset>
        </div>
        <div class="row-actions device-save-actions">
          <button class="ghost-button" data-action="toggle-device-editor" type="button">取消</button>
          <button class="${isSaving ? "is-loading" : ""}" data-action="save-device-bindings" type="button" ${isSaving ? "disabled" : ""}>${isSaving ? "保存中..." : "保存绑定"}</button>
        </div>
        </div>
      </article>
    `;
    }).join("")
    : `<div class="empty">${state.devices.length ? "当前筛选下没有设备。" : "暂无设备。启动 Windows 管理器并插入手机后会出现在这里。"}</div>`;
  els.xhsDeviceSelect.innerHTML = state.devices.length
    ? state.devices.map((device) => `<option value="${escapeHtml(device.deviceId)}">${escapeHtml(device.deviceName || device.deviceId)}</option>`).join("")
    : `<option value="">暂无设备</option>`;
  renderXhsSlotOptions();
}

function renderDeviceListingToolbar() {
  if (!els.deviceListingToolbar) return;
  const counts = { all: state.devices.length, pending: 0, listed: 0, unlisted: 0 };
  for (const device of state.devices) {
    counts[normalizedListingStatus(device.listingStatus)] += 1;
  }
  const items = [
    ["all", "全部", counts.all],
    ["pending", "待确认", counts.pending],
    ["listed", "已上架", counts.listed],
    ["unlisted", "已下架", counts.unlisted]
  ];
  els.deviceListingToolbar.innerHTML = `
    <div class="listing-tabs">
      ${items.map(([value, label, count]) => `
        <button class="${state.adminDeviceListingFilter === value ? "active" : ""}" data-device-listing-filter="${value}" type="button">
          <span>${escapeHtml(label)}</span>
          <strong>${count}</strong>
        </button>
      `).join("")}
    </div>
    <div class="listing-toolbar-copy">
      <strong>${counts.pending}</strong>
      <span>台待确认，确认后才会出现在用户端。</span>
    </div>
  `;
}

function normalizedListingStatus(status) {
  const value = String(status || "listed").trim().toLowerCase();
  if (value === "listed" || value === "published") return "listed";
  if (value === "unlisted" || value === "hidden") return "unlisted";
  return "pending";
}

function listingStatusText(status) {
  return {
    listed: "已上架",
    pending: "待确认",
    unlisted: "已下架"
  }[normalizedListingStatus(status)] || "待确认";
}

function listingStatusClass(status) {
  return {
    listed: "ok",
    pending: "warn",
    unlisted: "bad"
  }[normalizedListingStatus(status)] || "warn";
}

function listingStatusHint(status) {
  return {
    listed: "用户端可见，可接收短信库查询和扫码任务。",
    pending: "新接入设备仅后台可见，请核对 SIM、账号槽位和自动化状态后上架。",
    unlisted: "用户端隐藏，不能被普通用户选择或下发任务。"
  }[normalizedListingStatus(status)] || "新接入设备仅后台可见，请核对后上架。";
}

function deviceListingActions(device) {
  const status = normalizedListingStatus(device.listingStatus);
  const isListing = adminDeviceListingIds.has(device.deviceId);
  if (status === "listed") {
    return `<button class="danger-soft ${isListing ? "is-loading" : ""}" data-action="set-device-listing" data-listing-status="unlisted" type="button" ${isListing ? "disabled" : ""}>${isListing ? "下架中..." : "下架"}</button>`;
  }
  return `<button class="primary ${isListing ? "is-loading" : ""}" data-action="set-device-listing" data-listing-status="listed" type="button" ${isListing ? "disabled" : ""}>${isListing ? "上架中..." : "上架"}</button>`;
}

function renderXhsSlotOptions() {
  if (!els.xhsSlotSelect) return;
  const device = state.devices.find((item) => item.deviceId === els.xhsDeviceSelect?.value) || state.devices[0];
  const accounts = (device?.xhsAccounts || [])
    .filter((account) => account.enabled !== false)
    .slice(0, 2);
  els.xhsSlotSelect.innerHTML = accounts.length
    ? accounts.map((account) => {
      const label = [account.label || account.appSlot, account.accountName, account.xhsId ? `ID ${account.xhsId}` : ""].filter(Boolean).join(" · ");
      return `<option value="${escapeHtml(account.appSlot)}">${escapeHtml(label)}</option>`;
    }).join("")
    : `<option value="">暂无可用小红书账号</option>`;
}

function renderSms() {
  renderSmsLibraryFilters();
  const orders = state.smsOrders.slice(0, 20).map((order) => `
    <article class="data-row">
      <div>
        <strong>${escapeHtml(order.platform)}</strong>
        <span>${escapeHtml(displayPhoneNumber(order.phoneNumber))} · ${escapeHtml(shortTime(order.createdAt))}</span>
      </div>
      <em class="${order.status === "received" ? "ok" : order.status === "expired" ? "bad" : "warn"}">${escapeHtml(order.status)}</em>
      <code>${escapeHtml(order.code || "等待")}</code>
    </article>
  `).join("");
  const events = state.smsEvents.slice(0, 20).map((event) => `
    <article class="data-row">
      <div>
        <strong>${escapeHtml(event.sender || event.platform)}</strong>
        <span>${escapeHtml(displayPhoneNumber(event.phoneNumber) || "-")} · ${escapeHtml(event.body)}</span>
      </div>
      <code>${escapeHtml(event.code || "-")}</code>
    </article>
  `).join("");
  els.smsList.innerHTML = orders || events ? `${orders}${events}` : `<div class="empty">暂无短信订单。</div>`;
  renderSmsLibrary();
}

function renderSmsLibraryFilters() {
  if (!els.smsLibraryDeviceSelect) return;
  const current = els.smsLibraryDeviceSelect.value || localStorage.getItem("phoneCloudSmsLibraryDeviceId") || "";
  const options = [
    `<option value="">全部手机</option>`,
    ...state.devices.map((device) => {
      const label = [device.deviceName || device.model || device.deviceId, device.adb?.serial].filter(Boolean).join(" · ");
      return `<option value="${escapeHtml(device.deviceId)}">${escapeHtml(label)}</option>`;
    })
  ].join("");
  els.smsLibraryDeviceSelect.innerHTML = options;
  if ([...els.smsLibraryDeviceSelect.options].some((option) => option.value === current)) {
    els.smsLibraryDeviceSelect.value = current;
  }
}

function renderSmsLibrary() {
  if (!els.smsLibraryList) return;
  els.smsLibraryList.innerHTML = state.smsMessages.length
    ? state.smsMessages.map((message) => {
      const device = state.devices.find((item) => item.deviceId === message.deviceId);
      const deviceLabel = device?.deviceName || device?.model || message.deviceId;
      const box = smsBoxLabel(message.box);
      const sim = message.slotIndex === null || message.slotIndex === undefined ? "" : `SIM ${Number(message.slotIndex) + 1}`;
      return `
        <article class="data-row sms-message-row">
          <div>
            <strong>${escapeHtml(displayPhoneNumber(message.address || message.phoneNumber || "未知号码"))}</strong>
            <span>${escapeHtml([deviceLabel, box, sim, smsSourceLabel(message), shortTime(message.messageAt)].filter(Boolean).join(" · "))}</span>
            <p>${escapeHtml(message.body || "")}</p>
          </div>
          <em class="${message.box === "inbox" ? "ok" : message.box === "sent" ? "warn" : ""}">${escapeHtml(box)}</em>
          <code>${escapeHtml(message.code || "-")}</code>
        </article>
      `;
    }).join("")
    : `<div class="empty">暂无短信库记录。请确认 Windows 管理器在线，且 ADB 能读取 content://sms。</div>`;
}

function smsBoxLabel(box) {
  return {
    inbox: "收件箱",
    sent: "已发送",
    draft: "草稿",
    outbox: "发件箱",
    failed: "发送失败",
    queued: "待发送",
    unknown: "未知"
  }[box] || "全部";
}

function smsSourceLabel(message = {}) {
  const source = String(message.source || "").toLowerCase();
  const aliases = Array.isArray(message.sourceAliases) ? message.sourceAliases.map((item) => String(item || "").toLowerCase()) : [];
  if (source.includes("notification")) return "通知补全";
  if (aliases.some((item) => item.includes("notification"))) return "系统短信（已合并通知）";
  return "系统短信";
}

function renderRelease() {
  if (!els.releaseDetail) return;
  const release = state.appRelease;
  els.releaseDetail.innerHTML = release
    ? `
      <article class="data-row">
        <div>
          <strong>${escapeHtml(release.versionName || "-")} (${escapeHtml(release.versionCode || 0)})</strong>
          <span>${escapeHtml(release.publishedAt ? shortTime(release.publishedAt) : "未发布")} · ${escapeHtml(release.sizeBytes || 0)} bytes</span>
        </div>
        <em class="${release.hasLocalApk ? "ok" : "warn"}">${release.hasLocalApk ? "本地 APK" : "外部地址"}</em>
      </article>
      <article class="data-row">
        <div>
          <strong>下载地址</strong>
          <span>${escapeHtml(release.downloadUrl || "-")}</span>
        </div>
      </article>
      <article class="data-row">
        <div>
          <strong>SHA256</strong>
          <span>${escapeHtml(release.sha256 || "-")}</span>
        </div>
      </article>
    `
    : `<div class="empty">还没有发布 APK。Windows 安装任务会要求本地 apkPath，或先在这里发布。</div>`;
}

function renderXhs() {
  const pageSize = normalizedXhsTaskPageSize();
  const total = Number(state.xhsTaskTotal || state.xhsTasks.length || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (state.xhsTaskPage > totalPages) state.xhsTaskPage = totalPages;
  els.xhsList.innerHTML = state.xhsTasks.length
    ? state.xhsTasks.map((task) => {
      const requester = task.requestedBy || {};
      const requesterName = requester.displayName || requester.username || task.userId || "未知用户";
      const requesterMeta = requester.username && requester.username !== requesterName
        ? requester.username
        : requester.role === "admin" ? "管理员" : requester.role === "external" ? "外部调用" : "普通用户";
      const evidenceLoading = Boolean(state.xhsTaskEvidenceLoading?.[task.taskId]);
      const evidenceLoaded = task.evidenceLoaded === true;
      const eventCount = Number(task.summary?.eventCount || 0);
      const screenshotCount = Number(task.summary?.screenshotCount || 0);
      const canLoadEvidence = ["failed", "expired"].includes(task.status) && (eventCount > 0 || screenshotCount > 0);
      return `
        <article class="data-row admin-xhs-task-row ${evidenceLoaded ? "has-evidence" : ""}" data-admin-xhs-task-id="${escapeHtml(task.taskId)}">
          <div class="admin-xhs-task-main">
            <div class="admin-xhs-task-title">
              <div>
                <strong>小红书扫码</strong>
                <span>${escapeHtml(task.deviceId)} · ${escapeHtml([task.xhsAccountLabel || task.xhsAppSlot, task.xhsAccountName, task.xhsAccountId ? `ID ${task.xhsAccountId}` : ""].filter(Boolean).join(" · "))}</span>
              </div>
              <em class="${task.status === "succeeded" ? "ok" : ["failed", "cancelled", "expired"].includes(task.status) ? "bad" : "warn"}">${escapeHtml(xhsStatusText(task.status))}</em>
            </div>
            <div class="admin-xhs-task-meta">
              <span class="task-requester"><b>发起用户</b><strong>${escapeHtml(requesterName)}</strong><small>${escapeHtml(requesterMeta)}</small></span>
              <span><b>提交时间</b><strong>${escapeHtml(shortTime(task.createdAt))}</strong></span>
              <span><b>任务 ID</b><code>${escapeHtml(task.taskId)}</code></span>
            </div>
            ${renderXhsTaskSummary(task)}
            ${canLoadEvidence && !evidenceLoaded ? `
              <div class="task-evidence-actions">
                <button class="inline-action ${evidenceLoading ? "is-loading" : ""}" data-load-xhs-evidence="${escapeHtml(task.taskId)}" type="button" ${evidenceLoading ? "disabled" : ""}>${evidenceLoading ? "正在加载失败现场..." : `加载失败现场${screenshotCount ? ` · ${screenshotCount} 张截图` : ""}`}</button>
              </div>
            ` : ""}
          </div>
        </article>
      `;
    }).join("")
    : `<div class="empty">暂无扫码任务。</div>`;
  els.xhsList.insertAdjacentHTML("beforeend", renderXhsPagination(total));
}

async function loadAdminXhsTaskEvidence(taskId) {
  const id = String(taskId || "");
  if (!id || state.xhsTaskEvidenceLoading?.[id]) return;
  state.xhsTaskEvidenceLoading = { ...(state.xhsTaskEvidenceLoading || {}), [id]: true };
  renderXhs();
  try {
    const payload = await api(`/api/v1/xhs/qr-scan-tasks/${encodeURIComponent(id)}`);
    state.xhsTasks = state.xhsTasks.map((task) => task.taskId === id
      ? { ...task, ...(payload.task || {}), evidenceLoaded: true }
      : task);
  } finally {
    state.xhsTaskEvidenceLoading = { ...(state.xhsTaskEvidenceLoading || {}), [id]: false };
    renderXhs();
  }
}

function mergeAdminXhsTaskList(incomingTasks) {
  const loadedById = new Map((state.xhsTasks || [])
    .filter((task) => task?.evidenceLoaded)
    .map((task) => [task.taskId, task]));
  return (incomingTasks || []).map((task) => {
    const loaded = loadedById.get(task.taskId);
    if (!loaded) return task;
    return {
      ...loaded,
      ...task,
      result: loaded.result,
      events: loaded.events,
      summary: { ...(task.summary || {}), ...(loaded.summary || {}) },
      evidenceLoaded: true
    };
  });
}

function normalizedXhsTaskPageSize() {
  const size = Number(state.xhsTaskPageSize || 20);
  return [10, 20, 50].includes(size) ? size : 20;
}

function xhsTaskQuery() {
  const pageSize = normalizedXhsTaskPageSize();
  const page = Math.max(1, Number(state.xhsTaskPage || 1));
  const params = new URLSearchParams();
  params.set("limit", String(pageSize));
  params.set("offset", String((page - 1) * pageSize));
  return `/api/v1/xhs/qr-scan-tasks?${params.toString()}`;
}

function renderXhsPagination(total) {
  const pageSize = normalizedXhsTaskPageSize();
  const totalPages = Math.max(1, Math.ceil(Number(total || 0) / pageSize));
  const page = Math.min(Math.max(1, Number(state.xhsTaskPage || 1)), totalPages);
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(total || 0, start + state.xhsTasks.length - 1);
  return `
    <div class="sms-pagination xhs-pagination">
      <div class="sms-page-info">
        <span>扫码任务</span>
        <strong>${escapeHtml(start)}-${escapeHtml(end)}</strong>
        <span>/ 共 ${escapeHtml(total || 0)} 条</span>
      </div>
      <div class="sms-page-controls">
        <button data-xhs-task-page="prev" type="button" ${page <= 1 ? "disabled" : ""}>上一页</button>
        <span>第 ${escapeHtml(page)} / ${escapeHtml(totalPages)} 页</span>
        <button data-xhs-task-page="next" type="button" ${page >= totalPages ? "disabled" : ""}>下一页</button>
        <select data-xhs-task-page-size aria-label="每页扫码任务数量">
          ${[10, 20, 50].map((size) => `<option value="${size}" ${size === pageSize ? "selected" : ""}>每页 ${size} 条</option>`).join("")}
        </select>
      </div>
    </div>
  `;
}

function xhsStatusText(status) {
  return {
    creating: "创建中",
    queued: "排队中",
    running: "执行中",
    stalled: "等待恢复",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消",
    expired: "已超时",
    submit_failed: "提交失败"
  }[status] || status || "-";
}

function xhsStatusClass(status) {
  if (status === "succeeded") return "ok";
  if (["failed", "cancelled", "expired", "submit_failed"].includes(status)) return "bad";
  return "warn";
}

function xhsTaskProgress(task) {
  if (task?.progress && Number.isFinite(Number(task.progress.percent))) {
    return {
      percent: Math.max(0, Math.min(100, Number(task.progress.percent))),
      label: task.progress.message || task.progress.stepId || statusText(task.status)
    };
  }
  const status = String(task?.status || "");
  const summary = task?.summary || {};
  const lastEvent = summary.lastEvent || {};
  const source = [
    status,
    lastEvent.phase,
    lastEvent.stepId,
    lastEvent.message,
    summary.progressMessage,
    summary.failureMessage
  ].filter(Boolean).join(" ").toLowerCase();
  const stages = [
    [8, "创建任务", /creating|已接收二维码|创建扫码任务/],
    [16, "等待执行器领取", /queued|排队|等待.*领取|等待 windows/],
    [24, "连接执行器", /poco_ready|poco_reused|airtest|poco 服务|执行器/],
    [30, "同步二维码到手机", /qr|二维码已推送|相册.*二维码|prepareqr|push/],
    [42, "重启小红书", /start_xhs|重启小红书|小红书已进入前台/],
    [48, "选择小红书槽位", /choose_slot|picker|双开|系统双开/],
    [56, "进入我的页面", /click_me|进入我的页面|profile|我的页面/],
    [66, "打开扫一扫", /click_scan|扫一扫|scanner/],
    [76, "打开相册", /click_album|打开相册|album/],
    [84, "选择二维码图片", /after_select_image|选择二维码图片|定位相册图片/],
    [90, "识别登录确认页", /confirm_visible|登录确认页断言|login-confirm/],
    [93, "等待确认登录", /confirm_wait|等待后点击确认/],
    [96, "点击确认登录", /click_confirm|确认登录点击完成|点击确认登录/],
    [100, "任务完成", /done|扫码完成/]
  ];
  if (status === "succeeded") return { percent: 100, label: "任务完成" };
  if (status === "cancelled") return { percent: 100, label: "已取消" };
  if (status === "expired") return { percent: 100, label: "已超时" };
  if (status === "submit_failed") return { percent: 100, label: "提交失败" };
  if (lastEvent.level === "error" || /失败|未找到|超时|error|failed/i.test(lastEvent.message || "")) {
    const failedAt = currentFromLastKnownStage(source);
    return { percent: failedAt.percent, label: `失败于：${failedAt.label}` };
  }
  let current = status === "running"
    ? { percent: 24, label: "执行器处理中" }
    : status === "queued"
      ? { percent: 16, label: "等待执行器领取" }
      : { percent: 8, label: "创建任务" };
  for (const [percent, label, matcher] of stages) {
    if (matcher.test(source) && percent >= current.percent) current = { percent, label };
  }
  if (status === "failed") return { ...current, label: `失败于：${current.label}` };
  return current;
}

function currentFromLastKnownStage(source) {
  const stages = [
    [24, "连接执行器", /poco_ready|poco_reused|airtest|poco 服务|执行器/],
    [30, "同步二维码到手机", /qr|二维码已推送|相册.*二维码|prepareqr|push/],
    [42, "重启小红书", /start_xhs|重启小红书|小红书已进入前台/],
    [48, "选择小红书槽位", /choose_slot|picker|双开|系统双开/],
    [56, "进入我的页面", /click_me|进入我的页面|profile|我的页面/],
    [66, "打开扫一扫", /click_scan|扫一扫|scanner/],
    [76, "打开相册", /click_album|打开相册|album/],
    [84, "选择二维码图片", /after_select_image|选择二维码图片|定位相册图片/],
    [90, "识别登录确认页", /confirm_visible|登录确认页断言|login-confirm/],
    [93, "等待确认登录", /confirm_wait|等待后点击确认/],
    [96, "点击确认登录", /click_confirm|确认登录点击完成|点击确认登录/]
  ];
  let current = { percent: 24, label: "执行器处理中" };
  for (const [percent, label, matcher] of stages) {
    if (matcher.test(source) && percent >= current.percent) current = { percent, label };
  }
  return current;
}

function renderUserXhsTaskCard(task) {
  const summary = task.summary || {};
  const lastEvent = summary.lastEvent || {};
  const message = summary.failureMessage || summary.progressMessage || lastEvent.message || "等待 Windows 管理器上报步骤";
  const eventCount = Number(summary.eventCount || 0);
  const screenshotCount = Number(summary.screenshotCount || 0);
  const account = [task.xhsAccountLabel || task.xhsAppSlot, task.xhsAccountName, task.xhsAccountId ? `ID ${task.xhsAccountId}` : ""].filter(Boolean).join(" · ") || "未命名槽位";
  const mode = task.executionMode === "windows_airtest_poco" ? "Airtest/Poco 扫码" : task.executionMode === "windows_xml_uiautomator" ? "XML UIAutomator 扫码" : task.executionMode === "windows_adb_uiautomator" ? "ADB 自动化扫码" : "兼容通道";
  const statusClass = xhsStatusClass(task.status);
  const progress = xhsTaskProgress(task);
  return `
    <article class="scan-task-card is-${escapeHtml(task.status || "unknown")}" data-user-xhs-task-id="${escapeHtml(task.taskId)}">
      <header>
        <div>
          <span>${escapeHtml(mode)}</span>
          <strong>${escapeHtml(account)}</strong>
        </div>
        <em class="${statusClass}">${escapeHtml(xhsStatusText(task.status))}</em>
      </header>
      <div class="scan-task-progress-meta">
        <span>${escapeHtml(progress.label)}</span>
        <strong>${escapeHtml(progress.percent)}%</strong>
      </div>
      <div class="scan-task-progress" aria-label="任务进度 ${escapeHtml(progress.percent)}%"><i style="width:${progress.percent}%"></i></div>
      <p>${escapeHtml(message)}</p>
      <footer>
        <span>${escapeHtml(shortTime(task.createdAt))}</span>
        <span>${eventCount} 条轨迹${screenshotCount ? ` · ${screenshotCount} 张截图` : ""}</span>
        ${task.cancellable ? `<button data-user-xhs-action="cancel" type="button">取消任务</button>` : ""}
      </footer>
    </article>
  `;
}

function renderXhsTaskSummary(task) {
  const summary = task.summary || {};
  const lastEvent = summary.lastEvent || {};
  const message = summary.failureMessage || summary.progressMessage || lastEvent.message || "";
  const eventCount = Number(summary.eventCount || 0);
  const screenshotCount = Number(summary.screenshotCount || 0);
  const mode = task.executionMode === "windows_airtest_poco" ? "Airtest/Poco" : task.executionMode === "windows_xml_uiautomator" ? "XML UIAutomator" : task.executionMode === "windows_adb_uiautomator" ? "ADB 自动化" : "旧 Agent 通道";
  const diagnosticText = [lastEvent.errorCode, lastEvent.currentActivity || lastEvent.packageName].filter(Boolean).join(" · ");
  const uiEvidence = pickTaskUiEvidence(task);
  const screenshots = task.evidenceLoaded ? collectTaskScreenshots(task) : [];
  const hasRunnerLog = Boolean(task.result?.runner?.log?.length || task.result?.runner?.error);
  const hasLoadedEvidence = screenshots.length || uiEvidence.text || uiEvidence.url || hasRunnerLog;
  if (!message && !eventCount) return `<small class="task-summary"><span>${escapeHtml(mode)}</span></small>`;
  return `
    <small class="task-summary">
      <span>${escapeHtml(mode)}</span>
      ${message ? `<span>${escapeHtml(message)}</span>` : ""}
      ${diagnosticText ? `<span>${escapeHtml(diagnosticText)}</span>` : ""}
      <span>${eventCount} 条轨迹${screenshotCount ? ` · ${screenshotCount} 张截图` : ""}${lastEvent.createdAt ? ` · ${escapeHtml(shortTime(lastEvent.createdAt))}` : ""}</span>
      ${task.evidenceLoaded ? renderTaskScreenshot(task) : ""}
      ${task.evidenceLoaded ? renderUiHierarchy(uiEvidence.text, uiEvidence.url) : ""}
      ${task.evidenceLoaded ? renderTaskRunnerLog(task) : ""}
      ${task.evidenceLoaded && !hasLoadedEvidence ? `<span class="task-evidence-empty">失败现场已加载，但执行器没有采集到手机截图或有效元素树。</span>` : ""}
    </small>
  `;
}

function pickTaskUiEvidence(task) {
  const candidates = [
    ...(Array.isArray(task?.events) ? [...task.events].reverse() : []),
    task?.result || null,
    task?.summary?.lastEvent || null
  ].filter(Boolean);
  let fallbackUrl = "";
  for (const item of candidates) {
    const url = String(item.uiHierarchyUrl || item.uiHierarchyEvidence?.url || item.uiSnapshotUrl || item.uiSnapshotEvidence?.url || "").trim();
    if (!fallbackUrl && url) fallbackUrl = url;
    const texts = [item.uiHierarchy, item.uiSnapshot, item.detail?.uiHierarchy, item.detail?.xml];
    for (const value of texts) {
      const text = String(value || "").trim();
      if (isMeaningfulUiHierarchy(text)) return { text, url };
    }
  }
  return { text: "", url: fallbackUrl };
}

function isMeaningfulUiHierarchy(value) {
  const text = String(value || "").trim();
  if (text.length < 24) return false;
  const normalized = text.toLowerCase();
  return !["killed", "null", "undefined", "none", "empty"].includes(normalized);
}

function renderTaskScreenshot(task) {
  const screenshots = collectTaskScreenshots(task);
  if (!screenshots.length) return "";
  return `
    <div class="task-screenshot-grid">
      ${screenshots.map((screenshot, index) => renderScreenshotThumb(screenshot, `任务失败截图 ${index + 1}`)).join("")}
    </div>
  `;
}

function collectTaskScreenshots(task) {
  const seen = new Set();
  const screenshots = [];
  const push = (screenshot) => {
    const src = screenshot?.dataUrl || screenshot?.url || "";
    if (!src || seen.has(src)) return;
    seen.add(src);
    screenshots.push(screenshot);
  };
  push(task?.result?.screenshot);
  push(task?.summary?.lastEvent?.screenshot);
  for (const event of Array.isArray(task?.events) ? task.events : []) push(event?.screenshot);
  return screenshots.slice(-6);
}

function renderScreenshotThumb(screenshot, label = "失败截图") {
  const src = screenshot?.dataUrl || screenshot?.url || "";
  if (!src) return "";
  const key = `shot_${screenshotStore.size + 1}`;
  screenshotStore.set(key, { ...screenshot, label });
  return `
    <button class="task-screenshot" data-screenshot-key="${escapeHtml(key)}" type="button">
      <img src="${escapeHtml(src)}" alt="${escapeHtml(label)}">
      <span>${escapeHtml(label)} · 点击放大</span>
    </button>
  `;
}

function renderUiHierarchy(uiHierarchy, uiHierarchyUrl = "") {
  const text = String(uiHierarchy || "").trim();
  const url = String(uiHierarchyUrl || "").trim();
  if (!text && !url) return "";
  return `
    <details class="task-ui-tree">
      <summary>查看失败页面元素树</summary>
      ${url ? `<a class="inline-action" href="${escapeHtml(url)}" target="_blank" rel="noopener">打开完整元素树</a>` : ""}
      <pre>${escapeHtml(text)}</pre>
    </details>
  `;
}

function renderTaskRunnerLog(task) {
  const logs = Array.isArray(task?.result?.runner?.log) ? task.result.runner.log : [];
  const error = task?.result?.runner?.error || "";
  if (!logs.length && !error) return "";
  const rows = logs.slice(-80).map((item, index) => {
    const step = item.step || item.stepId || `step-${index + 1}`;
    const timing = [item.elapsedMs != null ? `${item.elapsedMs}ms` : "", item.sinceLastMs != null ? `+${item.sinceLastMs}ms` : ""].filter(Boolean).join(" ");
    const message = [item.action, item.message, item.error].filter(Boolean).join(" · ");
    return `${step}${timing ? ` ${timing}` : ""}${message ? ` | ${message}` : ""}`;
  });
  if (error) rows.push(`runner error | ${error}`);
  return `
    <details class="task-runner-log">
      <summary>查看执行日志</summary>
      <pre>${escapeHtml(rows.join("\n"))}</pre>
    </details>
  `;
}

function openScreenshotModal(key) {
  const screenshot = screenshotStore.get(String(key || ""));
  const src = screenshot?.dataUrl || screenshot?.url || "";
  if (!src) return;
  closeScreenshotModal();
  const modal = document.createElement("div");
  modal.className = "screenshot-modal";
  modal.innerHTML = `
    <div class="screenshot-modal-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(screenshot.label || "失败截图")}">
      <header>
        <strong>${escapeHtml(screenshot.label || "失败截图")}</strong>
        <button data-screenshot-close type="button" aria-label="关闭截图">关闭</button>
      </header>
      <img src="${escapeHtml(src)}" alt="${escapeHtml(screenshot.label || "失败截图")}">
      <footer>
        <span>${escapeHtml([screenshot.adbSerial, screenshot.capturedAt].filter(Boolean).join(" · "))}</span>
      </footer>
    </div>
  `;
  document.body.appendChild(modal);
}

function closeScreenshotModal() {
  document.querySelectorAll(".screenshot-modal").forEach((modal) => modal.remove());
}

function renderSettings() {
  if (!els.settingsDisplayName) return;
  const user = state.user || {};
  const displayName = user.displayName || user.username || "未登录";
  const roleLabel = user.role === "admin" ? "管理员" : user.role === "user" ? "普通用户" : "-";
  const initial = String(displayName || "设").trim().slice(0, 1) || "设";
  if (els.settingsAvatar) els.settingsAvatar.textContent = initial;
  els.settingsDisplayName.textContent = displayName;
  if (els.settingsAccountMeta) {
    els.settingsAccountMeta.textContent = user.username
      ? `${user.username} · ${roleLabel}`
      : "登录后可以查看账号信息和当前会话。";
  }
  if (els.settingsAccountFacts) {
    const facts = [
      ["账号", user.username || "-"],
      ["显示名", user.displayName || user.username || "-"],
      ["角色", roleLabel],
      ["状态", user.enabled === false ? "已停用" : "正常"],
      ["最后登录", shortTime(user.lastLoginAt)],
      ["创建时间", shortTime(user.createdAt)]
    ];
    els.settingsAccountFacts.innerHTML = facts.map(([label, value]) => `
      <div>
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value || "-")}</strong>
      </div>
    `).join("");
  }
}

function openSettingsModal() {
  if (!state.user || !els.settingsModal) return;
  renderSettings();
  els.settingsModal.classList.remove("hidden");
  document.body.classList.add("settings-modal-open");
  els.settingsCloseButton?.focus?.();
}

function closeSettingsModal() {
  if (!els.settingsModal) return;
  els.settingsModal.classList.add("hidden");
  document.body.classList.remove("settings-modal-open");
}

function renderAudit() {
  if (!els.auditList) return;
  els.auditList.innerHTML = state.audit.length
    ? state.audit.slice(0, 120).map((item) => `
      <article class="data-row">
        <div>
          <strong>${escapeHtml(item.action)}</strong>
          <span>${escapeHtml(item.actor || "system")} · ${escapeHtml(shortTime(item.createdAt))}</span>
        </div>
        <code>${escapeHtml(JSON.stringify(item.detail || {}))}</code>
      </article>
    `).join("")
    : `<div class="empty">暂无审计日志。</div>`;
}

function statusText(status) {
  return { ok: "通过", warn: "注意", fail: "失败" }[status] || status || "-";
}


function currentWorkflowScript() {
  return (state.workflowScripts || []).find((script) => script.scriptId === "xhs_qr_default") || null;
}

function workflowListValue(value) {
  return Array.isArray(value) ? value.join("\n") : "";
}

function workflowListFromTextarea(value) {
  return String(value || "")
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function workflowNumber(input, fallback) {
  const number = Number(input?.value || fallback);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function workflowStepsFromTextarea(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("steps 必须是 JSON 数组");
  return parsed;
}

function touchWorkflowScriptEditing() {
  state.adminWorkflowScriptEditingUntil = Date.now() + 45_000;
}

function renderWorkflowScripts() {
  const script = currentWorkflowScript();
  if (!script) {
    if (els.workflowScriptPreview) els.workflowScriptPreview.innerHTML = `<div class="empty">暂无脚本配置，请刷新后重试。</div>`;
    return;
  }
  const timeouts = script.timeouts || {};
  const editing = Date.now() < Number(state.adminWorkflowScriptEditingUntil || 0);
  if (!editing && els.workflowScriptForm) {
    if (els.workflowScriptEnabled) els.workflowScriptEnabled.checked = script.enabled !== false;
    if (els.workflowConfirmWaitMs) els.workflowConfirmWaitMs.value = script.confirmWaitMs || 6000;
    if (els.workflowTimeoutTotalMs) els.workflowTimeoutTotalMs.value = timeouts.totalMs || 180000;
    if (els.workflowTimeoutRestartMs) els.workflowTimeoutRestartMs.value = timeouts.restartMs || 25000;
    if (els.workflowTimeoutProfileMs) els.workflowTimeoutProfileMs.value = timeouts.profileMs || 10000;
    if (els.workflowTimeoutScannerMs) els.workflowTimeoutScannerMs.value = timeouts.scannerMs || 10000;
    if (els.workflowTimeoutAlbumMs) els.workflowTimeoutAlbumMs.value = timeouts.albumMs || 10000;
    if (els.workflowTimeoutSelectImageMs) els.workflowTimeoutSelectImageMs.value = timeouts.selectImageMs || 14000;
    if (els.workflowTimeoutLoginConfirmMs) els.workflowTimeoutLoginConfirmMs.value = timeouts.loginConfirmMs || 45000;
    if (els.workflowLoginKeywords) els.workflowLoginKeywords.value = workflowListValue(script.loginConfirmKeywords);
    if (els.workflowOrdinaryButtons) els.workflowOrdinaryButtons.value = workflowListValue(script.ordinaryConfirmButtons);
    if (els.workflowPlatformButtons) els.workflowPlatformButtons.value = workflowListValue(script.platformConfirmButtons);
    if (els.workflowScriptSteps) els.workflowScriptSteps.value = JSON.stringify(script.steps || [], null, 2);
  }
  if (els.workflowScriptMeta) {
    const updated = script.updatedAt ? ` · 最近保存 ${shortTime(script.updatedAt)}` : " · 使用默认配置";
    els.workflowScriptMeta.textContent = `${script.enabled === false ? "已停用" : "已启用"} · ${script.version || "xhs_qr_default"}${updated}`;
  }
  if (els.workflowScriptPreview) {
    const rows = [
      ["脚本 ID", script.scriptId || "xhs_qr_default"],
      ["启用状态", script.enabled === false ? "停用" : "启用"],
      ["确认等待", `${script.confirmWaitMs || 6000} ms`],
      ["确认页关键词", (script.loginConfirmKeywords || []).join(" / ")],
      ["普通确认按钮", (script.ordinaryConfirmButtons || []).join(" / ")],
      ["平台确认按钮", (script.platformConfirmButtons || []).join(" / ")],
      ["步骤数量", `${(script.steps || []).length} 步`],
      ["任务总超时", `${timeouts.totalMs || 180000} ms`],
      ["确认页超时", `${timeouts.loginConfirmMs || 45000} ms`]
    ];
    els.workflowScriptPreview.innerHTML = rows.map(([key, value]) => `
      <div class="script-preview-row">
        <span>${escapeHtml(key)}</span>
        <strong>${escapeHtml(value || "-")}</strong>
      </div>
    `).join("");
  }
}

function renderDiagnostics() {
  if (!els.diagnosticsSummary || !els.diagnosticsChecks || !els.diagnosticsDetail) return;
  const diagnostics = state.diagnostics;
  if (!diagnostics) {
    els.diagnosticsSummary.innerHTML = `<div class="empty">暂无诊断数据。</div>`;
    els.diagnosticsChecks.innerHTML = "";
    els.diagnosticsDetail.innerHTML = "";
    renderRealtimeDiagnostics();
    return;
  }

  const warningList = diagnostics.warnings?.length ? diagnostics.warnings.join("、") : "无";
  const launch = diagnostics.launchReadiness || {};
  const launchStatus = launch.status || "unknown";
  els.diagnosticsSummary.innerHTML = `
    <article class="diagnostic-banner ${escapeHtml(diagnostics.status)}">
      <div>
        <strong>${escapeHtml(statusText(diagnostics.status))}</strong>
        <span>${escapeHtml(diagnostics.generatedAt ? shortTime(diagnostics.generatedAt) : "-")} · 上线门禁: ${escapeHtml(launchStatus)} · ${escapeHtml(launch.summary || "未计算")} · warnings: ${escapeHtml(warningList)}</span>
      </div>
      <em class="${diagnostics.status === "ok" ? "ok" : diagnostics.status === "fail" ? "bad" : "warn"}">${escapeHtml(diagnostics.status)}</em>
    </article>
  `;
  const launchCards = (launch.gates || []).map((gate) => `
    <article class="check-card ${gate.status === "fail" ? "fail" : gate.status === "warn" ? "warn" : "ok"}">
      <header>
        <strong>${escapeHtml(gate.label)}</strong>
        <em class="${gate.status === "ok" ? "ok" : gate.status === "fail" ? "bad" : "warn"}">${escapeHtml(statusText(gate.status))}</em>
      </header>
      <span>${escapeHtml(gate.detail)}</span>
    </article>
  `).join("");
  const diagnosticCards = (diagnostics.checks || []).map((check) => `
    <article class="check-card ${escapeHtml(check.status)}">
      <header>
        <strong>${escapeHtml(check.label)}</strong>
        <em class="${check.status === "ok" ? "ok" : check.status === "fail" ? "bad" : "warn"}">${escapeHtml(statusText(check.status))}</em>
      </header>
      <span>${escapeHtml(check.detail)}</span>
    </article>
  `).join("");
  els.diagnosticsChecks.innerHTML = `${launchCards}${diagnosticCards}`;

  const rows = [
    ["上线状态", launchStatus],
    ["上线摘要", launch.summary || "-"],
    ["阻塞项", (launch.blockers || []).join("、") || "无"],
    ["复核项", (launch.reviews || []).join("、") || "无"],
    ["环境", diagnostics.runtime?.env],
    ["Node", diagnostics.runtime?.nodeVersion],
    ["监听", `${diagnostics.runtime?.host || "-"}:${diagnostics.runtime?.port || "-"}`],
    ["公网地址", diagnostics.runtime?.publicBaseUrl || "-"],
    ["运行时间", `${diagnostics.runtime?.uptimeSeconds || 0}s`],
    ["状态存储", diagnostics.storage?.backend || "-"],
    ["JSON 生产确认", diagnostics.storage?.jsonStorageProductionAck ? "已确认" : "未确认"],
    ["数据目录", diagnostics.storage?.dataDir?.path],
    ["状态文件", diagnostics.storage?.dataFile?.exists ? `${diagnostics.storage.dataFile.sizeBytes} bytes` : "未创建"],
    ["发布 APK", diagnostics.storage?.releaseFile?.exists ? `${diagnostics.storage.releaseFile.sizeBytes} bytes` : "未上传"],
    ["Windows 管理器", `${diagnostics.counts?.onlineAgents || 0}/${diagnostics.counts?.windowsAgents || 0}`],
    ["ADB 手机", `${diagnostics.counts?.adbOnline || 0}/${diagnostics.counts?.devices || 0}`],
    ["Airtest/Poco 自动化", (diagnostics.checks || []).find((check) => check.key === "airtest_poco")?.detail || "-"],
    ["兼容 Agent", `${diagnostics.counts?.agentOnline || 0}/${diagnostics.counts?.devices || 0}`],
    ["短信等待上限", `${diagnostics.limits?.userMaxWaitingSms || 0}/用户`],
    ["扫码任务上限", `${diagnostics.limits?.userMaxActiveXhsTasks || 0}/用户`],
    ["设备扫码并发", `${diagnostics.limits?.deviceMaxActiveXhsTasks || 0}/手机`],
    ["ADB 任务 TTL", `${diagnostics.limits?.windowsTaskTtlSeconds || 0}s`],
    ["扫码任务 TTL", `${diagnostics.limits?.xhsTaskTtlSeconds || 0}s`],
    ["数据保留", `${diagnostics.retention?.retentionDays || 0} 天`],
    ["待清理记录", Object.values(diagnostics.retention?.pendingRemoval || {}).reduce((sum, value) => sum + Number(value || 0), 0)],
    ["活跃设备锁", diagnostics.counts?.deviceLocks ?? 0],
    ["扫码成功率", diagnostics.counts?.xhsSuccessRate === null || diagnostics.counts?.xhsSuccessRate === undefined ? "-" : `${diagnostics.counts.xhsSuccessRate}%`],
    ["失败原因排行", (diagnostics.counts?.taskFailureReasons || []).map((item) => `${item.reason}(${item.count})`).join("、") || "无"],
    ["近 10 分钟异常", (diagnostics.recentIssues || []).map((item) => item.message).slice(0, 5).join("、") || "无"]
  ];
  els.diagnosticsDetail.innerHTML = rows.map(([key, value]) => `
    <div>
      <dt>${escapeHtml(key)}</dt>
      <dd>${escapeHtml(value || "-")}</dd>
    </div>
  `).join("");
  renderRealtimeDiagnostics();
}

function renderRealtimeDiagnostics() {
  if (!els.realtimeDiagnostics) return;
  const realtime = state.operationsMetrics?.realtime;
  if (!realtime) {
    els.realtimeDiagnostics.innerHTML = `<div class="empty">正在读取实时控制监控数据。</div>`;
    return;
  }
  const sessionRows = realtime.video?.sessions || [];
  const recentSessions = realtime.sessions?.recent || [];
  const summary = [
    ["活跃投屏", `${realtime.sessions?.active || 0}`],
    ["服务端转发", `${formatMetric(realtime.video?.totalBytes / 1024 / 1024, 1)} MB`],
    ["视频丢包", `${realtime.video?.totalDroppedPackets || 0}`],
    ["控制 RTT P95", `${formatMetric(realtime.control?.rttMs?.p95, 0)} ms`],
    ["Agent 执行 P95", `${formatMetric(realtime.control?.agentElapsedMs?.p95, 0)} ms`],
    ["服务端事件循环 P95", `${formatMetric(realtime.eventLoopDelayMs?.p95, 1)} ms`],
    ["服务端 CPU", `${formatMetric(realtime.runtime?.processCpuPercent, 1)}%`]
  ];
  const findings = buildRealtimeFindings(realtime, state.operationsMetrics?.agents || []);
  const sessions = sessionRows.length ? `
    <div class="realtime-session-table" role="table" aria-label="实时控制会话">
      <div class="realtime-session-row realtime-session-heading" role="row">
        <span>设备 / 管理器</span><span>Agent 编码</span><span>浏览器解码</span><span>丢帧 / 缓冲</span><span>控制 RTT</span>
      </div>
      ${sessionRows.map((session) => {
        const agent = session.agent || {};
        const browser = session.browser || {};
        return `<div class="realtime-session-row" role="row">
          <span><strong>${escapeHtml(session.deviceId || "-")}</strong><small>${escapeHtml(session.agentId || "-")}</small></span>
          <span>${formatMetric(agent.fps, 1)} FPS<small>${formatMetric(agent.megabitsPerSecond, 2)} Mbps · ${agent.width || "-"}×${agent.height || "-"}</small></span>
          <span>${formatMetric(browser.fps, 1)} FPS<small>呈现 ${browser.presented || 0} · 解码 ${browser.decoded || 0}</small></span>
          <span>${agent.droppedFrames || 0} / ${browser.dropped || 0}<small>${formatMetric(browser.bufferMs, 0)} ms · relay ${formatMetric(agent.bufferedBytes / 1024, 0)} KB</small></span>
          <span>${formatMetric(browser.controlRttMs || realtime.control?.rttMs?.p95, 0)} ms<small>Agent ${formatMetric(browser.agentControlMs || realtime.control?.agentElapsedMs?.p95, 0)} ms</small></span>
        </div>`;
      }).join("")}
    </div>` : `<div class="empty">当前没有实时控制会话。开始投屏后，这里会显示该会话的链路指标。</div>`;
  const history = recentSessions.length ? `
    <div class="realtime-history">
      <div class="realtime-history-head"><strong>最近结束会话</strong><span>保留有限数值采样，不包含视频或操作内容</span></div>
      <div class="realtime-session-table" role="table" aria-label="最近结束的实时控制会话">
        <div class="realtime-session-row realtime-session-heading" role="row">
          <span>设备</span><span>结束原因 / 时长</span><span>结束前 Agent</span><span>结束前浏览器</span><span>控制 RTT</span>
        </div>
        ${recentSessions.slice(0, 8).map((session) => {
          const agent = session.agent || session.agentSamples?.at(-1) || {};
          const browser = session.browser || session.browserSamples?.at(-1) || {};
          return `<div class="realtime-session-row" role="row">
            <span><strong>${escapeHtml(session.deviceId || "-")}</strong><small>${escapeHtml(session.agentId || "-")}</small></span>
            <span>${escapeHtml(screenCloseReasonLabel(session.closeReason))}<small>${formatDurationMs(session.durationMs)} · ${escapeHtml(formatDateTime(session.endedAt))}</small></span>
            <span>${formatMetric(agent.fps, 1)} FPS<small>${formatMetric(agent.megabitsPerSecond, 2)} Mbps</small></span>
            <span>${formatMetric(browser.fps, 1)} FPS<small>丢帧 ${browser.dropped || 0} · 缓冲 ${formatMetric(browser.bufferMs, 0)} ms</small></span>
            <span>${formatMetric(browser.controlRttMs, 0)} ms<small>Agent ${formatMetric(browser.agentControlMs, 0)} ms</small></span>
          </div>`;
        }).join("")}
      </div>
    </div>` : "";
  els.realtimeDiagnostics.innerHTML = `
    <div class="realtime-diagnostic-summary">
      ${summary.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}
    </div>
    <div class="realtime-findings">
      <strong>链路判断</strong>
      <ul>${findings.map((finding) => `<li class="${escapeHtml(finding.level)}">${escapeHtml(finding.message)}</li>`).join("")}</ul>
    </div>
    ${sessions}
    ${history}
  `;
}

function buildRealtimeFindings(realtime, agents) {
  const findings = [];
  const serverRuntime = realtime.runtime || {};
  if (Number(realtime.eventLoopDelayMs?.p95 || 0) >= 60) {
    findings.push({ level: "warn", message: `服务端事件循环 P95 ${formatMetric(realtime.eventLoopDelayMs.p95, 1)} ms，服务端处理可能正在排队。` });
  }
  if (Number(serverRuntime.processCpuPercent || 0) >= 75) {
    findings.push({ level: "warn", message: `服务端进程 CPU ${formatMetric(serverRuntime.processCpuPercent, 1)}%，需要结合并发会话数检查服务端资源。` });
  }
  for (const agent of agents) {
    const runtime = agent.runtime || {};
    if (Number(runtime.processCpuPercent || 0) >= 120) {
      findings.push({ level: "warn", message: `${agent.agentName || agent.agentId} 进程 CPU ${formatMetric(runtime.processCpuPercent, 1)}%，Windows 编码或 ADB 处理可能成为瓶颈。` });
    }
    if (Number(runtime.hostMemoryUsedPercent || 0) >= 90) {
      findings.push({ level: "warn", message: `${agent.agentName || agent.agentId} 系统内存使用 ${formatMetric(runtime.hostMemoryUsedPercent, 0)}%，可能影响长期投屏稳定性。` });
    }
  }
  for (const session of realtime.video?.sessions || []) {
    const agent = session.agent || {};
    const browser = session.browser || {};
    if (agent.reportedAt && !browser.reportedAt) {
      findings.push({ level: "info", message: `${session.deviceId || session.sessionId} 已收到编码数据，正在等待浏览器首个 5 秒播放采样。` });
      continue;
    }
    if (Number(agent.fps || 0) >= 12 && Number(browser.fps || 0) > 0 && Number(agent.fps) - Number(browser.fps) >= 8) {
      findings.push({ level: "warn", message: `${session.deviceId || session.sessionId} Agent ${formatMetric(agent.fps, 1)} FPS、浏览器 ${formatMetric(browser.fps, 1)} FPS，瓶颈偏向浏览器解码或浏览器到用户网络。` });
    }
    if (Number(agent.bufferedBytes || 0) >= 1_000_000 || Number(agent.droppedFrames || 0) >= 30) {
      findings.push({ level: "warn", message: `${session.deviceId || session.sessionId} Agent 缓冲 ${formatMetric(agent.bufferedBytes / 1024 / 1024, 1)} MB、丢帧 ${agent.droppedFrames || 0}，瓶颈偏向 Windows 编码或上行转发。` });
    }
    if (Number(browser.controlRttMs || 0) >= 300 && Number(browser.agentControlMs || 0) < 80) {
      findings.push({ level: "warn", message: `${session.deviceId || session.sessionId} 控制往返 ${formatMetric(browser.controlRttMs, 0)} ms，但手机执行仅 ${formatMetric(browser.agentControlMs, 0)} ms，延迟偏向网络或服务器转发。` });
    }
  }
  for (const session of (realtime.sessions?.recent || []).slice(0, 5)) {
    const agent = session.agent || session.agentSamples?.at(-1) || {};
    const browser = session.browser || session.browserSamples?.at(-1) || {};
    if (Number(agent.fps || 0) >= 12 && Number(browser.fps || 0) > 0 && Number(agent.fps) - Number(browser.fps) >= 8) {
      findings.push({ level: "warn", message: `最近结束的 ${session.deviceId || session.sessionId}：Agent ${formatMetric(agent.fps, 1)} FPS、浏览器 ${formatMetric(browser.fps, 1)} FPS，浏览器侧或用户网络存在解码/接收压力。` });
    }
  }
  return findings.length ? findings.slice(0, 8) : [{ level: "ok", message: "当前采样未出现明显的服务端、Windows 管理器或浏览器链路压力。" }];
}

function formatDurationMs(value) {
  const seconds = Math.max(0, Math.round(Number(value || 0) / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function screenCloseReasonLabel(reason) {
  return {
    user_closed: "用户结束",
    browser_disconnected: "浏览器断开",
    session_failed: "执行失败",
    stream_ended: "画面流结束",
    expired: "会话超时",
    failed: "启动失败"
  }[String(reason || "")] || "会话结束";
}

function formatMetric(value, digits = 0) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return "0";
  return numeric.toFixed(digits).replace(/\.0+$/, "");
}

function render() {
  screenshotStore.clear();
  renderShell();
  if (!state.user) return;
  if (state.page === "user-workbench") {
    renderUserWorkbench();
    renderSettings();
    return;
  }
  if (state.user.role !== "admin") {
    renderSettings();
    return;
  }
  if (state.page === "dashboard") renderOverview();
  if (state.page === "users") renderUsers();
  if (state.page === "windows") renderWindows();
  if (state.page === "devices") renderDevices();
  if (state.page === "release") renderRelease();
  if (state.page === "sms") renderSms();
  if (state.page === "xhs") renderXhs();
  if (state.page === "workflow-scripts") renderWorkflowScripts();
  if (state.page === "diagnostics") renderDiagnostics();
  if (state.page === "audit") renderAudit();
  renderSettings();
}

async function loadAll() {
  if (loadAllInFlight) return;
  loadAllInFlight = true;
  try {
  const requestId = ++latestLoadAllRequestId;
  const lookupSyncVersionAtStart = userLookupSyncVersion;
  if (!state.token) {
    state.user = null;
    if (requestId !== latestLoadAllRequestId) return;
    render();
    return;
  }
  let me;
  try {
    me = await api("/api/v1/auth/me");
  } catch (error) {
    if (error.status === 401) {
      state.token = "";
      state.user = null;
      didApplyUserDefaultLanding = false;
      localStorage.removeItem("phoneCloudSessionToken");
      if (requestId !== latestLoadAllRequestId) return;
      render();
      return;
    }
    throw error;
  }
  if (requestId !== latestLoadAllRequestId) return;
  state.user = me.user || null;
  if (state.user?.role !== "admin" && !didApplyUserDefaultLanding) {
    restoreUserWorkbenchRoute();
    didApplyUserDefaultLanding = true;
  }
  if (state.user?.role === "admin" && !didApplyUserDefaultLanding) {
    didApplyUserDefaultLanding = true;
    state.page = allowedPages().includes(state.page) ? state.page : "dashboard";
    localStorage.setItem("phoneCloudPage", state.page);
  }
  const usesUserWorkbench = state.page === "user-workbench";
  if (state.user?.role !== "admin" || usesUserWorkbench) {
    state.userDevicesLoading = true;
    state.userDevicesLoadError = "";
  }
  render();

  if (state.user?.role !== "admin" || usesUserWorkbench) {
    renderUserWorkbench();
    const shouldLoadXhsTasks = isUserScanPanelActive();
    const auxiliaryRequests = Promise.allSettled([
      api("/api/v1/user/phones"),
      api("/api/v1/user/sms-orders"),
      shouldLoadXhsTasks ? api("/api/v1/user/xhs/qr-scan-tasks") : Promise.resolve(null),
      api("/api/v1/user/automation/xhs-publish-tasks"),
      api("/api/v1/user/automation/kuaishou-lead-tasks"),
      api("/api/v1/user/automation/alipay-name-sessions")
    ]);
    let devices;
    try {
      devices = await loadStableUserDeviceInventory();
    } catch (error) {
      if (requestId === latestLoadAllRequestId) {
        state.userDevicesLoading = false;
        state.userDevicesLoadError = error.message || "请求失败，请稍后重试。";
        render();
      }
      throw error;
    }
    if (requestId !== latestLoadAllRequestId) return;
    state.userDevices = devices.devices || [];
    state.userDevicesLoading = false;
    state.userDevicesLoadError = "";
    state.userDevicesLoadedAt = Date.now();
    if (state.userSelectedDeviceId && !state.userDevices.some((device) => device.deviceId === state.userSelectedDeviceId)) {
      state.userSelectedDeviceId = "";
      state.userWorkbenchView = "inventory";
      localStorage.removeItem("phoneCloudUserSelectedDeviceId");
      localStorage.setItem("phoneCloudUserWorkbenchView", state.userWorkbenchView);
    }
    renderUserWorkbench();

    const [phones, orders, xhs, publish, kuaishou, lookup] = await auxiliaryRequests;
    if (requestId !== latestLoadAllRequestId) return;
    if (phones.status === "fulfilled") state.userPhones = phones.value.phones || [];
    else console.warn("user phones refresh failed", phones.reason);
    if (orders.status === "fulfilled") state.userSmsOrders = orders.value.orders || [];
    else console.warn("user sms orders refresh failed", orders.reason);
    if (xhs.status === "fulfilled" && xhs.value) state.userXhsTasks = xhs.value.tasks || [];
    else if (xhs.status === "rejected") console.warn("user xhs task refresh failed", xhs.reason);
    if (publish.status === "fulfilled") state.userPublishTasks = publish.value.tasks || [];
    else console.warn("user publish task refresh failed", publish.reason);
    if (kuaishou.status === "fulfilled") state.userKuaishouTasks = kuaishou.value.tasks || [];
    else console.warn("user Kuaishou lead task refresh failed", kuaishou.reason);
    if (lookup.status === "fulfilled" && canApplyLookupRefresh(lookupSyncVersionAtStart)) {
      state.userLookupSessions = lookup.value.sessions || [];
    } else if (lookup.status === "rejected") {
      console.warn("user lookup session refresh failed", lookup.reason);
    }
    prunePendingUserXhsTasks();
    if (isUserSmsPanelActive()) {
      loadUserSmsLibrary().catch((error) => console.warn("user sms library load failed", error));
    } else if (state.userWorkbenchView !== "detail" || !state.userSelectedDeviceId) {
      latestUserSmsRequestId++;
      state.userDeviceSmsMessages = [];
      state.userDeviceSmsTotal = 0;
      state.userDeviceSmsLoading = false;
      state.userDeviceSmsLoadingDeviceId = "";
      state.userDeviceSmsLoadedAt = 0;
      state.userDeviceSmsLoadedDeviceId = "";
      state.userDeviceSmsLoadedQueryKey = "";
      state.userSmsLoadError = "";
      state.userSmsPage = 1;
    }
    if (requestId !== latestLoadAllRequestId) return;
    render();
    return;
  }

  await loadAdminPageData(requestId);
  if (requestId !== latestLoadAllRequestId) return;
  render();
  } finally {
    loadAllInFlight = false;
  }
}

async function loadAdminPageData(requestId) {
  const page = state.page;
  if (page === "dashboard") {
    const payload = await api("/api/v1/overview");
    if (requestId === latestLoadAllRequestId) state.overview = payload.overview || {};
    return;
  }
  if (page === "users") {
    const payload = await api("/api/v1/users");
    if (requestId === latestLoadAllRequestId) state.users = payload.users || [];
    return;
  }
  if (page === "windows") {
    const [agents, devices, tasks] = await Promise.all([
      api("/api/v1/windows-agents"),
      api("/api/v1/devices"),
      api("/api/v1/windows-agent-tasks")
    ]);
    if (requestId !== latestLoadAllRequestId) return;
    state.agents = agents.agents || [];
    state.devices = devices.devices || [];
    state.windowsTasks = tasks.tasks || [];
    return;
  }
  if (page === "devices") {
    const payload = await api("/api/v1/devices");
    if (requestId === latestLoadAllRequestId) state.devices = payload.devices || [];
    return;
  }
  if (page === "sms") {
    const [devices, orders, events, smsLibrary] = await Promise.all([
      api("/api/v1/devices"),
      api("/api/v1/sms-orders"),
      api("/api/v1/sms-events"),
      api(`/api/v1/sms-library${smsLibraryQuery()}`)
    ]);
    if (requestId !== latestLoadAllRequestId) return;
    state.devices = devices.devices || [];
    state.smsOrders = orders.orders || [];
    state.smsEvents = events.events || [];
    state.smsMessages = smsLibrary.messages || [];
    return;
  }
  if (page === "xhs") {
    const [devices, xhs] = await Promise.all([
      api("/api/v1/devices"),
      api(xhsTaskQuery())
    ]);
    if (requestId !== latestLoadAllRequestId) return;
    state.devices = devices.devices || [];
    state.xhsTasks = mergeAdminXhsTaskList(xhs.tasks || []);
    state.xhsTaskTotal = Number(xhs.total || state.xhsTasks.length || 0);
    return;
  }
  if (page === "workflow-scripts") {
    const payload = await api("/api/v1/workflow-scripts");
    if (requestId === latestLoadAllRequestId) state.workflowScripts = payload.scripts || [];
    return;
  }
  if (page === "release") {
    const payload = await api("/api/v1/app-release/latest").catch(() => ({ release: null }));
    if (requestId === latestLoadAllRequestId) state.appRelease = payload.release || null;
    return;
  }
  if (page === "diagnostics") {
    const [diagnosticPayload, metricsPayload] = await Promise.all([
      api("/api/v1/diagnostics"),
      api("/api/v1/metrics/operations")
    ]);
    if (requestId === latestLoadAllRequestId) {
      state.diagnostics = diagnosticPayload.diagnostics || null;
      state.operationsMetrics = metricsPayload.metrics || null;
    }
    return;
  }
  if (page === "audit") {
    const payload = await api("/api/v1/audit");
    if (requestId === latestLoadAllRequestId) state.audit = payload.audit || [];
  }
}

function smsLibraryQuery() {
  if (!els.smsLibraryForm) return "";
  const params = new URLSearchParams();
  const deviceId = els.smsLibraryDeviceSelect?.value || "";
  const box = els.smsLibraryBoxSelect?.value || "all";
  const q = els.smsLibrarySearchInput?.value || "";
  if (deviceId) params.set("deviceId", deviceId);
  if (box && box !== "all") params.set("box", box);
  if (q.trim()) params.set("q", q.trim());
  params.set("limit", "200");
  const query = params.toString();
  return query ? `?${query}` : "";
}

function userDeviceSmsLibraryQuery(deviceId) {
  const params = new URLSearchParams();
  const pageSize = normalizedUserSmsPageSize();
  const page = Math.max(1, Number(state.userSmsPage || 1));
  params.set("limit", String(pageSize));
  params.set("offset", String((page - 1) * pageSize));
  if (state.userSmsSearch.trim()) params.set("q", state.userSmsSearch.trim());
  if (state.userSmsSimFilter !== "") params.set("slotIndex", state.userSmsSimFilter);
  if (state.userSmsCodeOnly) params.set("codeOnly", "1");
  return `/api/v1/user/devices/${encodeURIComponent(deviceId)}/sms-library?${params.toString()}`;
}

function normalizedUserSmsPageSize() {
  const size = Number(state.userSmsPageSize || 20);
  return [10, 20, 50, 100].includes(size) ? size : 20;
}

function userSmsTotalPages() {
  return Math.max(1, Math.ceil((state.userDeviceSmsTotal || 0) / normalizedUserSmsPageSize()));
}

function userSmsRefreshRemainingSeconds() {
  return Math.max(0, Math.ceil((Number(state.userSmsRefreshCooldownUntil || 0) - Date.now()) / 1000));
}

function updateUserSmsRefreshButton(selectedDevice = state.userDevices.find((device) => device.deviceId === state.userSelectedDeviceId)) {
  if (!els.userDeviceSmsRefreshButton) return;
  const refreshing = Boolean(state.userSmsRefreshDeviceId && state.userSmsRefreshDeviceId === state.userSelectedDeviceId);
  const remaining = userSmsRefreshRemainingSeconds();
  els.userDeviceSmsRefreshButton.disabled = !selectedDevice || refreshing || remaining > 0;
  els.userDeviceSmsRefreshButton.textContent = refreshing
    ? "同步中…"
    : remaining > 0
      ? `${remaining}s 后刷新`
      : "主动刷新";
  els.userDeviceSmsRefreshButton.title = remaining > 0
    ? "为避免频繁读取手机短信库，10 秒内只能主动刷新一次"
    : "立即通知 Windows 管理器读取这台手机的短信库";
  if (remaining > 0 && !userSmsRefreshCooldownTimer) {
    userSmsRefreshCooldownTimer = setInterval(() => {
      updateUserSmsRefreshButton();
      if (!userSmsRefreshRemainingSeconds()) {
        clearInterval(userSmsRefreshCooldownTimer);
        userSmsRefreshCooldownTimer = null;
      }
    }, 1000);
  }
}

function isUserSmsPanelActive() {
  return Boolean(
    state.token
    && state.page === "user-workbench"
    && state.userWorkbenchView === "detail"
    && state.userDetailTab === "sms"
    && state.userSelectedDeviceId
  );
}

async function autoRefreshCurrentUserSmsLibrary() {
  if (!isUserSmsPanelActive()) return;
  const deviceId = state.userSelectedDeviceId;
  if (state.userSmsRefreshDeviceId === deviceId || (state.userDeviceSmsLoading && state.userDeviceSmsLoadingDeviceId === deviceId)) return;
  const now = Date.now();
  const lastAt = Number(userSmsLastAutoRefreshAtByDevice.get(deviceId) || 0);
  if (now - lastAt < USER_SMS_AUTO_REFRESH_MS) return;
  userSmsLastAutoRefreshAtByDevice.set(deviceId, now);
  const needsDeviceSync = !userSmsDeviceSyncRequestedByDevice.has(deviceId);
  try {
    // Background synchronization is deliberately independent from the manual
    // refresh action. It may reuse an in-flight Agent task on the server, but
    // must never turn the user's button into "同步中" or consume its cooldown.
    if (needsDeviceSync) {
      await api(`/api/v1/user/devices/${encodeURIComponent(deviceId)}/sms-library/refresh`, {
        method: "POST",
        body: JSON.stringify({ source: "sms_panel_open" })
      });
      userSmsDeviceSyncRequestedByDevice.add(deviceId);
    }
    await loadUserSmsLibrary({ force: true });
    if (needsDeviceSync) {
      setTimeout(() => {
        if (state.userSelectedDeviceId === deviceId && isUserSmsPanelActive()) {
          loadUserSmsLibrary({ force: true }).catch(() => {});
        }
      }, 3000);
    }
  } catch (error) {
    if (error.code !== "sms_refresh_too_frequent" && error.code !== "sms_refresh_unavailable") {
      console.warn("auto sms refresh failed", error);
    }
  }
}

async function reloadUserSmsFirstPage() {
  state.userSmsPage = 1;
  await loadUserSmsLibrary({ force: true });
}

async function loadUserSmsLibrary(options = {}) {
  if (!isUserSmsPanelActive()) return;
  const deviceId = state.userSelectedDeviceId;
  const query = userDeviceSmsLibraryQuery(deviceId);
  const deviceChanged = state.userDeviceSmsLoadedDeviceId !== deviceId;
  const queryChanged = state.userDeviceSmsLoadedQueryKey !== query;
  const needsInitialLoad = !state.userDeviceSmsLoadedAt || deviceChanged || queryChanged;
  if (!options.force && !needsInitialLoad) return;

  const requestId = ++latestUserSmsRequestId;
  state.userDeviceSmsLoading = true;
  state.userDeviceSmsLoadingDeviceId = deviceId;
  state.userSmsLoadError = "";
  if (deviceChanged) {
    state.userDeviceSmsMessages = [];
    state.userDeviceSmsTotal = 0;
  }
  renderUserWorkbench();

  try {
    const sms = await api(query);
    if (requestId !== latestUserSmsRequestId || deviceId !== state.userSelectedDeviceId) return;
    state.userDeviceSmsMessages = sms.messages || [];
    state.userDeviceSmsTotal = Number(sms.total || 0);
    const totalPages = userSmsTotalPages();
    if (state.userSmsPage > totalPages) {
      state.userSmsPage = totalPages;
      await loadUserSmsLibrary({ force: true });
      return;
    }
  } catch (error) {
    if (requestId !== latestUserSmsRequestId || deviceId !== state.userSelectedDeviceId) return;
    state.userSmsLoadError = error.message || "无法读取短信库，请稍后重试。";
  } finally {
    if (requestId !== latestUserSmsRequestId || deviceId !== state.userSelectedDeviceId) return;
    state.userDeviceSmsLoadedAt = Date.now();
    state.userDeviceSmsLoadedDeviceId = deviceId;
    state.userDeviceSmsLoadedQueryKey = userDeviceSmsLibraryQuery(deviceId);
    state.userDeviceSmsLoading = false;
    state.userDeviceSmsLoadingDeviceId = "";
    renderUserWorkbench();
  }
}

async function refreshUserXhsTasksOnly(options = {}) {
  if (!options.force && !shouldFastRefreshUserXhsTasks()) return;
  if (userAutomationRefreshPromise) return userAutomationRefreshPromise;
  userAutomationRefreshPromise = (async () => {
    const requestId = ++latestUserAutomationRefreshRequestId;
    const [qrPayload, publishPayload, kuaishouPayload] = await Promise.allSettled([
      api("/api/v1/user/xhs/qr-scan-tasks"),
      api("/api/v1/user/automation/xhs-publish-tasks"),
      api("/api/v1/user/automation/kuaishou-lead-tasks")
    ]);
    if (requestId !== latestUserAutomationRefreshRequestId) return;
    if (qrPayload.status === "fulfilled") state.userXhsTasks = qrPayload.value.tasks || [];
    else console.warn("user xhs task refresh failed", qrPayload.reason);
    if (publishPayload.status === "fulfilled") state.userPublishTasks = publishPayload.value.tasks || [];
    else console.warn("user publish task refresh failed", publishPayload.reason);
    if (kuaishouPayload.status === "fulfilled") state.userKuaishouTasks = kuaishouPayload.value.tasks || [];
    else console.warn("user Kuaishou lead task refresh failed", kuaishouPayload.reason);
    prunePendingUserXhsTasks();
    renderUserWorkbench();
  })();
  try {
    return await userAutomationRefreshPromise;
  } finally {
    userAutomationRefreshPromise = null;
  }
}

async function refreshUserLookupSessionsOnly(options = {}) {
  if (!options.force && !shouldFastRefreshUserLookupSessions()) return;
  if (userLookupRefreshPromise) return userLookupRefreshPromise;
  userLookupRefreshPromise = (async () => {
    const lookupSyncVersionAtStart = userLookupSyncVersion;
    const payload = await api("/api/v1/user/automation/alipay-name-sessions");
    if (canApplyLookupRefresh(lookupSyncVersionAtStart)) state.userLookupSessions = payload.sessions || [];
    renderUserWorkbench();
    return payload;
  })();
  try {
    return await userLookupRefreshPromise;
  } finally {
    userLookupRefreshPromise = null;
  }
}

async function refreshCurrentUserSmsLibrary() {
  const deviceId = state.userSelectedDeviceId;
  if (!deviceId) return;
  const remaining = userSmsRefreshRemainingSeconds();
  if (remaining > 0) {
    alert(`短信库刷新太频繁，请 ${remaining} 秒后再试。`);
    return;
  }
  state.userSmsRefreshDeviceId = deviceId;
  state.userSmsRefreshCooldownUntil = Date.now() + USER_SMS_MANUAL_REFRESH_COOLDOWN_MS;
  state.userDeviceSmsLoading = true;
  state.userDeviceSmsLoadingDeviceId = deviceId;
  renderUserWorkbench();
  try {
    await api(`/api/v1/user/devices/${encodeURIComponent(deviceId)}/sms-library/refresh`, {
      method: "POST",
      body: JSON.stringify({ source: "manual_user_request" })
    });
    userSmsDeviceSyncRequestedByDevice.add(deviceId);
    await loadUserSmsLibrary({ force: true });
    setTimeout(() => {
      if (state.userSelectedDeviceId === deviceId && isUserSmsPanelActive()) {
        loadUserSmsLibrary({ force: true }).catch(() => {});
      }
    }, 3000);
  } catch (error) {
    if (error.code === "sms_refresh_too_frequent") {
      alert(error.message || "短信库刷新太频繁，请稍后再试。");
    } else {
      alert(error.message);
    }
    await loadUserSmsLibrary({ force: true }).catch(() => {});
  } finally {
    if (state.userSmsRefreshDeviceId === deviceId) state.userSmsRefreshDeviceId = "";
    updateUserSmsRefreshButton();
  }
}

async function createWindowsTask(button) {
  const row = button.closest(".adb-row");
  const payload = await api("/api/v1/windows-agent-tasks", {
    method: "POST",
    body: JSON.stringify({
      agentId: row.dataset.agentId,
      adbSerial: row.dataset.adbSerial,
      deviceId: row.dataset.deviceId,
      type: button.dataset.task,
      payload: {}
    })
  });
  button.textContent = "已排队";
  setTimeout(() => {
    button.textContent = windowsTaskButtonLabel(button.dataset.task);
  }, 1600);
  await loadAll();
  return payload;
}

async function fileToDataUrl(file, options = {}) {
  const label = String(options.label || "二维码图片");
  if (!file || file.size <= 0) throw new Error(`请选择${label}`);
  if (!QR_IMAGE_TYPES.has(file.type)) throw new Error(`${label}只支持 PNG、JPEG 或 WebP`);
  if (file.size > MAX_QR_IMAGE_FILE_BYTES) throw new Error(`${label}不能超过 3MB`);
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadRelease(form) {
  const data = new FormData(form);
  const versionName = String(data.get("versionName") || "").trim();
  const versionCode = Number(data.get("versionCode") || 0);
  const releaseNotes = String(data.get("releaseNotes") || "").trim();
  const downloadUrl = String(data.get("downloadUrl") || "").trim();
  const apkFile = data.get("apkFile");
  if (!versionName || !versionCode) throw new Error("版本名和版本号必填");

  await api("/api/v1/app-release/latest", {
    method: "POST",
    body: JSON.stringify({ versionName, versionCode, releaseNotes, downloadUrl })
  });

  if (apkFile && apkFile.size) {
    const response = await fetch(`/api/v1/app-release/latest/apk?versionName=${encodeURIComponent(versionName)}&versionCode=${encodeURIComponent(versionCode)}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${state.token}`,
        "content-type": "application/vnd.android.package-archive"
      },
      body: apkFile
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  }
}

async function saveDeviceBindings(card) {
  const deviceId = card.dataset.deviceId;
  const device = state.devices.find((item) => item.deviceId === deviceId) || {};
  const deviceName = String(card.querySelector('[data-role="device-name"]')?.value || "").trim();
  if (!deviceName) throw new Error("设备名称不能为空");
  const simInputs = [...card.querySelectorAll('[data-role="sim-phone"]')];
  const sims = simInputs
    .map((input) => {
      const index = Number(input.dataset.index || 0);
      const existing = (device.sims || []).find((sim) => Number(sim.slotIndex) === index) || device.sims?.[index] || {};
      return {
        subscriptionId: Number.isFinite(Number(existing.subscriptionId)) ? Number(existing.subscriptionId) : index,
        slotIndex: index,
        carrierName: existing.carrierName || "",
        phoneNumber: input.value.trim(),
        label: existing.label || `SIM ${index + 1}`,
        enabled: existing.enabled !== false
      };
    })
    .filter((sim) => sim.phoneNumber || sim.carrierName || sim.label);
  const accountInputs = [...card.querySelectorAll('[data-role="xhs-account-name"]')];
  const accounts = accountInputs.map((input) => {
    const enabledInput = card.querySelector(`[data-role="xhs-account-enabled"][data-slot="${input.dataset.slot}"]`);
    const idInput = card.querySelector(`[data-role="xhs-account-id"][data-slot="${input.dataset.slot}"]`);
    return {
      appSlot: input.dataset.slot,
      xhsId: String(idInput?.value || "").replace(/\s+/g, "").trim(),
      accountName: input.value.trim(),
      label: input.dataset.slot === "app2" ? "Ⅱ·小红书" : "小红书",
      enabled: Boolean(enabledInput?.checked)
      };
    });
  const payload = await api(`/api/v1/devices/${encodeURIComponent(deviceId)}`, {
    method: "PUT",
    body: JSON.stringify({ deviceName, sims, xhsAccounts: accounts })
  });
  if (payload.device) updateDeviceInState(payload.device);
  state.adminDeviceEditingUntil = 0;
  return payload.device || null;
}

async function setDeviceListing(card, listingStatus) {
  const deviceId = card.dataset.deviceId;
  const payload = await api(`/api/v1/devices/${encodeURIComponent(deviceId)}`, {
    method: "PUT",
    body: JSON.stringify({ listingStatus })
  });
  if (payload.device) updateDeviceInState(payload.device);
  state.adminDeviceEditingUntil = 0;
  return payload.device || null;
}

async function bulkSetDeviceListing(listingStatus) {
  const deviceIds = [...els.deviceList.querySelectorAll('[data-role="device-select"]:checked')]
    .map((input) => input.closest("[data-device-id]")?.dataset.deviceId)
    .filter(Boolean);
  if (!deviceIds.length) throw new Error("请先勾选要操作的手机");
  await api("/api/v1/devices/bulk-listing", {
    method: "POST",
    body: JSON.stringify({ deviceIds, listingStatus })
  });
  state.adminDeviceEditingUntil = 0;
  await loadAll();
}

function updateDeviceInState(updatedDevice) {
  if (!updatedDevice?.deviceId) return;
  const index = state.devices.findIndex((device) => device.deviceId === updatedDevice.deviceId);
  if (index >= 0) state.devices.splice(index, 1, updatedDevice);
  else state.devices.unshift(updatedDevice);
}

function setAdminDeviceFeedback(deviceId, message, kind = "info", ttlMs = 1800) {
  if (!deviceId) return;
  adminDeviceFeedbackById.set(deviceId, { message, kind });
  if (ttlMs > 0) {
    setTimeout(() => {
      const current = adminDeviceFeedbackById.get(deviceId);
      if (current?.message === message) {
        adminDeviceFeedbackById.delete(deviceId);
        if (!isAdminDeviceEditing()) renderDevices();
      }
    }, ttlMs);
  }
}

function setDeviceButtonBusy(button, busyText) {
  if (!button) return;
  button.dataset.originalText = button.dataset.originalText || button.textContent || "";
  button.textContent = busyText;
  button.disabled = true;
  button.classList.add("is-loading");
}

function clearDeviceButtonBusy(button, fallbackText = "") {
  if (!button) return;
  button.disabled = false;
  button.classList.remove("is-loading");
  button.textContent = fallbackText || button.dataset.originalText || button.textContent || "";
}

function setDeviceCardStatus(card, message, kind = "info") {
  const status = card?.querySelector(".device-save-status");
  if (!status) return;
  status.textContent = message || "";
  status.classList.remove("is-success", "is-error", "is-info");
  status.classList.add(`is-${kind}`);
}

function touchAdminDeviceEditing() {
  state.adminDeviceEditingUntil = Date.now() + 30_000;
}

function isAdminDeviceEditing() {
  return Date.now() < Number(state.adminDeviceEditingUntil || 0);
}

async function loginWithCredentials(username, password) {
  const payload = await api("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({
      username: String(username || "").trim(),
      password: String(password || "")
    })
  });
  state.token = payload.session.token;
  state.user = payload.user;
  localStorage.setItem("phoneCloudSessionToken", state.token);
  if (state.user?.role !== "admin") {
    forceUserInventoryHome();
    didApplyUserDefaultLanding = true;
  } else {
    didApplyUserDefaultLanding = true;
    state.page = "dashboard";
    localStorage.setItem("phoneCloudPage", state.page);
  }
  render();
  loadAll().catch((error) => {
    console.warn("loadAll after login failed", error);
    if (els.loginHint) els.loginHint.textContent = error.message;
  });
}

els.loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (els.loginHint) els.loginHint.textContent = "正在登录...";
  try {
    await loginWithCredentials(els.loginUsernameInput?.value, els.loginPasswordInput?.value);
    if (els.loginPasswordInput) els.loginPasswordInput.value = "";
    if (els.loginHint) els.loginHint.textContent = "";
  } catch (error) {
    if (els.loginHint) els.loginHint.textContent = error.message;
  }
});

async function logout() {
  await api("/api/v1/auth/logout", { method: "POST", body: "{}" }).catch(() => {});
  state.token = "";
  state.user = null;
  didApplyUserDefaultLanding = false;
  localStorage.removeItem("phoneCloudSessionToken");
  closeSettingsModal();
  render();
}

els.settingsLogoutButton?.addEventListener("click", () => logout().catch((error) => alert(error.message)));
els.topSettingsButton?.addEventListener("click", () => openSettingsModal());
els.settingsOpenButtons?.forEach((button) => button.addEventListener("click", () => openSettingsModal()));
els.settingsCloseButtons?.forEach((button) => button.addEventListener("click", () => closeSettingsModal()));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeScreenshotModal();
    closeSettingsModal();
  }
});

document.addEventListener("click", (event) => {
  const xhsPageButton = event.target.closest("[data-xhs-task-page]");
  if (xhsPageButton) {
    event.preventDefault();
    const totalPages = Math.max(1, Math.ceil(Number(state.xhsTaskTotal || 0) / normalizedXhsTaskPageSize()));
    state.xhsTaskPage = xhsPageButton.dataset.xhsTaskPage === "next"
      ? Math.min(totalPages, Number(state.xhsTaskPage || 1) + 1)
      : Math.max(1, Number(state.xhsTaskPage || 1) - 1);
    localStorage.setItem("phoneCloudXhsTaskPage", String(state.xhsTaskPage));
    loadAll().catch((error) => alert(error.message));
    return;
  }
  const screenshotButton = event.target.closest("[data-screenshot-key]");
  if (screenshotButton) {
    event.preventDefault();
    openScreenshotModal(screenshotButton.dataset.screenshotKey);
    return;
  }
  const xhsEvidenceButton = event.target.closest("[data-load-xhs-evidence]");
  if (xhsEvidenceButton) {
    event.preventDefault();
    loadAdminXhsTaskEvidence(xhsEvidenceButton.dataset.loadXhsEvidence)
      .catch((error) => alert(error.message || "加载失败现场失败"));
    return;
  }
  const windowsEvidenceButton = event.target.closest("[data-load-windows-evidence]");
  if (windowsEvidenceButton) {
    event.preventDefault();
    loadWindowsTaskEvidence(windowsEvidenceButton.dataset.loadWindowsEvidence)
      .catch((error) => alert(error.message || "加载失败现场失败"));
    return;
  }
  if (event.target.closest("[data-screenshot-close]")) {
    closeScreenshotModal();
    return;
  }
  if (event.target.classList?.contains("screenshot-modal")) {
    closeScreenshotModal();
  }
});

document.addEventListener("change", (event) => {
  const xhsPageSize = event.target.closest("[data-xhs-task-page-size]");
  if (!xhsPageSize) return;
  state.xhsTaskPageSize = Number(xhsPageSize.value || 20);
  state.xhsTaskPage = 1;
  localStorage.setItem("phoneCloudXhsTaskPageSize", String(state.xhsTaskPageSize));
  localStorage.setItem("phoneCloudXhsTaskPage", "1");
  loadAll().catch((error) => alert(error.message));
});

els.refreshButton.addEventListener("click", () => loadAll().catch((error) => alert(error.message)));

els.userTopAdminButton?.addEventListener("click", () => {
  state.page = "dashboard";
  localStorage.setItem("phoneCloudPage", state.page);
  render();
  loadAll().catch((error) => alert(error.message));
});

els.pageButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.page = button.dataset.pageButton;
    localStorage.setItem("phoneCloudPage", state.page);
    render();
    loadAll().catch((error) => alert(error.message));
  });
});

els.userCreateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(els.userCreateForm);
  try {
    await api("/api/v1/users", {
      method: "POST",
      body: JSON.stringify({
        username: form.get("username"),
        displayName: form.get("displayName"),
        password: form.get("password"),
        role: form.get("role")
      })
    });
    els.userCreateHint.textContent = "账号已创建。";
    els.userCreateForm.reset();
    await loadAll();
  } catch (error) {
    els.userCreateHint.textContent = error.message;
  }
});

els.userSmsOrderForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(els.userSmsOrderForm);
  try {
    await api("/api/v1/user/sms-orders", {
      method: "POST",
      body: JSON.stringify({
        phoneNumber: form.get("phoneNumber"),
        platform: form.get("platform")
      })
    });
    els.userSmsHint.textContent = "短信订单已创建。";
    await loadAll();
  } catch (error) {
    els.userSmsHint.textContent = error.message;
  }
});

els.userSmsList?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-user-sms-action]");
  if (!button) return;
  const row = button.closest("[data-user-sms-order-id]");
  try {
    await api(`/api/v1/user/sms-orders/${encodeURIComponent(row.dataset.userSmsOrderId)}/cancel`, {
      method: "POST",
      body: "{}"
    });
    await loadAll();
  } catch (error) {
    alert(error.message);
  }
});

function resetUserQrPreview() {
  if (!els.userQrPreview) return;
  els.userQrPreview.classList.remove("has-image", "has-error");
  els.userQrPreview.innerHTML = `
    <span class="scan-upload-icon">QR</span>
    <span class="scan-upload-copy">
      <strong>点击选择二维码</strong>
      <small>支持 PNG / JPEG / WebP，提交后自动推送到手机相册。</small>
    </span>
  `;
}

async function updateUserQrPreview(file) {
  if (!els.userQrPreview) return;
  if (!file || !file.size) {
    resetUserQrPreview();
    return;
  }
  try {
    const dataUrl = await fileToDataUrl(file);
    els.userQrPreview.classList.remove("has-error");
    els.userQrPreview.classList.add("has-image");
    els.userQrPreview.innerHTML = `<img src="${escapeHtml(dataUrl)}" alt="二维码预览" /><span class="scan-upload-copy"><strong>${escapeHtml(file.name || "二维码图片")}</strong><small>${Math.max(1, Math.round(file.size / 1024))} KB · 已选择，等待提交</small></span>`;
  } catch (error) {
    els.userQrPreview.classList.remove("has-image");
    els.userQrPreview.classList.add("has-error");
    els.userQrPreview.innerHTML = `<span class="scan-upload-icon">!</span><span class="scan-upload-copy"><strong>预览失败</strong><small>${escapeHtml(error.message)}</small></span>`;
  }
}

els.userAutomationTargetCards?.addEventListener("click", (event) => {
  const card = event.target.closest("[data-scan-target-value]");
  if (!card || card.disabled || !els.userAutomationTargetSelect) return;
  els.userAutomationTargetSelect.value = card.dataset.scanTargetValue || "";
  rememberAutomationTarget(state.userSelectedDeviceId, els.userAutomationTargetSelect.value);
  syncScanTargetCards();
});

els.userAutomationTargetSelect?.addEventListener("change", () => {
  rememberAutomationTarget(state.userSelectedDeviceId, els.userAutomationTargetSelect.value);
  syncScanTargetCards();
});

els.userQrImageInput?.addEventListener("change", async () => {
  await updateUserQrPreview(els.userQrImageInput.files?.[0]);
});

els.userXhsTaskForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.userXhsSubmitting) return;
  const form = new FormData(els.userXhsTaskForm);
  const pendingTaskId = `local-xhs-${Date.now()}`;
  let addedPendingTask = false;
  state.userXhsSubmitting = true;
  if (els.userXhsHint) els.userXhsHint.textContent = "正在读取二维码并创建任务...";
  renderUserWorkbench();
  try {
    const qrImageDataUrl = await fileToDataUrl(form.get("qrImage"));
    const target = parseAutomationTarget(form.get("target"));
    if (!state.userSelectedDeviceId) throw new Error("请先选择一台手机");
    const device = state.userDevices.find((item) => item.deviceId === state.userSelectedDeviceId);
    if (!automationReadyForDevice(device)) throw new Error(`当前手机${automationIssueLabel(device)}，请等待 Windows 管理器预检完成后再提交扫码`);
    if (target.platform !== "xhs") throw new Error("当前仅支持小红书扫码任务");
    if (!target.slot) throw new Error("请选择一个账号槽位");
    const targetInfo = automationTargetsForDevice(device).find((item) => item.value === form.get("target")) || {};
    addPendingUserXhsTask({
      taskId: pendingTaskId,
      deviceId: state.userSelectedDeviceId,
      status: "creating",
      createdAt: new Date().toISOString(),
      xhsAppSlot: target.slot,
      xhsAccountLabel: targetInfo.label || (target.slot === "app2" ? "小红书 2" : "小红书 1"),
      xhsAccountId: targetInfo.xhsId || "",
      xhsAccountName: targetInfo.accountName || "",
      executionMode: "windows_airtest_poco",
      cancellable: false,
      summary: {
        progressMessage: "已接收二维码，正在创建扫码任务",
        eventCount: 0,
        screenshotCount: 0
      }
    });
    addedPendingTask = true;
    if (els.userXhsHint) els.userXhsHint.textContent = "任务正在创建，右侧会实时显示进度。";
    renderUserWorkbench();
    const payload = await api("/api/v1/user/xhs/qr-scan-tasks", {
      method: "POST",
      body: JSON.stringify({
        deviceId: state.userSelectedDeviceId,
        xhsAppSlot: target.slot,
        qrImageDataUrl
      })
    });
    removePendingUserXhsTask(pendingTaskId);
    if (payload.task) {
      state.userXhsTasks = [
        payload.task,
        ...state.userXhsTasks.filter((task) => task.taskId !== payload.task.taskId)
      ];
      renderUserWorkbench();
    }
    if (els.userXhsHint) els.userXhsHint.textContent = "扫码任务已创建，正在等待 Windows 管理器领取。";
    if (els.userQrImageInput) els.userQrImageInput.value = "";
    resetUserQrPreview();
    loadAll().catch((error) => console.warn("refresh after xhs task create failed", error));
  } catch (error) {
    if (addedPendingTask) {
      markPendingUserXhsTaskFailed(pendingTaskId, error.message);
    }
    if (els.userXhsHint) els.userXhsHint.textContent = error.message;
    renderUserWorkbench();
  } finally {
    state.userXhsSubmitting = false;
    renderUserWorkbench();
  }
});

els.userAutomationModuleTabs?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-automation-module]");
  if (!button) return;
  state.userAutomationModule = button.dataset.automationModule || "scan";
  localStorage.setItem("phoneCloudUserAutomationModule", state.userAutomationModule);
  renderUserWorkbench();
});

els.userKuaishouStartButton?.addEventListener("click", async () => {
  if (!state.userSelectedDeviceId || state.userKuaishouBusy) return;
  const minDelaySeconds = Number(els.userKuaishouMinDelay?.value || 0);
  const maxDelaySeconds = Number(els.userKuaishouMaxDelay?.value || 0);
  if (!Number.isInteger(minDelaySeconds) || !Number.isInteger(maxDelaySeconds)
    || minDelaySeconds < 30 || maxDelaySeconds > 3600 || maxDelaySeconds < minDelaySeconds) {
    if (els.userKuaishouHint) els.userKuaishouHint.textContent = "间隔必须是 30–3600 秒，且最长时间不能小于最短时间。";
    return;
  }
  state.userKuaishouBusy = true;
  if (els.userKuaishouHint) els.userKuaishouHint.textContent = "正在创建持续扫描任务...";
  renderUserWorkbench();
  try {
    const payload = await api("/api/v1/user/automation/kuaishou-lead-tasks", {
      method: "POST",
      body: JSON.stringify({ deviceId: state.userSelectedDeviceId, minDelaySeconds, maxDelaySeconds })
    });
    if (payload.task) state.userKuaishouTasks = [payload.task, ...state.userKuaishouTasks.filter((task) => task.jobId !== payload.task.jobId)];
    if (els.userKuaishouHint) els.userKuaishouHint.textContent = "任务已启动；飞书没有待处理数据时也会继续扫描。";
  } catch (error) {
    if (els.userKuaishouHint) els.userKuaishouHint.textContent = error.message;
  } finally {
    state.userKuaishouBusy = false;
    renderUserWorkbench();
    refreshUserXhsTasksOnly({ force: true }).catch(() => {});
  }
});

els.userKuaishouStopButton?.addEventListener("click", async () => {
  if (state.userKuaishouBusy || !state.userSelectedDeviceId) return;
  const task = activeKuaishouLeadTask(state.userSelectedDeviceId);
  if (!task) return;
  state.userKuaishouBusy = true;
  if (els.userKuaishouHint) els.userKuaishouHint.textContent = "正在通知 Windows 管理器停止任务...";
  renderUserWorkbench();
  try {
    const payload = await api(`/api/v1/user/automation/kuaishou-lead-tasks/${encodeURIComponent(task.jobId)}/stop`, {
      method: "POST",
      body: "{}"
    });
    if (payload.task) state.userKuaishouTasks = [payload.task, ...state.userKuaishouTasks.filter((item) => item.jobId !== payload.task.jobId)];
    if (els.userKuaishouHint) els.userKuaishouHint.textContent = "任务已停止，不会再扫描飞书。";
  } catch (error) {
    if (els.userKuaishouHint) els.userKuaishouHint.textContent = error.message;
  } finally {
    state.userKuaishouBusy = false;
    renderUserWorkbench();
    refreshUserXhsTasksOnly({ force: true }).catch(() => {});
  }
});

els.userPublishImagesInput?.addEventListener("change", () => {
  const files = [...(els.userPublishImagesInput.files || [])];
  els.userPublishImageUpload?.classList.toggle("has-files", files.length > 0);
  if (els.userPublishImagesMeta) els.userPublishImagesMeta.textContent = files.length
    ? `已选择 ${files.length} 张 · ${files.map((file) => file.name).join("、")}`
    : "支持 1–5 张 PNG / JPEG / WebP";
});

function updatePublishCopyCounters() {
  if (els.userPublishTitleCount) els.userPublishTitleCount.textContent = `${els.userPublishTitleInput?.value.length || 0} / 100`;
  if (els.userPublishContentCount) els.userPublishContentCount.textContent = `${els.userPublishContentInput?.value.length || 0} / 2000`;
}

els.userPublishTitleInput?.addEventListener("input", updatePublishCopyCounters);
els.userPublishContentInput?.addEventListener("input", updatePublishCopyCounters);

els.userPublishForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.userPublishSubmitting) return;
  const deviceId = state.userSelectedDeviceId;
  const target = parseAutomationTarget(els.userPublishTargetSelect?.value || "");
  const files = [...(els.userPublishImagesInput?.files || [])];
  state.userPublishSubmitting = true;
  if (els.userPublishHint) els.userPublishHint.textContent = "正在读取图片并创建发布任务...";
  renderUserWorkbench();
  try {
    if (!deviceId) throw new Error("请先选择一台手机");
    if (target.platform !== "xhs" || !target.slot) throw new Error("请选择小红书 I 或 II");
    if (!files.length || files.length > 5) throw new Error("请选择 1–5 张发布图片");
    const imageDataUrls = await Promise.all(files.map(fileToDataUrl));
    const payload = await api("/api/v1/user/automation/xhs-publish-tasks", {
      method: "POST",
      body: JSON.stringify({
        deviceId,
        xhsAppSlot: target.slot,
        title: els.userPublishTitleInput?.value || "",
        content: els.userPublishContentInput?.value || "",
        imageDataUrls
      })
    });
    if (payload.task) state.userPublishTasks = [payload.task, ...state.userPublishTasks.filter((task) => task.jobId !== payload.task.jobId)];
    rememberAutomationTarget(deviceId, els.userPublishTargetSelect.value);
    els.userPublishForm.reset();
    els.userPublishImageUpload?.classList.remove("has-files");
    updatePublishCopyCounters();
    if (els.userPublishImagesMeta) els.userPublishImagesMeta.textContent = "支持 1–5 张 PNG / JPEG / WebP";
    if (els.userPublishHint) els.userPublishHint.textContent = "发布任务已创建，正在等待 Windows 管理器领取。";
  } catch (error) {
    if (els.userPublishHint) els.userPublishHint.textContent = error.message;
  } finally {
    state.userPublishSubmitting = false;
    renderUserWorkbench();
  }
});

els.userLookupStartButton?.addEventListener("click", async () => {
  if (!state.userSelectedDeviceId || state.userLookupBusy) return;
  bumpUserLookupSyncVersion();
  state.userLookupBusy = true;
  if (els.userLookupHint) els.userLookupHint.textContent = "正在建立支付宝查询会话...";
  renderUserWorkbench();
  try {
    const payload = await api("/api/v1/user/automation/alipay-name-sessions", {
      method: "POST",
      body: JSON.stringify({ deviceId: state.userSelectedDeviceId })
    });
    if (payload.session) upsertUserLookupSession(payload.session);
    bumpUserLookupSyncVersion();
    if (els.userLookupHint) els.userLookupHint.textContent = "启动任务已提交，搜索页就绪后即可连续查询。";
  } catch (error) {
    bumpUserLookupSyncVersion();
    if (els.userLookupHint) els.userLookupHint.textContent = error.message;
  } finally {
    state.userLookupBusy = false;
    renderUserWorkbench();
    refreshUserLookupSessionsOnly({ force: true }).catch(() => {});
  }
});

async function submitLookupQuery() {
  if (state.userLookupBusy || state.userLookupEnding || !state.userSelectedDeviceId) return;
  const session = activeLookupSessionForDevice(state.userSelectedDeviceId);
  if (!session || session.status !== "ready") return;
  if (resumableLookupHumanVerificationResult(session) || resumableLookupRecoveryResult(session)) return;
  const phoneNumber = String(els.userLookupPhoneInput?.value || "").replace(/\D/g, "");
  if (!/^1\d{10}$/.test(phoneNumber)) {
    if (els.userLookupHint) els.userLookupHint.textContent = "请输入正确的 11 位手机号。";
    return;
  }
  state.userLookupBusy = true;
  bumpUserLookupSyncVersion();
  const optimisticResultId = `submitting-${Date.now()}`;
  const optimisticCreatedAt = new Date().toISOString();
  state.userLookupSessions = state.userLookupSessions.map((item) => item.sessionId === session.sessionId ? {
    ...item,
    status: "querying",
    pendingJobId: optimisticResultId,
    updatedAt: optimisticCreatedAt,
    results: [{
      resultId: optimisticResultId,
      phoneNumber,
      status: "submitting",
      stage: "正在提交查询任务",
      createdAt: optimisticCreatedAt,
      updatedAt: optimisticCreatedAt
    }, ...(item.results || [])]
  } : item);
  if (els.userLookupHint) els.userLookupHint.textContent = "正在查询，完成后会自动保留当前搜索页...";
  renderUserWorkbench();
  try {
    const payload = await api(`/api/v1/user/automation/alipay-name-sessions/${encodeURIComponent(session.sessionId)}/queries`, {
      method: "POST",
      body: JSON.stringify({ phoneNumber })
    });
    if (payload.session) upsertUserLookupSession(payload.session, { preserveStopping: true });
    bumpUserLookupSyncVersion();
    if (els.userLookupPhoneInput) els.userLookupPhoneInput.value = "";
    if (els.userLookupHint) els.userLookupHint.textContent = "查询任务已提交。";
  } catch (error) {
    state.userLookupSessions = state.userLookupSessions.map((item) => item.sessionId === session.sessionId ? {
      ...item,
      status: item.status === "stopping" ? "stopping" : "ready",
      pendingJobId: item.pendingJobId === optimisticResultId ? "" : item.pendingJobId,
      results: (item.results || []).filter((result) => result.resultId !== optimisticResultId)
    } : item);
    bumpUserLookupSyncVersion();
    if (els.userLookupHint) els.userLookupHint.textContent = error.message;
  } finally {
    state.userLookupBusy = false;
    renderUserWorkbench();
    refreshUserLookupSessionsOnly({ force: true }).catch(() => {});
  }
}

els.userLookupRecoveryRetryButton?.addEventListener?.("click", async () => {
  const session = activeLookupSessionForDevice(state.userSelectedDeviceId);
  if (!resumableLookupRecoveryResult(session) || state.userLookupBusy || state.userLookupEnding) return;
  bumpUserLookupSyncVersion();
  state.userLookupBusy = true;
  renderUserWorkbench();
  try {
    const payload = await api(`/api/v1/user/automation/alipay-name-sessions/${encodeURIComponent(session.sessionId)}/resume-after-human-verification`, { method: "POST", body: "{}" });
    if (payload.session) state.userLookupSessions = state.userLookupSessions.map((item) => item.sessionId === payload.session.sessionId ? payload.session : item);
  } catch (error) {
    if (els.userLookupHint) els.userLookupHint.textContent = error.message;
  } finally {
    state.userLookupBusy = false;
    renderUserWorkbench();
    refreshUserLookupSessionsOnly({ force: true }).catch(() => {});
  }
});

els.userLookupQueryButton?.addEventListener("click", submitLookupQuery);
els.userLookupPhoneInput?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  submitLookupQuery().catch(() => {});
});

function resumableLookupHumanVerificationResult(session) {
  if (!session || session.pendingJobId || !["ready", "needs_human_verification"].includes(session.status)) return null;
  const result = Array.isArray(session.results)
    ? session.results.find((item) => item?.status !== "queued")
    : null;
  if (session.startupHumanVerification?.status === "needs_human_verification") return session.startupHumanVerification;
  if (!result) return null;
  return result.status === "needs_human_verification"
    || (result.limitReason === "jigsaw_verification" && !["succeeded", "not_found", "cancelled"].includes(result.status))
    ? result
    : null;
}

function resumableLookupRecoveryResult(session) {
  if (!session || session.pendingJobId || session.status !== "ready") return null;
  if (session.startupHumanVerification?.status === "needs_recovery") return session.startupHumanVerification;
  const result = session.results?.find((item) => item?.status !== "queued");
  return result?.status === "needs_recovery" ? result : null;
}

const lookupHumanPromptStates = new Map();

function lookupHumanPromptVisible(session, device) {
  return Boolean(state.token && state.page === "user-workbench" && state.userWorkbenchView === "detail"
    && session?.deviceId === state.userSelectedDeviceId && device?.deviceId === session?.deviceId);
}

function notifyLookupHumanVerification(session, device) {
  if (!session?.sessionId) return;
  const result = resumableLookupHumanVerificationResult(session);
  if (!result) {
    lookupHumanPromptStates.delete(session.sessionId);
    return;
  }
  if (!lookupHumanPromptVisible(session, device)) return;
  const key = String(result.resultId || "human_verification");
  if (lookupHumanPromptStates.get(session.sessionId)?.key === key) return;
  const prompt = { key };
  lookupHumanPromptStates.set(session.sessionId, prompt);
  if (lookupHumanPromptStates.size > 50) lookupHumanPromptStates.delete(lookupHumanPromptStates.keys().next().value);
  const token = state.token;
  // Defer until the current render completes; a late refresh must not show a stale prompt.
  setTimeout(() => {
    if (lookupHumanPromptStates.get(session.sessionId) !== prompt) return;
    const current = activeLookupSessionForDevice(session.deviceId);
    const currentResult = resumableLookupHumanVerificationResult(current);
    if (state.token !== token || current?.sessionId !== session.sessionId
      || !lookupHumanPromptVisible(current, device) || !currentResult
      || String(currentResult.resultId || "human_verification") !== key) {
      lookupHumanPromptStates.delete(session.sessionId);
      return;
    }
    if (currentResult.phase === "start") {
      alert(`手机 ${device.deviceName || "当前设备"} 检测到拼图，需要人工介入。\n账户准备和后续队列已暂停，不会自动求解或代滑。\n请进入实时控屏完成拼图，系统检测通过后继续准备账户，无需点击确认。`);
      return;
    }
    alert(`手机 ${device.deviceName || "当前设备"} 检测到拼图，需要人工介入。\n当前号码和后续队列已暂停，不会自动求解或代滑。\n请任务发起者或管理员进入实时控屏完成人工验证。无需点击确认；系统检测通过后会自动结束这次控屏，清空搜索框并重查原号码，然后继续队列。`);
  }, 0);
}

async function submitLookupAccountAction(targetAccount = "") {
  if (state.userLookupBusy || state.userLookupEnding || !state.userSelectedDeviceId) return;
  const session = activeLookupSessionForDevice(state.userSelectedDeviceId);
  if (!session || !["ready", "choosing_account"].includes(session.status)) return;
  if (resumableLookupHumanVerificationResult(session) || resumableLookupRecoveryResult(session)) return;
  const previousStatus = session.status;
  bumpUserLookupSyncVersion();
  state.userLookupBusy = true;
  state.userLookupSessions = state.userLookupSessions.map((item) => item.sessionId === session.sessionId ? {
    ...item,
    status: "switching",
    updatedAt: new Date().toISOString()
  } : item);
  if (els.userLookupHint) {
    els.userLookupHint.textContent = targetAccount
      ? `正在切换到 ${targetAccount}，请保持手机连接...`
      : "正在读取支付宝已保存账号，请保持手机连接...";
  }
  renderUserWorkbench();
  try {
    const payload = await api(`/api/v1/user/automation/alipay-name-sessions/${encodeURIComponent(session.sessionId)}/switch-account`, {
      method: "POST",
      body: JSON.stringify(targetAccount ? { targetAccount } : {})
    });
    if (payload.session) upsertUserLookupSession(payload.session, { preserveStopping: true });
    bumpUserLookupSyncVersion();
    if (els.userLookupHint) {
      els.userLookupHint.textContent = targetAccount
        ? `已提交切换到 ${targetAccount}，复核成功后可继续查询。`
        : "账号读取任务已提交，完成后请从列表中选择。";
    }
  } catch (error) {
    state.userLookupSessions = state.userLookupSessions.map((item) => item.sessionId === session.sessionId ? {
      ...item,
      status: item.status === "stopping" ? "stopping" : previousStatus
    } : item);
    bumpUserLookupSyncVersion();
    if (els.userLookupHint) els.userLookupHint.textContent = error.message;
  } finally {
    state.userLookupBusy = false;
    renderUserWorkbench();
    refreshUserLookupSessionsOnly({ force: true }).catch(() => {});
  }
}

els.userLookupSwitchButton?.addEventListener("click", () => {
  submitLookupAccountAction().catch(() => {});
});

els.userLookupAccountList?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-lookup-account-choice]");
  if (!button || button.disabled) return;
  const targetAccount = String(button.dataset.lookupAccountChoice || "").trim();
  if (!targetAccount) return;
  submitLookupAccountAction(targetAccount).catch(() => {});
});

els.userLookupResultList?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-lookup-copy-result-id]");
  if (!button) return;
  const resultId = String(button.dataset.lookupCopyResultId || "");
  const session = activeLookupSessionForDevice(state.userSelectedDeviceId);
  const result = (session?.results || []).find((item) => item.resultId === resultId);
  const tail = String(result?.realNameTailCharacter || "").trim();
  try {
    await copyLookupTailToClipboard(tail);
    copiedLookupResultId = resultId;
    clearTimeout(copiedLookupResetTimer);
    renderUserWorkbench();
    copiedLookupResetTimer = setTimeout(() => {
      if (copiedLookupResultId !== resultId) return;
      copiedLookupResultId = "";
      renderUserWorkbench();
    }, 1_800);
  } catch (error) {
    if (els.userLookupHint) els.userLookupHint.textContent = error.message;
  }
});

els.userLookupEndButton?.addEventListener("click", async () => {
  const session = activeLookupSessionForDevice(state.userSelectedDeviceId);
  if (!session || state.userLookupEnding || session.status === "stopping") return;
  bumpUserLookupSyncVersion();
  state.userLookupEnding = true;
  state.userLookupSessions = state.userLookupSessions.map((item) => item.sessionId === session.sessionId ? {
    ...item,
    status: "stopping",
    updatedAt: new Date().toISOString(),
    results: (item.results || []).map((result) => ["submitting", "queued", "running"].includes(result.status)
      ? { ...result, status: "cancelling", stage: "正在停止当前查询", updatedAt: new Date().toISOString() }
      : result)
  } : item);
  if (els.userLookupHint) els.userLookupHint.textContent = "正在结束会话并释放手机...";
  renderUserWorkbench();
  try {
    const payload = await api(`/api/v1/user/automation/alipay-name-sessions/${encodeURIComponent(session.sessionId)}/end`, { method: "POST", body: "{}" });
    if (payload.session) upsertUserLookupSession(payload.session);
    bumpUserLookupSyncVersion();
  } catch (error) {
    bumpUserLookupSyncVersion();
    if (els.userLookupHint) els.userLookupHint.textContent = error.message;
    refreshUserXhsTasksOnly().catch(() => {});
  } finally {
    state.userLookupEnding = false;
    renderUserWorkbench();
    refreshUserLookupSessionsOnly({ force: true }).catch(() => {});
  }
});

els.userDeviceList?.addEventListener("click", async (event) => {
  const opener = event.target.closest("[data-user-device-open]");
  if (opener) {
    event.preventDefault();
    event.stopPropagation();
    await openUserDeviceDetail(opener.dataset.userDeviceOpen);
    return;
  }
  const row = event.target.closest("[data-user-device-id]");
  if (!row) return;
  await openUserDeviceDetail(row.dataset.userDeviceId);
});

els.userDeviceList?.addEventListener("keydown", async (event) => {
  if (!["Enter", " "].includes(event.key)) return;
  const opener = event.target.closest("[data-user-device-open]");
  const row = opener || event.target.closest("[data-user-device-id]");
  if (!row) return;
  event.preventDefault();
  await openUserDeviceDetail(row.dataset.userDeviceOpen || row.dataset.userDeviceId);
});

async function openUserDeviceDetail(deviceId) {
  if (!deviceId) return;
  state.userDeviceSwitcherOpen = false;
  state.userDeviceSwitcherSearch = "";
  if (state.userScreenDeviceId && state.userScreenDeviceId !== deviceId) await stopUserScreenSession();
  if (state.userSelectedDeviceId !== deviceId) {
    state.userSmsPage = 1;
    state.userSmsSearch = "";
    state.userSmsSimFilter = "";
    state.userSmsCodeOnly = false;
    latestUserSmsRequestId++;
    state.userDeviceSmsMessages = [];
    state.userDeviceSmsTotal = 0;
    state.userDeviceSmsLoading = true;
    state.userDeviceSmsLoadingDeviceId = deviceId;
    state.userDeviceSmsLoadedAt = 0;
    state.userDeviceSmsLoadedDeviceId = "";
    state.userDeviceSmsLoadedQueryKey = "";
    state.userSmsLoadError = "";
  }
  state.userSelectedDeviceId = deviceId;
  state.userWorkbenchView = "detail";
  localStorage.setItem("phoneCloudUserSelectedDeviceId", state.userSelectedDeviceId);
  localStorage.setItem("phoneCloudUserWorkbenchView", state.userWorkbenchView);
  renderUserWorkbench();
  await loadAll();
  autoRefreshCurrentUserSmsLibrary().catch(() => {});
}

window.__openUserDeviceDetail = (deviceId) => {
  openUserDeviceDetail(deviceId).catch((error) => alert(error.message));
};

els.userDeviceSwitcherButton?.addEventListener("click", () => {
  if (state.userDeviceSwitcherOpen) closeUserDeviceSwitcher();
  else openUserDeviceSwitcher();
});

els.userDeviceSwitcherSearch?.addEventListener("input", () => {
  state.userDeviceSwitcherSearch = els.userDeviceSwitcherSearch.value || "";
  renderUserDeviceSwitcher(
    state.userDevices.find((device) => device.deviceId === state.userSelectedDeviceId) || null,
    state.userWorkbenchView === "detail"
  );
});

els.userDeviceSwitcherList?.addEventListener("click", async (event) => {
  const option = event.target.closest("[data-user-device-switch-id]");
  if (!option) return;
  const deviceId = option.dataset.userDeviceSwitchId || "";
  if (!deviceId) return;
  if (deviceId === state.userSelectedDeviceId) {
    closeUserDeviceSwitcher();
    els.userDeviceSwitcherButton?.focus();
    return;
  }
  closeUserDeviceSwitcher();
  await openUserDeviceDetail(deviceId);
});

document.addEventListener("pointerdown", (event) => {
  if (!state.userDeviceSwitcherOpen || els.userDeviceSwitcher?.contains(event.target)) return;
  closeUserDeviceSwitcher();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !state.userDeviceSwitcherOpen) return;
  event.preventDefault();
  closeUserDeviceSwitcher();
  els.userDeviceSwitcherButton?.focus();
});

els.userDeviceBackButton?.addEventListener("click", async () => {
  await stopUserScreenSession();
  state.userDeviceSwitcherOpen = false;
  state.userDeviceSwitcherSearch = "";
  state.userWorkbenchView = "inventory";
  localStorage.setItem("phoneCloudUserWorkbenchView", state.userWorkbenchView);
  renderUserWorkbench();
});

els.userDetailTabs?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-user-detail-tab]");
  if (!button) return;
  state.userDetailTab = button.dataset.userDetailTab || "sms";
  localStorage.setItem("phoneCloudUserDetailTab", state.userDetailTab);
  renderUserWorkbench();
  if (state.userDetailTab === "sms") {
    reloadUserSmsFirstPage()
      .then(() => autoRefreshCurrentUserSmsLibrary())
      .catch(() => {});
  } else if (state.userDetailTab === "scan") {
    refreshUserXhsTasksOnly({ force: true }).catch(() => {});
  }
});

els.userDeviceSearchInput?.addEventListener("input", () => {
  state.userDeviceSearch = els.userDeviceSearchInput.value || "";
  renderUserWorkbench();
});

els.userInventoryRefreshButton?.addEventListener("click", () => loadAll().catch((error) => alert(error.message)));
els.userDeviceSmsRefreshButton?.addEventListener("click", () => refreshCurrentUserSmsLibrary().catch((error) => alert(error.message)));
els.userScreenStartButton?.addEventListener("click", () => startUserScreenSession().catch((error) => alert(error.message)));
els.userScreenReconnectButton?.addEventListener("click", () => startUserScreenSession().catch((error) => alert(error.message)));
els.userScreenWakeButton?.addEventListener("click", () => wakeUserScreen().catch((error) => alert(error.message)));
els.userScreenStopButton?.addEventListener("click", () => stopUserScreenSession().catch((error) => alert(error.message)));
els.userScreenIdleContinueButton?.addEventListener("click", () => {
  if (!userScreenInactivityGuard.continueSession()) return;
  els.userScreenVideo?.focus({ preventScroll: true });
});
els.userScreenIdleDisconnectButton?.addEventListener("click", () => {
  stopUserScreenSession({ detail: "已断开实时控制" }).catch((error) => alert(error.message));
});
els.userScreenIdleModal?.addEventListener("keydown", (event) => {
  if (event.key !== "Tab" || els.userScreenIdleModal.hidden) return;
  const buttons = [els.userScreenIdleContinueButton, els.userScreenIdleDisconnectButton].filter(Boolean);
  if (!buttons.length) return;
  const currentIndex = buttons.indexOf(document.activeElement);
  const nextIndex = event.shiftKey
    ? (currentIndex <= 0 ? buttons.length - 1 : currentIndex - 1)
    : (currentIndex >= buttons.length - 1 ? 0 : currentIndex + 1);
  event.preventDefault();
  buttons[nextIndex].focus();
});
for (const activityEvent of ["pointerdown", "keydown", "wheel", "touchstart"]) {
  els.userScreenControlWorkspace?.addEventListener(activityEvent, (event) => {
    if (!event.isTrusted || !state.userScreenSession?.sessionId) return;
    userScreenInactivityGuard.activity();
  }, { capture: true, passive: activityEvent === "wheel" || activityEvent === "touchstart" });
}
els.userScreenGalleryFileInput?.addEventListener("change", () => {
  const [file] = els.userScreenGalleryFileInput.files || [];
  if (!file) return;
  stageUserScreenGalleryImage(file)
    .then(() => { els.userScreenGalleryFileInput.value = ""; })
    .catch((error) => alert(error.message));
});
els.userScreenGalleryPasteButton?.addEventListener("click", () => {
  els.userScreenGalleryPasteZone?.focus();
});
els.userScreenGalleryClearButton?.addEventListener("click", () => {
  clearUserScreenGalleryDraft();
  renderUserScreenControl(state.userDevices.find((item) => item.deviceId === state.userSelectedDeviceId));
});
els.userScreenGalleryConfirmButton?.addEventListener("click", () => {
  importUserScreenGalleryImage(state.userScreenGalleryDraftFile).catch((error) => alert(error.message));
});
document.addEventListener("paste", (event) => {
  handleUserScreenGalleryPaste(event).catch((error) => alert(error.message));
});
els.userScreenNavigationButtons?.forEach((button) => {
  button.addEventListener("click", () => state.userScreenController?.key(button.dataset.screenKey));
});
window.addEventListener("pagehide", releaseUserScreenSessionOnPageExit);
window.addEventListener("focus", () => userScreenInactivityGuard.reconcile());
document.addEventListener("visibilitychange", () => userScreenInactivityGuard.reconcile());

els.userSmsSearchInput?.addEventListener("input", () => {
  state.userSmsSearch = els.userSmsSearchInput.value || "";
  clearTimeout(userSmsSearchTimer);
  userSmsSearchTimer = setTimeout(() => {
    reloadUserSmsFirstPage().catch((error) => alert(error.message));
  }, 250);
});

els.userSmsSimFilter?.addEventListener("change", () => {
  state.userSmsSimFilter = els.userSmsSimFilter.value || "";
  reloadUserSmsFirstPage().catch((error) => alert(error.message));
});

els.userSmsCodeOnlyToggle?.addEventListener("change", () => {
  state.userSmsCodeOnly = Boolean(els.userSmsCodeOnlyToggle.checked);
  reloadUserSmsFirstPage().catch((error) => alert(error.message));
});

els.userSmsPagination?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-user-sms-page]");
  if (!button || button.disabled) return;
  const totalPages = userSmsTotalPages();
  if (button.dataset.userSmsPage === "prev") state.userSmsPage = Math.max(1, state.userSmsPage - 1);
  if (button.dataset.userSmsPage === "next") state.userSmsPage = Math.min(totalPages, state.userSmsPage + 1);
  loadAll().catch((error) => alert(error.message));
});

els.userSmsPagination?.addEventListener("change", (event) => {
  const select = event.target.closest("[data-user-sms-page-size]");
  if (!select) return;
  state.userSmsPageSize = Number(select.value || 20);
  localStorage.setItem("phoneCloudUserSmsPageSize", String(normalizedUserSmsPageSize()));
  reloadUserSmsFirstPage().catch((error) => alert(error.message));
});

els.userDeviceSmsList?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-copy-text]");
  if (!button) return;
  copyText(button.dataset.copyText || "");
});

els.userDeviceStatusSelect?.addEventListener("change", () => {
  state.userDeviceFilter = els.userDeviceStatusSelect.value || "all";
  localStorage.setItem("phoneCloudUserDeviceFilter", state.userDeviceFilter);
  renderUserWorkbench();
});

els.userDeviceBrandSelect?.addEventListener("change", () => {
  state.userDeviceBrandFilter = els.userDeviceBrandSelect.value || "";
  localStorage.setItem("phoneCloudUserDeviceBrandFilter", state.userDeviceBrandFilter);
  renderUserWorkbench();
});

els.userDeviceAndroidSelect?.addEventListener("change", () => {
  state.userDeviceAndroidFilter = els.userDeviceAndroidSelect.value || "";
  localStorage.setItem("phoneCloudUserDeviceAndroidFilter", state.userDeviceAndroidFilter);
  renderUserWorkbench();
});

els.userDeviceClearFiltersButton?.addEventListener("click", () => {
  state.userDeviceFilter = "all";
  state.userDeviceBrandFilter = "";
  state.userDeviceAndroidFilter = "";
  state.userDeviceSearch = "";
  localStorage.setItem("phoneCloudUserDeviceFilter", state.userDeviceFilter);
  localStorage.removeItem("phoneCloudUserDeviceBrandFilter");
  localStorage.removeItem("phoneCloudUserDeviceAndroidFilter");
  renderUserWorkbench();
});

els.userDeviceFilterChips?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-user-device-filter]");
  if (!button) return;
  state.userDeviceFilter = button.dataset.userDeviceFilter || "all";
  localStorage.setItem("phoneCloudUserDeviceFilter", state.userDeviceFilter);
  renderUserWorkbench();
});

els.userXhsList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-user-xhs-action]");
  if (!button) return;
  const row = button.closest("[data-user-xhs-task-id]");
  try {
    await api(`/api/v1/user/xhs/qr-scan-tasks/${encodeURIComponent(row.dataset.userXhsTaskId)}/cancel`, {
      method: "POST",
      body: "{}"
    });
    await loadAll();
  } catch (error) {
    alert(error.message);
  }
});

els.passwordForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(els.passwordForm);
  try {
    await api("/api/v1/auth/password", {
      method: "POST",
      body: JSON.stringify({
        currentPassword: form.get("currentPassword"),
        newPassword: form.get("newPassword")
      })
    });
    els.passwordHint.textContent = "密码已更新。";
    els.passwordForm.reset();
  } catch (error) {
    els.passwordHint.textContent = error.message;
  }
});

els.userList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-user-action]");
  if (!button) return;
  const row = button.closest("[data-user-id]");
  const userId = row.dataset.userId;
  try {
    if (button.dataset.userAction === "reset-password") {
      const password = prompt("输入新密码，普通用户至少 7 位");
      if (!password) return;
      await api(`/api/v1/users/${encodeURIComponent(userId)}`, {
        method: "PUT",
        body: JSON.stringify({ password })
      });
    } else {
      await api(`/api/v1/users/${encodeURIComponent(userId)}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: button.dataset.userAction === "enable" })
      });
    }
    await loadAll();
  } catch (error) {
    alert(error.message);
  }
});

els.agentCreateButton?.addEventListener("click", async () => {
  const agentId = prompt("输入 Windows 管理器 ID，例如 win-office-001");
  if (!agentId) return;
  const agentName = prompt("输入显示名称", agentId) || agentId;
  try {
    const payload = await api("/api/v1/windows-agents", {
      method: "POST",
      body: JSON.stringify({ agentId, agentName })
    });
    showAgentToken(payload.agent, payload.token);
    await loadAll();
  } catch (error) {
    alert(error.message);
  }
});

els.windowsList.addEventListener("click", async (event) => {
  const agentButton = event.target.closest("[data-agent-action]");
  if (agentButton) {
    const card = agentButton.closest("[data-agent-id]");
    const agentId = card?.dataset.agentId || "";
    if (!agentId) return;
    try {
      if (agentButton.dataset.agentAction === "rotate-token") {
        if (!confirm("重置后旧 token 会立即失效，确定继续？")) return;
        const payload = await api(`/api/v1/windows-agents/${encodeURIComponent(agentId)}/token/rotate`, { method: "POST", body: "{}" });
        showAgentToken(payload.agent, payload.token);
      } else {
        await api(`/api/v1/windows-agents/${encodeURIComponent(agentId)}/${agentButton.dataset.agentAction}`, { method: "POST", body: "{}" });
      }
      await loadAll();
    } catch (error) {
      alert(error.message);
    }
    return;
  }
  const button = event.target.closest("[data-task]");
  if (!button) return;
  createWindowsTask(button).catch((error) => alert(error.message));
});

els.windowsRecoveryConsole?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-recovery-filter]");
  if (!button) return;
  state.windowsRecoveryFilter = button.dataset.recoveryFilter || "all";
  localStorage.setItem("phoneCloudWindowsRecoveryFilter", state.windowsRecoveryFilter);
  renderWindowsRecoveryConsole();
});

function showAgentToken(agent, token) {
  if (!els.agentTokenNotice) return;
  els.agentTokenNotice.classList.remove("hidden");
  els.agentTokenNotice.innerHTML = `
    <strong>${escapeHtml(agent?.agentName || agent?.agentId || "Windows 管理器")} 的新 token 只显示一次</strong>
    <code>${escapeHtml(token || "")}</code>
    <span>请写入该管理器的 <b>agentToken</b> 配置，并确认 <b>agentId</b> 为 ${escapeHtml(agent?.agentId || "")}。</span>
  `;
}

els.deviceList.addEventListener("click", (event) => {
  const editorButton = event.target.closest('[data-action="toggle-device-editor"]');
  if (editorButton) {
    const card = editorButton.closest("[data-device-id]");
    const deviceId = card?.dataset.deviceId || "";
    if (!deviceId) return;
    if (adminDeviceExpandedIds.has(deviceId)) adminDeviceExpandedIds.delete(deviceId);
    else adminDeviceExpandedIds.add(deviceId);
    state.adminDeviceEditingUntil = 0;
    renderDevices();
    return;
  }

  const listingButton = event.target.closest('[data-action="set-device-listing"]');
  if (listingButton) {
    const card = listingButton.closest("[data-device-id]");
    const nextStatus = listingButton.dataset.listingStatus || "pending";
    const deviceId = card?.dataset.deviceId || "";
    if (deviceId) adminDeviceListingIds.add(deviceId);
    setDeviceButtonBusy(listingButton, nextStatus === "listed" ? "上架中..." : "下架中...");
    setDeviceCardStatus(card, nextStatus === "listed" ? "正在上架到用户端..." : "正在从用户端下架...", "info");
    setDeviceListing(card, nextStatus)
      .then(() => {
        if (deviceId) adminDeviceListingIds.delete(deviceId);
        setAdminDeviceFeedback(deviceId, nextStatus === "listed" ? "已上架，用户端可见" : "已下架，用户端隐藏", "success");
        renderDevices();
      })
      .catch((error) => {
        if (deviceId) adminDeviceListingIds.delete(deviceId);
        clearDeviceButtonBusy(listingButton, nextStatus === "listed" ? "上架" : "下架");
        setDeviceCardStatus(card, `操作失败：${error.message}`, "error");
        alert(error.message);
      });
    return;
  }

  const button = event.target.closest('[data-action="save-device-bindings"]');
  if (!button) return;
  const card = button.closest("[data-device-id]");
  const deviceId = card?.dataset.deviceId || "";
  if (deviceId) adminDeviceSavingIds.add(deviceId);
  setDeviceButtonBusy(button, "保存中...");
  setDeviceCardStatus(card, "正在保存设备名称、SIM 和账号槽位...", "info");
  saveDeviceBindings(card)
    .then(() => {
      if (deviceId) adminDeviceSavingIds.delete(deviceId);
      setAdminDeviceFeedback(deviceId, "已保存，设备资料已更新", "success");
      renderDevices();
      loadAll().catch(() => {});
    })
    .catch((error) => {
      if (deviceId) adminDeviceSavingIds.delete(deviceId);
      clearDeviceButtonBusy(button, "保存绑定");
      setDeviceCardStatus(card, `保存失败：${error.message}`, "error");
      alert(error.message);
    });
});

els.deviceBulkListingButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const listingStatus = button.dataset.deviceBulkListing;
    const original = button.textContent;
    try {
      els.deviceBulkListingButtons.forEach((item) => {
        item.disabled = true;
        item.classList.add("is-loading");
      });
      button.textContent = listingStatus === "listed" ? "批量上架中..." : "批量下架中...";
      await bulkSetDeviceListing(listingStatus);
    } catch (error) {
      alert(error.message);
    } finally {
      els.deviceBulkListingButtons.forEach((item) => {
        item.disabled = false;
        item.classList.remove("is-loading");
      });
      button.textContent = original;
    }
  });
});

els.deviceList.addEventListener("input", (event) => {
  if (event.target.closest("[data-device-id]")) touchAdminDeviceEditing();
});

els.deviceList.addEventListener("focusin", (event) => {
  if (event.target.closest("[data-device-id]")) touchAdminDeviceEditing();
});

els.deviceListingToolbar?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-device-listing-filter]");
  if (!button) return;
  state.adminDeviceListingFilter = button.dataset.deviceListingFilter || "all";
  localStorage.setItem("phoneCloudAdminDeviceListingFilter", state.adminDeviceListingFilter);
  renderDevices();
});

els.xhsDeviceSelect.addEventListener("change", () => {
  renderXhsSlotOptions();
});

els.smsOrderForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(els.smsOrderForm);
  const payload = {
    phoneNumber: form.get("phoneNumber"),
    platform: form.get("platform")
  };
  await api("/api/v1/sms-orders", { method: "POST", body: JSON.stringify(payload) });
  els.smsHint.textContent = "短信订单已创建。";
  els.smsOrderForm.reset();
  els.smsOrderForm.platform.value = "小红书";
  await loadAll();
});

els.smsLibraryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  localStorage.setItem("phoneCloudSmsLibraryDeviceId", els.smsLibraryDeviceSelect.value || "");
  await loadAll();
});

els.smsLibraryDeviceSelect.addEventListener("change", async () => {
  localStorage.setItem("phoneCloudSmsLibraryDeviceId", els.smsLibraryDeviceSelect.value || "");
  await loadAll();
});

els.smsLibraryBoxSelect.addEventListener("change", async () => {
  await loadAll();
});

els.releaseForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = els.releaseForm.querySelector("button");
  button.disabled = true;
  button.textContent = "保存中";
  try {
    await uploadRelease(els.releaseForm);
    els.releaseHint.textContent = "APK 发布信息已保存。";
    els.releaseForm.reset();
    await loadAll();
  } catch (error) {
    els.releaseHint.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "保存发布";
  }
});

els.xhsTaskForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(els.xhsTaskForm);
  try {
    const qrImageDataUrl = await fileToDataUrl(form.get("qrImage"));
    await api("/api/v1/xhs/qr-scan-tasks", {
      method: "POST",
      body: JSON.stringify({
        deviceId: form.get("deviceId"),
        xhsAppSlot: form.get("xhsAppSlot"),
        qrImageDataUrl
      })
    });
    els.xhsHint.textContent = "扫码任务已创建。";
    els.xhsTaskForm.reset();
    await loadAll();
  } catch (error) {
    els.xhsHint.textContent = error.message;
  }
});

els.workflowScriptForm?.addEventListener("input", () => touchWorkflowScriptEditing());
els.workflowScriptForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = els.workflowScriptForm.querySelector('button[type="submit"]');
  const original = button?.textContent || "保存脚本配置";
  try {
    if (button) {
      button.disabled = true;
      button.textContent = "保存中";
    }
    const payload = {
      enabled: Boolean(els.workflowScriptEnabled?.checked),
      confirmWaitMs: workflowNumber(els.workflowConfirmWaitMs, 6000),
      loginConfirmKeywords: workflowListFromTextarea(els.workflowLoginKeywords?.value),
      ordinaryConfirmButtons: workflowListFromTextarea(els.workflowOrdinaryButtons?.value),
      platformConfirmButtons: workflowListFromTextarea(els.workflowPlatformButtons?.value),
      steps: workflowStepsFromTextarea(els.workflowScriptSteps?.value),
      timeouts: {
        totalMs: workflowNumber(els.workflowTimeoutTotalMs, 180000),
        restartMs: workflowNumber(els.workflowTimeoutRestartMs, 25000),
        profileMs: workflowNumber(els.workflowTimeoutProfileMs, 10000),
        scannerMs: workflowNumber(els.workflowTimeoutScannerMs, 10000),
        albumMs: workflowNumber(els.workflowTimeoutAlbumMs, 10000),
        selectImageMs: workflowNumber(els.workflowTimeoutSelectImageMs, 14000),
        loginConfirmMs: workflowNumber(els.workflowTimeoutLoginConfirmMs, 45000)
      }
    };
    const result = await api("/api/v1/workflow-scripts/xhs_qr_default", { method: "PUT", body: JSON.stringify(payload) });
    state.workflowScripts = [result.script, ...state.workflowScripts.filter((script) => script.scriptId !== "xhs_qr_default")];
    state.adminWorkflowScriptEditingUntil = 0;
    if (els.workflowScriptHint) els.workflowScriptHint.textContent = "脚本配置已保存，新创建的扫码任务会使用这份配置。";
    renderWorkflowScripts();
  } catch (error) {
    if (els.workflowScriptHint) els.workflowScriptHint.textContent = error.message;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
});

loadAll().catch((error) => {
  render();
  alert(error.message);
});

setInterval(() => loadAll().catch(() => {}), AUTO_REFRESH_MS);
setInterval(updateRecoveryCountdowns, 1_000);
setInterval(() => {
  if (state.user?.role === "admin" && state.page === "diagnostics") {
    loadAll().catch(() => {});
  }
}, REALTIME_DIAGNOSTICS_REFRESH_MS);
userSmsAutoRefreshTimer = setInterval(() => {
  autoRefreshCurrentUserSmsLibrary().catch(() => {});
}, USER_SMS_AUTO_REFRESH_MS);
userXhsTaskRefreshTimer = setInterval(() => {
  refreshUserXhsTasksOnly().catch(() => {});
}, USER_XHS_TASK_REFRESH_MS);
userLookupRefreshTimer = setInterval(() => {
  refreshUserLookupSessionsOnly().catch(() => {});
}, USER_LOOKUP_REFRESH_MS);
setInterval(() => {
  reloadActiveLookupAfterClientUpdate().catch(() => {});
}, CLIENT_UPDATE_CHECK_MS);
