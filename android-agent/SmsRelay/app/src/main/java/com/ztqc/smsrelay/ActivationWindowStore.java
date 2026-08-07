package com.ztqc.smsrelay;

import android.content.Context;
import android.content.SharedPreferences;
import android.provider.Settings;
import android.text.TextUtils;

import org.json.JSONArray;
import org.json.JSONObject;

import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

public final class ActivationWindowStore {
    private static final String PREFS = "activation_windows";
    private static final String KEY_WINDOWS = "windows";
    private static final String KEY_REFRESHED_AT = "refreshed_at";
    private static final long REFRESH_INTERVAL_MS = 4_000;
    private static volatile boolean refreshing = false;
    private static volatile long lastRefreshAttemptAt = 0L;

    private ActivationWindowStore() {}

    public static void refreshAsync(Context context) {
        refreshAsync(context, false);
    }

    public static void refreshNowAsync(Context context) {
        refreshAsync(context, true);
    }

    private static void refreshAsync(Context context, boolean force) {
        long now = System.currentTimeMillis();
        if (refreshing || (!force && now - lastRefreshAttemptAt < REFRESH_INTERVAL_MS)) return;
        lastRefreshAttemptAt = now;
        Context appContext = context.getApplicationContext();
        new Thread(() -> {
            refreshing = true;
            try {
                JSONArray windows = RelayClient.fetchActivationWindows(appContext);
                save(appContext, windows);
            } catch (Exception error) {
                error.printStackTrace();
            } finally {
                refreshing = false;
            }
        }).start();
    }

    public static void save(Context context, JSONArray windows) {
        context.getApplicationContext()
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_WINDOWS, windows == null ? "[]" : windows.toString())
            .putLong(KEY_REFRESHED_AT, System.currentTimeMillis())
            .apply();
        Context appContext = context.getApplicationContext();
        long cutoffMillis = staleNotificationCutoffMillis(appContext);
        if (cutoffMillis > 0) {
            SmsNotificationListenerService.cancelSmsNotificationsBefore(cutoffMillis);
            SmsNotificationListenerService.replaySmsNotificationsSince(cutoffMillis);
        }
    }

    public static List<Window> activeWindows(Context context) {
        ArrayList<Window> result = new ArrayList<>();
        String raw = context.getApplicationContext()
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_WINDOWS, "[]");
        long now = System.currentTimeMillis();
        try {
            JSONArray array = new JSONArray(raw);
            for (int index = 0; index < array.length(); index++) {
                JSONObject item = array.optJSONObject(index);
                if (item == null) continue;
                Window window = Window.fromJson(item);
                if (window.expiresAtMillis > now) result.add(window);
            }
        } catch (Exception ignored) {
        }
        return result;
    }

    public static Match matchNotification(Context context, String sender, String body, long postedAtMillis) {
        if (TextUtils.isEmpty(body)) return null;
        String code = CodeParser.extractCode(body);
        if (TextUtils.isEmpty(code)) return null;
        List<Window> windows = activeWindows(context);
        Window best = null;
        for (Window window : windows) {
            if (postedAtMillis > 0 && postedAtMillis < window.createdAtMillis) continue;
            String platform = TextUtils.isEmpty(window.platform) ? "" : window.platform;
            if (!TextUtils.isEmpty(platform) && !body.contains(platform) && !String.valueOf(sender).contains(platform)) continue;
            if (!looksLikeVerificationForPlatform(platform, sender, body)) continue;
            if (best != null) return null;
            best = window;
        }
        if (best == null) return null;
        String fingerprint = fingerprint(context, best.activationId, sender, body);
        return new Match(best, fingerprint);
    }

    public static boolean isNotificationAccessEnabled(Context context) {
        String value = Settings.Secure.getString(context.getContentResolver(), "enabled_notification_listeners");
        if (TextUtils.isEmpty(value)) return false;
        String fullName = context.getPackageName() + "/" + SmsNotificationListenerService.class.getName();
        String shortName = context.getPackageName() + "/." + SmsNotificationListenerService.class.getSimpleName();
        return value.contains(fullName) || value.contains(shortName);
    }

    public static long refreshedAt(Context context) {
        return context.getApplicationContext()
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getLong(KEY_REFRESHED_AT, 0L);
    }

    public static long staleNotificationCutoffMillis(Context context) {
        long earliest = Long.MAX_VALUE;
        for (Window window : activeWindows(context)) {
            if (window.createdAtMillis > 0 && window.createdAtMillis < earliest) earliest = window.createdAtMillis;
        }
        return earliest == Long.MAX_VALUE ? 0L : Math.max(0L, earliest - 5_000L);
    }

    private static boolean looksLikeVerificationForPlatform(String platform, String sender, String body) {
        String text = String.valueOf(sender) + " " + String.valueOf(body);
        if (!text.contains("验证码") && !text.contains("校验码") && !text.contains("动态码") && !text.toLowerCase(Locale.US).contains("code")) {
            return false;
        }
        if ("小红书".equals(platform)) return text.contains("小红书");
        return true;
    }

    private static String fingerprint(Context context, String activationId, String sender, String body) {
        String deviceId = RelayConfig.deviceId(context);
        String raw = "notification|" + deviceId + "|" + activationId + "|" + sender + "|" + body;
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(raw.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (byte value : bytes) hex.append(String.format("%02x", value));
            return hex.toString();
        } catch (Exception ignored) {
            return String.valueOf(raw.hashCode());
        }
    }

    private static long parseIsoMillis(String value) {
        if (TextUtils.isEmpty(value)) return 0L;
        String[] patterns = new String[] {
            "yyyy-MM-dd'T'HH:mm:ss.SSSX",
            "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
            "yyyy-MM-dd'T'HH:mm:ssX",
            "yyyy-MM-dd'T'HH:mm:ssXXX"
        };
        for (String pattern : patterns) {
            try {
                SimpleDateFormat format = new SimpleDateFormat(pattern, Locale.US);
                format.setTimeZone(TimeZone.getTimeZone("UTC"));
                Date date = format.parse(value);
                if (date != null) return date.getTime();
            } catch (Exception ignored) {
            }
        }
        return 0L;
    }

    public static final class Window {
        public final String activationId;
        public final String phoneNumber;
        public final String platform;
        public final int subscriptionId;
        public final int slotIndex;
        public final long createdAtMillis;
        public final long expiresAtMillis;

        private Window(String activationId, String phoneNumber, String platform, int subscriptionId, int slotIndex, long createdAtMillis, long expiresAtMillis) {
            this.activationId = activationId;
            this.phoneNumber = phoneNumber;
            this.platform = platform;
            this.subscriptionId = subscriptionId;
            this.slotIndex = slotIndex;
            this.createdAtMillis = createdAtMillis;
            this.expiresAtMillis = expiresAtMillis;
        }

        static Window fromJson(JSONObject item) {
            return new Window(
                item.optString("activationId"),
                item.optString("phoneNumber"),
                item.optString("platform"),
                item.has("subscriptionId") ? item.optInt("subscriptionId", Integer.MIN_VALUE) : Integer.MIN_VALUE,
                item.has("slotIndex") ? item.optInt("slotIndex", Integer.MIN_VALUE) : Integer.MIN_VALUE,
                parseIsoMillis(item.optString("createdAt")),
                parseIsoMillis(item.optString("expiresAt"))
            );
        }
    }

    public static final class Match {
        public final Window window;
        public final String eventFingerprint;

        Match(Window window, String eventFingerprint) {
            this.window = window;
            this.eventFingerprint = eventFingerprint;
        }
    }
}
