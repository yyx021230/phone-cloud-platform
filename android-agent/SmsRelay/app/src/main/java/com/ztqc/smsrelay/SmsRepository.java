package com.ztqc.smsrelay;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.Telephony;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

public final class SmsRepository {
    private static final String[] MESSAGE_COLUMNS = new String[] {
        "_id", "thread_id", "address", "body", "date", "type", "read", "sub_id"
    };
    private static final String[] MESSAGE_COLUMNS_WITHOUT_SIM = new String[] {
        "_id", "thread_id", "address", "body", "date", "type", "read"
    };
    private static final int CONVERSATION_SCAN_LIMIT = 2_000;
    private static final int THREAD_MESSAGE_LIMIT = 500;

    private SmsRepository() {}

    public static List<SmsModels.Conversation> loadConversations(Context context, String query) {
        String normalizedQuery = query == null ? "" : query.trim().toLowerCase(Locale.ROOT);
        Map<Long, MutableConversation> grouped = new LinkedHashMap<>();
        try (Cursor cursor = querySms(
            context.getContentResolver(),
            null,
            null,
            "date desc",
            CONVERSATION_SCAN_LIMIT
        )) {
            if (cursor == null) return new ArrayList<>();
            while (cursor.moveToNext()) {
                SmsModels.Message message = readMessage(cursor);
                MutableConversation row = grouped.get(message.threadId);
                if (row == null) {
                    row = new MutableConversation(message);
                    grouped.put(message.threadId, row);
                }
                if (!message.outgoing() && !message.read) row.unreadCount += 1;
                if (!normalizedQuery.isEmpty()
                    && (contains(message.address, normalizedQuery) || contains(message.body, normalizedQuery))) {
                    row.matchesQuery = true;
                }
            }
        }
        SmsQueueStore localStore = new SmsQueueStore(context);
        try {
            for (SmsQueueStore.LocalMessage local : localStore.listProviderMissingMessages()) {
                long threadId = local.threadId == null || local.threadId <= 0L
                    ? threadIdForAddress(context, local.sender) : local.threadId;
                SmsModels.Message message = localMessage(local, threadId);
                MutableConversation row = grouped.get(threadId);
                if (row == null) {
                    row = new MutableConversation(message);
                    grouped.put(threadId, row);
                } else {
                    row.absorb(message);
                }
                if (!message.read) row.unreadCount += 1;
                if (!normalizedQuery.isEmpty()
                    && (contains(message.address, normalizedQuery) || contains(message.body, normalizedQuery))) {
                    row.matchesQuery = true;
                }
            }
        } finally {
            localStore.close();
        }
        List<SmsModels.Conversation> result = new ArrayList<>();
        for (MutableConversation row : grouped.values()) {
            if (!normalizedQuery.isEmpty() && !row.matchesQuery) continue;
            result.add(new SmsModels.Conversation(
                row.threadId,
                row.address,
                row.snippet,
                row.date,
                row.unreadCount,
                row.subscriptionId
            ));
        }
        result.sort((left, right) -> Long.compare(right.date, left.date));
        return result;
    }

    public static List<SmsModels.Message> loadThread(Context context, long threadId) {
        if (threadId <= 0L) return new ArrayList<>();
        List<SmsModels.Message> result = new ArrayList<>();
        try (Cursor cursor = querySms(
            context.getContentResolver(),
            "thread_id = ?",
            new String[] { String.valueOf(threadId) },
            "date desc",
            THREAD_MESSAGE_LIMIT
        )) {
            if (cursor == null) return result;
            while (cursor.moveToNext()) result.add(readMessage(cursor));
        }
        SmsQueueStore localStore = new SmsQueueStore(context);
        try {
            for (SmsQueueStore.LocalMessage local : localStore.listProviderMissingMessages()) {
                long localThreadId = local.threadId == null || local.threadId <= 0L
                    ? threadIdForAddress(context, local.sender) : local.threadId;
                if (localThreadId == threadId) result.add(localMessage(local, localThreadId));
            }
        } finally {
            localStore.close();
        }
        result.sort((left, right) -> Long.compare(left.date, right.date));
        return result;
    }

