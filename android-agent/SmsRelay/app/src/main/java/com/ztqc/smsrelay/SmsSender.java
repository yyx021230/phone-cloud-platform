package com.ztqc.smsrelay;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.telephony.SmsManager;

import java.util.ArrayList;

public final class SmsSender {
    private SmsSender() {}

    public static long send(Context context, String recipient, String body, int subscriptionId) throws Exception {
        String normalizedRecipient = recipient == null ? "" : recipient.trim();
        String normalizedBody = body == null ? "" : body.trim();
        if (normalizedRecipient.isEmpty()) throw new IllegalArgumentException("收件人不能为空");
        if (normalizedBody.isEmpty()) throw new IllegalArgumentException("短信内容不能为空");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
            && context.checkSelfPermission(Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
            throw new SecurityException("没有发送短信权限");
        }

        int resolvedSubscriptionId = subscriptionId;
        if (resolvedSubscriptionId == Integer.MIN_VALUE) {
            resolvedSubscriptionId = SmsManager.getDefaultSmsSubscriptionId();
        }
        SmsManager manager = resolvedSubscriptionId >= 0
            ? SmsManager.getSmsManagerForSubscriptionId(resolvedSubscriptionId)
            : SmsManager.getDefault();
        ArrayList<String> parts = manager.divideMessage(normalizedBody);
        if (parts.size() <= 1) {
            manager.sendTextMessage(normalizedRecipient, null, normalizedBody, null, null);
        } else {
            manager.sendMultipartTextMessage(normalizedRecipient, null, parts, null, null);
        }
        long now = System.currentTimeMillis();
        return SmsRepository.insertSent(context, normalizedRecipient, normalizedBody, now, resolvedSubscriptionId);
    }
}
