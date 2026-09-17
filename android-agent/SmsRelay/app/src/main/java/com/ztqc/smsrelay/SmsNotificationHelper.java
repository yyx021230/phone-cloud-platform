package com.ztqc.smsrelay;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

public final class SmsNotificationHelper {
    private static final String CHANNEL_ID = "incoming_sms";

    private SmsNotificationHelper() {}

    public static void showIncoming(Context context, long threadId, String sender, String body, int subscriptionId) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        ensureChannel(manager);
        Intent open = new Intent(context, SmsThreadActivity.class);
        open.putExtra(SmsThreadActivity.EXTRA_THREAD_ID, threadId);
        open.putExtra(SmsThreadActivity.EXTRA_ADDRESS, sender);
        open.putExtra(SmsThreadActivity.EXTRA_SUBSCRIPTION_ID, subscriptionId);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
            context,
            notificationId(threadId),
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | immutableFlag()
        );
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(context, CHANNEL_ID)
            : new Notification.Builder(context);
        Notification notification = builder
            .setSmallIcon(R.drawable.ic_stat_ztc)
            .setContentTitle(sender == null || sender.isEmpty() ? "新短信" : sender)
            .setContentText(body == null ? "" : body)
            .setStyle(new Notification.BigTextStyle().bigText(body == null ? "" : body))
            .setContentIntent(contentIntent)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .build();
        manager.notify(notificationId(threadId), notification);
    }

    public static void showMmsUnsupported(Context context) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        ensureChannel(manager);
        Intent open = new Intent(context, SmsHomeActivity.class);
        PendingIntent contentIntent = PendingIntent.getActivity(
            context,
            9198,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | immutableFlag()
        );
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(context, CHANNEL_ID)
            : new Notification.Builder(context);
        manager.notify(9198, builder
            .setSmallIcon(R.drawable.ic_stat_ztc)
            .setContentTitle("收到一条彩信")
            .setContentText("当前版本暂不下载彩信内容，文字短信不受影响")
            .setContentIntent(contentIntent)
            .setAutoCancel(true)
            .build());
    }

    public static void cancelThread(Context context, long threadId) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(notificationId(threadId));
    }

    private static void ensureChannel(NotificationManager manager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "新短信",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("显示手机收到的新短信");
        manager.createNotificationChannel(channel);
    }

    private static int notificationId(long threadId) {
        return 9200 + (int) (Math.abs(threadId) % 100_000);
    }

    private static int immutableFlag() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0;
    }
}
