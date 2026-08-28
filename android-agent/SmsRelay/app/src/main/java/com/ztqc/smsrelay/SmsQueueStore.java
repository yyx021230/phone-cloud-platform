package com.ztqc.smsrelay;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.net.Uri;

import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ThreadLocalRandom;

/**
 * Durable local SMS store. local_messages is the phone-side source of truth;
 * pending_sms is only an upload outbox. A server ACK removes the outbox row
 * but never removes the local message.
 */
public final class SmsQueueStore extends SQLiteOpenHelper {
    public static final Uri LOCAL_MESSAGES_URI = Uri.parse("content://com.ztqc.smsrelay.health/messages");
    private static final String DB_NAME = "sms_queue.db";
    private static final int DB_VERSION = 2;
    private static final String OUTBOX_TABLE = "pending_sms";
    private static final String MESSAGE_TABLE = "local_messages";
    private static final long MAX_RETRY_DELAY_MS = 5L * 60L * 1000L;
    private final Context appContext;

    public SmsQueueStore(Context context) {
        super(context, DB_NAME, null, DB_VERSION);
        this.appContext = context.getApplicationContext();
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        createOutboxTable(db);
        createMessageTable(db);
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        if (oldVersion < 2) {
            try {
                db.execSQL("alter table " + OUTBOX_TABLE + " add column next_attempt_at_millis integer not null default 0");
            } catch (Exception ignored) {
            }
            createMessageTable(db);
            db.execSQL(
                "insert or ignore into " + MESSAGE_TABLE + " (" +
                    "sender,body,received_at_millis,subscription_id,slot_index,event_fingerprint," +
                    "direction,read_state,provider_state,server_state,created_at_millis,updated_at_millis" +
                ") select sender,body,received_at_millis,subscription_id,slot_index,event_fingerprint," +
                    "'inbox',0,'pending','pending',created_at_millis,created_at_millis from " + OUTBOX_TABLE
            );
        }
    }

    private static void createOutboxTable(SQLiteDatabase db) {
        db.execSQL(
            "create table if not exists " + OUTBOX_TABLE + " (" +
            "id integer primary key autoincrement," +
            "sender text not null," +
            "body text not null," +
            "received_at_millis integer not null," +
            "subscription_id integer," +
            "slot_index integer," +
            "event_fingerprint text not null unique," +
            "attempt_count integer not null default 0," +
            "last_error text," +
            "next_attempt_at_millis integer not null default 0," +
            "created_at_millis integer not null" +
            ")"
        );
        db.execSQL("create index if not exists idx_pending_sms_due on " + OUTBOX_TABLE + " (next_attempt_at_millis, created_at_millis)");
    }

    private static void createMessageTable(SQLiteDatabase db) {
        db.execSQL(
            "create table if not exists " + MESSAGE_TABLE + " (" +
            "id integer primary key autoincrement," +
            "sender text not null," +
            "body text not null," +
            "received_at_millis integer not null," +
            "subscription_id integer," +
            "slot_index integer," +
            "event_fingerprint text not null unique," +
            "direction text not null default 'inbox'," +
            "read_state integer not null default 0," +
            "thread_id integer," +
            "provider_uri text," +
            "provider_state text not null default 'pending'," +
            "provider_error text," +
            "provider_updated_at_millis integer," +
            "server_state text not null default 'pending'," +
            "server_event_id text," +
            "server_acked_at_millis integer," +
            "last_upload_error text," +
            "created_at_millis integer not null," +
            "updated_at_millis integer not null" +
            ")"
        );
        db.execSQL("create index if not exists idx_local_sms_time on " + MESSAGE_TABLE + " (received_at_millis desc)");
        db.execSQL("create index if not exists idx_local_sms_thread on " + MESSAGE_TABLE + " (thread_id, received_at_millis)");
        db.execSQL("create index if not exists idx_local_sms_provider on " + MESSAGE_TABLE + " (provider_state, received_at_millis)");
    }

    public long enqueue(String sender, String body, long receivedAtMillis, int subscriptionId, int slotIndex) {
        return enqueueEvent(sender, body, receivedAtMillis, subscriptionId, slotIndex, null).outboxId;
    }

    public long enqueueWithFingerprint(String sender, String body, long receivedAtMillis, int subscriptionId, int slotIndex, String fingerprint) {
        return enqueueEvent(sender, body, receivedAtMillis, subscriptionId, slotIndex, fingerprint).outboxId;
    }

