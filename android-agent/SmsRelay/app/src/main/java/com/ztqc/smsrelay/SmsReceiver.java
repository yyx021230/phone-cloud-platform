package com.ztqc.smsrelay;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Telephony;
import android.telephony.SmsMessage;

public class SmsReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        boolean deliverToDefaultApp = Telephony.Sms.Intents.SMS_DELIVER_ACTION.equals(action);
        if (!deliverToDefaultApp && !Telephony.Sms.Intents.SMS_RECEIVED_ACTION.equals(action)) return;

        Bundle extras = intent.getExtras();
        if (extras == null) return;

        SmsMessage[] messages = Telephony.Sms.Intents.getMessagesFromIntent(intent);
        if (messages == null || messages.length == 0) return;

        String sender = messages[0].getDisplayOriginatingAddress();
        String serviceCenter = messages[0].getServiceCenterAddress();
        StringBuilder body = new StringBuilder();
        long timestamp = System.currentTimeMillis();
        for (SmsMessage message : messages) {
            body.append(message.getMessageBody());
            timestamp = message.getTimestampMillis();
        }
        long finalTimestamp = timestamp;
        Context appContext = context.getApplicationContext();
        SmsRelayDiagnostics.recordSmsReceived(appContext);
        int subscriptionId = extractSubscriptionId(intent);
        int slotIndex = SimInfoReader.slotIndexForSubscription(appContext, subscriptionId);
        if (slotIndex == Integer.MIN_VALUE) slotIndex = extractSlotIndex(intent);
        if (subscriptionId == Integer.MIN_VALUE && slotIndex != Integer.MIN_VALUE) {
            subscriptionId = SimInfoReader.subscriptionIdForSlot(appContext, slotIndex);
        }
        SmsQueueStore.EventRef eventRef;
        SmsQueueStore store = new SmsQueueStore(appContext);
        try {
            eventRef = store.enqueueEvent(sender, body.toString(), finalTimestamp, subscriptionId, slotIndex, null);
        } finally {
            store.close();
        }

        if (deliverToDefaultApp && DefaultSmsRole.isDefaultSmsApp(appContext)) {
            long threadId = SmsRepository.threadIdForAddress(appContext, sender);
            try {
                Uri providerUri = SmsRepository.insertIncoming(
                    appContext,
                    sender,
                    body.toString(),
                    finalTimestamp,
                    subscriptionId,
                    serviceCenter
                );
                SmsQueueStore providerStore = new SmsQueueStore(appContext);
                try {
                    if (providerUri == null) {
                        providerStore.markProviderFailed(eventRef.eventFingerprint, "content://sms insert returned null", threadId);
                    } else {
                        providerStore.markProviderWritten(eventRef.eventFingerprint, providerUri.toString(), threadId);
                    }
                } finally {
                    providerStore.close();
                }
                SmsNotificationHelper.showIncoming(
                    appContext,
                    threadId,
                    sender,
                    body.toString(),
                    subscriptionId
                );
            } catch (Exception error) {
                SmsQueueStore providerStore = new SmsQueueStore(appContext);
                try {
                    providerStore.markProviderFailed(eventRef.eventFingerprint, error.getClass().getSimpleName() + ": " + error.getMessage(), threadId);
                } finally {
                    providerStore.close();
                }
                SmsRelayDiagnostics.recordSync(appContext, "local_inbox_write_failed", 0, error.getMessage());
            }
        }

        SmsUploadJobService.schedule(appContext, 0L);
        RelayForegroundService.start(appContext);
        RelayForegroundService.syncSmsLibraryAsync(appContext, false);
    }

    private int extractSubscriptionId(Intent intent) {
        Bundle extras = intent.getExtras();
        if (extras == null) return Integer.MIN_VALUE;
        String[] keys = new String[] {
            "subscription",
            "android.telephony.extra.SUBSCRIPTION_INDEX",
            "subscription_id",
            "sub_id",
            "subId"
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

    private int extractSlotIndex(Intent intent) {
        Bundle extras = intent.getExtras();
        if (extras == null) return Integer.MIN_VALUE;
        String[] keys = new String[] {
            "android.telephony.extra.SLOT_INDEX",
            "slot",
            "slot_id",
            "slotId",
            "simSlot",
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
