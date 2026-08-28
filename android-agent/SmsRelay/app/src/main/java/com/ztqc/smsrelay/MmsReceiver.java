package com.ztqc.smsrelay;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class MmsReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        SmsNotificationHelper.showMmsUnsupported(context.getApplicationContext());
        RelayForegroundService.start(context.getApplicationContext());
    }
}
