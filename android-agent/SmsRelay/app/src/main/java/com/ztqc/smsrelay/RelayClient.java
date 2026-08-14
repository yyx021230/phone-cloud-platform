package com.ztqc.smsrelay;

import android.content.Context;
import android.os.BatteryManager;
import android.os.Build;

import org.json.JSONObject;
import org.json.JSONArray;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public final class RelayClient {
    private RelayClient() {}

    public static void sendSmsAsync(Context context, String sender, String body, long receivedAtMillis) {
        new Thread(() -> {
            try {
                sendSmsBlocking(context, sender, body, receivedAtMillis);
            } catch (Exception error) {
                error.printStackTrace();
            }
        }).start();
    }

    public static void sendSmsBlocking(Context context, String sender, String body, long receivedAtMillis) throws Exception {
        sendSmsBlocking(context, sender, body, receivedAtMillis, null, null, null);
    }

    public static void sendQueuedSmsBlocking(Context context, SmsQueueStore.PendingSms pending) throws Exception {
        sendSmsBlocking(
            context,
            pending.sender,
            pending.body,
            pending.receivedAtMillis,
            pending.subscriptionId,
            pending.slotIndex,
            pending.eventFingerprint
        );
    }

    public static void sendSmsBlocking(Context context, String sender, String body, long receivedAtMillis, Integer subscriptionId, Integer slotIndex, String eventFingerprint) throws Exception {
        JSONObject payload = basePayload(context);
        payload.put("sender", sender);
        payload.put("body", body);
        payload.put("code", CodeParser.extractCode(body));
        payload.put("platform", CodeParser.detectPlatform(sender, body));
        payload.put("receivedAt", isoTime(receivedAtMillis));
        if (subscriptionId != null) payload.put("subscriptionId", subscriptionId);
        if (slotIndex != null) payload.put("slotIndex", slotIndex);
        if (eventFingerprint != null && !eventFingerprint.isEmpty()) payload.put("eventFingerprint", eventFingerprint);
        post(context, "/api/v1/sms-events", payload);
    }

    public static void sendHeartbeatAsync(Context context) {
        new Thread(() -> {
            try {
                sendHeartbeatBlocking(context);
            } catch (Exception error) {
                error.printStackTrace();
            }
        }).start();
    }

    public static void sendHeartbeatBlocking(Context context) throws Exception {
        post(context, "/api/v1/devices/heartbeat", basePayload(context));
    }

    public static JSONObject fetchNextCommand(Context context) throws Exception {
        String deviceId = RelayConfig.deviceId(context);
        return get(context, "/api/v1/devices/" + urlEncode(deviceId) + "/commands/next");
    }

    public static JSONObject fetchCommand(Context context, String commandId) throws Exception {
        return get(context, "/api/v1/device-commands/" + urlEncode(commandId));
    }

    public static JSONArray fetchActivationWindows(Context context) throws Exception {
        String deviceId = RelayConfig.deviceId(context);
        JSONObject payload = get(context, "/api/v1/devices/" + urlEncode(deviceId) + "/activation-windows");
        JSONArray windows = payload.optJSONArray("windows");
        return windows == null ? new JSONArray() : windows;
    }

    public static void sendCommandStatus(Context context, String commandId, String status, JSONObject result) throws Exception {
        JSONObject payload = new JSONObject();
        payload.put("status", status);
        payload.put("result", result == null ? new JSONObject() : result);
        post(context, "/api/v1/device-commands/" + urlEncode(commandId) + "/status", payload);
    }

    public static void sendCommandEvent(Context context, String commandId, JSONObject event) throws Exception {
        post(context, "/api/v1/device-commands/" + urlEncode(commandId) + "/events", event == null ? new JSONObject() : event);
    }

    public static void sendSmsLibraryBatchBlocking(Context context, JSONArray messages, long lastSeenDate, String source) throws Exception {
        String deviceId = RelayConfig.deviceId(context);
        JSONObject payload = new JSONObject();
        payload.put("source", source == null || source.isEmpty() ? "android-agent" : "android-agent:" + source);
        payload.put("messages", messages == null ? new JSONArray() : messages);
        JSONObject cursor = new JSONObject();
        cursor.put("lastSeenDate", lastSeenDate);
        payload.put("cursor", cursor);
        post(context, "/api/v1/devices/" + urlEncode(deviceId) + "/sms-library/batch", payload);
    }

    private static JSONObject basePayload(Context context) throws Exception {
        JSONObject payload = new JSONObject();
        payload.put("deviceId", RelayConfig.deviceId(context));
        payload.put("deviceName", RelayConfig.deviceName(context));
        payload.put("phoneNumber", RelayConfig.phoneNumber(context));
        JSONArray phones = new JSONArray();
        for (String phone : RelayConfig.phoneNumbers(context)) {
            if (phone != null && !phone.trim().isEmpty()) phones.put(phone.trim());
        }
        payload.put("phoneNumbers", phones);
        payload.put("batteryLevel", batteryLevel(context));
        payload.put("androidVersion", Build.VERSION.RELEASE);
        payload.put("model", Build.MODEL);
        payload.put("appVersion", appVersion(context));
        payload.put("sims", SimInfoReader.activeSims(context));
        payload.put("xhsTargets", XhsAppDiscovery.discoverJson(context));
        payload.put("liveStatus", DeviceLiveClient.statusJson());
        payload.put("smsRelay", SmsRelayDiagnostics.snapshot(context));
        return payload;
    }

    private static String appVersion(Context context) {
        try {
            return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
        } catch (Exception ignored) {
            return "";
        }
    }

    private static int batteryLevel(Context context) {
        BatteryManager manager = (BatteryManager) context.getSystemService(Context.BATTERY_SERVICE);
        if (manager == null) return -1;
        return manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
    }

    private static String isoTime(long timeMillis) {
        return new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", java.util.Locale.US)
            .format(new java.util.Date(timeMillis));
    }

    private static void post(Context context, String path, JSONObject payload) throws Exception {
        URL url = new URL(RelayConfig.serverUrl(context) + path);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(8000);
        connection.setReadTimeout(8000);
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        connection.setRequestProperty("Authorization", "Bearer " + RelayConfig.token(context));
        byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(body.length);
        try (OutputStream stream = connection.getOutputStream()) {
            stream.write(body);
        }
        int code = connection.getResponseCode();
        if (code < 200 || code >= 300) {
            throw new IllegalStateException("relay server returned " + code);
        }
        connection.disconnect();
    }

    private static JSONObject get(Context context, String path) throws Exception {
        URL url = new URL(RelayConfig.serverUrl(context) + path);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(8000);
        connection.setReadTimeout(8000);
        connection.setRequestProperty("Authorization", "Bearer " + RelayConfig.token(context));
        int code = connection.getResponseCode();
        InputStream stream = code >= 200 && code < 300 ? connection.getInputStream() : connection.getErrorStream();
        String body = readAll(stream);
        connection.disconnect();
        if (code < 200 || code >= 300) {
            throw new IllegalStateException("relay server returned " + code);
        }
        return new JSONObject(body);
    }

    private static String readAll(InputStream stream) throws Exception {
        if (stream == null) return "{}";
        StringBuilder builder = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) builder.append(line);
        }
        return builder.toString();
    }

    private static String urlEncode(String value) throws Exception {
        return java.net.URLEncoder.encode(value == null ? "" : value, "UTF-8");
    }
}
