package com.ztqc.smsrelay;

import android.content.ContentValues;
import android.app.ActivityManager;
import android.app.KeyguardManager;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.PowerManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.text.TextUtils;
import android.util.Base64;

import org.json.JSONObject;

import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public final class DeviceCommandExecutor {
    private static volatile boolean polling = false;
    private static long lastPollAt = 0L;
    private static final String PENDING_LAUNCH_PREFS = "pending_xhs_launch";

    private DeviceCommandExecutor() {}

    public static void pollAsync(Context context) {
        long now = System.currentTimeMillis();
        if (polling || now - lastPollAt < 1_500) return;
        lastPollAt = now;
        Context appContext = context.getApplicationContext();
        new Thread(() -> {
            polling = true;
            try {
                pollOnce(appContext);
            } catch (Exception error) {
                error.printStackTrace();
            } finally {
                polling = false;
            }
        }).start();
    }

    private static void pollOnce(Context context) throws Exception {
        PowerManager.WakeLock wakeLock = acquirePollWakeLock(context);
        try {
            JSONObject payload = RelayClient.fetchNextCommand(context);
            JSONObject command = payload.optJSONObject("command");
            if (command == null) return;

            String commandId = command.optString("commandId");
            String type = command.optString("type");
            JSONObject result = new JSONObject();
            result.put("deviceId", Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ANDROID_ID));
            result.put("startedAt", isoNow());
            RelayClient.sendCommandStatus(context, commandId, "running", result);

            try {
                if ("xhs_qr_from_gallery".equals(type)) {
                    wakeAndDismissKeyguard(context, 18_000L);
                    executeXhsQrFromGallery(context, command);
                } else if ("open_xhs_scan".equals(type)) {
                    JSONObject done = new JSONObject();
                    boolean awake = wakeAndDismissKeyguard(context);
                    boolean swipeRequested = false;
                    if (isKeyguardLocked(context)) {
                        swipeRequested = ScanAccessibilityService.requestUnlockSwipe(context);
                        if (swipeRequested) Thread.sleep(1_500);
                    }
                    boolean keyguardLocked = isKeyguardLocked(context);
                    done.put("message", keyguardLocked ? "设备已亮屏，仍停留在锁屏" : "设备已唤醒并离开锁屏");
                    done.put("wakefulness", awake ? "Awake" : "WakeRequested");
                    done.put("unlockSwipeRequested", swipeRequested);
                    done.put("keyguardLocked", keyguardLocked);
                    done.put("completedAt", isoNow());
                    RelayClient.sendCommandStatus(context, commandId, "succeeded", done);
                    return;
                } else {
                    throw new IllegalArgumentException("unsupported command type: " + type);
                }
            } catch (CommandCancelledException cancelled) {
                JSONObject cancelledResult = new JSONObject();
                cancelledResult.put("message", cancelled.getMessage());
                cancelledResult.put("cancelledAt", isoNow());
                RelayClient.sendCommandStatus(context, commandId, "cancelled", cancelledResult);
            } catch (Exception error) {
                JSONObject failed = new JSONObject();
                failed.put("error", error.getMessage());
                failed.put("failedAt", isoNow());
                RelayClient.sendCommandStatus(context, commandId, "failed", failed);
            }
        } finally {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        }
    }

    private static PowerManager.WakeLock acquirePollWakeLock(Context context) {
        try {
            PowerManager powerManager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            if (powerManager == null) return null;
            PowerManager.WakeLock wakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "SmsRelay:PollCommand"
            );
            wakeLock.acquire(15_000);
            return wakeLock;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static boolean wakeAndDismissKeyguard(Context context) {
        return wakeAndDismissKeyguard(context, 3_000L);
    }

    private static boolean wakeAndDismissKeyguard(Context context, long holdActivityMs) {
        PowerManager powerManager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        PowerManager.WakeLock wakeLock = null;
        try {
            if (powerManager != null) {
                wakeLock = powerManager.newWakeLock(
                    PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                        | PowerManager.ACQUIRE_CAUSES_WAKEUP
                        | PowerManager.ON_AFTER_RELEASE,
                    "SmsRelay:WakeForCommand"
                );
                wakeLock.acquire(5_000);
            }
            Intent intent = new Intent(context, WakeUnlockActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION);
            intent.putExtra("finishDelayMs", Math.max(3_000L, Math.min(25_000L, holdActivityMs)));
            context.startActivity(intent);
            Thread.sleep(2_500);
            if (isKeyguardLocked(context)) {
                boolean swipeRequested = ScanAccessibilityService.requestUnlockSwipe(context);
                if (swipeRequested) Thread.sleep(1_500);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT_WATCH && powerManager != null) {
                return powerManager.isInteractive();
            }
            return true;
        } catch (Exception ignored) {
            // If the OEM blocks wake/dismiss, the command will continue and the accessibility flow can report timeout.
            return false;
        } finally {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        }
    }

    private static boolean isKeyguardLocked(Context context) {
        KeyguardManager keyguard = (KeyguardManager) context.getSystemService(Context.KEYGUARD_SERVICE);
        return keyguard != null && keyguard.isKeyguardLocked();
    }

    private static void executeXhsQrFromGallery(Context context, JSONObject command) throws Exception {
        String commandId = command.optString("commandId");
        JSONObject payload = command.optJSONObject("payload");
        String dataUrl = payload == null ? "" : payload.optString("qrImageDataUrl");
        boolean autoConfirmLogin = payload == null || payload.optBoolean("autoConfirmLogin", true);
        JSONObject workflowScript = payload == null ? null : payload.optJSONObject("workflowScript");
        Uri uri = saveImageToGallery(context, dataUrl);
        JSONObject result = new JSONObject();
        result.put("savedUri", String.valueOf(uri));
        result.put("savedAt", isoNow());
        result.put("autoConfirmLogin", autoConfirmLogin);
        RelayClient.sendCommandStatus(context, commandId, "running", result);
        ensureCommandStillActive(context, commandId);
        ScanAccessibilityService.startFlow(context, commandId, true, autoConfirmLogin, workflowScript);
        if (workflowScript != null && workflowScript.optInt("engineVersion", 1) >= 2) {
            JSONObject engineResult = new JSONObject();
            engineResult.put("message", "已启动自动化引擎，等待脚本执行 launchApp");
            engineResult.put("startedAt", isoNow());
            RelayClient.sendCommandStatus(context, commandId, "running", engineResult);
            return;
        }
        ensureCommandStillActive(context, commandId);
        JSONObject launchTarget = startXhs(context, payload);
        JSONObject launchResult = new JSONObject();
        launchResult.put("message", "已请求重启小红书");
        launchResult.put("xhsLaunchTarget", launchTarget);
        launchResult.put("startedAt", isoNow());
        RelayClient.sendCommandStatus(context, commandId, "running", launchResult);
    }

    private static Uri saveImageToGallery(Context context, String dataUrl) throws Exception {
        if (TextUtils.isEmpty(dataUrl) || !dataUrl.contains(",")) {
            throw new IllegalArgumentException("qr image is empty");
        }
        String base64 = dataUrl.substring(dataUrl.indexOf(',') + 1);
        byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
        Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        if (bitmap == null) throw new IllegalArgumentException("qr image cannot be decoded");

        String name = "IMG_" + new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date()) + ".png";
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, name);
        values.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_DCIM + "/Camera");
            values.put(MediaStore.Images.Media.IS_PENDING, 1);
        }
        Uri uri = context.getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new IllegalStateException("cannot create gallery image");
        try (OutputStream stream = context.getContentResolver().openOutputStream(uri)) {
            if (stream == null) throw new IllegalStateException("cannot write gallery image");
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues done = new ContentValues();
            done.put(MediaStore.Images.Media.IS_PENDING, 0);
            context.getContentResolver().update(uri, done, null, null);
        }
        Intent scan = new Intent(Intent.ACTION_MEDIA_SCANNER_SCAN_FILE, uri);
        context.sendBroadcast(scan);
        return uri;
    }

    private static void ensureCommandStillActive(Context context, String commandId) throws Exception {
        JSONObject payload = RelayClient.fetchCommand(context, commandId);
        JSONObject command = payload.optJSONObject("command");
        String status = command == null ? "" : command.optString("status", "");
        if ("cancelled".equals(status) || "expired".equals(status)) {
            throw new CommandCancelledException("平台已取消或回收任务：" + status);
        }
    }

    static JSONObject startXhs(Context context, JSONObject payload) throws Exception {
        String appSlot = payload == null ? "app1" : payload.optString("xhsAppSlot", "app1");
        JSONObject requestedTarget = payload == null ? null : payload.optJSONObject("xhsLaunchTarget");
        XhsAppDiscovery.Target target = XhsAppDiscovery.resolveTarget(context, requestedTarget, appSlot);
        ActivityManager activityManager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        if (activityManager != null) activityManager.killBackgroundProcesses(target.packageName);

        boolean useLaunchProxy = payload == null || payload.optBoolean("useLaunchProxy", true);
        if (useLaunchProxy && !(context instanceof MainActivity)) {
            savePendingXhsLaunch(context, target.packageName, target.activityName);
            Intent proxy = new Intent(context, MainActivity.class);
            proxy.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            proxy.putExtra("autoLaunchXhs", true);
            proxy.putExtra("packageName", target.packageName);
            proxy.putExtra("activityName", target.activityName);
            context.startActivity(proxy);
        } else {
            startXhsComponent(context, target.packageName, target.activityName);
        }
        return target.toJson();
    }

    static void savePendingXhsLaunch(Context context, String packageName, String activityName) {
        context.getSharedPreferences(PENDING_LAUNCH_PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString("packageName", packageName)
            .putString("activityName", activityName)
            .putLong("createdAt", System.currentTimeMillis())
            .apply();
    }

    static JSONObject consumePendingXhsLaunch(Context context) {
        android.content.SharedPreferences prefs = context.getSharedPreferences(PENDING_LAUNCH_PREFS, Context.MODE_PRIVATE);
        String packageName = prefs.getString("packageName", "");
        String activityName = prefs.getString("activityName", "");
        long createdAt = prefs.getLong("createdAt", 0L);
        if (packageName == null || packageName.isEmpty() || activityName == null || activityName.isEmpty()) return null;
        prefs.edit().clear().apply();
        if (System.currentTimeMillis() - createdAt > 60_000L) return null;
        JSONObject json = new JSONObject();
        try {
            json.put("packageName", packageName);
            json.put("activityName", activityName);
        } catch (Exception ignored) {
        }
        return json;
    }

    static void startXhsComponent(Context context, String packageName, String activityName) {
        ComponentName component = new ComponentName(packageName, activityName);
        Intent launch = Intent.makeRestartActivityTask(component);
        launch.addCategory(Intent.CATEGORY_LAUNCHER);
        launch.addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION);
        try {
            context.startActivity(launch);
        } catch (ActivityNotFoundException error) {
            throw new IllegalStateException("小红书入口不可启动：" + packageName + "/" + activityName);
        }
    }

    private static String isoNow() {
        return new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US).format(new Date());
    }

    private static final class CommandCancelledException extends Exception {
        CommandCancelledException(String message) {
            super(message);
        }
    }
}
