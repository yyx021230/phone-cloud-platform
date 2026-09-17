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
    private static final String LAST_SERVICE_ALIVE_AT = "last_service_alive_at";
    private static final String LAST_SERVICE_START_AT = "last_service_start_at";
    private static final String LAST_SERVICE_START_ERROR = "last_service_start_error";
    private static final String SERVICE_START_FAILURE_COUNT = "service_start_failure_count";

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

    public static void recordServiceAlive(Context context) {
        prefs(context).edit().putLong(LAST_SERVICE_ALIVE_AT, System.currentTimeMillis()).apply();
    }

    public static void recordServiceStartSuccess(Context context) {
        prefs(context).edit()
            .putLong(LAST_SERVICE_START_AT, System.currentTimeMillis())
            .putString(LAST_SERVICE_START_ERROR, "")
            .apply();
    }

    public static void recordServiceStartFailure(Context context, Throwable error) {
        android.content.SharedPreferences values = prefs(context);
        values.edit()
            .putLong(LAST_SERVICE_START_AT, System.currentTimeMillis())
            .putString(LAST_SERVICE_START_ERROR, safe(error == null ? "unknown" : error.getClass().getSimpleName() + ": " + error.getMessage(), 500))
            .putInt(SERVICE_START_FAILURE_COUNT, values.getInt(SERVICE_START_FAILURE_COUNT, 0) + 1)
            .apply();
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
            String defaultSmsPackage = "";
            if (DefaultSmsRole.isDefaultSmsApp(context)) {
                defaultSmsPackage = context.getPackageName();
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
                String telephonyDefault = Telephony.Sms.getDefaultSmsPackage(context);
                defaultSmsPackage = telephonyDefault == null ? "" : telephonyDefault;
            }
            android.content.SharedPreferences prefs = prefs(context);
            boolean defaultSmsApp = DefaultSmsRole.isDefaultSmsApp(context);
            value.put("installed", true);
            value.put("compatibilityProbe", AppMode.isCompatibilityProbe(context));
            value.put("defaultSmsApp", defaultSmsApp);
            value.put("receiveSmsGranted", receiveSms);
            value.put("readSmsGranted", readSms);
            value.put("notificationAccessGranted", notificationAccess);
            value.put("batteryOptimizationIgnored", batteryExempt);
            value.put("oppoLike", manufacturerText.contains("oppo") || manufacturerText.contains("oneplus") || manufacturerText.contains("realme"));
            value.put("manufacturer", manufacturer);
            value.put("model", Build.MODEL == null ? "" : Build.MODEL);
            value.put("sdkInt", Build.VERSION.SDK_INT);
            value.put("primaryAbi", Build.SUPPORTED_ABIS == null || Build.SUPPORTED_ABIS.length == 0 ? "" : Build.SUPPORTED_ABIS[0]);
            value.put("telephonyFeature", context.getPackageManager().hasSystemFeature(PackageManager.FEATURE_TELEPHONY));
            value.put("smsRoleAvailable", DefaultSmsRole.isSmsRoleAvailable(context));
            value.put("foregroundServiceType", "remoteMessaging");
            value.put("defaultSmsPackage", defaultSmsPackage == null ? "" : defaultSmsPackage);
            value.put("previousDefaultSmsPackage", DefaultSmsRole.previousDefaultSmsPackage(context));
            value.put("lastSyncStatus", prefs.getString(LAST_SYNC_STATUS, "not_attempted"));
            value.put("lastSyncError", prefs.getString(LAST_SYNC_ERROR, ""));
            value.put("lastSyncAt", prefs.getLong(LAST_SYNC_AT, 0L));
            value.put("lastSyncCount", prefs.getInt(LAST_SYNC_COUNT, 0));
            value.put("lastReceiveAt", prefs.getLong(LAST_RECEIVE_AT, 0L));
            value.put("lastNotificationFallbackAt", prefs.getLong(LAST_NOTIFICATION_AT, 0L));
            long lastServiceAliveAt = prefs.getLong(LAST_SERVICE_ALIVE_AT, 0L);
            value.put("lastServiceAliveAt", lastServiceAliveAt);
            value.put("serviceAlive", System.currentTimeMillis() - lastServiceAliveAt <= 90_000L);
            value.put("lastServiceStartAt", prefs.getLong(LAST_SERVICE_START_AT, 0L));
            value.put("lastServiceStartError", prefs.getString(LAST_SERVICE_START_ERROR, ""));
            value.put("serviceStartFailureCount", prefs.getInt(SERVICE_START_FAILURE_COUNT, 0));
            SmsQueueStore store = new SmsQueueStore(context);
            try {
                value.put("pendingUploadCount", store.countPending());
                value.put("localMessageCount", store.countLocalMessages());
                value.put("providerWriteFailureCount", store.countProviderFailures());
                value.put("oldestPendingUploadAgeMillis", store.oldestPendingAgeMillis());
                value.put("nextUploadRetryInMillis", store.nextRetryDelayMillis());
            } finally {
                store.close();
            }
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
