package com.ztqc.smsrelay;

public final class SmsModels {
    private SmsModels() {}

    public static final class Conversation {
        public final long threadId;
        public final String address;
        public final String snippet;
        public final long date;
        public final int unreadCount;
        public final int subscriptionId;

        public Conversation(long threadId, String address, String snippet, long date, int unreadCount, int subscriptionId) {
            this.threadId = threadId;
            this.address = address == null ? "" : address;
            this.snippet = snippet == null ? "" : snippet;
            this.date = date;
            this.unreadCount = unreadCount;
            this.subscriptionId = subscriptionId;
        }
    }

    public static final class Message {
        public final long id;
        public final long threadId;
        public final String address;
        public final String body;
        public final long date;
        public final int type;
        public final boolean read;
        public final int subscriptionId;

        public Message(long id, long threadId, String address, String body, long date, int type, boolean read, int subscriptionId) {
            this.id = id;
            this.threadId = threadId;
            this.address = address == null ? "" : address;
            this.body = body == null ? "" : body;
            this.date = date;
            this.type = type;
            this.read = read;
            this.subscriptionId = subscriptionId;
        }

        public boolean outgoing() {
            return type == android.provider.Telephony.TextBasedSmsColumns.MESSAGE_TYPE_SENT
                || type == android.provider.Telephony.TextBasedSmsColumns.MESSAGE_TYPE_OUTBOX
                || type == android.provider.Telephony.TextBasedSmsColumns.MESSAGE_TYPE_FAILED
                || type == android.provider.Telephony.TextBasedSmsColumns.MESSAGE_TYPE_QUEUED;
        }
    }
}
