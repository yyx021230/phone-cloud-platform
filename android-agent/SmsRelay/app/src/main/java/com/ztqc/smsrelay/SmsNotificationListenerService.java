package com.ztqc.smsrelay;

import android.app.Notification;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.text.TextUtils;
import android.util.Log;

import java.lang.ref.WeakReference;

public class SmsNotificationListenerService extends NotificationListenerService {
    private static final String TAG = "SmsNotifyFallback";
    private static WeakReference<SmsNotificationListenerService> currentService = new WeakReference<>(null);

    @Override
    public void onListenerConnected() {
        currentService = new WeakReference<>(this);
        Log.i(TAG, "notification listener connected; active notifications will be replayed inside active windows");
        ActivationWindowStore.refreshAsync(this);
        long cutoffMillis = ActivationWindowStore.staleNotificationCutoffMillis(this);
        if (cutoffMillis > 0) pruneActiveSmsNotificationsBefore(cutoffMillis);
        replayActiveSmsNotificationsSince(cutoffMillis);
    }

    @Override
    public void onListenerDisconnected() {
        currentService = new WeakReference<>(null);
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        handleNotification(sbn, false);
    }

    public static void cancelSmsNotificationsBefore(long cutoffMillis) {
        SmsNotificationListenerService service = currentService.get();
        if (service != null) service.pruneActiveSmsNotificationsBefore(cutoffMillis);
    }

    public static void replaySmsNotificationsSince(long cutoffMillis) {
        SmsNotificationListenerService service = currentService.get();
        if (service != null) service.replayActiveSmsNotificationsSince(cutoffMillis);
    }

    private void handleNotification(StatusBarNotification sbn, boolean activeReplay) {
        try {
            if (!isSmsNotification(sbn)) return;
            Notification notification = sbn.getNotification();
            Bundle extras = notification == null ? null : notification.extras;
            if (extras == null) return;
            String sender = firstNonEmpty(
                text(extras.getCharSequence(Notification.EXTRA_TITLE)),
                sbn.getPackageName()
            );
            String body = firstNonEmpty(
                text(extras.getCharSequence(Notification.EXTRA_BIG_TEXT)),
                text(extras.getCharSequence(Notification.EXTRA_TEXT)),
                lines(extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES))
            );
            if (TextUtils.isEmpty(body)) return;
            long eventTime = notification.when > 0 ? notification.when : sbn.getPostTime();
            if (activeReplay) Log.i(TAG, "replay active sms notification package=" + sbn.getPackageName() + " when=" + eventTime);
            SmsNotificationFallback.handle(this, sender, body, eventTime);
        } catch (Exception error) {
            Log.e(TAG, "notification fallback failed", error);
        }
    }

    private void replayActiveSmsNotificationsSince(long cutoffMillis) {
        StatusBarNotification[] active = getActiveNotifications();
        if (active == null) return;
        int replayed = 0;
        for (StatusBarNotification sbn : active) {
            if (!isSmsNotification(sbn)) continue;
            Notification notification = sbn.getNotification();
            long when = notification == null ? 0L : notification.when;
            long eventTime = when > 0 ? when : sbn.getPostTime();
            if (cutoffMillis > 0 && eventTime < cutoffMillis) continue;
            handleNotification(sbn, true);
            replayed++;
        }
        if (replayed > 0) Log.i(TAG, "replayed active sms notifications since=" + cutoffMillis + " count=" + replayed);
    }

    private void pruneActiveSmsNotificationsBefore(long cutoffMillis) {
        StatusBarNotification[] active = getActiveNotifications();
        if (active == null) return;
        int cancelled = 0;
        for (StatusBarNotification sbn : active) {
            if (!isSmsNotification(sbn)) continue;
            Notification notification = sbn.getNotification();
            long when = notification == null ? 0L : notification.when;
            if (when > 0 && when < cutoffMillis) {
                cancelNotification(sbn.getKey());
                cancelled++;
            }
        }
        if (cancelled > 0) Log.i(TAG, "cancelled stale sms notifications before=" + cutoffMillis + " count=" + cancelled);
    }

    private boolean isSmsNotification(StatusBarNotification sbn) {
        if (sbn == null) return false;
        String pkg = sbn.getPackageName();
        return "com.android.mms".equals(pkg)
            || "com.android.mms.service".equals(pkg)
            || "com.hihonor.mms".equals(pkg)
            || "com.huawei.message".equals(pkg)
            || "com.google.android.apps.messaging".equals(pkg)
            || "com.samsung.android.messaging".equals(pkg);
    }

    private String text(CharSequence value) {
        if (value == null) return "";
        return value.toString().replace('\n', ' ').trim();
    }

    private String lines(CharSequence[] values) {
        if (values == null || values.length == 0) return "";
        StringBuilder builder = new StringBuilder();
        for (CharSequence value : values) {
            String item = text(value);
            if (TextUtils.isEmpty(item)) continue;
            if (builder.length() > 0) builder.append(" ");
            builder.append(item);
        }
        return builder.toString();
    }

    private String firstNonEmpty(String... values) {
        for (String value : values) {
            if (!TextUtils.isEmpty(value)) return value;
        }
        return "";
    }
}
