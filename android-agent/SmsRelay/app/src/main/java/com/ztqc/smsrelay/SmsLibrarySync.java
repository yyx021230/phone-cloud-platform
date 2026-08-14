package com.ztqc.smsrelay;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.provider.Telephony;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.concurrent.atomic.AtomicBoolean;

public final class SmsLibrarySync {
    private static final String PREFS = "sms_library_sync";
    private static final String LAST_SEEN_DATE = "last_seen_date";
    private static final String LAST_FULL_SYNC_AT = "last_full_sync_at";
    private static final String LAST_DEVICE_ID = "last_device_id";
    private static final long FULL_SYNC_INTERVAL_MS = 6L * 60L * 60L * 1000L;
    private static final long INCREMENTAL_LOOKBACK_MS = 60_000L;
    private static final int INCREMENTAL_SYNC_LIMIT = 200;
    private static final int BATCH_SIZE = 50;
    private static final AtomicBoolean running = new AtomicBoolean(false);

    private static final String[] PROJECTION = new String[] {
        "_id",
        "thread_id",
        "address",
        "body",
        "date",
        "date_sent",
        "type",
        "read",
        "seen",
        "status",
        "locked",
        "sub_id"
    };
    private static final String[] BASIC_PROJECTION = new String[] {
        "_id",
        "thread_id",
        "address",
        "body",
        "date",
        "date_sent",
        "type",
        "read",
        "seen",
        "status",
        "locked"
    };

    private SmsLibrarySync() {}

    public static void syncAsync(Context context, boolean forceFull) {
        Context appContext = context.getApplicationContext();
        if (!running.compareAndSet(false, true)) return;
        new Thread(() -> {
            try {
                syncNow(appContext, forceFull);
            } catch (Exception error) {
                SmsRelayDiagnostics.recordSync(appContext, "failed", 0, error.getClass().getSimpleName() + ": " + error.getMessage());
                error.printStackTrace();
            } finally {
                running.set(false);
            }
        }).start();
    }

    public static void syncNow(Context context, boolean forceFull) throws Exception {
        if (context.checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
            SmsRelayDiagnostics.recordSync(context, "read_sms_not_granted", 0, "android.permission.READ_SMS is not granted");
            return;
        }
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long now = System.currentTimeMillis();
        long lastSeenDate = prefs.getLong(LAST_SEEN_DATE, 0L);
        long lastFullSyncAt = prefs.getLong(LAST_FULL_SYNC_AT, 0L);
        String currentDeviceId = RelayConfig.deviceId(context);
        String lastDeviceId = prefs.getString(LAST_DEVICE_ID, "");
        boolean deviceChanged = currentDeviceId != null && !currentDeviceId.equals(lastDeviceId);
        boolean fullSync = forceFull || deviceChanged || lastSeenDate <= 0L || now - lastFullSyncAt >= FULL_SYNC_INTERVAL_MS;
        int limit = fullSync ? Integer.MAX_VALUE : INCREMENTAL_SYNC_LIMIT;
        String selection = null;
        String[] selectionArgs = null;
        if (!fullSync) {
            selection = "date >= ?";
            selectionArgs = new String[] { String.valueOf(Math.max(0L, lastSeenDate - INCREMENTAL_LOOKBACK_MS)) };
        }

        long maxDate = lastSeenDate;
        int scanned = 0;
        JSONArray batch = new JSONArray();
        try (Cursor cursor = query(context, selection, selectionArgs)) {
            if (cursor == null) {
                SmsRelayDiagnostics.recordSync(context, "provider_returned_null", 0, "content://sms returned null cursor");
                return;
            }
            while (cursor.moveToNext() && scanned < limit) {
                JSONObject message = cursorToMessage(context, cursor);
                maxDate = Math.max(maxDate, message.optLong("date", 0L));
                batch.put(message);
                scanned += 1;
                if (batch.length() >= BATCH_SIZE) {
                    RelayClient.sendSmsLibraryBatchBlocking(context, batch, maxDate, fullSync ? "full" : "incremental");
                    batch = new JSONArray();
                }
            }
        }
        if (batch.length() > 0) {
            RelayClient.sendSmsLibraryBatchBlocking(context, batch, maxDate, fullSync ? "full" : "incremental");
        }
        if (maxDate > lastSeenDate || fullSync) {
            prefs.edit()
                .putLong(LAST_SEEN_DATE, Math.max(maxDate, lastSeenDate))
                .putLong(LAST_FULL_SYNC_AT, fullSync ? now : lastFullSyncAt)
                .putString(LAST_DEVICE_ID, currentDeviceId == null ? "" : currentDeviceId)
                .apply();
        }
        SmsRelayDiagnostics.recordSync(context, fullSync ? "full_ok" : "incremental_ok", scanned, "");
    }

