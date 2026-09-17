package com.ztqc.smsrelay;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONObject;

import java.net.URLEncoder;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

public final class DeviceLiveClient {
    private static final String TAG = "DeviceLiveClient";
    private static final long[] RECONNECT_DELAYS_MS = new long[] {2_000L, 5_000L, 10_000L, 30_000L};
    private static final long WATCHDOG_INTERVAL_MS = 30_000L;
    private static final long WATCHDOG_TIMEOUT_MS = 90_000L;
    private static DeviceLiveClient instance;

    private final Context appContext;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final OkHttpClient client = new OkHttpClient.Builder()
        .pingInterval(30, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build();

    private WebSocket webSocket;
    private boolean stopped;
    private boolean connecting;
    private boolean connected;
    private int reconnectAttempt;
    private String activeUrl = "";
    private String activeToken = "";
    private long lastOpenAt;
    private long lastMessageAt;
    private long lastReconnectAt;
    private int watchdogReconnectCount;
    private String lastDisconnectReason = "";
    private String lastFailure = "";
    private String lastReconnectReason = "";
    private final Runnable watchdog = new Runnable() {
        @Override
        public void run() {
            checkWatchdog();
            handler.postDelayed(this, WATCHDOG_INTERVAL_MS);
        }
    };

    private DeviceLiveClient(Context context) {
        this.appContext = context.getApplicationContext();
    }

    public static synchronized void start(Context context) {
        if (instance == null) instance = new DeviceLiveClient(context);
        instance.stopped = false;
        instance.ensureConnected();
    }

    public static synchronized void stop() {
        if (instance == null) return;
        instance.stopped = true;
        instance.handler.removeCallbacksAndMessages(null);
        if (instance.webSocket != null) {
            instance.webSocket.close(1000, "service stopped");
            instance.webSocket = null;
        }
        instance.connected = false;
        instance.connecting = false;
    }

    public static synchronized boolean isConnected() {
        return instance != null && instance.connected;
    }

    public static JSONObject statusJson() {
        JSONObject status = new JSONObject();
        DeviceLiveClient current = instance;
        try {
            long now = System.currentTimeMillis();
            if (current == null) {
                status.put("connected", false);
                status.put("connecting", false);
                status.put("lastDisconnectReason", "not_started");
                return status;
            }
            synchronized (current) {
                status.put("connected", current.connected);
                status.put("connecting", current.connecting);
                status.put("reconnectAttempt", current.reconnectAttempt);
                status.put("watchdogTimeoutMs", WATCHDOG_TIMEOUT_MS);
                status.put("lastOpenAt", current.lastOpenAt);
                status.put("lastMessageAt", current.lastMessageAt);
                status.put("lastReconnectAt", current.lastReconnectAt);
                status.put("msSinceLastMessage", current.lastMessageAt > 0 ? now - current.lastMessageAt : -1);
                status.put("watchdogReconnectCount", current.watchdogReconnectCount);
                status.put("lastDisconnectReason", current.lastDisconnectReason);
                status.put("lastFailure", current.lastFailure);
                status.put("lastReconnectReason", current.lastReconnectReason);
            }
        } catch (Exception ignored) {
        }
        return status;
    }

    private synchronized void ensureConnected() {
        if (stopped) return;
        String url = liveUrl(appContext);
        String token = RelayConfig.token(appContext);
        if (url.isEmpty() || token == null || token.isEmpty()) return;
        if (connected && url.equals(activeUrl) && token.equals(activeToken)) return;
        if (connecting && url.equals(activeUrl) && token.equals(activeToken)) return;
        if (webSocket != null && (!url.equals(activeUrl) || !token.equals(activeToken))) {
            webSocket.close(1000, "config changed");
            webSocket = null;
            connected = false;
            connecting = false;
        }
        connecting = true;
        activeUrl = url;
        activeToken = token;
        Request request = new Request.Builder()
            .url(url)
            .addHeader("Authorization", "Bearer " + token)
            .build();
        webSocket = client.newWebSocket(request, new Listener());
        handler.removeCallbacks(watchdog);
        handler.postDelayed(watchdog, WATCHDOG_INTERVAL_MS);
    }

    private synchronized void scheduleReconnect(String reason) {
        if (stopped) return;
        connected = false;
        connecting = false;
        lastReconnectAt = System.currentTimeMillis();
        lastReconnectReason = reason == null ? "" : reason;
        long delayMs = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
        reconnectAttempt++;
        handler.removeCallbacksAndMessages(null);
        handler.postDelayed(this::ensureConnected, delayMs);
        handler.postDelayed(watchdog, WATCHDOG_INTERVAL_MS);
        RelayForegroundService.requestImmediateCommandPoll(appContext);
        RelayClient.sendHeartbeatAsync(appContext);
    }

    private void onConnected() {
        long now = System.currentTimeMillis();
        synchronized (this) {
            connected = true;
            connecting = false;
            reconnectAttempt = 0;
            lastOpenAt = now;
            lastMessageAt = now;
            lastDisconnectReason = "";
            lastFailure = "";
        }
        RelayClient.sendHeartbeatAsync(appContext);
        RelayForegroundService.requestImmediateCommandPoll(appContext);
    }

    private void onMessage(String raw) {
        synchronized (this) {
            lastMessageAt = System.currentTimeMillis();
        }
        try {
            JSONObject message = new JSONObject(raw == null ? "{}" : raw);
            String type = message.optString("type", "");
            if ("command_available".equals(type)) {
                RelayForegroundService.requestImmediateCommandPoll(appContext);
            } else if ("activation_available".equals(type)) {
                RelayForegroundService.requestImmediateActivationRefresh(appContext);
            } else if ("ping".equals(type)) {
                WebSocket socket;
                synchronized (this) {
                    socket = webSocket;
                }
                if (socket != null) {
                    JSONObject pong = new JSONObject();
                    pong.put("type", "pong");
                    pong.put("clientTime", System.currentTimeMillis());
                    socket.send(pong.toString());
                }
            } else if ("hello".equals(type)) {
                RelayClient.sendHeartbeatAsync(appContext);
                RelayForegroundService.requestImmediateCommandPoll(appContext);
            }
        } catch (Exception error) {
            Log.w(TAG, "ignored live message", error);
        }
    }

    private void checkWatchdog() {
        WebSocket socketToClose = null;
        long now = System.currentTimeMillis();
        synchronized (this) {
            if (stopped || !connected) return;
            long silentMs = lastMessageAt > 0 ? now - lastMessageAt : now - lastOpenAt;
            if (silentMs < WATCHDOG_TIMEOUT_MS) return;
            lastDisconnectReason = "watchdog_timeout";
            lastFailure = "no_live_message_for_" + silentMs + "ms";
            watchdogReconnectCount++;
            connected = false;
            connecting = false;
            socketToClose = webSocket;
            webSocket = null;
        }
        Log.w(TAG, "live watchdog timeout, reconnecting");
        if (socketToClose != null) {
            try {
                socketToClose.close(4000, "watchdog timeout");
            } catch (Exception ignored) {
            }
        }
        scheduleReconnect("watchdog_timeout");
    }

    private static String liveUrl(Context context) {
        try {
            String base = RelayConfig.serverUrl(context);
            if (base == null || base.trim().isEmpty()) return "";
            base = base.trim();
            if (base.startsWith("https://")) base = "wss://" + base.substring("https://".length());
            else if (base.startsWith("http://")) base = "ws://" + base.substring("http://".length());
            else if (!base.startsWith("ws://") && !base.startsWith("wss://")) base = "ws://" + base;
            while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
            String deviceId = RelayConfig.deviceId(context);
            return base + "/api/v1/devices/" + URLEncoder.encode(deviceId == null ? "" : deviceId, "UTF-8") + "/live";
        } catch (Exception error) {
            return "";
        }
    }

    private final class Listener extends WebSocketListener {
        @Override
        public void onOpen(WebSocket webSocket, Response response) {
            onConnected();
        }

        @Override
        public void onMessage(WebSocket webSocket, String text) {
            DeviceLiveClient.this.onMessage(text);
        }

        @Override
        public void onClosed(WebSocket webSocket, int code, String reason) {
            synchronized (DeviceLiveClient.this) {
                lastDisconnectReason = "closed:" + code + ":" + (reason == null ? "" : reason);
            }
            scheduleReconnect("closed");
        }

        @Override
        public void onFailure(WebSocket webSocket, Throwable t, Response response) {
            Log.w(TAG, "live connection failed", t);
            synchronized (DeviceLiveClient.this) {
                lastDisconnectReason = "failure";
                lastFailure = t == null ? "" : String.valueOf(t.getMessage());
            }
            scheduleReconnect("failure");
        }
    }
}
