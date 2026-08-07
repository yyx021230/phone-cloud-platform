package com.ztqc.smsrelay;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;

public final class SmsQueueStore extends SQLiteOpenHelper {
    private static final String DB_NAME = "sms_queue.db";
    private static final int DB_VERSION = 1;
    private static final String TABLE = "pending_sms";
    private final Context appContext;

    public SmsQueueStore(Context context) {
        super(context, DB_NAME, null, DB_VERSION);
        this.appContext = context.getApplicationContext();
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL(
            "create table " + TABLE + " (" +
            "id integer primary key autoincrement," +
            "sender text not null," +
            "body text not null," +
            "received_at_millis integer not null," +
            "subscription_id integer," +
            "slot_index integer," +
            "event_fingerprint text not null unique," +
            "attempt_count integer not null default 0," +
            "last_error text," +
            "created_at_millis integer not null" +
            ")"
        );
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        db.execSQL("drop table if exists " + TABLE);
        onCreate(db);
    }

    public long enqueue(String sender, String body, long receivedAtMillis, int subscriptionId, int slotIndex) {
        String fingerprint = fingerprint(appContext, sender, body, receivedAtMillis, subscriptionId);
        return enqueueWithFingerprint(sender, body, receivedAtMillis, subscriptionId, slotIndex, fingerprint);
    }

    public long enqueueWithFingerprint(String sender, String body, long receivedAtMillis, int subscriptionId, int slotIndex, String fingerprint) {
        ContentValues values = new ContentValues();
        values.put("sender", sender == null ? "" : sender);
        values.put("body", body == null ? "" : body);
        values.put("received_at_millis", receivedAtMillis);
        if (subscriptionId != Integer.MIN_VALUE) values.put("subscription_id", subscriptionId);
        if (slotIndex != Integer.MIN_VALUE) values.put("slot_index", slotIndex);
        values.put("event_fingerprint", fingerprint == null || fingerprint.isEmpty()
            ? fingerprint(appContext, sender, body, receivedAtMillis, subscriptionId)
            : fingerprint);
        values.put("created_at_millis", System.currentTimeMillis());
        return getWritableDatabase().insertWithOnConflict(TABLE, null, values, SQLiteDatabase.CONFLICT_IGNORE);
    }

    public List<PendingSms> listPending(int limit) {
        List<PendingSms> items = new ArrayList<>();
        try (Cursor cursor = getReadableDatabase().query(
            TABLE,
            null,
            null,
            null,
            null,
            null,
            "created_at_millis asc",
            String.valueOf(limit)
        )) {
            while (cursor.moveToNext()) {
                items.add(new PendingSms(
                    cursor.getLong(cursor.getColumnIndexOrThrow("id")),
                    cursor.getString(cursor.getColumnIndexOrThrow("sender")),
                    cursor.getString(cursor.getColumnIndexOrThrow("body")),
                    cursor.getLong(cursor.getColumnIndexOrThrow("received_at_millis")),
                    nullableInt(cursor, "subscription_id"),
                    nullableInt(cursor, "slot_index"),
                    cursor.getString(cursor.getColumnIndexOrThrow("event_fingerprint"))
                ));
            }
        }
        return items;
    }

    public void markSent(long id) {
        getWritableDatabase().delete(TABLE, "id = ?", new String[] { String.valueOf(id) });
    }

    public void markFailed(long id, Exception error) {
        ContentValues values = new ContentValues();
        values.put("attempt_count", attemptCount(id) + 1);
        values.put("last_error", error == null ? "" : String.valueOf(error.getMessage()));
        getWritableDatabase().update(TABLE, values, "id = ?", new String[] { String.valueOf(id) });
    }

    public int countPending() {
        try (Cursor cursor = getReadableDatabase().rawQuery("select count(*) from " + TABLE, null)) {
            return cursor.moveToFirst() ? cursor.getInt(0) : 0;
        }
    }

    private int attemptCount(long id) {
        try (Cursor cursor = getReadableDatabase().query(
            TABLE,
            new String[] { "attempt_count" },
            "id = ?",
            new String[] { String.valueOf(id) },
            null,
            null,
            null
        )) {
            return cursor.moveToFirst() ? cursor.getInt(0) : 0;
        }
    }

    private static Integer nullableInt(Cursor cursor, String column) {
        int index = cursor.getColumnIndexOrThrow(column);
        return cursor.isNull(index) ? null : cursor.getInt(index);
    }

    private static String fingerprint(Context context, String sender, String body, long receivedAtMillis, int subscriptionId) {
        String deviceId = RelayConfig.deviceId(context);
        String raw = deviceId + "|" + subscriptionId + "|" + sender + "|" + body + "|" + receivedAtMillis;
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

    public static final class PendingSms {
        public final long id;
        public final String sender;
        public final String body;
        public final long receivedAtMillis;
        public final Integer subscriptionId;
        public final Integer slotIndex;
        public final String eventFingerprint;

        PendingSms(long id, String sender, String body, long receivedAtMillis, Integer subscriptionId, Integer slotIndex, String eventFingerprint) {
            this.id = id;
            this.sender = sender;
            this.body = body;
            this.receivedAtMillis = receivedAtMillis;
            this.subscriptionId = subscriptionId;
            this.slotIndex = slotIndex;
            this.eventFingerprint = eventFingerprint;
        }
    }
}
