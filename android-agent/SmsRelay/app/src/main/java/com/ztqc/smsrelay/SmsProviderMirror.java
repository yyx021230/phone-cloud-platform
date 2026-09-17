package com.ztqc.smsrelay;

import android.content.Context;
import android.net.Uri;

import java.util.concurrent.atomic.AtomicBoolean;

/** Independently repairs the public SMS Provider mirror from the local source of truth. */
public final class SmsProviderMirror {
    private static final AtomicBoolean running = new AtomicBoolean(false);

    private SmsProviderMirror() {}

    public static void repairAsync(Context context) {
        Context appContext = context.getApplicationContext();
        if (!DefaultSmsRole.isDefaultSmsApp(appContext)) return;
        if (!running.compareAndSet(false, true)) return;
        new Thread(() -> {
            try {
                repairNow(appContext);
            } finally {
                running.set(false);
            }
        }, "sms-provider-mirror").start();
    }

    static void repairNow(Context context) {
        SmsQueueStore store = new SmsQueueStore(context);
        try {
            int repaired = 0;
            for (SmsQueueStore.LocalMessage message : store.listProviderMissingMessages()) {
                if (repaired >= 50) break;
                long threadId = message.threadId == null || message.threadId <= 0L
                    ? SmsRepository.threadIdForAddress(context, message.sender) : message.threadId;
                try {
                    Uri uri = SmsRepository.insertIncoming(
                        context,
                        message.sender,
                        message.body,
                        message.receivedAtMillis,
                        message.subscriptionId == null ? Integer.MIN_VALUE : message.subscriptionId,
                        null
                    );
                    if (uri == null) {
                        store.markProviderFailed(message.eventFingerprint, "content://sms repair returned null", threadId);
                    } else {
                        store.markProviderWritten(message.eventFingerprint, uri.toString(), threadId);
                    }
                } catch (Exception error) {
                    store.markProviderFailed(
                        message.eventFingerprint,
                        error.getClass().getSimpleName() + ": " + error.getMessage(),
                        threadId
                    );
                }
                repaired += 1;
            }
        } finally {
            store.close();
        }
    }
}
