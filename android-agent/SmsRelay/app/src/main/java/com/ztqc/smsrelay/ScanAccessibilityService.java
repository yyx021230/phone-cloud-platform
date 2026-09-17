package com.ztqc.smsrelay;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONObject;
import org.json.JSONArray;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class ScanAccessibilityService extends AccessibilityService {
    private static volatile ScanAccessibilityService activeService;
    private static final String PREFS = "scan_command_flow";
    private static final String COMMAND_ID = "command_id";
    private static final String NEED_GALLERY = "need_gallery";
    private static final String AUTO_CONFIRM_LOGIN = "auto_confirm_login";
    private static final String GALLERY_SELECTED = "gallery_selected";
    private static final String WORKFLOW_SCRIPT = "workflow_script";
    private static final String STEP_INDEX = "step_index";
    private static final String STEP_DELAY_UNTIL = "step_delay_until";
    private static final String STEP_WAIT_STARTED_AT = "step_wait_started_at";
    private static final String STEP_STARTED_AT = "step_started_at";
    private static final String STEP_VERIFY_INDEX = "step_verify_index";
    private static final String STEP_VERIFY_SPEC = "step_verify_spec";
    private static final String STEP_VERIFY_STARTED_AT = "step_verify_started_at";
    private static final String LAST_ACTION = "last_action";
    private static final String LAST_REPORT_ACTION = "last_report_action";
    private static final String LAST_REPORT_AT = "last_report_at";
    private static final String LAST_PACKAGE = "last_package";
    private static final String LAST_UI_SNAPSHOT = "last_ui_snapshot";
    private static final String CANCELLED_REMOTE_STATUS = "cancelled_remote_status";
    private static final String CANCEL_REPORTED = "cancel_reported";
    private static final String LAST_CANCEL_CHECK_AT = "last_cancel_check_at";
    private static final String ACTIVE = "active";
    private static final String VERIFY_FINISH_TEXT = "verify_finish_text";
    private static final String VERIFY_FINISH_MESSAGE = "verify_finish_message";
    private static final String VERIFY_FINISH_STARTED_AT = "verify_finish_started_at";
    private static final String SELF_LAUNCHER_SEARCH_PHASE = "self_launcher_search_phase";
    private static final String SELF_LAUNCHER_FORWARD_SWIPES = "self_launcher_forward_swipes";
    private static final String SELF_LAUNCHER_BACKWARD_SWIPES = "self_launcher_backward_swipes";
    private static final String SELF_LAUNCHER_HOME_SENT = "self_launcher_home_sent";
    private static final String SELF_LAUNCHER_TAPPED_AT = "self_launcher_tapped_at";
    private static final long FLOW_TIMEOUT_MS = 190_000L;
    private static final long FINISH_VERIFY_TIMEOUT_MS = 8_000L;
    private static final long CANCEL_CHECK_INTERVAL_MS = 2_000L;
    private static final long SELF_LAUNCHER_SWIPE_SETTLE_MS = 1_100L;
    private static final int SELF_LAUNCHER_FORWARD_SCAN_COUNT = 3;
    private static final int SELF_LAUNCHER_BACKWARD_SCAN_COUNT = 5;
    private static long lastActionAt = 0L;
    private static long lastSelfLauncherSwipeAt = 0L;
    private static volatile boolean cancelCheckRunning = false;
    private final Handler engineHandler = new Handler(Looper.getMainLooper());
    private boolean engineTickRunning = false;
    private final Runnable engineTick = new Runnable() {
        @Override
        public void run() {
            try {
                driveActiveFlow();
            } finally {
                engineHandler.postDelayed(this, 450);
            }
        }
    };

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        activeService = this;
        RelayForegroundService.start(this);
        RelayClient.sendHeartbeatAsync(this);
        engineHandler.removeCallbacks(engineTick);
        engineHandler.post(engineTick);
    }

    @Override
    public void onDestroy() {
        engineHandler.removeCallbacks(engineTick);
        super.onDestroy();
    }

    public static boolean requestUnlockSwipe(Context context) {
        ScanAccessibilityService service = activeService;
        if (service == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false;
        return service.swipeUnlockScreen();
    }

    public static void startFlow(Context context, String commandId, boolean needGallery, boolean autoConfirmLogin, JSONObject workflowScript) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(ACTIVE, true)
            .putString(COMMAND_ID, commandId)
            .putBoolean(NEED_GALLERY, needGallery)
            .putBoolean(AUTO_CONFIRM_LOGIN, autoConfirmLogin)
            .putBoolean(GALLERY_SELECTED, false)
            .putString(WORKFLOW_SCRIPT, workflowScript == null ? "" : workflowScript.toString())
            .putInt(STEP_INDEX, 0)
            .remove(STEP_DELAY_UNTIL)
            .remove(STEP_WAIT_STARTED_AT)
            .remove(STEP_STARTED_AT)
            .remove(STEP_VERIFY_INDEX)
            .remove(STEP_VERIFY_SPEC)
            .remove(STEP_VERIFY_STARTED_AT)
            .remove(LAST_ACTION)
            .remove(LAST_REPORT_ACTION)
            .remove(LAST_REPORT_AT)
            .remove(LAST_PACKAGE)
            .remove(LAST_UI_SNAPSHOT)
            .remove(CANCELLED_REMOTE_STATUS)
            .remove(CANCEL_REPORTED)
            .remove(LAST_CANCEL_CHECK_AT)
            .remove(VERIFY_FINISH_TEXT)
            .remove(VERIFY_FINISH_MESSAGE)
            .remove(VERIFY_FINISH_STARTED_AT)
            .remove(SELF_LAUNCHER_SEARCH_PHASE)
            .remove(SELF_LAUNCHER_FORWARD_SWIPES)
            .remove(SELF_LAUNCHER_BACKWARD_SWIPES)
            .remove(SELF_LAUNCHER_HOME_SENT)
            .remove(SELF_LAUNCHER_TAPPED_AT)
            .putLong("started_at", System.currentTimeMillis())
            .apply();
        ScanAccessibilityService service = activeService;
        if (service != null) {
            service.engineHandler.removeCallbacks(service.engineTick);
            service.engineHandler.post(service.engineTick);
        } else {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(ACTIVE, false).apply();
            new Thread(() -> {
                try {
                    JSONObject result = new JSONObject();
                    result.put("message", "无障碍服务未运行，请先开启“验证码中控”的无障碍授权");
                    result.put("at", System.currentTimeMillis());
                    RelayClient.sendCommandStatus(context, commandId, "failed", result);
                } catch (Exception ignored) {
                }
            }).start();
        }
    }

    public static void nudgeActiveFlow() {
        ScanAccessibilityService service = activeService;
        if (service == null) return;
        service.engineHandler.post(service::driveActiveFlow);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        driveActiveFlow();
    }

    private void driveActiveFlow() {
        if (engineTickRunning) return;
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (!prefs.getBoolean(ACTIVE, false)) return;
        if (prefs.contains(CANCELLED_REMOTE_STATUS)) {
            stopCancelledFlow(prefs.getString(CANCELLED_REMOTE_STATUS, "cancelled"));
            return;
        }
        requestRemoteCancelCheck(prefs);
        if (System.currentTimeMillis() - prefs.getLong("started_at", 0L) > FLOW_TIMEOUT_MS) {
            String lastAction = prefs.getString(LAST_ACTION, "");
            int stepIndex = prefs.getInt(STEP_INDEX, 0);
            String detail = lastAction == null || lastAction.isEmpty() ? "未执行到页面动作" : "最后动作：" + lastAction;
            finishCommand("failed", "扫码任务超时，脚本步骤 " + stepIndex + "，" + detail);
            return;
        }
        if (System.currentTimeMillis() - lastActionAt < 350) return;
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return;
        engineTickRunning = true;
        try {
            rememberUiSnapshot(root);
            handleActiveFlow(root, prefs);
        } finally {
            root.recycle();
            engineTickRunning = false;
        }
    }

    private void requestRemoteCancelCheck(SharedPreferences prefs) {
        String commandId = prefs.getString(COMMAND_ID, "");
        if (commandId == null || commandId.isEmpty() || cancelCheckRunning) return;
        long now = System.currentTimeMillis();
        long lastCheckedAt = prefs.getLong(LAST_CANCEL_CHECK_AT, 0L);
        if (now - lastCheckedAt < CANCEL_CHECK_INTERVAL_MS) return;
        prefs.edit().putLong(LAST_CANCEL_CHECK_AT, now).apply();
        cancelCheckRunning = true;
        new Thread(() -> {
            try {
                JSONObject payload = RelayClient.fetchCommand(this, commandId);
                JSONObject command = payload.optJSONObject("command");
                String status = command == null ? "" : command.optString("status", "");
                if ("cancelled".equals(status) || "expired".equals(status)) {
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                        .putBoolean(ACTIVE, false)
                        .putString(CANCELLED_REMOTE_STATUS, status)
                        .apply();
                    engineHandler.post(() -> stopCancelledFlow(status));
                }
            } catch (Exception ignored) {
            } finally {
                cancelCheckRunning = false;
            }
        }).start();
    }

    private void stopCancelledFlow(String remoteStatus) {
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (prefs.getBoolean(CANCEL_REPORTED, false)) return;
        prefs.edit()
            .putBoolean(ACTIVE, false)
            .putBoolean(CANCEL_REPORTED, true)
            .putString(CANCELLED_REMOTE_STATUS, remoteStatus == null || remoteStatus.isEmpty() ? "cancelled" : remoteStatus)
            .apply();
        String message = "平台已" + ("expired".equals(remoteStatus) ? "回收" : "取消") + "任务，手机端停止执行";
        reportStepEvent("cancel", "info", prefs.getInt(STEP_INDEX, 0), null, message, false);
        new Thread(() -> {
            try {
                JSONObject result = new JSONObject();
                result.put("message", message);
                result.put("remoteStatus", remoteStatus == null ? "" : remoteStatus);
                result.put("at", System.currentTimeMillis());
                RelayClient.sendCommandStatus(this, prefs.getString(COMMAND_ID, ""), "cancelled", result);
            } catch (Exception ignored) {
            }
        }).start();
        boolean handled = performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME);
        if (!handled) {
            try {
                DeviceController.goHome(this);
            } catch (Exception ignored) {
            }
        }
    }

    private void handleActiveFlow(AccessibilityNodeInfo root, SharedPreferences prefs) {
        if (verifyPendingFinish(root, prefs)) return;
        if (runWorkflowScript(root, prefs)) return;

        AccessibilityNodeInfo confirmLogin = findByText(root, new String[] {"确认登录"});
        if (confirmLogin != null) {
            if (prefs.getBoolean(AUTO_CONFIRM_LOGIN, true)) {
                clickNode(confirmLogin, "点击确认登录");
                finishCommand("succeeded", "已点击确认登录，二维码登录链路完成");
            } else {
                finishCommand("succeeded", "已到达确认登录页，等待人工确认");
            }
            return;
        }

        AccessibilityNodeInfo firstXhs = findExactByText(root, "小红书");
        if (firstXhs != null && findByText(root, new String[] {"选择要使用的应用"}) != null) {
            clickNode(firstXhs, "选择第一个小红书入口");
            return;
        }

        if (isGalleryPicker(root)) {
            AccessibilityNodeInfo firstImage = findFirstGalleryImage(root);
            if (firstImage != null) {
                clickNode(firstImage, "点击图库第一张图片");
                markGallerySelected("已选择图库第一张图片，等待小红书识别二维码");
                return;
            }
            tap(89, 269, "兜底点击图库第一张图片");
            markGallerySelected("已兜底点击图库第一张图片，等待小红书识别二维码");
            return;
        }

        if (prefs.getBoolean(GALLERY_SELECTED, false)) {
            reportRunning("等待二维码识别后的确认登录页");
            return;
        }

        AccessibilityNodeInfo album = findByText(root, new String[] {"相册", "图库", "从相册选择", "选择图片"});
        if (album != null) {
            clickNode(album, "点击相册入口");
            return;
        }

        AccessibilityNodeInfo scan = findByText(root, new String[] {"扫一扫", "扫码", "扫描"});
        if (scan != null) {
            clickNode(scan, "点击扫码入口");
            return;
        }

        if (isXhsProfilePage(root)) {
            tap(596, 99, "点击个人主页右上角扫码入口");
            return;
        }

        AccessibilityNodeInfo mine = findByText(root, new String[] {"我"});
        if (mine != null) {
            clickNode(mine, "点击我的");
            return;
        }

        // vivo + 小红书兜底：底部“我”大多在右下角，扫码/相册入口再交给下一轮识别。
        tap(650, 1480, "兜底点击我的");
    }

    private boolean runWorkflowScript(AccessibilityNodeInfo root, SharedPreferences prefs) {
        String raw = prefs.getString(WORKFLOW_SCRIPT, "");
        if (raw == null || raw.isEmpty()) return false;
        try {
            JSONObject script = new JSONObject(raw);
            JSONArray steps = script.optJSONArray("steps");
            if (steps == null || steps.length() == 0) return false;
            if (script.optInt("engineVersion", 1) >= 2) return runWorkflowScriptV2(root, prefs, steps);
            if (verifyPendingStep(root, prefs)) return true;
            if (!prefs.getBoolean(ACTIVE, false)) return true;
            int index = prefs.getInt(STEP_INDEX, 0);
            while (index < steps.length()) {
                JSONObject step = steps.optJSONObject(index);
                if (step == null) {
                    index++;
                    prefs.edit().putInt(STEP_INDEX, index).apply();
                    continue;
                }
                if (shouldSkipOptional(root, step)) {
                    index++;
                    prefs.edit().putInt(STEP_INDEX, index).remove(STEP_DELAY_UNTIL).remove(STEP_WAIT_STARTED_AT).apply();
                    continue;
                }
                if (shouldWaitBeforeStep(prefs, step)) return true;
                if (!executeScriptStep(root, step)) return true;
                if (hasStepVerification(step)) {
                    beginStepVerification(index, step);
                } else if (step.optBoolean("finish", false)) {
                    beginFinishVerification(step);
                } else {
                    index++;
                    prefs.edit().putInt(STEP_INDEX, index).remove(STEP_DELAY_UNTIL).remove(STEP_WAIT_STARTED_AT).apply();
                }
                return true;
            }
            return true;
        } catch (Exception error) {
            finishCommand("failed", "脚本解析或执行失败：" + error.getMessage());
            return true;
        }
    }

    private boolean runWorkflowScriptV2(AccessibilityNodeInfo root, SharedPreferences prefs, JSONArray steps) throws Exception {
        if (verifyPendingStep(root, prefs)) return true;
        if (!prefs.getBoolean(ACTIVE, false)) return true;
        int index = prefs.getInt(STEP_INDEX, 0);
        if (index >= steps.length()) return true;
        JSONObject step = steps.optJSONObject(index);
        if (step == null) {
            prefs.edit().putInt(STEP_INDEX, index + 1).remove(STEP_STARTED_AT).apply();
            return true;
        }

        if (shouldSkipOptionalV2(root, step)) {
            reportStepEvent("skip", "info", index, step, "跳过可选步骤：" + stepDescription(step), false);
            prefs.edit().putInt(STEP_INDEX, index + 1).remove(STEP_STARTED_AT).apply();
            return true;
        }

        long now = System.currentTimeMillis();
        long startedAt = prefs.getLong(STEP_STARTED_AT, 0L);
        if (startedAt <= 0L) {
            startedAt = now;
            prefs.edit().putLong(STEP_STARTED_AT, startedAt).apply();
            reportStepEvent("start", "info", index, step, "开始步骤：" + stepDescription(step), false);
        }

        long timeoutMs = Math.max(1_000L, step.optLong("timeoutMs", step.optLong("waitTimeoutMs", 15_000L)));
        if (now - startedAt >= timeoutMs) {
            finishCommand("failed", "步骤超时：" + stepDescription(step) + "，超过 " + Math.round(timeoutMs / 1000.0) + " 秒仍未完成");
            return true;
        }

        long delayMs = Math.max(0L, step.optLong("delayMs", 0L));
        if (delayMs > 0L) {
            long delayUntil = prefs.getLong(STEP_DELAY_UNTIL, 0L);
            if (delayUntil <= 0L) {
                delayUntil = now + delayMs;
                prefs.edit().putLong(STEP_DELAY_UNTIL, delayUntil).apply();
            }
            if (now < delayUntil) {
                reportRunning("等待 " + Math.max(1L, (delayUntil - now + 999L) / 1000L) + " 秒后执行：" + stepDescription(step));
                return true;
            }
            prefs.edit().remove(STEP_DELAY_UNTIL).apply();
        }

        if (!executeScriptStep(root, step)) {
            long remainingSeconds = Math.max(1L, (timeoutMs - (now - startedAt) + 999L) / 1000L);
            reportRunning("等待步骤可执行：" + stepDescription(step) + "，剩余 " + remainingSeconds + " 秒");
            return true;
        }
        if (!getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(ACTIVE, false)) return true;

        long postDelayMs = Math.max(0L, step.optLong("postDelayMs", 0L));
        if (postDelayMs > 0L) {
            prefs.edit().putLong(STEP_DELAY_UNTIL, System.currentTimeMillis() + postDelayMs).apply();
        }

        if (hasStepVerification(step)) {
            beginStepVerification(index, step);
        } else if (step.optBoolean("finish", false)) {
            finishCommand("succeeded", "脚本执行完成：" + stepDescription(step));
        } else {
            reportStepEvent("pass", "info", index, step, "步骤完成：" + stepDescription(step), false);
            prefs.edit().putInt(STEP_INDEX, index + 1).remove(STEP_STARTED_AT).remove(STEP_DELAY_UNTIL).apply();
        }
        return true;
    }

    private boolean hasStepVerification(JSONObject step) {
        JSONObject assertSpec = step.optJSONObject("assert");
        return step.has("expectPackage")
            || step.has("expectText")
            || step.has("expectAnyText")
            || step.has("expectGoneText")
            || (assertSpec != null && assertSpec.length() > 0);
    }

    private void beginStepVerification(int index, JSONObject step) {
        JSONObject spec = new JSONObject();
        try {
            spec.put("description", step.optString("description", step.optString("action", "步骤")));
            JSONObject assertSpec = step.optJSONObject("assert");
            spec.put("expectPackage", assertSpec == null ? step.optString("expectPackage", "") : assertSpec.optString("package", step.optString("expectPackage", "")));
            spec.put("expectAnyPackage", assertSpec == null ? null : assertSpec.optJSONArray("anyPackage"));
            spec.put("expectText", assertSpec == null ? step.optString("expectText", "") : assertSpec.optString("text", step.optString("expectText", "")));
            spec.put("expectAnyText", assertSpec == null ? step.optJSONArray("expectAnyText") : assertSpec.optJSONArray("anyText"));
            spec.put("expectGoneText", assertSpec == null ? step.optString("expectGoneText", "") : assertSpec.optString("goneText", step.optString("expectGoneText", "")));
            spec.put("failText", assertSpec == null ? step.optString("failText", "") : assertSpec.optString("failText", step.optString("failText", "")));
            spec.put("failAnyText", assertSpec == null ? step.optJSONArray("failAnyText") : assertSpec.optJSONArray("failAnyText"));
            spec.put("failMessage", assertSpec == null ? step.optString("failMessage", "") : assertSpec.optString("failMessage", step.optString("failMessage", "")));
            spec.put("verifyTimeoutMs", Math.max(1_000L, step.optLong("verifyTimeoutMs", step.optLong("timeoutMs", 8_000L))));
            spec.put("finish", step.optBoolean("finish", false));
        } catch (Exception ignored) {
        }
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putInt(STEP_VERIFY_INDEX, index)
            .putString(STEP_VERIFY_SPEC, spec.toString())
            .putLong(STEP_VERIFY_STARTED_AT, System.currentTimeMillis())
            .apply();
        reportRunning("开始断言：" + step.optString("description", step.optString("action", "步骤")));
    }

    private boolean verifyPendingStep(AccessibilityNodeInfo root, SharedPreferences prefs) throws Exception {
        String rawSpec = prefs.getString(STEP_VERIFY_SPEC, "");
        if (rawSpec == null || rawSpec.isEmpty()) return false;

        long delayUntil = prefs.getLong(STEP_DELAY_UNTIL, 0L);
        if (delayUntil > System.currentTimeMillis()) {
            reportRunning("等待页面稳定后断言，剩余 " + Math.max(1L, (delayUntil - System.currentTimeMillis() + 999L) / 1000L) + " 秒");
            return true;
        }

        JSONObject spec = new JSONObject(rawSpec);
        int index = prefs.getInt(STEP_VERIFY_INDEX, prefs.getInt(STEP_INDEX, 0));
        String description = spec.optString("description", "步骤");
        long startedAt = prefs.getLong(STEP_VERIFY_STARTED_AT, 0L);
        long timeoutMs = Math.max(1_000L, spec.optLong("verifyTimeoutMs", 8_000L));
        String fatal = stepFatalFailure(root, spec);
        if (fatal != null) {
            finishCommand("failed", fatal);
            return true;
        }
        String failure = stepVerificationFailure(root, spec);
        if (failure != null && shouldRetryOpenSelfFromLauncher(root, spec)) {
            if (maybeOpenSelfFromLauncher(root, "重试打开 ZTC 云控")) return true;
        }
        if (failure == null) {
            clearSelfLauncherState();
            prefs.edit()
                .putInt(STEP_INDEX, index + 1)
                .remove(STEP_DELAY_UNTIL)
                .remove(STEP_WAIT_STARTED_AT)
                .remove(STEP_STARTED_AT)
                .remove(STEP_VERIFY_INDEX)
                .remove(STEP_VERIFY_SPEC)
                .remove(STEP_VERIFY_STARTED_AT)
                .apply();
            if (spec.optBoolean("finish", false)) {
                finishCommand("succeeded", "脚本执行完成：" + description);
            } else {
                reportRunning("断言通过：" + description);
            }
            return false;
        }
        if (System.currentTimeMillis() - startedAt >= timeoutMs) {
            finishCommand("failed", "步骤断言失败：" + description + "，" + failure);
            return true;
        }
        long remainingSeconds = Math.max(1L, (timeoutMs - (System.currentTimeMillis() - startedAt) + 999L) / 1000L);
        reportRunning("等待断言通过：" + description + "，剩余 " + remainingSeconds + " 秒，" + failure);
        return true;
    }

    private String stepFatalFailure(AccessibilityNodeInfo root, JSONObject spec) {
        String failMessage = spec.optString("failMessage", "");
        String failText = spec.optString("failText", "");
        if (!failText.isEmpty() && findByText(root, new String[] {failText}) != null) {
            return failMessage.isEmpty() ? "页面出现阻断文本：“" + failText + "”" : failMessage;
        }
        JSONArray failAnyText = spec.optJSONArray("failAnyText");
        if (failAnyText != null && failAnyText.length() > 0) {
            for (int i = 0; i < failAnyText.length(); i++) {
                String text = failAnyText.optString(i, "");
                if (!text.isEmpty() && findByText(root, new String[] {text}) != null) {
                    return failMessage.isEmpty() ? "页面出现阻断文本：“" + text + "”" : failMessage;
                }
            }
        }
        return null;
    }

    private String stepVerificationFailure(AccessibilityNodeInfo root, JSONObject spec) {
        String expectPackage = spec.optString("expectPackage", "");
        if (!expectPackage.isEmpty() && !packageMatches(root, expectPackage)) {
            CharSequence current = root == null ? null : root.getPackageName();
            return "当前包名不是 " + expectPackage + "，实际为 " + (current == null ? "" : current.toString());
        }
        JSONArray expectAnyPackage = spec.optJSONArray("expectAnyPackage");
        if (expectAnyPackage != null && expectAnyPackage.length() > 0 && !packageMatchesAny(root, expectAnyPackage)) {
            CharSequence current = root == null ? null : root.getPackageName();
            return "当前包名不在预期范围 " + expectAnyPackage.toString() + "，实际为 " + (current == null ? "" : current.toString());
        }
        String expectText = spec.optString("expectText", "");
        if (!expectText.isEmpty() && findByText(root, new String[] {expectText}) == null) {
            return "未出现文本/描述：“" + expectText + "”";
        }
        JSONArray expectAnyText = spec.optJSONArray("expectAnyText");
        if (expectAnyText != null && expectAnyText.length() > 0 && !matchesAnyText(root, expectAnyText)) {
            return "未出现任一预期文本/描述：" + expectAnyText.toString();
        }
        String expectGoneText = spec.optString("expectGoneText", "");
        if (!expectGoneText.isEmpty() && findByText(root, new String[] {expectGoneText}) != null) {
            return "文本/描述仍存在：“" + expectGoneText + "”";
        }
        return null;
    }

    private boolean shouldSkipOptional(AccessibilityNodeInfo root, JSONObject step) {
        if (!step.optBoolean("optional", false)) return false;
        String whenPackage = step.optString("whenPackage", "");
        if (!whenPackage.isEmpty() && !packageMatches(root, whenPackage)) return true;
        String whenText = step.optString("whenText", "");
        if (whenText.isEmpty()) return false;
        return findByText(root, new String[] {whenText}) == null;
    }

    private boolean shouldSkipOptionalV2(AccessibilityNodeInfo root, JSONObject step) {
        if (!step.optBoolean("optional", false)) return false;
        JSONObject when = step.optJSONObject("when");
        String whenPackage = when == null ? step.optString("whenPackage", "") : when.optString("package", step.optString("whenPackage", ""));
        if (!whenPackage.isEmpty() && !packageMatches(root, whenPackage)) return true;
        String whenText = when == null ? step.optString("whenText", "") : when.optString("text", step.optString("whenText", ""));
        if (!whenText.isEmpty() && findByText(root, new String[] {whenText}) == null) return true;
        JSONArray anyText = when == null ? step.optJSONArray("whenAnyText") : when.optJSONArray("anyText");
        return anyText != null && anyText.length() > 0 && !matchesAnyText(root, anyText);
    }

    private boolean packageMatches(AccessibilityNodeInfo root, String packageName) {
        if (root == null || packageName == null || packageName.isEmpty()) return false;
        CharSequence current = root.getPackageName();
        return current != null && packageName.contentEquals(current);
    }

    private boolean packageMatchesAny(AccessibilityNodeInfo root, JSONArray packageNames) {
        if (root == null || packageNames == null) return false;
        CharSequence current = root.getPackageName();
        if (current == null) return false;
        for (int i = 0; i < packageNames.length(); i++) {
            String expected = packageNames.optString(i, "");
            if (!expected.isEmpty() && expected.contentEquals(current)) return true;
        }
        return false;
    }

    private boolean shouldOpenSelfDuringLaunch(AccessibilityNodeInfo root, JSONObject spec) {
        if (root == null || spec == null) return false;
        CharSequence current = root.getPackageName();
        if (current == null) return false;
        String packageName = current.toString();
        if (!isLauncherLikePackage(packageName)) return false;
        JSONArray expectAnyPackage = spec.optJSONArray("expectAnyPackage");
        if (expectAnyPackage == null) return false;
        for (int i = 0; i < expectAnyPackage.length(); i++) {
            if ("com.xingin.xhs".equals(expectAnyPackage.optString(i, ""))) return true;
        }
        return false;
    }

    private boolean shouldRetryOpenSelfFromLauncher(AccessibilityNodeInfo root, JSONObject spec) {
        if (shouldOpenSelfDuringLaunch(root, spec)) return true;
        if (root == null || spec == null) return false;
        CharSequence current = root.getPackageName();
        if (current == null || !isLauncherLikePackage(current.toString())) return false;
        return "com.ztqc.smsrelay".equals(spec.optString("expectPackage", ""));
    }

    private boolean isLauncherLikePackage(String packageName) {
        return "com.bbk.launcher2".equals(packageName)
            || "com.miui.home".equals(packageName)
            || "com.miui.personalassistant".equals(packageName)
            || "com.vivo.hiboard".equals(packageName)
            || "com.huawei.android.launcher".equals(packageName)
            || "com.huawei.intelligent".equals(packageName);
    }

    private boolean shouldWaitBeforeStep(SharedPreferences prefs, JSONObject step) {
        long delayMs = step.optLong("delayMs", 0L);
        if (delayMs <= 0L) return false;
        long now = System.currentTimeMillis();
        long until = prefs.getLong(STEP_DELAY_UNTIL, 0L);
        if (until <= 0L) {
            until = now + delayMs;
            prefs.edit().putLong(STEP_DELAY_UNTIL, until).apply();
        }
        if (now < until) {
            reportRunning("等待 " + Math.max(1L, (until - now + 999L) / 1000L) + " 秒后执行：" + step.optString("description", step.optString("action")));
            return true;
        }
        prefs.edit().remove(STEP_DELAY_UNTIL).apply();
        return false;
    }

    private boolean executeScriptStep(AccessibilityNodeInfo root, JSONObject step) {
        String action = step.optString("action", "");
        String description = step.optString("description", action);
        JSONObject selector = step.optJSONObject("selector");
        JSONObject when = step.optJSONObject("when");
        JSONObject params = step.optJSONObject("params");
        if ("launchApp".equals(action)) {
            try {
                JSONObject launchParams = params == null ? new JSONObject() : params;
                if (!launchParams.has("xhsAppSlot")) launchParams.put("xhsAppSlot", launchParams.optString("appSlot", "app1"));
                JSONObject target = DeviceController.launchXhs(this, launchParams);
                reportRunning(description + " · " + target.optString("packageName") + "/" + target.optString("activityName"));
                maybeOpenSelfFromLauncher(root, "打开自家 APK 获取前台启动资格");
                return true;
            } catch (Exception error) {
                finishCommand("failed", "启动应用失败：" + error.getMessage());
                return true;
            }
        }
        if ("openSelfFromLauncher".equals(action)) {
            return executeOpenSelfFromLauncherStep(root, description);
        }
        if ("forceStopApp".equals(action)) {
            String packageName = params == null ? step.optString("packageName", "com.xingin.xhs") : params.optString("packageName", step.optString("packageName", "com.xingin.xhs"));
            DeviceController.killPackage(this, packageName);
            reportRunning(description + " · " + packageName);
            return true;
        }
        if ("home".equals(action)) {
            goHome(description);
            reportRunning(description);
            return true;
        }
        if ("back".equals(action)) {
            DeviceController.back(this);
            reportRunning(description);
            return true;
        }
        if ("sleep".equals(action)) {
            long delayMs = Math.max(500L, step.optLong("timeoutMs", params == null ? 1_000L : params.optLong("durationMs", 1_000L)));
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putLong(STEP_DELAY_UNTIL, System.currentTimeMillis() + delayMs).apply();
            reportRunning(description);
            return true;
        }
        if ("tap".equals(action)) {
            AccessibilityNodeInfo node = findBySelector(root, selector, step);
            if (node == null) return false;
            if (selector != null && selector.optBoolean("center", false)) tapNodeCenter(node, description);
            else clickNode(node, description);
            return true;
        }
        if ("wait".equals(action) || "assert".equals(action)) {
            JSONObject assertSpec = step.optJSONObject("assert");
            if (assertSpec == null) assertSpec = selector;
            if (assertSpec == null) return false;
            JSONObject spec = new JSONObject();
            try {
                spec.put("expectPackage", assertSpec.optString("package", ""));
                spec.put("expectText", assertSpec.optString("text", ""));
                spec.put("expectAnyText", assertSpec.optJSONArray("anyText"));
                spec.put("expectGoneText", assertSpec.optString("goneText", ""));
            } catch (Exception ignored) {
            }
            return stepVerificationFailure(root, spec) == null;
        }
        if ("tapExactText".equals(action)) {
            String whenText = when == null ? step.optString("whenText", "") : when.optString("text", step.optString("whenText", ""));
            if (!whenText.isEmpty() && findByText(root, new String[] {whenText}) == null) return false;
            AccessibilityNodeInfo node = findExactByText(root, selector == null ? step.optString("text", "") : selector.optString("text", step.optString("text", "")));
            if (node == null) return false;
            clickNode(node, description);
            return true;
        }
        if ("tapLauncherIcon".equals(action)) {
            String whenPackage = when == null ? step.optString("whenPackage", "") : when.optString("package", step.optString("whenPackage", ""));
            if (!whenPackage.isEmpty() && !packageMatches(root, whenPackage)) return false;
            String text = selector == null ? step.optString("text", "") : selector.optString("text", step.optString("text", ""));
            int indexFromRight = selector == null ? step.optInt("indexFromRight", 0) : selector.optInt("indexFromRight", step.optInt("indexFromRight", 0));
            AccessibilityNodeInfo node = findExactByText(root, text, indexFromRight);
            if (node == null) return false;
            clickNode(node, description);
            return true;
        }
        if ("tapText".equals(action)) {
            AccessibilityNodeInfo node = findByText(root, new String[] {step.optString("text", "")});
            if (node == null) return false;
            clickNode(node, description);
            return true;
        }
        if ("tapTextCenter".equals(action)) {
            AccessibilityNodeInfo node = findByText(root, new String[] {step.optString("text", "")});
            if (node == null) return false;
            tapNodeCenter(node, description);
            return true;
        }
        if ("waitTapTextCenter".equals(action)) {
            return waitTapTextCenter(root, step);
        }
        if ("tapMiuiXspaceApp".equals(action)) {
            if (!packageMatches(root, "com.miui.securitycore")) return false;
            String whenText = step.optString("whenText", "");
            if (!whenText.isEmpty() && findByText(root, new String[] {whenText}) == null) return false;
            String appSlot = step.optString("appSlot", "app1");
            AccessibilityNodeInfo node = findByViewId(root, "com.miui.securitycore:id/" + ("app2".equals(appSlot) ? "app2" : "app1"));
            if (node == null) return false;
            clickNode(node, description);
            return true;
        }
        if ("tapByResourceId".equals(action)) {
            String whenPackage = when == null ? step.optString("whenPackage", "") : when.optString("package", step.optString("whenPackage", ""));
            if (!whenPackage.isEmpty() && !packageMatches(root, whenPackage)) return false;
            String whenText = when == null ? step.optString("whenText", "") : when.optString("text", step.optString("whenText", ""));
            if (!whenText.isEmpty() && findByText(root, new String[] {whenText}) == null) return false;
            AccessibilityNodeInfo node = findByViewId(root, selector == null ? step.optString("resourceId", "") : selector.optString("resourceId", step.optString("resourceId", "")));
            if (node == null) return false;
            clickNode(node, description);
            return true;
        }
        if ("tapBottomTextCenter".equals(action)) {
            JSONArray anyText = when == null ? step.optJSONArray("whenAnyText") : when.optJSONArray("anyText");
            if (!matchesAnyText(root, anyText)) return false;
            AccessibilityNodeInfo node = findBottomText(root, selector == null ? step.optString("text", "") : selector.optString("text", step.optString("text", "")));
            if (node == null) return false;
            tapNodeCenter(node, description);
            return true;
        }
        if ("tapTopRightIcon".equals(action)) {
            JSONArray anyText = when == null ? step.optJSONArray("whenAnyText") : when.optJSONArray("anyText");
            if (!matchesAnyText(root, anyText)) return false;
            JSONArray texts = selector == null ? step.optJSONArray("texts") : selector.optJSONArray("texts");
            int indexFromRight = selector == null ? step.optInt("indexFromRight", 1) : selector.optInt("indexFromRight", step.optInt("indexFromRight", 1));
            AccessibilityNodeInfo node = findTopRightIcon(root, texts, Math.max(1, indexFromRight));
            if (node == null) return false;
            tapNodeCenter(node, description);
            return true;
        }
        if ("tapPointWhenText".equals(action)) {
            if (!matchesAnyText(root, step.optJSONArray("whenAnyText"))) return false;
            tap(step.optInt("x"), step.optInt("y"), description);
            return true;
        }
        if ("tapFirstGalleryImage".equals(action)) {
            if (!isGalleryPicker(root)) return false;
            AccessibilityNodeInfo firstImage = findFirstGalleryImage(root);
            if (firstImage != null) {
                clickNode(firstImage, description);
            } else {
                tap(89, 269, description + "（兜底）");
            }
            return true;
        }
        if ("waitText".equals(action)) {
            return findByText(root, new String[] {step.optString("text", "")}) != null;
        }
        return false;
    }

    private boolean executeOpenSelfFromLauncherStep(AccessibilityNodeInfo root, String description) {
        String packageName = "";
        if (root != null && root.getPackageName() != null) packageName = root.getPackageName().toString();

        if ("com.ztqc.smsrelay".equals(packageName)) {
            reportRunning(description + " · ZTC 云控已在前台");
            clearSelfLauncherState();
            return true;
        }

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        long tappedAt = prefs.getLong(SELF_LAUNCHER_TAPPED_AT, 0L);
        if (tappedAt > 0L && System.currentTimeMillis() - tappedAt < 3_500L) {
            reportRunning(description + " · 已点击 ZTC 云控，等待前台切换");
            return true;
        }

        if (isLauncherLikePackage(packageName)) {
            return maybeOpenSelfFromLauncher(root, description) && prefs.getLong(SELF_LAUNCHER_TAPPED_AT, 0L) > 0L;
        }

        if (prefs.getBoolean(SELF_LAUNCHER_HOME_SENT, false)) {
            reportRunning(description + " · 等待回到桌面查找 ZTC 云控");
            return false;
        }
        prefs.edit().putBoolean(SELF_LAUNCHER_HOME_SENT, true).apply();
        goHome(description);
        reportRunning(description + " · 当前在 " + (packageName.isEmpty() ? "未知页面" : packageName) + "，先回桌面查找 ZTC 云控");
        return false;
    }

    private void goHome(String action) {
        boolean handled = performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME);
        if (!handled) DeviceController.goHome(this);
        lastActionAt = System.currentTimeMillis();
        reportRunning(action + " · HOME");
    }

    private boolean waitTapTextCenter(AccessibilityNodeInfo root, JSONObject step) {
        String text = step.optString("text", "");
        String description = step.optString("description", "等待并点击：" + text);
        AccessibilityNodeInfo node = findByText(root, new String[] {text});
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (node != null) {
            prefs.edit().remove(STEP_WAIT_STARTED_AT).apply();
            tapNodeCenter(node, description);
            return true;
        }

        long now = System.currentTimeMillis();
        long startedAt = prefs.getLong(STEP_WAIT_STARTED_AT, 0L);
        long timeoutMs = Math.max(1_000L, step.optLong("waitTimeoutMs", 30_000L));
        if (startedAt <= 0L) {
            startedAt = now;
            prefs.edit().putLong(STEP_WAIT_STARTED_AT, startedAt).apply();
        }
        long elapsedMs = now - startedAt;
        if (elapsedMs >= timeoutMs) {
            finishCommand("failed", "等待“" + text + "”超时 " + Math.round(timeoutMs / 1000.0) + " 秒，未出现可点击元素：" + description);
            return false;
        }
        long remainingSeconds = Math.max(1L, (timeoutMs - elapsedMs + 999L) / 1000L);
        reportRunning("等待“" + text + "”出现，剩余 " + remainingSeconds + " 秒");
        return false;
    }

    private boolean verifyPendingFinish(AccessibilityNodeInfo root, SharedPreferences prefs) {
        String text = prefs.getString(VERIFY_FINISH_TEXT, "");
        if (text == null || text.isEmpty()) return false;

        String message = prefs.getString(VERIFY_FINISH_MESSAGE, "脚本执行完成");
        long startedAt = prefs.getLong(VERIFY_FINISH_STARTED_AT, 0L);
        boolean stillOnConfirm = findByText(root, new String[] {text}) != null;
        if (!stillOnConfirm) {
            finishCommand("succeeded", message + "，页面已离开“" + text + "”");
            return true;
        }
        if (System.currentTimeMillis() - startedAt >= FINISH_VERIFY_TIMEOUT_MS) {
            finishCommand("failed", message + "，但页面仍停留在“" + text + "”");
            return true;
        }
        reportRunning(message + "，等待页面离开“" + text + "”");
        return true;
    }

    private void beginFinishVerification(JSONObject step) {
        String text = step.optString("verifyGoneText", step.optString("text", ""));
        String message = "脚本执行完成：" + step.optString("description", step.optString("action"));
        if (text == null || text.isEmpty()) {
            finishCommand("succeeded", message);
            return;
        }
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putString(VERIFY_FINISH_TEXT, text)
            .putString(VERIFY_FINISH_MESSAGE, message)
            .putLong(VERIFY_FINISH_STARTED_AT, System.currentTimeMillis())
            .apply();
        reportRunning(message + "，开始校验页面变化");
    }

    private boolean matchesAnyText(AccessibilityNodeInfo root, JSONArray texts) {
        if (texts == null || texts.length() == 0) return true;
        for (int i = 0; i < texts.length(); i++) {
            String text = texts.optString(i, "");
            if (!text.isEmpty() && findByText(root, new String[] {text}) != null) return true;
        }
        return false;
    }

    private boolean isXhsProfilePage(AccessibilityNodeInfo root) {
        return findByText(root, new String[] {"编辑主页", "小红书号"}) != null;
    }

    private boolean isGalleryPicker(AccessibilityNodeInfo root) {
        if (findByText(root, new String[] {"全部"}) == null) return false;
        return findRecyclerView(root) != null;
    }

    private AccessibilityNodeInfo findBySelector(AccessibilityNodeInfo root, JSONObject selector, JSONObject step) {
        if (root == null) return null;
        if (selector != null) {
            String resourceId = selector.optString("resourceId", "");
            if (!resourceId.isEmpty()) {
                AccessibilityNodeInfo byId = findByViewId(root, resourceId);
                if (byId != null) return byId;
            }
            String contentDesc = selector.optString("contentDesc", "");
            if (!contentDesc.isEmpty()) {
                AccessibilityNodeInfo byDescription = findByContentDescription(root, contentDesc);
                if (byDescription != null) return byDescription;
            }
            String text = selector.optString("text", "");
            if (!text.isEmpty()) return findByText(root, new String[] {text});
        }
        String text = step == null ? "" : step.optString("text", "");
        if (!text.isEmpty()) return findByText(root, new String[] {text});
        return null;
    }

    private AccessibilityNodeInfo findFirstGalleryImage(AccessibilityNodeInfo root) {
        List<AccessibilityNodeInfo> images = new ArrayList<>();
        collectClickableImages(root, images);
        AccessibilityNodeInfo best = null;
        Rect bestRect = new Rect();
        for (AccessibilityNodeInfo image : images) {
            Rect rect = new Rect();
            image.getBoundsInScreen(rect);
            if (rect.top < 150 || rect.width() < 80 || rect.height() < 80) continue;
            if (best == null || rect.top < bestRect.top || (rect.top == bestRect.top && rect.left < bestRect.left)) {
                best = image;
                bestRect.set(rect);
            }
        }
        return best;
    }

    private void rememberUiSnapshot(AccessibilityNodeInfo root) {
        SharedPreferences.Editor editor = getSharedPreferences(PREFS, MODE_PRIVATE).edit();
        CharSequence packageName = root.getPackageName();
        editor.putString(LAST_PACKAGE, packageName == null ? "" : packageName.toString());
        List<String> texts = new ArrayList<>();
        collectVisibleTexts(root, texts);
        editor.putString(LAST_UI_SNAPSHOT, joinTexts(texts, 3000));
        editor.apply();
    }

    private void collectVisibleTexts(AccessibilityNodeInfo node, List<String> out) {
        if (node == null || out.size() >= 80) return;
        if (node.isVisibleToUser()) {
            addText(out, node.getText());
            addText(out, node.getContentDescription());
        }
        for (int i = 0; i < node.getChildCount() && out.size() < 80; i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) collectVisibleTexts(child, out);
        }
    }

    private void addText(List<String> out, CharSequence value) {
        if (value == null) return;
        String text = value.toString().trim();
        if (text.isEmpty()) return;
        if (!out.contains(text)) out.add(text);
    }

    private String joinTexts(List<String> texts, int maxLength) {
        StringBuilder builder = new StringBuilder();
        for (String text : texts) {
            if (builder.length() > 0) builder.append(" | ");
            builder.append(text);
            if (builder.length() >= maxLength) {
                builder.setLength(maxLength);
                builder.append("...");
                break;
            }
        }
        return builder.toString();
    }

    private AccessibilityNodeInfo findBottomText(AccessibilityNodeInfo root, String text) {
        if (text == null || text.isEmpty()) return null;
        List<AccessibilityNodeInfo> nodes = root.findAccessibilityNodeInfosByText(text);
        AccessibilityNodeInfo best = null;
        Rect bestRect = new Rect();
        for (AccessibilityNodeInfo node : nodes) {
            if (node == null || !node.isVisibleToUser()) continue;
            CharSequence nodeText = node.getText();
            CharSequence description = node.getContentDescription();
            boolean exactText = nodeText != null && text.contentEquals(nodeText);
            boolean exactDescription = description != null && text.contentEquals(description);
            if (!exactText && !exactDescription) continue;
            Rect rect = new Rect();
            node.getBoundsInScreen(rect);
            if (best == null || rect.centerY() > bestRect.centerY()) {
                best = node;
                bestRect.set(rect);
            }
        }
        return best;
    }

    private AccessibilityNodeInfo findTopRightIcon(AccessibilityNodeInfo root, JSONArray texts, int indexFromRight) {
        if (texts != null) {
            for (int i = 0; i < texts.length(); i++) {
                String text = texts.optString(i, "");
                if (text.isEmpty()) continue;
                AccessibilityNodeInfo node = findByText(root, new String[] {text});
                if (node != null) return node;
            }
        }

        Rect rootRect = new Rect();
        root.getBoundsInScreen(rootRect);
        List<AccessibilityNodeInfo> candidates = new ArrayList<>();
        collectTopRightClickables(root, rootRect, candidates);
        candidates.sort((left, right) -> {
            Rect leftRect = new Rect();
            Rect rightRect = new Rect();
            left.getBoundsInScreen(leftRect);
            right.getBoundsInScreen(rightRect);
            return Integer.compare(rightRect.centerX(), leftRect.centerX());
        });
        if (candidates.isEmpty()) return null;
        return candidates.get(Math.min(indexFromRight - 1, candidates.size() - 1));
    }

    private void collectTopRightClickables(AccessibilityNodeInfo node, Rect rootRect, List<AccessibilityNodeInfo> out) {
        if (node == null) return;
        Rect rect = new Rect();
        node.getBoundsInScreen(rect);
        int rootWidth = Math.max(1, rootRect.width());
        int rootHeight = Math.max(1, rootRect.height());
        int width = rect.width();
        int height = rect.height();
        boolean inTopRight = rect.centerX() >= rootRect.left + rootWidth * 0.45
            && rect.centerY() <= rootRect.top + rootHeight * 0.18;
        boolean iconSized = width >= 24 && height >= 24 && width <= rootWidth * 0.22 && height <= rootHeight * 0.12;
        if (node.isVisibleToUser() && node.isClickable() && inTopRight && iconSized) {
            out.add(node);
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) collectTopRightClickables(child, rootRect, out);
        }
    }

    private void collectClickableImages(AccessibilityNodeInfo node, List<AccessibilityNodeInfo> out) {
        if (node == null) return;
        CharSequence className = node.getClassName();
        if (node.isClickable() && className != null && className.toString().contains("ImageView")) {
            out.add(node);
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) collectClickableImages(child, out);
        }
    }

    private AccessibilityNodeInfo findRecyclerView(AccessibilityNodeInfo node) {
        if (node == null) return null;
        CharSequence className = node.getClassName();
        if (className != null && className.toString().contains("RecyclerView")) return node;
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo found = findRecyclerView(node.getChild(i));
            if (found != null) return found;
        }
        return null;
    }

    private AccessibilityNodeInfo findByText(AccessibilityNodeInfo root, String[] texts) {
        for (String text : texts) {
            AccessibilityNodeInfo byDescription = findByContentDescription(root, text);
            if (byDescription != null) return byDescription;
            List<AccessibilityNodeInfo> nodes = root.findAccessibilityNodeInfosByText(text);
            for (AccessibilityNodeInfo node : nodes) {
                if (node != null && node.isVisibleToUser()) return node;
            }
        }
        return null;
    }

    private AccessibilityNodeInfo findByViewId(AccessibilityNodeInfo root, String viewId) {
        if (root == null || viewId == null || viewId.isEmpty()) return null;
        try {
            List<AccessibilityNodeInfo> nodes = root.findAccessibilityNodeInfosByViewId(viewId);
            for (AccessibilityNodeInfo node : nodes) {
                if (node != null && node.isVisibleToUser()) return node;
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private AccessibilityNodeInfo findByContentDescription(AccessibilityNodeInfo node, String text) {
        if (node == null) return null;
        CharSequence description = node.getContentDescription();
        if (description != null && description.toString().contains(text) && node.isVisibleToUser()) return node;
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo found = findByContentDescription(node.getChild(i), text);
            if (found != null) return found;
        }
        return null;
    }

    private AccessibilityNodeInfo findExactByText(AccessibilityNodeInfo root, String text) {
        return findExactByText(root, text, 0);
    }

    private AccessibilityNodeInfo findExactByText(AccessibilityNodeInfo root, String text, int indexFromRight) {
        List<AccessibilityNodeInfo> nodes = root.findAccessibilityNodeInfosByText(text);
        List<AccessibilityNodeInfo> exactNodes = new ArrayList<>();
        for (AccessibilityNodeInfo node : nodes) {
            if (node == null || !node.isVisibleToUser()) continue;
            CharSequence nodeText = node.getText();
            if (nodeText != null && text.contentEquals(nodeText)) exactNodes.add(node);
        }
        if (exactNodes.isEmpty()) return null;
        if (indexFromRight <= 0) return exactNodes.get(0);
        exactNodes.sort((left, right) -> {
            Rect leftRect = new Rect();
            Rect rightRect = new Rect();
            left.getBoundsInScreen(leftRect);
            right.getBoundsInScreen(rightRect);
            return Integer.compare(rightRect.centerX(), leftRect.centerX());
        });
        return exactNodes.get(Math.min(indexFromRight - 1, exactNodes.size() - 1));
    }

    private void clickNode(AccessibilityNodeInfo node, String action) {
        AccessibilityNodeInfo clickable = node;
        while (clickable != null && !clickable.isClickable()) clickable = clickable.getParent();
        if (clickable != null && clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
            lastActionAt = System.currentTimeMillis();
            reportRunning(action);
            return;
        }
        Rect rect = new Rect();
        node.getBoundsInScreen(rect);
        tap(rect.centerX(), rect.centerY(), action);
    }

    private void tapNodeCenter(AccessibilityNodeInfo node, String action) {
        AccessibilityNodeInfo target = node;
        while (target != null) {
            Rect rect = new Rect();
            target.getBoundsInScreen(rect);
            if (target.isClickable() || (rect.width() >= 80 && rect.height() >= 40)) {
                if (target.isClickable() && target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                    lastActionAt = System.currentTimeMillis();
                    reportRunning(action + " · ACTION_CLICK");
                    return;
                }
                tap(rect.centerX(), rect.centerY(), action + " · 元素中心");
                return;
            }
            AccessibilityNodeInfo parent = target.getParent();
            if (target != node) target.recycle();
            target = parent;
        }
        Rect rect = new Rect();
        node.getBoundsInScreen(rect);
        tap(rect.centerX(), rect.centerY(), action + " · 文本中心");
    }

    private void tap(int x, int y, String action) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return;
        Path path = new Path();
        path.moveTo(x, y);
        path.lineTo(x + 1, y + 1);
        GestureDescription gesture = new GestureDescription.Builder()
            .addStroke(new GestureDescription.StrokeDescription(path, 0, 180))
            .build();
        dispatchGesture(gesture, null, null);
        lastActionAt = System.currentTimeMillis();
        reportRunning(action + " (" + x + "," + y + ")");
    }

    private boolean swipeUnlockScreen() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false;
        android.util.DisplayMetrics metrics = getResources().getDisplayMetrics();
        int width = Math.max(1, metrics.widthPixels);
        int height = Math.max(1, metrics.heightPixels);
        Path path = new Path();
        path.moveTo(width / 2f, height * 0.86f);
        path.lineTo(width / 2f, height * 0.20f);
        GestureDescription gesture = new GestureDescription.Builder()
            .addStroke(new GestureDescription.StrokeDescription(path, 80, 520))
            .build();
        lastActionAt = System.currentTimeMillis();
        return dispatchGesture(gesture, null, null);
    }

    private boolean maybeOpenSelfFromLauncher(AccessibilityNodeInfo root, String action) {
        if (root == null) return false;
        CharSequence current = root.getPackageName();
        if (current == null) return false;
        String packageName = current.toString();
        if (!isLauncherLikePackage(packageName)) return false;

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        if ("com.vivo.hiboard".equals(packageName)
            || "com.miui.personalassistant".equals(packageName)
            || "com.huawei.intelligent".equals(packageName)) {
            if (swipeLauncherPage(true, action + " · 离开负一屏返回桌面")) {
                prefs.edit().putString(SELF_LAUNCHER_SEARCH_PHASE, "forward").apply();
            }
            return true;
        }

        long sinceSwipe = System.currentTimeMillis() - lastSelfLauncherSwipeAt;
        if (lastSelfLauncherSwipeAt > 0L && sinceSwipe < SELF_LAUNCHER_SWIPE_SETTLE_MS) {
            long remaining = Math.max(1L, (SELF_LAUNCHER_SWIPE_SETTLE_MS - sinceSwipe + 999L) / 1000L);
            reportRunning(action + " · 等待桌面滑动停止，剩余 " + remaining + " 秒");
            return true;
        }

        AccessibilityNodeInfo node = findByText(root, new String[] {"ZTC 云控", "验证码中控"});
        if (node != null) {
            forceTapNodeCenter(node, action);
            prefs.edit().putLong(SELF_LAUNCHER_TAPPED_AT, System.currentTimeMillis()).apply();
            return true;
        }

        String phase = prefs.getString(SELF_LAUNCHER_SEARCH_PHASE, "forward");
        if (!"backward".equals(phase)) phase = "forward";
        if ("forward".equals(phase)) {
            int forwardSwipes = prefs.getInt(SELF_LAUNCHER_FORWARD_SWIPES, 0);
            if (forwardSwipes < SELF_LAUNCHER_FORWARD_SCAN_COUNT) {
                if (swipeLauncherPage(true, action + " · 向下一屏查找 ZTC 云控 " + (forwardSwipes + 1) + "/" + SELF_LAUNCHER_FORWARD_SCAN_COUNT)) {
                    prefs.edit().putInt(SELF_LAUNCHER_FORWARD_SWIPES, forwardSwipes + 1).apply();
                }
                return true;
            }
            prefs.edit().putString(SELF_LAUNCHER_SEARCH_PHASE, "backward").apply();
            return true;
        }

        int backwardSwipes = prefs.getInt(SELF_LAUNCHER_BACKWARD_SWIPES, 0);
        if (backwardSwipes < SELF_LAUNCHER_BACKWARD_SCAN_COUNT) {
            if (swipeLauncherPage(false, action + " · 向上一屏查找 ZTC 云控 " + (backwardSwipes + 1) + "/" + SELF_LAUNCHER_BACKWARD_SCAN_COUNT)) {
                prefs.edit().putInt(SELF_LAUNCHER_BACKWARD_SWIPES, backwardSwipes + 1).apply();
            }
            return true;
        }
        finishCommand("failed", "桌面未找到 ZTC 云控图标：已检查当前页、向下一屏 " + SELF_LAUNCHER_FORWARD_SCAN_COUNT + " 次、向上一屏 " + SELF_LAUNCHER_BACKWARD_SCAN_COUNT + " 次，请确认图标未被移入文件夹或隐藏。");
        return true;
    }

    private void clearSelfLauncherState() {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .remove(SELF_LAUNCHER_SEARCH_PHASE)
            .remove(SELF_LAUNCHER_FORWARD_SWIPES)
            .remove(SELF_LAUNCHER_BACKWARD_SWIPES)
            .remove(SELF_LAUNCHER_HOME_SENT)
            .remove(SELF_LAUNCHER_TAPPED_AT)
            .apply();
    }

    private void forceTapNodeCenter(AccessibilityNodeInfo node, String action) {
        if (node == null) return;
        Rect rect = new Rect();
        node.getBoundsInScreen(rect);
        tap(rect.centerX(), rect.centerY(), action + " · 手势点击");
    }

    private boolean swipeLauncherPage(boolean nextPage, String action) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false;
        long now = System.currentTimeMillis();
        if (now - lastSelfLauncherSwipeAt < 1_200L) return false;
        lastSelfLauncherSwipeAt = now;

        android.util.DisplayMetrics metrics = getResources().getDisplayMetrics();
        int width = Math.max(1, metrics.widthPixels);
        int height = Math.max(1, metrics.heightPixels);
        Path path = new Path();
        if (nextPage) {
            path.moveTo(width * 0.82f, height * 0.55f);
            path.lineTo(width * 0.18f, height * 0.55f);
        } else {
            path.moveTo(width * 0.18f, height * 0.55f);
            path.lineTo(width * 0.82f, height * 0.55f);
        }
        GestureDescription gesture = new GestureDescription.Builder()
            .addStroke(new GestureDescription.StrokeDescription(path, 60, 360))
            .build();
        boolean dispatched = dispatchGesture(gesture, null, null);
        if (dispatched) {
            lastActionAt = now;
            reportRunning(action);
        }
        return dispatched;
    }

    private static class LauncherPageInfo {
        final int current;
        final int total;

        LauncherPageInfo(int current, int total) {
            this.current = current;
            this.total = total;
        }
    }

    private LauncherPageInfo findLauncherPageInfo(AccessibilityNodeInfo root) {
        String text = findLauncherPageInfoText(root);
        if (text == null || text.isEmpty()) return null;
        Matcher matcher = Pattern.compile("第\\s*(\\d+)\\s*页\\s*，\\s*共\\s*(\\d+)\\s*页").matcher(text);
        if (!matcher.find()) return null;
        try {
            int current = Integer.parseInt(matcher.group(1));
            int total = Integer.parseInt(matcher.group(2));
            if (current <= 0 || total <= 0) return null;
            return new LauncherPageInfo(current, total);
        } catch (Exception ignored) {
            return null;
        }
    }

    private String findLauncherPageInfoText(AccessibilityNodeInfo node) {
        if (node == null) return "";
        CharSequence text = node.getText();
        if (text != null && text.toString().contains("第") && text.toString().contains("页")) return text.toString();
        CharSequence description = node.getContentDescription();
        if (description != null && description.toString().contains("第") && description.toString().contains("页")) return description.toString();
        for (int i = 0; i < node.getChildCount(); i++) {
            String found = findLauncherPageInfoText(node.getChild(i));
            if (found != null && !found.isEmpty()) return found;
        }
        return "";
    }

    private void reportRunning(String action) {
        String commandId = getSharedPreferences(PREFS, MODE_PRIVATE).getString(COMMAND_ID, "");
        if (commandId == null || commandId.isEmpty()) return;
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        long now = System.currentTimeMillis();
        String previousAction = prefs.getString(LAST_REPORT_ACTION, "");
        long previousAt = prefs.getLong(LAST_REPORT_AT, 0L);
        if (action != null && action.equals(previousAction) && now - previousAt < 1_500L) {
            prefs.edit().putString(LAST_ACTION, action).apply();
            return;
        }
        prefs.edit()
            .putString(LAST_ACTION, action)
            .putString(LAST_REPORT_ACTION, action == null ? "" : action)
            .putLong(LAST_REPORT_AT, now)
            .apply();
        reportStepEvent("running", "info", prefs.getInt(STEP_INDEX, 0), null, action, false);
        new Thread(() -> {
            try {
                JSONObject result = new JSONObject();
                result.put("action", action);
                result.put("stepIndex", getSharedPreferences(PREFS, MODE_PRIVATE).getInt(STEP_INDEX, 0));
                result.put("at", System.currentTimeMillis());
                RelayClient.sendCommandStatus(this, commandId, "running", result);
            } catch (Exception ignored) {
            }
        }).start();
    }

    private String stepDescription(JSONObject step) {
        if (step == null) return "步骤";
        return step.optString("description", step.optString("id", step.optString("action", "步骤")));
    }

    private void reportStepEvent(String phase, String level, int stepIndex, JSONObject step, String message, boolean includeScreenshot) {
        String commandId = getSharedPreferences(PREFS, MODE_PRIVATE).getString(COMMAND_ID, "");
        if (commandId == null || commandId.isEmpty()) return;
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        new Thread(() -> {
            try {
                JSONObject event = new JSONObject();
                event.put("deviceId", DeviceController.deviceId(this));
                event.put("stepIndex", stepIndex);
                event.put("stepId", step == null ? "" : step.optString("id", ""));
                event.put("phase", phase);
                event.put("level", level);
                event.put("message", message == null ? "" : message);
                event.put("packageName", prefs.getString(LAST_PACKAGE, ""));
                event.put("uiSnapshot", prefs.getString(LAST_UI_SNAPSHOT, ""));
                if (includeScreenshot) event.put("screenshot", captureScreenshotDataUrl());
                RelayClient.sendCommandEvent(this, commandId, event);
            } catch (Exception ignored) {
            }
        }).start();
    }

    private void markGallerySelected(String message) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(GALLERY_SELECTED, true).apply();
        reportRunning(message);
    }

    private void finishCommand(String status, String message) {
        String commandId = getSharedPreferences(PREFS, MODE_PRIVATE).getString(COMMAND_ID, "");
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(ACTIVE, false).apply();
        if (commandId == null || commandId.isEmpty()) return;
        reportStepEvent("failed".equals(status) ? "fail" : "finish", "failed".equals(status) ? "error" : "info", getSharedPreferences(PREFS, MODE_PRIVATE).getInt(STEP_INDEX, 0), null, message, "failed".equals(status));
        new Thread(() -> {
            try {
                JSONObject result = new JSONObject();
                result.put("message", message);
                if ("failed".equals(status)) addFailureDiagnostics(result);
                result.put("at", System.currentTimeMillis());
                RelayClient.sendCommandStatus(this, commandId, status, result);
            } catch (Exception ignored) {
            }
        }).start();
    }

    private void addFailureDiagnostics(JSONObject result) throws Exception {
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        result.put("stepIndex", prefs.getInt(STEP_INDEX, 0));
        result.put("lastAction", prefs.getString(LAST_ACTION, ""));
        result.put("currentPackage", prefs.getString(LAST_PACKAGE, ""));
        result.put("uiSnapshot", prefs.getString(LAST_UI_SNAPSHOT, ""));
        result.put("screenshotInTrace", true);
    }

    private JSONObject captureScreenshotDataUrl() throws Exception {
        JSONObject result = new JSONObject();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            result.put("ok", false);
            result.put("reason", "Android 10 及以下不支持无障碍服务直接截图");
            return result;
        }

        CountDownLatch latch = new CountDownLatch(1);
        final String[] dataUrl = new String[] {""};
        final String[] error = new String[] {""};
        takeScreenshot(0, getMainExecutor(), new TakeScreenshotCallback() {
            @Override
            public void onSuccess(ScreenshotResult screenshot) {
                try {
                    Bitmap hardware = Bitmap.wrapHardwareBuffer(screenshot.getHardwareBuffer(), screenshot.getColorSpace());
                    if (hardware == null) {
                        error[0] = "empty screenshot";
                        return;
                    }
                    Bitmap software = hardware.copy(Bitmap.Config.ARGB_8888, false);
                    int width = software.getWidth();
                    int height = software.getHeight();
                    int targetWidth = Math.min(540, width);
                    int targetHeight = Math.max(1, Math.round(height * (targetWidth / (float) width)));
                    Bitmap scaled = targetWidth == width ? software : Bitmap.createScaledBitmap(software, targetWidth, targetHeight, true);
                    ByteArrayOutputStream stream = new ByteArrayOutputStream();
                    scaled.compress(Bitmap.CompressFormat.JPEG, 45, stream);
                    dataUrl[0] = "data:image/jpeg;base64," + Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP);
                    screenshot.getHardwareBuffer().close();
                } catch (Exception captureError) {
                    error[0] = captureError.getMessage();
                } finally {
                    latch.countDown();
                }
            }

            @Override
            public void onFailure(int errorCode) {
                error[0] = "takeScreenshot failed: " + errorCode;
                latch.countDown();
            }
        });

        boolean completed = latch.await(2500, TimeUnit.MILLISECONDS);
        if (!completed) {
            result.put("ok", false);
            result.put("reason", "截图超时");
        } else if (dataUrl[0].isEmpty()) {
            result.put("ok", false);
            result.put("reason", error[0].isEmpty() ? "截图失败" : error[0]);
        } else {
            result.put("ok", true);
            result.put("dataUrl", dataUrl[0]);
        }
        return result;
    }

    @Override
    public void onInterrupt() {
    }
}