    private static Cursor query(Context context, String selection, String[] selectionArgs) {
        Uri uri = Telephony.Sms.CONTENT_URI;
        try {
            return context.getContentResolver().query(
                uri,
                PROJECTION,
                selection,
                selectionArgs,
                "date desc"
            );
        } catch (IllegalArgumentException error) {
            return context.getContentResolver().query(
                uri,
                BASIC_PROJECTION,
                selection,
                selectionArgs,
                "date desc"
            );
        }
    }

    private static JSONObject cursorToMessage(Context context, Cursor cursor) throws Exception {
        long smsId = longValue(cursor, "_id", 0L);
        int subscriptionId = intValue(cursor, "sub_id", Integer.MIN_VALUE);
        int slotIndex = SimInfoReader.slotIndexForSubscription(context, subscriptionId);
        int type = intValue(cursor, "type", 0);
        JSONObject message = new JSONObject();
        message.put("messageKey", "sms:" + smsId);
        message.put("smsId", String.valueOf(smsId));
        message.put("threadId", String.valueOf(longValue(cursor, "thread_id", 0L)));
        message.put("box", boxName(type));
        message.put("type", type);
        message.put("address", stringValue(cursor, "address"));
        message.put("body", stringValue(cursor, "body"));
        message.put("date", longValue(cursor, "date", 0L));
        message.put("messageAt", longValue(cursor, "date", 0L));
        long dateSent = longValue(cursor, "date_sent", 0L);
        if (dateSent > 0L) message.put("dateSent", dateSent);
        message.put("read", intValue(cursor, "read", 0) == 1);
        message.put("seen", intValue(cursor, "seen", 0) == 1);
        message.put("status", String.valueOf(intValue(cursor, "status", 0)));
        message.put("locked", intValue(cursor, "locked", 0) == 1);
        if (subscriptionId != Integer.MIN_VALUE) message.put("subscriptionId", subscriptionId);
        if (slotIndex != Integer.MIN_VALUE) message.put("slotIndex", slotIndex);
        return message;
    }

    private static String boxName(int type) {
        if (type == 1) return "inbox";
        if (type == 2) return "sent";
        if (type == 3) return "draft";
        if (type == 4) return "outbox";
        if (type == 5) return "failed";
        if (type == 6) return "queued";
        return "unknown";
    }

    private static String stringValue(Cursor cursor, String column) {
        int index = cursor.getColumnIndex(column);
        if (index < 0 || cursor.isNull(index)) return "";
        return cursor.getString(index);
    }

    private static long longValue(Cursor cursor, String column, long fallback) {
        int index = cursor.getColumnIndex(column);
        if (index < 0 || cursor.isNull(index)) return fallback;
        return cursor.getLong(index);
    }

    private static int intValue(Cursor cursor, String column, int fallback) {
        int index = cursor.getColumnIndex(column);
        if (index < 0 || cursor.isNull(index)) return fallback;
        return cursor.getInt(index);
    }
}