    public static void markThreadRead(Context context, long threadId) {
        if (threadId <= 0L || !DefaultSmsRole.hasReadSmsPermission(context)) return;
        ContentValues values = new ContentValues();
        values.put("read", 1);
        values.put("seen", 1);
        try {
            context.getContentResolver().update(
                Telephony.Sms.CONTENT_URI,
                values,
                "thread_id = ? and (read = 0 or seen = 0)",
                new String[] { String.valueOf(threadId) }
            );
        } catch (Exception ignored) {
        }
        SmsQueueStore localStore = new SmsQueueStore(context);
        try {
            localStore.markLocalThreadRead(threadId);
        } finally {
            localStore.close();
        }
        SmsNotificationHelper.cancelThread(context, threadId);
    }

    public static int deleteThread(Context context, long threadId) {
        if (threadId <= 0L || !DefaultSmsRole.isDefaultSmsApp(context)) return 0;
        int localDeleted;
        SmsQueueStore localStore = new SmsQueueStore(context);
        try {
            localDeleted = localStore.deleteLocalThread(threadId);
        } finally {
            localStore.close();
        }
        try {
            int deleted = context.getContentResolver().delete(
                Telephony.Sms.CONTENT_URI,
                "thread_id = ?",
                new String[] { String.valueOf(threadId) }
            );
            SmsNotificationHelper.cancelThread(context, threadId);
            return deleted + localDeleted;
        } catch (Exception ignored) {
            return localDeleted;
        }
    }

    public static int deleteMessage(Context context, long messageId) {
        if (!DefaultSmsRole.isDefaultSmsApp(context)) return 0;
        if (messageId < 0L) {
            SmsQueueStore localStore = new SmsQueueStore(context);
            try {
                return localStore.deleteLocalMessage(-messageId);
            } finally {
                localStore.close();
            }
        }
        if (messageId == 0L) return 0;
        try {
            return context.getContentResolver().delete(
                ContentUris.withAppendedId(Telephony.Sms.CONTENT_URI, messageId),
                null,
                null
            );
        } catch (Exception ignored) {
            return 0;
        }
    }

    public static Uri insertIncoming(
        Context context,
        String address,
        String body,
        long timestamp,
        int subscriptionId,
        String serviceCenter
    ) {
        if (!DefaultSmsRole.isDefaultSmsApp(context)) return null;
        Uri duplicate = findExactIncoming(context, address, body, timestamp);
        if (duplicate != null) return duplicate;

        ContentValues values = new ContentValues();
        values.put("address", safe(address));
        values.put("body", safe(body));
        values.put("date", timestamp);
        values.put("date_sent", timestamp);
        values.put("read", 0);
        values.put("seen", 0);
        values.put("type", Telephony.TextBasedSmsColumns.MESSAGE_TYPE_INBOX);
        if (serviceCenter != null && !serviceCenter.isEmpty()) values.put("service_center", serviceCenter);
        if (subscriptionId != Integer.MIN_VALUE) values.put("sub_id", subscriptionId);
        try {
            return context.getContentResolver().insert(Telephony.Sms.Inbox.CONTENT_URI, values);
        } catch (RuntimeException error) {
            values.remove("sub_id");
            return context.getContentResolver().insert(Telephony.Sms.Inbox.CONTENT_URI, values);
        }
    }

    public static long insertSent(
        Context context,
        String address,
        String body,
        long timestamp,
        int subscriptionId
    ) {
        if (!DefaultSmsRole.isDefaultSmsApp(context)) return threadIdForAddress(context, address);
        ContentValues values = new ContentValues();
        values.put("address", safe(address));
        values.put("body", safe(body));
        values.put("date", timestamp);
        values.put("date_sent", timestamp);
        values.put("read", 1);
        values.put("seen", 1);
        values.put("type", Telephony.TextBasedSmsColumns.MESSAGE_TYPE_SENT);
        if (subscriptionId != Integer.MIN_VALUE) values.put("sub_id", subscriptionId);
        Uri uri;
        try {
            uri = context.getContentResolver().insert(Telephony.Sms.Sent.CONTENT_URI, values);
        } catch (RuntimeException error) {
            values.remove("sub_id");
            uri = context.getContentResolver().insert(Telephony.Sms.Sent.CONTENT_URI, values);
        }
        if (uri == null) return threadIdForAddress(context, address);
        return threadIdForMessage(context, ContentUris.parseId(uri), address);
    }

