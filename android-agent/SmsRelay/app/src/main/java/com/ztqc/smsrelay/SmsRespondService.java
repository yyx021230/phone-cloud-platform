package com.ztqc.smsrelay;

import android.app.Service;
import android.content.Intent;
import android.net.Uri;
import android.os.IBinder;

public class SmsRespondService extends Service {
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Uri data = intent == null ? null : intent.getData();
        String recipient = data == null ? "" : data.getSchemeSpecificPart();
        String body = intent == null ? "" : intent.getStringExtra(Intent.EXTRA_TEXT);
        new Thread(() -> {
            try {
                SmsSender.send(this, recipient, body, Integer.MIN_VALUE);
            } catch (Exception ignored) {
            } finally {
                stopSelf(startId);
            }
        }, "sms-respond").start();
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