    public EventRef enqueueEvent(String sender, String body, long receivedAtMillis, int subscriptionId, int slotIndex, String suppliedFingerprint) {
        String eventFingerprint = suppliedFingerprint == null || suppliedFingerprint.isEmpty()
            ? fingerprint(appContext, sender, body, receivedAtMillis, subscriptionId)
            : suppliedFingerprint;
        long now = System.currentTimeMillis();
        SQLiteDatabase db = getWritableDatabase();
        EventRef result;
        db.beginTransaction();
        try {
            ContentValues local = new ContentValues();
            local.put("sender", safe(sender));
            local.put("body", safe(body));
            local.put("received_at_millis", receivedAtMillis);
            putOptionalInt(local, "subscription_id", subscriptionId);
            putOptionalInt(local, "slot_index", slotIndex);
            local.put("event_fingerprint", eventFingerprint);
            local.put("direction", "inbox");
            local.put("read_state", 0);
            local.put("provider_state", "pending");
            local.put("server_state", "pending");
            local.put("created_at_millis", now);
            local.put("updated_at_millis", now);
            db.insertWithOnConflict(MESSAGE_TABLE, null, local, SQLiteDatabase.CONFLICT_IGNORE);

            long localId = localId(db, eventFingerprint);
            String serverState = localServerState(db, eventFingerprint);
            long outboxId = -1L;
            if (!"acked".equals(serverState)) {
                ContentValues outbox = new ContentValues();
                outbox.put("sender", safe(sender));
                outbox.put("body", safe(body));
                outbox.put("received_at_millis", receivedAtMillis);
                putOptionalInt(outbox, "subscription_id", subscriptionId);
                putOptionalInt(outbox, "slot_index", slotIndex);
                outbox.put("event_fingerprint", eventFingerprint);
                outbox.put("created_at_millis", now);
                outbox.put("next_attempt_at_millis", 0L);
                db.insertWithOnConflict(OUTBOX_TABLE, null, outbox, SQLiteDatabase.CONFLICT_IGNORE);
                outboxId = outboxId(db, eventFingerprint);
            }
            db.setTransactionSuccessful();
            result = new EventRef(localId, outboxId, eventFingerprint);
        } finally {
            db.endTransaction();
        }
        notifyLocalChanged();
        return result;
    }

