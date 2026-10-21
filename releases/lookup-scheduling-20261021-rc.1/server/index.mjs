import { verifyLookupApiKey } from "./lookup-api-key.mjs";
import { createRecoveryControls, recoverySerial, normalizeRecoveryControlAck, RECOVERY_CONTROL_PROTOCOL } from './recovery-controls.mjs';
import { createManagedLookupStore, MANAGED_LOOKUP_PROTOCOL } from './managed-lookup-store.mjs';
import { createManagedLookupService } from './managed-lookup.mjs';
import { createManagedLookupAdapter } from './managed-lookup-platform.mjs';
import { canDeliverManagedLookupTask, isManagedLookupTask, supportsLeasedWindowsTaskDelivery, hasActiveScreenGalleryDelivery, issueScreenGalleryDelivery, readScreenGalleryDeliveryPayload, acknowledgeScreenGalleryDelivery } from './managed-lookup-delivery.mjs';
import { createLookupHumanNotifier, pendingLookupHumanNotifications, readLookupHumanWebhook } from "./lookup-human-notifications.mjs";
import { createTaskStatusPersistence } from "./task-status-persistence.mjs";
import { createLookupHumanHandover, lookupHumanChallenge } from "./lookup-human-handover.mjs";
import { lookupAccountPolicy, publicLookupAccountCooldowns, recordLookupAccountCooldown,
  verifiedSavedAccounts, allSavedAccountsCooling, isVerifiedLookupAccountRestrictionEvent, isPreparedLookupLimitConfirmed } from "./lookup-account-cooldown.mjs";
import { compactTaskPayload, maintainTaskHistory, normalizeLoadedTaskHistory } from "./task-history-maintenance.mjs";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStateRepositories } from "./state-repositories.mjs";
import { selectSmsOrderMatch } from "./sms-order-matcher.mjs";
import { DEFAULT_SMS_ORDER_PROBE_INTERVAL_MS, smsOrderProbeDecision } from "./sms-order-probe.mjs";
import { applyStructuredOverlay, createPostgresRepositories } from "./postgres-repositories.mjs";
import { createPersistencePolicy } from "./persistence-policy.mjs";
import { createScreenRelay } from "./screen-relay.mjs";
import { ScreenSessionRegistry } from "./screen-sessions.mjs";
import { SCREEN_QUALITY_PROFILES } from "./screen-quality.mjs";
import { createScreenMediaAuthorizer, mediaPathForSession } from "./screen-media-auth.mjs";
import {
  SCREEN_GALLERY_DELIVERY_PROTOCOL,
  XHS_PUBLISH_DELIVERY_PROTOCOL,
  canQueueScreenGalleryImport,
  maintainScreenGalleryDeliveries,
  publicScreenGalleryImportTask
} from "./screen-gallery-import.mjs";
import { sanitizePostgresText, stringifyPostgresJson } from "./postgres-json.mjs";
import { createSaveQueue } from "./save-queue.mjs";
import { createRuntimeSaveScheduler } from "./runtime-save-scheduler.mjs";
import { createRealtimeMetrics } from "./realtime-metrics.mjs";
import { createEvidenceSignedUrl, verifyEvidenceSignedUrl } from "./evidence-signing.mjs";
import { cleanupEvidenceStorage } from "./evidence-storage.mjs";
import { hasXhsDataCollectionCapability, sanitizeXhsDataCollection, XHS_DATA_COLLECTION_PROTOCOL, XHS_DATA_COLLECTION_TTL_MS } from "./xhs-data-collection.mjs";
import { buildDeviceOccupancy } from "./device-occupancy.mjs";
import {
  canShareDeviceLockWithScreenControl,
  canShareLookupSessionWithScreenControl,
  findScreenControlLockConflict,
  lookupSessionNeedsHumanAction,
  remainingActiveDeviceLock
} from "./device-lock-compatibility.mjs";
import {
  automationLockType,
  hasVerifiedAllSavedAccountsRestricted,
  isPostQueryLookupRestrictionEvent,
  isActiveAutomationStatus,
  lookupHumanRecoveryUnresolved,
  normalizeAutomationKind,
  normalizeKuaishouLeadDelayRange,
  normalizeLookupAccountChoice,
  normalizeLookupPhone,
  publicAutomationJob as buildPublicAutomationJob,
  publicLookupSession as buildPublicLookupSession,
  resumableLookupHumanVerificationResult,
  resumableLookupRecoveryResult,
  upsertLookupRestrictionHistory
} from "./automation-center.mjs";
import { smsRefreshRatePolicy } from "./sms-refresh-rate.mjs";
import { readAgentRuntimeRelease } from "./agent-runtime-release.mjs";
import { findSemanticSmsDuplicate, mergeCrossSourceSms } from "./sms-message-dedupe.mjs";
import { createSmsMessageIndex, sortSmsMessagesNewestFirst } from "./sms-message-index.mjs";
import {
  isOpenLookupDeviceAllowed,
  normalizeExternalReference,
  openLookupRequestFingerprint,
  parseOpenNameLookupClients,
  publicOpenLookupResult,
  publicOpenLookupSession
} from "./open-name-lookup-api.mjs";
import {
  applyAdbDeviceName,
  applyAdminDeviceName,
  applyPhoneAgentDeviceName,
  defaultAdbDeviceName
} from "./device-naming.mjs";
import {
  applyAdminSimAuthority,
  mergeReportedSims,
  normalizeSimPhoneSource
} from "./device-sim-authority.mjs";
import {
  findXhsIdConflict,
  normalizeXhsId,
  validateXhsAccounts
} from "./xhs-account-identity.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(__dirname);
await loadDotEnv(path.join(rootDir, ".env"));

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = path.resolve(rootDir, process.env.DATA_DIR || "data");
const PUBLIC_DIR = path.join(rootDir, "public");
const RELEASE_DIR = path.join(DATA_DIR, "releases");
const AGENT_RUNTIME_RELEASE_DIR = path.join(DATA_DIR, "agent-releases");
const EVIDENCE_DIR = path.resolve(DATA_DIR, process.env.EVIDENCE_DIR || "evidence");
const STORAGE_BACKEND = normalizeStorageBackend(process.env.STORAGE_BACKEND || "json");
const REDIS_URL = String(process.env.REDIS_URL || "").trim();
const DATABASE_URL = process.env.DATABASE_URL || "";
const POSTGRES_STATE_KEY = process.env.POSTGRES_STATE_KEY || "default";
const POSTGRES_SSL = boolEnv(process.env.POSTGRES_SSL, false);
const POSTGRES_BOOTSTRAP_FROM_JSON = boolEnv(process.env.POSTGRES_BOOTSTRAP_FROM_JSON, false);
const NODE_ENV = process.env.NODE_ENV || "development";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
const STRICT_PRODUCTION_CONFIG = boolEnv(process.env.STRICT_PRODUCTION_CONFIG, false);
const ALLOW_JSON_STORAGE_IN_PRODUCTION = boolEnv(process.env.ALLOW_JSON_STORAGE_IN_PRODUCTION, false);
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || "dev-admin-token";
const WINDOWS_AGENT_TOKEN = process.env.WINDOWS_AGENT_TOKEN || "dev-windows-token";
const DEVICE_AGENT_TOKEN = process.env.DEVICE_AGENT_TOKEN || "dev-device-token";
const EVIDENCE_SIGNING_SECRET = process.env.EVIDENCE_SIGNING_SECRET || ADMIN_API_TOKEN || WINDOWS_AGENT_TOKEN;
const EVIDENCE_URL_TTL_SECONDS = Math.max(60, Number(process.env.EVIDENCE_URL_TTL_SECONDS || 300));
const THIRD_PARTY_API_CLIENTS = parseThirdPartyApiClients(process.env.THIRD_PARTY_API_CLIENTS || "");
const OPEN_NAME_LOOKUP_API_ENABLED = boolEnv(process.env.OPEN_NAME_LOOKUP_API_ENABLED, false);
const OPEN_NAME_LOOKUP_CLIENTS = parseOpenNameLookupClients(process.env.OPEN_NAME_LOOKUP_CLIENTS_JSON || "");
const BOOTSTRAP_ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const BOOTSTRAP_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS || 24) * 3_600_000;
const MIN_PASSWORD_LENGTH = Number(process.env.MIN_PASSWORD_LENGTH || (NODE_ENV === "production" ? 12 : 8));
const MIN_MANAGED_USER_PASSWORD_LENGTH = Number(process.env.MIN_MANAGED_USER_PASSWORD_LENGTH || 7);
const LOGIN_RATE_LIMIT_WINDOW_MS = Number(process.env.LOGIN_RATE_LIMIT_WINDOW_SECONDS || 300) * 1000;
const LOGIN_RATE_LIMIT_MAX = Number(process.env.LOGIN_RATE_LIMIT_MAX || 8);
const SMS_ORDER_TTL_MS = Number(process.env.SMS_ORDER_TTL_SECONDS || 300) * 1000;
const SMS_ORDER_PROBE_INTERVAL_MS = Math.max(500, Number(process.env.SMS_ORDER_PROBE_INTERVAL_MS || DEFAULT_SMS_ORDER_PROBE_INTERVAL_MS));
const WINDOWS_TASK_TTL_MS = Number(process.env.WINDOWS_TASK_TTL_SECONDS || 300) * 1000;
const ALIPAY_NAME_QUERY_WINDOWS_TASK_TTL_MS = Math.max(
  WINDOWS_TASK_TTL_MS,
  Number(process.env.ALIPAY_NAME_QUERY_TASK_TTL_SECONDS || 2100) * 1000
);
const WINDOWS_TASK_QUEUE_TTL_MS = Number(process.env.WINDOWS_TASK_QUEUE_TTL_SECONDS || 1800) * 1000;
const XHS_TASK_TTL_MS = Number(process.env.XHS_TASK_TTL_SECONDS || 600) * 1000;
const XHS_TASK_QUEUE_TTL_MS = Number(process.env.XHS_TASK_QUEUE_TTL_SECONDS || 1800) * 1000;
const USER_MAX_WAITING_SMS = Number(process.env.USER_MAX_WAITING_SMS || 1);
const USER_MAX_ACTIVE_XHS_TASKS = Number(process.env.USER_MAX_ACTIVE_XHS_TASKS || 3);
const DEVICE_MAX_ACTIVE_XHS_TASKS = Number(process.env.DEVICE_MAX_ACTIVE_XHS_TASKS || 1);
const MAX_JSON_BYTES = Number(process.env.MAX_JSON_BYTES || 20_000_000);
const MAX_APK_BYTES = Number(process.env.MAX_APK_BYTES || 200_000_000);
const MAX_AGENT_RUNTIME_RELEASE_BYTES = Number(process.env.MAX_AGENT_RUNTIME_RELEASE_BYTES || 50_000_000);
const MAX_QR_IMAGE_BYTES = Number(process.env.MAX_QR_IMAGE_BYTES || 3_000_000);
const MAX_PUBLISH_IMAGES = Math.max(1, Math.min(9, Number(process.env.MAX_PUBLISH_IMAGES || 5)));
const AUTOMATION_SESSION_TTL_MS = Math.max(600_000, Number(process.env.AUTOMATION_SESSION_TTL_SECONDS || 43_200) * 1000);
const KUAISHOU_LEAD_LOCK_TTL_MS = AUTOMATION_SESSION_TTL_MS;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_SECONDS || 120) * 1000;
const KEEP_ALIVE_TIMEOUT_MS = Number(process.env.KEEP_ALIVE_TIMEOUT_SECONDS || 65) * 1000;
const HEADERS_TIMEOUT_MS = Number(process.env.HEADERS_TIMEOUT_SECONDS || 70) * 1000;
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 30);
const MAX_SMS_ORDERS = Number(process.env.MAX_SMS_ORDERS || 5000);
const MAX_SMS_EVENTS = Number(process.env.MAX_SMS_EVENTS || 10000);
const MAX_SMS_MESSAGES = Number(process.env.MAX_SMS_MESSAGES || 50000);
const MAX_WINDOWS_TASKS = Number(process.env.MAX_WINDOWS_TASKS || 5000);
const MAX_XHS_TASKS = Number(process.env.MAX_XHS_TASKS || 5000);
const MAX_AUTOMATION_JOBS = Number(process.env.MAX_AUTOMATION_JOBS || 5000);
const MAX_AUTOMATION_SESSIONS = Number(process.env.MAX_AUTOMATION_SESSIONS || 1000);
const MAX_EVIDENCE_ASSETS = Number(process.env.MAX_EVIDENCE_ASSETS || 10000);
const MAX_AUDIT_EVENTS = Number(process.env.MAX_AUDIT_EVENTS || 5000);
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 5000);
const DEFAULT_AGENT_MAX_CONCURRENT_ADB_TASKS = Number(process.env.DEFAULT_AGENT_MAX_CONCURRENT_ADB_TASKS || 15);
const SCREEN_GALLERY_DELIVERY_LEASE_MS = Math.max(15_000, Number(process.env.SCREEN_GALLERY_DELIVERY_LEASE_SECONDS || 60) * 1000);
const SCREEN_GALLERY_DELIVERY_MAX_ATTEMPTS = Math.max(1, Number(process.env.SCREEN_GALLERY_DELIVERY_MAX_ATTEMPTS || 5));
const XHS_PUBLISH_DELIVERY_LEASE_MS = Math.max(15_000, Number(process.env.XHS_PUBLISH_DELIVERY_LEASE_SECONDS || 60) * 1000);
const XHS_PUBLISH_DELIVERY_MAX_ATTEMPTS = Math.max(1, Number(process.env.XHS_PUBLISH_DELIVERY_MAX_ATTEMPTS || 5));
const MAX_STORED_UI_HIERARCHY_CHARS = Number(process.env.MAX_STORED_UI_HIERARCHY_CHARS || 80_000);
const MAX_STORED_UI_SNAPSHOT_CHARS = Number(process.env.MAX_STORED_UI_SNAPSHOT_CHARS || 8_000);
const WINDOWS_AGENT_ONLINE_MS = Number(process.env.WINDOWS_AGENT_ONLINE_SECONDS || 90) * 1000;
const DEVICE_AGENT_ONLINE_MS = Number(process.env.DEVICE_AGENT_ONLINE_SECONDS || 130) * 1000;
const USER_SMS_REFRESH_COOLDOWN_MS = Number(process.env.USER_SMS_REFRESH_COOLDOWN_SECONDS || 10) * 1000;
const USER_SMS_AUTO_REFRESH_COOLDOWN_MS = Number(process.env.USER_SMS_AUTO_REFRESH_COOLDOWN_SECONDS || 300) * 1000;
const TRUSTED_ORIGINS = parseTrustedOrigins(process.env.TRUSTED_ORIGINS || PUBLIC_BASE_URL || "");
const OPEN_API_TIMESTAMP_SKEW_MS = Number(process.env.OPEN_API_TIMESTAMP_SKEW_SECONDS || 300) * 1000;
const MAX_OPEN_API_NONCES = Number(process.env.MAX_OPEN_API_NONCES || 5000);
const DEVICE_ONLINE_TTL_SECONDS = Number(process.env.DEVICE_ONLINE_TTL_SECONDS || 45);
const REDIS_COMMAND_TIMEOUT_MS = Number(process.env.REDIS_COMMAND_TIMEOUT_MS || 1500);
const STRUCTURED_TABLE_SYNC = boolEnv(process.env.STRUCTURED_TABLE_SYNC, false);
const STRUCTURED_WRITES = boolEnv(process.env.STRUCTURED_WRITES, STORAGE_BACKEND === "postgres");
const LEGACY_WINDOWS_AGENT_TOKEN_ENABLED = boolEnv(process.env.LEGACY_WINDOWS_AGENT_TOKEN_ENABLED, true);
const XHS_QR_DEFAULT_SCRIPT_ID = "xhs_qr_default";
const XHS_QR_DEFAULT_SCRIPT_VERSION = "xhs_qr_default_v1";
// Poco is the fast default.  This small, explicit allow-list is only for
// devices where the vendor UiAutomation/Poco service has been proven to hang.
// It can be extended without changing the task protocol.
const XHS_XML_UIAUTOMATOR_SERIALS = new Set(
  String(process.env.XHS_XML_UIAUTOMATOR_SERIALS || "10CD5H0N9B002G0")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);
const SCREEN_SESSION_TTL_MS = Number(process.env.SCREEN_SESSION_TTL_SECONDS || 7200) * 1000;
const SCREEN_MEDIA_SLOT_COUNT = Math.max(1, Number(process.env.SCREEN_MEDIA_SLOT_COUNT || process.env.SCREEN_MAX_CONCURRENT_SESSIONS || 20));
const SCREEN_MAX_CONCURRENT_SESSIONS = Math.min(
  SCREEN_MEDIA_SLOT_COUNT,
  Math.max(1, Number(process.env.SCREEN_MAX_CONCURRENT_SESSIONS || SCREEN_MEDIA_SLOT_COUNT))
);
// A conservative default prevents auto-quality from assuming an unrealistically
// large public uplink when deployment configuration has not set a budget.
const SCREEN_RELAY_BANDWIDTH_MBPS = Math.max(5, Number(process.env.SCREEN_RELAY_BANDWIDTH_MBPS || 20));
const SCREEN_MEDIA_TRANSPORT = ["websocket", "webrtc", "direct_webrtc"].includes(String(process.env.SCREEN_MEDIA_TRANSPORT || "websocket").trim())
  ? String(process.env.SCREEN_MEDIA_TRANSPORT || "websocket").trim()
  : "websocket";
const SCREEN_MEDIA_PUBLISH_TRANSPORT = ["rtsp", "whip"].includes(String(process.env.SCREEN_MEDIA_PUBLISH_TRANSPORT || "rtsp").trim())
  ? String(process.env.SCREEN_MEDIA_PUBLISH_TRANSPORT || "rtsp").trim()
  : "rtsp";
const SCREEN_MEDIA_AUTH_SECRET = process.env.SCREEN_MEDIA_AUTH_SECRET || EVIDENCE_SIGNING_SECRET;
const SCREEN_MEDIA_TOKEN_TTL_MS = Math.max(60_000, Number(process.env.SCREEN_MEDIA_TOKEN_TTL_SECONDS || 600) * 1000);
const SCREEN_MEDIA_WHEP_BASE_URL = String(process.env.SCREEN_MEDIA_WHEP_BASE_URL || `${PUBLIC_BASE_URL || ""}/webrtc`).replace(/\/$/, "");
const SCREEN_MEDIA_WHIP_PUBLISH_BASE_URL = String(process.env.SCREEN_MEDIA_WHIP_PUBLISH_BASE_URL || "").replace(/\/$/, "");
const SCREEN_MEDIA_RTSP_PUBLISH_BASE_URL = String(process.env.SCREEN_MEDIA_RTSP_PUBLISH_BASE_URL || "").replace(/\/$/, "");
const SCREEN_DIRECT_WEBRTC_ICE_SERVERS = parseWebRtcIceServers(process.env.SCREEN_WEBRTC_ICE_SERVERS_JSON);


const DATA_FILE = path.join(DATA_DIR, "state.json");
const recoveryControls = await createRecoveryControls({file:path.join(DATA_DIR,"device-recovery-controls.json")});
const saveQueue = createSaveQueue();
const realtimeMetrics = createRealtimeMetrics();
let postgresPool = null;
const loginRateLimits = new Map();
const state = await loadState();
const structuredRepos = STORAGE_BACKEND === "postgres" && STRUCTURED_WRITES
  ? createPostgresRepositories({ getPool: getPostgresPool, stringify: stringifyPostgresJson })
  : null;
if (structuredRepos) applyStructuredOverlay(state, await structuredRepos.loadOverlay());
// Normalize legacy records once, before HTTP/control handlers can observe state.
// Runtime maintenance only trims retention/payloads; it never deep-copies history.
await normalizeLoadedTaskHistory([state.windowsTasks, state.xhsQrTasks, state.automationJobs], {
  sanitizeEvent: sanitizeStoredEvent,
  sanitizeResult: (result) => sanitizeTaskResult(result, { includeEvidence: true })
});
sortSmsMessagesNewestFirst(state.smsMessages);
const smsMessageIndex = createSmsMessageIndex(state.smsMessages);
const repos = createStateRepositories(state);
const runtimeStore = createRuntimeStore();
const screenSessions = new ScreenSessionRegistry({
  ttlMs: SCREEN_SESSION_TTL_MS,
  mediaPaths: Array.from({ length: SCREEN_MEDIA_SLOT_COUNT }, (_, index) => `pc/slot-${index + 1}`)
});
const screenMediaAuthorizer = createScreenMediaAuthorizer({
  secret: SCREEN_MEDIA_AUTH_SECRET,
  tokenTtlMs: SCREEN_MEDIA_TOKEN_TTL_MS
});
const runtimeSaveScheduler = createRuntimeSaveScheduler({
  save: () => saveState(),
  isBusy: () => screenSessions.activeCount() > 0,
  onError: (error) => console.error("save runtime state", error),
  delayMs: structuredRepos ? 300_000 : 2_000,
  busyRetryMs: structuredRepos ? 30_000 : 5_000
});
const persistencePolicy = createPersistencePolicy({
  structuredWritesEnabled: Boolean(structuredRepos),
  saveSnapshot: () => saveState(),
  scheduleCheckpoint: () => runtimeSaveScheduler.mark()
});
const taskStatusPersistence = createTaskStatusPersistence();
let managedLookup = null;
const pendingEvidenceDeletes = new Set();
const pendingXhsCollectionCommits = new WeakSet();
let evidenceCleanupRunning = false;
let lastEvidenceCleanupAt = 0;
let screenRelay = null;
await ensureBootstrapAdmin();
enforceStrictProductionConfig();
await logStartupDiagnostics();
if (boolEnv(process.env.MANAGED_NAME_LOOKUP_ENABLED, false)) {
  if (NODE_ENV === 'production' && (!structuredRepos || STORAGE_BACKEND !== 'postgres')) throw new Error('managed_lookup_requires_structured_postgres');
  const store = await createManagedLookupStore({getPool: structuredRepos ? getPostgresPool : null, file:path.join(DATA_DIR,'managed-lookup.json'), key:POSTGRES_STATE_KEY, persistLegacy:saveState});
  const adapter = createManagedLookupAdapter({state, clientIds:()=>[...OPEN_NAME_LOOKUP_CLIENTS.keys()], userFor:id=>openNameLookupUser(OPEN_NAME_LOOKUP_CLIENTS.get(id)), persist:bundle=>structuredRepos.persistTaskMutation(bundle),
    listed:isDeviceListed,online:isAdbOnline,onlineMs:WINDOWS_AGENT_ONLINE_MS,screenActive:id=>screenSessions.activeForDevice(id),lockFor:activeDeviceLockForTask,recovery:resumableLookupRecoveryResult,
    allCooling:d=>{const session=state.automationSessions.find(x=>x.deviceId===d.deviceId&&x.savedAccounts?.length);return session?allSavedAccountsCooling(d,session.savedAccounts):false;},
    createSession:createLookupSession,createJob:createAutomationJob,acquireLock:acquireAutomationDeviceLock,queueTask:queueAutomationWindowsTask,result:upsertLookupResult,cancelJob:cancelAutomationJob});
  managedLookup = createManagedLookupService({store,adapter,probePhone:process.env.LOOKUP_READINESS_PROBE_PHONE||'',resumeHuman:resumeLookupAfterObservedHumanVerification});
}
const managedLookupTimer=setInterval(()=>managedLookup?.tick().catch(e=>console.error('managed lookup storage/dispatch unavailable; original tasks retained',e.code||e.name||'error')),250).unref();


let lookupHumanNotifier = null;
try {
  lookupHumanNotifier = createLookupHumanNotifier({
    webhookUrl: await readLookupHumanWebhook(),
    receiptsDir: path.join(DATA_DIR, "lookup-human-notifications"),
    getTargets: () => [...pendingLookupHumanNotifications(state.automationSessions, state.devices),...(managedLookup?.accountOfflineNotifications(state.devices)||[])],
    onResult: (outcome) => console.log("lookup human notification", outcome)
  });
} catch {
  console.error("lookup human notification configuration unavailable; notifications disabled");
}
const lookupHumanNotificationTimer = setInterval(() => {
  lookupHumanNotifier?.poll().catch(() => console.error("lookup human notification receipt unavailable"));
}, 3_000).unref();

const maintenanceTimer = setInterval(() => {
  const expiredScreenSessions = screenSessions.expire();
  for (const session of expiredScreenSessions) screenRelay?.stop(session.sessionId, "session_expired");
  const changed = [
    expireSmsOrders(),
    recoverStalledTasks(),
    expireWindowsTasks(),
    ensureWaitingSmsOrderProbes() > 0,
    expireXhsTasks(),
    expireDeviceLocks(),
    revokeExpiredSessions()
  ].some(Boolean);
  const pruneResult = pruneState();
  const pruned = Object.values(pruneResult.removed || {}).some((value) => Number(value || 0) > 0);
  if (pruned || Date.now() - lastEvidenceCleanupAt > 60 * 60 * 1000) {
    runEvidenceStorageCleanup().catch((error) => console.error("cleanup evidence storage", error));
  }
  if (changed || pruned) {
    runtimeSaveScheduler.mark();
    if (screenSessions.activeCount() === 0) {
      runtimeSaveScheduler.flush().catch((error) => console.error("save runtime state", error));
    }
  }
}, 10_000).unref();

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  const requestId = getRequestId(req);
  res.setHeader("x-request-id", requestId);
  setSecurityHeaders(res);
  res.on("finish", () => logAccess(req, res, startedAt, requestId));
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return json(res, 200, { ok: true, at: nowIso() });
    }

    if (req.method === "GET" && url.pathname === "/readyz") {
      const readiness = await buildReadiness();
      return json(res, readiness.ok ? 200 : 503, readiness);
    }

    if (url.pathname.startsWith("/api/")) {
      return await routeApi(req, res, url);
    }

    return await serveStatic(req, res, url);
  } catch (error) {
    if (!error.statusCode || error.statusCode >= 500) console.error(error);
    const status = error.statusCode || 500;
    const payload = status >= 500
      ? { error: "server_error", requestId }
      : { error: error.message || "request_failed" };
    return json(res, status, payload);
  }
});

server.requestTimeout = REQUEST_TIMEOUT_MS;
server.headersTimeout = HEADERS_TIMEOUT_MS;
server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

screenRelay = createScreenRelay({
  server,
  registry: screenSessions,
  metrics: realtimeMetrics,
  bandwidthMbps: SCREEN_RELAY_BANDWIDTH_MBPS,
  buildMediaStart(session) {
    return buildScreenMediaStart(session);
  },
  authenticateAgent(req, agentId) {
    return requireWindowsAgent(req, agentId);
  },
  onSessionClosed(session, reason) {
    if (!session) return;
    releaseDeviceScreenLock(session.sessionId, reason);
    runtimeSaveScheduler.mark();
  },
  logger: console
});

const lookupHumanHandover = createLookupHumanHandover({
  targets: lookupHumanProbeTargets,
  resume: resumeLookupAfterObservedHumanVerification,
  observeManaged: (target, observation) => managedLookup?.recordHumanObservation(target, observation)
});

// Screen session state deliberately lives in memory so browser credentials do
// not survive a process restart. Persisted screen locks therefore cannot be
// resumed after a restart; release them now and let the Agent inventory stop
// any leftover scrcpy / ffmpeg worker on reconnect.
if (releaseOrphanedScreenLocksAfterRestart()) {
  await saveState();
}

server.listen(PORT, HOST, () => {
  console.log(`phone-cloud-platform listening on http://${HOST}:${PORT}`);
});

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

async function routeApi(req, res, url) {
  enforceRequestOrigin(req);
  if(req.method==='POST'&&url.pathname==='/api/v1/open/name-lookups/prepare'){
    if(!OPEN_NAME_LOOKUP_API_ENABLED||!managedLookup)return json(res,404,{ok:false,code:'managed_lookup_not_enabled'});
    try{const {ctx,input}=await readSignedOpenJson(req,url,OPEN_NAME_LOOKUP_CLIENTS);if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)return json(res,400,{ok:false,code:'prepare_body_must_be_empty'});const {ok,preparationId,status,ready,expiresAt}=await managedLookup.prepare({clientId:ctx.clientId,key:requiredOpenIdempotencyKey(req)});return json(res,200,{ok,preparationId,status,ready,expiresAt});}catch(e){return json(res,e.statusCode||503,{ok:false,code:e.statusCode?e.message:'lookup_storage_unavailable'});}
  }
  if(req.method==='POST'&&url.pathname==='/api/v1/open/name-lookups/stop'){
    if(!OPEN_NAME_LOOKUP_API_ENABLED||!managedLookup)return json(res,404,{ok:false,code:'managed_lookup_not_enabled'});
    try{
      const {ctx,input}=await readSignedOpenJson(req,url,OPEN_NAME_LOOKUP_CLIENTS);
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||typeof input.preparationId!=='string')return json(res,400,{ok:false,code:'stop_body_requires_preparation_id'});
      const result=await managedLookup.stopRound({clientId:ctx.clientId,preparationId:input.preparationId,key:requiredOpenIdempotencyKey(req)});
      return json(res,result.stopped?200:202,result);
    }catch(e){return json(res,e.statusCode||503,{ok:false,code:e.statusCode?e.message:'lookup_storage_unavailable'});}
  }
  const asyncLookupResultMatch=url.pathname.match(/^\/api\/v1\/open\/name-lookups\/tasks\/([A-Za-z0-9-]{1,80})$/);
  if ((req.method==='POST'&&url.pathname==='/api/v1/open/name-lookups/tasks')||(req.method==='GET'&&asyncLookupResultMatch)) {
    if(!OPEN_NAME_LOOKUP_API_ENABLED||!managedLookup)return json(res,404,{ok:false,code:'managed_lookup_not_enabled'});
    try {
      if(req.method==='GET'){
        const ctx=verifyOpenApiRequest(req,url,'',OPEN_NAME_LOOKUP_CLIENTS);recordOpenApiNonce(ctx);
        return json(res,200,await managedLookup.getAsyncResult(asyncLookupResultMatch[1],ctx.clientId));
      }
      const {ctx,input}=await readSignedOpenJson(req,url,OPEN_NAME_LOOKUP_CLIENTS);
      let phoneNumber;try{phoneNumber=normalizeLookupPhone(input.phoneNumber);}catch{throw badRequest('invalid_lookup_phone');}
      const admitted=await managedLookup.submitAsync({clientId:ctx.clientId,phoneNumber,key:requiredOpenIdempotencyKey(req)});
      const result=await managedLookup.getAsyncResult(admitted.lookupId,ctx.clientId);
      if(!res.destroyed)return json(res,admitted.reused?200:202,{ok:true,lookupId:admitted.lookupId,status:result.status,reused:admitted.reused});return;
    }catch(e){if(res.destroyed)return;if(e.statusCode===429)res.setHeader('Retry-After','5');return json(res,e.statusCode||503,{ok:false,code:e.statusCode?e.message:'lookup_storage_unavailable'});}
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/open/name-lookups/query') {
    if (!OPEN_NAME_LOOKUP_API_ENABLED || !managedLookup) return json(res,404,{ok:false,name:'',code:'managed_lookup_not_enabled'});
    try {
      const {ctx,input}=await readSignedOpenJson(req,url,OPEN_NAME_LOOKUP_CLIENTS);
      let phoneNumber;try{phoneNumber=normalizeLookupPhone(input.phoneNumber);}catch{throw badRequest('invalid_lookup_phone');}
      const id=await managedLookup.submit({clientId:ctx.clientId,phoneNumber,key:requiredOpenIdempotencyKey(req)});
      const abort=new AbortController();const disconnect=()=>{if(!res.writableEnded)abort.abort();};res.once('close',disconnect);
      try { const result=await managedLookup.wait(id,ctx.clientId,{signal:abort.signal});if(!res.destroyed)return json(res,result.status,result.body); }
      finally {res.removeListener('close',disconnect);}return;
    } catch (e) {if(res.destroyed)return;if(!e.statusCode)return json(res,503,{ok:false,name:'',code:'lookup_storage_unavailable'});if(e.statusCode===429)res.setHeader('Retry-After','3');return json(res,e.statusCode,{ok:false,name:'',code:e.message});}
  }
  if(url.pathname.startsWith('/api/v1/admin/lookup-pool')) {
    const ctx=requireAuth(req,['admin']);if(!managedLookup)return json(res,404,{error:'managed_lookup_not_enabled'});
    if(req.method==='GET' && url.pathname==='/api/v1/admin/lookup-pool')return json(res,200,{pool:managedLookup.admin()});
    if(req.method==='POST' && url.pathname==='/api/v1/admin/lookup-pool/preview')return json(res,200,{devices:managedLookup.preview()});
    if(req.method==='PUT' && url.pathname==='/api/v1/admin/lookup-pool')return json(res,200,{ok:true,...await managedLookup.configure(await readJson(req),ctx.userId||ctx.role)});
    const retry=url.pathname.match(/^\/api\/v1\/admin\/lookup-pool\/requests\/([^/]+)\/retry$/);
    if(req.method==='POST' && retry){await managedLookup.retry(retry[1],ctx.userId||ctx.role);return json(res,202,{ok:true});}
    const cancel=url.pathname.match(/^\/api\/v1\/admin\/lookup-pool\/requests\/([^/]+)\/cancel$/);
    if(req.method==='POST' && cancel){await managedLookup.cancel(cancel[1],ctx.userId||ctx.role);return json(res,202,{ok:true});}
    return json(res,404,{error:'not_found'});
  }


  if (req.method === "POST" && url.pathname === "/api/internal/screen-media/auth") {
    const input = await readJson(req);
    const result = screenMediaAuthorizer.authorizeMediaRequest(input);
    if (!result.ok) {
      console.warn("screen media authentication rejected", {
        action: String(input?.action || ""),
        path: String(input?.path || ""),
        protocol: String(input?.protocol || ""),
        hasToken: Boolean(String(input?.token || "").trim()),
        hasAuthorization: Boolean(String(input?.authorization || input?.Authorization || "").trim()),
        hasQueryToken: /(?:^|&)token=/.test(String(input?.query || "")),
        reason: result.reason || "media_auth_denied"
      });
    }
    return json(res, result.ok ? 200 : 401, result.ok ? { ok: true } : { ok: false, error: "media_auth_denied" });
  }

  if (req.method === "POST" && url.pathname === "/api/v1/auth/login") {
    const input = await readJson(req);
    const username = normalizeUsername(input.username);
    const rateKey = loginRateLimitKey(req, username);
    const rateCheck = checkLoginRateLimit(rateKey);
    if (!rateCheck.ok) return json(res, 429, { error: "too_many_login_attempts", retryAfterSeconds: rateCheck.retryAfterSeconds });
    const user = state.users.find((item) => item.username === username && item.enabled !== false);
    if (!user || !verifyPassword(String(input.password || ""), user.passwordHash)) {
      recordLoginFailure(rateKey);
      return json(res, 401, { error: "invalid_credentials" });
    }
    clearLoginFailures(rateKey);
    const session = createSession(user, req);
    user.lastLoginAt = nowIso();
    const audit = addAudit("auth_login", { role: user.role, username: user.username, userId: user.userId }, { userId: user.userId });
    await persistencePolicy.persist(() => structuredRepos.persistAuthMutation({ user, sessions: [session], audit }));
    return json(res, 200, { ok: true, session: publicSession(session), user: publicUser(user) });
  }

  if (req.method === "GET" && url.pathname === "/api/v1/auth/me") {
    const ctx = requireAuth(req, ["admin", "user"]);
    return json(res, 200, { user: ctx.user ? publicUser(ctx.user) : staticTokenUser(ctx) });
  }

  if (req.method === "POST" && url.pathname === "/api/v1/auth/logout") {
    const ctx = requireAuth(req, ["admin", "user"]);
    if (ctx.session) {
      ctx.session.revokedAt = nowIso();
      await persistencePolicy.persist(() => structuredRepos.persistAuthMutation({ sessions: [ctx.session] }));
    }
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/v1/auth/password") {
    const ctx = requireAuth(req, ["admin", "user"]);
    if (!ctx.user || !ctx.session) return json(res, 400, { error: "password_change_requires_user_session" });
    const input = await readJson(req);
    if (!verifyPassword(String(input.currentPassword || ""), ctx.user.passwordHash)) return json(res, 401, { error: "invalid_current_password" });
    const nextPassword = String(input.newPassword || "");
    validatePasswordStrength(nextPassword);
    ctx.user.passwordHash = hashPassword(nextPassword);
    ctx.user.updatedAt = nowIso();
    revokeUserSessions(ctx.user.userId, ctx.session.sessionId);
    const audit = addAudit("auth_password_change", ctx, { userId: ctx.user.userId });
    const sessions = state.sessions.filter((session) => session.userId === ctx.user.userId);
    await persistencePolicy.persist(() => structuredRepos.persistAuthMutation({ user: ctx.user, sessions, audit }));
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/v1/open/sms-code-requests") {
    const { ctx, input } = await readSignedOpenJson(req, url);
    const target = resolveSmsOrderTarget(input);
    if (!target.phoneNumber && !target.deviceId) return json(res, 400, { error: "phoneNumber or deviceId is required" });
    if (target.deviceId) {
      const device = repos.devices.findById(target.deviceId);
      if (!device) return json(res, 404, { error: "device_not_found" });
      if (!isDeviceListed(device)) return json(res, 409, { error: "device_not_published" });
      if (!isDeviceUsable(device)) return json(res, 409, { error: "device_not_available" });
    }
    const idempotencyKey = normalizeIdempotencyKey(req.headers["idempotency-key"]);
    if (idempotencyKey) {
      const existing = state.smsOrders.find((order) => order.source === "open-api" && order.clientId === ctx.clientId && order.idempotencyKey === idempotencyKey);
      if (existing) return json(res, 200, { ok: true, idempotent: true, request: publicOpenSmsRequest(existing) });
    }
    const order = createSmsOrder({
      ...target,
      platform: input.platform || "第三方平台",
      userId: "",
      source: "open-api",
      clientId: ctx.clientId,
      idempotencyKey
    });
    addAudit("open_sms_request_create", ctx, { requestId: order.orderId, deviceId: order.deviceId, phoneNumber: order.phoneNumber });
    await saveState();
    return json(res, 201, { ok: true, request: publicOpenSmsRequest(order) });
  }

  const openSmsRequestMatch = url.pathname.match(/^\/api\/v1\/open\/sms-code-requests\/([^/]+)$/);
  if (req.method === "GET" && openSmsRequestMatch) {
    const ctx = verifyOpenApiRequest(req, url, "");
    const expired = expireSmsOrders();
    recordOpenApiNonce(ctx);
    const order = state.smsOrders.find((item) => item.orderId === openSmsRequestMatch[1] && item.source === "open-api" && item.clientId === ctx.clientId);
    if (!order) return json(res, 404, { error: "sms_request_not_found" });
    const probeQueued = Boolean(queueSmsOrderProbe(order));
    if (expired || probeQueued) runtimeSaveScheduler.mark();
    return json(res, 200, { request: publicOpenSmsRequest(order) });
  }

  const openSmsCancelMatch = url.pathname.match(/^\/api\/v1\/open\/sms-code-requests\/([^/]+)\/cancel$/);
  if (req.method === "POST" && openSmsCancelMatch) {
    const { ctx } = await readSignedOpenJson(req, url);
    const order = state.smsOrders.find((item) => item.orderId === openSmsCancelMatch[1] && item.source === "open-api" && item.clientId === ctx.clientId);
    if (!order) return json(res, 404, { error: "sms_request_not_found" });
    if (order.status !== "waiting") return json(res, 409, { error: "sms_request_not_cancellable" });
    order.status = "cancelled";
    order.updatedAt = nowIso();
    addAudit("open_sms_request_cancel", ctx, { requestId: order.orderId, deviceId: order.deviceId, phoneNumber: order.phoneNumber });
    await saveState();
    return json(res, 200, { ok: true, request: publicOpenSmsRequest(order) });
  }

  if (url.pathname.startsWith("/api/v1/open/name-lookups")) {
    if (!OPEN_NAME_LOOKUP_API_ENABLED) return json(res, 404, { error: "open_name_lookup_api_not_enabled" });

    if (req.method === "GET" && url.pathname === "/api/v1/open/name-lookups/devices") {
      const ctx = verifyOpenApiRequest(req, url, "", OPEN_NAME_LOOKUP_CLIENTS);
      recordOpenApiNonce(ctx);
      const user = openNameLookupUser(ctx.client);
      if (!user) return json(res, 403, { error: "open_name_lookup_user_not_available" });
      const devices = ctx.client.deviceIds.map((deviceId) => repos.devices.findById(deviceId)).filter(Boolean).map((device) => ({
        deviceId: device.deviceId,
        deviceName: device.deviceName || device.deviceId,
        available: Boolean(isDeviceListed(device) && isAdbOnline(device) && !activeDeviceLockForTask(device.deviceId)),
        listed: isDeviceListed(device),
        adbOnline: isAdbOnline(device)
      }));
      return json(res, 200, { devices });
    }

    if (req.method === "POST" && url.pathname === "/api/v1/open/name-lookups/sessions") {
      const { ctx, input } = await readSignedOpenJson(req, url, OPEN_NAME_LOOKUP_CLIENTS);
      const user = openNameLookupUser(ctx.client);
      if (!user) return json(res, 403, { error: "open_name_lookup_user_not_available" });
      const deviceId = String(input.deviceId || "").trim();
      if (!isOpenLookupDeviceAllowed(ctx.client, deviceId)) return json(res, 403, { error: "open_name_lookup_device_not_allowed" });
      const idempotencyKey = requiredOpenIdempotencyKey(req);
      const fingerprint = openLookupRequestFingerprint({ deviceId });
      const replay = state.automationSessions.find((session) => session.source === "open-api" && session.clientId === ctx.clientId && session.idempotencyKey === idempotencyKey);
      if (replay) {
        if (replay.requestFingerprint !== fingerprint) return json(res, 409, { error: "idempotency_conflict" });
        return json(res, 200, { ok: true, idempotent: true, session: publicOpenLookupSession(replay) });
      }
      const device = repos.devices.findById(deviceId);
      if (!device) return json(res, 404, { error: "device_not_found" });
      if (!isDeviceListed(device)) return json(res, 409, { error: "device_not_published" });
      if (!isAdbOnline(device)) return json(res, 409, { error: "device_not_available" });
      const conflict = activeDeviceLockForTask(device.deviceId);
      if (conflict) return json(res, 409, { error: "device_busy" });
      const existing = state.automationSessions.find((session) => session.userId === user.userId && session.deviceId === device.deviceId && isActiveLookupSessionStatus(session.status));
      if (existing) {
        if (existing.source === "open-api" && existing.clientId === ctx.clientId) {
          return json(res, 409, { error: "lookup_session_already_active", session: publicOpenLookupSession(existing) });
        }
        return json(res, 409, { error: "device_busy" });
      }
      const session = createLookupSession({ userId: user.userId, deviceId: device.deviceId });
      Object.assign(session, { source: "open-api", clientId: ctx.clientId, idempotencyKey, requestFingerprint: fingerprint });
      const job = createAutomationJob({ kind: "alipay_name_start", userId: user.userId, deviceId: device.deviceId, sessionId: session.sessionId });
      Object.assign(job, { source: "open-api", clientId: ctx.clientId });
      session.pendingJobId = job.jobId;
      const actor = { ...ctx, userId: user.userId, user };
      const lock = acquireAutomationDeviceLock(device, job, actor, { taskId: session.sessionId, ttlMs: AUTOMATION_SESSION_TTL_MS });
      session.lockId = lock.lockId;
      const windowsTask = queueAutomationWindowsTask(device, job);
      const audit = addAudit("open_name_lookup_session_start", actor, { sessionId: session.sessionId, deviceId: device.deviceId });
      await persistencePolicy.persist(() => structuredRepos.persistTaskMutation({ windowsTask, automationJob: job, automationSession: session, deviceLock: lock, audit }));
      return json(res, 201, { ok: true, session: publicOpenLookupSession(session) });
    }

    const openLookupSessionMatch = url.pathname.match(/^\/api\/v1\/open\/name-lookups\/sessions\/([^/]+)$/);
    if (req.method === "GET" && openLookupSessionMatch) {
      const ctx = verifyOpenApiRequest(req, url, "", OPEN_NAME_LOOKUP_CLIENTS);
      recordOpenApiNonce(ctx);
      if (expireAutomationJobs()) runtimeSaveScheduler.mark();
      const session = openNameLookupSession(ctx.clientId, openLookupSessionMatch[1]);
      if (!session) return json(res, 404, { error: "lookup_session_not_found" });
      const dispatched = dispatchNextOpenLookupQuery(session);
      if (dispatched) {
        await persistencePolicy.persist(() => structuredRepos.persistTaskMutation({
          windowsTask: dispatched.windowsTask,
          automationJob: dispatched.job,
          automationSession: session
        }));
      }
      return json(res, 200, { session: publicOpenLookupSession(session) });
    }

    const openLookupQueryMatch = url.pathname.match(/^\/api\/v1\/open\/name-lookups\/sessions\/([^/]+)\/queries$/);
    if (req.method === "POST" && openLookupQueryMatch) {
      const { ctx, input } = await readSignedOpenJson(req, url, OPEN_NAME_LOOKUP_CLIENTS);
      const session = openNameLookupSession(ctx.clientId, openLookupQueryMatch[1]);
      if (!session) return json(res, 404, { error: "lookup_session_not_found" });
      let phoneNumber;
      let clientReference;
      let consentReference;
      try {
        phoneNumber = normalizeLookupPhone(input.phoneNumber);
        clientReference = normalizeExternalReference(input.clientReference, "client_reference");
        consentReference = normalizeExternalReference(input.consentReference, "consent_reference");
      } catch (error) {
        return json(res, 400, { error: error.message || "invalid_lookup_query" });
      }
      const idempotencyKey = requiredOpenIdempotencyKey(req);
      const fingerprint = openLookupRequestFingerprint({ sessionId: session.sessionId, phoneNumber, clientReference, consentReference });
      const replay = state.automationJobs.find((job) => job.source === "open-api" && job.clientId === ctx.clientId && job.sessionId === session.sessionId && job.idempotencyKey === idempotencyKey);
      if (replay) {
        if (replay.requestFingerprint !== fingerprint) return json(res, 409, { error: "idempotency_conflict" });
        return json(res, 200, { ok: true, idempotent: true, queryId: replay.resultId || replay.jobId, session: publicOpenLookupSession(session) });
      }
      if (session.requiresAccountSwitch) {
        return json(res, 409, {
          error: "lookup_queue_paused_account_switch_required",
          session: publicOpenLookupSession(session)
        });
      }
      if (!["starting", "ready", "querying", "switching", "choosing_account", "needs_human_verification"].includes(session.status)) {
        return json(res, 409, { error: "lookup_session_not_accepting_queries", session: publicOpenLookupSession(session) });
      }
      const device = repos.devices.findById(session.deviceId);
      if (!device || !isAdbOnline(device)) return json(res, 409, { error: "device_not_available" });
      const job = createAutomationJob({ kind: "alipay_name_query", userId: session.userId, deviceId: session.deviceId, sessionId: session.sessionId, phoneNumber });
      session.nextExternalQuerySequence = Math.max(0, Number(session.nextExternalQuerySequence || 0)) + 1;
      Object.assign(job, { source: "open-api", clientId: ctx.clientId, idempotencyKey, requestFingerprint: fingerprint, clientReference, consentReference, queueSequence: session.nextExternalQuerySequence });
      session.updatedAt = nowIso();
      const result = upsertLookupResult(session, job, { status: "queued", stage: "查询已进入会话队列", createdAt: job.createdAt, updatedAt: session.updatedAt });
      result.clientReference = clientReference;
      result.consentReference = consentReference;
      const dispatched = dispatchNextOpenLookupQuery(session);
      const audit = addAudit("open_name_lookup_query", ctx, { sessionId: session.sessionId, jobId: job.jobId, deviceId: session.deviceId, clientReference, consentReference });
      await persistencePolicy.persist(() => structuredRepos.persistTaskMutation({
        windowsTask: dispatched?.windowsTask || null,
        automationJob: job,
        automationJobs: dispatched?.job && dispatched.job !== job ? [dispatched.job] : [],
        automationSession: session,
        audit
      }));
      return json(res, 202, { ok: true, queryId: result.resultId, session: publicOpenLookupSession(session) });
    }

    const openLookupQueryDetailMatch = url.pathname.match(/^\/api\/v1\/open\/name-lookups\/sessions\/([^/]+)\/queries\/([^/]+)$/);
    if (req.method === "GET" && openLookupQueryDetailMatch) {
      const ctx = verifyOpenApiRequest(req, url, "", OPEN_NAME_LOOKUP_CLIENTS);
      recordOpenApiNonce(ctx);
      const session = openNameLookupSession(ctx.clientId, openLookupQueryDetailMatch[1]);
      if (!session) return json(res, 404, { error: "lookup_session_not_found" });
      const result = (session.results || []).find((item) => item.resultId === openLookupQueryDetailMatch[2]);
      if (!result) return json(res, 404, { error: "lookup_query_not_found" });
      return json(res, 200, { query: publicOpenLookupResult(result) });
    }

    const openLookupResumeMatch = url.pathname.match(/^\/api\/v1\/open\/name-lookups\/sessions\/([^/]+)\/resume$/);
    if (req.method === "POST" && openLookupResumeMatch) {
      const { ctx, input } = await readSignedOpenJson(req, url, OPEN_NAME_LOOKUP_CLIENTS);
      const session = openNameLookupSession(ctx.clientId, openLookupResumeMatch[1]);
      if (!session) return json(res, 404, { error: "lookup_session_not_found" });
      const sourceResult = resumableLookupHumanVerificationResult(session) || resumableLookupRecoveryResult(session);
      if (!sourceResult) return json(res, 409, { error: "lookup_human_verification_not_resumable", session: publicOpenLookupSession(session) });
      if (sourceResult.phase === "start") return json(res, 409, { error: "lookup_startup_human_resume_automatic" });
      if (String(input.queryId || "") !== String(sourceResult.resultId || "")) return json(res, 409, { error: "lookup_human_verification_query_mismatch" });
      const idempotencyKey = requiredOpenIdempotencyKey(req);
      const fingerprint = openLookupRequestFingerprint({ sessionId: session.sessionId, queryId: sourceResult.resultId });
      const replay = state.automationJobs.find((job) => job.source === "open-api" && job.clientId === ctx.clientId && job.sessionId === session.sessionId && job.idempotencyKey === idempotencyKey);
      if (replay) {
        if (replay.requestFingerprint !== fingerprint) return json(res, 409, { error: "idempotency_conflict" });
        return json(res, 200, { ok: true, idempotent: true, queryId: sourceResult.resultId, session: publicOpenLookupSession(session) });
      }
      if (screenSessions.activeForDevice(session.deviceId)) return json(res, 409, { error: "lookup_screen_control_active" });
      const device = repos.devices.findById(session.deviceId);
      if (!device || !isAdbOnline(device)) return json(res, 409, { error: "device_not_available" });
      const job = createAutomationJob({ kind: "alipay_name_query", userId: session.userId, deviceId: session.deviceId, sessionId: session.sessionId, phoneNumber: sourceResult.phoneNumber, resultId: sourceResult.resultId, resumeAfterHumanVerification: true, restartAfterHumanVerification: sourceResult.status === "needs_recovery" });
      Object.assign(job, { source: "open-api", clientId: ctx.clientId, idempotencyKey, requestFingerprint: fingerprint, clientReference: sourceResult.clientReference || "", consentReference: sourceResult.consentReference || "" });
      session.status = "querying";
      session.pendingJobId = job.jobId;
      session.error = "";
      session.updatedAt = nowIso();
      upsertLookupResult(session, job, { status: "queued", stage: "等待继续获取当前号码结果", error: "", updatedAt: session.updatedAt });
      const windowsTask = queueAutomationWindowsTask(device, job);
      const audit = addAudit("open_name_lookup_human_verification_resume", ctx, { sessionId: session.sessionId, jobId: job.jobId, queryId: sourceResult.resultId, deviceId: session.deviceId });
      await persistencePolicy.persist(() => structuredRepos.persistTaskMutation({ windowsTask, automationJob: job, automationSession: session, audit }));
      return json(res, 202, { ok: true, queryId: sourceResult.resultId, session: publicOpenLookupSession(session) });
    }

    const openLookupEndMatch = url.pathname.match(/^\/api\/v1\/open\/name-lookups\/sessions\/([^/]+)\/end$/);
    if (req.method === "POST" && openLookupEndMatch) {
      const { ctx } = await readSignedOpenJson(req, url, OPEN_NAME_LOOKUP_CLIENTS);
      const session = openNameLookupSession(ctx.clientId, openLookupEndMatch[1]);
      if (!session) return json(res, 404, { error: "lookup_session_not_found" });
      if (["ended", "failed", "expired"].includes(session.status)) return json(res, 200, { ok: true, session: publicOpenLookupSession(session) });
      const pending = session.pendingJobId ? state.automationJobs.find((job) => job.jobId === session.pendingJobId) : null;
      const pendingWindowsTask = pending ? state.windowsTasks.find((task) => task.taskId === pending.windowsTaskId) : null;
      if (pending && isActiveAutomationStatus(pending.status)) {
        cancelAutomationJob(pending, "session_stopping", { releaseLock: false });
        if (pending.kind === "alipay_name_query") {
          upsertLookupResult(session, pending, {
            status: "cancelling",
            stage: "正在停止当前查询",
            error: "",
            updatedAt: nowIso()
          });
        }
      }
      const cancelledQueuedJobs = cancelQueuedOpenLookupQueries(session, "session_stopping");
      const device = repos.devices.findById(session.deviceId);
      let job = null;
      let windowsTask = null;
      if (!device || !isAdbOnline(device)) {
        session.results = (session.results || []).map((result) => result.status === "cancelling"
          ? { ...result, status: "cancelled", stage: "查询已取消", error: "会话已结束", updatedAt: nowIso() }
          : result);
        finishLookupSession(session, "ended", "device_offline_on_stop");
      } else {
        job = createAutomationJob({ kind: "alipay_name_stop", userId: session.userId, deviceId: session.deviceId, sessionId: session.sessionId });
        Object.assign(job, { source: "open-api", clientId: ctx.clientId });
        session.status = "stopping";
        session.pendingJobId = job.jobId;
        session.updatedAt = nowIso();
        windowsTask = queueAutomationWindowsTask(device, job);
      }
      const deviceLock = (state.deviceLocks || []).find((lock) => lock.lockId === session.lockId) || null;
      const audit = addAudit("open_name_lookup_session_end", ctx, { sessionId: session.sessionId, deviceId: session.deviceId });
      await persistencePolicy.persist(() => structuredRepos.persistTaskMutation({ windowsTask, automationJob: job, automationJobs: [...cancelledQueuedJobs, ...(pending ? [pending] : [])], windowsTasks: pendingWindowsTask ? [pendingWindowsTask] : [], automationSession: session, deviceLock, audit }));
      return json(res, 202, { ok: true, session: publicOpenLookupSession(session) });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/v1/overview") {
    const ctx = requireAuth(req, ["admin"]);
    const changed = [expireSmsOrders(), expireWindowsTasks(), expireXhsTasks()].some(Boolean);
    if (changed) runtimeSaveScheduler.mark();
    return json(res, 200, { overview: buildOverview(), actor: ctx.name });
  }

  if (req.method === "GET" && url.pathname === "/api/v1/users") {
    requireAuth(req, ["admin"]);
    return json(res, 200, { users: state.users.map(publicUser) });
  }

  if (req.method === "POST" && url.pathname === "/api/v1/users") {
    const ctx = requireAuth(req, ["admin"]);
    const input = await readJson(req);
    const user = createUser(input);
    const audit = addAudit("user_create", ctx, { userId: user.userId, username: user.username, role: user.role });
    await persistencePolicy.persist(() => structuredRepos.persistAuthMutation({ user, audit }));
    return json(res, 201, { ok: true, user: publicUser(user) });
  }

  const userUpdateMatch = url.pathname.match(/^\/api\/v1\/users\/([^/]+)$/);
  if (req.method === "PUT" && userUpdateMatch) {
    const ctx = requireAuth(req, ["admin"]);
    const input = await readJson(req);
    const user = state.users.find((item) => item.userId === userUpdateMatch[1]);
    if (!user) return json(res, 404, { error: "user_not_found" });
    updateUser(user, input);
    const audit = addAudit("user_update", ctx, { userId: user.userId, username: user.username, role: user.role });
    const sessions = state.sessions.filter((session) => session.userId === user.userId);
    await persistencePolicy.persist(() => structuredRepos.persistAuthMutation({ user, sessions, audit }));
    return json(res, 200, { ok: true, user: publicUser(user) });
  }

  if (req.method === "GET" && url.pathname === "/api/v1/diagnostics") {
    requireAuth(req, ["admin"]);
    return json(res, 200, { diagnostics: await buildDiagnostics() });
  }

  if (req.method === "GET" && url.pathname === "/api/v1/workflow-scripts") {
    requireAuth(req, ["admin"]);
    return json(res, 200, { scripts: [publicWorkflowScriptConfig(getStoredWorkflowScriptConfig(XHS_QR_DEFAULT_SCRIPT_ID))] });
  }

  const workflowScriptMatch = url.pathname.match(/^\/api\/v1\/workflow-scripts\/([^/]+)$/);
  if (req.method === "PUT" && workflowScriptMatch) {
    const ctx = requireAuth(req, ["admin"]);
    const scriptId = decodeURIComponent(workflowScriptMatch[1]);
    if (scriptId !== XHS_QR_DEFAULT_SCRIPT_ID) return json(res, 404, { error: "workflow_script_not_found" });
    const input = await readJson(req);
    const current = getStoredWorkflowScriptConfig(scriptId);
    const script = normalizeWorkflowScriptConfig({ ...current, ...input, scriptId }, "app1");
    script.updatedAt = nowIso();
    script.updatedBy = ctx.username || ctx.name || ctx.role;
    state.workflowScripts[scriptId] = script;
    addAudit("workflow_script_update", ctx, { scriptId, version: script.version, enabled: script.enabled, confirmWaitMs: script.confirmWaitMs });
    await saveState();
    return json(res, 200, { ok: true, script: publicWorkflowScriptConfig(script) });
  }

  if (req.method === "POST" && url.pathname === "/api/v1/maintenance/prune") {
    const ctx = requireAuth(req, ["admin"]);
    const input = await readJson(req);
    const result = pruneState({ dryRun: Boolean(input.dryRun) });
    if (!input.dryRun) {
      await runEvidenceStorageCleanup();
      addAudit("maintenance_prune", ctx, result.removed);
      await saveState();
    }
    return json(res, 200, { ok: true, result });
  }

  if (req.method === "GET" && url.pathname === "/api/v1/device-locks") {
    requireAuth(req, ["admin"]);
    if (expireDeviceLocks()) runtimeSaveScheduler.mark();
    return json(res, 200, { locks: (state.deviceLocks || []).slice(0, 300).map(publicAdminDeviceLock) });
  }

  const releaseLockMatch = url.pathname.match(/^\/api\/v1\/device-locks\/([^/]+)\/release$/);
  if (req.method === "POST" && releaseLockMatch) {
    const ctx = requireAuth(req, ["admin"]);
    const lock = (state.deviceLocks || []).find((item) => item.lockId === releaseLockMatch[1]);
    if (!lock) return json(res, 404, { error: "lock_not_found" });
    const task = state.xhsQrTasks.find((item) => item.taskId === lock.taskId);
    if (lock.status === "active") {
      lock.status = "released";
      lock.releasedAt = nowIso();
      lock.updatedAt = lock.releasedAt;
      lock.releaseReason = "manual_release";
      releaseRuntimeDeviceLock(lock);
    }
    if (task && isActiveXhsTask(task)) {
      task.status = "cancelled";
      task.result = { ...(task.result || {}), error: "manual_lock_release", message: "管理员手动释放设备锁，任务已取消" };
      task.completedAt = nowIso();
      task.updatedAt = task.completedAt;
      if (!Array.isArray(task.events)) task.events = [];
      task.events.push({
        eventId: newId(),
        phase: "lock_release",
        level: "warn",
        message: "管理员手动释放设备锁，扫码任务已取消",
        detail: { lockId: lock.lockId },
        createdAt: nowIso()
      });
      cancelLinkedWindowsTask(task, ctx);
    }
    addAudit("device_lock_manual_release", ctx, { lockId: lock.lockId, taskId: lock.taskId || "", deviceId: lock.deviceId || "" });
    await saveState();
    return json(res, 200, { ok: true, lock: publicAdminDeviceLock(lock), task: task ? publicAdminXhsTask(task) : null });
  }

  if (req.method === "GET" && url.pathname === "/api/v1/metrics/operations") {
    requireAuth(req, ["admin"]);
    const changed = [recoverStalledTasks(), expireWindowsTasks(), expireXhsTasks(), expireDeviceLocks()].some(Boolean);
    if (changed) runtimeSaveScheduler.mark();
    return json(res, 200, { metrics: buildOperationsMetrics() });
  }

  const evidenceMatch = url.pathname.match(/^\/api\/v1\/evidence\/([^/]+)$/);
  if (req.method === "GET" && evidenceMatch) {
    const evidenceId = decodeURIComponent(evidenceMatch[1]);
    if (!verifyEvidenceSignature(
      evidenceId,
      url.searchParams.get("expires") || "",
      url.searchParams.get("sig") || ""
    )) {
      requireAuth(req, ["admin"]);
    }
    return await serveEvidenceAsset(res, evidenceId);
  }

  const taskProgressMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/progress$/);
  if (req.method === "GET" && taskProgressMatch) {
    const ctx = requireAuth(req, ["user", "admin"]);
    const taskId = decodeURIComponent(taskProgressMatch[1]);
    const task = state.xhsQrTasks.find((item) => item.taskId === taskId);
    if (!task) return json(res, 404, { error: "task_not_found" });
    if (ctx.role !== "admin" && task.userId !== ctx.userId) return json(res, 404, { error: "task_not_found" });
    const progress = await getTaskProgress(taskId);
    return json(res, 200, { progress: progress || taskProgressFromTask(task) });
  }

  if (req.method === "GET" && url.pathname === "/api/v1/user/phones") {
    requireAuth(req, ["user", "admin"]);
    return json(res, 200, { phones: buildAvailablePhones() });
  }

  if (req.method === "GET" && url.pathname === "/api/v1/lookup-card-statuses") {
    const ctx = requireAuth(req, ["user", "admin"]);
    const devices=state.devices.filter(d=>ctx.role==='admin'||isDeviceListed(d));
    const lookupDevices=new Set((state.deviceLocks||[]).filter(l=>l.status==='active'&&l.lockType==='alipay_name_lookup').map(l=>l.deviceId));
    return json(res,200,{statuses:devices.map(d=>({deviceId:d.deviceId,lookup:lookupDevices.has(d.deviceId)||managedLookup?.reserved(d.deviceId)?deviceOccupancyForViewer(d,ctx)?.lookup||null:null}))});
  }

  if (req.method === "GET" && url.pathname === "/api/v1/user/devices") {
    const ctx = requireAuth(req, ["user", "admin"]);
    const changed = [expireSmsOrders(), expireXhsTasks()].some(Boolean);
    if (changed) runtimeSaveScheduler.mark();
    return json(res, 200, { devices: state.devices.filter(isDeviceListed).map((device) => publicUserDevice(device, ctx)) });
  }

  const userDeviceScreenSessionMatch = url.pathname.match(/^\/api\/v1\/user\/devices\/([^/]+)\/screen-sessions$/);
  if (req.method === "POST" && userDeviceScreenSessionMatch) {
    const ctx = requireAuth(req, ["user", "admin"]);
    const input = await readJson(req);
    const requestedQualityProfile = String(input.qualityProfile || "auto").trim().toLowerCase();
    if (requestedQualityProfile !== "auto" && !SCREEN_QUALITY_PROFILES[requestedQualityProfile]) {
      return json(res, 400, { error: "invalid_screen_quality_profile" });
    }
    screenSessions.expire();
    if (screenSessions.activeCount() >= SCREEN_MAX_CONCURRENT_SESSIONS) {
      return json(res, 409, { error: "screen_capacity_exhausted", capacity: SCREEN_MAX_CONCURRENT_SESSIONS });
    }
    const deviceId = decodeURIComponent(userDeviceScreenSessionMatch[1]);
    const device = repos.devices.findById(deviceId);
    if (!device || !isDeviceListed(device)) return json(res, 404, { error: "device_not_found" });
    if (!isAdbOnline(device) || !hasWindowsAdbBinding(device)) return json(res, 409, { error: "screen_device_offline" });
    if (!screenRelay.agentOnline(device.adb.agentId)) return json(res, 409, { error: "screen_agent_offline" });
    const screenOwnerUserId = screenSessionOwnerId(ctx);
    const conflict = activeDeviceLockForScreenControl(deviceId, screenOwnerUserId, {
      allowAdminOverride: ctx.role === "admin"
    });
    if (conflict) return json(res, 409, { error: "device_busy", detail: publicDeviceLock(conflict) });
    let created;
    try {
      created = screenSessions.create({
        deviceId,
        agentId: device.adb.agentId,
        adbSerial: device.adb.serial,
        userId: screenOwnerUserId,
        requestedQualityProfile,
        mediaTransport: SCREEN_MEDIA_TRANSPORT
      });
    } catch (error) {
      if (error.code === "device_screen_busy") return json(res, 409, { error: error.code, session: error.session });
      throw error;
    }
    // Bind auto-handover only to this authorised manual intervention, never
    // to an unrelated viewer or a later screen session on the same device.
    const humanLookup = state.automationSessions.find((item) => item.deviceId === deviceId
      && (item.userId === ctx.userId || ctx.role === "admin") && lookupHumanChallenge(item));
    if (humanLookup) {
      screenSessions.getMutable(created.session.sessionId).lookupHumanHandover = {
        sessionId: humanLookup.sessionId, challengeId: lookupHumanChallenge(humanLookup)
      };
    }
    acquireDeviceScreenLock(device, created.session, ctx);
    if (!screenRelay.start(created.session)) {
      screenSessions.close(created.session.sessionId, "failed", "Windows 管理器不在线");
      releaseDeviceScreenLock(created.session.sessionId, "agent_offline");
      return json(res, 409, { error: "screen_agent_offline" });
    }
    addAudit("screen_session_create", ctx, { sessionId: created.session.sessionId, deviceId, agentId: created.session.agentId });
    runtimeSaveScheduler.mark();
    const currentSession = screenSessions.get(created.session.sessionId);
    if (currentSession && currentSession.status === "failed") {
      return json(res, 409, {
        error: "screen_start_failed",
        detail: currentSession.statusMessage || "手机画面启动失败",
        session: currentSession
      });
    }
    const responseSession = currentSession || created.session;
    return json(res, 201, {
      ok: true,
      session: responseSession,
      browserToken: created.browserToken,
      media: buildScreenMediaBrowser(responseSession)
    });
  }

  const screenSessionMatch = url.pathname.match(/^\/api\/v1\/screen-sessions\/([^/]+)$/);
  const screenGalleryImportMatch = url.pathname.match(/^\/api\/v1\/screen-sessions\/([^/]+)\/gallery-imports$/);
  if (req.method === "POST" && screenGalleryImportMatch) {
    const ctx = requireAuth(req, ["user", "admin"]);
    const sessionId = decodeURIComponent(screenGalleryImportMatch[1]);
    const session = screenSessions.get(sessionId);
    const sessionCtx = { ...ctx, userId: screenSessionOwnerId(ctx) };
    if (!session || !canQueueScreenGalleryImport(session, sessionCtx)) {
      return json(res, 404, { error: "screen_session_not_found" });
    }
    const device = repos.devices.findById(session.deviceId);
    if (!device || !isAdbOnline(device) || !hasWindowsAdbBinding(device)) {
      return json(res, 409, { error: "screen_device_offline" });
    }
    const existing = state.windowsTasks.find((task) => (
      task.type === "screen_gallery_import"
      && task.payload?.screenSessionId === sessionId
      && ["queued", "running"].includes(task.status)
    ));
    if (existing) return json(res, 409, { error: "screen_gallery_import_busy", task: publicScreenGalleryImportTask(existing) });

    const input = await readJson(req);
    const imageDataUrl = normalizeImageDataUrl(input.imageDataUrl, "imageDataUrl");
    const task = createWindowsAgentTask({
      agentId: session.agentId,
      adbSerial: session.adbSerial,
      deviceId: session.deviceId,
      type: "screen_gallery_import",
      payload: {
        screenSessionId: sessionId,
        imageDataUrl
      }
    });
    const audit = addAudit("screen_gallery_import_create", ctx, { sessionId, taskId: task.taskId, deviceId: session.deviceId });
    await persistencePolicy.persist(() => structuredRepos.persistTaskMutation({ windowsTask: task, audit }));
    return json(res, 201, { ok: true, task: publicScreenGalleryImportTask(task) });
  }

  const screenGalleryImportTaskMatch = url.pathname.match(/^\/api\/v1\/screen-sessions\/([^/]+)\/gallery-imports\/([^/]+)$/);
  if (req.method === "GET" && screenGalleryImportTaskMatch) {
    const ctx = requireAuth(req, ["user", "admin"]);
    const sessionId = decodeURIComponent(screenGalleryImportTaskMatch[1]);
    const session = screenSessions.get(sessionId);
    const sessionCtx = { ...ctx, userId: screenSessionOwnerId(ctx) };
    if (!session || !canQueueScreenGalleryImport(session, sessionCtx)) {
      return json(res, 404, { error: "screen_session_not_found" });
    }
    const task = repos.windowsTasks.findById(decodeURIComponent(screenGalleryImportTaskMatch[2]));
    if (!task || task.type !== "screen_gallery_import" || task.payload?.screenSessionId !== sessionId) {
      return json(res, 404, { error: "screen_gallery_import_not_found" });
    }
    return json(res, 200, { task: publicScreenGalleryImportTask(task) });
  }

  if (req.method === "GET" && screenSessionMatch) {
    const ctx = requireAuth(req, ["user", "admin"]);
    const session = screenSessions.get(decodeURIComponent(screenSessionMatch[1]));
    if (!session || !screenSessions.canAccess(session, ctx)) return json(res, 404, { error: "screen_session_not_found" });
    return json(res, 200, { session });
  }

  if (req.method === "DELETE" && screenSessionMatch) {
    const ctx = requireAuth(req, ["user", "admin"]);
    const session = screenSessions.get(decodeURIComponent(screenSessionMatch[1]));
    if (!session || !screenSessions.canAccess(session, ctx)) return json(res, 404, { error: "screen_session_not_found" });
    screenRelay.stop(session.sessionId, "user_closed");
    addAudit("screen_session_close", ctx, { sessionId: session.sessionId, deviceId: session.deviceId });
    runtimeSaveScheduler.mark();
    return json(res, 200, { ok: true, session: screenSessions.get(session.sessionId) });
  }

  const userDeviceSmsLibraryMatch = url.pathname.match(/^\/api\/v1\/user\/devices\/([^/]+)\/sms-library$/);
  if (req.method === "GET" && userDeviceSmsLibraryMatch) {
    const ctx = requireAuth(req, ["user", "admin"]);
    const deviceId = decodeURIComponent(userDeviceSmsLibraryMatch[1]);
    const device = repos.devices.findById(deviceId);
    if (!device) return json(res, 404, { error: "device_not_found" });
    if (!isDeviceListed(device)) return json(res, 404, { error: "device_not_found" });
    const box = normalizeSmsBox(url.searchParams.get("box") || "all");
    const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
    const slotIndex = String(url.searchParams.get("slotIndex") || "").trim();
    const codeOnly = ["1", "true", "yes"].includes(String(url.searchParams.get("codeOnly") || "").toLowerCase());
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 20)));
    const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
    let visibility = ctx.role === "admin" ? "admin_preview" : "device_sms_library";
    let messages = smsMessagesForDevice(deviceId);
    if (ctx.role === "admin") {
      addAudit("admin_user_sms_library_preview", ctx, { deviceId, q: q ? "[filtered]" : "", box, slotIndex, codeOnly });
      scheduleStateSave();
    }
    if (box !== "all") messages = messages.filter((item) => item.box === box);
    if (slotIndex) messages = messages.filter((item) => String(effectiveSmsSlotIndex(item) ?? "") === slotIndex);
    if (codeOnly) messages = messages.filter((item) => item.code);
    if (q) {
      messages = messages.filter((item) => {
        return String(item.address || "").toLowerCase().includes(q)
          || String(item.body || "").toLowerCase().includes(q)
          || String(item.phoneNumber || "").toLowerCase().includes(q)
          || String(item.code || "").toLowerCase().includes(q);
      });
    }
    return json(res, 200, {
      device: publicUserDevice(device, ctx),
      total: messages.length,
      visibility,
      limit,
      offset,
      messages: messages.slice(offset, offset + limit).map((message) => ({
        ...publicSmsMessage(message),
        visibility,
        redacted: false
      }))
    });
  }

  const userDeviceSmsRefreshMatch = url.pathname.match(/^\/api\/v1\/user\/devices\/([^/]+)\/sms-library\/refresh$/);
  if (req.method === "POST" && userDeviceSmsRefreshMatch) {
    const ctx = requireAuth(req, ["user", "admin"]);
    const input = await readJson(req);
    const deviceId = decodeURIComponent(userDeviceSmsRefreshMatch[1]);
    const device = repos.devices.findById(deviceId);
    if (!device || !isDeviceListed(device)) return json(res, 404, { error: "device_not_found" });
    if (!isAdbOnline(device) || !hasWindowsAdbBinding(device)) {
      return json(res, 409, { error: "sms_refresh_unavailable" });
    }
    const rate = checkUserSmsRefreshRate(ctx.userId, deviceId, input.source);
    if (!rate.ok) {
      return json(res, 429, {
        error: "sms_refresh_too_frequent",
        retryAfterSeconds: Math.max(1, Math.ceil(rate.retryAfterMs / 1000))
      });
    }
    const task = findActiveSmsSyncTask(device) || createWindowsAgentTask({
      agentId: device.adb.agentId,
      adbSerial: device.adb.serial,
      deviceId,
      type: "sms_sync_now",
      payload: {
        source: input.source || "user_sms_library_refresh",
        requestedBy: ctx.userId,
        requestedAt: nowIso()
      }
    });
    addAudit("user_sms_library_refresh", ctx, { deviceId, taskId: task.taskId, agentId: task.agentId });
    await saveState();
    return json(res, 202, {
      ok: true,
      cooldownSeconds: Math.ceil(USER_SMS_REFRESH_COOLDOWN_MS / 1000),
      task: publicWindowsTask(task)
    });
  }

  if (req.method === "GET" && url.pathname === "/api/v1/user/sms-orders") {
    const ctx = requireAuth(req, ["user", "admin"]);
    expireSmsOrders();
    ensureWaitingSmsOrderProbes((order) => order.userId === ctx.userId);
    return json(res, 200, { orders: state.smsOrders.filter((order) => order.userId === ctx.userId).slice(0, 100).map(publicUserSmsOrder) });
  }

  if (req.method === "POST" && url.pathname === "/api/v1/user/sms-orders") {
    const ctx = requireAuth(req, ["user", "admin"]);
    const input = await readJson(req);
    const target = resolveSmsOrderTarget(input);
    const phoneNumber = target.phoneNumber;
    if (!phoneNumber) return json(res, 400, { error: "phoneNumber is required" });
    if (waitingSmsCountForUser(ctx.userId) >= USER_MAX_WAITING_SMS) return json(res, 429, { error: "user_waiting_sms_limit_reached", limit: USER_MAX_WAITING_SMS });
    if (!buildAvailablePhones().some((phone) => phone.phoneNumber === phoneNumber)) return json(res, 409, { error: "phone_not_available" });
    const order = createSmsOrder({ ...target, platform: input.platform || "小红书", userId: ctx.userId, source: "user" });
    addAudit("user_sms_order_create", ctx, { phoneNumber, platform: order.platform, orderId: order.orderId });
    await saveState();
    return json(res, 201, { ok: true, order: publicUserSmsOrder(order) });
  }

  if (req.method === "POST" && url.pathname === "/api/v1/third-party/sms-orders") {
    const ctx = requireAuth(req, ["user", "admin"]);
    const input = await readJson(req);
    const target = resolveSmsOrderTarget(input);
    if (!target.phoneNumber && !target.deviceId) return json(res, 400, { error: "phoneNumber or deviceId is required" });
    if (target.deviceId) {
      const device = repos.devices.findById(target.deviceId);
      if (!device) return json(res, 404, { error: "device_not_found" });
      if (!isDeviceListed(device)) return json(res, 409, { error: "device_not_published" });
      if (!isDeviceUsable(device)) return json(res, 409, { error: "device_not_available" });
    }
    const order = createSmsOrder({
      ...target,
      platform: input.platform || "第三方平台",
      userId: ctx.role === "user" ? ctx.userId : input.userId || "",
      source: "third-party"
    });
    addAudit("third_party_sms_order_create", ctx, { orderId: order.orderId, deviceId: order.deviceId, phoneNumber: order.phoneNumber });
    await saveState();
    return json(res, 201, { ok: true, legacy: true, migration: "use /api/v1/open/sms-code-requests", order: publicUserSmsOrder(order) });
  }

  const thirdPartySmsOrderMatch = url.pathname.match(/^\/api\/v1\/third-party\/sms-orders\/([^/]+)$/);
  if (req.method === "GET" && thirdPartySmsOrderMatch) {
    const ctx = requireAuth(req, ["user", "admin"]);
    const expired = expireSmsOrders();
    const order = state.smsOrders.find((item) => item.orderId === thirdPartySmsOrderMatch[1]);
    if (!order || (ctx.role === "user" && order.userId !== ctx.userId)) return json(res, 404, { error: "sms_order_not_found" });
    const probeQueued = Boolean(queueSmsOrderProbe(order));
    if (expired || probeQueued) runtimeSaveScheduler.mark();
    return json(res, 200, { order: publicUserSmsOrder(order) });
  }

  const userSmsOrderCancelMatch = url.pathname.match(/^\/api\/v1\/user\/sms-orders\/([^/]+)\/cancel$/);
  if (req.method === "POST" && userSmsOrderCancelMatch) {
    const ctx = requireAuth(req, ["user", "admin"]);
    const order = state.smsOrders.find((item) => item.orderId === userSmsOrderCancelMatch[1] && item.userId === ctx.userId);
    if (!order) return json(res, 404, { error: "sms_order_not_found" });
    if (order.status !== "waiting") return json(res, 409, { error: "sms_order_not_cancellable" });
    order.status = "cancelled";
    order.updatedAt = nowIso();
    addAudit("user_sms_order_cancel", ctx, { orderId: order.orderId, phoneNumber: order.phoneNumber });
    await saveState();
    return json(res, 200, { ok: true, order: publicUserSmsOrder(order) });
  }

  if (req.method === "GET" && url.pathname === "/api/v1/user/xhs/qr-scan-tasks") {
    const ctx = requireAuth(req, ["user", "admin"]);
    if (expireXhsTasks()) runtimeSaveScheduler.mark();
    return json(res, 200, { tasks: state.xhsQrTasks.filter((task) => task.userId === ctx.userId).slice(0, 100).map(publicUserXhsTask) });
  }

  if (req.method === "POST" && url.pathname === "/api/v1/user/xhs/qr-scan-tasks") {
    const ctx = requireAuth(req, ["user", "admin"]);
    const input = await readJson(req);
    const qrImageDataUrl = normalizeQrImageDataUrl(input.qrImageDataUrl);
    expireXhsTasks();
    if (activeXhsTaskCountForUser(ctx.userId) >= USER_MAX_ACTIVE_XHS_TASKS) return json(res, 429, { error: "user_active_xhs_task_limit_reached", limit: USER_MAX_ACTIVE_XHS_TASKS });
    const target = pickXhsTarget(input.deviceId, input.xhsAppSlot, { requireListed: true });
    if (!target) {
      const conflict = xhsTaskConflictForRequest(input.deviceId, input.xhsAppSlot);
      if (conflict) return json(res, 409, conflict);
      return json(res, 409, { error: "xhs_device_not_available", detail: "当前没有可用的小红书扫码手机" });
    }
    const task = createXhsQrTask({
      deviceId: target.device.deviceId,
      xhsAppSlot: target.account.appSlot,
      xhsAccountLabel: target.account.label,
      xhsAccountId: target.account.xhsId,
      xhsAccountName: target.account.accountName,
      qrImageDataUrl,
      userId: ctx.userId,
      source: "user"
    });
    const deviceLock = acquireDeviceTaskLock(target.device, task, ctx);
    const windowsTask = queueXhsAirtestWindowsTask(target.device, task, ctx);
    const audit = addAudit("user_xhs_qr_task_create", ctx, { deviceId: task.deviceId, xhsAppSlot: task.xhsAppSlot, taskId: task.taskId });
    await persistencePolicy.persist(() => structuredRepos.persistTaskMutation({ windowsTask, xhsTask: task, deviceLock, audit }));
    return json(res, 201, { ok: true, task: publicUserXhsTask(task) });
  }

  const userXhsTaskCancelMatch = url.pathname.match(/^\/api\/v1\/user\/xhs\/qr-scan-tasks\/([^/]+)\/cancel$/);
  if (req.method === "POST" && userXhsTaskCancelMatch) {
    const ctx = requireAuth(req, ["user", "admin"]);
    const task = state.xhsQrTasks.find((item) => item.taskId === userXhsTaskCancelMatch[1] && item.userId === ctx.userId);
    if (!task) return json(res, 404, { error: "xhs_task_not_found" });
    if (!["queued", "running"].includes(task.status)) return json(res, 409, { error: "xhs_task_not_cancellable" });
    task.status = "cancelled";
    task.updatedAt = nowIso();
    task.completedAt = nowIso();
    releaseDeviceTaskLock(task, "cancelled");
    cancelLinkedWindowsTask(task, ctx);
    addAudit("user_xhs_qr_task_cancel", ctx, { taskId: task.taskId, deviceId: task.deviceId });
    await saveState();
    return json(res, 200, { ok: true, task: publicUserXhsTask(task) });
  }

  if (url.pathname === "/api/v1/user/automation/xhs-data-tasks" && ["GET", "POST"].includes(req.method)) {
    const ctx = requireAuth(req, ["user", "admin"]);
    if (expireAutomationJobs()) runtimeSaveScheduler.mark();
    if (req.method === "GET") {
      return json(res, 200, { tasks: state.automationJobs
        .filter((job) => job.kind === "xhs_data_collect" && job.userId === ctx.userId)
        .slice(0, 30).map(publicDataCollectionJobSummary) });
    }
    const input = await readJson(req);
    if (!["app1", "app2"].includes(input.xhsAppSlot)) return json(res, 400, { error: "invalid_xhs_app_slot" });
    const device = state.devices.find((item) => item.deviceId === input.deviceId);
    if (!device || !isDeviceListed(device) || !hasWindowsAdbBinding(device) || !isAdbOnline(device)) {
      return json(res, 409, { error: "device_not_available" });
    }
    const account = (device.xhsAccounts || []).find((item) => item.appSlot === input.xhsAppSlot && item.enabled !== false);
    if (!account) return json(res, 409, { error: "xhs_account_slot_not_available" });
    const agent = state.windowsAgents.find((item) => item.agentId === device.adb.agentId);
    if (!hasXhsDataCollectionCapability(agent)) return json(res, 409, { error: "xhs_data_agent_update_required" });
    const conflict = activeDeviceLockForTask(device.deviceId);
    if (conflict) return json(res, 409, { error: "device_busy", conflict: publicDeviceLock(conflict) });
    const job = createAutomationJob({ kind: "xhs_data_collect", userId: ctx.userId,
      deviceId: device.deviceId, xhsAppSlot: account.appSlot, xhsAccountLabel: account.label,
      xhsAccountId: account.xhsId, xhsAccountName: account.accountName, title: "小红书数据采集" });
    const lock = acquireAutomationDeviceLock(device, job, ctx, { ttlMs: XHS_DATA_COLLECTION_TTL_MS });
    const windowsTask = queueAutomationWindowsTask(device, job);
    const audit = addAudit("user_xhs_data_collect_create", ctx, { jobId: job.jobId, deviceId: job.deviceId, xhsAppSlot: job.xhsAppSlot });
    pendingXhsCollectionCommits.add(windowsTask);
    try {
      await persistencePolicy.persist(() => structuredRepos.persistTaskMutation({ windowsTask, automationJob: job, deviceLock: lock, audit }));
    } catch (error) {
      cancelAutomationJob(job, "collection_persistence_failed");
      runtimeSaveScheduler.mark();
      throw error;
    } finally {
      pendingXhsCollectionCommits.delete(windowsTask);
    }
    return json(res, 201, { ok: true, task: publicAutomationJob(job) });
  }

  const dataDetailMatch = url.pathname.match(/^\/api\/v1\/user\/automation\/xhs-data-tasks\/([^/]+)$/);
  if (req.method === "GET" && dataDetailMatch) {
    const ctx = requireAuth(req, ["user", "admin"]);
    if (expireAutomationJobs()) runtimeSaveScheduler.mark();
    const job = state.automationJobs.find((item) => item.jobId === dataDetailMatch[1] && item.userId === ctx.userId && item.kind === "xhs_data_collect");
    if (!job) return json(res, 404, { error: "automation_job_not_found" });
    return json(res, 200, { task: publicAutomationJob(job) });
  }

  const dataCancelMatch = url.pathname.match(/^\/api\/v1\/user\/automation\/xhs-data-tasks\/([^/]+)\/cancel$/);
  if (req.method === "POST" && dataCancelMatch) {
    const ctx = requireAuth(req, ["user", "admin"]);
    const job = state.automationJobs.find((item) => item.jobId === dataCancelMatch[1] && item.userId === ctx.userId && item.kind === "xhs_data_collect");
    if (!job) return json(res, 404, { error: "automation_job_not_found" });
    if (!isActiveAutomationStatus(job.status)) return json(res, 409, { error: "automation_job_not_cancellable" });
    cancelAutomationJob(job, "cancelled");
    const windowsTask = state.windowsTasks.find((item) => item.taskId === job.windowsTaskId) || null;
    const deviceLock = state.deviceLocks.find((item) => item.lockId === job.lockId) || null;
    const audit = addAudit("user_xhs_data_collect_cancel", ctx, { jobId: job.jobId, deviceId: job.deviceId });
    await persistencePolicy.persist(() => structuredRepos.persistTaskMutation({ windowsTask, automationJob: job, deviceLock, audit }));
    return json(res, 200, { ok: true, task: publicAutomationJob(job) });
  }

  if (req.method === "GET" && url.pathname === "/api/v1/user/automation/xhs-publish-tasks") {
    const ctx = requireAuth(req, ["user", "admin"]);
    if (expireAutomationJobs()) runtimeSaveScheduler.mark();
    return json(res, 200, {
      tasks: state.automationJobs
        .filter((job) => job.kind === "xhs_publish" && job.userId === ctx.userId)
        .slice(0, 100)
        .map(publicAutomationJob)
    });
  }

  if (req.method === "POST" && url.pathname === "/api/v1/user/automation/xhs-publish-tasks") {
    const ctx = requireAuth(req, ["user", "admin"]);
    const input = await readJson(req);
    if (expireAutomationJobs()) runtimeSaveScheduler.mark();
    const title = String(input.title || "").trim();
    const content = String(input.content || "").trim();
    if (!title) return json(res, 400, { error: "publish_title_required" });
    if (title.length > 100) return json(res, 400, { error: "publish_title_too_long", limit: 100 });
    if (!content) return json(res, 400, { error: "publish_content_required" });
    if (content.length > 2000) return json(res, 400, { error: "publish_content_too_long", limit: 2000 });
    const rawImages = Array.isArray(input.imageDataUrls) ? input.imageDataUrls : [];
    if (!rawImages.length) return json(res, 400, { error: "publish_image_required" });
    if (rawImages.length > MAX_PUBLISH_IMAGES) return json(res, 400, { error: "publish_image_limit_reached", limit: MAX_PUBLISH_IMAGES });
    const imageDataUrls = rawImages.map((value, index) => normalizeImageDataUrl(value, `imageDataUrls[${index}]`));
    const target = pickXhsTarget(input.deviceId, input.xhsAppSlot, { requireListed: true });
    if (!target) {
      const conflict = xhsTaskConflictForRequest(input.deviceId, input.xhsAppSlot);
      if (conflict) return json(res, 409, conflict);
      return json(res, 409, { error: "xhs_device_not_available", detail: "当前没有可用的小红书发布手机" });
    }
    const job = createAutomationJob({
      kind: "xhs_publish",
      userId: ctx.userId,
      deviceId: target.device.deviceId,
      xhsAppSlot: target.account.appSlot,
      xhsAccountLabel: target.account.label,
      xhsAccountId: target.account.xhsId,
      xhsAccountName: target.account.accountName,
      title,
      content,
      imageDataUrls
    });
    const lock = acquireAutomationDeviceLock(target.device, job, ctx);
    const windowsTask = queueAutomationWindowsTask(target.device, job);
    const audit = addAudit("user_xhs_publish_create", ctx, { jobId: job.jobId, deviceId: job.deviceId, xhsAppSlot: job.xhsAppSlot });
    await persistencePolicy.persist(() => structuredRepos.persistTaskMutation({ windowsTask, automationJob: job, deviceLock: lock, audit }));
    return json(res, 201, { ok: true, task: publicAutomationJob(job), lock: publicDeviceLock(lock), windowsTaskId: windowsTask.taskId });
  }

  const publishCancelMatch = url.pathname.match(/^\/api\/v1\/user\/automation\/xhs-publish-tasks\/([^/]+)\/cancel$/);
  if (req.method === "POST" && publishCancelMatch) {
    const ctx = requireAuth(req, ["user", "admin"]);
    const job = state.automationJobs.find((item) => item.jobId === publishCancelMatch[1] && item.userId === ctx.userId && item.kind === "xhs_publish");
    if (!job) return json(res, 404, { error: "automation_job_not_found" });
    if (!isActiveAutomationStatus(job.status)) return json(res, 409, { error: "automation_job_not_cancellable" });
    cancelAutomationJob(job, "cancelled");
    const windowsTask = state.windowsTasks.find((task) => task.taskId === job.windowsTaskId) || null;
    const deviceLock = (state.deviceLocks || []).find((lock) => lock.lockId === job.lockId) || null;
    const audit = addAudit("user_xhs_publish_cancel", ctx, { jobId: job.jobId, deviceId: job.deviceId });
    await persistencePolicy.persist(() => structuredRepos.persistTaskMutation({ windowsTask, automationJob: job, deviceLock, audit }));
    return json(res, 200, { ok: true, task: publicAutomationJob(job) });
  }

  if (req.method === "GET" && url.pathname === "/api/v1/user/automation/kuaishou-lead-tasks") {
    const ctx = requireAuth(req, ["user", "admin"]);
    if (expireAutomationJobs()) runtimeSaveScheduler.mark();
    return json(res, 200, {
      tasks: state.automationJobs
        .filter((job) => job.kind === "kuaishou_lead" && job.userId === ctx.userId)
        .slice(0, 100)
        .map(publicAutomationJob)
    });
  }

  if (req.method === "POST" && url.pathname === "/api/v1/user/automation/kuaishou-lead-tasks") {
    const ctx = requireAuth(req, ["user", "admin"]);
    const input = await readJson(req);
    if (expireAutomationJobs()) runtimeSaveScheduler.mark();
    let delayRange;
    try {
      delayRange = normalizeKuaishouLeadDelayRange(input.minDelaySeconds, input.maxDelaySeconds);
    } catch {
      return json(res, 400, { error: "invalid_kuaishou_lead_delay_range", min: 30, max: 3600 });
    }
    const device = repos.devices.findById(String(input.deviceId || ""));
    if (!device) return json(res, 404, { error: "device_not_found" });
    if (!isDeviceListed(device)) return json(res, 409, { error: "device_not_published" });
    if (!isAdbOnline(device)) return json(res, 409, { error: "device_not_available" });
    const existing = state.automationJobs.find((job) => job.kind === "kuaishou_lead" && isActiveAutomationStatus(job.status));
    if (existing) {
      return json(res, 409, {
        error: "kuaishou_lead_already_active",
        task: existing.userId === ctx.userId ? publicAutomationJob(existing) : undefined
      });
    }
    const conflict = activeDeviceLockForTask(device.deviceId);
    if (conflict) return json(res, 409, { error: "device_busy", conflict: publicDeviceLock(conflict) });
    const job = createAutomationJob({
      kind: "kuaishou_lead",
      userId: ctx.userId,
      deviceId: device.deviceId,
      ...delayRange
    });
    const lock = acquireAutomationDeviceLock(device, job, ctx, { ttlMs: KUAISHOU_LEAD_LOCK_TTL_MS });
    const windowsTask = queueAutomationWindowsTask(device, job);
    const audit = addAudit("user_kuaishou_lead_start", ctx, {
      jobId: job.jobId,
      deviceId: job.deviceId,
      ...delayRange
    });
    await persistencePolicy.persist(() => structuredRepos.persistTaskMutation({ windowsTask, automationJob: job, deviceLock: lock, audit }));
    return json(res, 201, { ok: true, task: publicAutomationJob(job), lock: publicDeviceLock(lock), windowsTaskId: windowsTask.taskId });
  }

  const kuaishouStopMatch = url.pathname.match(/^\/api\/v1\/user\/automation\/kuaishou-lead-tasks\/([^/]+)\/stop$/);
  if (req.method === "POST" && kuaishouStopMatch) {
    const ctx = requireAuth(req, ["user", "admin"]);
    const job = state.automationJobs.find((item) => item.jobId === kuaishouStopMatch[1] && item.userId === ctx.userId && item.kind === "kuaishou_lead");
    if (!job) return json(res, 404, { error: "automation_job_not_found" });
    if (!isActiveAutomationStatus(job.status)) return json(res, 409, { error: "automation_job_not_stoppable" });
    cancelAutomationJob(job, "user_stopped");
    const windowsTask = state.windowsTasks.find((task) => task.taskId === job.windowsTaskId) || null;
    const deviceLock = (state.deviceLocks || []).find((lock) => lock.lockId === job.lockId) || null;
    const audit = addAudit("user_kuaishou_lead_stop", ctx, { jobId: job.jobId, deviceId: job.deviceId });
    await persistencePolicy.persist(() => structuredRepos.persistTaskMutation({ windowsTask, automationJob: job, deviceLock, audit }));
    return json(res, 200, { ok: true, task: publicAutomationJob(job) });
  }

  if (req.method === "GET" && url.pathname === "/api/v1/user/automation/alipay-name-sessions") {
    const ctx = requireAuth(req, ["user", "admin"]);
    if (expireAutomationJobs()) runtimeSaveScheduler.mark();
    return json(res, 200, {
      sessions: state.automationSessions
        .filter((session) => ctx.role === "admin" || session.userId === ctx.userId)
        .slice(0, 20)
        .map((session) => ({
          ...publicLookupSession(session),
          operatorMode: session.userId === ctx.userId ? "owner" : "admin_override"
        }))
    });
  }

  if (req.method === "POST" && url.pathname === "/api/v1/user/automation/alipay-name-sessions") {
    const ctx = requireAuth(req, ["user", "admin"]);
    const input = await readJson(req);
    if (expireAutomationJobs()) runtimeSaveScheduler.mark();
    const device = repos.devices.findById(String(input.deviceId || ""));
    if (!device) return json(res, 404, { error: "device_not_found" });
    if (!isDeviceListed(device)) return json(res, 409, { error: "device_not_published" });
    if (!isAdbOnline(device)) return json(res, 409, { error: "device_not_available" });
    const conflict = activeDeviceLockForTask(device.deviceId);
    if (conflict) return json(res, 409, { error: "device_busy", conflict: publicDeviceLock(conflict) });
    const existing = state.automationSessions.find((session) => session.userId === ctx.userId && session.deviceId === device.deviceId && ["starting", "ready", "querying", "switching", "choosing_account", "needs_human_verification", "stopping"].includes(session.status));
    if (existing) return json(res, 409, { error: "lookup_session_already_active", session: publicLookupSession(existing) });
    const session = createLookupSession({ userId: ctx.userId, deviceId: device.deviceId });
    const job = createAutomationJob({ kind: "alipay_name_start", userId: ctx.userId, deviceId: device.deviceId, sessionId: session.sessionId });
    session.pendingJobId = job.jobId;
    const lock = acquireAutomationDeviceLock(device, job, ctx, { taskId: session.sessionId, ttlMs: AUTOMATION_SESSION_TTL_MS });
    session.lockId = lock.lockId;
    const windowsTask = queueAutomationWindowsTask(device, job);
    const audit = addAudit("user_alipay_name_session_start", ctx, { sessionId: session.sessionId, deviceId: device.deviceId });
    await persistencePolicy.persist(() => structuredRepos.persistTaskMutation({ windowsTask, automationJob: job, automationSession: session, deviceLock: lock, audit }));
    return json(res, 201, { ok: true, session: publicLookupSession(session) });
  }

  const lookupQueryMatch = url.pathname.match(/^\/api\/v1\/user\/automation\/alipay-name-sessions\/([^/]+)\/queries$/);
  if (req.method === "POST" && lookupQueryMatch) {
    const ctx = requireAuth(req, ["user", "admin"]);
    const input = await readJson(req);
    const session = state.automationSessions.find((item) => item.sessionId === lookupQueryMatch[1] && item.userId === ctx.userId);
    if (!session) return json(res, 404, { error: "lookup_session_not_found" });
    if (session.managedLookupGeneration) return json(res,409,{error:"managed_lookup_use_pool_management"});
    if (session.status !== "ready" || session.pendingJobId) return json(res, 409, { error: "lookup_session_not_ready", session: publicLookupSession(session) });
    if (session.requiresAccountSwitch) return json(res, 409, { error: "lookup_no_available_account", session: publicLookupSession(session) });
    if (resumableLookupRecoveryResult(session)) return json(res, 409, { error: "lookup_recovery_required", session: publicLookupSession(session) });
    if (resumableLookupHumanVerificationResult(session)) {
      return json(res, 409, { error: "lookup_human_verification_required", session: publicLookupSession(session) });
    }
    let phoneNumber;
    try {
      phoneNumber = normalizeLookupPhone(input.phoneNumber);
    } catch {
      return json(res, 400, { error: "invalid_phone_number" });
    }
    const device = repos.devices.findById(session.deviceId);
    if (!device || !isAdbOnline(device)) return json(res, 409, { error: "device_not_available" });
    if (screenSessions.activeForDevice(session.deviceId)) {
      return json(res, 409, { error: "lookup_screen_control_active", session: publicLookupSession(session) });
    }
    const job = createAutomationJob({
      kind: "alipay_name_query",
      userId: ctx.userId,
      deviceId: session.deviceId,
      sessionId: session.sessionId,
      phoneNumber
    });
    session.status = "querying";
    session.pendingJobId = job.jobId;
    session.updatedAt = nowIso();
    upsertLookupResult(session, job, {
      status: "queued",
      stage: "查询任务已提交，等待 Windows 管理器领取",
      createdAt: job.createdAt,
      updatedAt: session.updatedAt
    });
    const windowsTask = queueAutomationWindowsTask(device, job);
    const audit = addAudit("user_alipay_name_query", ctx, { sessionId: session.sessionId, jobId: job.jobId, deviceId: session.deviceId });
    await persistencePolicy.persist(() => structuredRepos.persistTaskMutation({ windowsTask, automationJob: job, automationSession: session, audit }));
    return json(res, 202, { ok: true, job: publicAutomationJob(job), session: publicLookupSession(session) });
  }

  const lookupHumanResumeMatch = url.pathname.match(/^\/api\/v1\/user\/automation\/alipay-name-sessions\/([^/]+)\/resume-after-human-verification$/);
  if (req.method === "POST" && lookupHumanResumeMatch) {
    const ctx = requireAuth(req, ["user", "admin"]);
    const session = state.automationSessions.find((item) => (
      item.sessionId === lookupHumanResumeMatch[1]
      && (item.userId === ctx.userId || ctx.role === "admin")
    ));
    if (!session) return json(res, 404, { error: "lookup_session_not_found" });
    if (session.managedLookupGeneration) return json(res,409,{error:"managed_lookup_use_pool_management"});
    const sourceResult = resumableLookupHumanVerificationResult(session) || resumableLookupRecoveryResult(session);
    if (!sourceResult) return json(res, 409, { error: "lookup_human_verification_not_resumable", session: publicLookupSession(session) });
    if (screenSessions.activeForDevice(session.deviceId)) {
      return json(res, 409, { error: "lookup_screen_control_active", session: publicLookupSession(session) });
    }
    const device = repos.devices.findById(session.deviceId);
    if (!device || !isAdbOnline(device)) return json(res, 409, { error: "device_not_available" });
    const startup = sourceResult.phase === "start";
    const ordinaryRecovery = sourceResult.status === "needs_recovery";
    let phoneNumber;
    try {
      phoneNumber = startup ? "" : normalizeLookupPhone(sourceResult.phoneNumber);
    } catch {
      return json(res, 409, { error: "lookup_human_verification_phone_missing", session: publicLookupSession(session) });
    }
    const job = createAutomationJob({
      kind: startup ? "alipay_name_start" : "alipay_name_query",
      userId: session.userId,
      deviceId: session.deviceId,
      sessionId: session.sessionId,
      phoneNumber,
      resultId: sourceResult.resultId,
      resumeAfterHumanVerification: true,
      restartAfterHumanVerification: ordinaryRecovery
    });
    session.status = startup ? "starting" : "querying";
    session.pendingJobId = job.jobId;
    session.error = "";
    session.updatedAt = nowIso();
    if (startup) session.startupHumanVerification.status = "queued";
    else upsertLookupResult(session, job, {
      status: "queued",
      stage: "等待继续获取当前号码结果",
      error: "",
      updatedAt: session.updatedAt
    });
    const windowsTask = queueAutomationWindowsTask(device, job);
    const audit = addAudit("user_alipay_name_human_verification_resume", ctx, {
      sessionId: session.sessionId,
      jobId: job.jobId,
      sourceResultId: sourceResult.resultId,
      deviceId: session.deviceId
    });
    await persistencePolicy.persist(() => structuredRepos.persistTaskMutation({ windowsTask, automationJob: job, automationSession: session, audit }));
    return json(res, 202, { ok: true, job: publicAutomationJob(job), session: publicLookupSession(session) });
  }

  const lookupEndMatch = url.pathname.match(/^\/api\/v1\/user\/automation\/alipay-name-sessions\/([^/]+)\/end$/);

  const lookupSwitchMatch = url.pathname.match(/^\/api\/v1\/user\/automation\/alipay-name-sessions\/([^/]+)\/switch-account$/);
  if (req.method === "POST" && lookupSwitchMatch) {
    const ctx = requireAuth(req, ["user", "admin"]);
    const input = await readJson(req);
    const session = state.automationSessions.find((item) => item.sessionId === lookupSwitchMatch[1] && item.userId === ctx.userId);
    if (!session) return json(res, 404, { error: "lookup_session_not_found" });
    if (session.managedLookupGeneration) return json(res,409,{error:"managed_lookup_use_pool_management"});
    const requestedAccount = String(input.targetAccount || "").trim();
    const accountAction = requestedAccount ? "select" : "list";
    if (!["ready", "choosing_account"].includes(session.status) || session.pendingJobId) {
      return json(res, 409, { error: "lookup_session_not_ready", session: publicLookupSession(session) });
    }
    if (resumableLookupRecoveryResult(session)) return json(res, 409, { error: "lookup_recovery_required", session: publicLookupSession(session) });
    if (resumableLookupHumanVerificationResult(session)) {
      return json(res, 409, { error: "lookup_human_verification_required", session: publicLookupSession(session) });
    }
    let targetAccount = "";
    if (accountAction === "select") {
      try {
        targetAccount = normalizeLookupAccountChoice(requestedAccount);
      } catch {
        return json(res, 400, { error: "invalid_lookup_account_choice" });
      }
      const choice = (session.accountChoices || []).find((item) => item.account === targetAccount);
      if (!choice) return json(res, 409, { error: "lookup_account_choice_stale", session: publicLookupSession(session) });
      if (choice.current) return json(res, 409, { error: "lookup_account_already_current", session: publicLookupSession(session) });
    }
    const device = repos.devices.findById(session.deviceId);
    if (!device || !isAdbOnline(device)) return json(res, 409, { error: "device_not_available" });
    if (targetAccount && publicLookupAccountCooldowns(device).some((row) => row.account === targetAccount && row.cooling)) {
      return json(res, 409, { error: "lookup_account_cooling", session: publicLookupSession(session) });
    }
    if (screenSessions.activeForDevice(session.deviceId)) {
      return json(res, 409, { error: "lookup_screen_control_active", session: publicLookupSession(session) });
    }
    const job = createAutomationJob({
      kind: "alipay_name_switch",
      userId: ctx.userId,
      deviceId: session.deviceId,
      sessionId: session.sessionId,
      accountAction,
      targetAccount
    });
    session.status = "switching";
    session.pendingJobId = job.jobId;
    if (accountAction === "list") session.accountChoices = [];
    session.updatedAt = nowIso();
    const windowsTask = queueAutomationWindowsTask(device, job);
    const audit = addAudit("user_alipay_name_account_switch", ctx, {
      sessionId: session.sessionId,
      jobId: job.jobId,
      deviceId: session.deviceId,
      accountAction,
      targetAccount
    });
    await persistencePolicy.persist(() => structuredRepos.persistTaskMutation({ windowsTask, automationJob: job, automationSession: session, audit }));
    return json(res, 202, { ok: true, job: publicAutomationJob(job), session: publicLookupSession(session) });
  }

  if (req.method === "POST" && lookupEndMatch) {
    const ctx = requireAuth(req, ["user", "admin"]);
    const session = state.automationSessions.find((item) => item.sessionId === lookupEndMatch[1] && item.userId === ctx.userId);
    if (!session) return json(res, 404, { error: "lookup_session_not_found" });
    if (session.managedLookupGeneration) return json(res,409,{error:"managed_lookup_use_pool_management"});
    if (["ended", "failed", "expired"].includes(session.status)) return json(res, 200, { ok: true, session: publicLookupSession(session) });
    await drainPendingLookupQueryBeforeStop(session);
    const pending = session.pendingJobId ? state.automationJobs.find((job) => job.jobId === session.pendingJobId) : null;
    const pendingWindowsTask = pending ? state.windowsTasks.find((task) => task.taskId === pending.windowsTaskId) : null;
    if (pending && isActiveAutomationStatus(pending.status)) {
      cancelAutomationJob(pending, "session_stopping", { releaseLock: false });
      if (pending.kind === "alipay_name_query") {
        upsertLookupResult(session, pending, {
          status: "cancelling",
          stage: "正在停止当前查询",
          error: "",
          updatedAt: nowIso()
        });
      }
    }
    const device = repos.devices.findById(session.deviceId);
    let job = null;
    let windowsTask = null;
    if (!device || !isAdbOnline(device)) {
      session.results = (session.results || []).map((result) => result.status === "cancelling"
        ? { ...result, status: "cancelled", stage: "查询已取消", error: "会话已结束", updatedAt: nowIso() }
        : result);
      finishLookupSession(session, "ended", "device_offline_on_stop");
    } else {
      job = createAutomationJob({ kind: "alipay_name_stop", userId: ctx.userId, deviceId: session.deviceId, sessionId: session.sessionId });
      session.status = "stopping";
      session.pendingJobId = job.jobId;
      session.updatedAt = nowIso();
      windowsTask = queueAutomationWindowsTask(device, job);
    }
    const deviceLock = (state.deviceLocks || []).find((lock) => lock.lockId === session.lockId) || null;
    const audit = addAudit("user_alipay_name_session_end", ctx, { sessionId: session.sessionId, deviceId: session.deviceId });
    await persistencePolicy.persist(() => structuredRepos.persistTaskMutation({ windowsTask, automationJob: job, automationJobs: pending ? [pending] : [], windowsTasks: pendingWindowsTask ? [pendingWindowsTask] : [], automationSession: session, deviceLock, audit }));
    return json(res, 202, { ok: true, session: publicLookupSession(session) });
  }

  if (req.method === "GET" && url.pathname === "/api/v1/app-release/latest") {
    requireAuth(req, ["admin", "windows", "device"]);
    if (!state.appRelease) return json(res, 404, { error: "app_release_not_found" });
    return json(res, 200, { release: publicAppRelease(state.appRelease) });
  }

  if (req.method === "POST" && url.pathname === "/api/v1/app-release/latest") {
    const ctx = requireAuth(req, ["admin"]);
    const input = await readJson(req);
    const release = upsertAppReleaseMetadata(input);
    addAudit("app_release_metadata_update", ctx, { versionName: release.versionName, versionCode: release.versionCode });
    await saveState();
    return json(res, 200, { ok: true, release: publicAppRelease(release) });
  }

  if (req.method === "PUT" && url.pathname === "/api/v1/app-release/latest/apk") {
    const ctx = requireAuth(req, ["admin"]);
    await fs.mkdir(RELEASE_DIR, { recursive: true });
    const bytes = await readBytes(req, MAX_APK_BYTES);
    if (!bytes.length) return json(res, 400, { error: "apk body is required" });
    const versionCode = Number(url.searchParams.get("versionCode") || state.appRelease?.versionCode || 1);
    const versionName = String(url.searchParams.get("versionName") || state.appRelease?.versionName || "0.1.0");
    const fileName = safeFileName(`phone-agent-${versionCode}-${versionName}.apk`);
    const apkPath = path.join(RELEASE_DIR, fileName);
    await fs.writeFile(apkPath, bytes);
    const release = upsertAppReleaseMetadata({
      versionCode,
      versionName,
      apkFile: fileName,
      sizeBytes: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      publishedAt: nowIso()
    });
    addAudit("app_release_apk_upload", ctx, { versionName, versionCode, sizeBytes: bytes.length });
    await saveState();
    return json(res, 200, { ok: true, release: publicAppRelease(release) });
  }

  if (req.method === "GET" && url.pathname === "/api/v1/app-release/latest/download") {
    requireAuth(req, ["admin", "windows", "device"]);
    if (!state.appRelease?.apkFile) return json(res, 404, { error: "app_release_apk_not_found" });
    const apkPath = path.join(RELEASE_DIR, path.basename(state.appRelease.apkFile));
    let bytes;
    try {
      bytes = await fs.readFile(apkPath);
    } catch (error) {
      if (error.code === "ENOENT") return json(res, 404, { error: "app_release_apk_not_found" });
      throw error;
    }
    res.writeHead(200, {
      "content-type": "application/vnd.android.package-archive",
      "content-length": String(bytes.length),
      "content-disposition": `attachment; filename="${path.basename(state.appRelease.apkFile)}"`,
      "cache-control": "no-store"
    });
    return res.end(bytes);
  }

  if (req.method === "GET" && url.pathname === "/api/v1/windows-agents") {
    requireAuth(req, ["admin"]);
    return json(res, 200, { agents: state.windowsAgents.map(publicWindowsAgent) });
  }

  const agentRuntimeReleaseMatch = url.pathname.match(/^\/api\/v1\/windows-agents\/([^/]+)\/runtime-release\/download$/);
  if (req.method === "GET" && agentRuntimeReleaseMatch) {
    const agentId = decodeURIComponent(agentRuntimeReleaseMatch[1]);
    requireWindowsAgent(req, agentId);
    const release = await readAgentRuntimeRelease(AGENT_RUNTIME_RELEASE_DIR, {
      maxBytes: MAX_AGENT_RUNTIME_RELEASE_BYTES
    });
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-length": String(release.sizeBytes),
      "content-disposition": `attachment; filename="${release.fileName}"`,
      "x-content-sha256": release.sha256,
      "cache-control": "no-store"
    });
    return res.end(release.bytes);
  }

  if (req.method === "POST" && url.pathname === "/api/v1/windows-agents") {
    const ctx = requireAuth(req, ["admin"]);
    const input = await readJson(req);
    const agentId = String(input.agentId || "").trim();
    if (!agentId) return json(res, 400, { error: "agentId is required" });
    if (repos.agents.findById(agentId)) return json(res, 409, { error: "windows_agent_exists" });
    const token = createAgentToken();
    const agent = upsertWindowsAgent({
      agentId,
      agentName: input.agentName || agentId,
      scopes: normalizeAgentScopes(input.scopes),
      tokenHash: hashToken(token),
      tokenPrefix: token.slice(0, 10),
      lastRotatedAt: nowIso(),
      enabled: true
    }, req);
    addAudit("windows_agent_create", ctx, { agentId });
    await saveState();
    return json(res, 201, { ok: true, agent: publicWindowsAgent(agent), token });
  }

  const agentRotateMatch = url.pathname.match(/^\/api\/v1\/windows-agents\/([^/]+)\/token\/rotate$/);
  if (req.method === "POST" && agentRotateMatch) {
    const ctx = requireAuth(req, ["admin"]);
    const agent = repos.agents.findById(decodeURIComponent(agentRotateMatch[1]));
    if (!agent) return json(res, 404, { error: "windows_agent_not_found" });
    const token = createAgentToken();
    agent.tokenHash = hashToken(token);
    agent.tokenPrefix = token.slice(0, 10);
    agent.lastRotatedAt = nowIso();
    agent.revokedAt = "";
    agent.enabled = true;
    agent.updatedAt = nowIso();
    addAudit("windows_agent_token_rotate", ctx, { agentId: agent.agentId });
    await saveState();
    return json(res, 200, { ok: true, agent: publicWindowsAgent(agent), token });
  }

  const agentToggleMatch = url.pathname.match(/^\/api\/v1\/windows-agents\/([^/]+)\/(disable|enable)$/);
  if (req.method === "POST" && agentToggleMatch) {
    const ctx = requireAuth(req, ["admin"]);
    const agent = repos.agents.findById(decodeURIComponent(agentToggleMatch[1]));
    if (!agent) return json(res, 404, { error: "windows_agent_not_found" });
    const action = agentToggleMatch[2];
    agent.enabled = action === "enable";
    agent.revokedAt = action === "disable" ? nowIso() : "";
    agent.updatedAt = nowIso();
    addAudit(`windows_agent_${action}`, ctx, { agentId: agent.agentId });
    await saveState();
    return json(res, 200, { ok: true, agent: publicWindowsAgent(agent) });
  }

  const recoveryControlMatch = url.pathname.match(/^\/api\/v1\/windows-agents\/([^/]+)\/recovery-control$/);
  if (req.method === "POST" && recoveryControlMatch) {
    const ctx = requireAuth(req, ["admin"]);
    const agentId = decodeURIComponent(recoveryControlMatch[1]);
    const agent = repos.agents.findById(agentId);
    if (!agent) return json(res,404,{error:"windows_agent_not_found"});
    if (agent.health?.recoveryControl?.protocol !== RECOVERY_CONTROL_PROTOCOL) return json(res,409,{error:"recovery_control_agent_upgrade_required"});
    const input = await readJson(req);
    const serial = recoverySerial(input.adbSerial);
    if(input.resetIsolation && agent.health?.recoveryControl?.isolationReset!==true)return json(res,409,{error:'recovery_isolation_agent_upgrade_required'});
    if(input.resetIsolation && !(agent.health?.recoveryControl?.isolated||[]).some(x=>x.serial===serial))return json(res,409,{error:'device_recovery_not_isolated'});
    const current = recoveryControls.get(agentId);
    const known = (agent.devices || []).some(d => String(d.adbSerial || d.serial || "").toUpperCase() === serial)
      || (agent.health?.deviceRecovery?.queue || []).some(d => String(d.serial || "").toUpperCase() === serial)
      || state.devices.some(d => d.adb?.agentId === agentId && String(d.adb?.serial || "").toUpperCase() === serial)
      || current.paused.some(d => d.serial === serial);
    if (!known) return json(res,404,{error:"recovery_control_device_not_found"});
    const control = await recoveryControls.set(agentId,{...input,adbSerial:serial});
    addAudit(input.paused ? "device_recovery_pause" : "device_recovery_resume",ctx,{agentId,adbSerial:serial,revision:control.revision});
    runtimeSaveScheduler.mark();
    return json(res,200,{ok:true,control,agent:publicWindowsAgent(agent)});
  }

  if (req.method === "POST" && url.pathname === "/api/v1/windows-agents/heartbeat") {
    const ctx = requireWindowsAgent(req);
    requireWindowsScope(ctx, "heartbeat");
    const input = await readJson(req);
    if (ctx.agent && input.agentId && input.agentId !== ctx.agent.agentId) return json(res, 401, { error: "windows_agent_mismatch" });
    const agent = upsertWindowsAgent(input, req);
    addAudit("windows_agent_heartbeat", ctx, { agentId: agent.agentId });
    runtimeSaveScheduler.mark();
    return json(res, 200, { ok: true, agent: publicWindowsAgent(agent) });
  }

  const syncMatch = url.pathname.match(/^\/api\/v1\/windows-agents\/([^/]+)\/devices\/sync$/);
  if (req.method === "POST" && syncMatch) {
    const agentId = decodeURIComponent(syncMatch[1]);
    const ctx = requireWindowsAgent(req, agentId);
    requireWindowsScope(ctx, "devices:sync");
    const input = await readJson(req);
    const agent = upsertWindowsAgent({ ...(input.agent || {}), agentId }, req);
    syncAdbDevices(agent, input.devices || []);
    addAudit("windows_agent_devices_sync", ctx, { agentId, count: agent.devices.length });
    runtimeSaveScheduler.mark();
    return json(res, 200, { ok: true, agent: publicWindowsAgent(agent), devices: state.devices.map(publicDevice) });
  }

  const humanProbeMatch = url.pathname.match(/^\/api\/v1\/windows-agents\/([^/]+)\/lookup-human-verifications$/);
  if (humanProbeMatch && ["GET", "POST"].includes(req.method)) {
    const agentId = decodeURIComponent(humanProbeMatch[1]);
    const ctx = requireWindowsAgent(req, agentId);
    requireWindowsScope(ctx, req.method === "GET" ? "tasks:read" : "tasks:write");
    if (req.method === "GET") return json(res, 200, { ok: true, probes: lookupHumanHandover.list(agentId) });
    const input = await readJson(req);
    return json(res, 200, { ok: true, ...await lookupHumanHandover.report(agentId, input) });
  }

  const nextTaskMatch = url.pathname.match(/^\/api\/v1\/windows-agents\/([^/]+)\/tasks\/next$/);
  if (req.method === "GET" && nextTaskMatch) {
    const agentId = decodeURIComponent(nextTaskMatch[1]);
    const ctx = requireWindowsAgent(req, agentId);
    requireWindowsScope(ctx, "tasks:read");
    const galleryDeliveryMaintenance = maintainScreenGalleryDeliveries(state.windowsTasks, {
      maxAttemptsByType: {
        screen_gallery_import: SCREEN_GALLERY_DELIVERY_MAX_ATTEMPTS,
        xhs_publish: XHS_PUBLISH_DELIVERY_MAX_ATTEMPTS
      }
    });
    if (galleryDeliveryMaintenance.changed) {
      for (const changedTask of galleryDeliveryMaintenance.tasks) {
        let automationJob = null;
        let deviceLock = null;
        if (changedTask.type === "xhs_publish" && isTerminalStatus(changedTask.status)) {
          const automationJobId = String(changedTask.payload?.automationJobId || "");
          automationJob = state.automationJobs.find((item) => item.jobId === automationJobId) || null;
          deviceLock = automationJob?.lockId
            ? state.deviceLocks.find((item) => item.lockId === automationJob.lockId) || null
            : null;
          syncAutomationJobFromWindowsTask(changedTask, "failed", changedTask.result);
          compactTaskPayload(automationJob);
        }
        compactCompletedTask(changedTask);
        await persistencePolicy.persist(() => structuredRepos.persistTaskMutation({
          windowsTask: changedTask,
          automationJob,
          deviceLock
        }));
      }
    }
    const recoveredTasks = recoverStalledTasks(agentId);
    const expiredTasks = expireWindowsTasks();
    const maintenanceChanged = galleryDeliveryMaintenance.changed || recoveredTasks || expiredTasks;
    const agent = ctx.agent || repos.agents.findById(agentId);
    if (!agent) return json(res, 404, { error: "windows_agent_not_found" });
    const activeTaskIds = new Set(String(url.searchParams.get("activeTaskIds") || "")
      .split(",")
      .map((value) => decodeURIComponent(value).trim())
      .filter(Boolean)
      .slice(0, 32));
    const managedDeliveryV1 = String(url.searchParams.get("managedLookupDelivery") || "") === MANAGED_LOOKUP_PROTOCOL;
    const galleryDeliveryV2 = String(url.searchParams.get("galleryDelivery") || "") === SCREEN_GALLERY_DELIVERY_PROTOCOL;
    const xhsPublishDeliveryV1 = String(url.searchParams.get("xhsPublishDelivery") || "") === XHS_PUBLISH_DELIVERY_PROTOCOL;
    const cancelledTaskIds = state.windowsTasks
      .filter((item) => item.agentId === agentId && item.status === "cancelled" && activeTaskIds.has(item.taskId))
      .map((item) => item.taskId);
    const maxRunning = Math.max(1, Number(agent.maxConcurrentAdbTasks || DEFAULT_AGENT_MAX_CONCURRENT_ADB_TASKS));
    const excludedSerials = new Set(String(url.searchParams.get("excludeSerials") || "")
      .split(",")
      .map((value) => decodeURIComponent(value).trim())
      .filter(Boolean));
    const screenGallerySerials = new Set(String(url.searchParams.get("screenGallerySerials") || "")
      .split(",")
      .map((value) => decodeURIComponent(value).trim())
      .filter(Boolean));
    const runningTasks = state.windowsTasks.filter((item) => item.agentId === agentId && item.status === "running");
    if (runningTasks.length >= maxRunning) {
      if (maintenanceChanged) runtimeSaveScheduler.mark();
      return json(res, 200, { task: null, cancelledTaskIds, capacity: { running: runningTasks.length, max: maxRunning } });
    }
    const runningSerials = new Set(runningTasks.filter((item) => item.adbSerial).map((item) => String(item.adbSerial)));
    const task = state.windowsTasks.find((item) => (
      item.agentId === agentId
      && item.status === "queued"
      && !pendingXhsCollectionCommits.has(item)
      && (!isManagedLookupTask(item) || (managedDeliveryV1 && canDeliverManagedLookupTask(item)))
      && !activeTaskIds.has(item.taskId)
      && !(supportsLeasedWindowsTaskDelivery(item)
        && ((item.type === "screen_gallery_import" && galleryDeliveryV2) || (item.type === "xhs_publish" && xhsPublishDeliveryV1) || isManagedLookupTask(item))
        && hasActiveScreenGalleryDelivery(item))
      && (!item.adbSerial || (
        !runningSerials.has(String(item.adbSerial))
        && (!excludedSerials.has(String(item.adbSerial)) || (
          item.type === "screen_gallery_import"
          && screenGallerySerials.has(String(item.adbSerial))
        ))
      ))
    ));
    if (!task) {
      if (maintenanceChanged) runtimeSaveScheduler.mark();
      return json(res, 200, { task: null, cancelledTaskIds });
    }
    const leasedDeliveryEnabled = (
      isManagedLookupTask(task) ||
      (task.type === "screen_gallery_import" && galleryDeliveryV2)
      || (task.type === "xhs_publish" && xhsPublishDeliveryV1)
    );
    if (leasedDeliveryEnabled) {
      const claimSnapshot = snapshotWindowsTaskClaim(task);
      try {
        const responseTask = issueScreenGalleryDelivery(task, {
          token: newId(),
          leaseMs: task.type === "xhs_publish" ? XHS_PUBLISH_DELIVERY_LEASE_MS : SCREEN_GALLERY_DELIVERY_LEASE_MS
        });
        const audit = addAudit("windows_agent_task_delivery", ctx, {
          agentId,
          taskId: task.taskId,
          type: task.type,
          attempt: task.deliveryAttempts
        });
        await persistencePolicy.persist(() => structuredRepos.persistWindowsTaskDeliveryLease({ windowsTask: task, audit }));
        return json(res, 200, { task: responseTask, cancelledTaskIds });
      } catch (error) {
        restoreWindowsTaskClaim(claimSnapshot);
        throw error;
      }
    }
    const claimSnapshot = snapshotWindowsTaskClaim(task);
    try {
      task.status = "running";
      task.pickedAt = task.pickedAt || nowIso();
      task.updatedAt = nowIso();
      const xhsTask = syncXhsTaskFromWindowsTask(task, "running", { action: "Windows 管理器已领取扫码任务" });
      const automationJob = syncAutomationJobFromWindowsTask(task, "running", { action: "Windows 管理器已领取自动化任务" });
      const automationSession = automationJob?.sessionId ? state.automationSessions.find((item) => item.sessionId === automationJob.sessionId) : null;
      const audit = addAudit("windows_agent_task_pick", ctx, { agentId, taskId: task.taskId, type: task.type });
      const responseTask = publicWindowsTask(task);
      // Gallery images are one-shot delivery payloads; keep only task metadata after pickup.
      if (task.type === "screen_gallery_import" && task.payload?.imageDataUrl) delete task.payload.imageDataUrl;
      if (task.type === "xhs_publish" && task.payload?.imageDataUrls) delete task.payload.imageDataUrls;
      await persistencePolicy.persist(() => structuredRepos.persistTaskMutation({ windowsTask: task, xhsTask, automationJob, automationSession, audit }));
      return json(res, 200, { task: responseTask, cancelledTaskIds });
    } catch (error) {
      restoreWindowsTaskClaim(claimSnapshot);
      throw error;
    }
  }

  const taskPayloadMatch = url.pathname.match(/^\/api\/v1\/windows-agent-tasks\/([^/]+)\/payload$/);
  if (req.method === "POST" && taskPayloadMatch) {
    const ctx = requireWindowsAgent(req);
    requireWindowsScope(ctx, "tasks:read");
    const task = repos.windowsTasks.findById(taskPayloadMatch[1]);
    if (!task) return json(res, 404, { error: "task_not_found" });
    if (!windowsCtxCanAccessTask(ctx, task)) return json(res, 401, { error: "windows_agent_task_mismatch" });
    const input = await readJson(req);
    const delivery = readScreenGalleryDeliveryPayload(task, input.deliveryToken);
    if (!delivery.ok) return json(res, 409, { error: delivery.error });
    return json(res, 200, { ok: true, payload: delivery.payload });
  }

  const taskAckMatch = url.pathname.match(/^\/api\/v1\/windows-agent-tasks\/([^/]+)\/ack$/);
  if (req.method === "POST" && taskAckMatch) {
    const ctx = requireWindowsAgent(req);
    requireWindowsScope(ctx, "tasks:write");
    const task = repos.windowsTasks.findById(taskAckMatch[1]);
    if (!task) return json(res, 404, { error: "task_not_found" });
    if (!windowsCtxCanAccessTask(ctx, task)) return json(res, 401, { error: "windows_agent_task_mismatch" });
    const input = await readJson(req);
    const claimSnapshot = snapshotWindowsTaskClaim(task);
    try {
      const acknowledgement = acknowledgeScreenGalleryDelivery(task, input.deliveryToken);
      if (!acknowledgement.ok) return json(res, 409, { error: acknowledgement.error });
      let automationJob = null;
      let automationSession = null;
      if (!acknowledgement.idempotent && (task.type === "xhs_publish" || isManagedLookupTask(task))) {
        automationJob = syncAutomationJobFromWindowsTask(task, "running", { action: "Windows 管理器已确认接收发布任务" });
        automationSession = automationJob?.sessionId
          ? state.automationSessions.find((item) => item.sessionId === automationJob.sessionId) || null
          : null;
        if (task.payload?.imageDataUrls) delete task.payload.imageDataUrls;
        if (automationJob?.imageDataUrls) delete automationJob.imageDataUrls;
      }
      const audit = acknowledgement.idempotent ? null : addAudit("windows_agent_task_pick", ctx, {
        agentId: task.agentId,
        taskId: task.taskId,
        type: task.type,
        deliveryAttempt: task.deliveryAttempts
      });
      await persistencePolicy.persist(() => structuredRepos.persistTaskMutation({
        windowsTask: task,
        automationJob,
        automationSession,
        audit
      }));
      return json(res, 200, { ok: true, idempotent: acknowledgement.idempotent });
    } catch (error) {
      restoreWindowsTaskClaim(claimSnapshot);
      throw error;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/v1/windows-agent-tasks") {
    const ctx = requireAuth(req, ["admin"]);
    const input = await readJson(req);
    if(managedLookup?.reserved(input.deviceId))return json(res,409,{error:"managed_device_reserved"});
    const agent = repos.agents.findById(input.agentId);
    if (!agent) return json(res, 404, { error: "windows_agent_not_found" });
    const allowed = new Set(["adb_install_apk", "adb_grant_permissions", "adb_start_agent", "adb_collect_diagnostics", "adb_restart_server", "xhs_qr_appium", "xhs_publish", "kuaishou_lead", "alipay_name_start", "alipay_name_query", "alipay_name_switch", "alipay_name_stop", "sms_sync_now"]);
    if (!allowed.has(input.type)) return json(res, 400, { error: "unsupported_task_type" });
    const task = createWindowsAgentTask({
      agentId: input.agentId,
      adbSerial: input.adbSerial,
      deviceId: input.deviceId,
      type: input.type,
      payload: input.payload || {}
    });
    addAudit("windows_agent_task_create", ctx, { agentId: task.agentId, adbSerial: task.adbSerial, type: task.type });
    await saveState();
    return json(res, 201, { ok: true, task: publicWindowsTask(task) });
  }

  if (req.method === "GET" && url.pathname === "/api/v1/windows-agent-tasks") {
    requireAuth(req, ["admin"]);
    const limit = boundedInt(url.searchParams.get("limit"), 50, 1, 200);
    return json(res, 200, { tasks: state.windowsTasks.slice(0, limit).map(publicWindowsTaskSummary), limit, total: state.windowsTasks.length });
  }

  const taskDetailMatch = url.pathname.match(/^\/api\/v1\/windows-agent-tasks\/([^/]+)$/);
  if (req.method === "GET" && taskDetailMatch) {
    requireAuth(req, ["admin"]);
    const task = repos.windowsTasks.findById(taskDetailMatch[1]);
    if (!task) return json(res, 404, { error: "task_not_found" });
    return json(res, 200, { task: publicWindowsTaskAdminDetail(task) });
  }

  const taskStatusMatch = url.pathname.match(/^\/api\/v1\/windows-agent-tasks\/([^/]+)\/status$/);
  if (req.method === "POST" && taskStatusMatch) {
    const ctx = requireWindowsAgent(req);
    requireWindowsScope(ctx, "tasks:write");
    const input = await readJson(req);
    const task = repos.windowsTasks.findById(taskStatusMatch[1]);
    if (!task) return json(res, 404, { error: "task_not_found" });
    if (!windowsCtxCanAccessTask(ctx, task)) return json(res, 401, { error: "windows_agent_task_mismatch" });
    if (isManagedLookupTask(task) && input.managedLookupGeneration !== task.payload.managedLookup.generation) return json(res,409,{error:"managed_lookup_generation_mismatch"});
    if (!["running", "succeeded", "failed", "cancelled"].includes(input.status)) return json(res, 400, { error: "invalid_status" });
    if (isTerminalStatus(task.status)) {
      await taskStatusPersistence.persist(`${task.taskId}:${task.status}`, () => persistencePolicy.persist(() => structuredRepos.persistTaskMutation({ windowsTask: task })));
      return json(res, 200, { ok: true, ignored: true, task: publicWindowsTask(task) });
    }
    const materializedResult = await materializeTaskResultEvidence(input.result || {}, { taskId: task.taskId, eventId: "result" });
    // Evidence materialization can yield while another terminal report wins.
    if (isTerminalStatus(task.status)) {
      await taskStatusPersistence.persist(`${task.taskId}:${task.status}`, () => persistencePolicy.persist(() => structuredRepos.persistTaskMutation({ windowsTask: task })));
      return json(res, 200, { ok: true, ignored: true, task: publicWindowsTask(task) });
    }
    task.result = sanitizeTaskResult(materializedResult, { includeEvidence: true });
    task.status = input.status;
    if (task.type === "xhs_data_collect" && input.status === "succeeded" && task.result.collection?.complete !== true) {
      task.status = "failed";
      task.result.errorCode = "recent_window_not_proven";
      task.result.message = "采集结果尚未证明最近30天完整";
    }
    task.updatedAt = nowIso();
    if (["succeeded", "failed", "cancelled"].includes(task.status)) {
      task.completedAt = nowIso();
      compactCompletedTask(task);
    }
    const xhsTask = syncXhsTaskFromWindowsTask(task, task.status, task.result);
    const automationJob = syncAutomationJobFromWindowsTask(task, task.status, task.result);
    const automationSession = automationJob?.sessionId ? state.automationSessions.find((item) => item.sessionId === automationJob.sessionId) : null;
    let openLookupDispatch = null;
    let cancelledQueuedJobs = [];
    if (["succeeded", "failed", "cancelled"].includes(task.status) && automationSession?.source === "open-api") {
      if (["ended", "failed", "expired"].includes(automationSession.status)) {
        cancelledQueuedJobs = cancelQueuedOpenLookupQueries(automationSession, "lookup_session_terminal");
      } else {
        openLookupDispatch = dispatchNextOpenLookupQuery(automationSession);
      }
    }
    const linkedLockId = String(automationSession?.lockId || automationJob?.lockId || xhsTask?.lockId || "");
    const deviceLock = linkedLockId ? (state.deviceLocks || []).find((item) => item.lockId === linkedLockId) || null : null;
    await taskStatusPersistence.persist(`${task.taskId}:${task.status}`, () => persistencePolicy.persist(() => structuredRepos.persistTaskMutation({
      windowsTask: task,
      windowsTasks: openLookupDispatch?.windowsTask ? [openLookupDispatch.windowsTask] : [],
      device: automationSession ? repos.devices.findById(automationSession.deviceId) : null,
      xhsTask,
      automationJob,
      automationJobs: [...cancelledQueuedJobs, ...(openLookupDispatch?.job ? [openLookupDispatch.job] : [])],
      automationSession,
      deviceLock
    })));
    return json(res, 200, { ok: true, task: publicWindowsTask(task) });
  }

  const taskEventsMatch = url.pathname.match(/^\/api\/v1\/windows-agent-tasks\/([^/]+)\/events$/);
  if (req.method === "GET" && taskEventsMatch) {
    requireAuth(req, ["admin"]);
    const task = repos.windowsTasks.findById(taskEventsMatch[1]);
    if (!task) return json(res, 404, { error: "task_not_found" });
    const includeEvidence = url.searchParams.get("includeEvidence") === "1";
    return json(res, 200, { events: (task.events || []).map((event) => publicWindowsTaskEventSummary(event, { includeEvidence })) });
  }

  if (req.method === "POST" && taskEventsMatch) {
    const ctx = requireWindowsAgent(req);
    requireWindowsScope(ctx, "tasks:write");
    const input = await readJson(req);
    const task = repos.windowsTasks.findById(taskEventsMatch[1]);
    if (!task) return json(res, 404, { error: "task_not_found" });
    if (!windowsCtxCanAccessTask(ctx, task)) return json(res, 401, { error: "windows_agent_task_mismatch" });
    if (task.type === "kuaishou_lead" && input.phase === "heartbeat" && !isTerminalStatus(task.status)) {
      task.updatedAt = nowIso();
      const automationJobId = String(task.payload?.automationJobId || "");
      const automationJob = state.automationJobs.find((job) => job.jobId === automationJobId) || null;
      if (automationJob && isActiveAutomationStatus(automationJob.status)) {
        automationJob.updatedAt = task.updatedAt;
        automationJob.result = {
          ...(automationJob.result || {}),
          progress: {
            ...(automationJob.result?.progress || {}),
            heartbeatAt: task.updatedAt
          }
        };
        renewAutomationLock(automationJob, KUAISHOU_LEAD_LOCK_TTL_MS);
      }
      const deviceLock = automationJob?.lockId
        ? (state.deviceLocks || []).find((lock) => lock.lockId === automationJob.lockId) || null
        : null;
      await persistencePolicy.persist(() => structuredRepos.persistTaskMutation({ windowsTask: task, automationJob, deviceLock }));
      return json(res, 200, { ok: true, heartbeat: true });
    }
    const eventId = newId();
    const materializedEvent = await materializeEventEvidence(input, { taskId: task.taskId, eventId });
    const event = {
      eventId,
      phase: materializedEvent.phase || "log",
      level: materializedEvent.level || "info",
      message: String(materializedEvent.message || "").slice(0, 2000),
      stepId: String(materializedEvent.stepId || "").slice(0, 120),
      stepIndex: Number.isFinite(Number(materializedEvent.stepIndex)) ? Number(materializedEvent.stepIndex) : null,
      errorCode: String(materializedEvent.errorCode || "").slice(0, 120),
      packageName: String(materializedEvent.packageName || "").slice(0, 160),
      currentActivity: String(materializedEvent.currentActivity || "").slice(0, 1000),
      uiSnapshot: String(materializedEvent.uiSnapshot || "").slice(0, MAX_STORED_UI_SNAPSHOT_CHARS),
      uiHierarchy: String(materializedEvent.uiHierarchy || materializedEvent.detail?.uiHierarchy || materializedEvent.uiSnapshot || "").slice(0, MAX_STORED_UI_HIERARCHY_CHARS),
      uiHierarchyEvidence: materializedEvent.uiHierarchyEvidence || null,
      uiHierarchyUrl: String(materializedEvent.uiHierarchyUrl || "").slice(0, 500),
      screenshot: sanitizeScreenshot(materializedEvent.screenshot, { includeDataUrl: true }),
      detail: sanitizeEventDetail(materializedEvent.detail || {}),
      createdAt: nowIso()
    };
    task.events.push(event);
    task.updatedAt = nowIso();
    const xhsTask = appendWindowsEventToXhsTask(task, event);
    const automationJob = appendWindowsEventToAutomationJob(task, event);
    const automationSession = automationJob?.sessionId ? state.automationSessions.find((item) => item.sessionId === automationJob.sessionId) : null;
    await persistencePolicy.persist(() => structuredRepos.persistTaskMutation({
      windowsTask: task,
      xhsTask,
      automationJob,
      automationSession,
      device: automationSession ? repos.devices.findById(automationSession.deviceId) : null,
      events: [{ event, taskId: task.taskId, source: "windows" }]
    }));
    const acknowledgedRestriction = event.stepId === "lookup_account_limit_confirmed"
      && task.payload?.accountCooldownProtocol === 1 && isVerifiedLookupAccountRestrictionEvent(event)
      && automationJob && !isTerminalStatus(automationJob.status)
      && repos.devices.findById(automationSession?.deviceId)?.lookupAccountCooldowns?.some((row) =>
        row.account === event.detail.currentAccount && row.restrictionId === `${automationJob.jobId}:${row.account}`);
    const accountCooldown = acknowledgedRestriction
      ? publicLookupAccountCooldowns(repos.devices.findById(automationSession?.deviceId))
        .find((row) => row.account === event.detail.currentAccount) || null : null;
    return json(res, 201, { ok: true, event, ...(accountCooldown ? { accountCooldown } : {}) });
  }

  if (req.method === "GET" && url.pathname === "/api/v1/devices") {
    requireAuth(req, ["admin"]);
    return json(res, 200, { devices: state.devices.map(publicDevice) });
  }

  const deviceUpdateMatch = url.pathname.match(/^\/api\/v1\/devices\/([^/]+)$/);
  if (req.method === "PUT" && deviceUpdateMatch) {
    const ctx = requireAuth(req, ["admin"]);
    const input = await readJson(req);
    const deviceId = decodeURIComponent(deviceUpdateMatch[1]);
    const device = state.devices.find((item) => item.deviceId === deviceId);
    if (!device) return json(res, 404, { error: "device_not_found" });
    const updates = {};
    if (input.deviceName !== undefined) {
      const deviceName = String(input.deviceName || "").trim();
      if (!deviceName) return json(res, 400, { error: "deviceName is required" });
      if (deviceName.length > 80) return json(res, 400, { error: "deviceName must be at most 80 characters" });
      applyAdminDeviceName(device, deviceName, nowIso());
      updates.deviceName = deviceName;
    }
    if (input.listingStatus !== undefined) {
      const listingStatus = normalizeDeviceListingStatus(input.listingStatus);
      device.listingStatus = listingStatus;
      if (listingStatus === "listed") {
        device.listedAt = device.listedAt || nowIso();
        device.unlistedAt = "";
      } else if (listingStatus === "unlisted") {
        device.unlistedAt = nowIso();
      }
      updates.listingStatus = listingStatus;
    }
    if (input.sims !== undefined) {
      device.sims = applyAdminSimAuthority(normalizeSims(input.sims || []), nowIso());
      updates.sims = device.sims.length;
    }
    if (input.xhsAccounts !== undefined || input.accounts !== undefined) {
      const xhsAccounts = normalizeXhsAccounts(input.xhsAccounts || input.accounts || []);
      const validationError = validateXhsAccounts(xhsAccounts);
      if (validationError) return json(res, 400, validationError);
      const conflict = findXhsIdConflict(state.devices, deviceId, xhsAccounts);
      if (conflict) return json(res, 409, conflict);
      device.xhsAccounts = xhsAccounts;
      updates.xhsAccounts = device.xhsAccounts.length;
    }
    if (!Object.keys(updates).length) return json(res, 400, { error: "no_device_updates" });
    device.updatedAt = nowIso();
    const audit = addAudit("device_update", ctx, { deviceId, ...updates });
    await persistencePolicy.persist(() => structuredRepos.persistDeviceMutation({ device, audit }));
    return json(res, 200, { ok: true, device: publicDevice(device) });
  }

  if (req.method === "POST" && url.pathname === "/api/v1/devices/bulk-listing") {
    const ctx = requireAuth(req, ["admin"]);
    const input = await readJson(req);
    const deviceIds = Array.isArray(input.deviceIds) ? input.deviceIds.map((id) => String(id || "").trim()).filter(Boolean) : [];
    const listingStatus = normalizeDeviceListingStatus(input.listingStatus);
    if (!deviceIds.length) return json(res, 400, { error: "deviceIds is required" });
    if (!["listed", "unlisted", "pending"].includes(listingStatus)) return json(res, 400, { error: "invalid_listing_status" });
    const touched = [];
    for (const device of state.devices) {
      if (!deviceIds.includes(device.deviceId)) continue;
      device.listingStatus = listingStatus;
      if (listingStatus === "listed") {
        device.listedAt = device.listedAt || nowIso();
        device.unlistedAt = "";
      } else if (listingStatus === "unlisted") {
        device.unlistedAt = nowIso();
      }
      device.updatedAt = nowIso();
      touched.push(device);
    }
    const audit = addAudit("device_bulk_listing_update", ctx, { listingStatus, count: touched.length, deviceIds: touched.slice(0, 50).map((device) => device.deviceId) });
    await persistencePolicy.persist(() => structuredRepos.persistDeviceBatch({ devices: touched, audit }));
    return json(res, 200, { ok: true, listingStatus, updated: touched.length, devices: state.devices.map(publicDevice) });
  }

  const deviceBindSimMatch = url.pathname.match(/^\/api\/v1\/devices\/([^/]+)\/sims$/);
  if (req.method === "PUT" && deviceBindSimMatch) {
    const ctx = requireAuth(req, ["admin"]);
    const input = await readJson(req);
    const deviceId = decodeURIComponent(deviceBindSimMatch[1]);
    const device = state.devices.find((item) => item.deviceId === deviceId);
    if (!device) return json(res, 404, { error: "device_not_found" });
    device.sims = applyAdminSimAuthority(normalizeSims(input.sims || []), nowIso());
    device.updatedAt = nowIso();
    const audit = addAudit("device_sims_update", ctx, { deviceId, count: device.sims.length });
    await persistencePolicy.persist(() => structuredRepos.persistDeviceMutation({ device, audit }));
    return json(res, 200, { ok: true, device: publicDevice(device) });
  }

  const deviceXhsAccountMatch = url.pathname.match(/^\/api\/v1\/devices\/([^/]+)\/xhs-accounts$/);
  if (req.method === "PUT" && deviceXhsAccountMatch) {
    const ctx = requireAuth(req, ["admin"]);
    const input = await readJson(req);
    const deviceId = decodeURIComponent(deviceXhsAccountMatch[1]);
    const device = state.devices.find((item) => item.deviceId === deviceId);
    if (!device) return json(res, 404, { error: "device_not_found" });
    const xhsAccounts = normalizeXhsAccounts(input.accounts || []);
    const validationError = validateXhsAccounts(xhsAccounts);
    if (validationError) return json(res, 400, validationError);
    const conflict = findXhsIdConflict(state.devices, deviceId, xhsAccounts);
    if (conflict) return json(res, 409, conflict);
    device.xhsAccounts = xhsAccounts;
    device.updatedAt = nowIso();
    const audit = addAudit("device_xhs_accounts_update", ctx, { deviceId, count: device.xhsAccounts.length });
    await persistencePolicy.persist(() => structuredRepos.persistDeviceMutation({ device, audit }));
    return json(res, 200, { ok: true, device: publicDevice(device) });
  }

  if (req.method === "POST" && url.pathname === "/api/v1/devices/heartbeat") {
    const ctx = requireAuth(req, ["device"]);
    const input = await readJson(req);
    const device = upsertPhoneAgentDevice(input);
    addAudit("device_heartbeat", ctx, { deviceId: device.deviceId });
    await saveState();
    return json(res, 200, { ok: true, device: publicDevice(device) });
  }

  const activationWindowsMatch = url.pathname.match(/^\/api\/v1\/devices\/([^/]+)\/activation-windows$/);
  if (req.method === "GET" && activationWindowsMatch) {
    requireAuth(req, ["device"]);
    const expired = expireSmsOrders();
    const deviceId = decodeURIComponent(activationWindowsMatch[1]);
    const device = state.devices.find((item) => item.deviceId === deviceId);
    if (!device) return json(res, 200, { windows: [] });
    const phones = new Set((device.sims || []).filter((sim) => sim.enabled !== false && sim.phoneNumber).map((sim) => sim.phoneNumber));
    const windows = state.smsOrders
      .filter((order) => order.status === "waiting" && phones.has(order.phoneNumber))
      .slice(0, 20)
      .map((order) => {
        const sim = (device.sims || []).find((item) => item.phoneNumber === order.phoneNumber) || {};
        return {
          activationId: order.orderId,
          status: order.status,
          phoneNumber: order.phoneNumber,
          platform: order.platform,
          createdAt: order.createdAt,
          expiresAt: order.expiresAt,
          subscriptionId: sim.subscriptionId,
          slotIndex: sim.slotIndex
        };
      });
    if (expired) runtimeSaveScheduler.mark();
    return json(res, 200, { windows });
  }

  if (req.method === "GET" && url.pathname === "/api/v1/sms-orders") {
    requireAuth(req, ["admin"]);
    expireSmsOrders();
    return json(res, 200, { orders: state.smsOrders.slice(0, 200) });
  }

  if (req.method === "POST" && url.pathname === "/api/v1/sms-orders") {
    const ctx = requireAuth(req, ["admin"]);
    const input = await readJson(req);
    const target = resolveSmsOrderTarget(input);
    const phoneNumber = target.phoneNumber;
    if (!phoneNumber) return json(res, 400, { error: "phoneNumber is required" });
    const order = createSmsOrder({
      ...target,
      platform: input.platform || "小红书",
      userId: input.userId || "",
      source: "admin"
    });
    addAudit("sms_order_create", ctx, { phoneNumber, platform: order.platform });
    await saveState();
    return json(res, 201, { ok: true, order });
  }

  if (req.method === "GET" && url.pathname === "/api/v1/sms-events") {
    requireAuth(req, ["admin"]);
    return json(res, 200, { events: state.smsEvents.slice(0, 200) });
  }

  if (req.method === "GET" && url.pathname === "/api/v1/sms-library") {
    requireAuth(req, ["admin"]);
    const deviceId = String(url.searchParams.get("deviceId") || "").trim();
    const box = normalizeSmsBox(url.searchParams.get("box") || "all");
    const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 200)));
    const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
    const sourceMessages = deviceId ? smsMessagesForDevice(deviceId) : repos.sms.allMessages();
    let messages = sourceMessages;
    if (box !== "all") messages = messages.filter((item) => item.box === box);
    if (q) {
      messages = messages.filter((item) => {
        return String(item.address || "").toLowerCase().includes(q)
          || String(item.body || "").toLowerCase().includes(q)
          || String(item.phoneNumber || "").toLowerCase().includes(q);
      });
    }
    return json(res, 200, {
      total: messages.length,
      limit,
      offset,
      messages: messages
        .slice(offset, offset + limit)
        .map(publicSmsMessage)
    });
  }

  if (req.method === "POST" && url.pathname === "/api/v1/sms-events") {
    const ctx = requireAuth(req, ["device"]);
    const input = await readJson(req);
    const event = {
      eventId: newId(),
      deviceId: String(input.deviceId || ""),
      phoneNumber: normalizePhone(input.phoneNumber),
      subscriptionId: normalizeOptionalInt(input.subscriptionId),
      slotIndex: normalizeOptionalInt(input.slotIndex),
      sender: sanitizePostgresText(input.sender || "", 200),
      platform: normalizePlatform(input.platform || detectPlatform(input.body, input.sender)),
      body: sanitizePostgresText(input.body || "", 8000),
      code: sanitizePostgresText(input.code || extractCode(input.body) || "", 20),
      receivedAt: normalizeIsoTime(input.receivedAt) || nowIso(),
      createdAt: nowIso(),
      eventFingerprint: normalizeSmsEventFingerprint(input.eventFingerprint),
      matchedOrderId: ""
    };

    const duplicate = findDuplicateSmsEvent(event);
    if (duplicate) {
      addAudit("sms_event_duplicate", ctx, { deviceId: event.deviceId, eventId: duplicate.eventId, eventFingerprint: event.eventFingerprint });
      await saveState();
      return json(res, 200, { ok: true, duplicate: true, event: duplicate });
    }

    matchSmsEvent(event);
    upsertSmsMessageFromEvent(event);
    state.smsEvents.unshift(event);
    addAudit("sms_event_receive", ctx, { deviceId: event.deviceId, phoneNumber: event.phoneNumber, platform: event.platform });
    await saveState();
    return json(res, 201, { ok: true, event });
  }

  const smsLibraryBatchMatch = url.pathname.match(/^\/api\/v1\/devices\/([^/]+)\/sms-library\/batch$/);
  if (req.method === "POST" && smsLibraryBatchMatch) {
    const ctx = requireAuth(req, ["device"]);
    const deviceId = decodeURIComponent(smsLibraryBatchMatch[1]);
    const input = await readJson(req);
    const device = state.devices.find((item) => item.deviceId === deviceId) || upsertPhoneAgentDevice({ deviceId });
    const messages = Array.isArray(input.messages) ? input.messages : [];
    const result = upsertSmsLibraryMessages(deviceId, messages);
    device.smsLibrary = {
      ...(device.smsLibrary || {}),
      lastSyncedAt: nowIso(),
      lastSyncCount: result.upserted,
      lastSource: String(input.source || "android-agent").slice(0, 60),
      cursor: input.cursor || device.smsLibrary?.cursor || null
    };
    const audit = addAudit("sms_library_sync", ctx, { deviceId, received: messages.length, upserted: result.upserted });
    await persistencePolicy.persist(() => structuredRepos.persistSmsBatch({
      device,
      messages: result.persistedMessages,
      audit
    }));
    const { persistedMessages, ...publicResult } = result;
    return json(res, 200, { ok: true, ...publicResult });
  }

  if (req.method === "GET" && url.pathname === "/api/v1/xhs/qr-scan-tasks") {
    requireAuth(req, ["admin"]);
    const limit = boundedInt(url.searchParams.get("limit"), 20, 1, 100);
    const offset = boundedInt(url.searchParams.get("offset"), 0, 0, Math.max(0, state.xhsQrTasks.length));
    const includeEvidence = url.searchParams.get("includeEvidence") === "1";
    return json(res, 200, {
      tasks: state.xhsQrTasks.slice(offset, offset + limit).map((task) => publicAdminXhsTask(task, { includeEvidence })),
      limit,
      offset,
      total: state.xhsQrTasks.length
    });
  }

  const adminXhsTaskDetailMatch = url.pathname.match(/^\/api\/v1\/xhs\/qr-scan-tasks\/([^/]+)$/);
  if (req.method === "GET" && adminXhsTaskDetailMatch) {
    requireAuth(req, ["admin"]);
    const task = state.xhsQrTasks.find((item) => item.taskId === adminXhsTaskDetailMatch[1]);
    if (!task) return json(res, 404, { error: "xhs_task_not_found" });
    return json(res, 200, { task: publicAdminXhsTask(task, { includeEvidence: true }) });
  }

  if (req.method === "POST" && url.pathname === "/api/v1/xhs/qr-scan-tasks") {
    const ctx = requireAuth(req, ["admin"]);
    const input = await readJson(req);
    const deviceId = String(input.deviceId || "");
    const qrImageDataUrl = normalizeQrImageDataUrl(input.qrImageDataUrl);
    const device = state.devices.find((item) => item.deviceId === deviceId);
    if (!device) return json(res, 404, { error: "device_not_found" });
    if (!isAdbOnline(device)) return json(res, 409, { error: "adb_device_not_available" });
    if (!hasWindowsAdbBinding(device)) return json(res, 409, { error: "windows_agent_not_available" });
    if (!isDeviceAutomationReady(device)) return json(res, 409, { error: "device_automation_not_ready", detail: deviceAutomationError(device) });
    const account = pickXhsAccount(device, input.xhsAppSlot);
    if (!account) return json(res, 409, { error: "xhs_account_not_available" });
    const conflict = xhsTaskConflictForRequest(device.deviceId, account.appSlot);
    if (conflict) return json(res, 409, conflict);
    const task = createXhsQrTask({
      deviceId,
      xhsAppSlot: account.appSlot,
      xhsAccountLabel: account.label,
      xhsAccountId: account.xhsId,
      xhsAccountName: account.accountName,
      qrImageDataUrl,
      userId: input.userId || ctx.userId || "",
      source: "admin"
    });
    const deviceLock = acquireDeviceTaskLock(device, task, ctx);
    const windowsTask = queueXhsAirtestWindowsTask(device, task, ctx);
    const audit = addAudit("xhs_qr_task_create", ctx, { deviceId, xhsAppSlot: task.xhsAppSlot });
    await persistencePolicy.persist(() => structuredRepos.persistTaskMutation({ windowsTask, xhsTask: task, deviceLock, audit }));
    return json(res, 201, { ok: true, task });
  }

  const xhsTaskNextMatch = url.pathname.match(/^\/api\/v1\/devices\/([^/]+)\/xhs\/qr-scan-tasks\/next$/);
  if (req.method === "GET" && xhsTaskNextMatch) {
    requireAuth(req, ["device"]);
    const expired = expireXhsTasks();
    const deviceId = decodeURIComponent(xhsTaskNextMatch[1]);
    const task = state.xhsQrTasks.find((item) => item.deviceId === deviceId && item.status === "queued" && !isWindowsManagedXhsTask(item));
    if (!task) {
      if (expired) runtimeSaveScheduler.mark();
      return json(res, 200, { task: null });
    }
    task.status = "running";
    task.pickedAt = task.pickedAt || nowIso();
    task.updatedAt = nowIso();
    await saveState();
    return json(res, 200, { task });
  }

  const deviceCommandNextMatch = url.pathname.match(/^\/api\/v1\/devices\/([^/]+)\/commands\/next$/);
  if (req.method === "GET" && deviceCommandNextMatch) {
    requireAuth(req, ["device"]);
    const expired = expireXhsTasks();
    const deviceId = decodeURIComponent(deviceCommandNextMatch[1]);
    const task = state.xhsQrTasks.find((item) => item.deviceId === deviceId && item.status === "queued" && !isWindowsManagedXhsTask(item));
    if (!task) {
      if (expired) runtimeSaveScheduler.mark();
      return json(res, 200, { command: null });
    }
    task.status = "running";
    task.pickedAt = task.pickedAt || nowIso();
    task.updatedAt = nowIso();
    await saveState();
    return json(res, 200, { command: xhsTaskAsDeviceCommand(task) });
  }

  const deviceCommandStatusMatch = url.pathname.match(/^\/api\/v1\/device-commands\/([^/]+)\/status$/);
  const deviceCommandMatch = url.pathname.match(/^\/api\/v1\/device-commands\/([^/]+)$/);
  if (req.method === "GET" && deviceCommandMatch) {
    requireAuth(req, ["device"]);
    const expired = expireXhsTasks();
    const task = state.xhsQrTasks.find((item) => item.taskId === deviceCommandMatch[1]);
    if (!task) return json(res, 404, { error: "command_not_found" });
    if (expired) runtimeSaveScheduler.mark();
    return json(res, 200, { command: xhsTaskAsDeviceCommand(task) });
  }

  if (req.method === "POST" && deviceCommandStatusMatch) {
    requireAuth(req, ["device"]);
    const input = await readJson(req);
    const task = state.xhsQrTasks.find((item) => item.taskId === deviceCommandStatusMatch[1]);
    if (!task) return json(res, 404, { error: "command_not_found" });
    if (!["running", "succeeded", "failed", "cancelled"].includes(input.status)) return json(res, 400, { error: "invalid_status" });
    if (isTerminalStatus(task.status)) {
      return json(res, 200, { ok: true, ignored: true, command: xhsTaskAsDeviceCommand(task) });
    }
    task.status = input.status;
    task.result = isTerminalStatus(task.status)
      ? sanitizeTaskResult(input.result || {}, { includeEvidence: true })
      : input.result || {};
    task.updatedAt = nowIso();
    if (["succeeded", "failed", "cancelled"].includes(task.status)) {
      task.completedAt = nowIso();
      releaseDeviceTaskLock(task, task.status);
    }
    await saveState();
    return json(res, 200, { ok: true, command: xhsTaskAsDeviceCommand(task) });
  }

  const deviceCommandEventsMatch = url.pathname.match(/^\/api\/v1\/device-commands\/([^/]+)\/events$/);
  if (req.method === "POST" && deviceCommandEventsMatch) {
    requireAuth(req, ["device"]);
    const input = await readJson(req);
    const task = state.xhsQrTasks.find((item) => item.taskId === deviceCommandEventsMatch[1]);
    if (!task) return json(res, 404, { error: "command_not_found" });
    const event = sanitizeStoredEvent({
      eventId: newId(),
      phase: input.phase || "log",
      level: input.level || "info",
      message: String(input.message || "").slice(0, 2000),
      packageName: input.packageName || "",
      uiSnapshot: input.uiSnapshot || "",
      screenshot: input.screenshot || null,
      detail: input.detail || {},
      createdAt: nowIso()
    });
    if (!Array.isArray(task.events)) task.events = [];
    task.events.push(event);
    task.updatedAt = nowIso();
    await saveState();
    return json(res, 201, { ok: true, event });
  }

  if (req.method === "GET" && deviceCommandEventsMatch) {
    requireAuth(req, ["admin"]);
    const task = state.xhsQrTasks.find((item) => item.taskId === deviceCommandEventsMatch[1]);
    if (!task) return json(res, 404, { error: "command_not_found" });
    return json(res, 200, { events: (task.events || []).map((event) => sanitizeStoredEvent(event)) });
  }

  const xhsTaskStatusMatch = url.pathname.match(/^\/api\/v1\/xhs\/qr-scan-tasks\/([^/]+)\/status$/);
  if (req.method === "POST" && xhsTaskStatusMatch) {
    requireAuth(req, ["device"]);
    const input = await readJson(req);
    const task = state.xhsQrTasks.find((item) => item.taskId === xhsTaskStatusMatch[1]);
    if (!task) return json(res, 404, { error: "xhs_task_not_found" });
    if (!["running", "succeeded", "failed", "cancelled"].includes(input.status)) return json(res, 400, { error: "invalid_status" });
    if (isTerminalStatus(task.status)) {
      return json(res, 200, { ok: true, ignored: true, task });
    }
    task.status = input.status;
    task.result = isTerminalStatus(task.status)
      ? sanitizeTaskResult(input.result || {}, { includeEvidence: true })
      : input.result || {};
    task.updatedAt = nowIso();
    if (["succeeded", "failed", "cancelled"].includes(task.status)) task.completedAt = nowIso();
    await saveState();
    return json(res, 200, { ok: true, task });
  }

  if (req.method === "GET" && url.pathname === "/api/v1/audit") {
    requireAuth(req, ["admin"]);
    return json(res, 200, { audit: state.audit.slice(0, 300) });
  }

  return json(res, 404, { error: "not_found" });
}

function requireAuth(req, roles) {
  const token = extractToken(req);
  const session = findSessionByToken(token);
  const staticCtx = session ? null : staticTokenContext(token);
  const role = session?.role || staticCtx?.role || "";
  if (!role || !roles.includes(role)) {
    const error = new Error("unauthorized");
    error.statusCode = 401;
    throw error;
  }
  const user = session ? state.users.find((item) => item.userId === session.userId && item.enabled !== false) : null;
  if (session && !user) {
    const error = new Error("unauthorized");
    error.statusCode = 401;
    throw error;
  }
  return {
    role,
    name: user?.username || role,
    userId: user?.userId || "",
    username: user?.username || "",
    user,
    session,
    tokenHash: staticCtx?.tokenHash || "",
    agent: staticCtx?.agent || null,
    agentId: staticCtx?.agentId || "",
    legacyWindowsToken: Boolean(staticCtx?.legacyWindowsToken)
  };
}

function requireWindowsAgent(req, expectedAgentId = "") {
  const ctx = requireAuth(req, ["windows"]);
  const agentId = String(expectedAgentId || "").trim();
  if (ctx.agent) {
    if (ctx.agent.enabled === false || ctx.agent.revokedAt) throw unauthorized("windows_agent_disabled");
    if (agentId && ctx.agent.agentId !== agentId) throw unauthorized("windows_agent_mismatch");
    ctx.agent.lastAuthenticatedAt = nowIso();
    return ctx;
  }
  if (ctx.legacyWindowsToken && LEGACY_WINDOWS_AGENT_TOKEN_ENABLED) return ctx;
  throw unauthorized("windows_agent_token_not_bound");
}

function windowsCtxCanAccessTask(ctx, task) {
  if (!task) return false;
  if (ctx.legacyWindowsToken && LEGACY_WINDOWS_AGENT_TOKEN_ENABLED) return true;
  return Boolean(ctx.agentId && task.agentId && ctx.agentId === task.agentId);
}

function requireWindowsScope(ctx, scope) {
  if (ctx.legacyWindowsToken && LEGACY_WINDOWS_AGENT_TOKEN_ENABLED) return;
  const scopes = normalizeAgentScopes(ctx.agent?.scopes || []);
  if (!scopes.includes(scope)) throw unauthorized("windows_agent_scope_denied");
}

function createAgentToken() {
  return `pcwa_${crypto.randomBytes(32).toString("base64url")}`;
}

function normalizeAgentScopes(scopes = []) {
  const allowed = new Set(["heartbeat", "devices:sync", "tasks:read", "tasks:write", "sms:sync", "automation:xhs"]);
  const input = Array.isArray(scopes) ? scopes : String(scopes || "").split(",");
  const normalized = input.map((item) => String(item || "").trim()).filter((item) => allowed.has(item));
  return normalized.length ? [...new Set(normalized)] : [...allowed];
}

function openNameLookupUser(client) {
  if (!client?.username) return null;
  return (state.users || []).find((user) => (
    user.enabled !== false
    && user.role === "user"
    && String(user.username || "").trim().toLowerCase() === client.username
  )) || null;
}

function openNameLookupSession(clientId, sessionId) {
  return (state.automationSessions || []).find((session) => (
    session.sessionId === String(sessionId || "")
    && session.source === "open-api"
    && session.clientId === String(clientId || "")
  )) || null;
}

function isActiveLookupSessionStatus(status) {
  return ["starting", "ready", "querying", "switching", "choosing_account", "needs_human_verification", "stopping"].includes(String(status || ""));
}

function requiredOpenIdempotencyKey(req) {
  const key = normalizeIdempotencyKey(req.headers["idempotency-key"]);
  if (!key) throw badRequest("idempotency_key_required");
  return key;
}

function queuedOpenLookupJobs(session) {
  return (state.automationJobs || [])
    .filter((job) => (
      job.source === "open-api"
      && job.clientId === session.clientId
      && job.sessionId === session.sessionId
      && job.kind === "alipay_name_query"
      && job.resumeAfterHumanVerification !== true
      && job.status === "queued"
      && !job.windowsTaskId
    ))
    .sort((left, right) => Number(left.queueSequence || 0) - Number(right.queueSequence || 0)
      || String(left.createdAt || "").localeCompare(String(right.createdAt || ""))
      || String(left.jobId || "").localeCompare(String(right.jobId || "")));
}

function refreshOpenLookupQueuePositions(session) {
  const queued = queuedOpenLookupJobs(session);
  const queuedResultIds = new Set();
  queued.forEach((job, index) => {
    queuedResultIds.add(String(job.resultId || job.jobId));
    const result = upsertLookupResult(session, job, {
      status: "queued",
      stage: `队列等待中，前方 ${index} 个查询`,
      updatedAt: job.updatedAt || session.updatedAt
    });
    result.queuePosition = index + 1;
  });
  for (const result of session.results || []) {
    if (!queuedResultIds.has(result.resultId)) delete result.queuePosition;
  }
  session.queuedCount = queued.length;
  return queued;
}

function dispatchNextOpenLookupQuery(session) {
  const queued = refreshOpenLookupQueuePositions(session);
  if (!queued.length || session.pendingJobId || session.status !== "ready") return null;
  if (session.requiresAccountSwitch || resumableLookupHumanVerificationResult(session) || resumableLookupRecoveryResult(session)) return null;
  if (screenSessions.activeForDevice(session.deviceId)) return null;
  const device = repos.devices.findById(session.deviceId);
  if (!device || !isAdbOnline(device)) return null;
  const job = queued[0];
  const windowsTask = queueAutomationWindowsTask(device, job);
  session.status = "querying";
  session.pendingJobId = job.jobId;
  session.updatedAt = nowIso();
  const result = upsertLookupResult(session, job, {
    status: "queued",
    stage: "查询任务已提交，等待 Windows 管理器领取",
    updatedAt: session.updatedAt
  });
  delete result.queuePosition;
  refreshOpenLookupQueuePositions(session);
  return { job, windowsTask };
}

function cancelQueuedOpenLookupQueries(session, reason) {
  const queued = queuedOpenLookupJobs(session);
  for (const job of queued) {
    cancelAutomationJob(job, reason, { releaseLock: false });
    const result = upsertLookupResult(session, job, {
      status: "cancelled",
      stage: "查询已取消",
      error: "会话已结束",
      updatedAt: job.updatedAt
    });
    delete result.queuePosition;
  }
  session.queuedCount = 0;
  return queued;
}

async function readSignedOpenJson(req, url, clients = THIRD_PARTY_API_CLIENTS) {
  const { raw, input } = await readRawJson(req);
  const ctx = verifyOpenApiRequest(req, url, raw, clients);
  recordOpenApiNonce(ctx);
  return { ctx, input, raw };
}

function verifyOpenApiRequest(req, url, rawBody = "", clients = THIRD_PARTY_API_CLIENTS) {
  if (clients === OPEN_NAME_LOOKUP_CLIENTS && Object.hasOwn(req.headers, "x-api-key")) {
    return verifyLookupApiKey(req, url, clients);
  }
  const clientId = String(req.headers["x-client-id"] || "").trim();
  const timestamp = String(req.headers["x-timestamp"] || "").trim();
  const nonce = String(req.headers["x-nonce"] || "").trim();
  const signature = String(req.headers["x-signature"] || "").trim();
  if (!clientId || !timestamp || !nonce || !signature) throw unauthorizedOpenApi("open_api_auth_required");
  const client = clients.get(clientId);
  if (!client) throw unauthorizedOpenApi("invalid_open_api_client");
  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > OPEN_API_TIMESTAMP_SKEW_MS) {
    throw unauthorizedOpenApi("open_api_timestamp_expired");
  }
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(nonce)) throw unauthorizedOpenApi("invalid_open_api_nonce");
  const replay = state.openApiNonces.some((item) => item.clientId === clientId && item.nonce === nonce);
  if (replay) throw unauthorizedOpenApi("open_api_nonce_replayed");
  const expected = signOpenApiRequest(client.secret, req.method || "GET", url.pathname, timestamp, nonce, rawBody);
  if (!secureTokenEquals(signature, expected)) throw unauthorizedOpenApi("invalid_open_api_signature");
  return { role: "open-api", name: clientId, clientId, nonce, client };
}

function signOpenApiRequest(secret, method, pathname, timestamp, nonce, rawBody = "") {
  const bodyHash = crypto.createHash("sha256").update(String(rawBody || "")).digest("hex");
  const canonical = [String(method || "GET").toUpperCase(), pathname, timestamp, nonce, bodyHash].join("\n");
  return crypto.createHmac("sha256", secret).update(canonical).digest("hex");
}

function unauthorizedOpenApi(message) {
  const error = new Error(message);
  error.statusCode = 401;
  return error;
}

function pruneOpenApiNonces() {
  const cutoff = Date.now() - OPEN_API_TIMESTAMP_SKEW_MS * 2;
  state.openApiNonces = (state.openApiNonces || [])
    .filter((item) => toTime(item.createdAt) >= cutoff)
    .slice(0, MAX_OPEN_API_NONCES);
}

function recordOpenApiNonce(ctx) {
  if (ctx.authType === "lookup-api-key") return;
  pruneOpenApiNonces();
  state.openApiNonces.unshift({
    clientId: ctx.clientId,
    nonce: ctx.nonce,
    createdAt: nowIso()
  });
  state.openApiNonces = state.openApiNonces.slice(0, MAX_OPEN_API_NONCES);
}

function extractToken(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return req.headers["x-api-key"] || "";
}

function findSessionByToken(token) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const session = state.sessions.find((item) => item.tokenHash === tokenHash && !item.revokedAt);
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    session.revokedAt = nowIso();
    return null;
  }
  return session;
}

function staticTokenContext(token) {
  if (!token) return null;
  if (secureTokenEquals(token, ADMIN_API_TOKEN)) return { role: "admin", name: "admin-token" };
  const agent = findWindowsAgentByToken(token);
  if (agent) {
    if (agent.enabled === false || agent.revokedAt) return null;
    return {
      role: "windows",
      name: agent.agentId,
      agent,
      agentId: agent.agentId,
      tokenHash: hashToken(token)
    };
  }
  if (LEGACY_WINDOWS_AGENT_TOKEN_ENABLED && secureTokenEquals(token, WINDOWS_AGENT_TOKEN)) {
    return { role: "windows", name: "legacy-windows-token", legacyWindowsToken: true, tokenHash: hashToken(token) };
  }
  if (secureTokenEquals(token, DEVICE_AGENT_TOKEN)) return { role: "device", name: "device-token" };
  return null;
}

function staticTokenRole(token) {
  const ctx = staticTokenContext(token);
  return typeof ctx === "string" ? ctx : ctx?.role || "";
}

function findWindowsAgentByToken(token) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  return (state.windowsAgents || []).find((agent) => (
    agent.tokenHash
    && secureTokenEquals(agent.tokenHash, tokenHash)
    && agent.enabled !== false
    && !agent.revokedAt
  )) || null;
}

function unauthorized(message = "unauthorized") {
  const error = new Error(message);
  error.statusCode = 401;
  return error;
}

function secureTokenEquals(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (!left.length || !right.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

async function ensureBootstrapAdmin() {
  if (!state.users.some((user) => user.role === "admin")) {
    const user = createUser({
      username: BOOTSTRAP_ADMIN_USERNAME,
      password: BOOTSTRAP_ADMIN_PASSWORD,
      displayName: "平台管理员",
      role: "admin"
    });
    addAudit("bootstrap_admin_create", { role: "system" }, { username: user.username });
    await saveState();
  }
}

function createUser(input = {}) {
  const username = normalizeUsername(input.username);
  const password = String(input.password || "");
  const role = input.role === "admin" ? "admin" : "user";
  if (!username) throw badRequest("username is required");
  validatePasswordStrength(password, {
    minLength: role === "admin" ? MIN_PASSWORD_LENGTH : MIN_MANAGED_USER_PASSWORD_LENGTH
  });
  if (state.users.some((user) => user.username === username)) throw badRequest("username already exists");
  const user = {
    userId: newId(),
    username,
    displayName: String(input.displayName || username).slice(0, 80),
    role,
    enabled: input.enabled !== false,
    passwordHash: hashPassword(password),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastLoginAt: null
  };
  state.users.unshift(user);
  return user;
}

function updateUser(user, input = {}) {
  if (input.displayName !== undefined) user.displayName = String(input.displayName || user.username).slice(0, 80);
  if (input.role !== undefined) user.role = input.role === "admin" ? "admin" : "user";
  if (input.enabled !== undefined) {
    user.enabled = Boolean(input.enabled);
    if (!user.enabled) revokeUserSessions(user.userId);
  }
  if (input.password !== undefined && String(input.password || "").length) {
    const nextPassword = String(input.password);
    validatePasswordStrength(nextPassword, {
      minLength: user.role === "admin" ? MIN_PASSWORD_LENGTH : MIN_MANAGED_USER_PASSWORD_LENGTH
    });
    user.passwordHash = hashPassword(nextPassword);
    revokeUserSessions(user.userId);
  }
  user.updatedAt = nowIso();
}

function createSession(user, req) {
  revokeExpiredSessions();
  const token = crypto.randomBytes(32).toString("base64url");
  const session = {
    sessionId: newId(),
    userId: user.userId,
    username: user.username,
    role: user.role,
    tokenHash: hashToken(token),
    ip: req?.socket?.remoteAddress || "",
    userAgent: String(req?.headers?.["user-agent"] || "").slice(0, 300),
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    revokedAt: null
  };
  state.sessions.unshift(session);
  state.sessions = state.sessions.slice(0, MAX_SESSIONS);
  return { ...session, token };
}

function validatePasswordStrength(password, options = {}) {
  const minLength = Number(options.minLength || MIN_PASSWORD_LENGTH);
  if (String(password || "").length < minLength) {
    throw badRequest(`password must be at least ${minLength} characters`);
  }
}

function revokeExpiredSessions() {
  const now = Date.now();
  let changed = false;
  for (const session of state.sessions) {
    if (!session.revokedAt && new Date(session.expiresAt).getTime() <= now) {
      session.revokedAt = nowIso();
      changed = true;
    }
  }
  return changed;
}

function revokeUserSessions(userId, exceptSessionId = "") {
  for (const session of state.sessions) {
    if (session.userId === userId && session.sessionId !== exceptSessionId && !session.revokedAt) session.revokedAt = nowIso();
  }
}

function loginRateLimitKey(req, username) {
  return `${req.socket?.remoteAddress || "unknown"}:${username || "unknown"}`;
}

function checkLoginRateLimit(key) {
  const entry = loginRateLimits.get(key);
  if (!entry) return { ok: true, retryAfterSeconds: 0 };
  const elapsed = Date.now() - entry.firstAt;
  if (elapsed > LOGIN_RATE_LIMIT_WINDOW_MS) {
    loginRateLimits.delete(key);
    return { ok: true, retryAfterSeconds: 0 };
  }
  if (entry.count >= LOGIN_RATE_LIMIT_MAX) {
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((LOGIN_RATE_LIMIT_WINDOW_MS - elapsed) / 1000)) };
  }
  return { ok: true, retryAfterSeconds: 0 };
}

function recordLoginFailure(key) {
  const now = Date.now();
  const entry = loginRateLimits.get(key);
  if (!entry || now - entry.firstAt > LOGIN_RATE_LIMIT_WINDOW_MS) {
    loginRateLimits.set(key, { count: 1, firstAt: now });
    return;
  }
  entry.count += 1;
}

function clearLoginFailures(key) {
  loginRateLimits.delete(key);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, storedHash = "") {
  const [scheme, salt, expected] = String(storedHash || "").split(":");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expectedBytes = Buffer.from(expected, "hex");
  return expectedBytes.length === actual.length && crypto.timingSafeEqual(expectedBytes, actual);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function publicSession(session) {
  return {
    sessionId: session.sessionId,
    token: session.token,
    role: session.role,
    expiresAt: session.expiresAt
  };
}

function publicUser(user) {
  return {
    userId: user.userId,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    enabled: user.enabled !== false,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt || null
  };
}

function staticTokenUser(ctx) {
  return {
    userId: "",
    username: ctx.role,
    displayName: ctx.role === "admin" ? "静态管理员 Token" : ctx.role,
    role: ctx.role,
    enabled: true,
    createdAt: "",
    updatedAt: "",
    lastLoginAt: null
  };
}

function normalizeUsername(value = "") {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_.@-]/g, "").slice(0, 80);
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function upsertWindowsAgent(input = {}, req) {
  const agentId = String(input.agentId || "").trim();
  if (!agentId) {
    const error = new Error("agentId is required");
    error.statusCode = 400;
    throw error;
  }
  let agent = state.windowsAgents.find((item) => item.agentId === agentId);
  if (!agent) {
    agent = {
      agentId,
      agentName: "",
      hostname: "",
      version: "",
      platform: "",
      arch: "",
      ip: "",
      adbVersion: "",
      health: {},
      tokenHash: "",
      tokenPrefix: "",
      lastRotatedAt: "",
      lastAuthenticatedAt: "",
      enabled: true,
      revokedAt: "",
      scopes: normalizeAgentScopes(input.scopes),
      maxConcurrentAdbTasks: DEFAULT_AGENT_MAX_CONCURRENT_ADB_TASKS,
      deviceTaskConcurrency: 1,
      devices: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastSeenAt: nowIso()
    };
    state.windowsAgents.unshift(agent);
  }
  agent.agentName = String(input.agentName || input.name || agent.agentName || agentId);
  agent.hostname = String(input.hostname || agent.hostname || "");
  agent.version = String(input.version || agent.version || "");
  agent.platform = String(input.platform || agent.platform || "");
  agent.arch = String(input.arch || agent.arch || "");
  agent.ip = String(input.ip || req?.socket?.remoteAddress || agent.ip || "");
  agent.lastIp = String(req?.socket?.remoteAddress || input.ip || agent.lastIp || agent.ip || "");
  agent.adbVersion = String(input.adbVersion || agent.adbVersion || "");
  if (input.managedLookupProtocol !== undefined) agent.managedLookupProtocol = input.managedLookupProtocol === MANAGED_LOOKUP_PROTOCOL ? MANAGED_LOOKUP_PROTOCOL : "";
  agent.lookupRuntimeId=typeof input.lookupRuntimeId==="string"&&/^[a-f0-9-]{36}$/.test(input.lookupRuntimeId)?input.lookupRuntimeId:"";
  agent.health = normalizeAgentHealth(input.health || agent.health || {});
  if (input.tokenHash) agent.tokenHash = String(input.tokenHash);
  if (input.tokenPrefix) agent.tokenPrefix = String(input.tokenPrefix).slice(0, 16);
  if (input.lastRotatedAt) agent.lastRotatedAt = input.lastRotatedAt;
  if (input.enabled !== undefined) agent.enabled = input.enabled !== false;
  if (input.revokedAt !== undefined) agent.revokedAt = String(input.revokedAt || "");
  agent.scopes = normalizeAgentScopes(input.scopes || agent.scopes || []);
  agent.maxConcurrentAdbTasks = Math.max(1, Number(input.maxConcurrentAdbTasks || agent.maxConcurrentAdbTasks || DEFAULT_AGENT_MAX_CONCURRENT_ADB_TASKS));
  agent.deviceTaskConcurrency = Math.max(1, Number(input.deviceTaskConcurrency || agent.deviceTaskConcurrency || 1));
  agent.updatedAt = nowIso();
  agent.lastSeenAt = nowIso();
  return agent;
}

function normalizeAgentHealth(input = {}) {
  const warnings = Array.isArray(input.warnings) ? input.warnings.map((item) => String(item).slice(0, 120)).slice(0, 20) : [];
  return {
    status: input.status === "ok" ? "ok" : warnings.length ? "warn" : String(input.status || "unknown").slice(0, 40),
    reason: String(input.reason || "").slice(0, 80),
    checkedAt: input.checkedAt || nowIso(),
    warnings,
    adb: {
      ok: Boolean(input.adb?.ok),
      path: String(input.adb?.path || "").slice(0, 300),
      version: String(input.adb?.version || "").slice(0, 300),
      error: String(input.adb?.error || "").slice(0, 800)
    },
    recoveryControl: normalizeRecoveryControlAck(input.recoveryControl),
    xhsDataCollect: {
      protocol: input.xhsDataCollect?.protocol === XHS_DATA_COLLECTION_PROTOCOL ? XHS_DATA_COLLECTION_PROTOCOL : "",
      ready: input.xhsDataCollect?.ready === true
    },
    airtest: {
      enabled: input.airtest?.enabled !== false,
      ok: Boolean(input.airtest?.ok),
      pythonCommand: String(input.airtest?.pythonCommand || "").slice(0, 300),
      autoInstall: input.airtest?.autoInstall !== false,
      runnerPath: String(input.airtest?.runnerPath || "").slice(0, 500),
      packages: sanitizeStringList(input.airtest?.packages || [], 20, 120),
      lastError: cleanLogText(input.airtest?.lastError || input.airtest?.error || "").slice(0, 800),
      checkedAt: input.airtest?.checkedAt || nowIso()
    },
    runtime: {
      processCpuPercent: boundedMetric(input.runtime?.processCpuPercent, 0, 10_000, 1),
      processRssMb: boundedMetric(input.runtime?.processRssMb, 0, 1_000_000, 1),
      processHeapUsedMb: boundedMetric(input.runtime?.processHeapUsedMb, 0, 1_000_000, 1),
      hostMemoryUsedPercent: boundedMetric(input.runtime?.hostMemoryUsedPercent, 0, 100, 1),
      hostFreeMemoryMb: boundedMetric(input.runtime?.hostFreeMemoryMb, 0, 1_000_000, 1),
      uptimeSeconds: boundedMetric(input.runtime?.uptimeSeconds, 0, 1_000_000_000, 0)
    },
    screenControl: {
      enabled: input.screenControl?.enabled !== false,
      connected: Boolean(input.screenControl?.connected),
      activeSessions: boundedMetric(input.screenControl?.activeSessions, 0, 1000, 0),
      serverJarReady: Boolean(input.screenControl?.serverJarReady)
    },
    deviceRecovery: {
      observedAt: String(input.deviceRecovery?.observedAt || "").slice(0, 80),
      circuitOpen: Boolean(input.deviceRecovery?.circuitOpen),
      circuitReason: String(input.deviceRecovery?.circuitReason || "").slice(0, 120),
      circuitUntil: String(input.deviceRecovery?.circuitUntil || "").slice(0, 80),
      blockedReason: String(input.deviceRecovery?.blockedReason || "").slice(0, 120),
      physicalCount: boundedMetric(input.deviceRecovery?.physicalCount, 0, 10_000, 0),
      adbDeviceCount: boundedMetric(input.deviceRecovery?.adbDeviceCount, 0, 10_000, 0),
      actionableCount: boundedMetric(input.deviceRecovery?.actionableCount, 0, 10_000, 0),
      newlyLostCount: boundedMetric(input.deviceRecovery?.newlyLostCount, 0, 10_000, 0),
      unauthorizedCount: boundedMetric(input.deviceRecovery?.unauthorizedCount, 0, 10_000, 0),
      offlineCount: boundedMetric(input.deviceRecovery?.offlineCount, 0, 10_000, 0),
      absentCount: boundedMetric(input.deviceRecovery?.absentCount, 0, 10_000, 0),
      automaticActionsLastHour: boundedMetric(input.deviceRecovery?.automaticActionsLastHour, 0, 10_000, 0),
      maxActionsPerHour: boundedMetric(input.deviceRecovery?.maxActionsPerHour, 0, 10_000, 0),
      acknowledgedActionableCount: boundedMetric(input.deviceRecovery?.acknowledgedActionableCount, 0, 10_000, 0),
      recoveryMode: String(input.deviceRecovery?.recoveryMode || "normal").slice(0, 80),
      actionReadyAt: String(input.deviceRecovery?.actionReadyAt || "").slice(0, 80),
      postActionWatchCount: boundedMetric(input.deviceRecovery?.postActionWatchCount, 0, 100, 0),
      postActionWatchUntil: String(input.deviceRecovery?.postActionWatchUntil || "").slice(0, 80),
      rescueSerials: sanitizeStringList(input.deviceRecovery?.rescueSerials || [], 20, 160),
      rescueCanMutate: Boolean(input.deviceRecovery?.rescueCanMutate),
      maxAttemptsPerDevice: boundedMetric(input.deviceRecovery?.maxAttemptsPerDevice, 1, 100, 0),
      quarantinedCount: boundedMetric(input.deviceRecovery?.quarantinedCount, 0, 10_000, 0),
      inventoryObservedAt: String(input.deviceRecovery?.inventoryObservedAt || "").slice(0, 80),
      inventoryFresh: Boolean(input.deviceRecovery?.inventoryFresh),
      inventoryError: String(input.deviceRecovery?.inventoryError || "").slice(0, 300),
      queue: normalizeRecoveryQueue(input.deviceRecovery?.queue),
      recentEvents: normalizeRecoveryEvents(input.deviceRecovery?.recentEvents)
    },
    directories: {
      logDir: {
        path: String(input.directories?.logDir?.path || "").slice(0, 300),
        ok: Boolean(input.directories?.logDir?.ok),
        error: String(input.directories?.logDir?.error || "").slice(0, 500)
      },
      cacheDir: {
        path: String(input.directories?.cacheDir?.path || "").slice(0, 300),
        ok: Boolean(input.directories?.cacheDir?.ok),
        error: String(input.directories?.cacheDir?.error || "").slice(0, 500)
      }
    },
    lastScan: input.lastScan ? {
      ok: Boolean(input.lastScan.ok),
      at: input.lastScan.at || "",
      error: String(input.lastScan.error || "").slice(0, 800)
    } : null
  };
}

function cleanLogText(value) {
  return String(value || "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .trim();
}

function boundedMetric(value, min, max, digits = 0) {
  const numeric = Number(value || 0);
  const bounded = Math.min(max, Math.max(min, Number.isFinite(numeric) ? numeric : 0));
  const factor = 10 ** digits;
  return Math.round(bounded * factor) / factor;
}

function normalizeRecoveryQueue(value) {
  return (Array.isArray(value) ? value : []).slice(0, 200).map((item = {}) => ({
    serial: String(item.serial || "").slice(0, 160),
    deviceId: String(item.deviceId || "").slice(0, 160),
    deviceName: String(item.deviceName || item.serial || "未知设备").slice(0, 160),
    state: String(item.state || "unknown").slice(0, 80),
    physicalPresent: Boolean(item.physicalPresent),
    attempts: boundedMetric(item.attempts, 0, 100, 0),
    maxAttempts: boundedMetric(item.maxAttempts, 1, 100, 0),
    mode: String(item.mode || "").slice(0, 80),
    lastAttemptAt: String(item.lastAttemptAt || "").slice(0, 80),
    nextActionAt: String(item.nextActionAt || "").slice(0, 80),
    inProgress: Boolean(item.inProgress),
    quarantined: Boolean(item.quarantined),
    quarantinedAt: String(item.quarantinedAt || "").slice(0, 80),
    targetType: String(item.targetType || "").slice(0, 80),
    lastError: cleanLogText(item.lastError || "").slice(0, 300),
    rootProblem: String(item.rootProblem || "").slice(0, 120),
    adbInterfaceProblem: String(item.adbInterfaceProblem || "").slice(0, 120)
  })).filter((item) => item.serial);
}

function normalizeRecoveryEvents(value) {
  return (Array.isArray(value) ? value : []).slice(-80).map((item = {}) => ({
    id: String(item.id || "").slice(0, 120),
    at: String(item.at || "").slice(0, 80),
    type: String(item.type || "status").slice(0, 60),
    severity: ["success", "warning", "error", "info"].includes(item.severity) ? item.severity : "info",
    serial: String(item.serial || "").slice(0, 160),
    state: String(item.state || "").slice(0, 80),
    previousState: String(item.previousState || "").slice(0, 80),
    attempt: boundedMetric(item.attempt, 0, 100, 0),
    maxAttempts: boundedMetric(item.maxAttempts, 0, 100, 0),
    mode: String(item.mode || "").slice(0, 80),
    reason: String(item.reason || "").slice(0, 160),
    result: cleanLogText(item.result || "").slice(0, 300),
    nextActionAt: String(item.nextActionAt || "").slice(0, 80),
    targetType: String(item.targetType || "").slice(0, 80)
  })).filter((item) => item.at && item.type);
}

function syncAdbDevices(agent, devices) {
  const seen = new Set();
  for (const input of Array.isArray(devices) ? devices : []) {
    const adbSerial = String(input.adbSerial || input.serial || "").trim();
    if (!adbSerial) continue;
    const adbSerialKey = adbSerial.toUpperCase();
    seen.add(adbSerialKey);
    let item = agent.devices.find((device) => String(device.adbSerial || "").toUpperCase() === adbSerialKey);
    if (!item) {
      item = { adbSerial, createdAt: nowIso() };
      agent.devices.push(item);
    }
    item.deviceId = String(input.deviceId || item.deviceId || (input.state === "device" ? `adb:${adbSerial}` : ""));
    item.state = String(input.state || "unknown");
    item.model = String(input.model || item.model || "");
    item.manufacturer = String(input.manufacturer || item.manufacturer || "");
    item.brand = String(input.brand || item.brand || "");
    item.product = String(input.product || item.product || "");
    item.deviceName = String(input.deviceName || item.model || item.deviceName || adbSerial);
    item.transportId = String(input.transportId || item.transportId || "");
    item.androidVersion = String(input.androidVersion || item.androidVersion || "");
    item.batteryLevel = Number.isFinite(Number(input.batteryLevel)) ? Number(input.batteryLevel) : item.batteryLevel ?? null;
    if (Array.isArray(input.sims)) {
      const normalizedSims = normalizeSims(input.sims);
      if (normalizedSims.length || !(item.sims || []).length) {
        item.sims = mergeAdbSims(item.sims || [], normalizedSims, { source: "adb", updatedAt: nowIso() });
      }
    }
    item.automation = normalizeDeviceAutomation(input.automation || item.automation || {});
    item.recovery = normalizeDeviceRecovery(input.recovery || { state: item.state, physicalPresent: item.state !== "missing" });
    item.smsRelay = normalizeSmsRelayStatus({ ...(item.smsRelay || {}), ...(input.smsRelay || {}) });
    item.updatedAt = nowIso();
    if (item.state === "device") item.lastSeenAt = nowIso();
    updateAdbDeviceState(agent, item);

    if (item.deviceId && (item.state === "device" || item.recovery.physicalPresent)) {
      upsertAdbDevice(agent, item);
    }
    if (item.state === "device" && item.deviceId) {
      recordDeviceOnlineRuntime(item.deviceId, {
        agentId: agent.agentId,
        adbSerial,
        state: item.state,
        seenAt: item.lastSeenAt || item.updatedAt || nowIso()
      });
    }
  }
  // A full ADB scan is authoritative for this Windows manager.  The Agent can
  // restart with an empty in-memory device list, so relying only on
  // agent.devices would leave old records permanently shown as connected.
  for (const device of state.devices) {
    const serial = String(device.adb?.serial || "").trim();
    if (!serial || device.adb?.agentId !== agent.agentId || seen.has(serial.toUpperCase())) continue;
    device.adb = {
      ...(device.adb || {}),
      state: "missing",
      updatedAt: nowIso()
    };
    device.recovery = normalizeDeviceRecovery({ state: "physically_absent", physicalPresent: false, lastObservedAt: nowIso() });
    device.updatedAt = nowIso();
  }
  for (const device of agent.devices) {
    if (!seen.has(String(device.adbSerial || "").toUpperCase())) {
      device.state = "missing";
      device.recovery = normalizeDeviceRecovery({ state: "physically_absent", physicalPresent: false, lastObservedAt: nowIso() });
      device.updatedAt = nowIso();
      updateAdbDeviceState(agent, device);
    }
  }
  agent.updatedAt = nowIso();
  agent.lastSeenAt = nowIso();
}

function updateAdbDeviceState(agent, adbDevice) {
  const adbSerialKey = String(adbDevice.adbSerial || "").toUpperCase();
  const deviceIdKey = String(adbDevice.deviceId || "").toUpperCase();
  const device = state.devices.find((item) => (
    (adbSerialKey && String(item.adb?.serial || "").toUpperCase() === adbSerialKey)
    || (deviceIdKey && String(item.deviceId || "").toUpperCase() === deviceIdKey)
  ));
  if (!device) return;
  device.adb = {
    ...(device.adb || {}),
    agentId: agent.agentId,
    serial: adbDevice.adbSerial,
    state: adbDevice.state || "unknown",
    model: adbDevice.model || device.adb?.model || "",
    manufacturer: adbDevice.manufacturer || device.adb?.manufacturer || "",
    brand: adbDevice.brand || device.adb?.brand || "",
    product: adbDevice.product || device.adb?.product || "",
    transportId: adbDevice.transportId || device.adb?.transportId || "",
    lastSeenAt: adbDevice.state === "device" ? nowIso() : device.adb?.lastSeenAt || null,
    updatedAt: nowIso()
  };
  device.automation = normalizeDeviceAutomation(adbDevice.automation || device.automation || {});
  device.recovery = normalizeDeviceRecovery(adbDevice.recovery || { state: adbDevice.state, physicalPresent: adbDevice.state !== "missing" });
  device.smsRelay = normalizeSmsRelayStatus({ ...(device.smsRelay || {}), ...(adbDevice.smsRelay || {}) });
  device.updatedAt = nowIso();
}

function upsertAdbDevice(agent, adbDevice) {
  const adbSerialKey = String(adbDevice.adbSerial || "").toUpperCase();
  const deviceIdKey = String(adbDevice.deviceId || "").toUpperCase();
  let device = state.devices.find((item) => (
    (deviceIdKey && String(item.deviceId || "").toUpperCase() === deviceIdKey)
    || (adbSerialKey && String(item.adb?.serial || "").toUpperCase() === adbSerialKey)
  ));
  const defaultName = defaultAdbDeviceName(adbDevice);
  if (!device) {
    device = {
      deviceId: adbDevice.deviceId,
      deviceName: defaultName,
      deviceNameSource: "auto",
      deviceNameUpdatedAt: nowIso(),
      model: adbDevice.model || "",
      manufacturer: adbDevice.manufacturer || "",
      brand: adbDevice.brand || "",
      androidVersion: adbDevice.androidVersion || "",
      appVersion: "",
      batteryLevel: adbDevice.batteryLevel ?? null,
      listingStatus: "pending",
      listedAt: "",
      unlistedAt: "",
      adb: {},
      sims: [],
      xhsAccounts: [
        { appSlot: "app1", label: "小红书", xhsId: "", accountName: "", enabled: true },
        { appSlot: "app2", label: "Ⅱ·小红书", xhsId: "", accountName: "", enabled: true }
      ],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastSeenAt: null
    };
    state.devices.unshift(device);
  }
  device.model = adbDevice.model || device.model || "";
  device.manufacturer = adbDevice.manufacturer || device.manufacturer || "";
  device.brand = adbDevice.brand || device.brand || "";
  applyAdbDeviceName(device, adbDevice, nowIso());
  device.androidVersion = adbDevice.androidVersion || device.androidVersion || "";
  device.batteryLevel = adbDevice.batteryLevel ?? device.batteryLevel ?? null;
  if (Array.isArray(adbDevice.sims)) {
    const normalizedSims = normalizeSims(adbDevice.sims);
    if (normalizedSims.length || !(device.sims || []).length) {
      device.sims = mergeAdbSims(device.sims || [], normalizedSims, { source: "adb", updatedAt: nowIso() });
    }
  }
  device.automation = normalizeDeviceAutomation(adbDevice.automation || device.automation || {});
  device.recovery = normalizeDeviceRecovery(adbDevice.recovery || { state: adbDevice.state, physicalPresent: true });
  device.smsRelay = normalizeSmsRelayStatus({ ...(device.smsRelay || {}), ...(adbDevice.smsRelay || {}) });
  device.adb = {
    agentId: agent.agentId,
    serial: adbDevice.adbSerial,
    state: adbDevice.state,
    model: adbDevice.model || "",
    manufacturer: adbDevice.manufacturer || "",
    brand: adbDevice.brand || "",
    product: adbDevice.product || "",
    transportId: adbDevice.transportId || "",
    lastSeenAt: adbDevice.state === "device" ? nowIso() : device.adb?.lastSeenAt || null
  };
  device.updatedAt = nowIso();
}

function normalizeDeviceAutomation(input = {}) {
  return {
    ok: Boolean(input.ok),
    status: String(input.status || "unknown").slice(0, 80),
    checkedAt: String(input.checkedAt || "").slice(0, 80),
    airtestReady: Boolean(input.airtestReady),
    pocoReady: Boolean(input.pocoReady),
    yosemiteReady: Boolean(input.yosemiteReady),
    helpersReady: Boolean(input.helpersReady),
    xhsInstalled: Boolean(input.xhsInstalled),
    xhsPackageName: String(input.xhsPackageName || "").slice(0, 120),
    androidSdk: Number.isFinite(Number(input.androidSdk)) ? Number(input.androidSdk) : 0,
    phantomProcessLimit: String(input.phantomProcessLimit || "").slice(0, 80),
    phantomProcessConfigured: Boolean(input.phantomProcessConfigured),
    accessibilityServices: sanitizeStringList(input.accessibilityServices, 20, 240),
    accessibilityConflicts: sanitizeStringList(input.accessibilityConflicts, 20, 240),
    repairAction: String(input.repairAction || "").slice(0, 120),
    lastError: String(input.lastError || "").slice(0, 1000)
  };
}

function normalizeDeviceRecovery(input = {}) {
  return {
    state: String(input.state || "unknown").slice(0, 120),
    physicalPresent: Boolean(input.physicalPresent),
    rootProblem: String(input.rootProblem || "").slice(0, 160),
    adbInterfaceProblem: String(input.adbInterfaceProblem || "").slice(0, 160),
    lastObservedAt: String(input.lastObservedAt || "").slice(0, 80)
  };
}

function sanitizeStringList(value, maxItems = 20, maxLength = 240) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim().slice(0, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function upsertPhoneAgentDevice(input = {}) {
  const deviceId = String(input.deviceId || "").trim();
  if (!deviceId) {
    const error = new Error("deviceId is required");
    error.statusCode = 400;
    throw error;
  }
  let device = state.devices.find((item) => item.deviceId === deviceId);
  if (!device) {
    device = { deviceId, sims: [], xhsAccounts: [], adb: {}, createdAt: nowIso() };
    state.devices.unshift(device);
  }
  applyPhoneAgentDeviceName(device, input.deviceName, nowIso());
  device.model = String(input.model || device.model || "");
  device.androidVersion = String(input.androidVersion || device.androidVersion || "");
  device.appVersion = String(input.appVersion || device.appVersion || "");
  device.batteryLevel = Number.isFinite(Number(input.batteryLevel)) ? Number(input.batteryLevel) : device.batteryLevel ?? null;
  device.smsRelay = normalizeSmsRelayStatus({ ...(device.smsRelay || {}), ...(input.smsRelay || {}) });
  device.lastSeenAt = nowIso();
  device.updatedAt = nowIso();
  if (Array.isArray(input.sims)) {
    device.sims = mergeAdbSims(device.sims || [], normalizeSims(input.sims), {
      source: "phone_agent",
      updatedAt: nowIso()
    });
  }
  mergeLegacyAndroidIdDevices(device);
  return device;
}

function normalizeSmsRelayStatus(input = {}) {
  return {
    installed: Boolean(input.installed),
    collectionMode: String(input.collectionMode || (input.installed ? "health_only" : "legacy_windows")).slice(0, 80),
    checkedAt: String(input.checkedAt || "").slice(0, 80),
    status: String(input.status || "unknown").slice(0, 80),
    error: String(input.error || "").slice(0, 500),
    defaultSmsApp: Boolean(input.defaultSmsApp),
    serviceAlive: Boolean(input.serviceAlive),
    receiveSmsGranted: Boolean(input.receiveSmsGranted),
    readSmsGranted: Boolean(input.readSmsGranted),
    notificationAccessGranted: Boolean(input.notificationAccessGranted),
    batteryOptimizationIgnored: Boolean(input.batteryOptimizationIgnored),
    oppoLike: Boolean(input.oppoLike),
    defaultSmsPackage: String(input.defaultSmsPackage || "").slice(0, 160),
    lastSyncStatus: String(input.lastSyncStatus || "unknown").slice(0, 80),
    lastSyncError: String(input.lastSyncError || "").slice(0, 500),
    lastSyncAt: Number.isFinite(Number(input.lastSyncAt)) ? Number(input.lastSyncAt) : 0,
    lastSyncCount: Number.isFinite(Number(input.lastSyncCount)) ? Math.max(0, Number(input.lastSyncCount)) : 0,
    lastReceiveAt: Number.isFinite(Number(input.lastReceiveAt)) ? Number(input.lastReceiveAt) : 0,
    lastNotificationFallbackAt: Number.isFinite(Number(input.lastNotificationFallbackAt)) ? Number(input.lastNotificationFallbackAt) : 0,
    lastServiceAliveAt: Number.isFinite(Number(input.lastServiceAliveAt)) ? Math.max(0, Number(input.lastServiceAliveAt)) : 0,
    pendingUploadCount: boundedMetric(input.pendingUploadCount, 0, 1_000_000, 0),
    localMessageCount: boundedMetric(input.localMessageCount, 0, 10_000_000, 0),
    providerWriteFailureCount: boundedMetric(input.providerWriteFailureCount, 0, 1_000_000, 0),
    oldestPendingUploadAgeMillis: boundedMetric(input.oldestPendingUploadAgeMillis, 0, Number.MAX_SAFE_INTEGER, 0),
    nextUploadRetryInMillis: boundedMetric(input.nextUploadRetryInMillis, 0, Number.MAX_SAFE_INTEGER, 0)
  };
}

function mergeLegacyAndroidIdDevices(canonical) {
  if (!canonical || !String(canonical.deviceId || "").startsWith("adb:")) return;
  const canonicalPhones = new Set((canonical.sims || []).map((sim) => sim.phoneNumber).filter(Boolean));
  if (!canonicalPhones.size) return;
  const legacyDevices = state.devices.filter((device) => {
    if (!device || device === canonical) return false;
    if (String(device.deviceId || "").startsWith("adb:")) return false;
    if (device.adb?.serial) return false;
    if (canonical.model && device.model && canonical.model !== device.model) return false;
    return (device.sims || []).some((sim) => sim.phoneNumber && canonicalPhones.has(sim.phoneNumber));
  });
  for (const legacy of legacyDevices) {
    reassignSmsMessages(legacy.deviceId, canonical.deviceId);
    state.smsEvents.forEach((event) => {
      if (event.deviceId === legacy.deviceId) event.deviceId = canonical.deviceId;
    });
    state.xhsQrTasks.forEach((task) => {
      if (task.deviceId === legacy.deviceId) task.deviceId = canonical.deviceId;
    });
    state.devices = state.devices.filter((device) => device !== legacy);
    addAudit("device_legacy_merge", { role: "system" }, { fromDeviceId: legacy.deviceId, toDeviceId: canonical.deviceId });
  }
}

function reassignSmsMessages(fromDeviceId, toDeviceId) {
  if (!Array.isArray(state.smsMessages) || !fromDeviceId || !toDeviceId || fromDeviceId === toDeviceId) return;
  let changed = false;
  const seen = new Map();
  for (const message of state.smsMessages) {
    if (message.deviceId === toDeviceId && message.messageKey) seen.set(message.messageKey, message);
  }
  const remove = new Set();
  for (const message of state.smsMessages) {
    if (message.deviceId !== fromDeviceId) continue;
    const key = message.messageKey || "";
    const duplicate = key ? seen.get(key) : null;
    if (duplicate) {
      Object.assign(duplicate, message, {
        deviceId: toDeviceId,
        messageId: duplicate.messageId,
        createdAt: duplicate.createdAt || message.createdAt,
        updatedAt: nowIso()
      });
      remove.add(message);
      changed = true;
    } else {
      message.deviceId = toDeviceId;
      message.updatedAt = nowIso();
      if (key) seen.set(key, message);
      changed = true;
    }
  }
  if (remove.size) state.smsMessages = state.smsMessages.filter((message) => !remove.has(message));
  if (changed) smsMessageIndex.replace(state.smsMessages);
}

function normalizeSims(sims) {
  return (Array.isArray(sims) ? sims : [])
    .map((sim, index) => ({
      subscriptionId: Number.isFinite(Number(sim.subscriptionId)) ? Number(sim.subscriptionId) : index,
      slotIndex: Number.isFinite(Number(sim.slotIndex)) ? Number(sim.slotIndex) : index,
      carrierName: String(sim.carrierName || ""),
      phoneNumber: normalizePhone(sim.phoneNumber || sim.number || ""),
      phoneNumberSource: normalizeSimPhoneSource(sim.phoneNumberSource),
      phoneNumberUpdatedAt: normalizeIsoTime(sim.phoneNumberUpdatedAt),
      label: String(sim.label || ""),
      enabled: sim.enabled !== false
    }))
    .slice(0, 4);
}

function mergeAdbSims(existingSims = [], adbSims = [], options = {}) {
  return mergeReportedSims(normalizeSims(existingSims), normalizeSims(adbSims), options);
}

function normalizeXhsAccounts(accounts) {
  const normalized = (Array.isArray(accounts) ? accounts : [])
    .map((account, index) => ({
      appSlot: normalizeXhsAppSlot(account.appSlot || (index === 1 ? "app2" : "app1")),
      label: String(account.label || (index === 1 ? "Ⅱ·小红书" : "小红书")),
      xhsId: normalizeXhsId(account.xhsId || account.accountId || ""),
      accountName: String(account.accountName || account.xhsAccount || ""),
      enabled: account.enabled !== false
    }))
    .slice(0, 2);
  for (const slot of ["app1", "app2"]) {
    if (!normalized.some((item) => item.appSlot === slot)) {
      normalized.push({ appSlot: slot, label: slot === "app2" ? "Ⅱ·小红书" : "小红书", xhsId: "", accountName: "", enabled: true });
    }
  }
  return normalized.sort((a, b) => a.appSlot.localeCompare(b.appSlot));
}

function normalizeXhsAppSlot(value = "") {
  return String(value || "").trim() === "app2" ? "app2" : "app1";
}

function createSmsOrder(input = {}) {
  const createdAt = nowIso();
  const order = {
    orderId: newId(),
    userId: String(input.userId || ""),
    source: String(input.source || "admin"),
    deviceId: String(input.deviceId || ""),
    phoneNumber: normalizePhone(input.phoneNumber),
    subscriptionId: normalizeOptionalInt(input.subscriptionId),
    slotIndex: normalizeOptionalInt(input.slotIndex),
    platform: normalizePlatform(input.platform || "小红书"),
    matchMode: String(input.matchMode || "first_new_sms"),
    clientId: String(input.clientId || ""),
    idempotencyKey: String(input.idempotencyKey || ""),
    status: "waiting",
    code: "",
    smsEventId: "",
    smsMessageId: "",
    sender: "",
    body: "",
    matchedAt: "",
    createdAt,
    startedAt: normalizeIsoTime(input.startedAt) || createdAt,
    updatedAt: createdAt,
    expiresAt: new Date(Date.now() + SMS_ORDER_TTL_MS).toISOString()
  };
  state.smsOrders.unshift(order);
  queueSmsOrderProbe(order, { force: true });
  return order;
}

function createXhsQrTask(input = {}) {
  const qrImageDataUrl = normalizeQrImageDataUrl(input.qrImageDataUrl);
  const xhsAppSlot = normalizeXhsAppSlot(input.xhsAppSlot);
  const workflowScript = attachXhsWorkflowScript(input.workflowScript, xhsAppSlot);
  if (workflowScript.enabled === false) throw badRequest("workflow_script_disabled");
  const task = {
    taskId: newId(),
    userId: String(input.userId || ""),
    source: String(input.source || "admin"),
    deviceId: String(input.deviceId || ""),
    xhsAppSlot,
    xhsAccountLabel: String(input.xhsAccountLabel || (xhsAppSlot === "app2" ? "Ⅱ·小红书" : "小红书")),
    xhsAccountId: normalizeXhsId(input.xhsAccountId),
    xhsAccountName: String(input.xhsAccountName || ""),
    platform: "小红书",
    executionMode: String(input.executionMode || "windows_airtest_poco"),
    windowsTaskId: String(input.windowsTaskId || ""),
    agentId: String(input.agentId || ""),
    adbSerial: String(input.adbSerial || ""),
    status: "queued",
    qrImageDataUrl,
    workflowScript,
    result: {},
    events: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    pickedAt: null,
    completedAt: null
  };
  state.xhsQrTasks.unshift(task);
  return task;
}

function publicDataCollectionJobSummary(job) {
  const task = publicAutomationJob(job);
  if (task.result?.collection) {
    const { notes, recovery_events, ...summary } = task.result.collection;
    task.result = { ...task.result, collection: { ...summary, note_count: notes.length } };
  }
  return task;
}

function createAutomationJob(input = {}) {
  const kind = normalizeAutomationKind(input.kind);
  const createdAt = nowIso();
  const job = {
    jobId: newId(),
    kind,
    userId: String(input.userId || ""),
    deviceId: String(input.deviceId || ""),
    sessionId: String(input.sessionId || ""),
    xhsAppSlot: input.xhsAppSlot ? normalizeXhsAppSlot(input.xhsAppSlot) : "",
    xhsAccountLabel: String(input.xhsAccountLabel || ""),
    xhsAccountId: normalizeXhsId(input.xhsAccountId),
    xhsAccountName: String(input.xhsAccountName || ""),
    title: String(input.title || ""),
    content: String(input.content || ""),
    imageDataUrls: Array.isArray(input.imageDataUrls) ? input.imageDataUrls : [],
    phoneNumber: String(input.phoneNumber || ""),
    minDelaySeconds: Math.max(0, Number(input.minDelaySeconds || 0)),
    maxDelaySeconds: Math.max(0, Number(input.maxDelaySeconds || 0)),
    resultId: String(input.resultId || ""),
    resumeAfterHumanVerification: input.resumeAfterHumanVerification === true,
    restartAfterHumanVerification: input.restartAfterHumanVerification === true,
    accountAction: String(input.accountAction || ""),
    targetAccount: String(input.targetAccount || ""),
    successfulCountBefore: Math.max(0, Number(input.successfulCountBefore || 0)),
    windowsTaskId: "",
    agentId: "",
    adbSerial: "",
    status: "queued",
    result: {},
    events: [],
    createdAt,
    updatedAt: createdAt,
    pickedAt: null,
    completedAt: null
  };
  state.automationJobs.unshift(job);
  return job;
}

function publicLookupSession(session = {}) {
  const device = repos.devices.findById(session.deviceId);
  const cooldowns = publicLookupAccountCooldowns(device);
  const view = buildPublicLookupSession(session);
  return { ...view, accountIdentityVerified: session.accountIdentityVerified === true,
    savedAccounts: session.savedAccounts || [],
    accountCooldowns: cooldowns,
    accountChoices: view.accountChoices.map((choice) => ({ ...choice,
      ...(cooldowns.find((row) => row.account === choice.account) || { cooling: false, remainingMs: 0 })
    })) };
}

function createLookupSession(input = {}) {
  const createdAt = nowIso();
  const session = {
    sessionId: newId(),
    userId: String(input.userId || ""),
    deviceId: String(input.deviceId || ""),
    status: "starting",
    successfulCount: 0,
    currentAccount: "",
    accountIdentityVerified: false,
    accountQueryStarted: false,
    savedAccounts: [],
    requiresAccountSwitch: false,
    limitReason: "",
    automationHaltReason: "",
    lastAccountSwitch: null,
    accountChoices: [],
    restrictionHistory: [],
    pendingJobId: "",
    lockId: "",
    results: [],
    error: "",
    createdAt,
    updatedAt: createdAt,
    endedAt: null
  };
  state.automationSessions.unshift(session);
  return session;
}

function acquireAutomationDeviceLock(device, job, ctx = { role: "system" }, options = {}) {
  if (!device || !job) return null;
  expireDeviceLocks();
  const conflict = activeDeviceLockForTask(device.deviceId);
  if (conflict) {
    const error = badRequest("device_busy");
    error.statusCode = 409;
    error.detail = publicDeviceLock(conflict);
    throw error;
  }
  const createdAt = nowIso();
  const lock = {
    lockId: newId(),
    lockType: automationLockType(job.kind),
    deviceId: device.deviceId,
    appSlot: job.xhsAppSlot || "",
    ownerUserId: job.userId || "",
    taskId: String(options.taskId || job.jobId),
    status: "active",
    createdAt,
    updatedAt: createdAt,
    expiresAt: new Date(Date.now() + Math.max(60_000, Number(options.ttlMs || XHS_TASK_TTL_MS))).toISOString(),
    releasedAt: "",
    releaseReason: ""
  };
  state.deviceLocks.unshift(lock);
  job.lockId = lock.lockId;
  runtimeStore.setNxEx(`lock:device:${lock.deviceId}`, JSON.stringify(publicDeviceLock(lock)), Math.ceil((Number(options.ttlMs || XHS_TASK_TTL_MS)) / 1000)).catch(() => {});
  addAudit("device_lock_acquire", ctx, { lockId: lock.lockId, lockType: lock.lockType, deviceId: lock.deviceId, taskId: lock.taskId });
  return lock;
}

function releaseAutomationLock(jobOrSession, reason = "completed") {
  const lockId = String(jobOrSession?.lockId || "");
  const taskId = String(jobOrSession?.sessionId || jobOrSession?.jobId || "");
  const lock = (state.deviceLocks || []).find((item) => item.status === "active" && ((lockId && item.lockId === lockId) || (taskId && item.taskId === taskId)));
  if (!lock) return null;
  lock.status = "released";
  lock.updatedAt = nowIso();
  lock.releasedAt = lock.updatedAt;
  lock.releaseReason = reason;
  releaseRuntimeDeviceLock(lock);
  return lock;
}

function snapshotWindowsTaskClaim(task) {
  const xhsTaskId = String(task?.payload?.xhsTaskId || "");
  const automationJobId = String(task?.payload?.automationJobId || "");
  const xhsTask = xhsTaskId ? state.xhsQrTasks.find((item) => item.taskId === xhsTaskId) || null : null;
  const automationJob = automationJobId ? state.automationJobs.find((item) => item.jobId === automationJobId) || null : null;
  const automationSession = automationJob?.sessionId
    ? state.automationSessions.find((item) => item.sessionId === automationJob.sessionId) || null
    : null;
  const deviceLock = automationJob?.lockId
    ? (state.deviceLocks || []).find((item) => item.lockId === automationJob.lockId) || null
    : null;
  return {
    records: [task, xhsTask, automationJob, automationSession, deviceLock]
      .filter(Boolean)
      .map((record) => ({ record, snapshot: structuredClone(record) })),
    audit: state.audit
  };
}

function restoreWindowsTaskClaim(claimSnapshot) {
  for (const entry of claimSnapshot?.records || []) {
    for (const key of Object.keys(entry.record)) delete entry.record[key];
    Object.assign(entry.record, structuredClone(entry.snapshot));
  }
  if (claimSnapshot?.audit) state.audit = claimSnapshot.audit;
}

function renewAutomationLock(job, ttlMs = AUTOMATION_SESSION_TTL_MS) {
  const lockId = String(job?.lockId || "");
  if (!lockId) return null;
  const lock = (state.deviceLocks || []).find((item) => item.lockId === lockId && item.status === "active");
  if (!lock) return null;
  const boundedTtlMs = Math.max(60_000, Number(ttlMs || AUTOMATION_SESSION_TTL_MS));
  lock.updatedAt = nowIso();
  lock.expiresAt = new Date(Date.now() + boundedTtlMs).toISOString();
  runtimeStore.setEx(
    `lock:device:${lock.deviceId}`,
    JSON.stringify(publicDeviceLock(lock)),
    Math.ceil(boundedTtlMs / 1000)
  ).catch(() => {});
  return lock;
}

function finishLookupSession(session, status, reason = "") {
  session.status = status;
  delete session.startupHumanVerification;
  if (session.limitReason === "jigsaw_verification") session.limitReason = "";
  session.pendingJobId = "";
  session.error = status === "failed" ? String(reason || "lookup_session_failed") : "";
  session.updatedAt = nowIso();
  session.endedAt = session.updatedAt;
  releaseAutomationLock(session, reason || status);
  return session;
}

async function drainPendingLookupQueryBeforeStop(session, graceMs = 1_800) {
  const isPendingQuery = (job) => String(job?.kind || "") === "alipay_name_query"
    && ["submitting", "queued", "running"].includes(String(job?.status || ""));
  const initial = session?.pendingJobId
    ? state.automationJobs.find((job) => job.jobId === session.pendingJobId)
    : null;
  if (!isPendingQuery(initial)) return initial;
  const deadline = Date.now() + Math.max(0, Number(graceMs || 0));
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const current = session?.pendingJobId
      ? state.automationJobs.find((job) => job.jobId === session.pendingJobId)
      : null;
    if (!isPendingQuery(current)) return current;
  }
  return session?.pendingJobId
    ? state.automationJobs.find((job) => job.jobId === session.pendingJobId)
    : null;
}

function upsertLookupResult(session, job, patch = {}) {
  if (!session || !job?.jobId) return null;
  if (!Array.isArray(session.results)) session.results = [];
  const resultId = String(job.resultId || job.jobId);
  let result = session.results.find((item) => item.resultId === resultId);
  if (!result) {
    result = {
      resultId,
      phoneNumber: String(job.phoneNumber || ""),
      name: "",
      realNameTailCharacter: "",
      status: "queued",
      stage: "查询任务已提交",
      createdAt: job.createdAt || nowIso(),
      updatedAt: job.updatedAt || job.createdAt || nowIso()
    };
    session.results.unshift(result);
  }
  if (job.kind === "alipay_name_query" && patch.accountSwitchCount !== undefined) {
    // Capture the preceding attempts once per job. Replayed terminal reports
    // remain idempotent; retaining/pruning old jobs cannot reset this total.
    if (job.lookupResultAccountSwitchBaseCount === undefined) {
      job.lookupResultAccountSwitchBaseCount = Math.max(0, Number(result.accountSwitchCount) || 0);
    }
    const count = job.lookupResultAccountSwitchBaseCount + Math.max(0, Number(patch.accountSwitchCount) || 0);
    patch = { ...patch, accountSwitchCount: count,
      accountSwitched: Boolean(count || patch.accountSwitched),
      accountSwitchReason: patch.accountSwitchReason || result.accountSwitchReason || "" };
  }
  Object.assign(result, patch, { updatedAt: patch.updatedAt || job.updatedAt || nowIso() });
  if (session.source !== "open-api") session.results = session.results.slice(0, 500);
  return result;
}

function lookupProgressStage(event = {}) {
  const step = String(event.stepId || event.detail?.stepId || "");
  if (step === "clear_previous_query") return "正在清空上一次号码";
  if (step === "input_phone") return "号码已输入，正在搜索";
  if (step === "submit_search") return "已确认搜索，正在等待结果";
  if (step === "retry_search_result") return "结果暂未返回，正在重新提交一次";
  if (step === "lookup_no_name_result") {
    return event.detail?.reason === "account_not_real_named"
      ? "已识别支付宝账户未实名，正在返回"
      : "该号码未查询到姓名结果";
  }
  if (step === "alipay_access_denied_detected" || step === "alipay_account_restriction_detected") {
    return event.detail?.accountSwitchRequired
      ? "已检测到当前账号查询受限，正在返回切号提示"
      : "查询前已存在限制页面，正在返回诊断";
  }
  if (step === "human_verification_detected") return "检测到滑动验证，正在自动处理";
  if (step === "human_verification_slider_drag") return "正在拖动验证滑块";
  if (step === "human_verification_retry") return "滑块未通过，正在重试";
  if (step === "human_verification_passed") return "滑块验证已通过";
  if (step === "human_verification_failed") return "滑块自动验证未通过";
  if (step === "replay_query_after_human_verification") return "验证通过，正在重新提交当前号码";
  if (step === "open_my_tab" || step === "open_settings" || step === "open_saved_account_picker") return "正在读取支付宝已保存账号";
  if (step === "reuse_open_account_picker") return "已复用当前账号页，正在切换指定账号";
  if (step === "reuse_open_account_picker_failed") return "账号页已变化，正在重新读取";
  if (step === "account_selected") return "已选择新账号，正在等待支付宝返回首页";
  if (step === "account_selection_returned_home") return "账号切换已返回首页，正在恢复查询页";
  if (step === "account_switch_verified") return "支付宝账号切换完成，正在继续查询";
  if (step === "query_full_path_recovery") return "页面状态异常，正在自动恢复";
  if (step === "launch_alipay") return "正在重新打开支付宝";
  if (step === "open_search") return "正在进入支付宝搜索页";
  if (step === "masked_real_name_tail_extracted") return "已识别结果，正在返回";
  if (step === "error" || event.level === "error") return "查询失败，正在收集诊断";
  if (event.phase === "start") return "Windows 管理器正在执行";
  if (event.phase === "alipay_name") return "正在准备支付宝查询";
  return "正在查询";
}

function acquireDeviceTaskLock(device, task, ctx = { role: "system" }) {
  if (!device || !task) return null;
  if (!Array.isArray(state.deviceLocks)) state.deviceLocks = [];
  expireDeviceLocks();
  const conflict = activeDeviceLockForTask(task.deviceId, task.xhsAppSlot);
  if (conflict) {
    const error = badRequest("device_busy");
    error.statusCode = 409;
    error.detail = publicDeviceLock(conflict);
    throw error;
  }
  const createdAt = nowIso();
  const lock = {
    lockId: newId(),
    lockType: "xhs_qr",
    deviceId: task.deviceId,
    appSlot: normalizeXhsAppSlot(task.xhsAppSlot || "app1"),
    ownerUserId: task.userId || "",
    taskId: task.taskId,
    status: "active",
    createdAt,
    updatedAt: createdAt,
    expiresAt: new Date(Date.now() + XHS_TASK_TTL_MS).toISOString(),
    releasedAt: "",
    releaseReason: ""
  };
  state.deviceLocks.unshift(lock);
  task.lockId = lock.lockId;
  runtimeStore.setNxEx(`lock:device:${lock.deviceId}`, JSON.stringify(publicDeviceLock(lock)), Math.ceil(XHS_TASK_TTL_MS / 1000)).catch(() => {});
  addAudit("device_lock_acquire", ctx, { lockId: lock.lockId, deviceId: lock.deviceId, appSlot: lock.appSlot, taskId: task.taskId });
  return lock;
}

function releaseDeviceTaskLock(task, reason = "completed") {
  if (!task || !Array.isArray(state.deviceLocks)) return null;
  const lock = state.deviceLocks.find((item) => item.taskId === task.taskId && item.status === "active");
  if (!lock) return null;
  lock.status = "released";
  lock.updatedAt = nowIso();
  lock.releasedAt = lock.updatedAt;
  lock.releaseReason = reason;
  releaseRuntimeDeviceLock(lock);
  return lock;
}

function managedLookupReservationLock(deviceId) {
  const c=managedLookup?.reserved(deviceId);if(!c)return null;
  const session=state.automationSessions.find(s=>s.sessionId===c.sessionId);
  return {lockId:session?.lockId||c.generation,lockType:'alipay_name_lookup',deviceId,status:'active',taskId:c.sessionId,ownerUserId:session?.userId||'',managedLookupGeneration:c.generation};
}

function activeDeviceLockForTask(deviceId = "", xhsAppSlot = "") {
  expireDeviceLocks();
  const normalizedSlot = xhsAppSlot ? normalizeXhsAppSlot(xhsAppSlot) : "";
  return (state.deviceLocks || []).find((lock) => (
    lock.status === "active"
    && lock.deviceId === deviceId
    && (lock.lockType !== "xhs_qr" || DEVICE_MAX_ACTIVE_XHS_TASKS <= 1 || !normalizedSlot || !lock.appSlot || lock.appSlot === normalizedSlot)
  )) || (typeof managedLookup!=="undefined" && managedLookup ? managedLookupReservationLock(deviceId) : null);
}

function activeDeviceLockForScreenControl(deviceId = "", ownerUserId = "", options = {}) {
  expireDeviceLocks();
  const locks = (state.deviceLocks || []).filter((lock) => (
    lock.status === "active" && lock.deviceId === deviceId
  ));
  if(!locks.length && typeof managedLookup!=="undefined" && managedLookup?.reserved(deviceId)) locks.push(managedLookupReservationLock(deviceId));
  const conflict = findScreenControlLockConflict(locks, deviceId, ownerUserId, options);
  if (conflict) return conflict;
  const lookupLock = locks.find((lock) => canShareDeviceLockWithScreenControl(lock, ownerUserId, options));
  if (!lookupLock) return null;
  const lookupSession = (state.automationSessions || []).find((session) => session.sessionId === lookupLock.taskId) || null;
  return canShareLookupSessionWithScreenControl(lookupLock, ownerUserId, lookupSession, options) ? null : lookupLock;
}

function acquireDeviceScreenLock(device, session, ctx = { role: "system" }) {
  if (!Array.isArray(state.deviceLocks)) state.deviceLocks = [];
  expireDeviceLocks();
  const conflict = activeDeviceLockForScreenControl(device.deviceId, session.userId, {
    allowAdminOverride: ctx.role === "admin"
  });
  if (conflict) {
    const error = badRequest("device_busy");
    error.statusCode = 409;
    error.detail = publicDeviceLock(conflict);
    throw error;
  }
  const createdAt = nowIso();
  const lock = {
    lockId: newId(),
    lockType: "screen_control",
    deviceId: device.deviceId,
    appSlot: "",
    ownerUserId: session.userId,
    taskId: session.sessionId,
    status: "active",
    createdAt,
    updatedAt: createdAt,
    expiresAt: session.expiresAt,
    releasedAt: "",
    releaseReason: ""
  };
  state.deviceLocks.unshift(lock);
  runtimeStore.setNxEx(`lock:device:${lock.deviceId}`, JSON.stringify(publicDeviceLock(lock)), Math.ceil(SCREEN_SESSION_TTL_MS / 1000)).catch(() => {});
  addAudit("device_lock_acquire", ctx, { lockId: lock.lockId, deviceId: lock.deviceId, sessionId: session.sessionId, lockType: lock.lockType });
  return lock;
}

function releaseDeviceScreenLock(sessionId, reason = "completed") {
  const lock = (state.deviceLocks || []).find((item) => item.lockType === "screen_control" && item.taskId === sessionId && item.status === "active");
  if (!lock) return null;
  lock.status = "released";
  lock.updatedAt = nowIso();
  lock.releasedAt = lock.updatedAt;
  lock.releaseReason = reason;
  releaseRuntimeDeviceLock(lock);
  return lock;
}

function releaseOrphanedScreenLocksAfterRestart() {
  let changed = false;
  for (const lock of state.deviceLocks || []) {
    if (lock.lockType !== "screen_control" || lock.status !== "active") continue;
    lock.status = "released";
    lock.updatedAt = nowIso();
    lock.releasedAt = lock.updatedAt;
    lock.releaseReason = "server_restart";
    releaseRuntimeDeviceLock(lock);
    changed = true;
  }
  return changed;
}

function expireDeviceLocks() {
  if (!Array.isArray(state.deviceLocks)) state.deviceLocks = [];
  const now = Date.now();
  let changed = false;
  for (const lock of state.deviceLocks) {
    if (lock.status !== "active") continue;
    if (lock.managedLookupGeneration && managedLookup?.reserved(lock.deviceId)) continue;
    if (lock.lockType === "kuaishou_lead") {
      const job = (state.automationJobs || []).find((item) => item.jobId === lock.taskId);
      const windowsTask = job?.windowsTaskId ? (state.windowsTasks || []).find((item) => item.taskId === job.windowsTaskId) : null;
      if (job && isActiveAutomationStatus(job.status) && windowsTask && ["queued", "running", "stalled"].includes(windowsTask.status)) {
        continue;
      }
      if (job && !isActiveAutomationStatus(job.status)) {
        lock.status = "released";
        lock.releasedAt = job.completedAt || nowIso();
        lock.releaseReason = job.status || "task_terminal";
        lock.updatedAt = nowIso();
        releaseRuntimeDeviceLock(lock);
        changed = true;
        continue;
      }
    }
    const task = state.xhsQrTasks.find((item) => item.taskId === lock.taskId);
    if (task && !isActiveXhsTask(task)) {
      lock.status = "released";
      lock.releasedAt = task.completedAt || nowIso();
      lock.releaseReason = task.status || "task_terminal";
      lock.updatedAt = nowIso();
      releaseRuntimeDeviceLock(lock);
      changed = true;
      continue;
    }
    if (toTime(lock.expiresAt) && toTime(lock.expiresAt) <= now) {
      lock.status = "expired";
      lock.releasedAt = nowIso();
      lock.releaseReason = "lock_timeout";
      lock.updatedAt = lock.releasedAt;
      releaseRuntimeDeviceLock(lock);
      changed = true;
    }
  }
  return changed;
}

function publicDeviceLock(lock) {
  if (!lock) return null;
  return {
    lockId: lock.lockId,
    lockType: lock.lockType,
    deviceId: lock.deviceId,
    appSlot: lock.appSlot || "",
    taskId: lock.taskId || "",
    ownerUserId: lock.ownerUserId || "",
    status: lock.status || "",
    expiresAt: lock.expiresAt || ""
  };
}

function publicAdminDeviceLock(lock) {
  if (!lock) return null;
  const device = state.devices.find((item) => item.deviceId === lock.deviceId);
  const task = state.xhsQrTasks.find((item) => item.taskId === lock.taskId);
  const owner = state.users.find((item) => item.userId === lock.ownerUserId);
  return {
    ...publicDeviceLock(lock),
    status: lock.status || "",
    deviceName: device?.deviceName || device?.deviceId || lock.deviceId || "",
    ownerUsername: owner?.username || "",
    taskStatus: task?.status || "",
    taskCreatedAt: task?.createdAt || "",
    createdAt: lock.createdAt || "",
    updatedAt: lock.updatedAt || "",
    releasedAt: lock.releasedAt || "",
    releaseReason: lock.releaseReason || ""
  };
}

function createWindowsAgentTask(input = {}) {
  const task = {
    taskId: newId(),
    agentId: String(input.agentId || ""),
    adbSerial: String(input.adbSerial || ""),
    deviceId: String(input.deviceId || ""),
    type: String(input.type || ""),
    status: "queued",
    payload: input.payload || {},
    result: {},
    events: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    pickedAt: null,
    completedAt: null
  };
  state.windowsTasks.unshift(task);
  return task;
}

function checkUserSmsRefreshRate(userId, deviceId, source = "") {
  if (!Array.isArray(state.smsLibraryRefreshes)) state.smsLibraryRefreshes = [];
  const policy = smsRefreshRatePolicy(source, {
    manualCooldownMs: USER_SMS_REFRESH_COOLDOWN_MS,
    autoCooldownMs: USER_SMS_AUTO_REFRESH_COOLDOWN_MS
  });
  const key = `${String(userId || "")}:${String(deviceId || "")}:${policy.scope}`;
  const now = Date.now();
  const retentionMs = Math.max(USER_SMS_REFRESH_COOLDOWN_MS, USER_SMS_AUTO_REFRESH_COOLDOWN_MS) * 2;
  state.smsLibraryRefreshes = state.smsLibraryRefreshes.filter((item) => now - Number(item.at || 0) < retentionMs);
  const previous = state.smsLibraryRefreshes.find((item) => item.key === key);
  if (previous && now - Number(previous.at || 0) < policy.cooldownMs) {
    return { ok: false, retryAfterMs: policy.cooldownMs - (now - Number(previous.at || 0)) };
  }
  if (previous) previous.at = now;
  else state.smsLibraryRefreshes.push({ key, userId: String(userId || ""), deviceId: String(deviceId || ""), scope: policy.scope, at: now });
  return { ok: true, retryAfterMs: 0 };
}

function findActiveSmsSyncTask(device) {
  const agentId = device?.adb?.agentId || "";
  const adbSerial = device?.adb?.serial || "";
  return state.windowsTasks.find((task) => (
    task.type === "sms_sync_now"
    && task.agentId === agentId
    && task.adbSerial === adbSerial
    && ["queued", "running"].includes(task.status)
  )) || null;
}

function queueSmsOrderProbe(order, options = {}) {
  const device = order?.deviceId ? repos.devices.findById(order.deviceId) : null;
  const decision = smsOrderProbeDecision({
    order,
    device,
    tasks: state.windowsTasks,
    nowMs: Date.now(),
    intervalMs: SMS_ORDER_PROBE_INTERVAL_MS,
    force: options.force === true
  });
  if (!decision.queue) return null;
  const queuedAt = nowIso();
  const task = createWindowsAgentTask({
    agentId: decision.agentId,
    adbSerial: decision.adbSerial,
    deviceId: device.deviceId,
    type: "sms_code_probe",
    payload: {
      smsOrderId: order.orderId,
      source: "sms_order_wait",
      requestedAt: queuedAt,
      subscriptionId: order.subscriptionId,
      slotIndex: order.slotIndex
    }
  });
  order.smsProbeLastQueuedAt = queuedAt;
  order.smsProbeAttempts = Math.max(0, Number(order.smsProbeAttempts || 0)) + 1;
  return task;
}

function ensureWaitingSmsOrderProbes(predicate = null) {
  let queued = 0;
  for (const order of state.smsOrders) {
    if (order.status !== "waiting") continue;
    if (typeof predicate === "function" && !predicate(order)) continue;
    if (queueSmsOrderProbe(order)) queued += 1;
  }
  return queued;
}

function queueDeviceAgentWake(device, ctx = { role: "system" }) {
  if (!device || isDeviceAgentOnline(device)) return null;
  const agentId = String(device.adb?.agentId || "");
  const adbSerial = String(device.adb?.serial || "");
  if (!agentId || !adbSerial || !isAdbOnline(device)) return null;
  const pending = state.windowsTasks.find((task) =>
    task.agentId === agentId
    && task.adbSerial === adbSerial
    && task.type === "adb_start_agent"
    && ["queued", "running"].includes(task.status)
  );
  if (pending) return pending;
  const task = createWindowsAgentTask({
    agentId,
    adbSerial,
    deviceId: device.deviceId,
    type: "adb_start_agent",
    payload: {
      deviceId: device.deviceId,
      deviceName: device.deviceName || device.deviceId
    }
  });
  addAudit("windows_agent_autowake_queued", ctx, { agentId, adbSerial, deviceId: device.deviceId, taskId: task.taskId });
  return task;
}

function queueXhsAirtestWindowsTask(device, xhsTask, ctx = { role: "system" }) {
  if (!device || !xhsTask) return null;
  const agentId = String(device.adb?.agentId || "");
  const adbSerial = String(device.adb?.serial || "");
  if (!agentId || !adbSerial || !isAdbOnline(device)) return null;
  const executionMode = XHS_XML_UIAUTOMATOR_SERIALS.has(adbSerial)
    ? "windows_xml_uiautomator"
    : "windows_airtest_poco";
  const workflowScript = attachXhsWorkflowScript(xhsTask.workflowScript, xhsTask.xhsAppSlot || "app1");
  xhsTask.workflowScript = workflowScript;
  xhsTask.executionMode = executionMode;
  xhsTask.agentId = agentId;
  xhsTask.adbSerial = adbSerial;
  const task = createWindowsAgentTask({
    agentId,
    adbSerial,
    deviceId: device.deviceId,
    type: "xhs_qr_appium",
    payload: {
      xhsTaskId: xhsTask.taskId,
      qrImageDataUrl: xhsTask.qrImageDataUrl || "",
      xhsAppSlot: xhsTask.xhsAppSlot || "app1",
      xhsAccountLabel: xhsTask.xhsAccountLabel || "",
      xhsAccountId: xhsTask.xhsAccountId || "",
      xhsAccountName: xhsTask.xhsAccountName || "",
      executionMode,
      workflowScript
    }
  });
  xhsTask.windowsTaskId = task.taskId;
  addAudit("xhs_windows_task_create", ctx, { agentId, adbSerial, deviceId: device.deviceId, xhsTaskId: xhsTask.taskId, windowsTaskId: task.taskId, executionMode });
  return task;
}

function lookupHumanProbeTargets(agentId) {
  const probes = [];
  for (const session of state.automationSessions) {
    const challengeId = lookupHumanChallenge(session);
    if (!challengeId || session.requiresAccountSwitch) continue;
    const device = repos.devices.findById(session.deviceId);
    if (!device || !isAdbOnline(device) || device.adb?.agentId !== agentId) continue;
    const lock = state.deviceLocks.find((item) => item.status === "active"
      && item.lockType === "alipay_name_lookup" && item.taskId === session.sessionId
      && item.deviceId === session.deviceId && item.ownerUserId === session.userId);
    if (!lock) continue;
    const screen = screenSessions.activeForDevice(session.deviceId);
    if (screen) {
      const handover = screenSessions.getMutable(screen.sessionId)?.lookupHumanHandover;
      if (!screenRelay.agentOnline(agentId) || !["ready", "streaming"].includes(screen.status)
        || handover?.sessionId !== session.sessionId || handover.challengeId !== challengeId) continue;
    }
    probes.push({ managedLookup: Boolean(session.managedLookupGeneration), sessionId: session.sessionId, deviceId: session.deviceId,
      adbSerial: device.adb.serial, challengeId, screenSessionId: screen?.sessionId || "" });
  }
  return probes;
}

async function resumeLookupAfterObservedHumanVerification(target) {
  const session = state.automationSessions.find((item) => item.sessionId === target.sessionId);
  if (!session || lookupHumanChallenge(session) !== target.challengeId) throw badRequest("lookup_human_probe_stale");
  if (session.managedLookupGeneration && !lookupHumanProbeTargets(repos.devices.findById(session.deviceId)?.adb?.agentId).some(p => p.sessionId === target.sessionId && p.deviceId === target.deviceId && p.challengeId === target.challengeId && p.screenSessionId === target.screenSessionId)) return false;
  if (session.managedLookupGeneration && !(await managedLookup?.beforeResume(session.sessionId))) return false;
  const sourceResult = resumableLookupHumanVerificationResult(session) || resumableLookupRecoveryResult(session);
  const device = repos.devices.findById(session.deviceId);
  const startup = sourceResult.phase === "start";
  const phoneNumber = startup ? "" : normalizeLookupPhone(sourceResult.phoneNumber);
  const screen = screenSessions.activeForDevice(session.deviceId);
  if ((screen?.sessionId || "") !== target.screenSessionId) throw badRequest("lookup_human_probe_stale");
  if (screen && !screenRelay.stop(screen.sessionId, "lookup_human_verification_completed")) {
    throw badRequest("lookup_human_screen_stop_failed");
  }
  const job = createAutomationJob({ kind: startup ? "alipay_name_start" : "alipay_name_query", userId: session.userId,
    deviceId: session.deviceId, sessionId: session.sessionId, phoneNumber,
    resultId: sourceResult.resultId, resumeAfterHumanVerification: true,
    restartAfterHumanVerification: true });
  if (["open-api", "managed-api"].includes(session.source)) Object.assign(job, {
    source: session.source, clientId: session.clientId,
    clientReference: sourceResult.clientReference || "", consentReference: sourceResult.consentReference || ""
  });
  const oldJob=(state.automationJobs||[]).find(j=>(j.resultId||j.jobId)===sourceResult.resultId&&j.preparedLookup);
  if(oldJob)job.preparedLookup={...oldJob.preparedLookup,verifiedAccount:""};
  session.status = startup ? "starting" : "querying";
  session.pendingJobId = job.jobId;
  session.error = "";
  session.updatedAt = nowIso();
  if (startup) session.startupHumanVerification.status = "queued";
  else upsertLookupResult(session, job, { status: "queued", error: "",
    stage: "人工验证已消失，等待控屏释放后清空搜索框并重查原号码", updatedAt: session.updatedAt });
  const windowsTask = queueAutomationWindowsTask(device, job);
  // Do not admit a retry before its durable record exists. A persistence
  // failure leaves it held, rather than blindly running/retrying a query.
  windowsTask.status = "human_handover_pending";
  const audit = addAudit("alipay_name_human_auto_handover", { role: "windows_agent", agentId: job.agentId }, {
    sessionId: session.sessionId, jobId: job.jobId, sourceResultId: sourceResult.resultId,
    deviceId: session.deviceId, screenSessionId: target.screenSessionId
  });
  try {
    await persistencePolicy.persist(() => structuredRepos.persistTaskMutation({ windowsTask, automationJob: job, automationSession: session, audit }));
  } catch {
    session.error = "人工验证自动恢复保存失败，任务保持暂停，请结束会话后检查。";
    throw new Error("lookup_human_resume_persist_failed");
  }
  // End/cancel may have happened while saving. Never resurrect that task.
  if (session.pendingJobId !== job.jobId || session.status !== (startup ? "starting" : "querying")
    || job.status !== "queued" || windowsTask.status !== "human_handover_pending") return;
  windowsTask.status = "queued";
  runtimeSaveScheduler.mark();
  return true;
}

function queueAutomationWindowsTask(device, job) {
  const agentId = String(device?.adb?.agentId || "");
  const adbSerial = String(device?.adb?.serial || "");
  if (!agentId || !adbSerial || !isAdbOnline(device)) throw badRequest("device_not_available");
  const typeByKind = {
    xhs_publish: "xhs_publish",
    kuaishou_lead: "kuaishou_lead",
    xhs_data_collect: "xhs_data_collect",
    alipay_name_start: "alipay_name_start",
    alipay_name_query: "alipay_name_query",
    alipay_name_switch: "alipay_name_switch",
    alipay_name_stop: "alipay_name_stop"
  };
  const task = createWindowsAgentTask({
    agentId,
    adbSerial,
    deviceId: device.deviceId,
    type: typeByKind[job.kind],
    payload: {
      automationJobId: job.jobId,
      ...(job.kind === "xhs_data_collect" ? { deviceName: device.deviceName || device.deviceId, windowDays: 30 } : {}),
      automationSessionId: job.sessionId || "",
      ...(state.automationSessions.find(s=>s.sessionId===job.sessionId)?.managedLookupGeneration ? {managedLookup:{protocol:MANAGED_LOOKUP_PROTOCOL,generation:state.automationSessions.find(s=>s.sessionId===job.sessionId).managedLookupGeneration}} : {}),
      xhsAppSlot: job.xhsAppSlot || "",
      xhsAccountLabel: job.xhsAccountLabel || "",
      title: job.title || "",
      content: job.content || "",
      imageDataUrls: job.imageDataUrls || [],
      phoneNumber: job.phoneNumber || "",
      ...(job.preparedLookup?{preparedLookup:job.preparedLookup}:{}),
      minDelaySeconds: job.minDelaySeconds || 0,
      maxDelaySeconds: job.maxDelaySeconds || 0,
      resumeAfterHumanVerification: job.resumeAfterHumanVerification === true,
      restartAfterHumanVerification: job.restartAfterHumanVerification === true,
      accountAction: job.accountAction || "",
      targetAccount: job.targetAccount || "",
      ...(job.kind.startsWith("alipay_name_") ? lookupAccountPolicy(device,
        state.automationSessions.find((session) => session.sessionId === job.sessionId)) : {}),
      savedAccounts: job.kind.startsWith("alipay_name_")
        ? (state.automationSessions.find((session) => session.sessionId === job.sessionId)?.savedAccounts || []) : [],
      maxRecoveryAttempts: 2
    }
  });
  job.windowsTaskId = task.taskId;
  job.agentId = agentId;
  job.adbSerial = adbSerial;
  return task;
}

function cancelAutomationJob(job, reason = "cancelled", options = {}) {
  if (!job) return null;
  job.status = "cancelled";
  job.updatedAt = nowIso();
  job.completedAt = job.updatedAt;
  job.result = { ...(job.result || {}), errorCode: reason, message: "自动化任务已取消" };
  const windowsTask = state.windowsTasks.find((task) => task.taskId === job.windowsTaskId);
  if (windowsTask && !isTerminalStatus(windowsTask.status)) {
    windowsTask.status = "cancelled";
    windowsTask.result = { ...(windowsTask.result || {}), errorCode: reason, message: "关联自动化任务已取消" };
    windowsTask.updatedAt = nowIso();
    windowsTask.completedAt = windowsTask.updatedAt;
  }
  if (options.releaseLock !== false) releaseAutomationLock(job, reason);
  return job;
}

function syncAutomationJobFromWindowsTask(windowsTask, status, result = {}) {
  const jobId = String(windowsTask?.payload?.automationJobId || "");
  if (!jobId) return null;
  const job = state.automationJobs.find((item) => item.jobId === jobId);
  if (!job || isTerminalStatus(job.status)) return job || null;
  job.status = status;
  const previousProgress = job.kind === "kuaishou_lead" && job.result?.progress && typeof job.result.progress === "object"
    ? { ...job.result.progress } : null;
  job.result = sanitizeTaskResult(result || {}, { includeEvidence: true });
  if (previousProgress) job.result.progress = previousProgress;
  job.windowsTaskId = windowsTask.taskId;
  job.agentId = windowsTask.agentId;
  job.adbSerial = windowsTask.adbSerial;
  if (status === "running") job.pickedAt = job.pickedAt || nowIso();
  job.updatedAt = nowIso();
  if (job.kind === "kuaishou_lead" && status === "running") renewAutomationLock(job, KUAISHOU_LEAD_LOCK_TTL_MS);
  const session = job.sessionId ? state.automationSessions.find((item) => item.sessionId === job.sessionId) : null;
  const device = session ? repos.devices.findById(session.deviceId) : null;
  const accountProtocol = windowsTask.payload?.accountCooldownProtocol === 1;
  if (session && ["succeeded", "failed"].includes(status) && accountProtocol) {
    const runner = job.result.runner || job.result.diagnostic || {};
    const saved = verifiedSavedAccounts(job.result.savedAccounts || runner.savedAccounts);
    const current = String(job.result.currentAccount || "");
    const verified = job.result.accountIdentityVerified === true
      && saved?.some((choice) => choice.current && choice.account === current);
    if (verified && job.kind !== "alipay_name_stop") {
      // Query failure/puzzle can follow a completed, verified rotation. Commit
      // the identity and its picker together, independently of query success.
      session.savedAccounts = saved;
      session.currentAccount = current;
      session.accountIdentityVerified = true;
    }
    if (status === "succeeded" && job.kind !== "alipay_name_stop") {
      if (!verified) {
        status = job.status = "failed";
        job.result.errorCode = "alipay_account_identity_unverified";
        job.result.message = "账户身份未确认，未放行查询；请重新启动会话检查账户。";
        session.accountIdentityVerified = false;
      } else {
        session.currentAccount = current;
        session.accountIdentityVerified = true;
      }
    }
  }
  if (session && job.kind === "alipay_name_query" && status === "running") {
    upsertLookupResult(session, job, {
      status: "running",
      stage: job.resumeAfterHumanVerification
        ? "人工验证已确认，正在获取当前号码结果"
        : "Windows 管理器已领取，正在查询",
      updatedAt: job.updatedAt
    });
    session.status = "querying";
    session.updatedAt = job.updatedAt;
  } else if (session && job.kind === "alipay_name_switch" && status === "running") {
    session.status = "switching";
    session.updatedAt = job.updatedAt;
  }
  if (["succeeded", "failed", "cancelled"].includes(status)) {
    job.completedAt = nowIso();
    if (["xhs_publish", "kuaishou_lead", "xhs_data_collect"].includes(job.kind)) {
      releaseAutomationLock(job, status);
    } else if (session) {
      session.pendingJobId = "";
      session.updatedAt = nowIso();
      if (job.kind === "alipay_name_start") {
        if (status === "succeeded") {
          delete session.startupHumanVerification;
          session.status = "ready";
          session.currentAccount = String(job.result.currentAccount || "");
          session.requiresAccountSwitch = false;
          session.limitReason = "";
          session.automationHaltReason = "";
          session.error = "";
        } else if (status === "failed" && (job.result.errorCode === "alipay_human_verification_required"
          || String(job.result.error || "").includes("alipay_human_verification_required"))) {
          session.startupHumanVerification = { resultId: job.jobId, phase: "start",
            status: "needs_human_verification", limitReason: "jigsaw_verification",
            errorCode: "alipay_human_verification_required", updatedAt: job.completedAt };
          session.status = "needs_human_verification";
          session.limitReason = "jigsaw_verification";
          session.requiresAccountSwitch = false;
          session.error = "启动时遇到拼图，请在实时控屏中完成，系统检测通过后继续准备账户。";
        } else if (lookupHumanRecoveryUnresolved(job, status, { limitReached: job.result.errorCode === "alipay_no_available_account" })) {
          session.startupHumanVerification = { resultId: job.jobId, phase: "start",
            status: "needs_recovery", updatedAt: job.completedAt };
          session.status = "ready";
          session.limitReason = "";
          session.automationHaltReason = "lookup_human_recovery_failed";
          session.error = "账户准备恢复失败，队列已暂停；请重试或结束会话。";
        } else {
          finishLookupSession(session, "failed", job.result.errorCode || job.result.error || status);
        }
      } else if (job.kind === "alipay_name_query") {
        if (!accountProtocol && job.result.accountSwitched) {
          session.currentAccount = String(job.result.currentAccount || session.currentAccount || "");
        }
        if (status === "succeeded" && job.result.realNameTailCharacter) {
          session.successfulCount += 1;
          session.currentAccount = String(job.result.currentAccount || session.currentAccount || "");
          session.requiresAccountSwitch = false;
          session.limitReason = "";
          session.automationHaltReason = "";
          upsertLookupResult(session, job, {
            name: String(job.result.alipayDisplayName || ""),
            realNameTailCharacter: String(job.result.realNameTailCharacter || ""),
            account: String(job.result.currentAccount || ""),
            accountSwitched: Boolean(job.result.accountSwitched),
            accountSwitchReason: String(job.result.accountSwitchReason || ""),
            accountSwitchCount: Math.max(0, Number(job.result.accountSwitchCount || 0)),
            recoveryAttempts: Math.max(0, Number(job.result.recoveryAttempts || 0)),
            durationMs: Number(job.result.durationMs || 0),
            status: "succeeded",
            limitReason: "",
            errorCode: "",
            stage: job.resumeAfterHumanVerification ? "人工验证后当前号码查询完成" : "查询完成",
            error: "",
            updatedAt: job.completedAt
          });
          session.status = "ready";
          session.error = "";
        } else if (status === "succeeded" && job.result.notFound === true) {
          const accountNotRealNamed = job.result.message === "account_not_real_named";
          session.successfulCount += 1;
          session.requiresAccountSwitch = false;
          session.limitReason = "";
          session.automationHaltReason = "";
          upsertLookupResult(session, job, {
            name: "",
            realNameTailCharacter: "",
            account: String(job.result.currentAccount || ""),
            accountSwitched: Boolean(job.result.accountSwitched),
            accountSwitchReason: String(job.result.accountSwitchReason || ""),
            accountSwitchCount: Math.max(0, Number(job.result.accountSwitchCount || 0)),
            recoveryAttempts: Math.max(0, Number(job.result.recoveryAttempts || 0)),
            durationMs: Number(job.result.durationMs || 0),
            status: "not_found",
            limitReason: "",
            errorCode: "",
            stage: accountNotRealNamed ? "支付宝账户未实名" : "该号码未查询到姓名结果",
            error: "",
            updatedAt: job.completedAt
          });
          session.status = "ready";
          session.error = "";
        } else {
          const noAvailableAccount = accountProtocol && job.result.errorCode === "alipay_no_available_account"
            && allSavedAccountsCooling(device, session.savedAccounts);
          const limitReached = noAvailableAccount || isPreparedLookupLimitConfirmed(device, job) || hasVerifiedAllSavedAccountsRestricted(job.result.diagnostic);
          const explicitHumanVerification = job.result.errorCode === "alipay_human_verification_required"
            || String(job.result.error || job.result.message || "").includes("alipay_human_verification_required");
          const needsHumanVerification = explicitHumanVerification;
          const recoveryUnresolved = !explicitHumanVerification
            && !limitReached && (lookupHumanRecoveryUnresolved(job, status, { limitReached })
              || job.result.errorCode === "lookup_status_storage_unavailable");
          const limitReason = String(job.result.diagnostic?.limitReason || "");
          const errorMessage = String(job.result.message || job.result.error || status);
          if (limitReached) {
            const restrictionEvent = [...(job.events || [])].reverse().find((event) => isPostQueryLookupRestrictionEvent(event));
            const detail = restrictionEvent?.detail || {};
            upsertLookupRestrictionHistory(session, {
              restrictionId: job.jobId,
              jobId: job.jobId,
              windowsTaskId: job.windowsTaskId,
              deviceId: job.deviceId,
              phoneNumber: job.phoneNumber,
              account: detail.currentAccount || job.result.currentAccount || session.currentAccount,
              reason: limitReason || detail.reason,
              title: detail.title,
              driver: detail.driver,
              phase: detail.phase,
              phoneQueryStarted: detail.phoneQueryStarted === true,
              requiresAccountSwitch: true,
              status: "confirmed",
              errorCode: job.result.errorCode,
              message: errorMessage,
              detectedAt: restrictionEvent?.createdAt,
              confirmedAt: job.completedAt
            });
          }
          upsertLookupResult(session, job, {
            name: "",
            realNameTailCharacter: "",
            status: status === "cancelled" ? "cancelled" : needsHumanVerification ? "needs_human_verification" : recoveryUnresolved ? "needs_recovery" : limitReached ? "limit_reached" : "failed",
            account: String(job.result.currentAccount || ""),
            accountSwitched: Boolean(job.result.accountSwitched),
            accountSwitchReason: String(job.result.accountSwitchReason || ""),
            accountSwitchCount: Math.max(0, Number(job.result.accountSwitchCount || 0)),
            stage: needsHumanVerification
              ? (job.resumeAfterHumanVerification ? "人工恢复未完成，需检查当前号码" : "等待人工验证")
              : recoveryUnresolved ? "当前号码恢复失败，等待重试" : status === "cancelled" ? "查询已取消" : limitReached ? "当前账号触发查询限制" : "查询失败",
            error: errorMessage,
            errorCode: String(job.result.errorCode || ""),
            limitReason,
            durationMs: Number(job.result.durationMs || 0),
            updatedAt: job.completedAt
          });
          if (recoveryUnresolved) {
            session.status = "ready";
            session.automationHaltReason = "lookup_human_recovery_failed";
            session.error = "当前号码恢复失败，后续队列已暂停；请重试当前号码或结束会话。";
          } else if (needsHumanVerification) {
            session.status = "ready";
            session.error = job.resumeAfterHumanVerification
              ? "当前号码的人工恢复未完成；队列已暂停，请检查页面后再次确认。"
              : "支付宝要求人工完成滑动验证；完成后可重试当前号码";
          } else if (limitReached) {
            session.status = "ready";
            session.requiresAccountSwitch = true;
            session.limitReason = limitReason;
            session.automationHaltReason = String(job.result.errorCode || limitReason || "automatic_account_rotation_exhausted");
            session.error = errorMessage;
          } else if (session.status !== "stopping") {
            session.requiresAccountSwitch = false;
            session.limitReason = "";
            session.automationHaltReason = "";
            session.status = "ready";
            session.error = status === "cancelled" ? "查询已取消，可以继续输入号码。" : errorMessage;
          } else {
            session.updatedAt = job.completedAt;
          }
        }
        session.accountQueryStarted = status === "succeeded";
      } else if (job.kind === "alipay_name_switch") {
        session.accountQueryStarted = false;
        if (status === "succeeded" && job.accountAction === "list") {
          const choices = Array.isArray(job.result.savedAccounts) ? job.result.savedAccounts : [];
          session.accountChoices = choices.slice(0, 12).map((choice) => ({
            account: String(choice?.account || "").slice(0, 120),
            current: Boolean(choice?.current)
          })).filter((choice) => choice.account);
          session.status = "choosing_account";
          session.currentAccount = String(job.result.currentAccount || session.currentAccount || "");
          session.error = "";
        } else if (status === "succeeded") {
          session.status = "ready";
          session.currentAccount = String(job.result.currentAccount || session.currentAccount || "");
          session.accountChoices = [];
          session.requiresAccountSwitch = false;
          session.limitReason = "";
          session.automationHaltReason = "";
          session.lastAccountSwitch = {
            fromAccount: String(job.result.diagnostic?.fromAccount || ""),
            toAccount: String(job.result.currentAccount || ""),
            switchedAt: job.completedAt
          };
          session.error = "";
        } else if (session.status !== "stopping") {
          session.status = session.accountChoices?.length ? "choosing_account" : "ready";
          session.error = String(job.result.message || job.result.error || "支付宝账号切换失败，请重试。");
        }
      } else if (job.kind === "alipay_name_stop") {
        session.results = (session.results || []).map((result) => result.status === "cancelling"
          ? { ...result, status: "cancelled", stage: "查询已取消", error: "会话已结束", updatedAt: job.completedAt }
          : result);
        finishLookupSession(session, "ended", status);
      }
    }
    if (job.imageDataUrls?.length) delete job.imageDataUrls;
  }
  return job;
}

function appendWindowsEventToAutomationJob(windowsTask, event) {
  const jobId = String(windowsTask?.payload?.automationJobId || "");
  if (!jobId) return null;
  const job = state.automationJobs.find((item) => item.jobId === jobId);
  if (!job) return null;
  if (isTerminalStatus(job.status)) return job;
  job.events.push(sanitizeStoredEvent({ ...event, source: "windows-agent", windowsTaskId: windowsTask.taskId }));
  job.events = job.events.slice(-100);
  job.updatedAt = nowIso();
  if (job.kind === "kuaishou_lead") {
    renewAutomationLock(job, KUAISHOU_LEAD_LOCK_TTL_MS);
    const queueEvent = String(event?.detail?.queueEvent || "");
    const progress = job.result?.progress && typeof job.result.progress === "object"
      ? { ...job.result.progress }
      : { processedCount: 0, successCount: 0, failedAttemptCount: 0, unknownCount: 0, skippedCount: 0 };
    if (queueEvent === "row_finalized") {
      progress.processedCount = Math.max(0, Number(progress.processedCount || 0)) + 1;
      if (event.detail?.status === "推送成功") progress.successCount = Math.max(0, Number(progress.successCount || 0)) + 1;
      else if (event.detail?.status === "推送失败（提交前）") progress.failedAttemptCount = Math.max(0, Number(progress.failedAttemptCount || 0)) + 1;
      else if (event.detail?.status === "结果待确认") progress.unknownCount = Math.max(0, Number(progress.unknownCount || 0)) + 1;
      progress.lastRow = Math.max(0, Number(event.detail?.row || 0));
      progress.lastStatus = String(event.detail?.status || "").slice(0, 80);
    }
    if (queueEvent === "row_skipped") {
      progress.skippedCount = Math.max(0, Number(progress.skippedCount || 0)) + 1;
      progress.lastRow = Math.max(0, Number(event.detail?.row || 0));
      progress.lastStatus = "领取状态变化，未操作手机";
      progress.currentRow = 0;
    }
    if (["waiting", "waiting_for_new_rows", "waiting_for_queue_retry", "waiting_after_row_skip"].includes(queueEvent)) {
      const seconds = Math.max(0, Number(event.detail?.seconds || 0));
      progress.nextRunAt = seconds ? new Date(Date.now() + seconds * 1000).toISOString() : "";
    }
    if (queueEvent === "candidate_selected") {
      progress.currentRow = Math.max(0, Number(event.detail?.row || 0));
      progress.currentPhone = String(event.detail?.phone || "").slice(0, 32);
      progress.currentCity = String(event.detail?.city || "").slice(0, 80);
    }
    if (queueEvent === "queue_empty") progress.currentRow = 0;
    progress.lastQueueEvent = queueEvent;
    progress.lastEventAt = job.updatedAt;
    job.result = { ...(job.result || {}), progress };
  }
  const lookupSession = job.sessionId ? state.automationSessions.find((item) => item.sessionId === job.sessionId) : null;
  const verifiedRestriction = windowsTask.payload?.accountCooldownProtocol === 1
    && isVerifiedLookupAccountRestrictionEvent(event);
  if (lookupSession && verifiedRestriction) {
    const detail = event.detail;
    recordLookupAccountCooldown(repos.devices.findById(lookupSession.deviceId), {
      account: detail.currentAccount, reason: detail.reason,
      restrictionId: `${job.jobId}:${detail.currentAccount}`, jobId: job.jobId,
      accountIdentityVerified: true, phoneQueryStarted: detail.phoneQueryStarted,
      detectedAt: event.createdAt || nowIso()
    });
  }
  if (job.kind === "alipay_name_query") {
    const session = state.automationSessions.find((item) => item.sessionId === job.sessionId);
    if (session) {
      const stopping = session.status === "stopping";
      if (isPostQueryLookupRestrictionEvent(event) || verifiedRestriction) {
        const detail = event.detail || {};
        const account = String(detail.currentAccount || session.currentAccount || "");
        upsertLookupRestrictionHistory(session, {
          restrictionId: `${job.jobId}:${account}`,
          jobId: job.jobId,
          windowsTaskId: windowsTask.taskId,
          deviceId: job.deviceId,
          phoneNumber: job.phoneNumber,
          account,
          reason: detail.reason,
          title: detail.title,
          driver: detail.driver,
          phase: detail.phase,
          phoneQueryStarted: detail.phoneQueryStarted === true,
          requiresAccountSwitch: true,
          status: "detected",
          detectedAt: event.createdAt || nowIso()
        });
      }
      upsertLookupResult(session, job, {
        status: stopping ? "cancelling" : "running",
        stage: stopping ? "正在停止当前查询" : lookupProgressStage(event),
        updatedAt: job.updatedAt
      });
      session.status = stopping ? "stopping" : "querying";
      session.updatedAt = job.updatedAt;
    }
  }
  return job;
}

function cancelLinkedWindowsTask(xhsTask, ctx = { role: "system" }) {
  const taskId = String(xhsTask?.windowsTaskId || "");
  if (!taskId) return null;
  const task = state.windowsTasks.find((item) => item.taskId === taskId);
  if (!task || !["queued", "running", "stalled"].includes(task.status)) return null;
  task.status = "cancelled";
  task.result = { ...(task.result || {}), message: "关联扫码任务已取消" };
  task.updatedAt = nowIso();
  task.completedAt = nowIso();
  if (!Array.isArray(task.events)) task.events = [];
  task.events.push({
    eventId: newId(),
    phase: "cancel",
    level: "warn",
    message: "用户取消扫码任务，Windows 执行任务已标记取消",
    detail: { xhsTaskId: xhsTask.taskId },
    createdAt: nowIso()
  });
  addAudit("xhs_linked_windows_task_cancel", ctx, { xhsTaskId: xhsTask.taskId, windowsTaskId: task.taskId });
  return task;
}

function syncXhsTaskFromWindowsTask(windowsTask, status, result = {}) {
  const xhsTaskId = String(windowsTask?.payload?.xhsTaskId || "");
  if (!xhsTaskId) return null;
  const task = state.xhsQrTasks.find((item) => item.taskId === xhsTaskId);
  if (!task || isTerminalStatus(task.status)) return task || null;
  if (!["queued", "running", "stalled", "succeeded", "failed", "cancelled"].includes(status)) return task;
  task.status = status;
  task.result = sanitizeTaskResult(result || {}, { includeEvidence: true });
  task.windowsTaskId = windowsTask.taskId;
  task.agentId = windowsTask.agentId;
  task.adbSerial = windowsTask.adbSerial;
  task.executionMode = result?.executionMode || (windowsTask.type === "xhs_qr_appium" ? "windows_airtest_poco" : "windows_adb_uiautomator");
  if (status === "running") task.pickedAt = task.pickedAt || nowIso();
  if (status === "stalled") {
    task.stalledAt = task.stalledAt || nowIso();
    task.recoverable = true;
  }
  if (status === "queued") {
    task.completedAt = null;
    task.recoverable = true;
  }
  task.updatedAt = nowIso();
  if (["succeeded", "failed", "cancelled"].includes(status)) {
    task.completedAt = nowIso();
    appendWindowsResultEvidenceToXhsTask(task, windowsTask, task.result, status);
    releaseDeviceTaskLock(task, status);
    if (task.qrImageDataUrl) delete task.qrImageDataUrl;
    compactCompletedTask(windowsTask);
  }
  recordTaskProgress(task, windowsTask);
  return task;
}

function appendWindowsResultEvidenceToXhsTask(task, windowsTask, result = {}, status = "") {
  if (!task || !result || typeof result !== "object") return;
  if (!result.screenshot && !result.uiHierarchy && !result.uiSnapshot && !result.currentActivity) return;
  if (!Array.isArray(task.events)) task.events = [];
  const windowsTaskId = String(windowsTask?.taskId || "");
  const alreadyAppended = task.events.some((event) => (
    event?.source === "windows-task-result"
    && String(event?.windowsTaskId || "") === windowsTaskId
    && event?.phase === "evidence"
  ));
  if (alreadyAppended) return;
  task.events.push(sanitizeStoredEvent({
    eventId: newId(),
    phase: "evidence",
    level: status === "failed" ? "error" : "info",
    message: result.message || result.error || "任务现场证据已保存",
    errorCode: result.errorCode || result.error || "",
    packageName: result.packageName || "",
    currentActivity: result.currentActivity || "",
    uiSnapshot: result.uiSnapshot || "",
    uiHierarchy: result.uiHierarchy || "",
    screenshot: result.screenshot || null,
    source: "windows-task-result",
    windowsTaskId,
    detail: {
      diagnostic: result.diagnostic || null,
      qrTimings: result.qrTimings || null,
      preRunTimings: result.preRunTimings || null
    },
    createdAt: nowIso()
  }));
}

function appendWindowsEventToXhsTask(windowsTask, event) {
  const xhsTaskId = String(windowsTask?.payload?.xhsTaskId || "");
  if (!xhsTaskId) return null;
  const task = state.xhsQrTasks.find((item) => item.taskId === xhsTaskId);
  if (!task) return null;
  if (!Array.isArray(task.events)) task.events = [];
  task.events.push(sanitizeStoredEvent({
    ...event,
    source: "windows-agent",
    windowsTaskId: windowsTask.taskId
  }));
  task.updatedAt = nowIso();
  recordTaskProgress(task, windowsTask, event);
  return task;
}

function attachXhsWorkflowScript(inputScript, xhsAppSlot) {
  const normalizedSlot = normalizeXhsAppSlot(xhsAppSlot);
  const defaults = getXhsQrDefaultWorkflowScriptConfig(normalizedSlot);
  const script = cloneJson(inputScript && typeof inputScript === "object" ? inputScript : xhsQrLoginWorkflowScript(normalizedSlot));
  script.scriptId = String(script.scriptId || defaults.scriptId);
  script.version = String(script.version || defaults.version);
  script.enabled = script.enabled !== false;
  script.platform = String(script.platform || defaults.platform);
  script.appSlot = normalizedSlot;
  script.xhsAppSlot = normalizedSlot;
  script.confirmWaitMs = normalizePositiveNumber(script.confirmWaitMs, defaults.confirmWaitMs);
  script.loginConfirmKeywords = normalizeStringList(script.loginConfirmKeywords, defaults.loginConfirmKeywords);
  script.ordinaryConfirmButtons = normalizeStringList(script.ordinaryConfirmButtons, defaults.ordinaryConfirmButtons);
  script.platformConfirmButtons = normalizeStringList(script.platformConfirmButtons, defaults.platformConfirmButtons);
  script.timeouts = normalizeScriptTimeouts(script.timeouts, defaults.timeouts);
  script.engineVersion = Number(script.engineVersion || 2);
  script.timeoutMs = normalizePositiveNumber(script.timeoutMs, script.timeouts.totalMs || 180_000);
  script.description = String(script.description || defaults.description);
  script.steps = Array.isArray(script.steps) ? script.steps : [];
  const launchStep = script.steps.find((step) => step && step.action === "launchApp");
  if (launchStep) {
    launchStep.params = {
      ...(launchStep.params || {}),
      appSlot: normalizedSlot,
      xhsAppSlot: normalizedSlot
    };
  }
  return script;
}

function xhsQrDefaultScriptConfig(appSlot = "app1") {
  const normalizedSlot = normalizeXhsAppSlot(appSlot);
  return {
    scriptId: XHS_QR_DEFAULT_SCRIPT_ID,
    version: XHS_QR_DEFAULT_SCRIPT_VERSION,
    enabled: true,
    platform: "xhs",
    appSlot: normalizedSlot,
    xhsAppSlot: normalizedSlot,
    confirmWaitMs: 10_000,
    loginConfirmKeywords: ["登录确认", "确认登录", "即将登录小红书电脑端", "请确认是你本人操作", "登录设备", "登录地点", "登录平台", "已阅读并同意", "千帆", "专业号", "商家"],
    ordinaryConfirmButtons: ["确认登录", "确定登录", "同意并登录", "授权登录"],
    platformConfirmButtons: ["登录", "同意并登录"],
    timeouts: {
      totalMs: 180_000,
      restartMs: 25_000,
      profileMs: 10_000,
      scannerMs: 10_000,
      albumMs: 10_000,
      selectImageMs: 14_000,
      loginConfirmMs: 45_000
    },
    description: "小红书扫码默认脚本：图库二维码后断言登录确认页，等待 10 秒再确认登录"
  };
}

function normalizeWorkflowScripts(input = {}) {
  const scripts = input && typeof input === "object" ? input : {};
  return {
    [XHS_QR_DEFAULT_SCRIPT_ID]: normalizeWorkflowScriptConfig(scripts[XHS_QR_DEFAULT_SCRIPT_ID], "app1")
  };
}

function getStoredWorkflowScriptConfig(scriptId) {
  const scripts = state?.workflowScripts && typeof state.workflowScripts === "object" ? state.workflowScripts : {};
  if (scriptId === XHS_QR_DEFAULT_SCRIPT_ID) return normalizeWorkflowScriptConfig(scripts[scriptId], "app1");
  return null;
}

function getXhsQrDefaultWorkflowScriptConfig(appSlot = "app1") {
  return normalizeWorkflowScriptConfig(getStoredWorkflowScriptConfig(XHS_QR_DEFAULT_SCRIPT_ID), appSlot);
}

function normalizeWorkflowScriptConfig(input = {}, appSlot = "app1") {
  const normalizedSlot = normalizeXhsAppSlot(appSlot);
  const defaults = xhsQrDefaultScriptConfig(normalizedSlot);
  const source = input && typeof input === "object" ? input : {};
  return {
    scriptId: XHS_QR_DEFAULT_SCRIPT_ID,
    version: String(source.version || defaults.version).slice(0, 80),
    enabled: source.enabled !== false,
    platform: "xhs",
    appSlot: normalizedSlot,
    xhsAppSlot: normalizedSlot,
    confirmWaitMs: normalizePositiveNumber(source.confirmWaitMs, defaults.confirmWaitMs),
    loginConfirmKeywords: normalizeStringList(source.loginConfirmKeywords, defaults.loginConfirmKeywords).slice(0, 40),
    ordinaryConfirmButtons: normalizeStringList(source.ordinaryConfirmButtons, defaults.ordinaryConfirmButtons).slice(0, 20),
    platformConfirmButtons: normalizeStringList(source.platformConfirmButtons, defaults.platformConfirmButtons).slice(0, 20),
    timeouts: normalizeScriptTimeouts(source.timeouts, defaults.timeouts),
    steps: Array.isArray(source.steps) ? cloneJson(source.steps).slice(0, 100) : [],
    description: String(source.description || defaults.description).slice(0, 300),
    updatedAt: String(source.updatedAt || ""),
    updatedBy: String(source.updatedBy || "").slice(0, 80)
  };
}

function publicWorkflowScriptConfig(script) {
  const config = normalizeWorkflowScriptConfig(script, script?.xhsAppSlot || script?.appSlot || "app1");
  if (!config.steps.length) config.steps = cloneJson(xhsQrLoginWorkflowScript(config.xhsAppSlot || config.appSlot || "app1").steps || []);
  return config;
}

function normalizeStringList(value, fallback = []) {
  const items = Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
  return items.length ? items : [...fallback];
}

function normalizePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeScriptTimeouts(value, fallback = {}) {
  const input = value && typeof value === "object" ? value : {};
  const output = { ...fallback };
  for (const [key, fallbackValue] of Object.entries(fallback)) {
    output[key] = normalizePositiveNumber(input[key], fallbackValue);
  }
  return output;
}

function xhsQrLoginWorkflowScript(appSlot = "app1") {
  const normalizedSlot = normalizeXhsAppSlot(appSlot);
  const config = getXhsQrDefaultWorkflowScriptConfig(normalizedSlot);
  if (Array.isArray(config.steps) && config.steps.length) {
    const steps = cloneJson(config.steps).slice(0, 100);
    const launchStep = steps.find((step) => step && step.action === "launchApp");
    if (launchStep) {
      launchStep.params = {
        ...(launchStep.params || {}),
        appSlot: normalizedSlot,
        xhsAppSlot: normalizedSlot
      };
    }
    return {
      ...config,
      appSlot: normalizedSlot,
      xhsAppSlot: normalizedSlot,
      engineVersion: 2,
      timeoutMs: config.timeouts.totalMs,
      steps
    };
  }
  const xhsEntryText = normalizedSlot === "app2" ? "Ⅱ·小红书" : "小红书";
  return {
    ...config,
    engineVersion: 2,
    timeoutMs: config.timeouts.totalMs,
    steps: [
      {
        id: "return-home",
        action: "home",
        timeoutMs: 5_000,
        description: "回到桌面，准备重启小红书"
      },
      {
        id: "launch-xhs",
        action: "launchApp",
        params: { platform: "xhs", appSlot: normalizedSlot, xhsAppSlot: normalizedSlot, restart: true },
        timeoutMs: config.timeouts.restartMs,
        assert: { anyPackage: ["com.xingin.xhs", "com.miui.securitycore", "com.android.intentresolver", "android"] },
        description: `重启${normalizedSlot === "app2" ? "双开" : "主应用"}小红书`
      },
      {
        id: "miui-android-resolver-picker",
        action: "tapByResourceId",
        resourceId: `android.miui:id/${normalizedSlot === "app2" ? "app2" : "app1"}`,
        whenPackage: "android",
        whenText: "请选择要使用的应用",
        optional: true,
        timeoutMs: 8_000,
        assert: { package: "com.xingin.xhs" },
        description: `MIUI 系统选择器出现时选择${normalizedSlot === "app2" ? "右侧双开" : "左侧主应用"}小红书`
      },
      {
        id: "miui-xspace-picker",
        action: "tapByResourceId",
        resourceId: `com.miui.securitycore:id/${normalizedSlot === "app2" ? "app2" : "app1"}`,
        whenPackage: "com.miui.securitycore",
        whenText: "选择要使用的应用",
        optional: true,
        timeoutMs: 8_000,
        assert: { package: "com.xingin.xhs" },
        description: `小米双开选择器出现时选择${normalizedSlot === "app2" ? "右侧双开" : "左侧主应用"}小红书`
      },
      {
        id: "generic-xhs-picker",
        action: "tapExactText",
        selector: { text: xhsEntryText },
        when: { text: "选择要使用的应用" },
        optional: true,
        timeoutMs: 8_000,
        assert: { package: "com.xingin.xhs" },
        description: `双开选择器出现时选择${normalizedSlot === "app2" ? "第二个" : "第一个"}小红书入口`
      },
      {
        id: "dismiss-xhs-notification-prompt",
        action: "tapExactText",
        selector: { text: "确认" },
        when: { anyText: ["打开通知", "热门笔记", "互动消息"] },
        optional: true,
        timeoutMs: 6_000,
        postDelayMs: 1_000,
        description: "关闭小红书通知弹窗"
      },
      {
        id: "open-profile",
        action: "tapBottomTextCenter",
        selector: { text: "我" },
        when: { anyText: ["首页", "发现", "消息"] },
        optional: true,
        postDelayMs: 2_000,
        timeoutMs: config.timeouts.profileMs,
        assert: {
          anyText: ["编辑主页", "小红书号", "扫一扫"],
          failAnyText: ["微信登录", "手机号登录", "其他登录方式"],
          failMessage: "小红书当前未登录，无法进入扫码入口；请先在这台手机上登录小红书账号后重试"
        },
        description: "点击底部我的"
      },
      {
        id: "open-scanner",
        action: "tapTopRightIcon",
        selector: { texts: ["扫一扫", "扫码", "扫描"], indexFromRight: 2 },
        when: { anyText: ["编辑主页", "小红书号"] },
        postDelayMs: 2_000,
        timeoutMs: config.timeouts.scannerMs,
        assert: { anyText: ["扫描二维码", "相册"] },
        description: "点击个人主页右上角扫码图标"
      },
      {
        id: "open-album",
        action: "tapByResourceId",
        selector: { resourceId: "com.xingin.xhs.redscanner:id/llMyPhoto" },
        when: { package: "com.xingin.xhs" },
        postDelayMs: 2_000,
        timeoutMs: config.timeouts.albumMs,
        assert: { anyText: ["全部"] },
        description: "点击扫码页相册入口"
      },
      {
        id: "select-qr-image",
        action: "tapFirstGalleryImage",
        timeoutMs: config.timeouts.selectImageMs,
        assert: { anyText: config.loginConfirmKeywords },
        description: "点击图库第一张图片"
      },
      {
        id: "confirm-login",
        action: "tap",
        selector: { textAny: [...config.ordinaryConfirmButtons, ...config.platformConfirmButtons], contentDesc: "确认登录", center: true },
        delayMs: config.confirmWaitMs,
        timeoutMs: config.timeouts.loginConfirmMs,
        assert: { goneTextAny: ["确认登录", "请确认是你本人操作"] },
        finish: true,
        description: "持续等待小红书登录确认页出现；如有协议勾选先勾选，再点击确认登录/登录"
      }
    ]
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function createRuntimeStore() {
  const memory = new Map();
  let warned = false;

  const memoryGet = (key) => {
    const item = memory.get(key);
    if (!item) return null;
    if (item.expiresAt && item.expiresAt <= Date.now()) {
      memory.delete(key);
      return null;
    }
    return item.value;
  };
  const memorySetEx = (key, value, seconds) => {
    memory.set(key, { value, expiresAt: Date.now() + Math.max(1, Number(seconds || 1)) * 1000 });
    return true;
  };
  const memorySetNxEx = (key, value, seconds) => {
    if (memoryGet(key) != null) return false;
    return memorySetEx(key, value, seconds);
  };
  const memoryDel = (key) => memory.delete(key);

  const redis = REDIS_URL ? createRedisRuntimeClient(REDIS_URL) : null;
  const withFallback = async (operation, fallback) => {
    if (!redis) return fallback();
    try {
      return await operation(redis);
    } catch (error) {
      if (!warned) {
        warned = true;
        console.warn(`redis runtime unavailable, using memory fallback: ${error.message}`);
      }
      return fallback();
    }
  };

  return {
    mode: REDIS_URL ? "redis" : "memory",
    async get(key) {
      return await withFallback(
        (client) => client.get(key),
        () => memoryGet(key)
      );
    },
    async setEx(key, value, seconds) {
      memorySetEx(key, value, seconds);
      return await withFallback(
        (client) => client.setEx(key, value, seconds),
        () => true
      );
    },
    async setNxEx(key, value, seconds) {
      const memoryOk = memorySetNxEx(key, value, seconds);
      return await withFallback(
        (client) => client.setNxEx(key, value, seconds),
        () => memoryOk
      );
    },
    async del(key) {
      memoryDel(key);
      return await withFallback(
        (client) => client.del(key),
        () => true
      );
    },
    async ping() {
      if (!redis) return { ok: true, mode: "memory", detail: "未配置 REDIS_URL，使用进程内运行态缓存" };
      try {
        const pong = await redis.command(["PING"]);
        return { ok: String(pong).toUpperCase() === "PONG", mode: "redis", detail: REDIS_URL.replace(/\/\/[^:@/]+:[^@/]+@/, "//***:***@") };
      } catch (error) {
        return { ok: false, mode: "redis", detail: error.message };
      }
    }
  };
}

function createRedisRuntimeClient(redisUrl) {
  const url = new URL(redisUrl);
  const host = url.hostname || "127.0.0.1";
  const port = Number(url.port || 6379);
  const password = decodeURIComponent(url.password || "");
  const db = String(url.pathname || "").replace(/^\//, "");

  const command = async (args) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(REDIS_COMMAND_TIMEOUT_MS);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const writeCommand = (parts) => {
      const payload = `*${parts.length}\r\n${parts.map((part) => {
        const text = String(part);
        return `$${Buffer.byteLength(text)}\r\n${text}\r\n`;
      }).join("")}`;
      socket.write(payload);
    };
    const readOne = () => {
      const parsed = parseRedisReply(buffer);
      if (!parsed) return null;
      buffer = buffer.subarray(parsed.offset);
      return { value: parsed.value };
    };
    return await new Promise((resolve, reject) => {
      const cleanup = () => {
        socket.removeAllListeners();
        socket.end();
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const done = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const pending = [];
      if (password) pending.push(["AUTH", password]);
      if (db) pending.push(["SELECT", db]);
      pending.push(args);
      socket.on("connect", () => {
        for (const parts of pending) writeCommand(parts);
      });
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        try {
          let reply;
          while ((reply = readOne()) !== null) {
            if (pending.length > 1) {
              pending.shift();
              continue;
            }
            done(reply.value);
            break;
          }
        } catch (error) {
          fail(error);
        }
      });
      socket.on("timeout", () => fail(new Error("redis command timeout")));
      socket.on("error", fail);
      socket.on("end", () => {
        if (!settled) fail(new Error("redis connection ended"));
      });
    });
  };

  return {
    command,
    async get(key) {
      return await command(["GET", key]);
    },
    async setEx(key, value, seconds) {
      return String(await command(["SET", key, value, "EX", Math.max(1, Number(seconds || 1))])).toUpperCase() === "OK";
    },
    async setNxEx(key, value, seconds) {
      return String(await command(["SET", key, value, "NX", "EX", Math.max(1, Number(seconds || 1))])).toUpperCase() === "OK";
    },
    async del(key) {
      await command(["DEL", key]);
      return true;
    }
  };
}

function parseRedisReply(buffer) {
  if (!buffer.length) return null;
  const type = String.fromCharCode(buffer[0]);
  const lineEnd = buffer.indexOf("\r\n");
  if (lineEnd === -1) return null;
  const line = buffer.subarray(1, lineEnd).toString("utf8");
  const offset = lineEnd + 2;
  if (type === "+") return { value: line, offset };
  if (type === "-") throw new Error(`redis error: ${line}`);
  if (type === ":") return { value: Number(line), offset };
  if (type === "$") {
    const length = Number(line);
    if (length < 0) return { value: null, offset };
    const end = offset + length;
    if (buffer.length < end + 2) return null;
    return { value: buffer.subarray(offset, end).toString("utf8"), offset: end + 2 };
  }
  if (type === "*") {
    const count = Number(line);
    let cursor = offset;
    const values = [];
    for (let index = 0; index < count; index += 1) {
      const parsed = parseRedisReply(buffer.subarray(cursor));
      if (!parsed) return null;
      values.push(parsed.value);
      cursor += parsed.offset;
    }
    return { value: values, offset: cursor };
  }
  throw new Error(`unsupported redis reply: ${type}`);
}

function runtimeJsonSet(key, value, seconds) {
  return runtimeStore.setEx(key, JSON.stringify(value), seconds).catch((error) => {
    console.warn(`runtime set failed ${key}: ${error.message}`);
    return false;
  });
}

async function runtimeJsonGet(key) {
  const raw = await runtimeStore.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function recordDeviceOnlineRuntime(deviceId, value = {}) {
  if (!deviceId) return;
  runtimeJsonSet(`device:online:${deviceId}`, value, DEVICE_ONLINE_TTL_SECONDS);
}

function releaseRuntimeDeviceLock(lock) {
  if (!lock?.deviceId) return;
  const remaining = remainingActiveDeviceLock(state.deviceLocks, lock);
  if (!remaining) {
    runtimeStore.del(`lock:device:${lock.deviceId}`).catch(() => {});
    return;
  }
  const ttlSeconds = Math.max(1, Math.ceil((toTime(remaining.expiresAt) - Date.now()) / 1000));
  runtimeStore.setEx(`lock:device:${remaining.deviceId}`, JSON.stringify(publicDeviceLock(remaining)), ttlSeconds).catch(() => {});
}

async function getTaskProgress(taskId) {
  return await runtimeJsonGet(`task:progress:${taskId}`);
}

function recordTaskProgress(task, windowsTask = null, event = null) {
  if (!task?.taskId) return;
  runtimeJsonSet(`task:progress:${task.taskId}`, taskProgressFromTask(task, windowsTask, event), 24 * 3600);
}

function taskProgressFromTask(task, windowsTask = null, event = null) {
  const events = Array.isArray(task?.events) ? task.events : [];
  const lastEvent = event || events[events.length - 1] || null;
  const status = String(task?.status || windowsTask?.status || "");
  const percent = deriveTaskProgressPercent(status, lastEvent);
  return {
    taskId: task?.taskId || "",
    windowsTaskId: task?.windowsTaskId || windowsTask?.taskId || "",
    status,
    percent,
    stepId: String(lastEvent?.stepId || ""),
    stepIndex: Number.isFinite(Number(lastEvent?.stepIndex)) ? Number(lastEvent.stepIndex) : null,
    message: String(task?.result?.message || task?.result?.action || lastEvent?.message || "").slice(0, 700),
    elapsedMs: Number.isFinite(Number(lastEvent?.detail?.elapsedMs)) ? Number(lastEvent.detail.elapsedMs) : Number.isFinite(Number(lastEvent?.elapsedMs)) ? Number(lastEvent.elapsedMs) : null,
    updatedAt: task?.updatedAt || lastEvent?.createdAt || nowIso()
  };
}

function deriveTaskProgressPercent(status, event = null) {
  if (status === "succeeded") return 100;
  if (["failed", "cancelled", "expired"].includes(status)) return 100;
  if (status === "queued") return 8;
  if (status === "stalled") return 24;
  const stepId = String(event?.stepId || event?.phase || "").toLowerCase();
  const table = [
    [/prepare|push|media|qr/, 16],
    [/launch|restart|start/, 24],
    [/profile|me|mine|home/, 34],
    [/scan|scanner|sao/, 48],
    [/album|gallery|photo/, 62],
    [/pick|image|first/, 74],
    [/confirm_branch|confirm|login/, 88],
    [/finish|done|success/, 96]
  ];
  for (const [pattern, value] of table) {
    if (pattern.test(stepId)) return value;
  }
  return status === "running" ? 24 : 0;
}

async function materializeTaskResultEvidence(input = {}, context = {}) {
  const result = { ...(input || {}) };
  if (result.screenshot) result.screenshot = await materializeScreenshot(result.screenshot, context);
  if (result.uiHierarchy) {
    const asset = await storeEvidenceAsset({
      kind: "uiHierarchy",
      mimeType: "application/xml; charset=utf-8",
      data: String(result.uiHierarchy),
      extension: ".xml",
      taskId: context.taskId || ""
    });
    result.uiHierarchyEvidence = asset;
    result.uiHierarchyUrl = asset.url;
    result.uiHierarchy = "";
  }
  if (result.uiSnapshot && String(result.uiSnapshot).length > MAX_STORED_UI_SNAPSHOT_CHARS) {
    const asset = await storeEvidenceAsset({
      kind: "uiSnapshot",
      mimeType: "text/plain; charset=utf-8",
      data: String(result.uiSnapshot),
      extension: ".txt",
      taskId: context.taskId || ""
    });
    result.uiSnapshotEvidence = asset;
    result.uiSnapshotUrl = asset.url;
    result.uiSnapshot = String(result.uiSnapshot).slice(0, MAX_STORED_UI_SNAPSHOT_CHARS);
  }
  return result;
}

async function materializeEventEvidence(input = {}, context = {}) {
  const event = { ...(input || {}) };
  if (event.screenshot) event.screenshot = await materializeScreenshot(event.screenshot, context);
  const hierarchy = event.uiHierarchy || event.detail?.uiHierarchy || event.detail?.xml || "";
  if (hierarchy) {
    const asset = await storeEvidenceAsset({
      kind: "uiHierarchy",
      mimeType: "application/xml; charset=utf-8",
      data: String(hierarchy),
      extension: ".xml",
      taskId: context.taskId || ""
    });
    event.uiHierarchyEvidence = asset;
    event.uiHierarchyUrl = asset.url;
    event.uiHierarchy = String(hierarchy).slice(0, MAX_STORED_UI_HIERARCHY_CHARS);
    if (event.detail?.uiHierarchy) event.detail.uiHierarchy = "";
    if (event.detail?.xml) event.detail.xml = "";
  }
  return event;
}

async function materializeScreenshot(input = {}, context = {}) {
  if (!input || typeof input !== "object") return null;
  if (input.evidenceId || input.url) return input;
  const dataUrl = String(input.dataUrl || "");
  if (!dataUrl) return input;
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) return input;
  const mimeType = match[1].toLowerCase();
  const extension = mimeType === "image/png" ? ".png" : mimeType === "image/webp" ? ".webp" : ".jpg";
  const asset = await storeEvidenceAsset({
    kind: "screenshot",
    mimeType,
    data: Buffer.from(match[2].replace(/\s/g, ""), "base64"),
    extension,
    taskId: context.taskId || ""
  });
  return {
    ...input,
    dataUrl: "",
    evidenceId: asset.evidenceId,
    url: asset.url,
    storage: "file",
    sha256: asset.sha256,
    sizeBytes: asset.sizeBytes,
    mimeType
  };
}

async function storeEvidenceAsset(input = {}) {
  const evidenceId = newId();
  const createdAt = nowIso();
  const taskId = String(input.taskId || "");
  const safeTask = taskId ? taskId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) : "unassigned";
  const extension = String(input.extension || ".bin").replace(/[^A-Za-z0-9.]/g, "").slice(0, 12) || ".bin";
  const dir = path.join(EVIDENCE_DIR, safeTask);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${createdAt.replace(/[:.]/g, "-")}-${evidenceId}${extension}`);
  const buffer = Buffer.isBuffer(input.data) ? input.data : Buffer.from(String(input.data || ""), "utf8");
  await fs.writeFile(filePath, buffer, { mode: 0o600 });
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const asset = {
    evidenceId,
    kind: String(input.kind || "file"),
    taskId,
    filePath,
    mimeType: String(input.mimeType || "application/octet-stream").slice(0, 120),
    sizeBytes: buffer.length,
    sha256,
    url: `/api/v1/evidence/${encodeURIComponent(evidenceId)}`,
    createdAt
  };
  if (!Array.isArray(state.evidenceAssets)) state.evidenceAssets = [];
  state.evidenceAssets.unshift(asset);
  return publicEvidenceAsset(asset);
}

function publicEvidenceAsset(asset) {
  if (!asset) return null;
  const evidenceId = String(asset.evidenceId || "");
  return {
    evidenceId,
    kind: asset.kind || "",
    mimeType: asset.mimeType || "",
    sizeBytes: Number(asset.sizeBytes || 0),
    sha256: asset.sha256 || "",
    url: signedEvidenceUrl(evidenceId),
    createdAt: asset.createdAt || ""
  };
}

function signedEvidenceUrl(evidenceId) {
  return createEvidenceSignedUrl(evidenceId, {
    secret: EVIDENCE_SIGNING_SECRET,
    ttlSeconds: EVIDENCE_URL_TTL_SECONDS
  });
}

function publicEventHierarchyUrl(event) {
  const evidenceId = event?.uiHierarchyEvidence?.evidenceId || event?.detail?.uiHierarchyEvidence?.evidenceId;
  return evidenceId ? signedEvidenceUrl(evidenceId)
    : String(event?.uiHierarchyUrl || event?.uiHierarchyEvidence?.url || event?.detail?.uiHierarchyUrl || event?.detail?.uiHierarchyEvidence?.url || "");
}

function publicAutomationJob(job) {
  const view = buildPublicAutomationJob(job);
  const result = isTerminalStatus(view.status) ? sanitizeTaskResult(view.result, { includeEvidence: true }) : view.result;
  if (view.kind === "kuaishou_lead" && view.result?.progress && typeof view.result.progress === "object") {
    result.progress = sanitizeKuaishouLeadProgress(view.result.progress);
  }
  return {
    ...view,
    result,
    events: view.events.map((event) => sanitizeStoredEvent(event))
  };
}

function verifyEvidenceSignature(evidenceId, expires, sig) {
  return verifyEvidenceSignedUrl(evidenceId, {
    secret: EVIDENCE_SIGNING_SECRET,
    expires,
    signature: sig
  });
}

async function serveEvidenceAsset(res, evidenceId) {
  const asset = (state.evidenceAssets || []).find((item) => item.evidenceId === evidenceId);
  if (!asset) return json(res, 404, { error: "evidence_not_found" });
  const data = await fs.readFile(asset.filePath);
  res.statusCode = 200;
  res.setHeader("content-type", asset.mimeType || "application/octet-stream");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-length", String(data.length));
  res.end(data);
}

function sanitizeScreenshot(input, options = {}) {
  if (!input || typeof input !== "object") return null;
  const dataUrl = String(input.dataUrl || "");
  const summary = {
    mimeType: String(input.mimeType || input.type || "").slice(0, 80),
    path: String(input.path || "").slice(0, 500),
    width: Number.isFinite(Number(input.width)) ? Number(input.width) : null,
    height: Number.isFinite(Number(input.height)) ? Number(input.height) : null,
    capturedAt: String(input.capturedAt || input.createdAt || "").slice(0, 80),
    hasDataUrl: Boolean(dataUrl),
    sizeBytes: Number.isFinite(Number(input.sizeBytes)) ? Number(input.sizeBytes) : dataUrl.length
  };
  if (input.evidenceId) summary.evidenceId = String(input.evidenceId).slice(0, 120);
  if (input.url || input.evidenceId) summary.url = String(input.evidenceId ? signedEvidenceUrl(String(input.evidenceId)) : input.url).slice(0, 500);
  if (input.storage) summary.storage = String(input.storage).slice(0, 40);
  if (input.sha256) summary.sha256 = String(input.sha256).slice(0, 80);
  if (options.includeDataUrl && dataUrl) summary.dataUrl = dataUrl;
  return summary;
}

function sanitizeEventDetail(input = {}) {
  const detail = cloneJson(input);
  if (detail.uiHierarchy) detail.uiHierarchy = String(detail.uiHierarchy).slice(0, MAX_STORED_UI_HIERARCHY_CHARS);
  if (detail.uiSnapshot) detail.uiSnapshot = String(detail.uiSnapshot).slice(0, MAX_STORED_UI_SNAPSHOT_CHARS);
  if (detail.source) detail.source = String(detail.source).slice(0, MAX_STORED_UI_SNAPSHOT_CHARS);
  if (detail.xml) detail.xml = String(detail.xml).slice(0, MAX_STORED_UI_HIERARCHY_CHARS);
  if (detail.screenshot) detail.screenshot = sanitizeScreenshot(detail.screenshot, { includeDataUrl: true });
  if (detail.uiHierarchyEvidence) {
    detail.uiHierarchyEvidence = publicEvidenceAsset(detail.uiHierarchyEvidence);
    detail.uiHierarchyUrl = detail.uiHierarchyEvidence.url;
  }
  if (detail.uiHierarchyUrl) detail.uiHierarchyUrl = String(detail.uiHierarchyUrl).slice(0, 500);
  return detail;
}

function sanitizeTaskResult(input = {}, options = {}) {
  const result = {
    action: String(input.action || "").slice(0, 500),
    message: String(input.message || "").slice(0, 1000),
    error: String(input.error || "").slice(0, 500),
    errorCode: String(input.errorCode || "").slice(0, 160),
    executionMode: String(input.executionMode || "").slice(0, 80),
    packageName: String(input.packageName || "").slice(0, 160),
    currentActivity: String(input.currentActivity || "").slice(0, 1000),
    durationMs: Number.isFinite(Number(input.durationMs)) ? Number(input.durationMs) : null,
    wallMs: Number.isFinite(Number(input.wallMs)) ? Number(input.wallMs) : null,
    timeoutSeconds: Number.isFinite(Number(input.timeoutSeconds)) ? Number(input.timeoutSeconds) : null
  };
  if (input.collection) result.collection = sanitizeXhsDataCollection(input.collection);
  if (input.uiSnapshot) result.uiSnapshot = String(input.uiSnapshot).slice(0, MAX_STORED_UI_SNAPSHOT_CHARS);
  if (input.uiHierarchy) result.uiHierarchy = String(input.uiHierarchy).slice(0, MAX_STORED_UI_HIERARCHY_CHARS);
  if (input.uiHierarchyUrl) result.uiHierarchyUrl = String(input.uiHierarchyUrl).slice(0, 500);
  if (input.uiSnapshotUrl) result.uiSnapshotUrl = String(input.uiSnapshotUrl).slice(0, 500);
  if (input.uiHierarchyEvidence) {
    result.uiHierarchyEvidence = publicEvidenceAsset(input.uiHierarchyEvidence);
    result.uiHierarchyUrl = result.uiHierarchyEvidence.url;
  }
  if (input.uiSnapshotEvidence) {
    result.uiSnapshotEvidence = publicEvidenceAsset(input.uiSnapshotEvidence);
    result.uiSnapshotUrl = result.uiSnapshotEvidence.url;
  }
  if (input.screenshot) result.screenshot = sanitizeScreenshot(input.screenshot, { includeDataUrl: options.includeEvidence === true });
  for (const key of ["qrTimings", "preRunTimings", "timings", "diagnostic"]) {
    if (input[key] && typeof input[key] === "object") result[key] = cloneJson(input[key]);
  }
  for (const key of ["realNameTailCharacter", "alipayDisplayName", "matchedPhone", "currentAccount", "accountSwitchReason", "remotePaths", "publishedAt"]) {
    if (input[key] !== undefined && input[key] !== null) result[key] = Array.isArray(input[key])
      ? input[key].map((value) => String(value).slice(0, 500)).slice(0, MAX_PUBLISH_IMAGES)
      : String(input[key]).slice(0, 500);
  }
  if (Number.isFinite(Number(input.recoveryAttempts))) result.recoveryAttempts = Number(input.recoveryAttempts);
  if (Number.isFinite(Number(input.accountSwitchCount))) result.accountSwitchCount = Math.max(0, Number(input.accountSwitchCount));
  if (input.accountSwitched !== undefined) result.accountSwitched = Boolean(input.accountSwitched);
  if (input.accountIdentityVerified !== undefined) result.accountIdentityVerified = input.accountIdentityVerified === true;
  if (input.notFound !== undefined) result.notFound = Boolean(input.notFound);
  if (Array.isArray(input.savedAccounts)) {
    result.savedAccounts = input.savedAccounts.slice(0, 12).map((choice) => ({
      account: String(choice?.account || "").slice(0, 120),
      current: Boolean(choice?.current)
    })).filter((choice) => choice.account);
  }
  if (Array.isArray(input.events)) result.events = input.events.slice(-30).map((event) => sanitizeStoredEvent(event));
  if (input.runner && typeof input.runner === "object") {
    result.runner = {
      ok: Boolean(input.runner.ok),
      exitCode: Number.isFinite(Number(input.runner.exitCode)) ? Number(input.runner.exitCode) : null,
      error: String(input.runner.error || "").slice(0, 1000),
      log: Array.isArray(input.runner.log) ? input.runner.log.slice(-80).map((item) => sanitizeRunnerLogItem(item)) : []
    };
  }
  return result;
}

function sanitizeKuaishouLeadProgress(input = {}) {
  return {
    processedCount: Math.max(0, Number(input.processedCount || 0)),
    successCount: Math.max(0, Number(input.successCount || 0)),
    failedAttemptCount: Math.max(0, Number(input.failedAttemptCount || 0)),
    unknownCount: Math.max(0, Number(input.unknownCount || 0)),
    skippedCount: Math.max(0, Number(input.skippedCount || 0)),
    currentRow: Math.max(0, Number(input.currentRow || 0)),
    currentPhone: String(input.currentPhone || "").slice(0, 32),
    currentCity: String(input.currentCity || "").slice(0, 80),
    lastRow: Math.max(0, Number(input.lastRow || 0)),
    lastStatus: String(input.lastStatus || "").slice(0, 80),
    lastQueueEvent: String(input.lastQueueEvent || "").slice(0, 80),
    lastEventAt: String(input.lastEventAt || "").slice(0, 80),
    nextRunAt: String(input.nextRunAt || "").slice(0, 80),
    heartbeatAt: String(input.heartbeatAt || "").slice(0, 80)
  };
}

function sanitizeRunnerLogItem(input = {}) {
  return {
    step: String(input.step || input.stepId || "").slice(0, 120),
    action: String(input.action || "").slice(0, 200),
    message: String(input.message || "").slice(0, 500),
    elapsedMs: Number.isFinite(Number(input.elapsedMs)) ? Number(input.elapsedMs) : null,
    sinceLastMs: Number.isFinite(Number(input.sinceLastMs)) ? Number(input.sinceLastMs) : null,
    x: Number.isFinite(Number(input.x)) ? Number(input.x) : null,
    y: Number.isFinite(Number(input.y)) ? Number(input.y) : null,
    width: Number.isFinite(Number(input.width)) ? Number(input.width) : null,
    height: Number.isFinite(Number(input.height)) ? Number(input.height) : null,
    error: String(input.error || "").slice(0, 500)
  };
}

function sanitizeStoredEvent(input = {}) {
  const uiHierarchyEvidence = input.uiHierarchyEvidence ? publicEvidenceAsset(input.uiHierarchyEvidence) : null;
  const event = {
    ...cloneJson(input),
    message: String(input.message || "").slice(0, 2000),
    stepId: String(input.stepId || "").slice(0, 120),
    errorCode: String(input.errorCode || "").slice(0, 120),
    packageName: String(input.packageName || "").slice(0, 160),
    currentActivity: String(input.currentActivity || "").slice(0, 1000),
    uiSnapshot: String(input.uiSnapshot || "").slice(0, MAX_STORED_UI_SNAPSHOT_CHARS),
    uiHierarchy: String(input.uiHierarchy || input.uiSnapshot || "").slice(0, MAX_STORED_UI_HIERARCHY_CHARS),
    uiHierarchyEvidence,
    uiHierarchyUrl: String(uiHierarchyEvidence?.url || input.uiHierarchyUrl || "").slice(0, 500),
    detail: sanitizeEventDetail(input.detail || {}),
    screenshot: sanitizeScreenshot(input.screenshot, { includeDataUrl: true })
  };
  return event;
}

function compactCompletedTask(task) {
  if (!task || !isTerminalStatus(task.status)) return task;
  compactTaskPayload(task);
  if (task.result) task.result = sanitizeTaskResult(task.result, { includeEvidence: true });
  const xhsTaskId = String(task.payload?.xhsTaskId || "");
  const xhsTask = xhsTaskId ? state.xhsQrTasks.find((item) => item.taskId === xhsTaskId) : null;
  if (xhsTask && isTerminalStatus(xhsTask.status) && xhsTask.qrImageDataUrl) delete xhsTask.qrImageDataUrl;
  return task;
}

function normalizeQrImageDataUrl(value) {
  return normalizeImageDataUrl(value, "qrImageDataUrl");
}

function normalizeImageDataUrl(value, fieldName = "imageDataUrl") {
  const text = String(value || "").trim();
  if (!text) throw badRequest(`${fieldName} is required`);

  const match = text.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) throw badRequest(`${fieldName} must be a PNG, JPEG, or WebP data URL`);

  const mime = match[1].toLowerCase();
  const base64 = match[2].replace(/\s/g, "");
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length) throw badRequest(`${fieldName} is required`);
  if (bytes.length > MAX_QR_IMAGE_BYTES) throw badRequest(`${fieldName} must be <= ${MAX_QR_IMAGE_BYTES} bytes`);
  if (!imageMagicMatches(mime, bytes)) throw badRequest(`${fieldName} image content does not match its MIME type`);

  return `data:${mime};base64,${base64}`;
}

function screenSessionOwnerId(ctx) {
  if (ctx?.userId) return String(ctx.userId);
  return ctx?.role === "admin" ? `admin:${ctx.username || "admin"}` : "";
}

function imageMagicMatches(mime, bytes) {
  if (mime === "image/png") {
    return bytes.length >= 8
      && bytes[0] === 0x89
      && bytes[1] === 0x50
      && bytes[2] === 0x4e
      && bytes[3] === 0x47
      && bytes[4] === 0x0d
      && bytes[5] === 0x0a
      && bytes[6] === 0x1a
      && bytes[7] === 0x0a;
  }
  if (mime === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mime === "image/webp") {
    return bytes.length >= 12
      && bytes.toString("ascii", 0, 4) === "RIFF"
      && bytes.toString("ascii", 8, 12) === "WEBP";
  }
  return false;
}

function buildAvailablePhones() {
  expireSmsOrders();
  const busyPhones = new Set(state.smsOrders
    .filter((order) => order.status === "waiting" && order.phoneNumber)
    .map((order) => order.phoneNumber));
  return state.devices
    .filter((device) => isDeviceListed(device) && isDeviceUsable(device))
    .flatMap((device) => (device.sims || [])
      .filter((sim) => sim.enabled !== false && sim.phoneNumber && !busyPhones.has(sim.phoneNumber))
      .map((sim) => ({
        phoneNumber: sim.phoneNumber,
        carrierName: sim.carrierName || "",
        label: sim.label || `SIM ${Number(sim.slotIndex || 0) + 1}`,
        platform: "小红书",
        deviceName: device.deviceName || "手机资源"
      })));
}

function resolveSmsOrderTarget(input = {}) {
  const phoneNumber = normalizePhone(input.phoneNumber);
  const deviceId = String(input.deviceId || "").trim();
  const slotIndex = input.slotIndex === undefined || input.slotIndex === "" ? null : normalizeOptionalInt(input.slotIndex);
  const subscriptionId = input.subscriptionId === undefined || input.subscriptionId === "" ? null : normalizeOptionalInt(input.subscriptionId);
  let device = deviceId ? state.devices.find((item) => item.deviceId === deviceId) : null;
  let sim = null;
  if (device) {
    sim = (device.sims || []).find((item) => {
      if (phoneNumber && item.phoneNumber === phoneNumber) return true;
      if (slotIndex !== null && slotIndex !== undefined && Number(item.slotIndex ?? 0) === Number(slotIndex)) return true;
      if (subscriptionId !== null && subscriptionId !== undefined && Number(item.subscriptionId ?? -1) === Number(subscriptionId)) return true;
      return false;
    }) || null;
  }
  if (!device && phoneNumber) {
    for (const candidate of state.devices) {
      const matched = (candidate.sims || []).find((item) => item.phoneNumber === phoneNumber);
      if (matched) {
        device = candidate;
        sim = matched;
        break;
      }
    }
  }
  return {
    deviceId: device?.deviceId || deviceId,
    phoneNumber: phoneNumber || sim?.phoneNumber || "",
    subscriptionId: subscriptionId ?? sim?.subscriptionId ?? null,
    slotIndex: slotIndex ?? sim?.slotIndex ?? null,
    matchMode: "first_new_sms",
    startedAt: nowIso()
  };
}

function smsMessagesForDevice(deviceId = "") {
  return deviceId ? smsMessageIndex.forDevice(deviceId) : smsMessageIndex.all();
}

function visibleSmsMessagesForUser(userId, deviceId = "") {
  const userOrders = state.smsOrders.filter((order) => order.userId === userId && (!deviceId || order.deviceId === deviceId));
  if (!userOrders.length) return [];
  const sourceMessages = deviceId ? smsMessagesForDevice(deviceId) : smsMessageIndex.all();
  return sourceMessages.filter((message) => {
    if (deviceId && message.deviceId !== deviceId) return false;
    return userOrders.some((order) => smsOrderHasMatchedMessage(order, message));
  });
}

function smsOrderHasMatchedMessage(order, message) {
  if (!order || !message || order.status !== "received") return false;
  if (order.smsMessageId && message.messageId === order.smsMessageId) return true;
  return Boolean(order.smsMessageId || order.smsEventId) && smsOrderCanSeeMessage(order, message);
}

function smsOrderCanSeeMessage(order, message) {
  if (!order || !message) return false;
  if (order.deviceId && message.deviceId !== order.deviceId) return false;
  if (order.smsMessageId && message.messageId === order.smsMessageId) return true;
  const messageTime = toTime(message.messageAt || message.receivedAt || message.createdAt);
  const startedAt = toTime(order.startedAt || order.createdAt);
  const expiresAt = toTime(order.expiresAt);
  if (!Number.isFinite(messageTime) || !Number.isFinite(startedAt) || !Number.isFinite(expiresAt)) return false;
  if (messageTime < startedAt - 1000 || messageTime > expiresAt) return false;
  if (order.phoneNumber && message.phoneNumber && message.phoneNumber !== order.phoneNumber) return false;
  if (order.subscriptionId !== null && order.subscriptionId !== undefined && message.subscriptionId !== null && message.subscriptionId !== undefined && Number(message.subscriptionId) !== Number(order.subscriptionId)) return false;
  if (order.slotIndex !== null && order.slotIndex !== undefined && message.slotIndex !== null && message.slotIndex !== undefined && Number(message.slotIndex) !== Number(order.slotIndex)) return false;
  return true;
}

function publicUserDevice(device, ctx = null) {
  const waitingPhones = new Set(state.smsOrders
    .filter((order) => order.status === "waiting" && order.phoneNumber)
    .map((order) => order.phoneNumber));
  const activeXhs = activeXhsTaskCount(device.deviceId);
  const busySims = (device.sims || []).filter((sim) => sim.phoneNumber && waitingPhones.has(sim.phoneNumber));
  const smsLibraryCount = smsMessageIndex.countForDevice(device.deviceId);
  const adbOnline = isAdbOnline(device);
  const agentOnline = isDeviceAgentOnline(device);
  const windowsAgent = device.adb?.agentId ? state.windowsAgents.find((agent) => agent.agentId === device.adb.agentId) : null;
  const airtest = windowsAgent?.health?.airtest || {};
  const deviceAutomation = device.automation || {};
  const online = adbOnline || agentOnline;
  const activeXhsTask = activeXhsTaskForDevice(device.deviceId);
  const activeLock = activeDeviceLockForTask(device.deviceId);
  const activeScreenSession = screenSessions.activeForDevice(device.deviceId);
  const screenOwnerUserId = screenSessionOwnerId(ctx);
  const screenControlAccess = { allowAdminOverride: ctx?.role === "admin" };
  const screenOwnerLookupSession = canShareDeviceLockWithScreenControl(activeLock, screenOwnerUserId, screenControlAccess)
    ? (state.automationSessions || []).find((session) => session.sessionId === activeLock.taskId) || null
    : null;
  const screenControlConcurrentLookupAllowed = Boolean(
    !activeScreenSession
    && canShareLookupSessionWithScreenControl(
      activeLock,
      screenOwnerUserId,
      screenOwnerLookupSession,
      screenControlAccess
    )
    && !activeDeviceLockForScreenControl(device.deviceId, screenOwnerUserId, screenControlAccess)
  );
  const screenControlNeedsHumanAction = Boolean(
    screenOwnerLookupSession
    && lookupSessionNeedsHumanAction(screenOwnerLookupSession)
  );
  const waitingSmsOrder = state.smsOrders.find((order) => (
    order.status === "waiting"
    && (order.deviceId === device.deviceId || (order.phoneNumber && busySims.some((sim) => sim.phoneNumber === order.phoneNumber)))
  ));
  const occupancy = deviceOccupancyForViewer(device, ctx, {
    activeLock,
    activeXhsTask,
    activeScreenSession,
    waitingSmsOrder
  });
  const busy = Boolean(busySims.length || activeXhs > 0 || activeLock);
  return {
    deviceId: device.deviceId,
    deviceName: device.deviceName || device.deviceId,
    model: device.model || "",
    manufacturer: device.manufacturer || device.adb?.manufacturer || "",
    brand: device.brand || device.adb?.brand || "",
    androidVersion: device.androidVersion || "",
    batteryLevel: device.batteryLevel ?? null,
    adbState: device.adb?.state || "",
    connectionState: device.recovery?.state || device.adb?.state || "unknown",
    adbOnline,
    agentOnline,
    listingStatus: normalizeDeviceListingStatus(device.listingStatus || "listed"),
    xhsDataCollectionReady: hasXhsDataCollectionCapability(windowsAgent),
    automationStatus: {
      checkedAt: windowsAgent?.health?.checkedAt || null,
      windowsAgentOnline: windowsAgent ? Date.now() - new Date(windowsAgent.lastSeenAt).getTime() < WINDOWS_AGENT_ONLINE_MS : false,
      airtestEnabled: airtest.enabled !== false,
      airtestReady: Boolean(airtest.ok || deviceAutomation.airtestReady),
      airtestPythonCommand: airtest.pythonCommand || "",
      airtestLastError: airtest.lastError || "",
      pocoReady: Boolean(deviceAutomation.pocoReady),
      yosemiteReady: Boolean(deviceAutomation.yosemiteReady),
      deviceAutomationReady: Boolean(deviceAutomation.ok),
      devicePreflightStatus: deviceAutomation.status || "unknown",
      devicePreflightCheckedAt: deviceAutomation.checkedAt || "",
      helpersReady: Boolean(deviceAutomation.helpersReady),
      xhsInstalled: Boolean(deviceAutomation.xhsInstalled),
      xhsPackageName: deviceAutomation.xhsPackageName || "com.xingin.xhs",
      androidSdk: Number(deviceAutomation.androidSdk || 0),
      phantomProcessLimit: deviceAutomation.phantomProcessLimit || "",
      phantomProcessConfigured: Boolean(deviceAutomation.phantomProcessConfigured),
      accessibilityServices: deviceAutomation.accessibilityServices || [],
      accessibilityConflicts: deviceAutomation.accessibilityConflicts || [],
      repairAction: deviceAutomation.repairAction || "",
      deviceAutomationError: deviceAutomation.lastError || ""
    },
    online,
    available: isDeviceUsable(device) && !busy,
    lastSeenAt: device.lastSeenAt || null,
    adbLastSeenAt: device.adb?.lastSeenAt || null,
    smsLibraryCount,
    busy,
    occupancy,
    busyReasons: [
      ...(occupancy ? [`${occupancy.ownerLabel}正在${occupancy.label}`] : []),
      ...(!occupancy && busySims.length ? [`短信等待中 ${busySims.length} 个号码`] : []),
      ...(!occupancy && activeXhs > 0 ? [`扫码任务执行中 ${activeXhs} 个`] : []),
      ...(!occupancy && activeScreenSession ? ["实时控制中"] : [])
    ],
    screenControlAvailable: Boolean(adbOnline && device.adb?.agentId && screenRelay?.agentOnline(device.adb.agentId)),
    screenControlConcurrentLookupAllowed,
    screenControlNeedsHumanAction,
    screenControlBusy: Boolean(activeScreenSession),
    screenSession: activeScreenSession ? {
      sessionId: activeScreenSession.sessionId,
      status: activeScreenSession.status,
      statusMessage: activeScreenSession.statusMessage
    } : null,
    activeXhsTask: activeXhsTask ? publicXhsTaskOccupancy(activeXhsTask) : null,
    sims: (device.sims || []).map((sim, index) => ({
      subscriptionId: sim.subscriptionId ?? index,
      slotIndex: sim.slotIndex ?? index,
      carrierName: sim.carrierName || "",
      phoneNumber: sim.phoneNumber || "",
      label: sim.label || `SIM ${Number(sim.slotIndex ?? index) + 1}`,
      enabled: sim.enabled !== false,
      busy: Boolean(sim.phoneNumber && waitingPhones.has(sim.phoneNumber))
    })),
    xhsAccounts: normalizeXhsAccounts(device.xhsAccounts || [])
      .filter((account) => account.enabled !== false)
      .map((account) => {
        const activeSlotTask = activeXhsTaskForDeviceSlot(device.deviceId, account.appSlot);
        return {
          appSlot: account.appSlot,
          label: account.label,
          xhsId: account.xhsId || "",
          accountName: account.accountName || "",
          enabled: account.enabled !== false,
          busy: Boolean(activeSlotTask || activeXhsTask),
          busyTaskId: (activeSlotTask || activeXhsTask)?.taskId || ""
        };
      })
  };
}

function pickXhsTarget(preferredDeviceId = "", preferredAppSlot = "", options = {}) {
  const candidates = state.devices.map((device) => {
    if (preferredDeviceId && device.deviceId !== preferredDeviceId) return false;
    if (options.requireListed && !isDeviceListed(device)) return false;
    if (!isDeviceUsable(device)) return false;
    if (!hasWindowsAdbBinding(device)) return false;
    if (activeDeviceLockForTask(device.deviceId, preferredAppSlot)) return false;
    if (activeXhsTaskCount(device.deviceId) >= DEVICE_MAX_ACTIVE_XHS_TASKS) return false;
    const account = pickXhsAccount(device, preferredAppSlot);
    if (account && activeXhsTaskForDeviceSlot(device.deviceId, account.appSlot)) return false;
    return account ? { device, account } : false;
  }).filter(Boolean);
  return candidates.sort((a, b) => activeXhsTaskCount(a.device.deviceId) - activeXhsTaskCount(b.device.deviceId))[0] || null;
}

function pickXhsAccount(device, preferredAppSlot = "") {
  const accounts = (device.xhsAccounts || normalizeXhsAccounts([])).filter((account) => (
    account.enabled !== false && String(account.accountName || "").trim()
  ));
  const slot = String(preferredAppSlot || "").trim();
  if (slot) return accounts.find((account) => account.appSlot === normalizeXhsAppSlot(slot)) || null;
  return accounts[0] || null;
}

function xhsTaskConflictForRequest(deviceId = "", xhsAppSlot = "") {
  const normalizedDeviceId = String(deviceId || "");
  if (!normalizedDeviceId) return null;
  const normalizedSlot = xhsAppSlot ? normalizeXhsAppSlot(xhsAppSlot) : "";
  const lock = activeDeviceLockForTask(normalizedDeviceId, normalizedSlot);
  if (lock) {
    const sameSlot = normalizedSlot && lock.appSlot === normalizedSlot;
    return {
      error: sameSlot ? "account_slot_busy" : "device_busy",
      detail: sameSlot ? "当前账号槽位正在执行扫码任务，请等待完成后再提交" : "当前手机正在执行扫码任务，请等待完成后再提交",
      conflict: publicDeviceLock(lock)
    };
  }
  const slotTask = normalizedSlot ? activeXhsTaskForDeviceSlot(normalizedDeviceId, normalizedSlot) : null;
  if (slotTask) {
    return {
      error: "account_slot_busy",
      detail: "当前小红书账号槽位正在执行扫码任务，请等待完成后再提交",
      conflict: publicXhsTaskOccupancy(slotTask)
    };
  }
  const deviceTask = activeXhsTaskForDevice(normalizedDeviceId);
  if (deviceTask || activeXhsTaskCount(normalizedDeviceId) >= DEVICE_MAX_ACTIVE_XHS_TASKS) {
    return {
      error: "device_busy",
      detail: "当前手机正在执行扫码任务，请等待完成后再提交",
      conflict: deviceTask ? publicXhsTaskOccupancy(deviceTask) : null
    };
  }
  return null;
}

function activeXhsTaskForDevice(deviceId) {
  return state.xhsQrTasks.find((task) => task.deviceId === deviceId && isActiveXhsTask(task)) || null;
}

function activeXhsTaskForDeviceSlot(deviceId, xhsAppSlot) {
  const normalizedSlot = normalizeXhsAppSlot(xhsAppSlot || "app1");
  return state.xhsQrTasks.find((task) => (
    task.deviceId === deviceId
    && normalizeXhsAppSlot(task.xhsAppSlot || "app1") === normalizedSlot
    && isActiveXhsTask(task)
  )) || null;
}

function activeXhsTaskCount(deviceId) {
  return state.xhsQrTasks.filter((task) => task.deviceId === deviceId && isActiveXhsTask(task)).length;
}

function activeXhsTaskCountForUser(userId) {
  return state.xhsQrTasks.filter((task) => task.userId === userId && isActiveXhsTask(task)).length;
}

function isActiveXhsTask(task) {
  return ["queued", "running", "stalled"].includes(task?.status);
}

function isWindowsManagedXhsTask(task) {
  return ["windows_airtest_poco", "windows_appium", "windows_adb_uiautomator", "windows_xml_uiautomator"].includes(task?.executionMode);
}

function publicXhsTaskOccupancy(task) {
  return {
    taskId: task.taskId,
    deviceId: task.deviceId,
    xhsAppSlot: task.xhsAppSlot || "app1",
    xhsAccountLabel: task.xhsAccountLabel || "",
    xhsAccountId: task.xhsAccountId || "",
    xhsAccountName: task.xhsAccountName || "",
    status: task.status,
    userId: task.userId || "",
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}

function isTerminalStatus(status) {
  return ["succeeded", "failed", "cancelled", "expired"].includes(status);
}

function waitingSmsCountForUser(userId) {
  expireSmsOrders();
  return state.smsOrders.filter((order) => order.userId === userId && order.status === "waiting").length;
}

function isDeviceUsable(device) {
  return isAdbOnline(device) && isDeviceAutomationReady(device);
}

function isDeviceListed(device) {
  return normalizeDeviceListingStatus(device?.listingStatus || "listed") === "listed";
}

function normalizeDeviceListingStatus(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (["listed", "published", "online", "上架", "已上架"].includes(text)) return "listed";
  if (["unlisted", "offline", "hidden", "下架", "已下架"].includes(text)) return "unlisted";
  return "pending";
}

function isAdbOnline(device) {
  if (device?.adb?.state !== "device") return false;
  const seenAt = device.adb?.lastSeenAt || device.adb?.updatedAt;
  return Boolean(seenAt && Date.now() - new Date(seenAt).getTime() < WINDOWS_AGENT_ONLINE_MS);
}

function isWindowsAgentOnline(agent) {
  const seenAt = agent?.lastSeenAt;
  return Boolean(seenAt && Date.now() - new Date(seenAt).getTime() < WINDOWS_AGENT_ONLINE_MS);
}

function hasWindowsAdbBinding(device) {
  return Boolean(device?.adb?.agentId && device?.adb?.serial);
}

function isDeviceAutomationReady(device) {
  const automation = device?.automation || {};
  if (isAdbOnline(device) && hasWindowsAdbBinding(device) && isAdbModeAutomationStatus(automation)) return true;
  return Boolean(
    isAdbOnline(device) &&
    hasWindowsAdbBinding(device) &&
    automation.ok &&
    automation.airtestReady &&
    automation.pocoReady &&
    automation.helpersReady
  );
}

function deviceAutomationError(device) {
  const automation = device?.automation || {};
  if (!isAdbOnline(device)) return "ADB 设备未在线";
  if (!hasWindowsAdbBinding(device)) return "Windows 管理器未绑定该 ADB 设备";
  if (isAdbModeAutomationStatus(automation)) return "";
  if (!automation.ok) return automation.lastError || `自动化预检未通过：${automation.status || "unknown"}`;
  if (!automation.airtestReady) return "Airtest/Poco 未就绪";
  if (!automation.pocoReady) return "PocoService 未就绪";
  if (!automation.helpersReady) return "手机端自动化组件未就绪";
  return "";
}

function isAdbModeAutomationStatus(automation = {}) {
  const lastError = String(automation.lastError || "");
  const status = String(automation.status || "");
  return lastError === "airtest_disabled" || ["unknown", "queued", "offline"].includes(status);
}

function isDeviceAgentOnline(device) {
  return Boolean(device?.lastSeenAt && Date.now() - new Date(device.lastSeenAt).getTime() < DEVICE_AGENT_ONLINE_MS);
}

function publicUserSmsOrder(order) {
  return {
    orderId: order.orderId,
    deviceId: order.deviceId || "",
    phoneNumber: order.phoneNumber,
    subscriptionId: order.subscriptionId ?? null,
    slotIndex: order.slotIndex ?? null,
    platform: order.platform,
    matchMode: order.matchMode || "first_new_sms",
    status: order.status,
    code: order.code,
    sender: order.sender || "",
    body: order.body || "",
    smsMessageId: order.smsMessageId || "",
    matchedAt: order.matchedAt || "",
    cancellable: order.status === "waiting",
    createdAt: order.createdAt,
    startedAt: order.startedAt || order.createdAt,
    updatedAt: order.updatedAt,
    expiresAt: order.expiresAt
  };
}

function publicOpenSmsRequest(order) {
  return {
    requestId: order.orderId,
    status: order.status,
    code: order.code || "",
    sender: order.sender || "",
    body: order.body ? maskSmsBody(order.body, order.code) : "",
    platform: order.platform,
    phoneNumber: maskPhone(order.phoneNumber),
    deviceId: order.deviceId || "",
    matchStrategy: order.matchStrategy || "",
    matchedAt: order.matchedAt || "",
    createdAt: order.createdAt,
    startedAt: order.startedAt || order.createdAt,
    updatedAt: order.updatedAt,
    expiresAt: order.expiresAt
  };
}

function publicUserXhsTask(task) {
  const events = publicXhsTaskEvents(task);
  return {
    taskId: task.taskId,
    deviceId: task.deviceId || "",
    platform: task.platform,
    xhsAppSlot: task.xhsAppSlot || "app1",
    xhsAccountLabel: task.xhsAccountLabel || "",
    xhsAccountId: task.xhsAccountId || "",
    xhsAccountName: task.xhsAccountName || "",
    executionMode: task.executionMode || "legacy_device_agent",
    windowsTaskId: task.windowsTaskId || "",
    agentId: task.agentId || "",
    adbSerial: task.adbSerial || "",
    status: task.status,
    result: sanitizeTaskResult(task.result || {}),
    progress: taskProgressFromTask(task),
    summary: summarizeXhsTask(task),
    events,
    cancellable: ["queued", "running", "stalled"].includes(task.status),
    recoverable: task.recoverable !== false && task.status === "stalled",
    stalledAt: task.stalledAt || "",
    lockId: task.lockId || "",
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    pickedAt: task.pickedAt || null,
    completedAt: task.completedAt || null
  };
}

function publicAdminXhsTask(task, options = {}) {
  const includeEvidence = options.includeEvidence === true;
  const events = publicXhsTaskEvents(task, {
    includeScreenshot: includeEvidence,
    includeUiSnapshot: includeEvidence,
    limit: includeEvidence ? 50 : 10
  });
  const result = sanitizeTaskResult(task.result || {}, { includeEvidence });
  if (!includeEvidence) {
    delete result.runner;
    delete result.uiSnapshot;
    delete result.uiHierarchy;
    delete result.screenshot;
  }
  return {
    taskId: task.taskId,
    userId: task.userId || "",
    requestedBy: publicXhsTaskRequester(task),
    source: task.source || "admin",
    deviceId: task.deviceId,
    platform: task.platform,
    xhsAppSlot: task.xhsAppSlot || "app1",
    xhsAccountLabel: task.xhsAccountLabel || "",
    xhsAccountId: task.xhsAccountId || "",
    xhsAccountName: task.xhsAccountName || "",
    executionMode: task.executionMode || "legacy_device_agent",
    windowsTaskId: task.windowsTaskId || "",
    agentId: task.agentId || "",
    adbSerial: task.adbSerial || "",
    status: task.status,
    result,
    progress: taskProgressFromTask(task),
    summary: summarizeXhsTask(task, {
      includeScreenshot: includeEvidence,
      includeUiSnapshot: includeEvidence
    }),
    events,
    recoverable: task.recoverable !== false && task.status === "stalled",
    stalledAt: task.stalledAt || "",
    lockId: task.lockId || "",
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    pickedAt: task.pickedAt || null,
    completedAt: task.completedAt || null
  };
}

function publicXhsTaskRequester(task) {
  const userId = String(task?.userId || "");
  const user = userId ? state.users.find((item) => item.userId === userId) : null;
  if (user) {
    return {
      userId,
      username: user.username || "",
      displayName: user.displayName || user.username || "",
      role: user.role || "user",
      source: task?.source || "user"
    };
  }
  if (userId) {
    return {
      userId,
      username: "",
      displayName: userId,
      role: "external",
      source: task?.source || "external"
    };
  }
  return {
    userId: "",
    username: "",
    displayName: task?.source === "admin" ? "管理员操作" : "未知用户",
    role: task?.source === "admin" ? "admin" : "unknown",
    source: task?.source || "unknown"
  };
}

function publicXhsTaskEvents(task, options = {}) {
  const limit = boundedInt(options.limit, 10, 1, 50);
  return (Array.isArray(task.events) ? task.events : [])
    .slice(-limit)
    .map((event) => publicXhsEventSummary(event, options));
}

function summarizeXhsTask(task, options = {}) {
  const events = Array.isArray(task.events) ? task.events : [];
  const lastEvent = events[events.length - 1] || null;
  const result = task.result || {};
  const failureMessage = ["failed", "expired"].includes(task.status)
    ? String(result.message || result.error || lastEvent?.message || "").slice(0, 500)
    : "";
  const progressMessage = String(result.action || lastEvent?.message || failureMessage || "").slice(0, 500);
  return {
    eventCount: events.length,
    screenshotCount: countUniqueTaskScreenshots(task),
    progressMessage,
    failureMessage,
    lastEvent: lastEvent ? publicXhsEventSummary(lastEvent, options) : null,
    statusAt: task.completedAt || task.updatedAt || task.createdAt
  };
}

function countUniqueTaskScreenshots(task) {
  const screenshots = [
    task?.result?.screenshot,
    ...(Array.isArray(task?.events) ? task.events.map((event) => event?.screenshot) : [])
  ].filter(Boolean);
  const seen = new Set();
  for (const screenshot of screenshots) {
    const dataUrl = String(screenshot.dataUrl || "");
    const hasReadableSource = Boolean(screenshot.evidenceId || screenshot.url || dataUrl);
    if (!hasReadableSource) continue;
    const key = String(
      screenshot.evidenceId
      || screenshot.sha256
      || screenshot.url
      || [screenshot.capturedAt || screenshot.createdAt || "", screenshot.sizeBytes || 0, dataUrl.length].join(":")
    );
    if (key) seen.add(key);
  }
  return seen.size;
}

function publicXhsEventSummary(event, options = {}) {
  const screenshot = event?.screenshot ? sanitizeScreenshot(event.screenshot, { includeDataUrl: options.includeScreenshot === true }) : null;
  const uiHierarchyUrl = publicEventHierarchyUrl(event);
  const summary = {
    phase: String(event.phase || ""),
    level: String(event.level || "info"),
    message: String(event.message || "").slice(0, 500),
    stepIndex: Number.isFinite(Number(event.stepIndex)) ? Number(event.stepIndex) : null,
    stepId: String(event.stepId || ""),
    errorCode: String(event.errorCode || ""),
    packageName: String(event.packageName || ""),
    currentActivity: String(event.currentActivity || ""),
    uiSnapshot: options.includeUiSnapshot ? String(event.uiSnapshot || "").slice(0, 1000) : "",
    uiHierarchy: options.includeScreenshot ? String(event.uiHierarchy || event.uiSnapshot || "").slice(0, MAX_STORED_UI_HIERARCHY_CHARS) : "",
    uiHierarchyUrl,
    uiHierarchyEvidence: event.uiHierarchyEvidence ? publicEvidenceAsset(event.uiHierarchyEvidence) : null,
    hasScreenshot: Boolean(screenshot),
    createdAt: event.createdAt || ""
  };
  if (screenshot) {
    summary.screenshot = screenshot;
  }
  return summary;
}

function matchSmsEvent(event) {
  const order = matchSmsOrderWithMessage({
    messageId: "",
    deviceId: event.deviceId,
    phoneNumber: event.phoneNumber,
    subscriptionId: event.subscriptionId,
    slotIndex: event.slotIndex,
    address: event.sender,
    platform: event.platform,
    body: event.body,
    code: event.code,
    messageAt: event.receivedAt,
    receivedAt: event.receivedAt
  }, { smsEventId: event.eventId });
  if (order) event.matchedOrderId = order.orderId;
}

function matchSmsOrdersFromLibrary(messages) {
  const incoming = (Array.isArray(messages) ? messages : [])
    .filter((message) => message && message.box === "inbox")
    .slice()
    .sort((a, b) => toTime(a.messageAt || a.receivedAt || a.createdAt) - toTime(b.messageAt || b.receivedAt || b.createdAt));
  for (const message of incoming) matchSmsOrderWithMessage(message);
}

function matchSmsOrderWithMessage(message, detail = {}) {
  const messageTime = toTime(message.messageAt || message.receivedAt || message.createdAt);
  if (!Number.isFinite(messageTime)) return null;
  const match = selectSmsOrderMatch(state.smsOrders, message, messageTime);
  const order = match?.order || null;
  if (!order) return null;
  order.status = "received";
  order.code = String(message.code || extractCode(message.body) || "");
  order.smsEventId = detail.smsEventId || order.smsEventId || "";
  order.smsMessageId = message.messageId || order.smsMessageId || "";
  order.sender = message.address || message.sender || "";
  order.body = String(message.body || "").slice(0, 8000);
  order.matchStrategy = match.strategy;
  order.matchCandidateCount = Number(match.candidateCount || 0);
  order.matchedAt = nowIso();
  order.updatedAt = order.matchedAt;
  return order;
}

function findDuplicateSmsEvent(event) {
  if (event.eventFingerprint) {
    const byFingerprint = state.smsEvents.find((item) => item.deviceId === event.deviceId && item.eventFingerprint === event.eventFingerprint);
    if (byFingerprint) return byFingerprint;
  }

  const eventTime = new Date(event.receivedAt).getTime();
  if (!Number.isFinite(eventTime)) return null;
  return state.smsEvents.find((item) => {
    if (item.deviceId !== event.deviceId) return false;
    if (item.phoneNumber !== event.phoneNumber) return false;
    if ((item.subscriptionId ?? null) !== (event.subscriptionId ?? null)) return false;
    if ((item.slotIndex ?? null) !== (event.slotIndex ?? null)) return false;
    if (item.sender !== event.sender || item.body !== event.body || item.code !== event.code) return false;
    const itemTime = new Date(item.receivedAt).getTime();
    return Number.isFinite(itemTime) && Math.abs(itemTime - eventTime) < 1000;
  }) || null;
}

function upsertSmsMessageFromEvent(event) {
  upsertSmsLibraryMessages(event.deviceId, [{
    messageKey: event.eventFingerprint || `event:${event.eventId}`,
    box: "inbox",
    type: 1,
    address: event.sender,
    phoneNumber: event.phoneNumber,
    body: event.body,
    code: event.code,
    platform: event.platform,
    messageAt: event.receivedAt,
    receivedAt: event.receivedAt,
    subscriptionId: event.subscriptionId,
    slotIndex: event.slotIndex,
    source: "sms-event"
  }]);
}

function upsertSmsLibraryMessages(deviceId, messages) {
  if (!deviceId) return { upserted: 0, inserted: 0, updated: 0, skipped: Array.isArray(messages) ? messages.length : 0, persistedMessages: [] };
  if (!Array.isArray(state.smsMessages)) {
    state.smsMessages = [];
    smsMessageIndex.replace(state.smsMessages);
  }
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const insertedMessages = [];
  const persistedMessages = [];
  for (const raw of Array.isArray(messages) ? messages : []) {
    const message = normalizeSmsLibraryMessage(deviceId, raw);
    if (!message) {
      skipped += 1;
      continue;
    }
    const existing = smsMessageIndex.find(message.deviceId, message.messageKey);
    if (existing) {
      const sourceAliases = [...new Set([
        ...(Array.isArray(existing.sourceAliases) ? existing.sourceAliases : []),
        ...(Array.isArray(message.sourceAliases) ? message.sourceAliases : []),
        existing.source,
        message.source
      ].filter(Boolean))];
      Object.assign(existing, message, {
        messageId: existing.messageId,
        createdAt: existing.createdAt || message.createdAt,
        sourcePackage: message.sourcePackage || existing.sourcePackage || "",
        sourceNotificationKey: message.sourceNotificationKey || existing.sourceNotificationKey || "",
        sourceAliases,
        updatedAt: nowIso()
      });
      persistedMessages.push(existing);
      updated += 1;
    } else {
      const semanticDuplicate = findSemanticSmsDuplicate(smsMessageIndex.forDevice(message.deviceId), message);
      if (semanticDuplicate) {
        const previousBusinessKey = {
          deviceId: semanticDuplicate.deviceId,
          messageKey: semanticDuplicate.messageKey
        };
        Object.assign(semanticDuplicate, mergeCrossSourceSms(semanticDuplicate, message), { updatedAt: nowIso() });
        smsMessageIndex.reindex(semanticDuplicate, previousBusinessKey);
        persistedMessages.push(semanticDuplicate);
        updated += 1;
      } else {
        state.smsMessages.unshift(message);
        smsMessageIndex.add(message);
        insertedMessages.push(message);
        persistedMessages.push(message);
        inserted += 1;
      }
    }
  }
  if (!inserted && !updated) return { upserted: 0, inserted: 0, updated: 0, skipped, persistedMessages };
  matchSmsOrdersFromLibrary(insertedMessages);
  sortSmsMessagesNewestFirst(state.smsMessages);
  if (state.smsMessages.length > MAX_SMS_MESSAGES) state.smsMessages = state.smsMessages.slice(0, MAX_SMS_MESSAGES);
  smsMessageIndex.replace(state.smsMessages);
  return { upserted: inserted + updated, inserted, updated, skipped, persistedMessages };
}

function normalizeSmsLibraryMessage(deviceId, raw = {}) {
  const body = sanitizePostgresText(raw.body || "", 8000);
  const address = sanitizePostgresText(raw.address || raw.sender || "", 200);
  const messageAt = normalizeIsoTime(raw.messageAt || raw.receivedAt || raw.date) || nowIso();
  const rawKey = String(raw.messageKey || raw.smsId || raw._id || "").trim();
  const messageKey = normalizeSmsMessageKey(rawKey || smsMessageContentFingerprint(deviceId, raw, body, address, messageAt));
  if (!messageKey) return null;
  const box = normalizeSmsBox(raw.box || raw.type);
  const subscriptionId = normalizeOptionalInt(raw.subscriptionId);
  const rawSlotIndex = normalizeOptionalInt(raw.slotIndex);
  const device = state.devices.find((item) => item.deviceId === deviceId);
  const matchedSim = (device?.sims || []).find((sim) => subscriptionId !== null && Number(sim.subscriptionId) === Number(subscriptionId));
  const slotIndex = rawSlotIndex !== null ? rawSlotIndex : normalizeOptionalInt(matchedSim?.slotIndex);
  return {
    messageId: newId(),
    deviceId,
    messageKey,
    smsId: sanitizePostgresText(raw.smsId || raw._id || "", 80),
    threadId: sanitizePostgresText(raw.threadId || "", 80),
    box,
    type: normalizeOptionalInt(raw.type),
    address,
    phoneNumber: normalizePhone(raw.phoneNumber || raw.recipient || ""),
    body,
    code: sanitizePostgresText(raw.code || extractCode(body) || "", 20),
    platform: normalizePlatform(raw.platform || detectPlatform(body, address)),
    messageAt,
    dateSent: normalizeIsoTime(raw.dateSent) || "",
    receivedAt: normalizeIsoTime(raw.receivedAt || raw.messageAt || raw.date) || messageAt,
    read: raw.read === true || raw.read === 1 || raw.read === "1",
    seen: raw.seen === true || raw.seen === 1 || raw.seen === "1",
    status: sanitizePostgresText(raw.status ?? "", 80),
    locked: raw.locked === true || raw.locked === 1 || raw.locked === "1",
    subscriptionId,
    slotIndex,
    source: sanitizePostgresText(raw.source || "android-agent", 60),
    sourcePackage: sanitizePostgresText(raw.sourcePackage || "", 200),
    sourceNotificationKey: sanitizePostgresText(raw.sourceNotificationKey || "", 80),
    sourceAliases: Array.isArray(raw.sourceAliases)
      ? [...new Set(raw.sourceAliases.map((item) => sanitizePostgresText(item || "", 60)).filter(Boolean))]
      : [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
}

function smsMessageContentFingerprint(deviceId, raw, body, address, messageAt) {
  return crypto.createHash("sha256")
    .update([
      deviceId,
      raw.subscriptionId ?? "",
      raw.slotIndex ?? "",
      raw.type ?? raw.box ?? "",
      address,
      body,
      messageAt
    ].join("|"))
    .digest("hex");
}

function expireSmsOrders() {
  const now = Date.now();
  let changed = false;
  for (const order of state.smsOrders) {
    if (order.status === "waiting" && new Date(order.expiresAt).getTime() <= now) {
      order.status = "expired";
      order.updatedAt = nowIso();
      changed = true;
    }
  }
  return changed;
}

function recoverStalledTasks(agentId = "") {
  const now = Date.now();
  const targetAgentId = String(agentId || "");
  const onlineAgents = new Set((state.windowsAgents || []).filter(isWindowsAgentOnline).map((agent) => agent.agentId));
  let changed = false;
  for (const task of state.windowsTasks || []) {
    if (targetAgentId && task.agentId !== targetAgentId) continue;
    if (["queued", "running"].includes(task.status) && task.agentId && !onlineAgents.has(task.agentId)) {
      task.status = "stalled";
      task.stalledAt = task.stalledAt || nowIso();
      task.recoverable = true;
      task.result = { ...(task.result || {}), error: "agent_offline", message: "Windows 管理器离线，任务等待恢复" };
      task.updatedAt = nowIso();
      if (!Array.isArray(task.events)) task.events = [];
      task.events.push({
        eventId: newId(),
        phase: "stalled",
        level: "warn",
        message: "Windows 管理器离线，任务已进入待恢复状态",
        detail: { agentId: task.agentId },
        createdAt: nowIso()
      });
      syncXhsTaskFromWindowsTask(task, "stalled", task.result);
      syncAutomationJobFromWindowsTask(task, "stalled", task.result);
      changed = true;
      continue;
    }
    if (task.status === "stalled" && task.agentId && onlineAgents.has(task.agentId) && task.recoverable !== false) {
      const stalledAt = toTime(task.stalledAt || task.updatedAt);
      if (stalledAt && now - stalledAt > WINDOWS_TASK_TTL_MS) {
        task.status = "failed";
        task.recoverable = false;
        task.completedAt = nowIso();
        task.updatedAt = task.completedAt;
        task.result = { ...(task.result || {}), error: "task_stalled_timeout", message: "任务待恢复超时，平台已自动失败" };
        syncXhsTaskFromWindowsTask(task, "failed", task.result);
        syncAutomationJobFromWindowsTask(task, "failed", task.result);
        changed = true;
      } else {
        task.status = "queued";
        task.updatedAt = nowIso();
        task.result = { ...(task.result || {}), recoveredAt: task.updatedAt };
        if (!Array.isArray(task.events)) task.events = [];
        task.events.push({
          eventId: newId(),
          phase: "recovered",
          level: "info",
          message: "Windows 管理器恢复在线，任务重新排队",
          detail: { agentId: task.agentId },
          createdAt: nowIso()
        });
        syncXhsTaskFromWindowsTask(task, "queued", task.result);
        syncAutomationJobFromWindowsTask(task, "queued", task.result);
        changed = true;
      }
    }
  }
  return changed;
}

function expireWindowsTasks() {
  const now = Date.now();
  let changed = false;
  for (const task of state.windowsTasks) {
    if (!["queued", "running", "stalled"].includes(task.status)) continue;
    const anchor = task.status === "running" ? latestTaskActivityAt(task) || task.pickedAt || task.updatedAt : task.createdAt;
    const runningTtlMs = task.type === "alipay_name_query"
      ? ALIPAY_NAME_QUERY_WINDOWS_TASK_TTL_MS
      : task.type === "kuaishou_lead"
        ? AUTOMATION_SESSION_TTL_MS
        : task.type === "xhs_data_collect" ? XHS_DATA_COLLECTION_TTL_MS : WINDOWS_TASK_TTL_MS;
    const ttlMs = task.status === "queued" ? WINDOWS_TASK_QUEUE_TTL_MS : runningTtlMs;
    const wasStalled = task.status === "stalled";
    if (task.status === "stalled") {
      const stalledAt = toTime(task.stalledAt || task.updatedAt || task.createdAt);
      if (stalledAt && now - stalledAt <= runningTtlMs) continue;
    } else if (now - new Date(anchor || task.createdAt).getTime() <= ttlMs) {
      continue;
    }
    if (isManagedLookupTask(task)) {task.status="stalled";task.stalledAt=task.stalledAt||nowIso();task.updatedAt=nowIso();changed=true;continue;}
    const expiredStatus = task.status;
    const timeoutSeconds = Math.round(ttlMs / 1000);
    task.status = "failed";
    task.result = {
      ...(task.result || {}),
      error: wasStalled ? "task_stalled_timeout" : expiredStatus === "queued" ? "task_queue_timeout" : "task_timeout",
      timeoutSeconds
    };
    task.updatedAt = nowIso();
    task.completedAt = nowIso();
    if (!Array.isArray(task.events)) task.events = [];
    task.events.push({
      eventId: newId(),
      phase: "timeout",
      level: "error",
      message: "任务超时，平台已自动标记失败",
      detail: { timeoutSeconds },
      createdAt: nowIso()
    });
    syncXhsTaskFromWindowsTask(task, "failed", task.result);
    syncAutomationJobFromWindowsTask(task, "failed", task.result);
    changed = true;
  }
  return changed;
}

function expireXhsTasks() {
  const now = Date.now();
  let changed = false;
  for (const task of state.xhsQrTasks) {
    if (!["queued", "running", "stalled"].includes(task.status)) continue;
    const anchor = task.status === "running" ? latestTaskActivityAt(task) || task.pickedAt || task.updatedAt : task.status === "stalled" ? task.stalledAt || task.updatedAt : task.createdAt;
    const ttlMs = task.status === "queued" ? XHS_TASK_QUEUE_TTL_MS : XHS_TASK_TTL_MS;
    if (now - new Date(anchor || task.createdAt).getTime() <= ttlMs) continue;
    const expiredStatus = task.status;
    const timeoutSeconds = Math.round(ttlMs / 1000);
    task.status = "expired";
    task.result = {
      ...(task.result || {}),
      error: expiredStatus === "queued" ? "task_queue_timeout" : "task_timeout",
      timeoutSeconds
    };
    task.updatedAt = nowIso();
    task.completedAt = nowIso();
    releaseDeviceTaskLock(task, "expired");
    if (!Array.isArray(task.events)) task.events = [];
    task.events.push({
      eventId: newId(),
      phase: "timeout",
      level: "error",
      message: "扫码任务超时，平台已自动过期",
      detail: { timeoutSeconds },
      createdAt: nowIso()
    });
    cancelLinkedWindowsTask(task, { role: "system" });
    changed = true;
  }
  return changed;
}

function expireAutomationJobs() {
  const now = Date.now();
  let changed = false;
  expireDeviceLocks();
  for (const job of state.automationJobs || []) {
    if (!isActiveAutomationStatus(job.status)) continue;
    if (job.kind === "kuaishou_lead") {
      const windowsTask = job.windowsTaskId ? (state.windowsTasks || []).find((item) => item.taskId === job.windowsTaskId) : null;
      if (windowsTask && ["queued", "running", "stalled"].includes(windowsTask.status)) continue;
    }
    const ttlMs = job.kind === "xhs_data_collect" ? XHS_DATA_COLLECTION_TTL_MS : job.kind === "xhs_publish" ? XHS_TASK_TTL_MS : AUTOMATION_SESSION_TTL_MS;
    const anchor = toTime(job.updatedAt || job.createdAt);
    if (!anchor || now - anchor <= ttlMs) continue;
    job.status = "expired";
    job.updatedAt = nowIso();
    job.completedAt = job.updatedAt;
    job.result = { ...(job.result || {}), errorCode: "automation_task_timeout", timeoutSeconds: Math.round(ttlMs / 1000) };
    if (["xhs_publish", "kuaishou_lead", "xhs_data_collect"].includes(job.kind)) releaseAutomationLock(job, "expired");
    const session = job.sessionId ? state.automationSessions.find((item) => item.sessionId === job.sessionId) : null;
    if (session) finishLookupSession(session, "expired", "automation_session_timeout");
    changed = true;
  }
  for (const session of state.automationSessions || []) {
    if (session.managedLookupGeneration && managedLookup?.reserved(session.deviceId)) continue;
    if (!["starting", "ready", "querying", "switching", "choosing_account", "needs_human_verification", "stopping"].includes(session.status)) continue;
    const lock = (state.deviceLocks || []).find((item) => item.lockId === session.lockId);
    const anchor = toTime(session.updatedAt || session.createdAt);
    if ((lock && lock.status === "active") && anchor && now - anchor <= AUTOMATION_SESSION_TTL_MS) continue;
    finishLookupSession(session, "expired", lock?.releaseReason || "automation_session_timeout");
    changed = true;
  }
  return changed;
}

function latestTaskActivityAt(task) {
  const events = Array.isArray(task?.events) ? task.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const eventTime = toTime(events[index]?.createdAt);
    if (eventTime) return events[index].createdAt;
  }
  return task?.updatedAt || "";
}

function pruneState(options = {}) {
  expireDeviceLocks();
  const dryRun = Boolean(options.dryRun);
  const before = stateCounts();
  const next = {
    smsOrders: pruneArray(state.smsOrders, {
      isActive: (order) => order.status === "waiting",
      getTime: (order) => order.updatedAt || order.createdAt,
      maxItems: MAX_SMS_ORDERS
    }),
    smsEvents: pruneArray(state.smsEvents, {
      isActive: () => false,
      getTime: (event) => event.createdAt || event.receivedAt,
      maxItems: MAX_SMS_EVENTS
    }),
    smsMessages: pruneArray(state.smsMessages, {
      isActive: () => false,
      getTime: (message) => message.messageAt || message.receivedAt || message.createdAt,
      maxItems: MAX_SMS_MESSAGES
    }),
    windowsTasks: pruneArray(state.windowsTasks, {
      isActive: (task) => ["queued", "running", "stalled"].includes(task.status),
      getTime: (task) => task.updatedAt || task.createdAt,
      maxItems: MAX_WINDOWS_TASKS
    }),
    xhsQrTasks: pruneArray(state.xhsQrTasks, {
      isActive: (task) => ["queued", "running", "stalled"].includes(task.status),
      getTime: (task) => task.updatedAt || task.createdAt,
      maxItems: MAX_XHS_TASKS
    }),
    automationJobs: pruneArray(state.automationJobs || [], {
      isActive: (job) => isActiveAutomationStatus(job.status),
      getTime: (job) => job.updatedAt || job.createdAt,
      maxItems: MAX_AUTOMATION_JOBS
    }),
    automationSessions: pruneArray(state.automationSessions || [], {
      isActive: (session) => ["starting", "ready", "querying", "switching", "choosing_account", "needs_human_verification", "stopping"].includes(session.status),
      getTime: (session) => session.updatedAt || session.createdAt,
      maxItems: MAX_AUTOMATION_SESSIONS
    }),
    sessions: pruneArray(state.sessions, {
      isActive: (session) => !session.revokedAt && new Date(session.expiresAt).getTime() > Date.now(),
      getTime: (session) => session.revokedAt || session.expiresAt || session.createdAt,
      maxItems: MAX_SESSIONS
    }),
    audit: pruneArray(state.audit, {
      isActive: () => false,
      getTime: (event) => event.createdAt,
      maxItems: MAX_AUDIT_EVENTS
    }),
    deviceLocks: pruneArray(state.deviceLocks || [], {
      isActive: (lock) => lock.status === "active",
      getTime: (lock) => lock.updatedAt || lock.createdAt,
      maxItems: MAX_XHS_TASKS
    }),
    evidenceAssets: pruneArray(state.evidenceAssets || [], {
      isActive: () => false,
      getTime: (asset) => asset.createdAt,
      maxItems: MAX_EVIDENCE_ASSETS
    })
  };
  const after = {
    ...before,
    smsOrders: next.smsOrders.length,
    smsEvents: next.smsEvents.length,
    smsMessages: next.smsMessages.length,
    windowsTasks: next.windowsTasks.length,
    xhsQrTasks: next.xhsQrTasks.length,
    automationJobs: next.automationJobs.length,
    automationSessions: next.automationSessions.length,
    sessions: next.sessions.length,
    audit: next.audit.length,
    deviceLocks: next.deviceLocks.length,
    evidenceAssets: next.evidenceAssets.length
  };
  if (!dryRun) {
    const retainedEvidenceIds = new Set(next.evidenceAssets.map((asset) => asset.evidenceId));
    queueEvidenceCleanup((state.evidenceAssets || [])
      .filter((asset) => !retainedEvidenceIds.has(asset.evidenceId))
      .map((asset) => asset.filePath));
    trimTaskEvents(next.windowsTasks);
    trimTaskEvents(next.xhsQrTasks);
    trimTaskEvents(next.automationJobs);
    state.smsOrders = next.smsOrders;
    state.smsEvents = next.smsEvents;
    if (state.smsMessages !== next.smsMessages) {
      state.smsMessages = next.smsMessages;
      smsMessageIndex.replace(state.smsMessages);
    }
    state.windowsTasks = next.windowsTasks;
    state.xhsQrTasks = next.xhsQrTasks;
    state.automationJobs = next.automationJobs;
    state.automationSessions = next.automationSessions;
    state.sessions = next.sessions;
    state.audit = next.audit;
    state.deviceLocks = next.deviceLocks;
    state.evidenceAssets = next.evidenceAssets;
  }
  return {
    dryRun,
    retentionDays: RETENTION_DAYS,
    before,
    after,
    removed: Object.fromEntries(Object.keys(before).map((key) => [key, before[key] - after[key]]))
  };
}

function queueEvidenceCleanup(paths = []) {
  for (const filePath of paths) {
    if (filePath) pendingEvidenceDeletes.add(String(filePath));
  }
}

async function runEvidenceStorageCleanup() {
  if (evidenceCleanupRunning) return null;
  evidenceCleanupRunning = true;
  const removedPaths = [...pendingEvidenceDeletes];
  removedPaths.forEach((filePath) => pendingEvidenceDeletes.delete(filePath));
  try {
    const result = await cleanupEvidenceStorage({
      rootDir: EVIDENCE_DIR,
      retainedPaths: (state.evidenceAssets || []).map((asset) => asset.filePath).filter(Boolean),
      removedPaths,
      orphanMinAgeMs: 60 * 60 * 1000
    });
    lastEvidenceCleanupAt = Date.now();
    if (result.errors.length) console.warn("evidence cleanup completed with errors", result.errors.slice(0, 5));
    return result;
  } catch (error) {
    queueEvidenceCleanup(removedPaths);
    throw error;
  } finally {
    evidenceCleanupRunning = false;
  }
}

function trimTaskEvents(tasks = []) {
  maintainTaskHistory(tasks);
}

function compactTaskCollectionsForSave() {
  for (const task of state.windowsTasks || []) {
    compactTaskPayload(task);
  }
  for (const task of state.xhsQrTasks || []) {
    compactTaskPayload(task);
  }
  for (const job of state.automationJobs || []) {
    compactTaskPayload(job);
  }
}

function pruneArray(items, options) {
  const list = Array.isArray(items) ? items : [];
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 3_600_000;
  const withinRetention = options.ignoreRetention
    ? list
    : list.filter((item) => options.isActive(item) || toTime(options.getTime(item)) >= cutoff);
  if (withinRetention.length <= options.maxItems) {
    return withinRetention.length === list.length ? list : withinRetention;
  }
  const active = withinRetention.filter(options.isActive);
  const inactive = withinRetention
    .filter((item) => !options.isActive(item))
    .sort((a, b) => toTime(options.getTime(b)) - toTime(options.getTime(a)));
  const inactiveLimit = Math.max(0, options.maxItems - active.length);
  const keep = new Set([...active, ...inactive.slice(0, inactiveLimit)]);
  return withinRetention.filter((item) => keep.has(item));
}

function stateCounts() {
  return {
    smsOrders: state.smsOrders.length,
    smsEvents: state.smsEvents.length,
    smsMessages: state.smsMessages.length,
    windowsTasks: state.windowsTasks.length,
    xhsQrTasks: state.xhsQrTasks.length,
    automationJobs: (state.automationJobs || []).length,
    automationSessions: (state.automationSessions || []).length,
    deviceLocks: (state.deviceLocks || []).length,
    evidenceAssets: (state.evidenceAssets || []).length,
    sessions: state.sessions.length,
    audit: state.audit.length
  };
}

function toTime(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function buildOverview() {
  expireDeviceLocks();
  const onlineAgents = state.windowsAgents.filter(isWindowsAgentOnline).length;
  const adbOnline = state.devices.filter(isAdbOnline).length;
  const agentOnline = state.devices.filter(isDeviceAgentOnline).length;
  const waitingSms = state.smsOrders.filter((order) => order.status === "waiting").length;
  const smsLibraryMessages = state.smsMessages.length;
  const xhsCompleted = state.xhsQrTasks.filter((task) => ["succeeded", "failed", "cancelled", "expired"].includes(task.status));
  const xhsSucceeded = xhsCompleted.filter((task) => task.status === "succeeded").length;
  const activeLocks = (state.deviceLocks || []).filter((lock) => lock.status === "active").length;
  return {
    windowsAgents: state.windowsAgents.length,
    onlineAgents,
    devices: state.devices.length,
    adbOnline,
    agentOnline,
    waitingSms,
    smsLibraryMessages,
    xhsQueued: state.xhsQrTasks.filter((task) => task.status === "queued").length,
    xhsRunning: state.xhsQrTasks.filter((task) => task.status === "running").length,
    xhsStalled: state.xhsQrTasks.filter((task) => task.status === "stalled").length,
    xhsSuccessRate: xhsCompleted.length ? Math.round((xhsSucceeded / xhsCompleted.length) * 100) : null,
    deviceLocks: activeLocks,
    taskFailureReasons: topTaskFailureReasons()
  };
}

function topTaskFailureReasons(limit = 5) {
  const counts = new Map();
  for (const task of state.xhsQrTasks || []) {
    if (!["failed", "expired", "cancelled"].includes(task.status)) continue;
    const reason = String(task.result?.error || task.result?.errorCode || task.result?.message || task.status || "unknown").slice(0, 120);
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([reason, count]) => ({ reason, count }));
}

function countBy(items = [], getter = () => "") {
  const counts = {};
  for (const item of items) {
    const key = String(getter(item) || "unknown");
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function buildOperationsMetrics() {
  const overview = buildOverview();
  const activeLocks = (state.deviceLocks || []).filter((lock) => lock.status === "active").map(publicAdminDeviceLock);
  const taskStatuses = countBy(state.xhsQrTasks || [], (task) => task.status);
  const windowsTaskStatuses = countBy(state.windowsTasks || [], (task) => task.status);
  const queue = {
    xhsActive: (state.xhsQrTasks || []).filter(isActiveXhsTask).length,
    xhsQueued: taskStatuses.queued || 0,
    xhsRunning: taskStatuses.running || 0,
    xhsStalled: taskStatuses.stalled || 0,
    windowsQueued: windowsTaskStatuses.queued || 0,
    windowsRunning: windowsTaskStatuses.running || 0,
    windowsStalled: windowsTaskStatuses.stalled || 0
  };
  const staleSmsDevices = (state.devices || [])
    .filter((device) => isAdbOnline(device) && (!toTime(device.smsLibrary?.lastSyncedAt) || Date.now() - toTime(device.smsLibrary?.lastSyncedAt) > 10 * 60 * 1000))
    .map((device) => ({
      deviceId: device.deviceId,
      deviceName: device.deviceName || device.deviceId,
      lastSyncedAt: device.smsLibrary?.lastSyncedAt || ""
    }));
  return {
    generatedAt: nowIso(),
    realtime: realtimeMetrics.snapshot(),
    overview,
    queue,
    taskStatuses,
    windowsTaskStatuses,
    activeLocks,
    failureReasons: topTaskFailureReasons(10),
    recentIssues: recentOperationalIssues(),
    staleSmsDevices,
    agents: (state.windowsAgents || []).map((agent) => ({
      agentId: agent.agentId,
      agentName: agent.agentName || "",
      online: isWindowsAgentOnline(agent),
      lastSeenAt: agent.lastSeenAt || "",
      lastIp: agent.lastIp || "",
      enabled: agent.enabled !== false,
      runtime: agent.health?.runtime || null,
      screenControl: agent.health?.screenControl || null
    }))
  };
}

function recentOperationalIssues() {
  const now = Date.now();
  const tenMinutesMs = 10 * 60 * 1000;
  const issues = [];
  for (const agent of state.windowsAgents || []) {
    const seenAt = toTime(agent.lastSeenAt);
    if (!seenAt || now - seenAt > WINDOWS_AGENT_ONLINE_MS) {
      issues.push({ type: "agent_offline", level: "warn", subject: agent.agentId, message: `${agent.agentName || agent.agentId} 离线或未心跳` });
    }
    const airtest = agent.health?.airtest || {};
    if (seenAt && now - seenAt <= WINDOWS_AGENT_ONLINE_MS && airtest.enabled !== false && !airtest.ok) {
      issues.push({ type: "airtest_poco_not_ready", level: "warn", subject: agent.agentId, message: airtest.lastError || "Airtest/Poco 未就绪" });
    }
  }
  for (const device of state.devices || []) {
    if (device.adb?.state && device.adb.state !== "device") {
      issues.push({ type: "adb_not_device", level: "warn", subject: device.deviceId, message: `${device.deviceName || device.deviceId}: ADB ${device.adb.state}` });
    }
    const lastSms = toTime(device.smsLibrary?.lastSyncedAt);
    if (isAdbOnline(device) && (!lastSms || now - lastSms > tenMinutesMs)) {
      issues.push({ type: "sms_sync_stale", level: "warn", subject: device.deviceId, message: `${device.deviceName || device.deviceId}: 10 分钟内无短信库同步` });
    }
  }
  for (const task of state.xhsQrTasks || []) {
    const updatedAt = toTime(task.updatedAt || task.createdAt);
    if (task.status === "stalled") {
      issues.push({ type: "task_stalled", level: "warn", subject: task.taskId, message: `${task.deviceId}: Windows 管理器离线，扫码任务待恢复` });
    }
    if (["failed", "expired"].includes(task.status) && updatedAt && now - updatedAt <= tenMinutesMs) {
      issues.push({ type: "recent_task_failure", level: "error", subject: task.taskId, message: `${task.deviceId}: ${task.result?.error || task.status}` });
    }
  }
  return issues.slice(0, 50);
}

function adbSerialConflictMap() {
  const bySerial = new Map();
  for (const agent of state.windowsAgents || []) {
    for (const device of agent.devices || []) {
      const serial = String(device.adbSerial || "").trim();
      if (!serial || device.state !== "device") continue;
      const list = bySerial.get(serial) || [];
      list.push({ agentId: agent.agentId, lastSeenAt: agent.lastSeenAt || device.updatedAt || "" });
      bySerial.set(serial, list);
    }
  }
  return bySerial;
}

async function buildDiagnostics() {
  const changed = [expireSmsOrders(), recoverStalledTasks(), expireWindowsTasks(), expireXhsTasks(), expireDeviceLocks()].some(Boolean);
  const prunePreview = pruneState({ dryRun: true });
  const overview = buildOverview();
  const recentIssues = recentOperationalIssues();
  const onlineWindowsAgents = state.windowsAgents.filter(isWindowsAgentOnline);
  const boundAgentCount = state.windowsAgents.filter((agent) => agent.tokenHash && agent.enabled !== false && !agent.revokedAt).length;
  const automationReadyAgents = onlineWindowsAgents.filter((agent) => agent.health?.airtest?.enabled !== false && agent.health?.airtest?.ok);
  const automationDetails = onlineWindowsAgents
    .map((agent) => {
      const airtest = agent.health?.airtest || {};
      const setup = [airtest.pythonCommand, airtest.autoInstall ? "auto install" : "manual"].filter(Boolean).join(", ");
      return `${agent.agentName || agent.agentId}: ${airtest.ok ? "ok" : airtest.lastError || "not ready"}${setup ? ` (${setup})` : ""}`;
    })
    .join("；") || "暂无在线 Windows 管理器";
  const stateFile = STORAGE_BACKEND === "json" ? await statPath(DATA_FILE) : { exists: false, type: "", sizeBytes: 0, updatedAt: "" };
  const dataDir = await statPath(DATA_DIR);
  const releaseDir = await statPath(RELEASE_DIR);
  const evidenceDir = await statPath(EVIDENCE_DIR);
  const releasePath = state.appRelease?.apkFile ? path.join(RELEASE_DIR, path.basename(state.appRelease.apkFile)) : "";
  const releaseFile = releasePath ? await statPath(releasePath) : null;
  const dataWritable = await canWriteToDir(DATA_DIR);
  const storageStatus = await checkStorageStatus();
  const runtimeStatus = await runtimeStore.ping();
  const tokenWarnings = buildTokenWarnings();
  const productionWarnings = buildProductionConfigWarnings();
  const warnings = [...tokenWarnings];
  if (!THIRD_PARTY_API_CLIENTS.size) warnings.push("open_api_clients_not_configured");
  if (OPEN_NAME_LOOKUP_API_ENABLED && !OPEN_NAME_LOOKUP_CLIENTS.size) warnings.push("open_name_lookup_api_enabled_without_clients");

  if (NODE_ENV === "production" && STORAGE_BACKEND === "json" && !ALLOW_JSON_STORAGE_IN_PRODUCTION) {
    warnings.push("json_storage_requires_production_ack");
  }
  if (!storageStatus.ok) {
    warnings.push("storage_backend_unavailable");
  }
  if (NODE_ENV === "production" && PUBLIC_BASE_URL && PUBLIC_BASE_URL.startsWith("http://")) {
    warnings.push("production_public_base_url_not_https");
  }
  if (!PUBLIC_BASE_URL) {
    warnings.push("public_base_url_not_set");
  }
  if (!dataWritable.ok) {
    warnings.push("data_dir_not_writable");
  }
  if (state.appRelease?.apkFile && !releaseFile?.exists) {
    warnings.push("release_apk_file_missing");
  }
  if (changed) await saveState();

  const checks = [
    readinessCheck("server", "平台服务已启动", "ok", `Node ${process.version}, uptime ${Math.floor(process.uptime())}s`),
    readinessCheck(
      "storage_backend",
      "状态存储",
      storageStatus.ok && !(NODE_ENV === "production" && STORAGE_BACKEND === "json" && !ALLOW_JSON_STORAGE_IN_PRODUCTION) ? "ok" : "fail",
      storageStatus.detail
    ),
    readinessCheck("data_dir", "数据目录可写", dataWritable.ok ? "ok" : "fail", dataWritable.ok ? DATA_DIR : dataWritable.error),
    readinessCheck("runtime_store", "运行时协调层", runtimeStatus.ok ? "ok" : "warn", runtimeStatus.detail),
    readinessCheck("evidence_store", "失败证据存储", evidenceDir.exists ? "ok" : "warn", evidenceDir.exists ? `${EVIDENCE_DIR}，${state.evidenceAssets.length} 个证据文件` : "首次失败证据上传后自动创建"),
    readinessCheck("evidence_links", "失败证据访问保护", process.env.EVIDENCE_SIGNING_SECRET ? "ok" : "warn", process.env.EVIDENCE_SIGNING_SECRET ? `独立签名密钥，链接有效 ${EVIDENCE_URL_TTL_SECONDS} 秒` : `暂用管理 Token 签名，链接有效 ${EVIDENCE_URL_TTL_SECONDS} 秒；生产环境应配置独立密钥`),
    readinessCheck("structured_tables", "结构化表迁移准备", STORAGE_BACKEND === "postgres" ? "ok" : "warn", STRUCTURED_TABLE_SYNC ? "已开启结构化表双写" : "表结构已支持，当前仍以 snapshot 兼容为主"),
    readinessCheck("state_file", "状态文件", stateFile.exists ? "ok" : "warn", stateFile.exists ? `${stateFile.sizeBytes} bytes` : "首次启动后会自动创建"),
    readinessCheck("admin_token", "管理 Token", tokenWarnings.includes("admin_token_uses_default") ? "fail" : "ok", tokenWarnings.includes("admin_token_uses_default") ? "仍在使用默认值" : "已配置"),
    readinessCheck("admin_account", "管理员账号", tokenWarnings.includes("bootstrap_admin_uses_default_password") ? "fail" : "ok", tokenWarnings.includes("bootstrap_admin_uses_default_password") ? "仍在使用默认账号密码" : BOOTSTRAP_ADMIN_USERNAME),
    readinessCheck("windows_token", "Windows Token", tokenWarnings.includes("windows_agent_token_uses_default") ? "fail" : "ok", tokenWarnings.includes("windows_agent_token_uses_default") ? "仍在使用默认值" : "已配置"),
    readinessCheck("windows_agent_bound_tokens", "Agent 独立 Token", state.windowsAgents.length && boundAgentCount < state.windowsAgents.length ? "warn" : "ok", `${boundAgentCount}/${state.windowsAgents.length} 个管理器已绑定独立 token`),
    readinessCheck("legacy_windows_token", "旧 Windows Token 兼容", LEGACY_WINDOWS_AGENT_TOKEN_ENABLED ? "warn" : "ok", LEGACY_WINDOWS_AGENT_TOKEN_ENABLED ? "兼容开启，迁移完成后建议关闭" : "已关闭旧全局 token"),
    readinessCheck("device_token", "手机 Agent Token", tokenWarnings.includes("device_agent_token_uses_default") ? "fail" : "ok", tokenWarnings.includes("device_agent_token_uses_default") ? "仍在使用默认值" : "已配置"),
    readinessCheck("public_url", "公网访问地址", PUBLIC_BASE_URL ? (PUBLIC_BASE_URL.startsWith("https://") ? "ok" : "warn") : "warn", PUBLIC_BASE_URL || "未设置 PUBLIC_BASE_URL"),
    readinessCheck("app_release", "手机 Agent APK", state.appRelease?.apkFile || state.appRelease?.downloadUrl ? (releasePath && !releaseFile?.exists ? "fail" : "ok") : "warn", state.appRelease?.versionName || "尚未发布"),
    readinessCheck("windows_agent", "Windows 管理器在线", overview.onlineAgents > 0 ? "ok" : "warn", `${overview.onlineAgents}/${overview.windowsAgents}`),
    readinessCheck("adb_devices", "ADB 可控手机", overview.adbOnline > 0 ? "ok" : "warn", `${overview.adbOnline}/${overview.devices}`),
    readinessCheck("airtest_poco", "Airtest/Poco 自动化", automationReadyAgents.length > 0 ? "ok" : "warn", automationDetails),
    readinessCheck("open_api_clients", "第三方验证码 API", THIRD_PARTY_API_CLIENTS.size ? "ok" : "warn", THIRD_PARTY_API_CLIENTS.size ? `${THIRD_PARTY_API_CLIENTS.size} 个客户端已配置` : "未配置 THIRD_PARTY_API_CLIENTS"),
    readinessCheck(
      "open_name_lookup_api",
      "外部查名字 API",
      !OPEN_NAME_LOOKUP_API_ENABLED ? "ok" : OPEN_NAME_LOOKUP_CLIENTS.size ? "ok" : "fail",
      !OPEN_NAME_LOOKUP_API_ENABLED ? "默认关闭" : OPEN_NAME_LOOKUP_CLIENTS.size ? `已启用，${OPEN_NAME_LOOKUP_CLIENTS.size} 个客户端已配置` : "已启用但未配置有效客户端"
    ),
    readinessCheck("legacy_third_party_sms_orders", "旧验证码接口兼容", "warn", "旧 /api/v1/third-party/sms-orders 仍保留，第三方新接入应使用签名 open API"),
    readinessCheck("recent_operational_issues", "近 10 分钟异常", recentIssues.some((item) => item.level === "error") ? "fail" : recentIssues.length ? "warn" : "ok", recentIssues.length ? `${recentIssues.length} 个异常需要查看` : "暂无异常"),
    readinessCheck("phone_agents", "手机 Agent 兼容通道", overview.agentOnline > 0 ? "ok" : "warn", `${overview.agentOnline}/${overview.devices}，新流程不依赖 APK 在线`)
  ];
  const launchReadiness = buildLaunchReadiness({
    checks,
    warnings,
    productionWarnings,
    storageStatus,
    dataWritable,
    overview,
    automationReadyAgents
  });

  return {
    generatedAt: nowIso(),
    status: checks.some((check) => check.status === "fail") ? "fail" : warnings.length || checks.some((check) => check.status === "warn") ? "warn" : "ok",
    launchReadiness,
    runtime: {
      nodeVersion: process.version,
      env: NODE_ENV,
      host: HOST,
      port: PORT,
      publicBaseUrl: PUBLIC_BASE_URL,
      uptimeSeconds: Math.floor(process.uptime())
    },
    storage: {
      backend: STORAGE_BACKEND,
      stateVersion: state.stateVersion || 1,
      jsonStorageProductionAck: ALLOW_JSON_STORAGE_IN_PRODUCTION,
      postgres: STORAGE_BACKEND === "postgres" ? {
        connected: storageStatus.ok,
        stateKey: POSTGRES_STATE_KEY,
        ssl: POSTGRES_SSL,
        structuredTableSync: STRUCTURED_TABLE_SYNC,
        detail: storageStatus.detail
      } : null,
      runtimeStore: runtimeStatus,
      evidenceDir: { path: EVIDENCE_DIR, ...evidenceDir, assets: state.evidenceAssets.length },
      dataDir: { path: DATA_DIR, ...dataDir },
      dataFile: { path: DATA_FILE, ...stateFile },
      releaseDir: { path: RELEASE_DIR, ...releaseDir },
      releaseFile: releasePath ? { path: releasePath, ...releaseFile } : null,
      dataWritable: dataWritable.ok
    },
    auth: {
      adminTokenConfigured: ADMIN_API_TOKEN !== "dev-admin-token",
      windowsTokenConfigured: WINDOWS_AGENT_TOKEN !== "dev-windows-token",
      legacyWindowsAgentTokenEnabled: LEGACY_WINDOWS_AGENT_TOKEN_ENABLED,
      boundWindowsAgents: boundAgentCount,
      deviceTokenConfigured: DEVICE_AGENT_TOKEN !== "dev-device-token",
      bootstrapAdminConfigured: !(BOOTSTRAP_ADMIN_USERNAME === "admin" && BOOTSTRAP_ADMIN_PASSWORD === "admin123"),
      openApiClientsConfigured: THIRD_PARTY_API_CLIENTS.size > 0,
      strictProductionConfig: STRICT_PRODUCTION_CONFIG,
      warnings: tokenWarnings,
      productionWarnings
    },
    limits: {
      userMaxWaitingSms: USER_MAX_WAITING_SMS,
      userMaxActiveXhsTasks: USER_MAX_ACTIVE_XHS_TASKS,
      deviceMaxActiveXhsTasks: DEVICE_MAX_ACTIVE_XHS_TASKS,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      loginRateLimitMax: LOGIN_RATE_LIMIT_MAX,
      loginRateLimitWindowSeconds: Math.round(LOGIN_RATE_LIMIT_WINDOW_MS / 1000),
      smsOrderTtlSeconds: Math.round(SMS_ORDER_TTL_MS / 1000),
      windowsTaskTtlSeconds: Math.round(WINDOWS_TASK_TTL_MS / 1000),
      windowsTaskQueueTtlSeconds: Math.round(WINDOWS_TASK_QUEUE_TTL_MS / 1000),
      xhsTaskTtlSeconds: Math.round(XHS_TASK_TTL_MS / 1000),
      xhsTaskQueueTtlSeconds: Math.round(XHS_TASK_QUEUE_TTL_MS / 1000)
    },
    retention: {
      retentionDays: RETENTION_DAYS,
      maxSmsOrders: MAX_SMS_ORDERS,
      maxSmsEvents: MAX_SMS_EVENTS,
      maxWindowsTasks: MAX_WINDOWS_TASKS,
      maxXhsTasks: MAX_XHS_TASKS,
      maxAuditEvents: MAX_AUDIT_EVENTS,
      maxSessions: MAX_SESSIONS,
      pendingRemoval: prunePreview.removed
    },
    counts: {
      ...overview,
      windowsTasks: state.windowsTasks.length,
      smsOrders: state.smsOrders.length,
      smsEvents: state.smsEvents.length,
      xhsQrTasks: state.xhsQrTasks.length,
      users: state.users.length,
      activeSessions: state.sessions.filter((session) => !session.revokedAt && new Date(session.expiresAt).getTime() > Date.now()).length,
      audit: state.audit.length
    },
    recentIssues,
    checks,
    warnings
  };
}

function readinessCheck(key, label, status, detail) {
  return { key, label, status, detail: String(detail || ""), checkedAt: nowIso() };
}

function buildLaunchReadiness(input) {
  const gates = [
    launchGate(
      "production_config",
      "生产配置",
      input.productionWarnings.length ? "fail" : "ok",
      input.productionWarnings.length ? input.productionWarnings.join(", ") : "生产环境变量满足基础要求"
    ),
    launchGate(
      "transport_security",
      "公网 HTTPS",
      PUBLIC_BASE_URL && PUBLIC_BASE_URL.startsWith("https://") ? "ok" : "fail",
      PUBLIC_BASE_URL ? PUBLIC_BASE_URL : "未设置 PUBLIC_BASE_URL"
    ),
    launchGate(
      "auth_secrets",
      "账号和 Token",
      input.warnings.some((item) => /token_uses_default|bootstrap_admin_uses_default_password/.test(item)) ? "fail" : "ok",
      input.warnings.some((item) => /token_uses_default|bootstrap_admin_uses_default_password/.test(item)) ? "存在默认账号或默认机器 Token" : "已替换默认账号和机器 Token"
    ),
    launchGate(
      "storage",
      "状态存储",
      input.storageStatus.ok && !(NODE_ENV === "production" && STORAGE_BACKEND === "json" && !ALLOW_JSON_STORAGE_IN_PRODUCTION) ? (STORAGE_BACKEND === "json" ? "warn" : "ok") : "fail",
      input.storageStatus.detail
    ),
    launchGate(
      "data_writable",
      "数据目录",
      input.dataWritable.ok ? "ok" : "fail",
      input.dataWritable.ok ? DATA_DIR : input.dataWritable.error
    ),
    launchGate(
      "windows_manager",
      "Windows 管理器",
      input.overview.onlineAgents > 0 ? "ok" : "fail",
      `${input.overview.onlineAgents}/${input.overview.windowsAgents} 在线`
    ),
    launchGate(
      "adb_devices",
      "ADB 手机池",
      input.overview.adbOnline > 0 ? "ok" : "fail",
      `${input.overview.adbOnline}/${input.overview.devices} 可控`
    ),
    launchGate(
      "airtest_poco_automation",
      "Airtest/Poco 自动化",
      input.automationReadyAgents.length > 0 ? "ok" : "fail",
      `${input.automationReadyAgents.length}/${input.overview.onlineAgents} 个在线管理器可执行自动化`
    ),
    launchGate(
      "task_safety",
      "任务并发保护",
      DEVICE_MAX_ACTIVE_XHS_TASKS === 1 && SMS_ORDER_TTL_MS > 0 && WINDOWS_TASK_TTL_MS > 0 && XHS_TASK_TTL_MS > 0 ? "ok" : "warn",
      `设备扫码并发=${DEVICE_MAX_ACTIVE_XHS_TASKS}, SMS TTL=${Math.round(SMS_ORDER_TTL_MS / 1000)}s, Windows TTL=${Math.round(WINDOWS_TASK_TTL_MS / 1000)}s, XHS TTL=${Math.round(XHS_TASK_TTL_MS / 1000)}s`
    ),
    launchGate(
      "backup",
      "备份策略",
      STORAGE_BACKEND === "postgres" ? "warn" : "warn",
      "需要上线环境执行备份脚本并启用每日 timer 后人工确认"
    )
  ];
  const blockers = gates.filter((gate) => gate.status === "fail");
  const reviews = gates.filter((gate) => gate.status === "warn");
  return {
    status: blockers.length ? "blocked" : reviews.length ? "review" : "ready",
    summary: blockers.length ? `还有 ${blockers.length} 个阻塞项` : reviews.length ? `还有 ${reviews.length} 个复核项` : "达到基础上线门槛",
    blockers: blockers.map((gate) => gate.key),
    reviews: reviews.map((gate) => gate.key),
    gates
  };
}

function launchGate(key, label, status, detail) {
  return { key, label, status, detail: String(detail || "") };
}

async function buildReadiness() {
  const storage = await checkStorageStatus();
  const dataWritable = await canWriteToDir(DATA_DIR);
  const runtime = await runtimeStore.ping();
  const ok = storage.ok && dataWritable.ok && runtime.ok;
  return {
    ok,
    status: ok ? "ok" : "fail",
    at: nowIso(),
    storage: {
      backend: STORAGE_BACKEND,
      ok: storage.ok,
      detail: storage.detail
    },
    dataDir: {
      path: DATA_DIR,
      writable: dataWritable.ok,
      error: dataWritable.error
    },
    runtime
  };
}

function buildTokenWarnings() {
  const warnings = [];
  if (ADMIN_API_TOKEN === "dev-admin-token") warnings.push("admin_token_uses_default");
  if (WINDOWS_AGENT_TOKEN === "dev-windows-token") warnings.push("windows_agent_token_uses_default");
  if (LEGACY_WINDOWS_AGENT_TOKEN_ENABLED) warnings.push("legacy_windows_agent_token_enabled");
  if (DEVICE_AGENT_TOKEN === "dev-device-token") warnings.push("device_agent_token_uses_default");
  if (BOOTSTRAP_ADMIN_USERNAME === "admin" && BOOTSTRAP_ADMIN_PASSWORD === "admin123") warnings.push("bootstrap_admin_uses_default_password");
  return warnings;
}

function buildProductionConfigWarnings() {
  const warnings = [...buildTokenWarnings()];
  if (NODE_ENV !== "production") warnings.push("node_env_not_production");
  if (!PUBLIC_BASE_URL) warnings.push("public_base_url_not_set");
  if (PUBLIC_BASE_URL && !PUBLIC_BASE_URL.startsWith("https://")) warnings.push("public_base_url_not_https");
  if (/localhost|127\.0\.0\.1|phone\.example\.com/i.test(PUBLIC_BASE_URL)) warnings.push("public_base_url_uses_placeholder");
  if (!["json", "postgres"].includes(STORAGE_BACKEND)) warnings.push("storage_backend_invalid");
  if (STORAGE_BACKEND === "postgres" && !DATABASE_URL) warnings.push("database_url_required");
  if (NODE_ENV === "production" && STORAGE_BACKEND === "json" && !ALLOW_JSON_STORAGE_IN_PRODUCTION) warnings.push("json_storage_requires_production_ack");
  if (String(ADMIN_API_TOKEN).length < 32) warnings.push("admin_token_too_short");
  if (String(WINDOWS_AGENT_TOKEN).length < 32) warnings.push("windows_agent_token_too_short");
  if (String(DEVICE_AGENT_TOKEN).length < 32) warnings.push("device_agent_token_too_short");
  if (!REDIS_URL) warnings.push("redis_url_not_set");
  if (!process.env.EVIDENCE_SIGNING_SECRET) warnings.push("evidence_signing_secret_not_set");
  if (String(EVIDENCE_SIGNING_SECRET).length < 32) warnings.push("evidence_signing_secret_too_short");
  if (String(BOOTSTRAP_ADMIN_PASSWORD).length < 12) warnings.push("admin_password_too_short");
  if (MIN_PASSWORD_LENGTH < 12) warnings.push("min_password_length_too_short");
  return [...new Set(warnings)];
}

function enforceStrictProductionConfig() {
  if (!STRICT_PRODUCTION_CONFIG) return;
  const warnings = buildProductionConfigWarnings();
  if (!warnings.length) return;
  const error = new Error(`strict production config failed: ${warnings.join(", ")}`);
  error.statusCode = 500;
  throw error;
}

async function statPath(target) {
  try {
    const stat = await fs.stat(target);
    return {
      exists: true,
      type: stat.isDirectory() ? "directory" : "file",
      sizeBytes: stat.size,
      updatedAt: stat.mtime.toISOString()
    };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, type: "", sizeBytes: 0, updatedAt: "" };
    return { exists: false, type: "", sizeBytes: 0, updatedAt: "", error: error.message };
  }
}

async function canWriteToDir(targetDir) {
  const probe = path.join(targetDir, `.write-test-${process.pid}-${Date.now()}`);
  try {
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(probe, "ok");
    await fs.unlink(probe);
    return { ok: true, error: "" };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function logStartupDiagnostics() {
  const diagnostics = await buildDiagnostics();
  if (diagnostics.warnings.length) {
    console.warn(`startup warnings: ${diagnostics.warnings.join(", ")}`);
  }
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${nowIso()} received ${signal}, shutting down`);
  clearInterval(maintenanceTimer);
  clearInterval(lookupHumanNotificationTimer);
  clearInterval(managedLookupTimer);
  await managedLookup?.close();
  screenRelay?.close();
  try {
    await saveState();
    realtimeMetrics.close();
    if (postgresPool) await postgresPool.end();
  } catch (error) {
    console.error("saveState during shutdown", error);
  }
  server.close((error) => {
    if (error) {
      console.error("server close", error);
      process.exit(1);
    }
    process.exit(0);
  });
  setTimeout(() => {
    console.error("shutdown timeout");
    process.exit(1);
  }, 10_000).unref();
}

function publicWindowsAgent(agent) {
  const taskCounts = state.windowsTasks
    .filter((task) => task.agentId === agent.agentId)
    .reduce((acc, task) => {
      acc[task.status] = (acc[task.status] || 0) + 1;
      return acc;
    }, {});
  return {
    ...agent,
    recoveryControl: recoveryControls.get(agent.agentId),
    tokenHash: undefined,
    hasToken: Boolean(agent.tokenHash),
    tokenPrefix: agent.tokenPrefix || "",
    enabled: agent.enabled !== false,
    revokedAt: agent.revokedAt || "",
    scopes: normalizeAgentScopes(agent.scopes || []),
    devices: agent.devices || [],
    taskCounts
  };
}

function upsertAppReleaseMetadata(input = {}) {
  const current = state.appRelease || {};
  state.appRelease = {
    versionName: String(input.versionName || current.versionName || ""),
    versionCode: Number(input.versionCode || current.versionCode || 0),
    minSupportedVersionCode: Number(input.minSupportedVersionCode || current.minSupportedVersionCode || 0),
    mandatory: Boolean(input.mandatory ?? current.mandatory ?? false),
    releaseNotes: String(input.releaseNotes || current.releaseNotes || ""),
    downloadUrl: String(input.downloadUrl || current.downloadUrl || ""),
    apkFile: input.apkFile || current.apkFile || "",
    sizeBytes: Number(input.sizeBytes || current.sizeBytes || 0),
    sha256: String(input.sha256 || current.sha256 || ""),
    publishedAt: input.publishedAt || current.publishedAt || nowIso(),
    updatedAt: nowIso()
  };
  return state.appRelease;
}

function publicAppRelease(release) {
  if (!release) return null;
  const localDownloadUrl = release.apkFile ? "/api/v1/app-release/latest/download" : "";
  return {
    ...release,
    downloadUrl: release.downloadUrl || localDownloadUrl,
    hasLocalApk: Boolean(release.apkFile)
  };
}

function publicWindowsTask(task) {
  return {
    ...task,
    payload: cloneJson(task?.payload || {}),
    result: cloneJson(task?.result || {}),
    delivery: undefined,
    deliveryAttempts: undefined,
    events: undefined
  };
}

function publicWindowsTaskSummary(task) {
  const payload = task?.payload || {};
  const result = task?.result || {};
  const events = Array.isArray(task.events) ? task.events : [];
  const lastEvent = events[events.length - 1] || null;
  return {
    taskId: task.taskId,
    agentId: task.agentId || "",
    adbSerial: task.adbSerial || "",
    deviceId: task.deviceId || "",
    type: task.type || "",
    status: task.status || "",
    payload: publicWindowsTaskPayload(payload),
    result: {
      action: String(result.action || "").slice(0, 300),
      error: String(result.error || result.errorCode || "").slice(0, 200),
      message: String(result.message || "").slice(0, 500),
      hasScreenshot: Boolean(result?.screenshot || events.some((event) => event?.screenshot)),
      hasUiHierarchy: Boolean(result?.uiHierarchy || events.some((event) => event?.uiHierarchy || event?.uiSnapshot))
    },
    lastEvent: lastEvent ? publicWindowsTaskEventSummary(lastEvent) : null,
    eventCount: events.length,
    screenshotCount: events.filter((event) => event?.screenshot).length + (result?.screenshot ? 1 : 0),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    pickedAt: task.pickedAt || null,
    completedAt: task.completedAt || null,
    stalledAt: task.stalledAt || "",
    recoverable: task.recoverable !== false
  };
}

function publicWindowsTaskAdminDetail(task) {
  return {
    ...task,
    payload: publicWindowsTaskPayload(task.payload || {}),
    result: sanitizeTaskResult(task.result || {}, { includeEvidence: true }),
    delivery: undefined,
    deliveryAttempts: Number(task.deliveryAttempts || 0),
    events: undefined
  };
}

function publicWindowsTaskPayload(payload = {}) {
  return {
    smsOrderId: payload.smsOrderId || "",
    source: payload.source || "",
    automationJobId: payload.automationJobId || "",
    automationSessionId: payload.automationSessionId || "",
    minDelaySeconds: Math.max(0, Number(payload.minDelaySeconds || 0)),
    maxDelaySeconds: Math.max(0, Number(payload.maxDelaySeconds || 0)),
    xhsTaskId: payload.xhsTaskId || "",
    xhsAppSlot: payload.xhsAppSlot || "",
    xhsAccountLabel: payload.xhsAccountLabel || "",
    xhsAccountId: payload.xhsAccountId || "",
    xhsAccountName: payload.xhsAccountName || "",
    deviceName: payload.deviceName || "",
    apkPath: payload.apkPath || "",
    workflowScriptId: payload.workflowScript?.scriptId || payload.workflowScriptId || "",
    workflowScriptVersion: payload.workflowScript?.version || payload.workflowScriptVersion || ""
  };
}

function publicWindowsTaskEventSummary(event, options = {}) {
  const screenshot = event?.screenshot ? sanitizeScreenshot(event.screenshot, { includeDataUrl: options.includeEvidence === true }) : null;
  const uiHierarchyUrl = publicEventHierarchyUrl(event);
  return {
    phase: String(event?.phase || ""),
    level: String(event?.level || "info"),
    message: String(event?.message || "").slice(0, 700),
    stepId: String(event?.stepId || ""),
    stepIndex: Number.isFinite(Number(event?.stepIndex)) ? Number(event.stepIndex) : null,
    errorCode: String(event?.errorCode || ""),
    packageName: String(event?.packageName || ""),
    currentActivity: String(event?.currentActivity || ""),
    uiSnapshot: String(event?.uiSnapshot || "").slice(0, options.includeEvidence ? MAX_STORED_UI_SNAPSHOT_CHARS : 1000),
    uiHierarchy: options.includeEvidence ? String(event?.uiHierarchy || event?.uiSnapshot || "").slice(0, MAX_STORED_UI_HIERARCHY_CHARS) : "",
    uiHierarchyUrl,
    uiHierarchyEvidence: event?.uiHierarchyEvidence ? publicEvidenceAsset(event.uiHierarchyEvidence) : null,
    hasScreenshot: Boolean(screenshot),
    screenshot,
    createdAt: event?.createdAt || ""
  };
}

function xhsTaskAsDeviceCommand(task) {
  return {
    commandId: task.taskId,
    deviceId: task.deviceId,
    type: "xhs_qr_from_gallery",
    status: task.status,
    payload: {
      qrImageDataUrl: task.qrImageDataUrl || "",
      autoConfirmLogin: true,
      xhsAppSlot: task.xhsAppSlot || "app1",
      xhsAccountLabel: task.xhsAccountLabel || "",
      xhsAccountId: task.xhsAccountId || "",
      xhsAccountName: task.xhsAccountName || "",
      workflowScript: task.workflowScript || null
    },
    result: isTerminalStatus(task.status)
      ? sanitizeTaskResult(task.result || {}, { includeEvidence: true })
      : task.result || {},
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    pickedAt: task.pickedAt || null,
    completedAt: task.completedAt || null
  };
}

function effectiveSmsSlotIndex(message = {}) {
  if (message.slotIndex !== null && message.slotIndex !== undefined) return message.slotIndex;
  const subscriptionId = message.subscriptionId;
  if (subscriptionId === null || subscriptionId === undefined) return null;
  const device = state.devices.find((item) => item.deviceId === message.deviceId);
  const sim = (device?.sims || []).find((item) => Number(item.subscriptionId) === Number(subscriptionId));
  return sim?.slotIndex ?? null;
}

function publicSmsMessage(message) {
  return {
    messageId: message.messageId,
    deviceId: message.deviceId,
    messageKey: message.messageKey,
    smsId: message.smsId || "",
    threadId: message.threadId || "",
    box: message.box || "unknown",
    type: message.type ?? null,
    address: message.address || "",
    phoneNumber: message.phoneNumber || "",
    body: message.body || "",
    code: message.code || "",
    platform: message.platform || "",
    messageAt: message.messageAt || message.receivedAt || message.createdAt,
    dateSent: message.dateSent || "",
    read: Boolean(message.read),
    seen: Boolean(message.seen),
    status: message.status || "",
    locked: Boolean(message.locked),
    subscriptionId: message.subscriptionId ?? null,
    slotIndex: effectiveSmsSlotIndex(message),
    source: message.source || "",
    sourcePackage: message.sourcePackage || "",
    sourceAliases: Array.isArray(message.sourceAliases) ? message.sourceAliases : [],
    createdAt: message.createdAt,
    updatedAt: message.updatedAt
  };
}

function publicUserSmsMessage(message, userId = "") {
  const matchedOrder = state.smsOrders.find((order) => order.userId === userId && smsOrderHasMatchedMessage(order, message));
  return {
    messageId: message.messageId,
    deviceId: message.deviceId,
    box: message.box || "unknown",
    address: message.address || "",
    phoneNumber: maskPhone(message.phoneNumber || matchedOrder?.phoneNumber || ""),
    body: maskSmsBody(message.body || "", message.code || matchedOrder?.code || ""),
    code: message.code || matchedOrder?.code || "",
    platform: message.platform || matchedOrder?.platform || "",
    messageAt: message.messageAt || message.receivedAt || message.createdAt,
    read: Boolean(message.read),
    seen: Boolean(message.seen),
    subscriptionId: message.subscriptionId ?? null,
    slotIndex: message.slotIndex ?? null,
    source: message.source || "",
    visibility: matchedOrder ? "matched_sms" : "none",
    redacted: true,
    accessReason: matchedOrder ? "sms_order_window" : "none",
    smsOrderId: matchedOrder?.orderId || "",
    matchedOrderId: matchedOrder?.orderId || "",
    createdAt: message.createdAt,
    updatedAt: message.updatedAt
  };
}

function maskPhone(value = "") {
  const text = String(value || "");
  const digits = text.replace(/\D/g, "");
  if (digits.length < 7) return text;
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

function maskSmsBody(body = "", code = "") {
  const text = String(body || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const preservedCode = String(code || "");
  if (preservedCode) {
    const marker = "__PHONE_CLOUD_CODE__";
    return text
      .replaceAll(preservedCode, marker)
      .replace(/[0-9A-Za-z]/g, "*")
      .replaceAll(marker, preservedCode)
      .slice(0, 300);
  }
  return text.replace(/[0-9A-Za-z]/g, "*").slice(0, 300);
}

function publicDevice(device) {
  const serial = String(device.adb?.serial || "").trim();
  const agentReports = serial ? (adbSerialConflictMap().get(serial) || []) : [];
  const uniqueAgents = [...new Set(agentReports.map((item) => item.agentId).filter(Boolean))];
  return {
    ...device,
    occupancy: deviceOccupancyForViewer(device, { role: "admin" }),
    listingStatus: normalizeDeviceListingStatus(device.listingStatus || "listed"),
    listed: isDeviceListed(device),
    leaseAgentId: device.adb?.agentId || "",
    conflictStatus: uniqueAgents.length > 1 ? "agent_conflict" : "",
    conflictAgents: uniqueAgents
  };
}

function deviceOccupancyForViewer(device, viewer = null, overrides = {}) {
  const activeLock = overrides.activeLock || activeDeviceLockForTask(device.deviceId);
  const activeScreenSession = overrides.activeScreenSession || screenSessions.activeForDevice(device.deviceId);
  const activeXhsTask = overrides.activeXhsTask || activeXhsTaskForDevice(device.deviceId);
  const waitingSmsOrder = overrides.waitingSmsOrder || state.smsOrders.find((order) => (
    order.status === "waiting" && order.deviceId === device.deviceId
  ));
  const source = activeLock
    || (activeScreenSession ? {
      lockType: "screen_control",
      ownerUserId: activeScreenSession.userId,
      taskId: activeScreenSession.sessionId,
      createdAt: activeScreenSession.createdAt
    } : null)
    || (activeXhsTask ? {
      lockType: "xhs_qr",
      ownerUserId: activeXhsTask.userId,
      taskId: activeXhsTask.taskId,
      appSlot: activeXhsTask.xhsAppSlot,
      createdAt: activeXhsTask.createdAt
    } : null)
    || (waitingSmsOrder ? {
      lockType: "sms_wait",
      ownerUserId: waitingSmsOrder.userId,
      taskId: waitingSmsOrder.orderId,
      createdAt: waitingSmsOrder.startedAt || waitingSmsOrder.createdAt
    } : null);
  const lookupChannel = managedLookup?.reserved(device.deviceId);
  const lookupSessionId = lookupChannel?.sessionId || (source?.lockType === "alipay_name_lookup" ? source.taskId : "");
  const lookupSession = lookupSessionId ? state.automationSessions.find(s => s.sessionId === lookupSessionId && s.deviceId === device.deviceId) : null;
  return buildDeviceOccupancy({ lock: source, viewer, users: state.users || [], lookupSession, lookupChannel, lookupJobs: state.automationJobs || [] });
}

function addAudit(action, ctx, detail) {
  const event = { auditId: newId(), action, actor: ctx?.role || "system", detail, createdAt: nowIso() };
  state.audit.unshift(event);
  state.audit = state.audit.slice(0, MAX_AUDIT_EVENTS);
  return event;
}

function getRequestId(req) {
  const incoming = String(req.headers["x-request-id"] || "").trim();
  if (/^[A-Za-z0-9._:-]{8,120}$/.test(incoming)) return incoming.slice(0, 120);
  return newId();
}

function setSecurityHeaders(res) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("cross-origin-resource-policy", "same-origin");
  res.setHeader("cross-origin-opener-policy", "same-origin");
  res.setHeader("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; base-uri 'self'; frame-ancestors 'none'");
  if (PUBLIC_BASE_URL.startsWith("https://")) {
    res.setHeader("strict-transport-security", "max-age=15552000; includeSubDomains");
  }
}

function enforceRequestOrigin(req) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method || "")) return;
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return;
  if (isTrustedOrigin(origin, req)) return;
  const error = new Error("forbidden_origin");
  error.statusCode = 403;
  throw error;
}

function isTrustedOrigin(origin, req) {
  if (TRUSTED_ORIGINS.has(origin)) return true;
  const host = String(req.headers.host || "").trim();
  if (!host) return false;
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwardedProto || (PUBLIC_BASE_URL.startsWith("https://") ? "https" : "http");
  return origin === `${proto}://${host}`;
}

function parseTrustedOrigins(value) {
  const origins = new Set();
  for (const item of String(value || "").split(",")) {
    const origin = item.trim().replace(/\/+$/, "");
    if (/^https?:\/\/[^/]+$/i.test(origin)) origins.add(origin);
  }
  return origins;
}

function parseWebRtcIceServers(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 8).map((item) => {
      const urls = Array.isArray(item?.urls)
        ? item.urls.map((url) => String(url || "").trim()).filter(Boolean).slice(0, 8)
        : String(item?.urls || "").trim();
      return {
        urls,
        ...(item?.username ? { username: String(item.username).slice(0, 256) } : {}),
        ...(item?.credential ? { credential: String(item.credential).slice(0, 512) } : {})
      };
    }).filter((item) => Array.isArray(item.urls) ? item.urls.length : item.urls);
  } catch {
    console.warn("invalid SCREEN_WEBRTC_ICE_SERVERS_JSON");
    return [];
  }
}

function parseThirdPartyApiClients(value) {
  const clients = new Map();
  for (const item of String(value || "").split(",")) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf(":");
    if (index <= 0) continue;
    const clientId = trimmed.slice(0, index).trim();
    const secret = trimmed.slice(index + 1).trim();
    if (!/^[A-Za-z0-9._-]{3,80}$/.test(clientId)) continue;
    if (secret.length < 16) continue;
    clients.set(clientId, { clientId, secret });
  }
  return clients;
}

function logAccess(req, res, startedAt, requestId) {
  const durationMs = Date.now() - startedAt;
  const url = req.url || "/";
  const actor = req.headers.authorization ? "auth" : "anon";
  console.log(`${nowIso()} request_id=${requestId} method=${req.method} path=${JSON.stringify(url)} status=${res.statusCode} duration_ms=${durationMs} actor=${actor} ip=${req.socket?.remoteAddress || ""}`);
}

async function serveStatic(req, res, url) {
  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const target = path.normalize(path.join(PUBLIC_DIR, pathname));
  const relative = path.relative(PUBLIC_DIR, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return json(res, 403, { error: "forbidden" });
  try {
    const bytes = await fs.readFile(target);
    res.writeHead(200, { "content-type": contentType(target), "cache-control": "no-store" });
    res.end(bytes);
  } catch (error) {
    if (error.code === "ENOENT") return json(res, 404, { error: "not_found" });
    throw error;
  }
}

async function readJson(req) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (contentType && !contentType.includes("application/json")) {
    const error = new Error("unsupported_media_type");
    error.statusCode = 415;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      const error = new Error("payload_too_large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    const invalidJson = new Error("invalid_json");
    invalidJson.statusCode = 400;
    throw invalidJson;
  }
}

async function readRawJson(req) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (contentType && !contentType.includes("application/json")) {
    const error = new Error("unsupported_media_type");
    error.statusCode = 415;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      const error = new Error("payload_too_large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return { raw: "", input: {} };
  try {
    return { raw, input: JSON.parse(raw) };
  } catch {
    const invalidJson = new Error("invalid_json");
    invalidJson.statusCode = 400;
    throw invalidJson;
  }
}

async function readBytes(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("payload_too_large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

function buildScreenMediaStart(session) {
  if (session?.mediaTransport === "direct_webrtc") {
    return {
      mode: "direct_webrtc",
      signalUrl: screenDirectWebRtcSignalUrl(session, "agent"),
      iceServers: SCREEN_DIRECT_WEBRTC_ICE_SERVERS
    };
  }
  if (session?.mediaTransport !== "webrtc") return { mode: "websocket" };
  const path = mediaPathForSession(session);
  const publishBase = SCREEN_MEDIA_PUBLISH_TRANSPORT === "whip" ? screenMediaWhipPublishBaseUrl() : mediaRtspPublishBaseUrl();
  if (!publishBase) return { mode: "websocket", unavailableReason: "screen_webrtc_publish_url_missing" };
  const token = encodeURIComponent(screenMediaAuthorizer.issue({ sessionId: session.sessionId, action: "publish", path }));
  if (SCREEN_MEDIA_PUBLISH_TRANSPORT === "whip") {
    return {
      mode: "webrtc",
      publisher: "whip",
      path,
      publishUrl: `${publishBase}/${path}/whip?token=${token}`
    };
  }
  return {
    mode: "webrtc",
    publisher: "rtsp",
    path,
    publishUrl: `${publishBase}/${path}?token=${token}`
  };
}

function buildScreenMediaBrowser(session) {
  if (session?.mediaTransport === "direct_webrtc") {
    return {
      mode: "direct_webrtc",
      signalUrl: screenDirectWebRtcSignalUrl(session, "browser"),
      iceServers: SCREEN_DIRECT_WEBRTC_ICE_SERVERS
    };
  }
  if (session?.mediaTransport !== "webrtc") return { mode: "websocket" };
  const path = mediaPathForSession(session);
  const whepBase = screenMediaWhepBaseUrl();
  if (!whepBase) return { mode: "websocket", unavailableReason: "screen_webrtc_whep_url_missing" };
  return {
    mode: "webrtc",
    path,
    whepUrl: `${whepBase}/${path}/whep`,
    token: screenMediaAuthorizer.issue({ sessionId: session.sessionId, action: "read", path })
  };
}

function screenDirectWebRtcSignalUrl(session, role) {
  const source = PUBLIC_BASE_URL || `http://${HOST}:${PORT}`;
  try {
    const url = new URL(source);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/realtime/v1/sessions/${encodeURIComponent(session.sessionId)}/direct-webrtc`;
    url.search = role === "agent" ? `role=agent&agentId=${encodeURIComponent(session.agentId)}` : "role=browser";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function mediaRtspPublishBaseUrl() {
  if (SCREEN_MEDIA_RTSP_PUBLISH_BASE_URL) return SCREEN_MEDIA_RTSP_PUBLISH_BASE_URL;
  const source = PUBLIC_BASE_URL || `http://${HOST}:${PORT}`;
  try {
    const url = new URL(source);
    return `rtsp://${url.hostname}:8554`;
  } catch {
    return "";
  }
}

function screenMediaWhepBaseUrl() {
  if (SCREEN_MEDIA_WHEP_BASE_URL && !SCREEN_MEDIA_WHEP_BASE_URL.startsWith("/")) return SCREEN_MEDIA_WHEP_BASE_URL;
  const source = PUBLIC_BASE_URL || "";
  if (!source) return "";
  return `${source.replace(/\/$/, "")}${SCREEN_MEDIA_WHEP_BASE_URL || "/webrtc"}`;
}

function screenMediaWhipPublishBaseUrl() {
  if (SCREEN_MEDIA_WHIP_PUBLISH_BASE_URL && !SCREEN_MEDIA_WHIP_PUBLISH_BASE_URL.startsWith("/")) return SCREEN_MEDIA_WHIP_PUBLISH_BASE_URL;
  const source = PUBLIC_BASE_URL || "";
  if (!source) return "";
  return `${source.replace(/\/$/, "")}${SCREEN_MEDIA_WHIP_PUBLISH_BASE_URL || "/webrtc"}`;
}

async function loadState() {
  if (STORAGE_BACKEND === "postgres") return await loadPostgresState();
  if (STORAGE_BACKEND !== "json") throw new Error(`unsupported STORAGE_BACKEND: ${STORAGE_BACKEND}`);
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const parsed = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
    return withStateDefaults(parsed);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return withStateDefaults({});
  }
}

function withStateDefaults(input) {
  return {
    stateVersion: Number(input.stateVersion || 1),
    windowsAgents: input.windowsAgents || [],
    windowsTasks: input.windowsTasks || [],
    deviceLocks: input.deviceLocks || [],
    devices: input.devices || [],
    smsOrders: input.smsOrders || [],
    smsEvents: input.smsEvents || [],
    smsMessages: input.smsMessages || [],
    smsLibraryRefreshes: input.smsLibraryRefreshes || [],
    xhsQrTasks: input.xhsQrTasks || [],
    automationJobs: input.automationJobs || [],
    automationSessions: input.automationSessions || [],
    evidenceAssets: input.evidenceAssets || [],
    workflowScripts: normalizeWorkflowScripts(input.workflowScripts),
    users: input.users || [],
    sessions: input.sessions || [],
    openApiNonces: input.openApiNonces || [],
    appRelease: input.appRelease || null,
    audit: input.audit || []
  };
}

async function saveState() {
  return saveQueue.enqueue(async () => {
    const startedAt = Date.now();
    compactTaskCollectionsForSave();
    if (STORAGE_BACKEND === "postgres") {
      const bytes = await savePostgresSnapshot(state);
      realtimeMetrics.snapshotSaved(Date.now() - startedAt, bytes);
      return;
    }
    if (STORAGE_BACKEND !== "json") throw new Error(`unsupported STORAGE_BACKEND: ${STORAGE_BACKEND}`);
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${DATA_FILE}.tmp`;
    const serialized = JSON.stringify(state, null, 2);
    await fs.writeFile(tmp, serialized, { mode: 0o600 });
    await fs.chmod(tmp, 0o600).catch(() => {});
    await fs.rename(tmp, DATA_FILE);
    await fs.chmod(DATA_FILE, 0o600).catch(() => {});
    realtimeMetrics.snapshotSaved(Date.now() - startedAt, Buffer.byteLength(serialized));
  });
}

let deferredStateSaveTimer = null;

function scheduleStateSave(delayMs = 1000) {
  if (deferredStateSaveTimer) return;
  deferredStateSaveTimer = setTimeout(() => {
    deferredStateSaveTimer = null;
    saveState().catch((error) => console.error("deferred state save failed", error));
  }, Math.max(0, Number(delayMs) || 0));
  deferredStateSaveTimer.unref?.();
}

async function loadPostgresState() {
  const pool = await getPostgresPool();
  await initPostgresStorage(pool);
  const result = await pool.query("select data from phone_cloud_state where state_key = $1", [POSTGRES_STATE_KEY]);
  if (result.rows[0]?.data) return withStateDefaults(result.rows[0].data);

  if (POSTGRES_BOOTSTRAP_FROM_JSON) {
    try {
      const parsed = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
      const snapshot = withStateDefaults(parsed);
      await savePostgresSnapshot(snapshot);
      console.log(`bootstrapped postgres state from ${DATA_FILE}`);
      return snapshot;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  return withStateDefaults({});
}

async function savePostgresSnapshot(snapshot) {
  const pool = await getPostgresPool();
  await initPostgresStorage(pool);
  const client = await pool.connect();
  const serialized = stringifyPostgresJson(snapshot);
  try {
    await client.query("begin");
    // This table intentionally stores a single full-state snapshot. Updating a
    // large jsonb row repeatedly creates dead TOAST tuples faster than autovacuum
    // can reclaim them. Replacing the one-row table keeps the relation small
    // until the state is fully split into structured tables.
    await client.query("truncate table phone_cloud_state");
    await client.query(
      `insert into phone_cloud_state (state_key, data, updated_at)
       values ($1, $2::json, now())`,
      [POSTGRES_STATE_KEY, serialized]
    );
    if (STRUCTURED_TABLE_SYNC) {
      await syncStructuredTables(client, snapshot);
    }
    await client.query("commit");
    return Buffer.byteLength(serialized);
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getPostgresPool() {
  if (postgresPool) return postgresPool;
  if (!DATABASE_URL) throw new Error("DATABASE_URL is required when STORAGE_BACKEND=postgres");
  let pg;
  try {
    pg = await import("pg");
  } catch (error) {
    throw new Error("Postgres storage requires npm dependency 'pg'. Run npm install before using STORAGE_BACKEND=postgres.");
  }
  const Pool = pg.Pool || pg.default?.Pool;
  if (!Pool) throw new Error("Postgres storage could not load pg.Pool");
  postgresPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: POSTGRES_SSL ? { rejectUnauthorized: false } : false
  });
  return postgresPool;
}

async function initPostgresStorage(pool) {
  await pool.query(`
    create table if not exists phone_cloud_state (
      state_key text primary key,
      data json not null,
      updated_at timestamptz not null default now()
    )
  `);
  await pool.query(`
    create table if not exists phone_cloud_users (
      user_id text primary key,
      username text,
      role text,
      enabled boolean,
      updated_at timestamptz,
      data jsonb not null
    );
    create table if not exists phone_cloud_sessions (
      session_id text primary key,
      user_id text,
      expires_at timestamptz,
      revoked_at timestamptz,
      data jsonb not null
    );
    create table if not exists phone_cloud_devices (
      device_id text primary key,
      data jsonb not null,
      updated_at timestamptz not null default now()
    );
    create table if not exists phone_cloud_sms_messages (
      message_id text primary key,
      device_id text not null,
      message_at timestamptz,
      data jsonb not null,
      updated_at timestamptz not null default now()
    );
    create table if not exists phone_cloud_xhs_tasks (
      task_id text primary key,
      device_id text,
      user_id text,
      status text,
      created_at timestamptz,
      updated_at timestamptz,
      data jsonb not null
    );
    create table if not exists phone_cloud_automation_jobs (
      job_id text primary key,
      device_id text,
      user_id text,
      kind text,
      status text,
      created_at timestamptz,
      updated_at timestamptz,
      data jsonb not null
    );
    create table if not exists phone_cloud_automation_sessions (
      session_id text primary key,
      device_id text,
      user_id text,
      status text,
      created_at timestamptz,
      updated_at timestamptz,
      data jsonb not null
    );
    create table if not exists phone_cloud_windows_tasks (
      task_id text primary key,
      agent_id text,
      adb_serial text,
      status text,
      created_at timestamptz,
      updated_at timestamptz,
      data jsonb not null
    );
    create table if not exists phone_cloud_task_events (
      event_id text primary key,
      task_id text not null,
      source text,
      created_at timestamptz,
      data jsonb not null
    );
    create table if not exists phone_cloud_device_locks (
      lock_id text primary key,
      device_id text,
      status text,
      expires_at timestamptz,
      data jsonb not null
    );
    create table if not exists phone_cloud_audit_events (
      audit_id text primary key,
      created_at timestamptz,
      data jsonb not null
    );
    create index if not exists idx_phone_cloud_sms_device_time on phone_cloud_sms_messages (device_id, message_at desc);
    create unique index if not exists idx_phone_cloud_users_username on phone_cloud_users (username);
    create index if not exists idx_phone_cloud_sessions_user_expiry on phone_cloud_sessions (user_id, expires_at desc);
    create index if not exists idx_phone_cloud_xhs_device_status on phone_cloud_xhs_tasks (device_id, status);
    create index if not exists idx_phone_cloud_xhs_user_created on phone_cloud_xhs_tasks (user_id, created_at desc);
    create index if not exists idx_phone_cloud_automation_job_device_status on phone_cloud_automation_jobs (device_id, status);
    create index if not exists idx_phone_cloud_automation_job_user_created on phone_cloud_automation_jobs (user_id, created_at desc);
    create index if not exists idx_phone_cloud_automation_session_device_status on phone_cloud_automation_sessions (device_id, status);
    create index if not exists idx_phone_cloud_windows_agent_status on phone_cloud_windows_tasks (agent_id, status);
    create index if not exists idx_phone_cloud_events_task_time on phone_cloud_task_events (task_id, created_at desc);
    create index if not exists idx_phone_cloud_locks_device_status on phone_cloud_device_locks (device_id, status);
  `);
}

async function syncStructuredTables(client, snapshot) {
  for (const device of snapshot.devices || []) {
    await client.query(
      `insert into phone_cloud_devices (device_id, data, updated_at)
       values ($1, $2::jsonb, now())
       on conflict (device_id) do update set data = excluded.data, updated_at = now()`,
      [device.deviceId, stringifyPostgresJson(device)]
    );
  }
  for (const message of snapshot.smsMessages || []) {
    await client.query(
      `insert into phone_cloud_sms_messages (message_id, device_id, message_at, data, updated_at)
       values ($1, $2, $3, $4::jsonb, now())
       on conflict (message_id) do update set data = excluded.data, updated_at = now()`,
      [message.messageId, message.deviceId || "", normalizePgDate(message.messageAt || message.receivedAt || message.createdAt), stringifyPostgresJson(message)]
    );
  }
  for (const task of snapshot.xhsQrTasks || []) {
    await client.query(
      `insert into phone_cloud_xhs_tasks (task_id, device_id, user_id, status, created_at, updated_at, data)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb)
       on conflict (task_id) do update set device_id = excluded.device_id, user_id = excluded.user_id, status = excluded.status, updated_at = excluded.updated_at, data = excluded.data`,
      [task.taskId, task.deviceId || "", task.userId || "", task.status || "", normalizePgDate(task.createdAt), normalizePgDate(task.updatedAt), stringifyPostgresJson(task)]
    );
    for (const event of task.events || []) {
      await syncStructuredEvent(client, event, task.taskId, "xhs");
    }
  }
  for (const job of snapshot.automationJobs || []) {
    await client.query(
      `insert into phone_cloud_automation_jobs (job_id, device_id, user_id, kind, status, created_at, updated_at, data)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       on conflict (job_id) do update set device_id = excluded.device_id, user_id = excluded.user_id, kind = excluded.kind, status = excluded.status, updated_at = excluded.updated_at, data = excluded.data`,
      [job.jobId, job.deviceId || "", job.userId || "", job.kind || "", job.status || "", normalizePgDate(job.createdAt), normalizePgDate(job.updatedAt), stringifyPostgresJson(job)]
    );
  }
  for (const session of snapshot.automationSessions || []) {
    await client.query(
      `insert into phone_cloud_automation_sessions (session_id, device_id, user_id, status, created_at, updated_at, data)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb)
       on conflict (session_id) do update set device_id = excluded.device_id, user_id = excluded.user_id, status = excluded.status, updated_at = excluded.updated_at, data = excluded.data`,
      [session.sessionId, session.deviceId || "", session.userId || "", session.status || "", normalizePgDate(session.createdAt), normalizePgDate(session.updatedAt), stringifyPostgresJson(session)]
    );
  }
  for (const task of snapshot.windowsTasks || []) {
    await client.query(
      `insert into phone_cloud_windows_tasks (task_id, agent_id, adb_serial, status, created_at, updated_at, data)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb)
       on conflict (task_id) do update set agent_id = excluded.agent_id, adb_serial = excluded.adb_serial, status = excluded.status, updated_at = excluded.updated_at, data = excluded.data`,
      [task.taskId, task.agentId || "", task.adbSerial || "", task.status || "", normalizePgDate(task.createdAt), normalizePgDate(task.updatedAt), stringifyPostgresJson(task)]
    );
    for (const event of task.events || []) {
      await syncStructuredEvent(client, event, task.taskId, "windows");
    }
  }
  for (const lock of snapshot.deviceLocks || []) {
    await client.query(
      `insert into phone_cloud_device_locks (lock_id, device_id, status, expires_at, data)
       values ($1, $2, $3, $4, $5::jsonb)
       on conflict (lock_id) do update set device_id = excluded.device_id, status = excluded.status, expires_at = excluded.expires_at, data = excluded.data`,
      [lock.lockId, lock.deviceId || "", lock.status || "", normalizePgDate(lock.expiresAt), stringifyPostgresJson(lock)]
    );
  }
  for (const event of snapshot.audit || []) {
    await client.query(
      `insert into phone_cloud_audit_events (audit_id, created_at, data)
       values ($1, $2, $3::jsonb)
       on conflict (audit_id) do update set data = excluded.data`,
      [event.auditId || event.eventId || crypto.createHash("sha256").update(stringifyPostgresJson(event)).digest("hex"), normalizePgDate(event.createdAt), stringifyPostgresJson(event)]
    );
  }
}

async function syncStructuredEvent(client, event, taskId, source) {
  const eventId = event.eventId || crypto.createHash("sha256").update(`${taskId}:${source}:${stringifyPostgresJson(event)}`).digest("hex");
  await client.query(
    `insert into phone_cloud_task_events (event_id, task_id, source, created_at, data)
     values ($1, $2, $3, $4, $5::jsonb)
     on conflict (event_id) do update set data = excluded.data`,
    [eventId, taskId, source, normalizePgDate(event.createdAt), stringifyPostgresJson(event)]
  );
}

function normalizePgDate(value) {
  const time = toTime(value);
  return time ? new Date(time).toISOString() : null;
}

async function checkStorageStatus() {
  if (STORAGE_BACKEND === "json") {
    return {
      ok: true,
      detail: ALLOW_JSON_STORAGE_IN_PRODUCTION
        ? "json 已显式确认，仅适合试运行和小规模联调"
        : "json 本地文件；生产试运行需设置 ALLOW_JSON_STORAGE_IN_PRODUCTION=true"
    };
  }

  if (STORAGE_BACKEND === "postgres") {
    try {
      const pool = await getPostgresPool();
      await initPostgresStorage(pool);
      const result = await pool.query("select updated_at from phone_cloud_state where state_key = $1", [POSTGRES_STATE_KEY]);
      const updatedAt = result.rows[0]?.updated_at ? new Date(result.rows[0].updated_at).toISOString() : "尚未写入快照";
      return { ok: true, detail: `postgres 已连接，state_key=${POSTGRES_STATE_KEY}，updated_at=${updatedAt}` };
    } catch (error) {
      return { ok: false, detail: `postgres 不可用：${error.message}` };
    }
  }

  return { ok: false, detail: `未知存储后端：${STORAGE_BACKEND}` };
}

async function loadDotEnv(file) {
  try {
    const text = await fs.readFile(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index <= 0) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
      if (!process.env[key]) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".jpg") || file.endsWith(".jpeg")) return "image/jpeg";
  if (file.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

function normalizePhone(value = "") {
  return String(value || "").replace(/[^\d+]/g, "");
}

function normalizeOptionalInt(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeIsoTime(value) {
  if (!value) return "";
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "";
  return new Date(time).toISOString();
}

function normalizeSmsEventFingerprint(value) {
  return String(value || "").trim().slice(0, 160);
}

function normalizeSmsMessageKey(value) {
  return String(value || "").trim().slice(0, 180);
}

function normalizeIdempotencyKey(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(text)) throw badRequest("invalid_idempotency_key");
  return text;
}

function normalizeSmsBox(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (["all", "inbox", "sent", "draft", "outbox", "failed", "queued", "unknown"].includes(text)) return text;
  const numeric = Number(value);
  if (numeric === 1) return "inbox";
  if (numeric === 2) return "sent";
  if (numeric === 3) return "draft";
  if (numeric === 4) return "outbox";
  if (numeric === 5) return "failed";
  if (numeric === 6) return "queued";
  return "unknown";
}

function normalizePlatform(value = "") {
  const text = String(value || "").trim();
  if (/xhs|redbook|xiaohongshu|小红书/i.test(text)) return "小红书";
  return text || "未知平台";
}

function detectPlatform(body = "", sender = "") {
  const text = `${sender} ${body}`;
  if (/小红书|xhs|redbook|xiaohongshu/i.test(text)) return "小红书";
  return sender || "未知平台";
}

function extractCode(body = "") {
  const text = String(body || "").replace(/\s+/g, " ");
  const match = text.match(/(?:验证码|校验码|动态码|code)[^\dA-Za-z]{0,18}([A-Za-z0-9]{4,8})/i)
    || text.match(/([A-Za-z0-9]{4,8})(?:\s*为|是)?[^，。,.]{0,20}(?:验证码|校验码|动态码)/);
  return match?.[1] || "";
}

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return crypto.randomUUID();
}

function safeFileName(value = "") {
  return String(value || "phone-agent.apk").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 160) || "phone-agent.apk";
}

function boolEnv(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function normalizeStorageBackend(value) {
  return String(value || "json").trim().toLowerCase() || "json";
}