    public static long threadIdForAddress(Context context, String address) {
        try {
            Set<String> recipients = Collections.singleton(safe(address));
            return Telephony.Threads.getOrCreateThreadId(context, recipients);
        } catch (Exception ignored) {
            return -1L;
        }
    }

    private static long threadIdForMessage(Context context, long messageId, String address) {
        try (Cursor cursor = context.getContentResolver().query(
            ContentUris.withAppendedId(Telephony.Sms.CONTENT_URI, messageId),
            new String[] { "thread_id" },
            null,
            null,
            null
        )) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getLong(0);
        } catch (Exception ignored) {
        }
        return threadIdForAddress(context, address);
    }

    private static Uri findExactIncoming(Context context, String address, String body, long timestamp) {
        long from = Math.max(0L, timestamp - 2_000L);
        long to = timestamp + 2_000L;
        try (Cursor cursor = context.getContentResolver().query(
            Telephony.Sms.Inbox.CONTENT_URI,
            new String[] { "_id" },
            "address = ? and body = ? and date between ? and ?",
            new String[] { safe(address), safe(body), String.valueOf(from), String.valueOf(to) },
            "date desc"
        )) {
            if (cursor != null && cursor.moveToFirst()) {
                return ContentUris.withAppendedId(Telephony.Sms.CONTENT_URI, cursor.getLong(0));
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private static Cursor querySms(
        ContentResolver resolver,
        String selection,
        String[] selectionArgs,
        String order,
        int limit
    ) {
        Uri uri = Telephony.Sms.CONTENT_URI.buildUpon()
            .appendQueryParameter("limit", String.valueOf(limit))
            .build();
        try {
            return resolver.query(uri, MESSAGE_COLUMNS, selection, selectionArgs, order);
        } catch (RuntimeException error) {
            return resolver.query(uri, MESSAGE_COLUMNS_WITHOUT_SIM, selection, selectionArgs, order);
        }
    }

    private static SmsModels.Message readMessage(Cursor cursor) {
        return new SmsModels.Message(
            longValue(cursor, "_id", -1L),
            longValue(cursor, "thread_id", -1L),
            stringValue(cursor, "address"),
            stringValue(cursor, "body"),
            longValue(cursor, "date", 0L),
            intValue(cursor, "type", 0),
            intValue(cursor, "read", 1) == 1,
            intValue(cursor, "sub_id", Integer.MIN_VALUE)
        );
    }

    private static SmsModels.Message localMessage(SmsQueueStore.LocalMessage local, long threadId) {
        return new SmsModels.Message(
            -local.id,
            threadId,
            local.sender,
            local.body,
            local.receivedAtMillis,
            Telephony.TextBasedSmsColumns.MESSAGE_TYPE_INBOX,
            local.read,
            local.subscriptionId == null ? Integer.MIN_VALUE : local.subscriptionId
        );
    }

    private static boolean contains(String value, String query) {
        return value != null && value.toLowerCase(Locale.ROOT).contains(query);
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }

    private static String stringValue(Cursor cursor, String column) {
        int index = cursor.getColumnIndex(column);
        return index < 0 || cursor.isNull(index) ? "" : cursor.getString(index);
    }

    private static long longValue(Cursor cursor, String column, long fallback) {
        int index = cursor.getColumnIndex(column);
        return index < 0 || cursor.isNull(index) ? fallback : cursor.getLong(index);
    }

    private static int intValue(Cursor cursor, String column, int fallback) {
        int index = cursor.getColumnIndex(column);
        return index < 0 || cursor.isNull(index) ? fallback : cursor.getInt(index);
    }

    private static final class MutableConversation {
        final long threadId;
        String address;
        String snippet;
        long date;
        int subscriptionId;
        int unreadCount;
        boolean matchesQuery;

        MutableConversation(SmsModels.Message message) {
            threadId = message.threadId;
            address = message.address;
            snippet = message.body;
            date = message.date;
            subscriptionId = message.subscriptionId;
        }

        void absorb(SmsModels.Message message) {
            if (message.date <= date) return;
            address = message.address;
            snippet = message.body;
            date = message.date;
            subscriptionId = message.subscriptionId;
        }
    }
}