    public List<PendingSms> listPending(int limit) {
        List<PendingSms> items = new ArrayList<>();
        try (Cursor cursor = getReadableDatabase().query(
            OUTBOX_TABLE,
            null,
            "next_attempt_at_millis <= ?",
            new String[] { String.valueOf(System.currentTimeMillis()) },
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

    public void markProviderWritten(String eventFingerprint, String providerUri, long threadId) {
        ContentValues values = new ContentValues();
        values.put("provider_state", "written");
        values.put("provider_uri", safe(providerUri));
        values.putNull("provider_error");
        if (threadId > 0L) values.put("thread_id", threadId);
        values.put("provider_updated_at_millis", System.currentTimeMillis());
        values.put("updated_at_millis", System.currentTimeMillis());
        updateLocal(eventFingerprint, values);
        notifyLocalChanged();
    }

    public void markProviderFailed(String eventFingerprint, String error, long threadId) {
        ContentValues values = new ContentValues();
        values.put("provider_state", "failed");
        values.put("provider_error", truncate(error, 500));
        if (threadId > 0L) values.put("thread_id", threadId);
        values.put("provider_updated_at_millis", System.currentTimeMillis());
        values.put("updated_at_millis", System.currentTimeMillis());
        updateLocal(eventFingerprint, values);
        notifyLocalChanged();
    }

    public void markSent(long id, String serverEventId) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            String eventFingerprint = outboxFingerprint(db, id);
            if (!eventFingerprint.isEmpty()) {
                ContentValues local = new ContentValues();
                local.put("server_state", "acked");
                local.put("server_event_id", safe(serverEventId));
                local.put("server_acked_at_millis", System.currentTimeMillis());
                local.putNull("last_upload_error");
                local.put("updated_at_millis", System.currentTimeMillis());
                db.update(MESSAGE_TABLE, local, "event_fingerprint = ?", new String[] { eventFingerprint });
            }
            db.delete(OUTBOX_TABLE, "id = ?", new String[] { String.valueOf(id) });
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    public void markFailed(long id, Exception error) {
        SQLiteDatabase db = getWritableDatabase();
        int nextAttempt = attemptCount(db, id) + 1;
        long baseDelay = Math.min(MAX_RETRY_DELAY_MS, 2_000L * (1L << Math.min(8, Math.max(0, nextAttempt - 1))));
        long jitter = ThreadLocalRandom.current().nextLong(Math.max(1L, Math.min(2_000L, baseDelay / 4L + 1L)));
        long nextAt = System.currentTimeMillis() + baseDelay + jitter;
        String message = truncate(error == null ? "" : String.valueOf(error.getMessage()), 500);
        ContentValues values = new ContentValues();
        values.put("attempt_count", nextAttempt);
        values.put("last_error", message);
        values.put("next_attempt_at_millis", nextAt);
        db.update(OUTBOX_TABLE, values, "id = ?", new String[] { String.valueOf(id) });

        String eventFingerprint = outboxFingerprint(db, id);
        if (!eventFingerprint.isEmpty()) {
            ContentValues local = new ContentValues();
            local.put("server_state", "retrying");
            local.put("last_upload_error", message);
            local.put("updated_at_millis", System.currentTimeMillis());
            db.update(MESSAGE_TABLE, local, "event_fingerprint = ?", new String[] { eventFingerprint });
        }
    }

    public int countPending() {
        return scalarInt("select count(*) from " + OUTBOX_TABLE, 0);
    }

    public int countLocalMessages() {
        return scalarInt("select count(*) from " + MESSAGE_TABLE, 0);
    }

    public int countProviderFailures() {
        return scalarInt("select count(*) from " + MESSAGE_TABLE + " where provider_state = 'failed'", 0);
    }

    public long oldestPendingAgeMillis() {
        long createdAt = scalarLong("select min(created_at_millis) from " + OUTBOX_TABLE, 0L);
        return createdAt <= 0L ? 0L : Math.max(0L, System.currentTimeMillis() - createdAt);
    }

    public long nextRetryDelayMillis() {
        long nextAt = scalarLong("select min(next_attempt_at_millis) from " + OUTBOX_TABLE, 0L);
        if (nextAt <= 0L) return 0L;
        return Math.max(0L, nextAt - System.currentTimeMillis());
    }

    public List<LocalMessage> listProviderMissingMessages() {
        List<LocalMessage> items = new ArrayList<>();
        try (Cursor cursor = getReadableDatabase().query(
            MESSAGE_TABLE,
            null,
            "provider_state != ?",
            new String[] { "written" },
            null,
            null,
            "received_at_millis asc",
            "2000"
        )) {
            while (cursor.moveToNext()) {
                items.add(new LocalMessage(
                    cursor.getLong(cursor.getColumnIndexOrThrow("id")),
                    cursor.getString(cursor.getColumnIndexOrThrow("sender")),
                    cursor.getString(cursor.getColumnIndexOrThrow("body")),
                    cursor.getLong(cursor.getColumnIndexOrThrow("received_at_millis")),
                    nullableInt(cursor, "subscription_id"),
                    nullableInt(cursor, "slot_index"),
                    nullableLong(cursor, "thread_id"),
                    cursor.getInt(cursor.getColumnIndexOrThrow("read_state")) == 1,
                    cursor.getString(cursor.getColumnIndexOrThrow("event_fingerprint")),
                    cursor.getString(cursor.getColumnIndexOrThrow("provider_state")),
                    cursor.getString(cursor.getColumnIndexOrThrow("server_state"))
                ));
            }
        }
        return items;
    }

    public void markLocalThreadRead(long threadId) {
        ContentValues values = new ContentValues();
        values.put("read_state", 1);
        values.put("updated_at_millis", System.currentTimeMillis());
        getWritableDatabase().update(MESSAGE_TABLE, values, "thread_id = ?", new String[] { String.valueOf(threadId) });
        notifyLocalChanged();
    }

    public int deleteLocalMessage(long localId) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            String fingerprint = localFingerprint(db, localId);
            if (!fingerprint.isEmpty()) db.delete(OUTBOX_TABLE, "event_fingerprint = ?", new String[] { fingerprint });
            int deleted = db.delete(MESSAGE_TABLE, "id = ?", new String[] { String.valueOf(localId) });
            db.setTransactionSuccessful();
            notifyLocalChanged();
            return deleted;
        } finally {
            db.endTransaction();
        }
    }

    public int deleteLocalThread(long threadId) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            db.execSQL("delete from " + OUTBOX_TABLE + " where event_fingerprint in (select event_fingerprint from " + MESSAGE_TABLE + " where thread_id = ?)", new Object[] { threadId });
            int deleted = db.delete(MESSAGE_TABLE, "thread_id = ?", new String[] { String.valueOf(threadId) });
            db.setTransactionSuccessful();
            notifyLocalChanged();
            return deleted;
        } finally {
            db.endTransaction();
        }
    }

    private void updateLocal(String eventFingerprint, ContentValues values) {
        if (eventFingerprint == null || eventFingerprint.isEmpty()) return;
        getWritableDatabase().update(MESSAGE_TABLE, values, "event_fingerprint = ?", new String[] { eventFingerprint });
    }

    private void notifyLocalChanged() {
        try {
            appContext.getContentResolver().notifyChange(LOCAL_MESSAGES_URI, null);
        } catch (Exception ignored) {
        }
    }

    private int scalarInt(String sql, int fallback) {
        try (Cursor cursor = getReadableDatabase().rawQuery(sql, null)) {
            return cursor.moveToFirst() && !cursor.isNull(0) ? cursor.getInt(0) : fallback;
        }
    }

    private long scalarLong(String sql, long fallback) {
        try (Cursor cursor = getReadableDatabase().rawQuery(sql, null)) {
            return cursor.moveToFirst() && !cursor.isNull(0) ? cursor.getLong(0) : fallback;
        }
    }

    private static int attemptCount(SQLiteDatabase db, long id) {
        try (Cursor cursor = db.query(OUTBOX_TABLE, new String[] { "attempt_count" }, "id = ?", new String[] { String.valueOf(id) }, null, null, null)) {
            return cursor.moveToFirst() ? cursor.getInt(0) : 0;
        }
    }

    private static long localId(SQLiteDatabase db, String fingerprint) {
        try (Cursor cursor = db.query(MESSAGE_TABLE, new String[] { "id" }, "event_fingerprint = ?", new String[] { fingerprint }, null, null, null)) {
            return cursor.moveToFirst() ? cursor.getLong(0) : -1L;
        }
    }

    private static long outboxId(SQLiteDatabase db, String fingerprint) {
        try (Cursor cursor = db.query(OUTBOX_TABLE, new String[] { "id" }, "event_fingerprint = ?", new String[] { fingerprint }, null, null, null)) {
            return cursor.moveToFirst() ? cursor.getLong(0) : -1L;
        }
    }

    private static String localServerState(SQLiteDatabase db, String fingerprint) {
        try (Cursor cursor = db.query(MESSAGE_TABLE, new String[] { "server_state" }, "event_fingerprint = ?", new String[] { fingerprint }, null, null, null)) {
            return cursor.moveToFirst() ? safe(cursor.getString(0)) : "";
        }
    }

    private static String outboxFingerprint(SQLiteDatabase db, long id) {
        try (Cursor cursor = db.query(OUTBOX_TABLE, new String[] { "event_fingerprint" }, "id = ?", new String[] { String.valueOf(id) }, null, null, null)) {
            return cursor.moveToFirst() ? safe(cursor.getString(0)) : "";
        }
    }

    private static String localFingerprint(SQLiteDatabase db, long id) {
        try (Cursor cursor = db.query(MESSAGE_TABLE, new String[] { "event_fingerprint" }, "id = ?", new String[] { String.valueOf(id) }, null, null, null)) {
            return cursor.moveToFirst() ? safe(cursor.getString(0)) : "";
        }
    }

    private static Integer nullableInt(Cursor cursor, String column) {
        int index = cursor.getColumnIndexOrThrow(column);
        return cursor.isNull(index) ? null : cursor.getInt(index);
    }

    private static Long nullableLong(Cursor cursor, String column) {
        int index = cursor.getColumnIndexOrThrow(column);
        return cursor.isNull(index) ? null : cursor.getLong(index);
    }

    private static void putOptionalInt(ContentValues values, String key, int value) {
        if (value != Integer.MIN_VALUE) values.put(key, value);
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }

    private static String truncate(String value, int maxLength) {
        String safeValue = safe(value).replace('\n', ' ').replace('\r', ' ').trim();
        return safeValue.substring(0, Math.min(maxLength, safeValue.length()));
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

    public static final class EventRef {
        public final long localId;
        public final long outboxId;
        public final String eventFingerprint;

        EventRef(long localId, long outboxId, String eventFingerprint) {
            this.localId = localId;
            this.outboxId = outboxId;
            this.eventFingerprint = eventFingerprint;
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

    public static final class LocalMessage {
        public final long id;
        public final String sender;
        public final String body;
        public final long receivedAtMillis;
        public final Integer subscriptionId;
        public final Integer slotIndex;
        public final Long threadId;
        public final boolean read;
        public final String eventFingerprint;
        public final String providerState;
        public final String serverState;

        LocalMessage(long id, String sender, String body, long receivedAtMillis, Integer subscriptionId, Integer slotIndex, Long threadId, boolean read, String eventFingerprint, String providerState, String serverState) {
            this.id = id;
            this.sender = sender;
            this.body = body;
            this.receivedAtMillis = receivedAtMillis;
            this.subscriptionId = subscriptionId;
            this.slotIndex = slotIndex;
            this.threadId = threadId;
            this.read = read;
            this.eventFingerprint = eventFingerprint;
            this.providerState = providerState;
            this.serverState = serverState;
        }
    }
}
