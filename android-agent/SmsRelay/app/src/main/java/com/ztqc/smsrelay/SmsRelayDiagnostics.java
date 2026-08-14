package com.ztqc.smsrelay;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Telephony;

import org.json.JSONObject;

/**
 * Keeps SMS capture health observable on OEM ROMs.  In particular, ColorOS can
 * grant RECEIVE_SMS while separately denying READ_SMS or suspend the relay in
 * the background.  Do not infer success from an installed APK alone.
 */
public final class SmsRelayDiagnostics {
    private static final String PREFS = "sms_relay_diagnostics";
    private static final String LAST_SYNC_STATUS = "last_sync_status";
    private static final String LAST_SYNC_ERROR = "last_sync_error";
    private static final String LAST_SYNC_AT = "last_sync_at";
    private static final String LAST_SYNC_COUNT = "last_sync_count";
    private static final String LAST_RECEIVE_AT = "last_receive_at";
    private static final String LAST_NOTIFICATION_AT = "last_notification_at";

    private SmsRelayDiagnostics() {}

    public static void recordSync(Context context, String status, int count, String error) {
        prefs(context).edit()
            .putString(LAST_SYNC_STATUS, safe(status, 80))
            .putString(LAST_SYNC_ERROR, safe(error, 500))
            .putInt(LAST_SYNC_COUNT, Math.max(0, count))
            .putLong(LAST_SYNC_AT, System.currentTimeMillis())
            .apply();
    }

    public static void recordSmsReceived(Context context) {
        prefs(context).edit().putLong(LAST_RECEIVE_AT, System.currentTimeMillis()).apply();
    }

    public static void recordNotificationFallback(Context context) {
        prefs(context).edit().putLong(LAST_NOTIFICATION_AT, System.currentTimeMillis()).apply();
    }

    public static JSONObject snapshot(Context context) {
        JSONObject value = new JSONObject();
        try {
            boolean receiveSms = hasPermission(context, Manifest.permission.RECEIVE_SMS);
            boolean readSms = hasPermission(context, Manifest.permission.READ_SMS);
            boolean notificationAccess = ActivationWindowStore.isNotificationAccessEnabled(context);
            PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            boolean batteryExempt = power != null && power.isIgnoringBatteryOptimizations(context.getPackageName());
            String manufacturer = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
            String brand = Build.BRAND == null ? "" : Build.BRAND;
            String manufacturerText = (manufacturer + " " + brand).toLowerCase(java.util.Locale.ROOT);
            String defaultSmsPackage = Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT
                ? String.valueOf(Telephony.Sms.getDefaultSmsPackage(context)) : "";
            android.content.SharedPreferences prefs = prefs(context);
            value.put("receiveSmsGranted", receiveSms);
            value.put("readSmsGranted", readSms);
            value.put("notificationAccessGranted", notificationAccess);
            value.put("batteryOptimizationIgnored", batteryExempt);
            value.put("oppoLike", manufacturerText.contains("oppo") || manufacturerText.contains("oneplus") || manufacturerText.contains("realme"));
            value.put("defaultSmsPackage", defaultSmsPackage == null ? "" : defaultSmsPackage);
            value.put("lastSyncStatus", prefs.getString(LAST_SYNC_STATUS, "not_attempted"));
            value.put("lastSyncError", prefs.getString(LAST_SYNC_ERROR, ""));
            value.put("lastSyncAt", prefs.getLong(LAST_SYNC_AT, 0L));
            value.put("lastSyncCount", prefs.getInt(LAST_SYNC_COUNT, 0));
            value.put("lastReceiveAt", prefs.getLong(LAST_RECEIVE_AT, 0L));
            value.put("lastNotificationFallbackAt", prefs.getLong(LAST_NOTIFICATION_AT, 0L));
        } catch (Exception ignored) {
        }
        return value;
    }

    private static boolean hasPermission(Context context, String permission) {
        return context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    private static android.content.SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String safe(String value, int maxLength) {
        if (value == null) return "";
        return value.replace('\n', ' ').replace('\r', ' ').trim().substring(0, Math.min(value.trim().length(), maxLength));
    }
}
