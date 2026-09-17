package com.ztqc.smsrelay;

import android.accessibilityservice.AccessibilityService;
import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;

import org.json.JSONObject;

public final class DeviceController {
    private DeviceController() {}

    public static JSONObject launchXhs(Context context, JSONObject params) throws Exception {
        return DeviceCommandExecutor.startXhs(context, params == null ? new JSONObject() : params);
    }

    public static void killPackage(Context context, String packageName) {
        if (packageName == null || packageName.trim().isEmpty()) return;
        ActivityManager activityManager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        if (activityManager != null) activityManager.killBackgroundProcesses(packageName.trim());
    }

    public static void goHome(Context context) {
        Intent intent = new Intent(Intent.ACTION_MAIN);
        intent.addCategory(Intent.CATEGORY_HOME);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);
    }

    public static void back(AccessibilityService service) {
        if (service != null) service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK);
    }

    public static String deviceId(Context context) {
        return RelayConfig.deviceId(context);
    }
}
