package com.ztqc.smsrelay;

import android.content.Context;
import android.content.SharedPreferences;

public final class RelayConfig {
    private static final String PREFS = "sms_relay_prefs";
    private static final String SERVER_URL = "server_url";
    private static final String TOKEN = "token";
    private static final String PHONE_NUMBER = "phone_number";
    private static final String DEVICE_NAME = "device_name";
    private static final String DEVICE_ID = "device_id";

    private RelayConfig() {}

    public static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static String serverUrl(Context context) {
        return prefs(context).getString(SERVER_URL, "http://47.98.127.132:8787");
    }

    public static String token(Context context) {
        String value = prefs(context).getString(TOKEN, "dev-device-token");
        return value == null ? "" : value;
    }

    public static String phoneNumber(Context context) {
        return prefs(context).getString(PHONE_NUMBER, "");
    }

    public static String[] phoneNumbers(Context context) {
        String raw = phoneNumber(context);
        if (raw == null || raw.trim().isEmpty()) return new String[] {};
        return raw.split("[,，、;；\\s]+");
    }

    public static String deviceName(Context context) {
        return prefs(context).getString(DEVICE_NAME, "vivo Y37");
    }

    public static String deviceId(Context context) {
        String saved = prefs(context).getString(DEVICE_ID, "");
        if (saved != null && !saved.trim().isEmpty()) return saved.trim();
        return android.provider.Settings.Secure.getString(context.getContentResolver(), android.provider.Settings.Secure.ANDROID_ID);
    }

    public static void save(Context context, String serverUrl, String token, String phoneNumber, String deviceName) {
        save(context, serverUrl, token, phoneNumber, deviceName, null);
    }

    public static void save(Context context, String serverUrl, String token, String phoneNumber, String deviceName, String deviceId) {
        SharedPreferences prefs = prefs(context);
        SharedPreferences.Editor editor = prefs.edit()
            .putString(SERVER_URL, trimSlash(serverUrl))
            .putString(PHONE_NUMBER, phoneNumber == null ? "" : phoneNumber.trim())
            .putString(DEVICE_NAME, deviceName == null || deviceName.trim().isEmpty() ? deviceName(context) : deviceName.trim());
        String normalizedToken = token == null ? "" : token.trim();
        if (!normalizedToken.isEmpty() && !"dev-device-token".equals(normalizedToken)) {
            editor.putString(TOKEN, normalizedToken);
        }
        String normalizedDeviceId = deviceId == null ? "" : deviceId.trim();
        if (!normalizedDeviceId.isEmpty()) {
            editor.putString(DEVICE_ID, normalizedDeviceId);
        }
        editor.apply();
    }

    private static String trimSlash(String value) {
        if (value == null || value.isEmpty()) return "http://47.98.127.132:8787";
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        return value;
    }
}
