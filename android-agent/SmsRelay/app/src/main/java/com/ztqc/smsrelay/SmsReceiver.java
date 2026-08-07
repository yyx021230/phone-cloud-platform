package com.ztqc.smsrelay;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.provider.Telephony;
import android.telephony.SmsMessage;

public class SmsReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Telephony.Sms.Intents.SMS_RECEIVED_ACTION.equals(intent.getAction())) return;

        Bundle extras = intent.getExtras();
        if (extras == null) return;

        SmsMessage[] messages = Telephony.Sms.Intents.getMessagesFromIntent(intent);
        if (messages == null || messages.length == 0) return;

        String sender = messages[0].getDisplayOriginatingAddress();
        StringBuilder body = new StringBuilder();
        long timestamp = System.currentTimeMillis();
        for (SmsMessage message : messages) {
            body.append(message.getMessageBody());
            timestamp = message.getTimestampMillis();
        }
        long finalTimestamp = timestamp;
        Context appContext = context.getApplicationContext();
        int subscriptionId = extractSubscriptionId(intent);
        int slotIndex = SimInfoReader.slotIndexForSubscription(appContext, subscriptionId);
        SmsQueueStore store = new SmsQueueStore(appContext);
        try {
            store.enqueue(sender, body.toString(), finalTimestamp, subscriptionId, slotIndex);
        } finally {
            store.close();
        }
        RelayForegroundService.start(appContext);
        PendingResult result = goAsync();
        new Thread(() -> {
            try {
                RelayForegroundService.drainQueueNow(appContext);
                RelayForegroundService.syncSmsLibraryAsync(appContext, false);
            } catch (Exception error) {
                error.printStackTrace();
            } finally {
                result.finish();
            }
        }).start();
    }

    private int extractSubscriptionId(Intent intent) {
        Bundle extras = intent.getExtras();
        if (extras == null) return Integer.MIN_VALUE;
        String[] keys = new String[] {
            "subscription",
            "android.telephony.extra.SUBSCRIPTION_INDEX",
            "subscription_id",
            "phone"
        };
        for (String key : keys) {
            Object value = extras.get(key);
            if (value instanceof Integer) return (Integer) value;
            if (value instanceof Long) return ((Long) value).intValue();
            if (value instanceof String) {
                try {
                    return Integer.parseInt((String) value);
                } catch (NumberFormatException ignored) {
                }
            }
        }
        return Integer.MIN_VALUE;
    }
}
