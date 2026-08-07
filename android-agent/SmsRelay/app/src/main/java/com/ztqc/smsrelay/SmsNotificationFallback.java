package com.ztqc.smsrelay;

import android.content.Context;
import android.text.TextUtils;
import android.util.Log;

public final class SmsNotificationFallback {
    private static final String TAG = "SmsNotifyFallback";

    private SmsNotificationFallback() {}

    public static boolean handle(Context context, String sender, String body, long postTimeMillis) {
        if (TextUtils.isEmpty(body)) return false;
        ActivationWindowStore.Match match = ActivationWindowStore.matchNotification(context, sender, body, postTimeMillis);
        if (match == null) return false;
        SmsQueueStore store = new SmsQueueStore(context);
        try {
            long inserted = store.enqueueWithFingerprint(
                sender,
                body,
                postTimeMillis > 0 ? postTimeMillis : System.currentTimeMillis(),
                match.window.subscriptionId,
                match.window.slotIndex,
                match.eventFingerprint
            );
            RelayForegroundService.start(context);
            RelayForegroundService.drainQueueAsync(context);
            Log.i(TAG, "queued notification sms inserted=" + inserted + " activation=" + match.window.activationId + " platform=" + match.window.platform);
            return inserted != 0;
        } finally {
            store.close();
        }
    }
}
